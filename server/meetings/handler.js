// HTTP surface for the meetings feature. Mounted from server/index.js under
// /api/meetings. All mutations require the session CSRF token and a same-site
// origin; reads only require the session.

import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { secretEquals } from '../auth/compare.js';
import { LoginRateLimiter } from '../auth/rate-limit.js';
import { AUDIO_EXTENSIONS, isValidMeetingId } from './store.js';
import { SettingsError } from './settings.js';

const MIME_EXT = new Map([
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/wave', '.wav'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['video/mp4', '.mp4'],
  ['audio/aac', '.aac'],
  ['audio/ogg', '.ogg'],
  ['audio/oga', '.oga'],
  ['audio/opus', '.opus'],
  ['audio/flac', '.flac'],
  ['audio/x-flac', '.flac'],
  ['audio/webm', '.webm'],
  ['video/webm', '.webm'],
  ['audio/amr', '.amr'],
  ['audio/x-ms-wma', '.wma'],
  ['application/octet-stream', '.wav'],
]);

const EXT_MIME = new Map([
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.webm', 'audio/webm'],
  ['.amr', 'audio/amr'],
  ['.wma', 'audio/x-ms-wma'],
]);

const MEETINGS_MESSAGES = {
  csrf: '请求已过期，请刷新页面后重试。',
  notFound: '找不到这条会议记录。',
  unsupported: '只支持常见音频格式（wav、mp3、m4a、aac、ogg、opus、flac、webm、amr、wma）。',
  tooLarge: '录音文件超过服务器允许的大小上限。',
  noAudio: '这条记录没有可用的录音文件。',
  noTranscript: '这条记录还没有转写稿。',
  summaryPlanned: '会议纪要未启用或未配置，请先到设置页选择纪要服务。',
  noSummary: '这条记录还没有会议纪要。',
  settingsUnreadable: '设置内容无法解析。',
  settingsRate: '保存过于频繁，请稍后再试。',
  uploadBusy: '这条记录正在上传，请稍后再试。',
  busyTranscribing: '这条记录正在转写，请等它完成后再操作。',
  tooManyUploads: '同时上传的文件太多，请等当前上传完成。',
  uploadFailed: '上传失败，请稍后重试。',
  empty: '请选择要上传的录音文件。',
  badFormat: '不支持的转写稿格式。',
  uploadAborted: '上传已中断。',
  audioDeleted: '录音已删除，且没有转写稿。',
};

const MAX_CONCURRENT_UPLOADS = 2;

function safeFilename(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-()\u4e00-\u9fff ]+/g, '_').replace(/^\.+/, '').slice(0, 100).trim();
  return cleaned || 'recording';
}

function extensionFor(name, contentType) {
  const fromName = extname(name).toLowerCase();
  if (AUDIO_EXTENSIONS.has(fromName)) return fromName;
  const fromType = MIME_EXT.get(String(contentType ?? '').split(';')[0].trim().toLowerCase());
  return fromType && AUDIO_EXTENSIONS.has(fromType) ? fromType : null;
}

function audioMime(meta) {
  if (meta?.audio?.mime && /^(audio|video)\//.test(meta.audio.mime)) return meta.audio.mime;
  return EXT_MIME.get(meta?.audio?.ext) ?? 'application/octet-stream';
}

function publicMeeting(meta, queue) {
  if (!meta) return null;
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: meta.status,
    error: meta.error ?? null,
    audio: meta.audio
      ? {
        filename: meta.audio.filename,
        ext: meta.audio.ext,
        bytes: meta.audio.bytes ?? 0,
        mime: meta.audio.mime ?? null,
        deleted: Boolean(meta.audio.deleted),
      }
      : null,
    transcript: meta.transcript
      ? {
        model: meta.transcript.model,
        language: meta.transcript.language,
        durationMs: meta.transcript.durationMs ?? 0,
        speakers: meta.transcript.speakers ?? [],
        completedAt: meta.transcript.completedAt ?? null,
        chars: meta.transcript.chars ?? 0,
      }
      : null,
    summary: meta.summary
      ? {
        status: meta.summary.status ?? null,
        provider: meta.summary.provider ?? null,
        error: meta.summary.error ?? null,
        requestedAt: meta.summary.requestedAt ?? null,
        completedAt: meta.summary.completedAt ?? null,
        chars: meta.summary.chars ?? 0,
        stale: Boolean(meta.summary.stale),
      }
      : null,
    queuePosition: queue?.position ? queue.position(meta.id) : null,
  };
}

// Settles only after the file descriptor is closed ('close'), so the caller
// can rename or delete the .part right away — Windows refuses both on an open
// file. A client that disconnects mid-body is detected through 'close' with
// an incomplete request, which also covers runtimes that no longer emit
// 'aborted'.
function streamToFile(req, destination, maxBytes) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'w' });
    let size = 0;
    let failure = null;
    let settled = false;

    function settle() {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      if (failure) reject(failure);
      else resolve(size);
    }

    function fail(error) {
      if (failure || settled) return;
      failure = error;
      req.off('data', onData);
      req.unpipe(output);
      req.resume();
      output.destroy();
    }

    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error(MEETINGS_MESSAGES.tooLarge), { statusCode: 413 }));
      }
    }

    const aborted = () => fail(Object.assign(new Error(MEETINGS_MESSAGES.uploadAborted), { statusCode: 400 }));
    output.on('error', fail);
    output.on('close', settle);
    req.on('aborted', aborted);
    req.on('error', fail);
    req.on('close', () => {
      if (!req.complete) aborted();
    });
    req.on('data', onData);
    req.pipe(output);
  });
}

export function createMeetingsHandler({
  config,
  store,
  queue,
  settings,
  summaries,
  now = () => Date.now(),
  securityHeaders,
  originAllowed,
  logger = console,
  settingsLimiter = new LoginRateLimiter({ windowMs: 60 * 1000, maxAttempts: 20 }),
}) {
  const uploading = new Set();
  let inflightUploads = 0;

  function sendJson(res, status, payload, extra = {}) {
    res.writeHead(status, {
      ...securityHeaders('application/json; charset=utf-8'),
      ...extra,
    });
    res.end(JSON.stringify(payload));
  }

  function originAllowedFor(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // index.js already rejects POSTs without an allowed Origin; this also covers DELETE.
    if (typeof originAllowed === 'function') return originAllowed(req);
    return origin === config.siteOrigin;
  }

  function guard(req, res, session) {
    if (!['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method)) return true;
    if (!originAllowedFor(req)) {
      sendJson(res, 403, { error: '来源校验失败。' });
      return false;
    }
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !secretEquals(token, session.csrf)) {
      sendJson(res, 403, { error: MEETINGS_MESSAGES.csrf });
      return false;
    }
    return true;
  }

  async function stats(meetings) {
    const list = meetings ?? await store.list();
    const counts = { draft: 0, queued: 0, transcribing: 0, done: 0, failed: 0 };
    let audioBytes = 0;
    let transcriptCount = 0;
    for (const meta of list) {
      if (counts[meta.status] !== undefined) counts[meta.status] += 1;
      if (meta.audio && !meta.audio.deleted) audioBytes += Number(meta.audio.bytes) || 0;
      if (meta.transcript) transcriptCount += 1;
    }
    return { total: list.length, counts, audioBytes, transcriptCount };
  }

  async function listMeetings(res) {
    const meetings = await store.list();
    let features = { summaryEnabled: false, provider: null };
    if (settings) {
      const [transcription, summary] = await Promise.all([settings.resolveTranscription(), settings.resolveSummary()]);
      features = {
        summaryEnabled: Boolean(summary.provider?.available?.()),
        provider: transcription.providerId,
        providerReady: Boolean(transcription.apiKey),
      };
    }
    sendJson(res, 200, {
      meetings: meetings.map((meta) => publicMeeting(meta, queue)),
      stats: await stats(meetings),
      queueSize: queue.size?.() ?? 0,
      limits: { maxUploadBytes: config.meetingsMaxUploadBytes },
      features,
    });
  }

  async function createMeeting(req, res, readJson) {
    let body;
    try {
      body = await readJson(req, 8 * 1024);
    } catch {
      sendJson(res, 400, { error: '请求内容无法解析。' });
      return;
    }
    const meta = await store.create({ title: typeof body?.title === 'string' ? body.title : '' });
    sendJson(res, 201, { meeting: publicMeeting(meta, queue) });
  }

  async function uploadAudio(req, res, url, id) {
    const meta = await store.get(id);
    if (!meta) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    if (uploading.has(id)) {
      sendJson(res, 409, { error: MEETINGS_MESSAGES.uploadBusy });
      return;
    }
    if (meta.status === 'transcribing') {
      sendJson(res, 409, { error: MEETINGS_MESSAGES.busyTranscribing });
      return;
    }

    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const name = safeFilename(url.searchParams.get('name'));
    const ext = extensionFor(name, contentType);
    if (!ext) {
      sendJson(res, 415, { error: MEETINGS_MESSAGES.unsupported });
      return;
    }
    const acceptedType = contentType.startsWith('audio/')
      || contentType === 'video/mp4'
      || contentType === 'video/webm'
      || contentType === 'application/octet-stream';
    if (!acceptedType) {
      sendJson(res, 415, { error: MEETINGS_MESSAGES.unsupported });
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.meetingsMaxUploadBytes) {
      sendJson(res, 413, { error: MEETINGS_MESSAGES.tooLarge }, { Connection: 'close' });
      return;
    }
    if (inflightUploads >= MAX_CONCURRENT_UPLOADS) {
      sendJson(res, 429, { error: MEETINGS_MESSAGES.tooManyUploads });
      return;
    }

    uploading.add(id);
    inflightUploads += 1;
    const directory = store.dir(id);
    const temporary = join(directory, `upload-${now()}.part`);
    try {
      await mkdir(directory, { recursive: true });
      const bytes = await streamToFile(req, temporary, config.meetingsMaxUploadBytes);
      if (!bytes) {
        await rm(temporary, { force: true });
        sendJson(res, 400, { error: MEETINGS_MESSAGES.empty });
        return;
      }
      // One locked write: replace the recording (dropping an old file with a
      // different extension) and queue it, based on the meta as it is *now*,
      // not as it was when the upload started minutes ago.
      const queued = await store.attachAudio(id, {
        temporaryPath: temporary,
        ext,
        bytes,
        mime: EXT_MIME.get(ext) ?? contentType,
        filename: name,
      }, {
        status: 'queued',
        error: null,
        queue: { enqueuedAt: now(), startedAt: null, finishedAt: null },
      });
      if (!queued) {
        // The meeting was deleted while the upload was in flight.
        await rm(temporary, { force: true }).catch(() => {});
        sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
        return;
      }
      queue.enqueue(id);
      sendJson(res, 201, { meeting: publicMeeting(queued, queue) });
    } catch (error) {
      await rm(temporary, { force: true, maxRetries: 3 }).catch(() => {});
      if (error.statusCode === 413) {
        sendJson(res, 413, { error: MEETINGS_MESSAGES.tooLarge }, { Connection: 'close' });
        return;
      }
      logger?.error?.('[meetings] 上传失败:', error?.message ?? error);
      const message = error.statusCode ? (error.message || MEETINGS_MESSAGES.uploadFailed) : MEETINGS_MESSAGES.uploadFailed;
      sendJson(res, error.statusCode ?? 500, { error: message });
    } finally {
      uploading.delete(id);
      inflightUploads -= 1;
    }
  }

  async function transcribe(req, res, id) {
    const meta = await store.get(id);
    if (!meta) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    if (!meta.audio || meta.audio.deleted) {
      sendJson(res, 409, { error: MEETINGS_MESSAGES.noAudio });
      return;
    }
    if (meta.status === 'transcribing') {
      sendJson(res, 409, { error: MEETINGS_MESSAGES.busyTranscribing });
      return;
    }
    // Re-check under the lock: the audio may have been deleted or the worker
    // may have started since the read above.
    let refusal = MEETINGS_MESSAGES.notFound;
    let refusalStatus = 404;
    const updated = await store.update(id, (current) => {
      if (!current.audio || current.audio.deleted) {
        refusal = MEETINGS_MESSAGES.noAudio;
        refusalStatus = 409;
        return null;
      }
      if (current.status === 'transcribing') {
        refusal = MEETINGS_MESSAGES.busyTranscribing;
        refusalStatus = 409;
        return null;
      }
      return { status: 'queued', error: null, queue: { enqueuedAt: now(), startedAt: null, finishedAt: null } };
    });
    if (!updated) {
      sendJson(res, refusalStatus, { error: refusal });
      return;
    }
    queue.enqueue(id);
    sendJson(res, 200, { meeting: publicMeeting(updated, queue) });
  }

  async function deleteAudio(res, id) {
    const meta = await store.get(id);
    if (!meta) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    // Deleting the recording cancels any queued work for this meeting. A job
    // that is already running notices the changed audio token and discards
    // its result. Deleting the file and settling the status is one write.
    queue.dequeue?.(id);
    const updated = await store.deleteAudio(id, {
      settle: (current) => {
        if (current.status !== 'queued' && current.status !== 'transcribing') return {};
        return current.transcript
          ? { status: 'done', error: null, queue: { finishedAt: now() } }
          : { status: 'failed', error: MEETINGS_MESSAGES.audioDeleted, queue: { finishedAt: now() } };
      },
    });
    if (!updated) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    sendJson(res, 200, { meeting: publicMeeting(updated, queue) });
  }

  async function removeMeeting(res, id) {
    const meta = await store.get(id);
    if (!meta) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    queue.dequeue?.(id);
    summaries?.cancel?.(id);
    await store.remove(id);
    sendJson(res, 200, { ok: true });
  }

  async function serveTranscript(req, res, url, id) {
    const meta = await store.get(id);
    if (!meta) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    // Validate the request before the state, so a bad format is a 400 even when
    // the meeting has no transcript yet.
    const format = String(url.searchParams.get('format') ?? 'json').toLowerCase();
    if (!['json', 'md', 'txt'].includes(format)) {
      sendJson(res, 400, { error: MEETINGS_MESSAGES.badFormat });
      return;
    }
    if (!meta.transcript) {
      sendJson(res, 409, { error: MEETINGS_MESSAGES.noTranscript });
      return;
    }
    if (format === 'md' || format === 'txt') {
      const body = await store.readTranscriptExport(id, format);
      if (body == null) {
        sendJson(res, 404, { error: MEETINGS_MESSAGES.noTranscript });
        return;
      }
      const filename = `${safeFilename(meta.title)}.${format}`;
      const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      res.writeHead(200, {
        ...securityHeaders(`text/${format === 'md' ? 'markdown' : 'plain'}; charset=utf-8`),
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      res.end(body);
      return;
    }
    const transcript = await store.readTranscript(id);
    if (!transcript) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.noTranscript });
      return;
    }
    sendJson(res, 200, { meeting: publicMeeting(meta, queue), transcript });
  }

  async function serveAudio(req, res, id) {
    const meta = await store.get(id);
    if (!meta) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }
    if (!meta.audio || meta.audio.deleted) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.noAudio });
      return;
    }
    const info = await store.audioStat(id, meta);
    if (!info) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.noAudio });
      return;
    }

    const mime = audioMime(meta);
    const range = req.headers.range;
    if (typeof range === 'string') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match && match[1] === '' && match[2] === '') {
        res.writeHead(416, { ...securityHeaders(mime), 'Content-Range': `bytes */${info.size}` });
        res.end();
        return;
      }
      if (match) {
        let start = match[1] === '' ? null : Number(match[1]);
        let end = match[2] === '' ? null : Number(match[2]);
        if (start == null && end != null) {
          start = Math.max(0, info.size - end);
          end = info.size - 1;
        }
        start = start ?? 0;
        end = end == null ? info.size - 1 : Math.min(end, info.size - 1);
        if (start <= end && start < info.size) {
          res.writeHead(206, {
            ...securityHeaders(mime),
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          });
          const stream = store.openAudio(id, meta, { start, end });
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        res.writeHead(416, { ...securityHeaders(mime), 'Content-Range': `bytes */${info.size}` });
        res.end();
        return;
      }
    }

    res.writeHead(200, {
      ...securityHeaders(mime),
      'Content-Length': String(info.size),
      'Accept-Ranges': 'bytes',
    });
    const stream = store.openAudio(id, meta);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ── settings ─────────────────────────────────────────────────────────────
  async function getSettings(res) {
    if (!settings) return sendJson(res, 404, { error: 'not found' });
    sendJson(res, 200, { settings: await settings.public() });
  }

  async function putSettings(req, res, readJson, session) {
    if (!settings) return sendJson(res, 404, { error: 'not found' });
    const rate = settingsLimiter.check(`settings:${session.username}`, now());
    if (!rate.allowed) return sendJson(res, 429, { error: MEETINGS_MESSAGES.settingsRate });
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch (error) {
      const status = error?.statusCode === 413 ? 413 : 400;
      return sendJson(res, status, { error: MEETINGS_MESSAGES.settingsUnreadable }, status === 413 ? { Connection: 'close' } : {});
    }
    try {
      const next = await settings.update(body ?? {});
      sendJson(res, 200, { settings: next });
    } catch (error) {
      if (error instanceof SettingsError) return sendJson(res, 400, { error: error.message, field: error.field });
      logger?.error?.('[meetings] 保存设置失败:', error?.message ?? error);
      sendJson(res, 500, { error: '保存设置失败，请稍后重试。' });
    }
  }

  // ── summaries ────────────────────────────────────────────────────────────
  async function requestSummary(res, id) {
    if (!summaries) return sendJson(res, 501, { error: MEETINGS_MESSAGES.summaryPlanned });
    const meta = await store.get(id);
    if (!meta) return sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
    const result = await summaries.request(id);
    if (result.error) {
      // 501 keeps the "not wired up" answer the page and tests already expect.
      const status = result.status === 503 ? 501 : result.status;
      return sendJson(res, status, { error: result.error });
    }
    sendJson(res, 202, { meeting: publicMeeting(result.meta, queue) });
  }

  async function serveSummary(req, res, url, id) {
    const meta = await store.get(id);
    if (!meta) return sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
    const format = String(url.searchParams.get('format') ?? 'json').toLowerCase();
    if (!['json', 'md'].includes(format)) return sendJson(res, 400, { error: MEETINGS_MESSAGES.badFormat });
    const markdown = meta.summary?.status === 'done' || meta.summary?.chars ? await store.readSummary(id) : null;
    if (markdown == null) return sendJson(res, 409, { error: MEETINGS_MESSAGES.noSummary });
    if (format === 'md') {
      const filename = `${safeFilename(meta.title)}-纪要.md`;
      const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      res.writeHead(200, {
        ...securityHeaders('text/markdown; charset=utf-8'),
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      res.end(markdown);
      return;
    }
    sendJson(res, 200, { meeting: publicMeeting(meta, queue), markdown });
  }

  async function handle(req, res, { pathname, url, session, readJson }) {
    if (!guard(req, res, session)) return;

    const parts = pathname.split('/').filter(Boolean); // api / meetings / :id / :action / :sub
    const [, , rawId, action, sub] = parts;

    if (parts.length === 3 && rawId === 'settings') {
      if (req.method === 'GET') return getSettings(res);
      if (req.method === 'PUT' || req.method === 'POST') return putSettings(req, res, readJson, session);
      return sendJson(res, 405, { error: '方法不被支持。' });
    }

    if (parts.length === 2) {
      if (req.method === 'GET') return listMeetings(res);
      if (req.method === 'POST') return createMeeting(req, res, readJson);
      return sendJson(res, 405, { error: '方法不被支持。' });
    }

    const id = rawId;
    if (!isValidMeetingId(id)) {
      sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
      return;
    }

    if (parts.length === 3) {
      if (req.method === 'GET') {
        const meta = await store.get(id);
        if (!meta) {
          sendJson(res, 404, { error: MEETINGS_MESSAGES.notFound });
          return;
        }
        sendJson(res, 200, { meeting: publicMeeting(meta, queue) });
        return;
      }
      if (req.method === 'DELETE') return removeMeeting(res, id);
      return sendJson(res, 405, { error: '方法不被支持。' });
    }

    if (parts.length === 4) {
      if (action === 'audio') {
        if (req.method === 'POST') return uploadAudio(req, res, url, id);
        if (req.method === 'GET') return serveAudio(req, res, id);
        if (req.method === 'DELETE') return deleteAudio(res, id);
        return sendJson(res, 405, { error: '方法不被支持。' });
      }
      if (action === 'transcript' && req.method === 'GET') return serveTranscript(req, res, url, id);
      if (action === 'transcribe' && req.method === 'POST') return transcribe(req, res, id);
      if (action === 'summary' && req.method === 'POST') return requestSummary(res, id);
      if (action === 'summary' && req.method === 'GET') return serveSummary(req, res, url, id);
      return sendJson(res, 405, { error: '方法不被支持。' });
    }

    if (parts.length === 5 && action === 'audio' && sub === 'delete' && req.method === 'POST') {
      return deleteAudio(res, id);
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return { handle };
}

export { MEETINGS_MESSAGES };
