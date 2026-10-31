import { secretEquals } from '../auth/compare.js';
import { LoginRateLimiter } from '../auth/rate-limit.js';
import { assertLoopbackBase } from '../media/allowlist.js';
import {
  MATTING_MAX_BYTES,
  MATTING_MAX_RESPONSE_BYTES,
  MATTING_MESSAGES,
  describeUpstreamFailure,
  inputImageType,
  parseMattingQuery,
  refinementFields,
} from './options.js';

function sendJson(res, status, payload, securityHeaders) {
  res.writeHead(status, securityHeaders('application/json; charset=utf-8'));
  res.end(JSON.stringify(payload));
}

function discard(req) {
  req.resume();
}

function readBytes(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.resume();
      reject(error);
    }

    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error(MATTING_MESSAGES.tooLarge), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    }

    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(error));
  });
}

async function readSnippet(response, maxBytes) {
  if (!response.body?.getReader) {
    await response.body?.cancel?.().catch(() => {});
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    return { error: 'large' };
  }
  if (!response.body) return { bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: 'large' };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return { bytes: Buffer.concat(chunks) };
}

export function createMattingHandler({
  config,
  fetchImpl = globalThis.fetch,
  limiter = new LoginRateLimiter({ windowMs: 10 * 60 * 1000, maxAttempts: 40 }),
  maxConcurrent = 1,
  now = () => Date.now(),
  securityHeaders,
}) {
  let inflight = 0;

  async function probe(origin) {
    const response = await fetchImpl(new URL('/api', origin), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
    });
    await response.body?.cancel?.().catch(() => {});
    return response.status >= 200 && response.status < 400;
  }

  async function handle(req, res, { pathname, url, session }) {
    if (req.method === 'GET' && pathname === '/api/matting/health') {
      const origin = assertLoopbackBase(config.rembgApiUrl);
      if (!origin) {
        sendJson(res, 200, { ok: false, reason: 'config' }, securityHeaders);
        return;
      }
      try {
        const up = await probe(origin);
        sendJson(res, 200, { ok: up, reason: up ? 'ok' : 'down' }, securityHeaders);
      } catch {
        sendJson(res, 200, { ok: false, reason: 'down' }, securityHeaders);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/matting/remove') {
      const token = req.headers['x-csrf-token'];
      if (!secretEquals(token, session.csrf)) {
        discard(req);
        sendJson(res, 403, { error: MATTING_MESSAGES.csrf }, securityHeaders);
        return;
      }
      const rate = limiter.check(`matting:${session.username}`, now());
      if (!rate.allowed) {
        discard(req);
        sendJson(res, 429, { error: MATTING_MESSAGES.rate }, securityHeaders);
        return;
      }
      const query = parseMattingQuery(url);
      if (query.error) {
        discard(req);
        sendJson(res, 400, { error: query.error }, securityHeaders);
        return;
      }
      const image = inputImageType(req.headers['content-type']);
      if (!image) {
        discard(req);
        sendJson(res, 400, { error: MATTING_MESSAGES.type }, securityHeaders);
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MATTING_MAX_BYTES) {
        discard(req);
        sendJson(res, 413, { error: MATTING_MESSAGES.tooLarge }, securityHeaders);
        return;
      }
      if (inflight >= maxConcurrent) {
        discard(req);
        sendJson(res, 429, { error: MATTING_MESSAGES.busy }, securityHeaders);
        return;
      }

      inflight += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.rembgTimeoutMs);
      const stopIfGone = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', stopIfGone);
      try {
        let bytes;
        try {
          bytes = await readBytes(req, MATTING_MAX_BYTES);
        } catch (error) {
          const status = error.statusCode === 413 ? 413 : 400;
          sendJson(res, status, { error: status === 413 ? MATTING_MESSAGES.tooLarge : MATTING_MESSAGES.empty }, securityHeaders);
          return;
        }
        if (!bytes.length) {
          sendJson(res, 400, { error: MATTING_MESSAGES.empty }, securityHeaders);
          return;
        }
        const origin = assertLoopbackBase(config.rembgApiUrl);
        if (!origin) {
          sendJson(res, 500, { error: MATTING_MESSAGES.loopback }, securityHeaders);
          return;
        }
        const form = new FormData();
        form.set('file', new Blob([bytes], { type: image.type }), image.filename);
        form.set('model', query.model);
        for (const [key, value] of Object.entries(refinementFields(query.refine))) form.set(key, value);
        let upstream;
        try {
          upstream = await fetchImpl(new URL('/api/remove', origin), {
            method: 'POST',
            body: form,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (error) {
          const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
          if (!res.writableEnded) {
            sendJson(res, 502, { error: timedOut ? MATTING_MESSAGES.timeout : MATTING_MESSAGES.down }, securityHeaders);
          }
          return;
        }
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel?.().catch(() => {});
          sendJson(res, 502, { error: MATTING_MESSAGES.redirect }, securityHeaders);
          return;
        }
        if (!upstream.ok) {
          const detail = await readSnippet(upstream, 2048);
          sendJson(res, 502, { error: describeUpstreamFailure(upstream.status, detail) }, securityHeaders);
          return;
        }
        const outputType = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!outputType.startsWith('image/')) {
          await upstream.body?.cancel?.().catch(() => {});
          sendJson(res, 502, { error: MATTING_MESSAGES.notImage }, securityHeaders);
          return;
        }
        const output = await readLimited(upstream, MATTING_MAX_RESPONSE_BYTES);
        if (output.error || !output.bytes?.length) {
          sendJson(res, 502, { error: output.error === 'large' ? MATTING_MESSAGES.resultTooLarge : MATTING_MESSAGES.notImage }, securityHeaders);
          return;
        }
        if (res.writableEnded) return;
        res.writeHead(200, {
          ...securityHeaders('image/png'),
          'Cache-Control': 'private, no-store',
          'Content-Length': output.bytes.length,
        });
        res.end(output.bytes);
      } finally {
        clearTimeout(timer);
        res.off('close', stopIfGone);
        inflight -= 1;
      }
      return;
    }

    discard(req);
    sendJson(res, 404, { error: 'not found' }, securityHeaders);
  }

  return { handle };
}
