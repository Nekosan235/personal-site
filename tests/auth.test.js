import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword, verifyPassword } from '../server/auth/password.js';
import { SessionStore } from '../server/auth/sessions.js';
import { COOKIE_NAMES } from '../server/auth/cookies.js';

const USER = 'test-user';
const PASSWORD = 'test-only-password-2026';
const ORIGIN = 'https://personal-site.example';
const passwordHash = await hashPassword(PASSWORD);

async function fixture(t, overrides = {}) {
  const prefix = join(tmpdir(), 'personal-site-test-');
  const directory = await mkdtemp(prefix);
  const publicDir = join(directory, 'public');
  await mkdir(join(publicDir, 'assets', 'components'), { recursive: true });
  await mkdir(join(publicDir, 'assets', 'pages'), { recursive: true });
  await writeFile(join(publicDir, 'login.html'), '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"><body>login-only</body></html>');
  await writeFile(join(publicDir, 'index.html'), '<html>private-home</html>');
  await writeFile(join(publicDir, 'assets', 'login.js'), '/* public-login */');
  await writeFile(join(publicDir, 'assets', 'styles.css'), 'body { color: black; }');
  await writeFile(join(publicDir, 'assets', 'theme-bootstrap.js'), '/* public-theme-bootstrap */');
  for (const file of ['theme.js', 'appearance.js', 'ambient.js', 'solar.js', 'dom.js']) {
    await writeFile(join(publicDir, 'assets', 'components', file), `/* public-${file} */`);
  }
  for (const file of ['api.js', 'poller.js', 'metric.js', 'welcome.js']) {
    await writeFile(join(publicDir, 'assets', 'components', file), `/* private-${file} */`);
  }
  await writeFile(join(publicDir, 'assets', 'app.js'), '/* private-business */');
  await writeFile(join(publicDir, 'assets', 'pages', 'dashboard.js'), '/* private-metrics */');
  const config = loadConfig({}, {
    SITE_ORIGIN: ORIGIN,
    NODE_ENV: 'production',
    DATA_DIR: join(directory, 'data'),
    PUBLIC_DIR: publicDir,
    AUTH_USERNAME: USER,
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'),
    HOST: '127.0.0.1',
    PORT: 0,
    MONITORING_MODE: 'mock',
    ...overrides,
  });
  let server;
  let baseUrl;
  const stop = async () => {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise((done, reject) => closing.close(error => error ? reject(error) : done()));
  };
  const start = async () => {
    server = createApplication({ config });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => {
    await stop();
    assert.ok(resolve(directory).startsWith(resolve(prefix)), 'remove only the owned test directory');
    await rm(directory, { recursive: true, force: true });
  });
  function client() {
    const cookies = new Map();
    return {
      cookies,
      cookieHeader: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const requestHeaders = {
          Cookie: this.cookieHeader(),
          ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
          ...headers,
        };
        const response = await fetch(baseUrl + path, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          redirect: 'manual',
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [pair] = cookie.split(';');
          const separator = pair.indexOf('=');
          const name = pair.slice(0, separator);
          const value = pair.slice(separator + 1);
          if (/Max-Age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
          else cookies.set(name, value);
        }
        return response;
      },
      async challenge() {
        const response = await this.request('/login');
        assert.equal(response.status, 200);
        const html = await response.text();
        const match = html.match(/name="csrf-token"\s+content="([^"]+)"/);
        assert.ok(match, 'login page must carry a server-issued CSRF token');
        assert.notEqual(match[1], '{{CSRF_TOKEN}}');
        return match[1];
      },
      async login(password = PASSWORD, additionalHeaders = {}) {
        const csrf = await this.challenge();
        return this.request('/api/auth/login', {
          method: 'POST', body: { username: USER, password },
          headers: { 'X-CSRF-Token': csrf, ...additionalHeaders },
        });
      },
    };
  }
  return { client, config, directory, start, stop };
}

test('anonymous visitors get only login UI and no protected pages, code or data', async t => {
  const f = await fixture(t);
  const c = f.client();
  for (const path of ['/', '/tools', '/agents', '/tools/remove-background', '/tools/file-converter']) {
    const response = await c.request(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get('location'), '/login');
    assert.doesNotMatch(await response.text(), /private-home/);
  }
  for (const path of ['/api/session', '/api/dashboard', '/api/modules']) {
    assert.equal((await c.request(path)).status, 401, path);
  }
  for (const path of ['/assets/app.js', '/assets/pages/dashboard.js', '/index.html']) {
    const response = await c.request(path);
    assert.notEqual(response.status, 200, path);
    assert.doesNotMatch(await response.text(), /private-home|private-business|private-metrics/);
  }
  const login = await c.request('/login');
  assert.match(await login.text(), /login-only/);
  assert.match(login.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(login.headers.get('cache-control'), /no-store/);
  for (const path of [
    '/assets/theme-bootstrap.js',
    '/assets/components/theme.js',
    '/assets/components/appearance.js',
    '/assets/components/ambient.js',
    '/assets/components/solar.js',
    '/assets/components/dom.js',
  ]) {
    assert.equal((await c.request(path)).status, 200, path);
  }
  for (const path of [
    '/assets/components/api.js',
    '/assets/components/poller.js',
    '/assets/components/metric.js',
    '/assets/components/welcome.js',
    '/assets/pages/dashboard.js',
  ]) {
    const response = await c.request(path);
    assert.notEqual(response.status, 200, path);
  }
});

test('password verification rejects wrong passwords and malformed hashes', async () => {
  assert.equal(await verifyPassword(PASSWORD, passwordHash), true);
  assert.equal(await verifyPassword('wrong-password', passwordHash), false);
  assert.equal(await verifyPassword(PASSWORD, 'not-a-hash'), false);
});

test('login requires signed prelogin CSRF and rejects forged allowed origins', async t => {
  const f = await fixture(t);
  const c = f.client();
  const payload = { username: USER, password: PASSWORD };
  assert.equal((await c.request('/api/auth/login', { method: 'POST', body: payload })).status, 403);
  const csrf = await c.challenge();
  assert.equal((await c.request('/api/auth/login', {
    method: 'POST', body: payload, headers: { 'X-CSRF-Token': 'invalid-token' },
  })).status, 403);
  assert.equal((await c.request('/api/auth/login', {
    method: 'POST', body: payload,
    headers: { 'X-CSRF-Token': csrf, Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' },
  })).status, 403);
});

test('valid login uses safe cookie flags and grants access to registered modules', async t => {
  const f = await fixture(t);
  const c = f.client();
  const login = await c.login();
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith(COOKIE_NAMES.session + '='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal((await c.request('/')).status, 200);
  assert.match(await (await c.request('/assets/app.js')).text(), /private-business/);
  const session = await (await c.request('/api/session')).json();
  assert.equal(session.user.username, USER);
  assert.ok(session.csrfToken.length >= 24);
  const dashboard = await (await c.request('/api/dashboard')).json();
  assert.equal(dashboard.mode, 'mock');
  assert.equal(dashboard.metrics.memory.total, 2);
  assert.equal(dashboard.metrics.disk.total, 40);
  const { modules } = await (await c.request('/api/modules')).json();
  for (const item of modules.filter(item => item.path)) {
    assert.equal((await c.request(item.path)).status, 200, item.id);
  }
  assert.ok(modules.some(item => item.id === 'remove-background' && item.status === 'planned'));
  assert.ok(modules.some(item => item.id === 'file-converter' && item.status === 'planned'));
  assert.equal(modules.find(item => item.id === 'codex-web').href, 'https://203.0.113.10:8443');
});

test('logout needs CSRF, then invalidates an already copied session token', async t => {
  const f = await fixture(t);
  const c = f.client();
  assert.equal((await c.login()).status, 200);
  const previousCookie = c.cookieHeader();
  assert.equal((await c.request('/api/auth/logout', { method: 'POST', body: {} })).status, 403);
  const session = await (await c.request('/api/session')).json();
  assert.equal((await c.request('/api/auth/logout', {
    method: 'POST', body: {}, headers: { 'X-CSRF-Token': session.csrfToken },
  })).status, 200);
  assert.equal((await c.request('/api/session', { headers: { Cookie: previousCookie } })).status, 401);
});

test('re-login rotates the token and revokes the previous session', async t => {
  const f = await fixture(t);
  const first = f.client();
  await first.login();
  const oldSession = first.cookies.get(COOKIE_NAMES.session);
  const next = f.client();
  const csrf = await next.challenge();
  const challengeCookie = next.cookieHeader();
  const result = await next.request('/api/auth/login', {
    method: 'POST', body: { username: USER, password: PASSWORD },
    headers: { 'X-CSRF-Token': csrf, Cookie: `${challengeCookie}; ${COOKIE_NAMES.session}=${oldSession}` },
  });
  assert.equal(result.status, 200);
  assert.notEqual(next.cookies.get(COOKIE_NAMES.session), oldSession);
  assert.equal((await first.request('/api/session')).status, 401);
});

test('sessions survive a clean application restart', async t => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  await f.stop();
  await f.start();
  const response = await c.request('/api/session');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.username, USER);
});

test('expired sessions are revoked and persistent storage contains only token digests', async t => {
  const f = await fixture(t);
  const store = new SessionStore(join(f.directory, 'expiry.sqlite'));
  try {
    const session = store.create(USER, 10, 1000);
    const row = store.db.prepare('SELECT token_hash FROM sessions').get();
    assert.notEqual(row.token_hash, session.token);
    assert.match(row.token_hash, /^[a-f0-9]{64}$/);
    assert.equal(store.get(session.token, 1009).username, USER);
    assert.equal(store.get(session.token, 1010), null);
  } finally { store.close(); }
});

test('invalid JSON, oversized bodies and login abuse are rejected', async t => {
  const f = await fixture(t);
  const c = f.client();
  const csrf = await c.challenge();
  assert.equal((await c.request('/api/auth/login', {
    method: 'POST', body: '{', headers: { 'X-CSRF-Token': csrf },
  })).status, 400);
  assert.equal((await c.request('/api/auth/login', {
    method: 'POST', body: { username: USER, password: 'x'.repeat(10000) }, headers: { 'X-CSRF-Token': csrf },
  })).status, 413);
  let response;
  for (let index = 0; index < 10; index += 1) {
    response = await c.request('/api/auth/login', {
      method: 'POST', body: { username: USER, password: 'wrong' }, headers: { 'X-CSRF-Token': csrf },
    });
  }
  assert.equal(response.status, 429);
  assert.equal((await c.request('/api/session')).status, 401);
});

test('encoded traversal cannot read files outside public assets', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'secret.txt'), 'test-private-content');
  const c = f.client();
  await c.login();
  const response = await c.request('/assets/pages/..%2f..%2f..%2fsecret.txt');
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /test-private-content/);
});

test('production config cannot disable secure cookies or use HTTP origins', () => {
  const base = { authUsername: USER, authPasswordHash: passwordHash, authSecret: 'x'.repeat(64), nodeEnv: 'production' };
  assert.throws(() => validateRuntimeConfig({ ...base, siteOrigin: 'http://example.test', cookieSecure: true }));
  assert.throws(() => validateRuntimeConfig({ ...base, siteOrigin: ORIGIN, cookieSecure: false }));
});
