import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { refinementFields } from '../server/matting/options.js';

const USER = 'matting-user';
const PASSWORD = 'matting-test-password-2026';
const ORIGIN = 'https://personal-site.example';
const passwordHash = await hashPassword(PASSWORD);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function listen(server) {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

test('refinement flags are mutually exclusive and the commercial default is not offered', () => {
  assert.deepEqual(refinementFields('none'), {});
  assert.deepEqual(refinementFields('dc'), { dc: 'true' });
  assert.deepEqual(refinementFields('alpha'), { a: 'true' });
  assert.deepEqual(refinementFields('vitmatte'), { vm: 'true' });
  const config = loadConfig({}, {
    AUTH_USERNAME: USER,
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: 'x'.repeat(32),
    rembgApiUrl: 'http://1.94.16.40:7000',
  });
  assert.throws(() => validateRuntimeConfig(config), /REMBG_API_URL must be a loopback/);
});

test('matting stays on loopback, checks the session, and forwards one rembg request', async (t) => {
  const calls = [];
  let release = () => {};
  let markArrived = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { markArrived = resolve; });
  const upstream = createServer(async (req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('docs');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ url: req.url, method: req.method, body: body.toString('latin1'), headers: req.headers });
    markArrived();
    if (calls.length === 1) await gate;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG);
  });
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const directory = await mkdtemp(join(tmpdir(), 'personal-site-matting-app-'));
  const publicDir = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'login.html'), '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"></html>');
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
    REMBG_API_URL: upstreamBase,
  });
  const server = createApplication({ config });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const cookies = new Map();
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(method === 'POST' ? { Origin: ORIGIN } : {}),
        ...headers,
      },
      body,
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
  }

  assert.equal((await request('/api/matting/health')).status, 401);
  const loginPage = await request('/login');
  const csrfLogin = (await loginPage.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
  const loggedIn = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfLogin },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  assert.equal(loggedIn.status, 200);
  const csrf = (await (await request('/api/session')).json()).csrfToken;
  const health = await (await request('/api/matting/health')).json();
  assert.deepEqual(health, { ok: true, reason: 'ok' });

  const denied = await request('/api/matting/remove?model=u2netp&refine=dc', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG,
  });
  assert.equal(denied.status, 403);

  const badModel = await request('/api/matting/remove?model=bria-rmbg&refine=none', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': csrf },
    body: PNG,
  });
  assert.equal(badModel.status, 400);
  assert.match(await badModel.text(), /不支持这个抠图模型/);
  assert.equal(calls.length, 0);

  const first = request('/api/matting/remove?model=birefnet-general-lite&refine=dc', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': csrf },
    body: PNG,
  });
  await arrived;
  const second = await request('/api/matting/remove?model=u2netp&refine=none', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-CSRF-Token': csrf },
    body: PNG,
  });
  assert.equal(second.status, 429);
  assert.match(await second.text(), /另一张/);
  release();
  const ok = await first;
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^image\/png/);
  assert.equal(Buffer.from(await ok.arrayBuffer()).equals(PNG), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/remove');
  assert.match(calls[0].body, /name="model"/);
  assert.match(calls[0].body, /birefnet-general-lite/);
  assert.match(calls[0].body, /name="dc"/);
  assert.doesNotMatch(calls[0].body, /name="vm"/);
  assert.doesNotMatch(calls[0].body, /name="a"/);
  assert.equal(JSON.stringify(calls[0].headers).includes(csrf), false);
});

test('a public rembg address and an upstream redirect are refused', async (t) => {
  let called = 0;
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-matting-block-'));
  const publicDir = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'login.html'), '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"></html>');
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
    REMBG_API_URL: 'http://1.94.16.40:7000',
  });
  const server = createApplication({
    config,
    mattingFetch: async () => {
      called += 1;
      return new Response(PNG, { status: 302, headers: { Location: 'http://203.0.113.10/secret', 'Content-Type': 'text/plain' } });
    },
  });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const cookies = new Map();
  async function request(path, init = {}) {
    const response = await fetch(base + path, {
      ...init,
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        Origin: ORIGIN,
        ...(init.headers || {}),
      },
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  const loginPage = await request('/login');
  const csrfLogin = (await loginPage.text()).match(/content="([^"]+)"/)[1];
  await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfLogin },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  const csrf = (await (await request('/api/session')).json()).csrfToken;
  const blocked = await request('/api/matting/remove?model=u2netp&refine=none', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': csrf },
    body: PNG,
  });
  assert.equal(blocked.status, 500);
  const text = await blocked.text();
  assert.match(text, /只能使用本机地址/);
  assert.equal(text.includes('1.94.16.40'), false);
  assert.equal(called, 0);

  const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.doesNotMatch(caddy, /1\.94\.16\.40|:7000/);
  const handbook = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(handbook, /REMBG_API_URL/);
  assert.match(handbook, /1\.94\.16\.40/);
  assert.match(handbook, /127\.0\.0\.1:7000/);
  assert.match(handbook, /0\.0\.0\.0/);
});

test('an upstream redirect is not followed', async (t) => {
  let called = 0;
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-matting-redirect-'));
  const publicDir = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'login.html'), '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"></html>');
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
    REMBG_API_URL: 'http://127.0.0.1:9',
  });
  const server = createApplication({
    config,
    mattingFetch: async () => {
      called += 1;
      return new Response(null, { status: 302, headers: { Location: 'http://203.0.113.10/secret' } });
    },
  });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const cookies = new Map();
  async function request(path, init = {}) {
    const response = await fetch(base + path, {
      ...init,
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        Origin: ORIGIN,
        ...(init.headers || {}),
      },
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  const loginPage = await request('/login');
  const csrfLogin = (await loginPage.text()).match(/content="([^"]+)"/)[1];
  await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfLogin },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  const csrf = (await (await request('/api/session')).json()).csrfToken;
  const redirected = await request('/api/matting/remove?model=u2netp&refine=alpha', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': csrf },
    body: PNG,
  });
  assert.equal(redirected.status, 502);
  const redirectText = await redirected.text();
  assert.match(redirectText, /跳转/);
  assert.equal(redirectText.includes('203.0.113.10'), false);
  assert.equal(called, 1);

  const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.doesNotMatch(caddy, /1\.94\.16\.40|:7000/);
  const handbook = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(handbook, /REMBG_API_URL/);
  assert.match(handbook, /1\.94\.16\.40/);
  assert.match(handbook, /127\.0\.0\.1:7000/);
  assert.match(handbook, /0\.0\.0\.0/);
});
