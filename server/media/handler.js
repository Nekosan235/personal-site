import { secretEquals } from '../auth/compare.js';
import { LoginRateLimiter } from '../auth/rate-limit.js';
import { parseShareText } from './client.js';
import { checkMediaBackends, publicMediaStatus } from './health.js';
import { createMediaSigner, defaultMediaTransport, pipeMediaFile, verifyMediaTarget } from './proxy.js';
import { MEDIA_MESSAGES, MediaError } from './errors.js';

function sendMediaJson(res, status, payload, securityHeaders, extra = {}) {
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    ...extra,
  });
  res.end(JSON.stringify(payload));
}

export function createMediaHandler({
  config,
  fetchImpl = globalThis.fetch,
  transport = defaultMediaTransport(),
  parseLimiter = new LoginRateLimiter({ windowMs: 10 * 60 * 1000, maxAttempts: 20 }),
  healthLimiter = new LoginRateLimiter({ windowMs: 10 * 60 * 1000, maxAttempts: 30 }),
  now = () => Date.now(),
  securityHeaders,
}) {
  const proxify = createMediaSigner(config.authSecret, config.mediaProxyTtlMs, now);

  async function handle(req, res, { pathname, url, session, readJson }) {
    const sendJson = (response, status, payload, extra) => sendMediaJson(response, status, payload, securityHeaders, extra);

    if (req.method === 'GET' && pathname === '/api/media/health') {
      const rate = healthLimiter.check(`health:${session.username}`, now());
      if (!rate.allowed) {
        sendJson(res, 429, { error: MEDIA_MESSAGES.rate });
        return;
      }
      const status = publicMediaStatus(await checkMediaBackends({
        ...config,
        mediaProbeTimeoutMs: config.mediaProbeTimeoutMs,
      }, fetchImpl));
      sendJson(res, 200, status);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/media/parse') {
      const token = req.headers['x-csrf-token'];
      if (!secretEquals(token, session.csrf)) {
        sendJson(res, 403, { error: MEDIA_MESSAGES.csrf });
        return;
      }
      const rate = parseLimiter.check(`parse:${session.username}`, now());
      if (!rate.allowed) {
        sendJson(res, 429, { error: MEDIA_MESSAGES.rate });
        return;
      }
      let body;
      try {
        body = await readJson(req, 32 * 1024);
      } catch (error) {
        if (error.closeConnection) res.shouldKeepAlive = false;
        const status = error.statusCode ?? 400;
        sendJson(
          res,
          status,
          { error: status === 413 ? MEDIA_MESSAGES.tooLong : MEDIA_MESSAGES.unreadable },
          error.closeConnection ? { Connection: 'close' } : {},
        );
        return;
      }
      const text = typeof body?.text === 'string' ? body.text : '';
      if (!text.trim()) {
        sendJson(res, 400, { error: MEDIA_MESSAGES.paste });
        return;
      }
      if (text.length > 8000) {
        sendJson(res, 400, { error: MEDIA_MESSAGES.tooLong });
        return;
      }
      try {
        const work = await parseShareText(text, {
          config,
          fetchImpl,
          proxify,
          timeoutMs: config.mediaParseTimeoutMs,
        });
        sendJson(res, 200, work);
      } catch (error) {
        const mediaError = error instanceof MediaError
          ? error
          : new MediaError(MEDIA_MESSAGES.generic, 502, 'parse_failed');
        sendJson(res, mediaError.statusCode, { error: mediaError.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/media/file') {
      const verified = verifyMediaTarget(url.searchParams.get('d') || '', url.searchParams.get('s') || '', config.authSecret, now());
      if (verified.error) {
        sendJson(res, 400, { error: verified.error });
        return;
      }
      await pipeMediaFile({
        req,
        res,
        target: verified.payload,
        download: url.searchParams.get('dl') === '1',
        transport,
        securityHeaders,
        sendJson,
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return { handle };
}
