// AssemblyAI client for the meetings feature. Kept as a small injectable
// factory so tests can replace it with a fake and never touch the network.
// Uploads, submissions and polls all retry on transient network errors: this
// box reaches the API over a long-haul link that occasionally resets TLS.
// An optional AbortSignal (from the queue, on shutdown) cancels any request or
// back-off sleep immediately and is never retried.

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanCjkSpacing } from './render.js';

const DEFAULT_BASE = 'https://api.assemblyai.com';
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

export class TranscriptionError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
    this.retryable = retryable;
  }
}

function networkCode(error) {
  return error?.cause?.code || error?.code || '';
}

function isNetworkError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError') return true;
  if (error.name === 'TypeError' && /fetch failed/i.test(error.message || '')) return true;
  if (NETWORK_CODES.has(networkCode(error))) return true;
  return /socket hang up|other side closed|terminated/i.test(error.message || '');
}

function abortableSleep(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  // The default sleep clears its own timer on abort; an injected one may not,
  // so the abort listener below still rejects promptly either way.
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(sleep(ms, signal)).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function requestSignal(signal, timeout) {
  const timer = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

function describe(error) {
  const code = networkCode(error);
  return code ? `${error.message}（${code}）` : (error?.message || '未知错误');
}

function normalizeUtterances(utterances) {
  if (!Array.isArray(utterances)) return [];
  return utterances
    .map((item) => ({
      speaker: String(item?.speaker ?? '?'),
      start: Number(item?.start) || 0,
      end: Number(item?.end) || 0,
      text: cleanCjkSpacing(item?.text),
    }))
    .filter((item) => item.text);
}

/**
 * Build a client that uploads one local file, submits a transcription job and
 * polls until it finishes. Every step throws a Chinese, user-facing message.
 */
export function createAssemblyAiClient({
  apiKey,
  baseUrl = DEFAULT_BASE,
  model = 'assemblyai-stt-3-7',
  keyterms = [],
  languageDetection = true,
  speakerLabels = true,
  minSpeakers = 1,
  maxSpeakers = 8,
  pollIntervalMs = 5000,
  timeoutMs = 45 * 60 * 1000,
  fetchImpl = globalThis.fetch,
  sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
  now = () => Date.now(),
  attempts = 4,
} = {}) {
  const endpoint = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');

  function requireKey() {
    if (!apiKey) {
      throw new TranscriptionError('尚未配置 ASSEMBLYAI_API_KEY，无法转写。', { status: 503 });
    }
  }

  async function withRetry(label, fn, maxAttempts = attempts, signal) {
    let last;
    for (let index = 0; index < maxAttempts; index += 1) {
      try {
        return await fn();
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        last = error;
        const retryable = error?.retryable || isNetworkError(error);
        if (!retryable || index === maxAttempts - 1) break;
        await abortableSleep(sleep, Math.min(15_000, 2000 * (index + 1)), signal);
      }
    }
    if (last instanceof TranscriptionError) throw last;
    throw new TranscriptionError(`${label}失败：${describe(last)}`, { retryable: true });
  }

  async function requestJson(path, { method = 'GET', body, headers = {}, timeout = 60_000, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method,
        headers: { authorization: apiKey, ...headers },
        body,
        signal: requestSignal(signal, timeout),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new TranscriptionError(`转写服务连接失败：${describe(error)}`, { retryable: true });
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const message = response.status === 401
        ? '转写服务鉴权失败，请检查 ASSEMBLYAI_API_KEY。'
        : `转写服务返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`;
      throw new TranscriptionError(message, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return response.json();
  }

  async function upload(filePath, size, signal) {
    return withRetry('音频上传', async () => {
      const stream = Readable.toWeb(createReadStream(filePath));
      let response;
      try {
        response = await fetchImpl(`${endpoint}/v2/upload`, {
          method: 'POST',
          headers: {
            authorization: apiKey,
            'content-type': 'application/octet-stream',
            'content-length': String(size),
          },
          body: stream,
          duplex: 'half',
          signal: requestSignal(signal, Math.max(120_000, Math.min(timeoutMs, 30 * 60 * 1000))),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new TranscriptionError(`音频上传失败：${describe(error)}`, { retryable: true });
      }
      if (!response.ok) {
        throw new TranscriptionError(`音频上传失败（HTTP ${response.status}）。`, { retryable: response.status >= 500 });
      }
      const payload = await response.json();
      if (!payload?.upload_url) throw new TranscriptionError('音频上传失败：服务未返回地址。');
      return payload.upload_url;
    }, 2, signal);
  }

  async function submit(audioUrl, signal) {
    const body = { audio_url: audioUrl, speech_models: [model] };
    if (languageDetection) body.language_detection = true;
    if (speakerLabels) {
      body.speaker_labels = true;
      body.speaker_options = { min_speakers_expected: minSpeakers, max_speakers_expected: maxSpeakers };
    }
    if (Array.isArray(keyterms) && keyterms.length) body.keyterms_prompt = keyterms.slice(0, 400);
    const payload = await withRetry('提交转写任务', () => requestJson('/v2/transcript', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 60_000,
      signal,
    }), attempts, signal);
    if (!payload?.id) throw new TranscriptionError('提交转写任务失败。');
    return payload.id;
  }

  async function poll(jobId, signal) {
    const deadline = now() + timeoutMs;
    let consecutiveFailures = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (now() > deadline) {
        throw new TranscriptionError('转写超时，请稍后重试。', { status: 504 });
      }
      let payload;
      try {
        payload = await requestJson(`/v2/transcript/${jobId}`, { timeout: 60_000, signal });
        consecutiveFailures = 0;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const retryable = error?.retryable || isNetworkError(error);
        if (!retryable || consecutiveFailures >= 8) throw error;
        consecutiveFailures += 1;
        await abortableSleep(sleep, Math.min(30_000, 3000 * consecutiveFailures), signal);
        continue;
      }
      if (payload.status === 'completed') return payload;
      if (payload.status === 'error') {
        throw new TranscriptionError(`转写失败：${payload.error || '服务未给出原因'}`);
      }
      await abortableSleep(sleep, pollIntervalMs, signal);
    }
  }

  async function transcribeFile({ filePath, size, mime, signal }) {
    requireKey();
    if (!filePath) throw new TranscriptionError('找不到录音文件。', { status: 404 });
    const audioUrl = await upload(filePath, size, signal);
    const jobId = await submit(audioUrl, signal);
    const payload = await poll(jobId, signal);
    const utterances = normalizeUtterances(payload.utterances);
    const speakers = [...new Set(utterances.map((item) => item.speaker))].sort();
    return {
      model: payload.speech_model_used || model,
      language: payload.language_code ?? null,
      durationMs: Math.round((Number(payload.audio_duration) || 0) * 1000),
      speakers,
      text: cleanCjkSpacing(payload.text ?? ''),
      utterances,
      jobId,
      completedAt: now(),
      mime: mime ?? null,
    };
  }

  return { transcribeFile, model };
}
