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
      cpuPercent: value,
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
  assert.deepEqual(dashboard.metrics.cpu.history, [3, 4, 5]);
  assert.equal(dashboard.metrics.cpu.used, 5);
  assert.equal(dashboard.metrics.cpu.total, 100);
  assert.equal(dashboard.metrics.cpu.available, 95);
  assert.equal(dashboard.metrics.disk.used, 25);
  assert.equal(dashboard.metrics.disk.available, 24);
  assert.equal(dashboard.metrics.disk.reserved, 1.5);
  assert.equal(dashboard.metrics.disk.volumes.length, 2);
  const invalid = report(6, new Date(now).toISOString());
  invalid.server.cpuPercent = 150;
  store.acceptReport(invalid);
  assert.deepEqual(store.getDashboard().metrics.cpu.history, [3, 4, 5]);
  assert.equal(store.getDashboard().metrics.cpu.used, null);

  now += 61_000;
  dashboard = store.getDashboard();
  assert.equal(dashboard.stale, true);
  assert.equal(dashboard.server.status, 'offline');
  assert.equal(dashboard.error.code, 'stale_report');
  assert.deepEqual(dashboard.metrics.cpu.history, [3, 4, 5]);
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

const SHARED_CLOUD_SECRET = 'shared-cloud-secret-0123456789abcd';
const EAST_CLOUD_SECRET = 'device-two-secret-0123456789abcdef';

function cloudOverrides(extra = {}) {
  return {
    REMOTE_CLOUD_MONITOR_SECRET: SHARED_CLOUD_SECRET,
    REMOTE_CLOUD_1_ID: 'huawei-ap-southeast-1',
    REMOTE_CLOUD_1_NAME: '华为云 · 东南亚',
    REMOTE_CLOUD_1_REGION: '东南亚 · ap-southeast-1',
    REMOTE_CLOUD_1_IP: '183.87.149.115',
    REMOTE_CLOUD_2_ID: 'huawei-cn-east-3',
    REMOTE_CLOUD_2_NAME: '华为云 · 华东',
    REMOTE_CLOUD_2_REGION: '华东 · cn-east-3',
    REMOTE_CLOUD_2_IP: '1.94.16.40',
    REMOTE_CLOUD_2_SECRET: EAST_CLOUD_SECRET,
    ...extra,
  };
}

function cloudReport(deviceId, value = 1, sampledAt = new Date(NOW).toISOString()) {
  return {
    deviceId,
    sampledAt,
    server: {
      id: deviceId,
      name: 'from-agent',
      os: 'Linux test',
      vcpu: 2,
      uptimeSeconds: 90,
      cpuPercent: 3.5,
      loadAverage: [0.2, 0.1, 0.1],
    },
    metrics: {
      memory: { used: value, total: 4, available: 4 - value, unit: 'GiB' },
      disk: { used: value + 1, total: 40, available: 38, reserved: 0.4, unit: 'GiB', volumes: [] },
    },
  };
}

function signedMonitorHeaders(secret, body, {
  timestamp = '1760000000',
  nonce = 'nonce-cloud',
  deviceId,
  prefix = 'x-monitor',
} = {}) {
  return {
    [`${prefix}-device-id`]: deviceId,
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-nonce`]: nonce,
    [`${prefix}-signature`]: createNasSignature({ secret, deviceId, timestamp, nonce, body }),
  };
}

test('remote cloud slots parse shared and per-device secrets and reject bad registration', async t => {
  const config = await configFor(t, cloudOverrides());
  assert.equal(config.remoteDevices.length, 3);
  assert.equal(config.remoteDevices[0].type, 'nas');
  assert.equal(config.remoteDevices[1].secret, SHARED_CLOUD_SECRET);
  assert.equal(config.remoteDevices[1].ip, '183.87.149.115');
  assert.equal(config.remoteDevices[2].secret, EAST_CLOUD_SECRET);
  assert.equal(config.remoteDevices[2].name, '华为云 · 华东');
  assert.doesNotThrow(() => validateRuntimeConfig(config));

  const gap = await configFor(t, {
    REMOTE_CLOUD_2_ID: 'huawei-cn-east-3',
    REMOTE_CLOUD_2_NAME: '华为云 · 华东',
    REMOTE_CLOUD_2_IP: '1.94.16.40',
    REMOTE_CLOUD_MONITOR_SECRET: SHARED_CLOUD_SECRET,
  });
  assert.deepEqual(gap.remoteDevices.map((device) => device.id), ['fnos-nas', 'huawei-cn-east-3']);

  const duplicate = await configFor(t, cloudOverrides({ REMOTE_CLOUD_1_ID: 'fnos-nas' }));
  const malformed = await configFor(t, cloudOverrides({ REMOTE_CLOUD_1_ID: 'bad id' }));
  const shortSecret = await configFor(t, cloudOverrides({
    REMOTE_CLOUD_MONITOR_SECRET: 'short',
    REMOTE_CLOUD_2_SECRET: '',
  }));
  assert.throws(() => validateRuntimeConfig(duplicate), /duplicate remote device id fnos-nas/);
  assert.throws(() => validateRuntimeConfig(malformed), /remote device id/);
  assert.throws(() => validateRuntimeConfig(shortSecret), /REMOTE_CLOUD secret for huawei-ap-southeast-1/);
});

test('each remote device accepts only its own signature and keeps independent history', async t => {
  let now = NOW;
  const config = await configFor(t, cloudOverrides({ NAS_STALE_AFTER_MS: 60_000, MONITORING_HISTORY_LIMIT: 3 }));
  const store = new NasMonitorStore(config, { now: () => now });
  const dashboards = store.getDashboards();
  assert.deepEqual(dashboards.map((device) => device.id), ['fnos-nas', 'huawei-ap-southeast-1', 'huawei-cn-east-3']);
  assert.equal(dashboards[1].server.status, 'waiting');
  assert.equal(dashboards[1].error.code, 'waiting_for_report');
  assert.equal(dashboards[1].server.ip, '183.87.149.115');
  assert.equal(dashboards[1].server.region, '东南亚 · ap-southeast-1');
  assert.equal(dashboards[1].stale, false);

  const southeast = JSON.stringify(cloudReport('huawei-ap-southeast-1', 1));
  const east = JSON.stringify(cloudReport('huawei-cn-east-3', 2));
  const southeastHeaders = signedMonitorHeaders(SHARED_CLOUD_SECRET, southeast, {
    deviceId: 'huawei-ap-southeast-1',
    nonce: 'nonce-se-1',
  });
  assert.equal(store.verifyHeaders(southeastHeaders, southeast).ok, true);
  assert.equal(store.verifyHeaders(southeastHeaders, southeast).error, 'replayed_nonce');
  assert.equal(store.verifyHeaders(signedMonitorHeaders(EAST_CLOUD_SECRET, southeast, {
    deviceId: 'huawei-ap-southeast-1',
    nonce: 'nonce-se-wrong',
  }), southeast).error, 'bad_signature');
  assert.equal(store.verifyHeaders(signedMonitorHeaders(SHARED_CLOUD_SECRET, east, {
    deviceId: 'huawei-cn-east-3',
    nonce: 'nonce-east-shared',
  }), east).error, 'bad_signature');
  assert.equal(store.verifyHeaders(signedMonitorHeaders(SHARED_CLOUD_SECRET, southeast, {
    deviceId: 'not-registered',
    nonce: 'nonce-unknown',
  }), southeast).error, 'unknown_device');
  assert.equal(store.verifyHeaders(signedMonitorHeaders(SHARED_CLOUD_SECRET, southeast, {
    deviceId: 'huawei-ap-southeast-1',
    nonce: 'nonce-stale',
    timestamp: '1000000000',
  }), southeast).error, 'stale_signature');

  const eastHeaders = signedMonitorHeaders(EAST_CLOUD_SECRET, east, {
    deviceId: 'huawei-cn-east-3',
    nonce: 'nonce-east-1',
    prefix: 'x-nas',
  });
  assert.equal(store.verifyHeaders(eastHeaders, east).deviceId, 'huawei-cn-east-3');
  store.acceptReport(JSON.parse(southeast), 'huawei-ap-southeast-1');
  store.acceptReport(JSON.parse(east), 'huawei-cn-east-3');
  store.acceptReport(report(1));

  let listed = store.getDashboards();
  assert.equal(listed[0].server.status, 'online');
  assert.equal(listed[0].metrics.memory.used, 1);
  assert.equal(listed[1].name, '华为云 · 东南亚');
  assert.equal(listed[1].type, 'cloud');
  assert.equal(listed[1].mode, 'push');
  assert.equal(listed[1].server.status, 'online');
  assert.equal(listed[1].server.ip, '183.87.149.115');
  assert.equal(listed[1].metrics.memory.used, 1);
  assert.equal(listed[1].metrics.disk.used, 2);
  assert.equal(listed[2].name, '华为云 · 华东');
  assert.equal(listed[2].server.status, 'online');
  assert.equal(listed[2].metrics.memory.used, 2);
  assert.deepEqual(listed[1].metrics.cpu.history, [3.5]);
  assert.equal(listed[1].metrics.cpu.used, 3.5);
  assert.deepEqual(listed[1].metrics.disk.volumes, []);

  now += 30_000;
  const later = cloudReport('huawei-ap-southeast-1', 3, new Date(now).toISOString());
  store.acceptReport(later, 'huawei-ap-southeast-1');
  store.acceptReport(report(2, new Date(now).toISOString()));
  now += 40_000;
  listed = store.getDashboards();
  assert.equal(listed[1].stale, false);
  assert.equal(listed[1].server.status, 'online');
  assert.deepEqual(listed[1].metrics.memory.history, [1, 3]);
  assert.deepEqual(listed[1].metrics.cpu.history, [3.5, 3.5]);
  assert.equal(listed[2].stale, true);
  assert.equal(listed[2].server.status, 'offline');
  assert.equal(listed[2].error.code, 'stale_report');
  assert.equal(listed[2].error.message, 'Cloud monitor data is stale');
  assert.equal(listed[2].metrics.memory.used, 2);
  assert.equal(listed[0].stale, false);
  assert.equal(store.getDashboard().id, 'fnos-nas');
  assert.deepEqual(store.getDashboard().metrics.memory.history, [1, 2]);
  assert.deepEqual(store.getDashboard().metrics.cpu.history, [1, 2]);

  assert.throws(() => store.acceptReport(cloudReport('huawei-cn-east-3'), 'huawei-ap-southeast-1'), /device_mismatch/);
});

test('dashboard keeps local cloud sampling and lists each remote cloud beside NAS', async t => {
  const config = await configFor(t, cloudOverrides());
  const server = createApplication({
    config,
    nasMonitoring: { now: () => NOW },
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const southeast = JSON.stringify(cloudReport('huawei-ap-southeast-1', 1));
    const southeastHeaders = signedMonitorHeaders(SHARED_CLOUD_SECRET, southeast, {
      deviceId: 'huawei-ap-southeast-1',
      nonce: 'nonce-se-http',
    });
    const eastBody = JSON.stringify({ ...cloudReport('huawei-cn-east-3', 2), deviceId: 'huawei-ap-southeast-1' });
    let response = await fetch(`${base}/api/monitor/remote/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedMonitorHeaders(EAST_CLOUD_SECRET, eastBody, { deviceId: 'huawei-cn-east-3', nonce: 'nonce-mismatch' }),
      },
      body: eastBody,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'device_mismatch');

    response = await fetch(`${base}/api/monitor/remote/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...southeastHeaders },
      body: southeast,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deviceId, 'huawei-ap-southeast-1');

    const nasBody = JSON.stringify(report());
    response = await fetch(`${base}/api/monitor/nas/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedHeaders(config, nasBody, { nonce: 'nonce-nas-http' }) },
      body: nasBody,
    });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/api/monitor/nas/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...southeastHeaders },
      body: southeast,
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'replayed_nonce');

    const freshSoutheast = JSON.stringify(cloudReport('huawei-ap-southeast-1', 2));
    response = await fetch(`${base}/api/monitor/nas/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedMonitorHeaders(SHARED_CLOUD_SECRET, freshSoutheast, {
          deviceId: 'huawei-ap-southeast-1',
          nonce: 'nonce-se-via-nas-path-ok',
        }),
      },
      body: freshSoutheast,
    });
    assert.equal(response.status, 200);

    const session = server.sessionStore.create('nas-test-user', 60_000);
    response = await fetch(`${base}/api/dashboard`, {
      headers: { Cookie: sessionCookie(session.token, config) },
    });
    assert.equal(response.status, 200);
    const dashboard = await response.json();
    assert.equal(dashboard.mode, 'mock');
    assert.equal(dashboard.metrics.memory.total, 2);
    assert.deepEqual(dashboard.devices.map((device) => device.id), [
      'liveCloud',
      'fnos-nas',
      'huawei-ap-southeast-1',
      'huawei-cn-east-3',
    ]);
    assert.equal(dashboard.devices[0].type, 'cloud');
    assert.equal(dashboard.devices[0].mode, 'mock');
    assert.equal(dashboard.devices[1].server.status, 'online');
    assert.equal(dashboard.devices[2].type, 'cloud');
    assert.equal(dashboard.devices[2].mode, 'push');
    assert.equal(dashboard.devices[2].server.status, 'online');
    assert.equal(dashboard.devices[2].server.name, '华为云 · 东南亚');
    assert.equal(dashboard.devices[2].server.ip, '183.87.149.115');
    assert.equal(dashboard.devices[2].metrics.memory.used, 2);
    assert.equal(dashboard.devices[3].server.status, 'waiting');
    assert.equal(dashboard.devices[3].server.ip, '1.94.16.40');
    assert.equal(dashboard.devices[3].error.code, 'waiting_for_report');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a registered cloud without a secret stays visible and rejects reports', async t => {
  const config = await configFor(t, {
    REMOTE_CLOUD_1_ID: 'huawei-ap-southeast-1',
    REMOTE_CLOUD_1_NAME: '华为云 · 东南亚',
    REMOTE_CLOUD_1_IP: '183.87.149.115',
  });
  const store = new NasMonitorStore(config, { now: () => NOW });
  const body = JSON.stringify(cloudReport('huawei-ap-southeast-1'));
  const headers = signedMonitorHeaders(SHARED_CLOUD_SECRET, body, { deviceId: 'huawei-ap-southeast-1' });
  assert.equal(store.verifyHeaders(headers, body).error, 'remote_monitor_disabled');
  assert.equal(store.getDashboards()[1].server.status, 'waiting');
  assert.equal(store.getDashboard().id, 'fnos-nas');
});
