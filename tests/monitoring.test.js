import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import {
  LiveDashboardProvider,
  bytesToGiB,
  calculateCpuPercent,
  computeDiskUsage,
  parseMeminfo,
  parseProcStat,
} from '../server/providers/live.js';
import { hashPassword } from '../server/auth/password.js';
import { sessionCookie } from '../server/auth/cookies.js';

async function liveConfig(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-monitoring-config-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return loadConfig({}, {
    NODE_ENV: 'production',
    SITE_ORIGIN: 'https://personal-site.example',
    DATA_DIR: join(directory, 'data'),
    AUTH_USERNAME: 'monitor-user',
    AUTH_PASSWORD_HASH: 'scrypt$16384$8$1$salt$key',
    AUTH_SECRET: randomBytes(48).toString('hex'),
    ...overrides,
  });
}

function sample(config, value, extra = {}) {
  const sampledAt = extra.sampledAt ?? new Date(1_700_000_000_000 + value * 1000).toISOString();
  return {
    sampledAt,
    server: {
      id: config.serverId,
      name: config.serverName,
      region: config.serverRegion,
      ip: config.serverIp,
      os: 'Test Linux',
      vcpu: 2,
      status: 'online',
      uptimeSeconds: 1234,
      cpuPercent: extra.cpuPercent ?? null,
      loadAverage: [0.1, 0.2, 0.3],
      cpuError: null,
    },
    metrics: {
      memory: { used: value, total: 16, available: 16 - value, unit: 'GiB', error: null },
      disk: { used: value * 2, total: 40, available: 40 - value * 2, reserved: 1, unit: 'GiB', error: null },
    },
    cpuState: { idle: value, total: value + 100 },
  };
}

test('production defaults to live monitoring and development defaults to mock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-monitoring-mode-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(loadConfig({}, { NODE_ENV: 'production', DATA_DIR: join(directory, 'prod') }).monitoringMode, 'live');
  assert.equal(loadConfig({}, { NODE_ENV: 'development', DATA_DIR: join(directory, 'dev') }).monitoringMode, 'mock');
  assert.equal(loadConfig({}, { NODE_ENV: 'production', DATA_DIR: join(directory, 'override'), MONITORING_MODE: 'mock' }).monitoringMode, 'mock');
  assert.throws(() => validateRuntimeConfig({
    authUsername: 'test', authPasswordHash: 'test-hash', authSecret: 'x'.repeat(64),
    nodeEnv: 'production', siteOrigin: 'https://personal-site.example',
    cookieSecure: true, monitoringMode: 'typo',
  }), /MONITORING_MODE/);
  const bounded = loadConfig({}, {
    NODE_ENV: 'production',
    DATA_DIR: join(directory, 'bounded'),
    MONITORING_REFRESH_INTERVAL_MS: 0,
    MONITORING_HISTORY_LIMIT: 500,
  });
  assert.equal(bounded.monitoringRefreshIntervalMs, 1000);
  assert.equal(bounded.monitoringHistoryLimit, 60);
});

test('Linux parsers compute memory and CPU percentages from kernel counters', () => {
  const memory = parseMeminfo('MemTotal:       2097152 kB\nMemAvailable:    524288 kB\n');
  assert.equal(bytesToGiB(memory.total), 2);
  assert.equal(bytesToGiB(memory.available), 0.5);
  assert.equal(bytesToGiB(memory.used), 1.5);
  assert.throws(() => parseMeminfo('MemTotal:             0 kB\nMemAvailable:       1 kB\n'));
  assert.throws(() => parseMeminfo('MemTotal:          1000 kB\nMemAvailable:      2000 kB\n'));

  const first = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\n');
  const second = parseProcStat('cpu  150 0 150 900 0 0 0 0 0 0\n');
  assert.equal(calculateCpuPercent(null, first), null);
  assert.equal(calculateCpuPercent(first, second), 50);
  assert.equal(calculateCpuPercent(second, first), null);
  assert.equal(calculateCpuPercent({ idle: 0, total: 100 }, { idle: 500, total: 200 }), 0);
  assert.equal(calculateCpuPercent({ idle: 100, total: 100 }, { idle: 100, total: 200 }), 100);
});

test('disk usage keeps reserved capacity distinct from user-available space', () => {
  const disk = computeDiskUsage({ bsize: 1024, blocks: 100, bfree: 30, bavail: 20 });
  assert.equal(disk.total, 102400);
  assert.equal(disk.used, 71680);
  assert.equal(disk.available, 20480);
  assert.equal(disk.reserved, 10240);
  assert.throws(() => computeDiskUsage({ bsize: 1024, blocks: 100, bfree: 10, bavail: 20 }));
});

test('live provider merges concurrent sampling and caps history at the configured limit', async t => {
  const config = await liveConfig(t, { MONITORING_HISTORY_LIMIT: 3 });
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const provider = new LiveDashboardProvider(config, {
    collector: async () => {
      calls += 1;
      await blocked;
      return sample(config, calls);
    },
  });

  const first = provider.sample();
  const second = provider.sample();
  release();
  assert.strictEqual(await first, await second);
  assert.equal(calls, 1);
  assert.deepEqual((await provider.getDashboard()).metrics.cpu.history, []);

  const historyProvider = new LiveDashboardProvider(config, {
    collector: async () => {
      const value = ++calls;
      const cpuPercent = value === 6 ? 140 : value * 10;
      return sample(config, value, { cpuPercent });
    },
    historyLimit: 3,
  });
  for (let index = 0; index < 5; index += 1) {
    await historyProvider.sample();
  }
  const dashboard = await historyProvider.getDashboard();
  assert.deepEqual(dashboard.metrics.memory.history, [4, 5, 6]);
  assert.deepEqual(dashboard.metrics.disk.history, [8, 10, 12]);
  assert.deepEqual(dashboard.metrics.cpu.history, [30, 40, 50]);
  assert.equal(dashboard.metrics.cpu.used, null);
  assert.equal(dashboard.metrics.cpu.total, null);
  assert.equal(dashboard.server.cpuPercent, null);
});

test('live provider reports collection failures without falling back to mock data', async t => {
  const config = await liveConfig(t);
  const error = Object.assign(new Error('cannot read /proc/meminfo'), { code: 'proc_read_failed' });
  const provider = new LiveDashboardProvider(config, {
    collector: async () => {
      throw error;
    },
  });
  const dashboard = await provider.getDashboard();
  assert.equal(dashboard.mode, 'live');
  assert.equal(dashboard.stale, false);
  assert.equal(dashboard.error.code, 'proc_read_failed');
  assert.equal(dashboard.error.message, 'Live monitoring is temporarily unavailable');
  assert.equal(dashboard.server.status, 'error');
  assert.equal(dashboard.metrics.memory.used, null);
  assert.equal(dashboard.metrics.memory.error.code, 'proc_read_failed');
  assert.deepEqual(dashboard.metrics.cpu.history, []);
  assert.equal(dashboard.metrics.cpu.used, null);
});

test('live provider marks old successful samples stale after a later failure', async t => {
  const config = await liveConfig(t);
  let fail = false;
  const provider = new LiveDashboardProvider(config, {
    collector: async () => {
      if (fail) throw Object.assign(new Error('statfs failed'), { code: 'statfs_failed' });
      return sample(config, 1, { cpuPercent: 12.5 });
    },
  });
  const fresh = await provider.sample();
  fail = true;
  const stale = await provider.sample();
  assert.equal(fresh.mode, 'live');
  assert.equal(stale.mode, 'live');
  assert.equal(stale.stale, true);
  assert.equal(stale.error.code, 'statfs_failed');
  assert.equal(stale.server.status, 'stale');
  assert.deepEqual(stale.metrics.memory.history, [1]);
  assert.deepEqual(stale.metrics.cpu.history, [12.5]);
  assert.equal(stale.metrics.cpu.used, 12.5);
  assert.equal(stale.server.cpuPercent, 12.5);
});

test('application dashboard uses injected live provider and stops it during close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-monitoring-app-'));
  const config = loadConfig({}, {
    NODE_ENV: 'production',
    SITE_ORIGIN: 'https://personal-site.example',
    DATA_DIR: join(directory, 'data'),
    AUTH_USERNAME: 'monitor-user',
    AUTH_PASSWORD_HASH: await hashPassword('monitor-password'),
    AUTH_SECRET: randomBytes(48).toString('hex'),
    MONITORING_MODE: 'live',
  });
  let started = 0;
  let stopped = 0;
  const provider = {
    start() { started += 1; },
    stop() { stopped += 1; },
    async getDashboard() { return { mode: 'live', updatedAt: 'now', metrics: {}, server: { status: 'online' } }; },
  };
  const server = createApplication({ config, dashboardProvider: provider });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const session = server.sessionStore.create('monitor-user', 60_000);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`, {
      headers: { Cookie: sessionCookie(session.token, config) },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, 'live');
    assert.equal(started, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(stopped, 1);
});
