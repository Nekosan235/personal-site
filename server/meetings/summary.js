// Meeting summaries ("会议纪要").
//
// The site does not write the minutes itself: it sends the cleaned transcript
// plus a prompt to Codex running on the same server and stores whatever
// Markdown comes back as summary.md in the meeting's folder.
//
// Summary providers share one contract:
//
//   provider.available()                 -> boolean (configured enough to try)
//   provider.summarize({ prompt, transcript, meeting, signal })
//       -> Promise<{ markdown: string, model?: string|null, raw?: string }>
//       throws SummaryError with a Chinese user-facing message on failure.
//
// Implemented here:
//   - disabled     never available; the page shows the feature as off.
//   - codex-exec   spawns `codex exec -` with the prompt on stdin (local CLI).
//   - codex-http   POSTs JSON to a loopback bridge in front of Codex.
//
// ⚠ Neither Codex provider has been run against a real Codex install: the
// handover asks an agent with server access to finish and verify them. Tests
// cover the contract with fakes only.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class SummaryError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'SummaryError';
    this.status = status;
    this.retryable = retryable;
  }
}

const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function clock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** The exact text handed to Codex: instructions, meeting facts, transcript. */
export function buildSummaryInput({ prompt, meeting, transcript }) {
  const lines = (transcript?.utterances ?? [])
    .map((item) => `[${clock(item.start)}] Speaker ${item.speaker}: ${item.text}`);
  let body = lines.join('\n');
  let truncated = false;
  if (body.length > MAX_TRANSCRIPT_CHARS) {
    body = body.slice(0, MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }
  const facts = [
    `会议标题：${meeting?.title ?? '—'}`,
    `录音时长：${Math.round((transcript?.durationMs ?? 0) / 60000)} 分钟`,
    `说话人：${(transcript?.speakers ?? []).join(' / ') || '—'}`,
    `转写模型：${transcript?.model ?? '—'}`,
  ];
  return [
    String(prompt ?? '').trim(),
    '',
    '---',
    '## 会议信息',
    ...facts,
    truncated ? '（转写稿过长，以下只包含前一部分）' : '',
    '',
    '## 转写稿',
    '<transcript>',
    body,
    '</transcript>',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

/** Strip a surrounding ```markdown fence and trailing noise from model output. */
export function cleanSummaryMarkdown(text) {
  let out = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/i.exec(out);
  if (fence) out = fence[1].trim();
  return out;
}

// ── providers ──────────────────────────────────────────────────────────────
export function createDisabledProvider() {
  return {
    id: 'disabled',
    label: '不生成纪要',
    description: '只保留转写稿。',
    available: () => false,
    async summarize() {
      throw new SummaryError('会议纪要未启用，请先在设置里选择纪要服务。', { status: 503 });
    },
  };
}

/**
 * Local Codex CLI. Runs `<bin> exec [args…] -` with the full input on stdin
 * and reads the final message from --output-last-message. No shell is used;
 * arguments are passed as an array.
 */
export function createCodexExecProvider({
  bin,
  args = [],
  cwd,
  timeoutMs = 10 * 60 * 1000,
  env = process.env,
  spawnImpl = spawn,
  logger = console,
} = {}) {
  return {
    id: 'codex-exec',
    label: 'Codex（本机 CLI）',
    description: '在服务器上调用 codex exec，把转写稿和提示词通过 stdin 发给它。',
    available: () => Boolean(bin),
    async summarize({ prompt, transcript, meeting, signal }) {
      if (!bin) throw new SummaryError('尚未配置 MEETINGS_CODEX_BIN，无法生成纪要。', { status: 503 });
      const input = buildSummaryInput({ prompt, meeting, transcript });
      const workdir = await mkdtemp(join(tmpdir(), 'meeting-summary-'));
      const outFile = join(workdir, 'last-message.md');
      try {
        const stdout = await new Promise((resolve, reject) => {
          const child = spawnImpl(bin, ['exec', ...args, '--output-last-message', outFile, '-'], {
            cwd: cwd || workdir,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let out = '';
          let err = '';
          let size = 0;
          let finished = false;
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish(new SummaryError('Codex 生成纪要超时。', { status: 504, retryable: true }));
          }, timeoutMs);
          const onAbort = () => {
            child.kill('SIGTERM');
            finish(signal.reason ?? new Error('aborted'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          function finish(error, value) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve(value);
          }
          child.stdout?.on('data', (chunk) => {
            size += chunk.length;
            if (size <= MAX_OUTPUT_BYTES) out += chunk;
          });
          child.stderr?.on('data', (chunk) => {
            if (err.length < 8000) err += chunk;
          });
          child.on('error', (error) => {
            finish(new SummaryError(
              error?.code === 'ENOENT' ? '找不到 Codex 可执行文件，请检查 MEETINGS_CODEX_BIN。' : `无法启动 Codex：${error?.message ?? error}`,
              { status: 503 },
            ));
          });
          child.on('close', (code) => {
            if (code === 0) finish(null, out);
            else {
              logger?.error?.('[meetings] codex exec 退出码', code, err.slice(-2000));
              finish(new SummaryError(`Codex 生成纪要失败（退出码 ${code}）。`, { retryable: true }));
            }
          });
          child.stdin?.on('error', () => {});
          child.stdin?.end(input, 'utf8');
        });
        let text = '';
        try {
          text = await readFile(outFile, 'utf8');
        } catch {
          text = stdout;
        }
        const markdown = cleanSummaryMarkdown(text);
        if (!markdown) throw new SummaryError('Codex 没有返回纪要内容。', { retryable: true });
        return { markdown, model: null };
      } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/**
 * Loopback HTTP bridge. POSTs
 *   { prompt, input, meeting: { id, title }, transcript: { model, language, durationMs, speakers } }
 * and expects 200 { markdown, model? }. The URL must be loopback (checked in
 * config validation); an optional bearer token comes from the environment.
 */
export function createCodexHttpProvider({
  url,
  token,
  timeoutMs = 10 * 60 * 1000,
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    id: 'codex-http',
    label: 'Codex（本机 HTTP 桥）',
    description: '把转写稿和提示词 POST 到服务器本机的 Codex 桥接服务。',
    available: () => Boolean(url),
    async summarize({ prompt, transcript, meeting, signal }) {
      if (!url) throw new SummaryError('尚未配置 MEETINGS_CODEX_URL，无法生成纪要。', { status: 503 });
      const input = buildSummaryInput({ prompt, meeting, transcript });
      const timer = AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            prompt,
            input,
            meeting: { id: meeting?.id, title: meeting?.title },
            transcript: {
              model: transcript?.model ?? null,
              language: transcript?.language ?? null,
              durationMs: transcript?.durationMs ?? 0,
              speakers: transcript?.speakers ?? [],
            },
          }),
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timer]) : timer,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error?.name === 'TimeoutError') throw new SummaryError('Codex 生成纪要超时。', { status: 504, retryable: true });
        throw new SummaryError('连不上 Codex 桥接服务，请确认它在运行。', { status: 502, retryable: true });
      }
      if (!response.ok) {
        throw new SummaryError(`Codex 桥接服务返回 ${response.status}。`, { retryable: response.status >= 500 });
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new SummaryError('Codex 桥接服务返回的内容无法解析。');
      }
      const markdown = cleanSummaryMarkdown(payload?.markdown);
      if (!markdown) throw new SummaryError('Codex 没有返回纪要内容。', { retryable: true });
      return { markdown, model: typeof payload?.model === 'string' ? payload.model.slice(0, 64) : null };
    },
  };
}

export function createSummaryRegistry(list) {
  const byId = new Map(list.map((provider) => [provider.id, provider]));
  return {
    has: (id) => byId.has(id),
    get: (id) => byId.get(id) ?? byId.get('disabled'),
    list: () => list,
  };
}

/**
 * Summary job runner. A meeting's `summary` field tracks it:
 *   { status: 'queued'|'running'|'done'|'failed', provider, error, requestedAt, startedAt, completedAt, chars, model }
 * Runs one at a time; a request for a meeting already queued or running is
 * ignored. Only the transcript that existed when the job started is used.
 */
export function createSummaryService({ store, settings, registry, now = () => Date.now(), logger = console }) {
  const waiting = [];
  const active = new Map();
  let stopped = false;

  function userMessage(error) {
    if (error instanceof SummaryError || error?.name === 'SummaryError') return error.message;
    return '生成纪要失败，请稍后重试。';
  }

  async function runOne(id, controller) {
    const meta = await store.get(id);
    if (!meta || meta.summary?.status !== 'queued') return;
    const transcript = await store.readTranscript(id);
    if (!transcript) {
      await store.update(id, (current) => (current.summary?.status === 'queued'
        ? { summary: { ...current.summary, status: 'failed', error: '还没有转写稿，无法生成纪要。', completedAt: now() } }
        : null));
      return;
    }
    const { providerId, provider, prompt } = await settings.resolveSummary();
    const transcriptStamp = meta.transcript?.completedAt ?? null;
    const started = await store.update(id, (current) => (current.summary?.status === 'queued'
      ? { summary: { ...current.summary, status: 'running', provider: providerId, error: null, startedAt: now() } }
      : null));
    if (!started) return;

    try {
      const result = await provider.summarize({ prompt, transcript, meeting: meta, signal: controller.signal });
      await store.writeSummary(id, result.markdown, (current) => {
        if (current.summary?.status !== 'running') return null;
        if ((current.transcript?.completedAt ?? null) !== transcriptStamp) return null; // re-transcribed meanwhile
        return {
          summary: {
            ...current.summary,
            status: 'done',
            error: null,
            completedAt: now(),
            chars: result.markdown.length,
            model: result.model ?? null,
            promptChars: String(prompt).length,
          },
        };
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await store.update(id, (current) => (current.summary?.status === 'running'
          ? { summary: { ...current.summary, status: 'queued', startedAt: null } }
          : null)).catch(() => {});
        return;
      }
      logger?.error?.(`[meetings] ${id} 生成纪要失败:`, error?.message ?? error);
      await store.update(id, (current) => (current.summary?.status === 'running'
        ? { summary: { ...current.summary, status: 'failed', error: userMessage(error), completedAt: now() } }
        : null));
    }
  }

  function pump() {
    if (stopped || active.size || !waiting.length) return;
    const id = waiting.shift();
    const controller = new AbortController();
    const task = runOne(id, controller)
      .catch((error) => logger?.error?.('[meetings] 纪要任务异常:', error?.message ?? error))
      .finally(() => {
        active.delete(id);
        pump();
      });
    active.set(id, { controller, task });
  }

  /** Mark the meeting queued and start it. Returns the updated meta or a refusal. */
  async function request(id) {
    const { provider } = await settings.resolveSummary();
    if (!provider.available()) return { error: '会议纪要未启用或未配置，请先到设置页选择纪要服务。', status: 503 };
    let refusal = null;
    const updated = await store.update(id, (current) => {
      if (!current.transcript) {
        refusal = { error: '还没有转写稿，无法生成纪要。', status: 409 };
        return null;
      }
      if (current.summary?.status === 'queued' || current.summary?.status === 'running') {
        refusal = { error: '纪要正在生成，请稍候。', status: 409 };
        return null;
      }
      return {
        summary: {
          ...(current.summary ?? {}),
          status: 'queued',
          error: null,
          requestedAt: now(),
          startedAt: null,
        },
      };
    });
    if (!updated) return refusal ?? { error: '找不到这条会议记录。', status: 404 };
    if (!waiting.includes(id)) waiting.push(id);
    pump();
    return { meta: updated };
  }

  /** Boot: anything left queued/running goes back in line. */
  async function recover() {
    for (const meta of await store.list()) {
      if (meta.summary?.status === 'running') {
        await store.update(meta.id, (current) => (current.summary?.status === 'running'
          ? { summary: { ...current.summary, status: 'queued', startedAt: null } }
          : null));
        waiting.push(meta.id);
      } else if (meta.summary?.status === 'queued') {
        waiting.push(meta.id);
      }
    }
    pump();
  }

  function cancel(id) {
    const index = waiting.indexOf(id);
    if (index !== -1) waiting.splice(index, 1);
    active.get(id)?.controller.abort(new Error('cancelled'));
  }

  function stop() {
    stopped = true;
    waiting.length = 0;
    for (const { controller } of active.values()) controller.abort(new Error('服务正在关闭'));
  }

  function drain() {
    return Promise.allSettled([...active.values()].map((entry) => entry.task));
  }

  return { request, recover, cancel, stop, drain, isBusy: (id) => active.has(id) || waiting.includes(id) };
}
