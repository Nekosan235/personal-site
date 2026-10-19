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
  assert.match(response.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  for (const [, path] of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)(?:\?[^"#]*)?"/g)) {
    assert.equal((await app.request(path)).status, 200, path);
  }
});

test('login form is a same-origin password form browsers can save', async (t) => {
  const html = await readFile(join(publicDir, 'login.html'), 'utf8');
  const formStart = html.indexOf('<form id="login-form"');
  const form = html.slice(formStart, html.indexOf('</form>', formStart) + '</form>'.length);
  assert.match(form, /method="post"/);
  assert.match(form, /action="\/login"/);
  assert.doesNotMatch(form, /action="\/api\//);
  assert.match(form, /autocomplete="on"/);
  assert.doesNotMatch(form, /autocomplete="off"/i);
  assert.doesNotMatch(form, /https?:\/\//);
  const usernameField = form.match(/<input\b[^>]*\bid="username"[^>]*>/)[0];
  const passwordField = form.match(/<input\b[^>]*\bid="password"[^>]*>/)[0];
  assert.match(usernameField, /\bname="username"/);
  assert.match(usernameField, /\btype="text"/);
  assert.match(usernameField, /\bautocomplete="username"/);
  assert.match(passwordField, /\bname="password"/);
  assert.match(passwordField, /\btype="password"/);
  assert.match(passwordField, /\bautocomplete="current-password"/);
  assert.ok(form.indexOf('id="username"') < form.indexOf('id="password"'));
  assert.ok(form.indexOf('name="csrf_token"') < form.indexOf('id="password"'));
  assert.ok(form.indexOf('name="csrf_token"') < form.indexOf('type="submit"'));
  assert.match(form, /<button\b[^>]*\bid="login-submit"[^>]*\btype="submit"/);
  assert.match(form, /<input\b[^>]*\bname="csrf_token"[^>]*\btype="hidden"/);
  const script = await readFile(join(publicDir, 'assets/login.js'), 'utf8');
  assert.doesNotMatch(script, /preventDefault|fetch\(|location\.assign/);
  const appearance = await readFile(join(publicDir, 'assets/components/appearance.js'), 'utf8');
  assert.match(appearance, /method: 'dialog'/);

  const app = await fixture(t);
  const page = await app.request('/login');
  const served = await page.text();
  assert.equal(page.status, 200);
  assert.doesNotMatch(served, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(served, /method="post"/);
  assert.match(served, /action="\/login"/);
  assert.doesNotMatch(served, /action="\/api\//);
  assert.match(served, /autocomplete="username"/);
  assert.match(served, /autocomplete="current-password"/);
  assert.doesNotMatch(served, /id="username"[^>]*\bvalue=/);
  assert.match(served, /role="alert" hidden><\/p>/);
  assert.doesNotMatch(served, /autocomplete="off"/i);
  const csrf = served.match(/name="csrf-token" content="([^"]+)"/)[1];
  assert.match(served, new RegExp(`name="csrf_token"[^>]*value="${csrf}"`));

  const prelogin = page.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const failed = await app.request('/login', {
    method: 'POST',
    headers: { Origin: origin, Cookie: prelogin, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: new URLSearchParams({
      username: 'ui-test-user"><script>',
      password: 'not-the-saved-password',
      csrf_token: csrf,
    }).toString(),
  });
  assert.equal(failed.status, 401);
  assert.equal(failed.headers.get('location'), null);
  const failedHtml = await failed.text();
  assert.match(failedHtml, /登录未成功，请检查账号和密码后重试。/);
  assert.match(failedHtml, /value="ui-test-user&quot;&gt;&lt;script&gt;"/);
  assert.doesNotMatch(failedHtml, /not-the-saved-password/);
  assert.doesNotMatch(failedHtml, /<script(?![^>]*\bsrc=)/);
  assert.match(failedHtml, /autocomplete="current-password"/);
  assert.equal(failed.headers.getSetCookie().some((value) => value.startsWith('ps_session=') && !/Max-Age=0/.test(value)), false);
  const retryCookie = failed.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const retryCsrf = failedHtml.match(/name="csrf-token" content="([^"]+)"/)[1];
  const ok = await app.request('/login', {
    method: 'POST',
    headers: { Origin: origin, Cookie: retryCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'ui-test-user', password, csrf_token: retryCsrf }).toString(),
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const sessionCookie = ok.headers.getSetCookie().filter((value) => !/Max-Age=0/.test(value)).map((value) => value.split(';')[0]).join('; ');
  const home = await app.request('/', { headers: { Cookie: sessionCookie } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /class="page-wrapper"/);
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

test('migrated image tools are registered as authenticated pages and keep their worker private', async (t) => {
  const app = await fixture(t);
  for (const path of ['/tools/remove-background', '/tools/gif-editor']) {
    const response = await app.request(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get('location'), '/login');
  }
  for (const path of ['/assets/components/image-tools/worker.js', '/assets/pages/gif-editor.js', '/api/image/upload']) {
    assert.notEqual((await app.request(path)).status, 200, path);
  }
  const challenge = await app.request('/login');
  const html = await challenge.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const prelogin = challenge.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const login = await app.request('/api/auth/login', {
    method: 'POST', headers: { Origin: origin, Cookie: prelogin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ username: 'ui-test-user', password }),
  });
  const cookie = login.headers.getSetCookie().filter((value) => !/Max-Age=0/.test(value)).map((value) => value.split(';')[0]).join('; ');
  const catalog = await (await app.request('/api/modules', { headers: { Cookie: cookie } })).json();
  for (const id of ['remove-background', 'gif-editor']) {
    const module = catalog.modules.find((item) => item.id === id);
    assert.equal(module.status, 'ready');
    assert.equal(module.group, 'tools');
  }
  for (const path of ['/assets/pages/remove-background.js', '/assets/pages/gif-editor.js',
    '/assets/components/image-tools/worker.js', '/assets/components/image-tools/gif-project.js']) {
    assert.equal((await app.request(path, { headers: { Cookie: cookie } })).status, 200, path);
  }
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
