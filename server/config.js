import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSshTargets, validateSshTargets } from './terminal/targets.js';

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

function textValue(overrides, env, lower, upper) {
  const value = overrides[lower] ?? overrides[upper] ?? env[upper];
  return typeof value === 'string' ? value.trim() : '';
}

function configuredUrl(overrides, env, lower, upper, fallback) {
  const value = pick(overrides, env, lower, upper, fallback);
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

const REMOTE_CLOUD_SLOTS = 8;

function validCalendarDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function shanghaiCalendarDate(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  const text = `${map.year}-${map.month}-${map.day}`;
  return validCalendarDate(text) ? text : null;
}

export function normalizeExpiresAt(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return validCalendarDate(text) ? text : null;
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text}+08:00` : text;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(zoned)) return null;
  const time = Date.parse(zoned);
  if (!Number.isFinite(time)) return null;
  return shanghaiCalendarDate(time);
}

function loadRemoteDevices(overrides, env, nas) {
  if (Array.isArray(overrides.remoteDevices) && overrides.remoteDevices.length > 0) {
    return overrides.remoteDevices;
  }
  const sharedSecret = textValue(overrides, env, 'remoteCloudMonitorSecret', 'REMOTE_CLOUD_MONITOR_SECRET');
  const devices = [{
    id: nas.id,
    type: 'nas',
    name: nas.name,
    region: null,
    host: nas.host,
    ip: null,
    secret: nas.secret,
    expiresAt: normalizeExpiresAt(nas.expiresAt),
  }];
  for (let index = 1; index <= REMOTE_CLOUD_SLOTS; index += 1) {
    const id = textValue(overrides, env, `remoteCloud${index}Id`, `REMOTE_CLOUD_${index}_ID`);
    if (!id) continue;
    const name = textValue(overrides, env, `remoteCloud${index}Name`, `REMOTE_CLOUD_${index}_NAME`);
    const region = textValue(overrides, env, `remoteCloud${index}Region`, `REMOTE_CLOUD_${index}_REGION`);
    const ip = textValue(overrides, env, `remoteCloud${index}Ip`, `REMOTE_CLOUD_${index}_IP`);
    const secret = textValue(overrides, env, `remoteCloud${index}Secret`, `REMOTE_CLOUD_${index}_SECRET`) || sharedSecret;
    devices.push({
      id,
      type: 'cloud',
      name: name || id,
      region: region || null,
      host: ip || null,
      ip: ip || null,
      secret,
      expiresAt: normalizeExpiresAt(textValue(
        overrides,
        env,
        `remoteCloud${index}ExpiresAt`,
        `REMOTE_CLOUD_${index}_EXPIRES_AT`,
      )),
    });
  }
  return devices;
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
    xhsApiUrl: configuredUrl(overrides, env, 'xhsApiUrl', 'XHS_API_URL', 'http://127.0.0.1:5556'),
    douyinApiUrl: configuredUrl(overrides, env, 'douyinApiUrl', 'DOUYIN_API_URL', 'http://127.0.0.1:5555'),
    xhsApiToken: textValue(overrides, env, 'xhsApiToken', 'XHS_API_TOKEN'),
    xhsApiTokenFile: textValue(overrides, env, 'xhsApiTokenFile', 'XHS_API_TOKEN_FILE'),
    douyinApiToken: textValue(overrides, env, 'douyinApiToken', 'DOUYIN_API_TOKEN'),
    douyinCookie: textValue(overrides, env, 'douyinCookie', 'DOUYIN_COOKIE'),
    mediaParseTimeoutMs: boundedNumber(
      pick(overrides, env, 'mediaParseTimeoutMs', 'MEDIA_PARSE_TIMEOUT_MS', 25_000),
      25_000,
      3_000,
      60_000,
    ),
    mediaProbeTimeoutMs: boundedNumber(
      pick(overrides, env, 'mediaProbeTimeoutMs', 'MEDIA_PROBE_TIMEOUT_MS', 4_000),
      4_000,
      500,
      15_000,
    ),
    mediaProxyTtlMs: boundedNumber(
      pick(overrides, env, 'mediaProxyTtlMs', 'MEDIA_PROXY_TTL_MS', 15 * 60 * 1000),
      15 * 60 * 1000,
      60 * 1000,
      60 * 60 * 1000,
    ),
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
    serverExpiresAt: normalizeExpiresAt(textValue(overrides, env, 'serverExpiresAt', 'SERVER_EXPIRES_AT')),
    nasMonitorSecret: pick(overrides, env, 'nasMonitorSecret', 'NAS_MONITOR_SECRET', ''),
    nasDeviceExpiresAt: normalizeExpiresAt(textValue(overrides, env, 'nasDeviceExpiresAt', 'NAS_DEVICE_EXPIRES_AT')),
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
    remoteDevices: loadRemoteDevices(overrides, env, {
      id: pick(overrides, env, 'nasDeviceId', 'NAS_DEVICE_ID', 'fnos-nas'),
      name: pick(overrides, env, 'nasDeviceName', 'NAS_DEVICE_NAME', 'fnOS NAS'),
      host: pick(overrides, env, 'nasDeviceHost', 'NAS_DEVICE_HOST', 'nas.local:5666'),
      secret: pick(overrides, env, 'nasMonitorSecret', 'NAS_MONITOR_SECRET', ''),
      expiresAt: textValue(overrides, env, 'nasDeviceExpiresAt', 'NAS_DEVICE_EXPIRES_AT'),
    }),
    sshIdleTimeoutMs: boundedNumber(
      pick(overrides, env, 'sshIdleTimeoutMs', 'SSH_IDLE_TIMEOUT_MS', 10 * 60 * 1000),
      10 * 60 * 1000,
      5_000,
      24 * 60 * 60 * 1000,
    ),
    sshMaxSessions: boundedNumber(
      pick(overrides, env, 'sshMaxSessions', 'SSH_MAX_SESSIONS', 4),
      4,
      1,
      8,
    ),
    sshMaxSessionBytes: boundedNumber(
      pick(overrides, env, 'sshMaxSessionBytes', 'SSH_MAX_SESSION_BYTES', 32 * 1024 * 1024),
      32 * 1024 * 1024,
      64 * 1024,
      128 * 1024 * 1024,
    ),
    sshReadyTimeoutMs: boundedNumber(
      pick(overrides, env, 'sshReadyTimeoutMs', 'SSH_READY_TIMEOUT_MS', 15_000),
      15_000,
      1_000,
      60_000,
    ),
    sshMaxSessionMs: boundedNumber(
      pick(overrides, env, 'sshMaxSessionMs', 'SSH_MAX_SESSION_MS', 4 * 60 * 60 * 1000),
      4 * 60 * 60 * 1000,
      60_000,
      24 * 60 * 60 * 1000,
    ),
    sshTargets: loadSshTargets(overrides, env, [
      {
        id: pick(overrides, env, 'serverId', 'SERVER_ID', 'cloud-01'),
        type: 'cloud',
        name: pick(overrides, env, 'serverName', 'SERVER_NAME', 'Cloud 01'),
        region: pick(overrides, env, 'serverRegion', 'SERVER_REGION', '上海 · 阿里云'),
        host: pick(overrides, env, 'serverIp', 'SERVER_IP', '203.0.113.10'),
        ip: pick(overrides, env, 'serverIp', 'SERVER_IP', '203.0.113.10'),
      },
      ...loadRemoteDevices(overrides, env, {
        id: pick(overrides, env, 'nasDeviceId', 'NAS_DEVICE_ID', 'fnos-nas'),
        name: pick(overrides, env, 'nasDeviceName', 'NAS_DEVICE_NAME', 'fnOS NAS'),
        host: pick(overrides, env, 'nasDeviceHost', 'NAS_DEVICE_HOST', 'nas.local:5666'),
        secret: pick(overrides, env, 'nasMonitorSecret', 'NAS_MONITOR_SECRET', ''),
        expiresAt: textValue(overrides, env, 'nasDeviceExpiresAt', 'NAS_DEVICE_EXPIRES_AT'),
      }),
    ]),
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
  if (config.xhsApiUrl && !isLoopbackHttpUrl(config.xhsApiUrl)) {
    missing.push('XHS_API_URL must be a loopback http(s) URL');
  }
  if (config.douyinApiUrl && !isLoopbackHttpUrl(config.douyinApiUrl)) {
    missing.push('DOUYIN_API_URL must be a loopback http(s) URL');
  }
  if (config.nasMonitorSecret && config.nasMonitorSecret.length < 32) {
    missing.push('NAS_MONITOR_SECRET must be at least 32 characters');
  }
  if (Array.isArray(config.remoteDevices)) {
    const seen = new Set();
    for (const device of config.remoteDevices) {
      if (!device || typeof device.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(device.id)) {
        missing.push('remote device id must match [A-Za-z0-9_.:-]{1,64}');
        continue;
      }
      if (seen.has(device.id)) missing.push(`duplicate remote device id ${device.id}`);
      seen.add(device.id);
      if (device.type !== 'nas' && device.secret && device.secret.length < 32) {
        missing.push(`REMOTE_CLOUD secret for ${device.id} must be at least 32 characters`);
      }
    }
  }
  missing.push(...validateSshTargets(config.sshTargets));
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
}
