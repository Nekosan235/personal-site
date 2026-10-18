import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAllowedCdn } from './allowlist.js';
import { createCdnTransport } from './cdn.js';
import { MEDIA_MESSAGES, MediaError } from './errors.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

function signaturesMatch(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signMediaTarget(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `/api/media/file?d=${encodeURIComponent(body)}&s=${encodeURIComponent(sig)}`;
}

export function verifyMediaTarget(body, sig, secret, now) {
  if (!body || !sig || !secret) return { error: MEDIA_MESSAGES.invalidLink };
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!signaturesMatch(sig, expected)) return { error: MEDIA_MESSAGES.invalidLink };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { error: MEDIA_MESSAGES.invalidLink };
  }
  if (!payload || typeof payload.url !== 'string' || typeof payload.exp !== 'number') {
    return { error: MEDIA_MESSAGES.invalidLink };
  }
  if (payload.exp < now) return { error: MEDIA_MESSAGES.expired };
  if (!isAllowedCdn(payload.url)) return { error: MEDIA_MESSAGES.outside };
  if (payload.platform !== 'xiaohongshu' && payload.platform !== 'douyin') return { error: MEDIA_MESSAGES.invalidLink };
  if (payload.kind !== 'image' && payload.kind !== 'video') return { error: MEDIA_MESSAGES.invalidLink };
  return { payload };
}

export function createMediaSigner(secret, ttlMs = DEFAULT_TTL_MS, now = () => Date.now()) {
  return function proxify(cdnUrl, meta) {
    return signMediaTarget({
      url: cdnUrl,
      platform: meta.platform,
      kind: meta.kind,
      filename: meta.filename,
      exp: now() + ttlMs,
    }, secret);
  };
}

function headerToken(value) {
  const text = String(value ?? '');
  if (!text || /[\r\n]/.test(text)) return '';
  return text;
}

function safeContentType(value, kind) {
  const text = headerToken(value).split(';')[0].trim().toLowerCase();
  if (/^image\/(?:jpeg|png|webp|gif|heic|heif)$/.test(text)) return text;
  if (/^video\/(?:mp4|webm|quicktime)$/.test(text)) return text;
  if (text === 'application/octet-stream') return text;
  if (!text) return kind === 'video' ? 'video/mp4' : 'image/jpeg';
  return 'application/octet-stream';
}

function safeLength(value) {
  const text = headerToken(Array.isArray(value) ? value[0] : value);
  return /^\d+$/.test(text) ? text : '';
}

function safeContentRange(value) {
  const text = headerToken(Array.isArray(value) ? value[0] : value);
  return /^bytes \d+-\d+\/(\d+|\*)$/.test(text) ? text : '';
}

function contentDisposition(filename, download) {
  const cleaned = headerToken(filename).replace(/["\\]/g, '').slice(0, 120) || 'media.bin';
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_') || 'media.bin';
  const type = download ? 'attachment' : 'inline';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

export function clientRange(value) {
  const text = headerToken(Array.isArray(value) ? value[0] : value);
  return /^bytes=\d*-\d*$/.test(text) ? text : '';
}

export async function pipeMediaFile({
  req,
  res,
  target,
  download,
  transport,
  securityHeaders,
  sendJson,
}) {
  let upstream;
  try {
    upstream = await transport({
      url: target.url,
      platform: target.platform,
      range: clientRange(req.headers.range),
    });
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MEDIA_MESSAGES.file, 502, 'upstream');
    sendJson(res, mediaError.statusCode, { error: mediaError.message });
    return;
  }
  if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
    upstream.body.resume?.();
    sendJson(res, 502, { error: MEDIA_MESSAGES.file });
    return;
  }
  const type = safeContentType(upstream.headers['content-type'], target.kind);
  const headers = {
    ...securityHeaders(type),
    'Content-Disposition': contentDisposition(target.filename, download),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  };
  const length = safeLength(upstream.headers['content-length']);
  const contentRange = safeContentRange(upstream.headers['content-range']);
  if (length) headers['Content-Length'] = length;
  if (contentRange) headers['Content-Range'] = contentRange;
  res.writeHead(upstream.statusCode, headers);
  const stop = () => upstream.body.destroy?.();
  res.on('close', stop);
  upstream.body.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  upstream.body.pipe(res);
}

export function defaultMediaTransport() {
  return createCdnTransport();
}
