import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { presentSshServers } from '../server/terminal/targets.js';
import { fingerprintHostKey } from '../server/terminal/hostkey.js';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2');
const USER = 'terminal-user';
const SITE_PASSWORD = 'test-only-password-2026';
const SSH_PASSWORD = 's3cr3t-ssh-pass-9f3a';
const KEY_MATERIAL = 'SUPER-SECRET-KEY-MATERIAL';
const ORIGIN = 'https://terminal.example';
const passwordHash = await hashPassword(SITE_PASSWORD);
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

function createHostKey() {
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return { privateKey, fingerprint: fingerprintHostKey(key.getPublicSSH()) };
}

function startEchoServer(t, { acceptKey = null } = {}) {
  const host = createHostKey();
  const shells = new Set();
  const stats = { connections: 0, auths: 0, methods: [] };
  const server = new Server({ hostKeys: [host.privateKey] }, (client) => {
    stats.connections += 1;
    client.on('authentication', (ctx) => {
      stats.auths += 1;
      stats.methods.push(ctx.method);
      const keyData = ctx.key?.data;
      if (ctx.method === 'publickey' && acceptKey && Buffer.isBuffer(keyData) && acceptKey.equals(keyData)) {
        ctx.accept();
        return;
      }
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === SSH_PASSWORD) ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => { if (typeof acceptPty === 'function') acceptPty(); });
        session.on('window-change', (acceptChange) => { if (typeof acceptChange === 'function') acceptChange(); });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          shells.add(stream);
          stream.on('close', () => shells.delete(stream));
          stream.on('data', (data) => stream.write(Buffer.concat([Buffer.from('echo:'), Buffer.from(data)])));
          setImmediate(() => stream.write('READY\n'));
        });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => {
        for (const stream of shells) stream.close();
        server.close(() => done());
      }));
      resolve({ port: server.address().port, shells, fingerprint: host.fingerprint, stats });
    });
  });
}

async function fixture(t, { ssh = null, limits, env = {}, sshDial } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-terminal-'));
  const config = loadConfig({
    SERVER_ID: 'cloud-01',
    SERVER_NAME: 'Cloud 01',
    SERVER_REGION: '上海 · 阿里云',
    SERVER_IP: '203.0.113.10',
    REMOTE_CLOUD_1_ID: 'huawei-ap-southeast-1',
    REMOTE_CLOUD_1_NAME: '华为云 · 东南亚',
    REMOTE_CLOUD_1_REGION: '东南亚 · ap-southeast-1',
    REMOTE_CLOUD_1_IP: '203.0.113.11',
    REMOTE_CLOUD_1_SECRET: `remote-secret-should-not-leak-${'0123456789abcdef'}`,
    REMOTE_CLOUD_2_ID: 'huawei-cn-east-3',
    REMOTE_CLOUD_2_NAME: '华为云 · 华东',
    REMOTE_CLOUD_2_REGION: '华东 · cn-east-3',
    REMOTE_CLOUD_2_IP: '203.0.113.12',
    SSH_1_ID: 'cloud-01',
    SSH_1_HOST: '127.0.0.1',
    SSH_1_PORT: ssh ? String(ssh.port) : '22',
    SSH_1_USERNAME: 'tester',
    SSH_1_PASSWORD: SSH_PASSWORD,
    SSH_1_HOST_FINGERPRINT: ssh?.fingerprint || '',
    SSH_2_ID: 'huawei-ap-southeast-1',
    SSH_2_HOST: '127.0.0.1',
    SSH_2_PORT: ssh ? String(ssh.port) : '22',
    SSH_2_USERNAME: 'tester',
    SSH_2_PASSWORD: SSH_PASSWORD,
    SSH_2_HOST_FINGERPRINT: ssh?.fingerprint || '',
    SSH_3_ID: 'huawei-cn-east-3',
    SSH_3_USERNAME: 'tester',
    SSH_3_PASSWORD_FILE: '/etc/personal-site/ssh/huawei-cn-east-3.pass',
    SSH_3_PRIVATE_KEY: `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_MATERIAL}\n-----END OPENSSH PRIVATE KEY-----\n`,
    NAS_DEVICE_ID: 'fnos-nas',
    ...env,
  }, {
    HOST: '127.0.0.1',
    PORT: 0,
    SITE_ORIGIN: ORIGIN,
    NODE_ENV: 'production',
    DATA_DIR: directory,
    PUBLIC_DIR: publicDir,
    MONITORING_MODE: 'mock',
    AUTH_USERNAME: USER,
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'),
    cookieSecure: false,
  });
  const server = createApplication({ config, terminalLimits: limits, sshDial });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  return { server, base, config };
}

async function login(base) {
  const challenge = await fetch(`${base}/login`);
  const html = await challenge.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const prelogin = challenge.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: prelogin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ username: USER, password: SITE_PASSWORD }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().filter((value) => !/Max-Age=0/.test(value)).map((value) => value.split(';')[0]).join('; ');
}

function openSocket(base, cookie, serverId, origin = ORIGIN) {
  const url = `${base.replace('http', 'ws')}/api/terminal/session?server=${encodeURIComponent(serverId)}`;
  const messages = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out opening ${serverId}`));
    }, 5000);
    ws.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), ws });
      });
    });
    ws.on('message', (data, isBinary) => {
      messages.push({
        isBinary,
        payload: isBinary ? Buffer.from(data).toString('utf8') : data.toString(),
      });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ status: 101, ws, messages });
    });
    ws.on('error', () => {});
  });
}

function waitFor(opened, predicate, timeoutMs = 4000) {
  const messages = opened.messages ?? [];
  const found = messages.find((message) => predicate(message.payload, message.isBinary));
  if (found) return Promise.resolve(found.payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for terminal output; saw ${JSON.stringify(messages)}`));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      const payload = isBinary ? Buffer.from(data).toString('utf8') : data.toString();
      if (!predicate(payload, isBinary)) return;
      clearTimeout(timer);
      opened.ws.off('message', onMessage);
      resolve(payload);
    };
    opened.ws.on('message', onMessage);
  });
}

test('ssh targets inherit monitor names and do not publish dial addresses or secrets', () => {
  const servers = presentSshServers([
    {
      id: 'cloud-01',
      name: 'Cloud 01',
      region: '上海 · 阿里云',
      displayHost: '203.0.113.10',
      dialHost: '127.0.0.1',
      ready: true,
      password: SSH_PASSWORD,
      privateKey: KEY_MATERIAL,
    },
    {
      id: 'huawei-cn-east-3',
      name: '配置里的旧名称',
      region: '',
      displayHost: '203.0.113.12',
      dialHost: '127.0.0.1',
      ready: true,
    },
  ], {
    localServer: { id: 'cloud-01', name: 'Cloud 01', region: '上海 · 阿里云', ip: '203.0.113.10', status: 'online' },
    remotes: [{
      id: 'huawei-cn-east-3',
      name: '华为云 · 华东',
      server: { id: 'huawei-cn-east-3', name: '华为云 · 华东', region: '华东 · cn-east-3', ip: '203.0.113.12', status: 'waiting' },
    }],
  });
  assert.deepEqual(servers, [
    { id: 'cloud-01', name: 'Cloud 01', region: '上海 · 阿里云', host: '203.0.113.10', online: 'online' },
    { id: 'huawei-cn-east-3', name: '华为云 · 华东', region: '华东 · cn-east-3', host: '203.0.113.12', online: 'waiting' },
  ]);
  assert.equal(JSON.stringify(servers).includes(SSH_PASSWORD), false);
  assert.equal(JSON.stringify(servers).includes(KEY_MATERIAL), false);
  assert.equal(JSON.stringify(servers).includes('127.0.0.1'), false);
});

test('anonymous visitors cannot open the terminal page, server list, socket, or xterm assets', async (t) => {
  const app = await fixture(t);
  const page = await fetch(`${app.base}/terminal`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await fetch(`${app.base}/api/terminal/servers`)).status, 401);
  const denied = await openSocket(app.base, '', 'cloud-01');
  assert.equal(denied.status, 401);
  assert.match(denied.body, /unauthorized/);
  assert.doesNotMatch(denied.body, new RegExp(SSH_PASSWORD));
  for (const path of ['/assets/vendor/xterm/xterm.js', '/assets/vendor/xterm/xterm.css', '/assets/pages/terminal.js']) {
    assert.notEqual((await fetch(`${app.base}${path}`)).status, 200, path);
  }
});

test('authenticated server list matches monitor cards and the socket only reaches the allowlist', async (t) => {
  const ssh = await startEchoServer(t);
  const app = await fixture(t, { ssh });
  const cookie = await login(app.base);
  const listed = await fetch(`${app.base}/api/terminal/servers`, { headers: { Cookie: cookie } });
  const body = await listed.json();
  const text = JSON.stringify(body);
  assert.equal(listed.status, 200);
  assert.deepEqual(body.servers.map((server) => server.id), ['cloud-01', 'huawei-ap-southeast-1', 'huawei-cn-east-3']);
  assert.deepEqual(body.servers[0], {
    id: 'cloud-01', name: 'Cloud 01', region: '上海 · 阿里云', host: '203.0.113.10', online: 'online',
  });
  assert.equal(body.servers[1].name, '华为云 · 东南亚');
  assert.equal(body.servers[1].host, '203.0.113.11');
  assert.equal(body.servers[1].online, 'waiting');
  assert.equal(body.servers[2].name, '华为云 · 华东');
  assert.equal(body.servers[2].region, '华东 · cn-east-3');
  assert.equal(body.servers[2].host, '203.0.113.12');
  assert.equal(text.includes('fnos-nas'), false);
  assert.equal(text.includes(SSH_PASSWORD), false);
  assert.equal(text.includes(KEY_MATERIAL), false);
  assert.equal(text.includes('127.0.0.1'), false);
  assert.equal(text.includes('remote-secret-should-not-leak'), false);
  for (const server of body.servers) {
    assert.deepEqual(Object.keys(server).sort(), ['host', 'id', 'name', 'online', 'region']);
  }
  assert.equal((await fetch(`${app.base}/terminal`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${app.base}/assets/vendor/xterm/xterm.js`, { headers: { Cookie: cookie } })).status, 200);
  const blocked = await openSocket(app.base, cookie, 'fnos-nas');
  assert.equal(blocked.status, 404);
  const crossSite = await openSocket(app.base, cookie, 'cloud-01', 'https://evil.example');
  assert.equal(crossSite.status, 403);

  const first = await openSocket(app.base, cookie, 'cloud-01');
  assert.equal(first.status, 101);
  const connected = await waitFor(first, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
  assert.doesNotMatch(connected, new RegExp(SSH_PASSWORD));
  assert.match(await waitFor(first, (payload, isBinary) => isBinary && payload.includes('READY')), /READY/);
  first.ws.send(Buffer.from('pwd\n'));
  assert.match(await waitFor(first, (payload, isBinary) => isBinary && payload.includes('echo:pwd')), /echo:pwd/);

  const second = await openSocket(app.base, cookie, 'huawei-ap-southeast-1');
  assert.equal(second.status, 101);
  const replaced = await waitFor(first, (payload, isBinary) => !isBinary && payload.includes('已切换到其他连接'));
  assert.doesNotMatch(replaced, /PRIVATE|password|127\.0\.0\.1/);
  await waitFor(second, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ssh.shells.size, 1);
  second.ws.send(JSON.stringify({ type: 'disconnect' }));
  await waitFor(second, (payload, isBinary) => !isBinary && payload.includes('已断开'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ssh.shells.size, 0);

  const again = await openSocket(app.base, cookie, 'cloud-01');
  await waitFor(again, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
  const session = await (await fetch(`${app.base}/api/session`, { headers: { Cookie: cookie } })).json();
  const logout = await fetch(`${app.base}/api/auth/logout`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  again.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  const expired = await waitFor(again, (payload, isBinary) => !isBinary && payload.includes('auth_expired'));
  assert.match(expired, /登录已失效/);
  assert.doesNotMatch(expired, new RegExp(SSH_PASSWORD));
});

test('a wrong password ends the socket with a fixed error and idle or size limits close the session', async (t) => {
  const ssh = await startEchoServer(t);
  const app = await fixture(t, {
    ssh,
    limits: { idleMs: 200, maxBytes: 32, maxMs: 60_000 },
    env: { SSH_1_PASSWORD: 'not-the-ssh-password' },
  });
  const cookie = await login(app.base);
  const failed = await openSocket(app.base, cookie, 'cloud-01');
  assert.equal(failed.status, 101);
  const error = await waitFor(failed, (payload, isBinary) => !isBinary && payload.includes('"error"'));
  assert.match(error, /登录失败/);
  assert.doesNotMatch(error, /not-the-ssh-password|PRIVATE|stack|\/etc\//);

  const limited = await fixture(t, { ssh, limits: { idleMs: 5_000, maxBytes: 4, maxMs: 60_000 } });
  const limitedCookie = await login(limited.base);
  const session = await openSocket(limited.base, limitedCookie, 'cloud-01');
  const capped = await waitFor(session, (payload, isBinary) => !isBinary && payload.includes('会话数据量已达上限'));
  assert.match(capped, /会话数据量已达上限/);
  assert.equal(JSON.stringify(capped).includes(SSH_PASSWORD), false);
});

test('idle timeout and incomplete ssh configuration are rejected without live hosts', async (t) => {
  let opened = 0;
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-terminal-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await fixture(t, {
    limits: { idleMs: 80, maxBytes: 1024, maxMs: 60_000 },
    sshDial() {
      opened += 1;
      let onClose = () => {};
      return {
        cancel() { onClose(); },
        done: Promise.resolve({
          write() {},
          resize() {},
          close() { onClose(); },
          onData() {},
          onClose(callback) { onClose = callback; },
          onError() {},
        }),
      };
    },
  });
  const cookie = await login(app.base);
  const ws = await openSocket(app.base, cookie, 'cloud-01');
  assert.equal(ws.status, 101);
  const idle = await waitFor(ws, (payload, isBinary) => !isBinary && payload.includes('空闲超时'), 2000);
  assert.match(idle, /空闲超时，连接已断开/);
  assert.equal(opened, 1);

  const incomplete = loadConfig({
    SSH_4_ID: 'cloud-01',
    SSH_4_USERNAME: 'root',
  }, {
    NODE_ENV: 'production',
    SITE_ORIGIN: ORIGIN,
    DATA_DIR: directory,
    AUTH_USERNAME: USER,
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: 'x'.repeat(40),
  });
  assert.throws(() => validateRuntimeConfig(incomplete), /SSH target cloud-01 is missing credentials/);
});

test('pinned host keys match, and a mismatch or missing pin is refused before authentication', async (t) => {
  const ssh = await startEchoServer(t);
  const app = await fixture(t, { ssh });
  const cookie = await login(app.base);
  const matched = await openSocket(app.base, cookie, 'cloud-01');
  assert.equal(matched.status, 101);
  const connected = await waitFor(matched, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
  assert.match(connected, /已连接/);
  assert.ok(ssh.stats.auths > 0);

  const mismatch = await fixture(t, {
    ssh,
    env: { SSH_1_HOST_FINGERPRINT: `SHA256:${'A'.repeat(43)}` },
  });
  const mismatchCookie = await login(mismatch.base);
  const authsBefore = ssh.stats.auths;
  const failed = await openSocket(mismatch.base, mismatchCookie, 'cloud-01');
  const error = await waitFor(failed, (payload, isBinary) => !isBinary && payload.includes('主机指纹不匹配'));
  assert.match(error, /主机指纹不匹配/);
  assert.doesNotMatch(error, /PRIVATE|password|127\.0\.0\.1|SHA256:/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(ssh.stats.auths, authsBefore);

  const unset = await fixture(t, { ssh, env: { SSH_1_HOST_FINGERPRINT: '' } });
  const unsetCookie = await login(unset.base);
  const connectionsBefore = ssh.stats.connections;
  const unsetSocket = await openSocket(unset.base, unsetCookie, 'cloud-01');
  const unsetError = await waitFor(unsetSocket, (payload, isBinary) => !isBinary && payload.includes('未配置主机指纹'));
  assert.match(unsetError, /未配置主机指纹，已拒绝连接/);
  assert.equal(ssh.stats.connections, connectionsBefore);

  const tofu = await fixture(t, {
    ssh,
    env: { SSH_1_HOST_FINGERPRINT: '', SSH_HOSTKEY_TOFU: '1' },
  });
  const tofuCookie = await login(tofu.base);
  const trusted = await openSocket(tofu.base, tofuCookie, 'cloud-01');
  await waitFor(trusted, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
});

test('private key authentication is tried before the password fallback', async (t) => {
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const identity = Array.isArray(parsed) ? parsed[0] : parsed;
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-ssh-key-'));
  const keyPath = join(directory, 'id_rsa');
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const keyed = await startEchoServer(t, { acceptKey: identity.getPublicSSH() });
  const app = await fixture(t, {
    ssh: keyed,
    env: { SSH_1_PASSWORD: '', SSH_1_PRIVATE_KEY_FILE: keyPath },
  });
  const cookie = await login(app.base);
  const opened = await openSocket(app.base, cookie, 'cloud-01');
  await waitFor(opened, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
  assert.ok(keyed.stats.methods.includes('publickey'));
  assert.equal(keyed.stats.methods.includes('password'), false);
  assert.equal(JSON.stringify(keyed.stats).includes(keyPath), false);

  const fallbackServer = await startEchoServer(t);
  const fallback = await fixture(t, {
    ssh: fallbackServer,
    env: { SSH_1_PRIVATE_KEY_FILE: keyPath, SSH_1_PASSWORD: SSH_PASSWORD },
  });
  const fallbackCookie = await login(fallback.base);
  const session = await openSocket(fallback.base, fallbackCookie, 'cloud-01');
  await waitFor(session, (payload, isBinary) => !isBinary && payload.includes('"connected"'));
  const publickeyAt = fallbackServer.stats.methods.indexOf('publickey');
  const passwordAt = fallbackServer.stats.methods.indexOf('password');
  assert.ok(publickeyAt >= 0);
  assert.ok(passwordAt > publickeyAt);
});

test('terminal upgrades are rate limited per session', async (t) => {
  const app = await fixture(t, { limits: { upgradeMaxAttempts: 2 } });
  const cookie = await login(app.base);
  assert.equal((await openSocket(app.base, cookie, 'cloud-01')).status, 101);
  assert.equal((await openSocket(app.base, cookie, 'cloud-01')).status, 101);
  const limited = await openSocket(app.base, cookie, 'cloud-01');
  assert.equal(limited.status, 429);
  assert.match(limited.body, /终端连接过于频繁/);
  assert.doesNotMatch(limited.body, new RegExp(SSH_PASSWORD));
});

test('the example env documents the three fleet slots and contains no private key', async () => {
  const example = await readFile(new URL('../deploy/site.env.example', import.meta.url), 'utf8');
  assert.match(example, /SSH_1_ID=cloud-01/);
  assert.match(example, /SSH_1_HOST=127\.0\.0\.1/);
  assert.match(example, /SSH_2_ID=huawei-ap-southeast-1/);
  assert.match(example, /SSH_3_ID=huawei-cn-east-3/);
  assert.match(example, /SSH_1_PRIVATE_KEY_FILE=/);
  assert.match(example, /SERVER_SSH_HOSTKEY/);
  assert.match(example, /REMOTE_CLOUD_1_SSH_HOSTKEY/);
  assert.match(example, /ssh-keygen -lf -/);
  assert.match(example, /SSH_HOSTKEY_TOFU/);
  assert.doesNotMatch(example, /BEGIN [A-Z ]*PRIVATE KEY/);
  assert.doesNotMatch(example, /SSH_\d+_PASSWORD=.+/);
  const page = await readFile(new URL('../public/assets/pages/terminal.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /PRIVATE KEY|SSH_\d+_PASSWORD|s3cr3t/);
  const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.match(caddy, /\/api\/terminal\/session/);
  assert.match(caddy, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(caddy, /Strict-Transport-Security[^\n]*preload/i);
});
