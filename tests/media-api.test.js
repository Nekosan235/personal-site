import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { LoginRateLimiter } from '../server/auth/rate-limit.js';
import { clearXhsTokenCache } from '../server/media/token.js';
import { signMediaTarget } from '../server/media/proxy.js';
import { MEDIA_MESSAGES } from '../server/media/errors.js';

const exec = promisify(execFile);
const USER = 'media-user';
const PASSWORD = 'media-test-password-2026';
const ORIGIN = 'https://personal-site.example';
const passwordHash = await hashPassword(PASSWORD);
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/media/${name}.json`, import.meta.url), 'utf8'));
}

async function appFixture(t, overrides = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-media-'));
  await mkdir(join(directory, 'public'), { recursive: true });
  await writeFile(join(directory, 'public', 'login.html'), '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"></html>');
  const config = loadConfig({}, {
    SITE_ORIGIN: ORIGIN,
    NODE_ENV: 'production',
    DATA_DIR: join(directory, 'data'),
    PUBLIC_DIR: join(directory, 'public'),
    AUTH_USERNAME: USER,
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'),
    HOST: '127.0.0.1',
    PORT: 0,
    MONITORING_MODE: 'mock',
    XHS_API_TOKEN: 'test-token',
    ...overrides,
  });
  const server = createApplication({ config, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    clearXhsTokenCache();
  });
  const cookies = new Map();
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
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
  }
  async function login() {
    const challenge = await request('/login');
    const html = await challenge.text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { username: USER, password: PASSWORD },
      headers: { 'X-CSRF-Token': csrf },
    });
    assert.equal(response.status, 200);
    const session = await (await request('/api/session')).json();
    return session.csrfToken;
  }
  return { request, login, config, directory };
}

test('share parsing requires a session and CSRF, then calls the matching backend', async (t) => {
  const xhs = await loadFixture('xhs-images');
  const calls = [];
  const f = await appFixture(t, {}, {
    mediaFetch: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return Response.json(xhs);
    },
  });
  assert.equal((await f.request('/api/media/parse', { method: 'POST', body: { text: 'https://xhslink.com/a/abc' } })).status, 401);
  const csrf = await f.login();
  assert.equal((await f.request('/api/media/parse', {
    method: 'POST', body: { text: 'https://xhslink.com/a/abc' },
  })).status, 403);
  const response = await f.request('/api/media/parse', {
    method: 'POST',
    body: { text: '复制打开小红书 https://www.xiaohongshu.com/explore/640d6dca000000001203f0f9?xsec_token=ABCdef 查看' },
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(response.status, 200);
  const work = await response.json();
  assert.equal(work.platform, 'xiaohongshu');
  assert.equal(work.type, 'images');
  assert.equal(work.items[0].kind, 'image');
  assert.match(work.items[0].url, /^\/api\/media\/file\?/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].body.download, false);
  assert.equal(calls[0].body.url, 'https://www.xiaohongshu.com/explore/640d6dca000000001203f0f9?xsec_token=ABCdef');
  assert.match(calls[0].url, /\/xhs\/detail$/);
});

test('Douyin resolves the short link before detail and can pass a cookie', async (t) => {
  const share = await loadFixture('douyin-share');
  const detail = await loadFixture('douyin-video');
  const calls = [];
  const f = await appFixture(t, { DOUYIN_COOKIE: 'session=secret' }, {
    mediaFetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body, token: init.headers.token });
      return Response.json(String(url).endsWith('/douyin/share') ? share : detail);
    },
  });
  const csrf = await f.login();
  const response = await f.request('/api/media/parse', {
    method: 'POST',
    body: { text: '7.43 复制打开抖音 https://v.douyin.com/iABC123/ 看看' },
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(response.status, 200);
  const work = await response.json();
  assert.equal(work.platform, 'douyin');
  assert.equal(work.type, 'video');
  assert.equal(work.items[0].width, 1080);
  assert.equal(work.items[0].height, 1920);
  assert.equal(calls[0].body.text, 'https://v.douyin.com/iABC123/');
  assert.equal(calls[0].body.cookie, undefined);
  assert.equal(calls[1].body.detail_id, '7123456789012345678');
  assert.equal(calls[1].body.cookie, 'session=secret');
  assert.equal(calls[1].token, undefined);
});

test('empty Xiaohongshu data and a failed Douyin detail become Chinese errors', async (t) => {
  const failure = await loadFixture('xhs-failure');
  const share = await loadFixture('douyin-share');
  const douyinFailure = await loadFixture('douyin-failure');
  let mode = 'xhs';
  const f = await appFixture(t, {}, {
    mediaFetch: async (url) => {
      if (mode === 'down') throw new Error('connect ECONNREFUSED');
      if (mode === 'denied') return new Response('forbidden', { status: 403 });
      if (String(url).includes('/douyin/share')) return Response.json(share);
      if (String(url).includes('/douyin/detail')) return Response.json(douyinFailure);
      return Response.json(failure);
    },
  });
  const csrf = await f.login();
  async function parse(text) {
    return f.request('/api/media/parse', { method: 'POST', body: { text }, headers: { 'X-CSRF-Token': csrf } });
  }
  const xhs = await parse('https://www.xiaohongshu.com/explore/missing?xsec_token=ABCdef');
  assert.equal(xhs.status, 502);
  assert.match((await xhs.json()).error, /xsec_token/);
  mode = 'douyin';
  const douyin = await parse('https://v.douyin.com/iABC123/');
  assert.equal((await douyin.json()).error, MEDIA_MESSAGES.douyinCookie);
  mode = 'down';
  assert.match((await (await parse('https://xhslink.com/a/abc')).json()).error, /小红书解析服务暂时不可用/);
  mode = 'denied';
  assert.match((await (await parse('https://xhslink.com/a/abc')).json()).error, /XHS_API_TOKEN/);
});

test('media proxy forwards Range, sets a filename, and refuses unsigned or off-allowlist targets', async (t) => {
  const video = await loadFixture('xhs-video');
  const seen = [];
  const f = await appFixture(t, {}, {
    mediaFetch: async () => Response.json(video),
    mediaTransport: async ({ url, range, platform }) => {
      seen.push({ url, range, platform });
      return {
        statusCode: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-3/10',
          'content-length': '4',
        },
        body: Readable.from([Buffer.from('wxyz')]),
      };
    },
  });
  assert.equal((await f.request('/api/media/file?d=1&s=2')).status, 401);
  const csrf = await f.login();
  const parsed = await f.request('/api/media/parse', {
    method: 'POST',
    body: { text: 'https://www.xiaohongshu.com/explore/video-id?xsec_token=ABCdef' },
    headers: { 'X-CSRF-Token': csrf },
  });
  const work = await parsed.json();
  const file = await f.request(work.items[0].url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(file.status, 206);
  assert.equal(file.headers.get('content-range'), 'bytes 0-3/10');
  assert.match(file.headers.get('cache-control'), /no-store/);
  assert.match(file.headers.get('content-disposition'), /inline/);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal(await file.text(), 'wxyz');
  assert.equal(seen[0].range, 'bytes=0-3');
  assert.equal(seen[0].platform, 'xiaohongshu');
  assert.match(seen[0].url, /^https:\/\/sns-video-bd\.xhscdn\.com\//);
  const download = await f.request(`${work.items[0].url}&dl=1`);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  await download.arrayBuffer();

  const blocked = signMediaTarget({
    url: 'http://127.0.0.1/secret',
    platform: 'douyin',
    kind: 'video',
    filename: 'secret.mp4',
    exp: Date.now() + 60_000,
  }, f.config.authSecret);
  const rejected = await f.request(blocked);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, MEDIA_MESSAGES.outside);
  assert.equal(seen.length, 2);

  const expired = signMediaTarget({
    url: 'https://sns-video-bd.xhscdn.com/stream/example.mp4',
    platform: 'xiaohongshu',
    kind: 'video',
    filename: 'old.mp4',
    exp: Date.now() - 1000,
  }, f.config.authSecret);
  const stale = await f.request(expired);
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).error, MEDIA_MESSAGES.expired);
});

test('parse is rate limited and a token file is used when the env token is empty', async (t) => {
  clearXhsTokenCache();
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-token-'));
  const tokenFile = join(directory, 'xhs-api.token');
  await writeFile(tokenFile, 'file-token\n');
  const calls = [];
  const f = await appFixture(t, { XHS_API_TOKEN: '', XHS_API_TOKEN_FILE: tokenFile }, {
    mediaFetch: async (url, init) => {
      calls.push(init.headers.Authorization);
      return Response.json(await loadFixture('xhs-failure'));
    },
    mediaRateLimiter: new LoginRateLimiter({ windowMs: 60_000, maxAttempts: 1 }),
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const csrf = await f.login();
  const first = await f.request('/api/media/parse', {
    method: 'POST', body: { text: 'https://xhslink.com/a/abc' }, headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(first.status, 502);
  assert.equal(calls[0], 'Bearer file-token');
  const second = await f.request('/api/media/parse', {
    method: 'POST', body: { text: 'https://xhslink.com/a/abc' }, headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(second.status, 429);
  assert.match((await second.json()).error, /频繁/);
});

test('health reports both backends and the selfcheck script exits non-zero on failure', async (t) => {
  const xhs = await listen((req, res) => {
    req.resume();
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"detail":"forbidden"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: '提取小红书作品链接失败', data: null }));
  });
  const douyin = await listen((req, res) => {
    if (req.url.startsWith('/openapi.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"openapi":"3.1.0"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => { xhs.close(); douyin.close(); });
  const f = await appFixture(t, {
    XHS_API_URL: `http://127.0.0.1:${xhs.address().port}`,
    DOUYIN_API_URL: `http://127.0.0.1:${douyin.address().port}`,
    MEDIA_PROBE_TIMEOUT_MS: '1000',
  });
  await f.login();
  const health = await (await f.request('/api/media/health')).json();
  assert.deepEqual(health, { xiaohongshu: { ok: true }, douyin: { ok: true } });

  const env = {
    ...process.env,
    XHS_API_URL: `http://127.0.0.1:${xhs.address().port}`,
    DOUYIN_API_URL: `http://127.0.0.1:${douyin.address().port}`,
    XHS_API_TOKEN: 'test-token',
    XHS_API_TOKEN_FILE: '',
    MEDIA_PROBE_TIMEOUT_MS: '1000',
  };
  const ok = await exec(process.execPath, ['scripts/media-selfcheck.js'], { cwd: projectRoot, env });
  assert.match(ok.stdout, /xiaohongshu ok/);
  assert.match(ok.stdout, /douyin ok/);
  await assert.rejects(exec(process.execPath, ['scripts/media-selfcheck.js'], {
    cwd: projectRoot,
    env: { ...env, XHS_API_TOKEN: 'wrong-token' },
  }));
});

test('the media page is login-only and a public API URL is rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-media-page-'));
  const config = loadConfig({}, {
    SITE_ORIGIN: ORIGIN, NODE_ENV: 'production', DATA_DIR: directory,
    PUBLIC_DIR: publicDir, AUTH_USERNAME: USER, AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'), MONITORING_MODE: 'mock',
  });
  const server = createApplication({ config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const anonymous = await fetch(`${base}/tools/media-download`, { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.notEqual((await fetch(`${base}/assets/pages/media-download.js`)).status, 200);
  assert.throws(() => validateRuntimeConfig({
    ...config,
    xhsApiUrl: 'https://downloads.example',
  }), /XHS_API_URL/);
  const page = await readFile(new URL('../public/assets/pages/media-download.js', import.meta.url), 'utf8');
  assert.match(page, /粘贴/);
  assert.match(page, /解析/);
  assert.match(page, /长按图片保存/);
  assert.match(page, /仅供个人保存自己或已获授权的内容/);
  const app = await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8');
  assert.match(app, /\['media-download', renderMediaDownload\]/);
});

function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}
