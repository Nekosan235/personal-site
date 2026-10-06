import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { sessionCookie } from '../server/auth/cookies.js';
import { NasMonitorStore, createNasSignature } from '../server/providers/nas.js';

const ORIGIN = 'https://personal-site.example';
const SECRET = 'test-nas-secret-0123456789abcdef';

async function configFor(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-nas-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return loadConfig({}, {
    NODE_ENV: 'production',
    SITE_ORIGIN: ORIGIN,
    DATA_DIR: join(directory, 'data'),
    AUTH_USERNAME: 'nas-test-user',
    AUTH_PASSWORD_HASH: await hashPassword('nas-test-password'),
    AUTH_SECRET: randomBytes(48).toString('hex'),
    MONITORING_MODE: 'mock',
    NAS_MONITOR_SECRET: SECRET,
    NAS_DEVICE_ID: 'fnos-nas',
    NAS_DEVICE_NAME: 'Test NAS',
    NAS_DEVICE_HOST: 'nas.local',
    NAS_STALE_AFTER_MS: 60_000,
    ...overrides,
  });
}

const NOW = 1_760_000_000_000;

function report(value = 1, sampledAt = new Date(NOW).toISOString()) {
  return {
    deviceId: 'fnos-nas',
    sampledAt,
    server: {
      id: 'fnos-nas',
      name: 'Test NAS',
      os: 'Linux test',
      vcpu: 4,
      uptimeSeconds: 123,
      cpuPercent: null,
      loadAverage: [0.1, 0.2, 0.3],
    },
    metrics: {
      memory: { used: value, total: 8, available: 8 - value, unit: 'GiB' },
      disk: {
        volumes: [
          { path: '/data-a', device: 'dev-a', used: value * 2, total: 10, available: 8, reserved: 0.5, unit: 'GiB' },
          { path: '/data-b', device: 'dev-b', used: value * 3, total: 20, available: 16, reserved: 1, unit: 'GiB' },
        ],
      },
    },
  };
}

function signedHeaders(config, body, { timestamp = '1760000000', nonce = 'nonce-one', deviceId = 'fnos-nas' } = {}) {
  return {
    'x-nas-device-id': deviceId,
    'x-nas-timestamp': timestamp,
    'x-nas-nonce': nonce,
    'x-nas-signature': createNasSignature({
      secret: config.nasMonitorSecret,
      deviceId,
      timestamp,
      nonce,
      body,
    }),
  };
}

test('runtime config rejects misspelled monitoring modes and short NAS secrets', async t => {
  const config = await configFor(t);
  assert.doesNotThrow(() => validateRuntimeConfig(config));
  assert.throws(() => validateRuntimeConfig({ ...config, monitoringMode: 'liv' }));
  assert.throws(() => validateRuntimeConfig({ ...config, nasMonitorSecret: 'short' }));
});

test('NAS HMAC accepts one report, rejects replay, stale timestamps and unknown devices', async t => {
  const config = await configFor(t);
  const store = new NasMonitorStore(config, { now: () => NOW });
  const body = JSON.stringify(report());
  const headers = signedHeaders(config, body);
  assert.equal(store.verifyHeaders(headers, body).ok, true);
  assert.equal(store.verifyHeaders(headers, body).error, 'replayed_nonce');
  assert.equal(store.verifyHeaders(signedHeaders(config, body, { timestamp: '1000000000', nonce: 'nonce-two' }), body).error, 'stale_signature');
  assert.equal(store.verifyHeaders(signedHeaders(config, body, { nonce: 'nonce-three', deviceId: 'other-nas' }), body).error, 'unknown_device');
});

test('NAS HMAC nonce store refuses new nonces when full instead of evicting live entries', async t => {
  const config = await configFor(t);
  const store = new NasMonitorStore(config, { now: () => NOW, nonceLimit: 1 });
  const body = JSON.stringify(report());
  assert.equal(store.verifyHeaders(signedHeaders(config, body, { nonce: 'nonce-one' }), body).ok, true);
  assert.equal(store.verifyHeaders(signedHeaders(config, body, { nonce: 'nonce-two' }), body).statusCode, 429);
});

test('NAS store shows waiting, online, history and stale states without fake online data', async t => {
  let now = NOW;
  const config = await configFor(t, { NAS_STALE_AFTER_MS: 60_000, MONITORING_HISTORY_LIMIT: 3 });
  const store = new NasMonitorStore(config, { now: () => now });
  assert.equal(store.getDashboard().server.status, 'waiting');

  for (let index = 1; index <= 5; index += 1) {
    now += 15_000;
    store.acceptReport(report(index, new Date(now).toISOString()));
  }
  let dashboard = store.getDashboard();
  assert.equal(dashboard.name, 'Test NAS');
  assert.equal(dashboard.server.status, 'online');
  assert.equal(dashboard.stale, false);
  assert.deepEqual(dashboard.metrics.memory.history, [3, 4, 5]);
  assert.deepEqual(dashboard.metrics.disk.history, [15, 20, 25]);
  assert.equal(dashboard.metrics.disk.used, 25);
  assert.equal(dashboard.metrics.disk.available, 24);
  assert.equal(dashboard.metrics.disk.reserved, 1.5);
  assert.equal(dashboard.metrics.disk.volumes.length, 2);

  now += 61_000;
  dashboard = store.getDashboard();
  assert.equal(dashboard.stale, true);
  assert.equal(dashboard.server.status, 'offline');
  assert.equal(dashboard.error.code, 'stale_report');
});

test('NAS reports require fresh sampledAt and preserve null server numbers', async t => {
  const config = await configFor(t);
  const store = new NasMonitorStore(config, { now: () => NOW });
  assert.throws(() => store.acceptReport({ ...report(), sampledAt: null }), /missing_sampled_at/);
  assert.throws(() => store.acceptReport(report(1, '2000-01-01T00:00:00.000Z')), /stale_sampled_at/);

  const payload = report();
  payload.server.vcpu = null;
  payload.server.uptimeSeconds = null;
  payload.metrics.memory.available = null;
  payload.metrics.disk.volumes = [
    { path: '/data-a', device: 'dev-a', used: 1, total: 10, available: 8, reserved: 0.5, unit: 'GiB' },
  ];
  payload.metrics.disk.missingVolumes = [{ path: '/data-b', error: 'not_directory' }];
  payload.metrics.disk.partial = true;
  store.acceptReport(payload);
  const dashboard = store.getDashboard();
  assert.equal(dashboard.server.vcpu, null);
  assert.equal(dashboard.server.uptimeSeconds, null);
  assert.equal(dashboard.metrics.memory.available, null);
  assert.equal(dashboard.metrics.disk.partial, true);
  assert.equal(dashboard.metrics.disk.missingVolumes.length, 1);
});

test('NAS incomplete volume metrics are partial and never counted as zero usage', async t => {
  const config = await configFor(t);
  const store = new NasMonitorStore(config, { now: () => NOW });
  const payload = report();
  payload.metrics.disk.volumes = [
    { path: '/data', device: 'dev-data', used: null, total: 8, available: 8, reserved: 0, unit: 'GiB' },
  ];
  store.acceptReport(payload);
  const dashboard = store.getDashboard();
  assert.equal(dashboard.metrics.disk.used, null);
  assert.equal(dashboard.metrics.disk.total, null);
  assert.deepEqual(dashboard.metrics.disk.history, []);
  assert.equal(dashboard.metrics.disk.partial, true);
  assert.equal(dashboard.metrics.disk.error.code, 'no_volumes');
  assert.equal(dashboard.metrics.disk.missingVolumes[0].error, 'invalid_volume_metric');
});

test('NAS report endpoint bypasses browser auth only with valid HMAC and dashboard devices stay session protected', async t => {
  const config = await configFor(t);
  const server = createApplication({
    config,
    nasMonitoring: { now: () => NOW },
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify(report());
    let response = await fetch(`${base}/api/monitor/nas/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 401);

    response = await fetch(`${base}/api/monitor/nas/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedHeaders(config, body) },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);

    response = await fetch(`${base}/api/dashboard`);
    assert.equal(response.status, 401);

    const session = server.sessionStore.create('nas-test-user', 60_000);
    response = await fetch(`${base}/api/dashboard`, {
      headers: { Cookie: sessionCookie(session.token, config) },
    });
    assert.equal(response.status, 200);
    const dashboard = await response.json();
    assert.equal(dashboard.devices.length, 2);
    assert.equal(dashboard.devices[0].id, 'liveCloud');
    assert.equal(dashboard.devices[1].id, 'fnos-nas');
    assert.equal(dashboard.devices[1].server.status, 'online');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
