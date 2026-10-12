import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createApplication } from '../server/index.js';
import { loadConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';

const origin = 'https://ui-assets.example';
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const password = 'test-only-ui-assets-password';
const passwordHash = await hashPassword(password);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-ui-assets-'));
  const config = loadConfig({}, {
    HOST: '127.0.0.1', PORT: 0, SITE_ORIGIN: origin, NODE_ENV: 'production',
    DATA_DIR: directory, PUBLIC_DIR: publicDir, MONITORING_MODE: 'mock',
    AUTH_USERNAME: 'ui-test-user', AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'),
  });
  const server = createApplication({ config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  return { base, request: (path, options) => fetch(base + path, { redirect: 'manual', ...options }) };
}

test('real login template exposes only self-hosted assets and retains CSRF and labels', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/login');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /name="csrf-token" content="[A-Za-z0-9_-]+"/);
  assert.doesNotMatch(html, /\{\{CSRF_TOKEN\}\}/);
  assert.match(html, /for="username"/);
  assert.match(html, /for="password"/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /\/assets\/vendor\/tabler\/tabler.min.css\?v=1.6.1/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  for (const [, path] of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)(?:\?[^"#]*)?"/g)) {
    assert.equal((await app.request(path)).status, 200, path);
  }
});

test('pinned genuine Tabler CSS is public without opening the whole vendor directory', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/assets/vendor/tabler/tabler.min.css?v=1.6.1');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/css/);
  const css = await response.text();
  assert.match(css, /Tabler v1\.6\.1/);
  assert.ok(css.length > 100_000);
  assert.doesNotMatch(css, /@import|url\(["']?https?:\/\//);
  for (const path of ['/assets/vendor/tabler/private.js', '/assets/vendor/tabler/LICENSE', '/assets/app.js', '/assets/components/icons.js', '/api/session', '/api/dashboard']) {
    assert.notEqual((await app.request(path)).status, 200, path);
  }
});

test('real login works, protected shell loads Tabler, and logout remains CSRF protected', async (t) => {
  const app = await fixture(t);
  const challenge = await app.request('/login');
  const html = await challenge.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const prelogin = challenge.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const login = await app.request('/api/auth/login', {
    method: 'POST', headers: { Origin: origin, Cookie: prelogin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ username: 'ui-test-user', password }),
  });
  assert.equal(login.status, 200);
  const sessionCookie = login.headers.getSetCookie().filter((value) => !/Max-Age=0/.test(value)).map((value) => value.split(';')[0]).join('; ');
  const session = await (await app.request('/api/session', { headers: { Cookie: sessionCookie } })).json();
  const home = await app.request('/', { headers: { Cookie: sessionCookie } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /class="page-wrapper"/);
  for (const path of ['/assets/app.js', '/assets/components/navigation.js', '/assets/components/icons.js']) {
    assert.equal((await app.request(path, { headers: { Cookie: sessionCookie } })).status, 200, path);
  }
  const logout = await app.request('/api/auth/logout', {
    method: 'POST', headers: { Origin: origin, Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal((await app.request('/api/session', { headers: { Cookie: sessionCookie } })).status, 401);
});

test('pre-paint bootstrap sets both native and Tabler theme attributes', async () => {
  const script = await readFile(join(publicDir, 'assets/theme-bootstrap.js'), 'utf8');
  for (const mode of ['light', 'dark']) {
    const attrs = new Map();
    runInNewContext(script, {
      localStorage: { getItem: () => JSON.stringify({ mode }) },
      matchMedia: () => ({ matches: false }), document: { documentElement: { setAttribute: (key, value) => attrs.set(key, value) } },
    });
    assert.equal(attrs.get('data-theme'), mode);
    assert.equal(attrs.get('data-bs-theme'), mode);
  }
});
