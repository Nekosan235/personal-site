import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

function boolFromEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function pick(overrides, env, lower, upper, fallback) {
  return overrides[lower] ?? overrides[upper] ?? env[upper] ?? fallback;
}

export function loadConfig(env = process.env, overrides = {}) {
  const siteOrigin = pick(overrides, env, 'siteOrigin', 'SITE_ORIGIN', 'https://203.0.113.10');
  const nodeEnv = pick(overrides, env, 'nodeEnv', 'NODE_ENV', 'development');
  const dataDir = resolve(pick(overrides, env, 'dataDir', 'DATA_DIR', resolve(projectRoot, 'data')));
  mkdirSync(dataDir, { recursive: true });

  const isLocalHttp =
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(siteOrigin);

  return {
    host: pick(overrides, env, 'host', 'HOST', '127.0.0.1'),
    port: Number(pick(overrides, env, 'port', 'PORT', 3010)),
    siteOrigin,
    dataDir,
    databasePath: resolve(dataDir, pick(overrides, env, 'databaseName', 'DATABASE_NAME', 'sessions.sqlite')),
    authUsername: pick(overrides, env, 'authUsername', 'AUTH_USERNAME', 'codex'),
    authPasswordHash: pick(overrides, env, 'authPasswordHash', 'AUTH_PASSWORD_HASH', ''),
    authSecret: pick(overrides, env, 'authSecret', 'AUTH_SECRET', ''),
    codexWebUrl: pick(overrides, env, 'codexWebUrl', 'CODEX_WEB_URL', 'https://203.0.113.10:8443'),
    nodeEnv,
    publicDir: resolve(pick(overrides, env, 'publicDir', 'PUBLIC_DIR', resolve(projectRoot, 'public'))),
    cookieSecure: boolFromEnv(
      pick(overrides, env, 'cookieSecure', 'COOKIE_SECURE', undefined),
      nodeEnv === 'production' || !isLocalHttp,
    ),
    sessionTtlMs: Number(pick(overrides, env, 'sessionTtlMs', 'SESSION_TTL_MS', 24 * 60 * 60 * 1000)),
    loginTtlMs: Number(pick(overrides, env, 'loginTtlMs', 'LOGIN_TTL_MS', 10 * 60 * 1000)),
    maxBodyBytes: Number(pick(overrides, env, 'maxBodyBytes', 'MAX_BODY_BYTES', 8 * 1024)),
    monitoringMode: pick(
      overrides,
      env,
      'monitoringMode',
      'MONITORING_MODE',
      nodeEnv === 'production' ? 'live' : 'mock',
    ),
    monitoringRefreshIntervalMs: boundedNumber(
      pick(overrides, env, 'monitoringRefreshIntervalMs', 'MONITORING_REFRESH_INTERVAL_MS', 5000),
      5000,
      1000,
      60_000,
    ),
    monitoringHistoryLimit: boundedNumber(
      pick(overrides, env, 'monitoringHistoryLimit', 'MONITORING_HISTORY_LIMIT', 60),
      60,
      1,
      60,
    ),
    serverId: pick(overrides, env, 'serverId', 'SERVER_ID', 'cloud-01'),
    serverName: pick(overrides, env, 'serverName', 'SERVER_NAME', 'Cloud 01'),
    serverRegion: pick(overrides, env, 'serverRegion', 'SERVER_REGION', '上海 · 阿里云'),
    serverIp: pick(overrides, env, 'serverIp', 'SERVER_IP', '203.0.113.10'),
    nasMonitorSecret: pick(overrides, env, 'nasMonitorSecret', 'NAS_MONITOR_SECRET', ''),
    nasDeviceId: pick(overrides, env, 'nasDeviceId', 'NAS_DEVICE_ID', 'fnos-nas'),
    nasDeviceName: pick(overrides, env, 'nasDeviceName', 'NAS_DEVICE_NAME', 'fnOS NAS'),
    nasDeviceHost: pick(overrides, env, 'nasDeviceHost', 'NAS_DEVICE_HOST', 'nas.local:5666'),
    nasReportIntervalMs: boundedNumber(
      pick(overrides, env, 'nasReportIntervalMs', 'NAS_REPORT_INTERVAL_MS', 15_000),
      15_000,
      5_000,
      60_000,
    ),
    nasStaleAfterMs: boundedNumber(
      pick(overrides, env, 'nasStaleAfterMs', 'NAS_STALE_AFTER_MS', 60_000),
      60_000,
      30_000,
      300_000,
    ),
    nasMaxBodyBytes: boundedNumber(
      pick(overrides, env, 'nasMaxBodyBytes', 'NAS_MAX_BODY_BYTES', 16 * 1024),
      16 * 1024,
      1024,
      64 * 1024,
    ),
    nasMaxClockSkewMs: boundedNumber(
      pick(overrides, env, 'nasMaxClockSkewMs', 'NAS_MAX_CLOCK_SKEW_MS', 120_000),
      120_000,
      10_000,
      10 * 60_000,
    ),
  };
}

export function validateRuntimeConfig(config) {
  const missing = [];
  if (!config.authUsername) missing.push('AUTH_USERNAME');
  if (!config.authPasswordHash) missing.push('AUTH_PASSWORD_HASH');
  if (!config.authSecret || config.authSecret.length < 32) missing.push('AUTH_SECRET(>=32 chars)');
  if (config.nodeEnv === 'production' && config.cookieSecure === false) {
    missing.push('COOKIE_SECURE must not be false in production');
  }
  if (config.nodeEnv === 'production' && !String(config.siteOrigin).startsWith('https://')) {
    missing.push('SITE_ORIGIN must be https:// in production');
  }
  if (config.monitoringMode != null && !['live', 'mock'].includes(config.monitoringMode)) {
    missing.push('MONITORING_MODE must be live or mock');
  }
  if (config.nasMonitorSecret && config.nasMonitorSecret.length < 32) {
    missing.push('NAS_MONITOR_SECRET must be at least 32 characters');
  }
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
}
