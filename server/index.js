import { createServer } from 'node:http';
import { createReadStream, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig, validateRuntimeConfig } from './config.js';
import { clientIp } from './auth/client-ip.js';
import { secretEquals } from './auth/compare.js';
import { COOKIE_NAMES, clearCookie, parseCookies, preloginCookie, sessionCookie } from './auth/cookies.js';
import { verifyPassword } from './auth/password.js';
import { createPreloginToken, verifyPreloginToken } from './auth/prelogin.js';
import { LoginRateLimiter } from './auth/rate-limit.js';
import { SessionStore } from './auth/sessions.js';
import { getModules } from './modules/catalog.js';
import { createMediaHandler } from './media/handler.js';
import { getDashboardMock } from './providers/mock.js';
import { createLiveDashboardProvider } from './providers/live.js';
import { NasMonitorStore, cloudDashboardDevice } from './providers/nas.js';
import { attachTerminalGateway } from './terminal/gateway.js';

const PUBLIC_ASSETS = new Set([
  '/assets/login.js',
  '/assets/styles.css',
  '/assets/vendor/tabler/tabler.min.css',
  '/assets/favicon.svg',
  '/assets/theme-bootstrap.js',
  '/assets/components/ambient.js',
  '/assets/components/appearance.js',
  '/assets/components/dom.js',
  '/assets/components/solar.js',
  '/assets/components/theme.js',
]);
const PROTECTED_ASSET_PREFIXES = ['/assets/components/', '/assets/pages/', '/assets/portfolio/', '/assets/vendor/xterm/'];
const PROTECTED_ASSETS = new Set(['/assets/app.js']);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

function securityHeaders(contentType, hsts = false) {
  const headers = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'off',
    'Cache-Control': 'private, no-store',
  };
  if (hsts) headers['Strict-Transport-Security'] = 'max-age=31536000';
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { ...securityHeaders(headers['Content-Type'], Boolean(res.hsts)), ...headers });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function redirect(res, location, headers = {}) {
  send(res, 303, '', { ...headers, Location: location });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function echoUsername(value) {
  return escapeHtml(String(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128));
}

function fillTemplate(content, replacements) {
  return content.replace(/\{\{[A-Z0-9_]+\}\}/g, (token) => (
    Object.prototype.hasOwnProperty.call(replacements, token) ? replacements[token] : token
  ));
}

function isAllowedOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return false;
  const allowed = new Set([config.siteOrigin]);
  if (config.nodeEnv !== 'production') {
    allowed.add(`http://${config.host}:${config.port}`);
    allowed.add(`http://127.0.0.1:${config.port}`);
    allowed.add(`http://localhost:${config.port}`);
  }
  return allowed.has(origin);
}

function safePathFromUrl(pathname) {
  if (pathname.includes('\0') || pathname.includes('%00')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const normalized = normalize(decoded).replace(/^(\.\.(?:\/|\\|$))+/, '');
  if (normalized.includes('..')) return null;
  return normalized.replace(/^[/\\]+/, '');
}

function resolvePublicPath(publicDir, pathname) {
  const safePath = safePathFromUrl(pathname);
  if (!safePath) return null;
  const fullPath = resolve(publicDir, safePath);
  const root = resolve(publicDir);
  if (fullPath !== root && !fullPath.startsWith(root + sep)) return null;
  return fullPath;
}

function isProtectedAsset(pathname) {
  return PROTECTED_ASSETS.has(pathname) || PROTECTED_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isPublicAsset(pathname) {
  return PUBLIC_ASSETS.has(pathname);
}

async function serveFile(res, publicDir, pathname, replacements = null) {
  const fullPath = resolvePublicPath(publicDir, pathname);
  if (!fullPath) return send(res, 404, 'Not found');

  let fileStat;
  try {
    fileStat = await stat(fullPath);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!fileStat.isFile()) return send(res, 404, 'Not found');

  const type = MIME_TYPES.get(extname(fullPath).toLowerCase()) ?? 'application/octet-stream';
  if (replacements) {
    const content = fillTemplate(await readFile(fullPath, 'utf8'), replacements);
    return send(res, 200, content, { 'Content-Type': type });
  }

  const stream = createReadStream(fullPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      send(res, 500, 'Internal server error');
      return;
    }
    res.destroy();
  });
  res.writeHead(200, securityHeaders(type, Boolean(res.hsts)));
  stream.pipe(res);
}

async function serveTemplate(res, publicDir, pathname, replacements, headers = {}, status = 200) {
  const fullPath = resolvePublicPath(publicDir, pathname);
  if (!fullPath) return send(res, 404, 'Not found', headers);
  let content;
  try {
    content = await readFile(fullPath, 'utf8');
  } catch {
    return send(res, 404, 'Not found', headers);
  }
  content = fillTemplate(content, replacements);
  return send(res, status, content, { 'Content-Type': MIME_TYPES.get(extname(fullPath)) ?? 'text/html; charset=utf-8', ...headers });
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.resume();
      rejectBody(error);
    }

    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejectOnce(Object.assign(new Error('Request body too large'), {
          statusCode: 413,
          closeConnection: true,
        }));
        return;
      }
      chunks.push(chunk);
    }

    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => rejectOnce(error));
  });
}

async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  if (!raw) return {};
  return JSON.parse(raw);
}

function getSession(req, store) {
  const cookies = parseCookies(req.headers.cookie);
  return store.get(cookies.get(COOKIE_NAMES.session));
}

function requireSession(req, res, store) {
  const session = getSession(req, store);
  if (!session) {
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
  return session;
}

function verifyCsrf(req, session) {
  const token = req.headers['x-csrf-token'];
  return typeof token === 'string' && secretEquals(token, session.csrf);
}

function forbidden(res) {
  sendJson(res, 403, { error: 'forbidden' });
}

export function createApplication(options = {}) {
  const config = loadConfig(process.env, options.config ?? {});
  const store = options.sessionStore ?? new SessionStore(config.databasePath);
  const rateOptions = options.rateLimit ?? {};
  const limiter = options.loginRateLimiter ?? new LoginRateLimiter(rateOptions);
  const accountLimiter = options.loginAccountRateLimiter ?? new LoginRateLimiter({
    windowMs: rateOptions.windowMs ?? 15 * 60 * 1000,
    maxAttempts: rateOptions.maxAccountAttempts ?? 5,
    maxEntries: rateOptions.maxEntries ?? 4096,
  });
  const hstsEnabled = config.cookieSecure || String(config.siteOrigin).startsWith('https://');
  const now = options.now ?? (() => Date.now());
  const publicDir = config.publicDir;
  const businessPages = new Set(getModules(config).filter((module) => module.path).map((module) => module.path));
  const dashboardProvider = options.dashboardProvider
    ?? (config.monitoringMode === 'live' ? createLiveDashboardProvider(config, options.monitoring) : null);
  const nasMonitorStore = options.nasMonitorStore ?? new NasMonitorStore(config, options.nasMonitoring);
  const media = createMediaHandler({
    config,
    fetchImpl: options.mediaFetch,
    transport: options.mediaTransport,
    parseLimiter: options.mediaRateLimiter,
    healthLimiter: options.mediaHealthRateLimiter,
    now,
    securityHeaders: (contentType) => securityHeaders(contentType, hstsEnabled),
  });
  dashboardProvider?.start?.();

  function renderLogin(res, { status = 200, username = '', showError = false, headers = {} } = {}) {
    const csrf = randomBytes(24).toString('base64url');
    const token = createPreloginToken(
      { csrf, expires: now() + config.loginTtlMs },
      config.authSecret || 'dev-insecure-secret',
    );
    const safeUsername = echoUsername(username);
    return serveTemplate(res, publicDir, '/login.html', {
      '{{CSRF_TOKEN}}': csrf,
      '{{USERNAME_ATTR}}': safeUsername ? ` value="${safeUsername}"` : '',
      '{{LOGIN_ERROR_ATTR}}': showError ? '' : ' hidden',
      '{{LOGIN_ERROR}}': showError ? '登录未成功，请检查账号和密码后重试。' : '',
    }, {
      ...headers,
      'Set-Cookie': preloginCookie(token, config),
    }, status);
  }

  async function handleMonitorReport(req, res) {
    let raw;
    try {
      raw = await readBody(req, config.nasMaxBodyBytes);
    } catch (error) {
      if (error.closeConnection) res.shouldKeepAlive = false;
      return sendJson(
        res,
        error.statusCode ?? 400,
        { error: 'bad request' },
        error.closeConnection ? { Connection: 'close' } : {},
      );
    }
    const verification = nasMonitorStore.verifyHeaders(req.headers, raw);
    if (!verification.ok) {
      return sendJson(res, verification.statusCode, { error: verification.error });
    }
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    let accepted;
    try {
      accepted = nasMonitorStore.acceptReport(report, verification.deviceId);
    } catch (error) {
      return sendJson(res, error.statusCode ?? 400, { error: error.code ?? 'bad report' });
    }
    return sendJson(res, 200, { ok: true, deviceId: accepted.deviceId, updatedAt: accepted.updatedAt });
  }

  async function handleLogin(req, res, form) {
    const cookies = parseCookies(req.headers.cookie);
    const prelogin = verifyPreloginToken(
      cookies.get(COOKIE_NAMES.prelogin),
      config.authSecret || 'dev-insecure-secret',
      now(),
    );
    const ip = clientIp(req);
    if (!form) {
      const csrfHeader = req.headers['x-csrf-token'];
      if (typeof csrfHeader !== 'string' || !prelogin || !secretEquals(csrfHeader, prelogin.csrf)) return forbidden(res);
      const rate = limiter.check(ip, now());
      if (!rate.allowed) return sendJson(res, rate.statusCode ?? 401, { error: 'invalid credentials' });
    }

    let raw;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (error) {
      if (error.closeConnection) res.shouldKeepAlive = false;
      const status = error.statusCode ?? 400;
      const extra = error.closeConnection ? { Connection: 'close' } : {};
      if (form) return renderLogin(res, { status, showError: true, headers: extra });
      return sendJson(res, status, { error: 'bad request' }, extra);
    }

    let username = '';
    let password = '';
    if (form) {
      const params = new URLSearchParams(raw);
      username = params.get('username') ?? '';
      password = params.get('password') ?? '';
      const csrf = params.get('csrf_token') ?? '';
      if (!prelogin || !secretEquals(csrf, prelogin.csrf)) {
        return renderLogin(res, { status: 403, username, showError: true });
      }
      const rate = limiter.check(ip, now());
      if (!rate.allowed) {
        return renderLogin(res, { status: rate.statusCode ?? 401, username, showError: true });
      }
    } else {
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { error: 'bad request' });
      }
      username = typeof body.username === 'string' ? body.username : '';
      password = String(body.password ?? '');
    }

    username = username.trim();
    const accountRate = accountLimiter.check('account', now());
    if (!accountRate.allowed) {
      if (form) return renderLogin(res, { status: accountRate.statusCode ?? 429, username, showError: true });
      return sendJson(res, accountRate.statusCode ?? 429, { error: 'invalid credentials' });
    }
    const usernameOk = username === config.authUsername;
    let passwordOk = false;
    try {
      passwordOk = await verifyPassword(password, config.authPasswordHash);
    } catch (error) {
      const status = error.statusCode ?? 503;
      if (form) return renderLogin(res, { status, username, showError: true });
      return sendJson(res, status, { error: 'temporarily unavailable' });
    }
    if (!usernameOk || !passwordOk) {
      if (form) return renderLogin(res, { status: 401, username, showError: true });
      return sendJson(res, 401, { error: 'invalid credentials' });
    }

    limiter.reset(ip);
    accountLimiter.reset('account');
    const oldToken = cookies.get(COOKIE_NAMES.session);
    const nextSession = store.rotate(oldToken, config.authUsername, config.sessionTtlMs, now());
    const sessionCookies = [
      sessionCookie(nextSession.token, config),
      clearCookie(COOKIE_NAMES.prelogin, config),
    ];
    // The browser form posts to /login. Success is one 303 to `/` with the
    // session cookie on that same response, so the follow-up GET is 200
    // instead of another 303 back to the password form. Failures stay on
    // 4xx and do not send a Location header.
    if (form) return redirect(res, '/', { 'Set-Cookie': sessionCookies });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookies });
  }

  let terminal;
  async function readLocalServer() {
    try {
      const dashboard = dashboardProvider
        ? await dashboardProvider.getDashboard()
        : getDashboardMock(new Date(now()));
      return dashboard?.server ?? null;
    } catch {
      return null;
    }
  }

  const server = createServer(async (req, res) => {
    res.hsts = hstsEnabled;
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/login') {
        return await renderLogin(res);
      }

      if (req.method === 'POST' && pathname === '/login') {
        if (!isAllowedOrigin(req, config)) return forbidden(res);
        return await handleLogin(req, res, true);
      }

      if (req.method === 'GET' && isPublicAsset(pathname)) {
        return await serveFile(res, publicDir, pathname);
      }

      if (req.method === 'POST' && (pathname === '/api/monitor/nas/report' || pathname === '/api/monitor/remote/report')) {
        return await handleMonitorReport(req, res);
      }

      const session = getSession(req, store);

      if (req.method === 'GET' && businessPages.has(pathname)) {
        if (!session) return redirect(res, '/login');
        return await serveFile(res, publicDir, '/index.html');
      }

      if (req.method === 'GET' && isProtectedAsset(pathname)) {
        if (!session) return send(res, 404, 'Not found');
        return await serveFile(res, publicDir, pathname);
      }

      if (pathname.startsWith('/api/')) {
        if (req.method === 'POST' && !isAllowedOrigin(req, config)) return forbidden(res);

        if (req.method === 'POST' && pathname === '/api/auth/login') {
          return await handleLogin(req, res, false);
        }

        const apiSession = requireSession(req, res, store);
        if (!apiSession) return;

        if (req.method === 'GET' && pathname === '/api/session') {
          return sendJson(res, 200, { user: { username: apiSession.username }, csrfToken: apiSession.csrf });
        }

        if (req.method === 'POST' && pathname === '/api/auth/logout') {
          if (!verifyCsrf(req, apiSession)) return forbidden(res);
          store.revoke(apiSession.token);
          return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(COOKIE_NAMES.session, config) });
        }

        if (req.method === 'GET' && pathname === '/api/modules') {
          return sendJson(res, 200, { modules: getModules(config) });
        }

        if (req.method === 'GET' && pathname === '/api/terminal/servers') {
          return sendJson(res, 200, { servers: await terminal.list() });
        }

        if (pathname === '/api/terminal/session') {
          return sendJson(res, 426, { error: 'upgrade required' }, { Upgrade: 'websocket' });
        }

        if (pathname.startsWith('/api/media/')) {
          await media.handle(req, res, { pathname, url, session: apiSession, readJson });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/dashboard') {
          const dashboard = dashboardProvider
            ? await dashboardProvider.getDashboard()
            : getDashboardMock(new Date(now()));
          const local = cloudDashboardDevice(dashboard, config);
          return sendJson(res, 200, {
            ...dashboard,
            server: local.server ?? dashboard.server,
            devices: [local, ...nasMonitorStore.getDashboards()],
          });
        }

        return sendJson(res, 404, { error: 'not found' });
      }

      return send(res, 404, 'Not found');
    } catch (error) {
      sendJson(res, 500, { error: 'internal server error' });
    }
  });

  terminal = attachTerminalGateway(server, {
    config,
    getSession: (req) => getSession(req, store),
    isAllowedOrigin: (req) => isAllowedOrigin(req, config),
    localServer: readLocalServer,
    remoteDashboards: () => nasMonitorStore.getDashboards(),
    dial: options.sshDial,
    limits: options.terminalLimits,
  });

  const originalClose = server.close.bind(server);
  server.config = config;
  server.sessionStore = store;
  server.nasMonitorStore = nasMonitorStore;
  server.close = (callback) => {
    terminal.close();
    return originalClose((error) => {
      dashboardProvider?.stop?.();
      store.close();
      callback?.(error);
    });
  };
  return server;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  validateRuntimeConfig(config);
  const server = createApplication({ config });
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exit(1);
      }
      process.exit(signal === 'SIGINT' ? 130 : 0);
    });
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  server.listen(config.port, config.host, () => {
    console.log(`personal-site listening on http://${config.host}:${config.port}`);
  });
}
