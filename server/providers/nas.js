import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reportError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createNasSignature({ secret, deviceId, timestamp, nonce, body }) {
  const digest = sha256(Buffer.isBuffer(body) ? body : Buffer.from(body));
  return `sha256=${createHmac('sha256', secret)
    .update(`${deviceId}.${timestamp}.${nonce}.${digest}`)
    .digest('hex')}`;
}

function metricWithHistory(metric, history, label) {
  const used = metric?.used ?? null;
  return {
    used,
    total: metric?.total ?? null,
    available: metric?.available ?? null,
    reserved: metric?.reserved ?? null,
    unit: metric?.unit ?? 'GiB',
    history: [...history],
    historyLabel: label,
    error: metric?.error ?? null,
  };
}

function normalizeCpuPercent(value) {
  const parsed = nullableNumber(value);
  if (parsed == null) return null;
  const rounded = round(parsed, 1);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

function cpuWithHistory(percent, history) {
  const valid = typeof percent === 'number' && percent >= 0 && percent <= 100;
  return {
    used: valid ? percent : null,
    total: valid ? 100 : null,
    available: valid ? round(Math.max(0, 100 - percent), 1) : null,
    unit: '%',
    history: [...history],
    historyLabel: 'cpu percent',
    error: null,
  };
}

function emptyCpuMetric() {
  return cpuWithHistory(null, []);
}

function normalizeLoadAverage(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 3).map((item) => round(Number(item), 2));
}

function normalizeMetric(value) {
  if (!value || typeof value !== 'object') return null;
  const usedRaw = nullableNumber(value.used);
  const totalRaw = nullableNumber(value.total);
  const availableRaw = nullableNumber(value.available);
  const reservedRaw = nullableNumber(value.reserved);
  if (usedRaw == null && totalRaw == null && availableRaw == null && reservedRaw == null) return null;
  if ([usedRaw, totalRaw, availableRaw, reservedRaw].some((item) => item != null && item < 0)) return null;
  if (totalRaw != null) {
    if (usedRaw != null && usedRaw > totalRaw) return null;
    if (availableRaw != null && availableRaw > totalRaw) return null;
  }
  return {
    used: round(usedRaw),
    total: round(totalRaw),
    available: round(availableRaw),
    reserved: round(reservedRaw),
    unit: value.unit === 'GiB' ? 'GiB' : 'GiB',
    error: value.error ?? null,
    partial: Boolean(value.partial),
  };
}

function headerValue(headers, names) {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

const DEVICE_ID_HEADERS = ['x-monitor-device-id', 'x-nas-device-id'];
const TIMESTAMP_HEADERS = ['x-monitor-timestamp', 'x-nas-timestamp'];
const NONCE_HEADERS = ['x-monitor-nonce', 'x-nas-nonce'];
const SIGNATURE_HEADERS = ['x-monitor-signature', 'x-nas-signature'];

function normalizeVolume(value) {
  if (!value || typeof value !== 'object') return null;
  const path = typeof value.path === 'string' ? value.path : null;
  if (!path) return null;
  const metric = normalizeMetric(value);
  if (!metric || metric.used == null || metric.total == null || metric.available == null) return null;
  return {
    path,
    device: typeof value.device === 'string' ? value.device : null,
    ...metric,
  };
}

function sumDisk(volumes, type = 'nas') {
  if (!volumes.length) return {
    used: null,
    total: null,
    available: null,
    reserved: null,
    unit: 'GiB',
    error: {
      code: 'no_volumes',
      message: type === 'nas' ? 'NAS volume metrics are unavailable' : 'Disk metrics are unavailable',
    },
  };
  const totals = volumes.reduce((acc, volume) => {
    acc.used += volume.used ?? 0;
    acc.total += volume.total ?? 0;
    acc.available += volume.available ?? 0;
    acc.reserved += volume.reserved ?? 0;
    return acc;
  }, { used: 0, total: 0, available: 0, reserved: 0 });
  return {
    used: round(totals.used),
    total: round(totals.total),
    available: round(totals.available),
    reserved: round(totals.reserved),
    unit: 'GiB',
    error: null,
  };
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export class NasMonitorStore {
  constructor(config, options = {}) {
    this.config = config;
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = Math.min(60, Math.max(1, Number(config.monitoringHistoryLimit) || 60));
    this.nonces = new Map();
    this.nonceLimit = options.nonceLimit ?? 2048;
    this.devices = new Map();
    this.deviceOrder = [];
    const configured = Array.isArray(config.remoteDevices) && config.remoteDevices.length
      ? config.remoteDevices
      : [{
        id: config.nasDeviceId,
        type: 'nas',
        name: config.nasDeviceName,
        region: null,
        host: config.nasDeviceHost,
        ip: null,
        secret: config.nasMonitorSecret,
      }];
    for (const device of configured) {
      if (!device?.id || this.devices.has(device.id)) continue;
      this.devices.set(device.id, {
        meta: device,
        cpuHistory: [],
        memoryHistory: [],
        diskHistory: [],
        lastReport: null,
      });
      this.deviceOrder.push(device.id);
    }
  }

  isEnabled() {
    for (const state of this.devices.values()) {
      if (state.meta.secret) return true;
    }
    return Boolean(this.config.nasMonitorSecret);
  }

  verifyHeaders(headers, body) {
    if (!this.isEnabled()) {
      return { ok: false, statusCode: 404, error: 'nas_monitor_disabled' };
    }
    const deviceId = headerValue(headers, DEVICE_ID_HEADERS);
    const timestamp = headerValue(headers, TIMESTAMP_HEADERS);
    const nonce = headerValue(headers, NONCE_HEADERS);
    const signature = headerValue(headers, SIGNATURE_HEADERS);
    if (!deviceId || !timestamp || !nonce || !signature) {
      return { ok: false, statusCode: 401, error: 'missing_signature_headers' };
    }
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(deviceId)
      || !/^\d{10}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)
      || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
      return { ok: false, statusCode: 401, error: 'malformed_signature_headers' };
    }
    const state = this.devices.get(deviceId);
    if (!state) {
      return { ok: false, statusCode: 403, error: 'unknown_device' };
    }
    if (!state.meta.secret) {
      return {
        ok: false,
        statusCode: 404,
        error: state.meta.type === 'nas' ? 'nas_monitor_disabled' : 'remote_monitor_disabled',
      };
    }
    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > this.config.nasMaxClockSkewMs) {
      return { ok: false, statusCode: 401, error: 'stale_signature' };
    }
    this.pruneNonces();
    const nonceKey = `${deviceId}.${nonce}`;
    if (this.nonces.has(nonceKey)) {
      return { ok: false, statusCode: 401, error: 'replayed_nonce' };
    }
    if (this.nonces.size >= this.nonceLimit) {
      return { ok: false, statusCode: 429, error: 'nonce_store_full' };
    }
    const expected = createNasSignature({
      secret: state.meta.secret,
      deviceId,
      timestamp,
      nonce,
      body,
    });
    if (!safeEqual(signature, expected)) {
      return { ok: false, statusCode: 401, error: 'bad_signature' };
    }
    this.nonces.set(nonceKey, timestampMs);
    return { ok: true, deviceId };
  }

  acceptReport(report, deviceId = this.config.nasDeviceId) {
    const state = this.devices.get(deviceId);
    if (!state) throw reportError('unknown_device', 403);
    this.validateReport(report, deviceId);
    const normalized = this.normalizeReport(report, state.meta);
    state.lastReport = normalized;
    this.pushHistory(state, normalized);
    return normalized;
  }

  validateReport(report, deviceId) {
    if (!report || typeof report !== 'object') throw reportError('invalid_report');
    if (typeof report.deviceId === 'string' && report.deviceId !== deviceId) {
      throw reportError('device_mismatch', 403);
    }
    const sampledAtMs = Date.parse(report.sampledAt ?? '');
    if (!Number.isFinite(sampledAtMs)) throw reportError('missing_sampled_at');
    if (Math.abs(this.now() - sampledAtMs) > this.config.nasMaxClockSkewMs) {
      throw reportError('stale_sampled_at');
    }
  }

  normalizeReport(report, meta) {
    const sampledAtMs = Date.parse(report?.sampledAt ?? '');
    const updatedAt = new Date(this.now()).toISOString();
    const volumes = [];
    const missingVolumes = Array.isArray(report?.metrics?.disk?.missingVolumes)
      ? [...report.metrics.disk.missingVolumes]
      : [];
    if (Array.isArray(report?.metrics?.disk?.volumes)) {
      for (const rawVolume of report.metrics.disk.volumes) {
        const normalized = normalizeVolume(rawVolume);
        if (normalized) {
          volumes.push(normalized);
          continue;
        }
        missingVolumes.push({
          path: typeof rawVolume?.path === 'string' ? rawVolume.path : null,
          error: 'invalid_volume_metric',
        });
      }
    }
    const reportedDisk = normalizeMetric(report?.metrics?.disk);
    const disk = reportedDisk && (reportedDisk.used != null || reportedDisk.total != null)
      ? reportedDisk
      : sumDisk(volumes, meta.type);
    const diskPartial = Boolean(report?.metrics?.disk?.partial || disk.partial || missingVolumes.length > 0);
    const partialMessage = meta.type === 'nas'
      ? 'Some NAS volume metrics are unavailable'
      : 'Some disk metrics are unavailable';
    const diskError = disk.error ?? (diskPartial ? { code: 'partial_volumes', message: partialMessage } : null);
    const memoryFallback = meta.type === 'nas'
      ? 'NAS memory metrics are unavailable'
      : 'Cloud memory metrics are unavailable';
    const reportedName = textOrNull(report?.server?.name);
    return {
      deviceId: meta.id,
      sampledAt: new Date(sampledAtMs).toISOString(),
      updatedAt,
      server: {
        id: meta.id,
        name: meta.type === 'cloud' ? (meta.name || reportedName || meta.id) : (reportedName || meta.name),
        host: meta.type === 'nas' ? meta.host : (meta.host || meta.ip || textOrNull(report?.server?.host)),
        ip: meta.type === 'cloud' ? (meta.ip || textOrNull(report?.server?.ip)) : null,
        region: meta.type === 'cloud' ? (meta.region || textOrNull(report?.server?.region)) : null,
        os: typeof report?.server?.os === 'string' ? report.server.os : null,
        vcpu: nullableNumber(report?.server?.vcpu),
        status: 'online',
        uptimeSeconds: nullableNumber(report?.server?.uptimeSeconds) == null ? null : Math.floor(nullableNumber(report.server.uptimeSeconds)),
        cpuPercent: normalizeCpuPercent(report?.server?.cpuPercent),
        loadAverage: normalizeLoadAverage(report?.server?.loadAverage),
      },
      metrics: {
        memory: normalizeMetric(report?.metrics?.memory) ?? {
          used: null,
          total: null,
          available: null,
          unit: 'GiB',
          error: { code: 'memory_unavailable', message: memoryFallback },
        },
        disk: {
          ...disk,
          volumes,
          partial: diskPartial,
          missingVolumes,
          error: diskError,
        },
      },
    };
  }

  pushHistory(state, report) {
    const cpu = report.server.cpuPercent;
    if (typeof cpu === 'number' && cpu >= 0 && cpu <= 100) {
      state.cpuHistory.push(cpu);
      while (state.cpuHistory.length > this.historyLimit) state.cpuHistory.shift();
    }
    if (report.metrics.memory.used != null && report.metrics.memory.error == null) {
      state.memoryHistory.push(report.metrics.memory.used);
      while (state.memoryHistory.length > this.historyLimit) state.memoryHistory.shift();
    }
    if (report.metrics.disk.used != null && report.metrics.disk.error == null) {
      state.diskHistory.push(report.metrics.disk.used);
      while (state.diskHistory.length > this.historyLimit) state.diskHistory.shift();
    }
  }

  getDashboard() {
    return this.dashboardFor(this.devices.get(this.config.nasDeviceId) ?? this.devices.get(this.deviceOrder[0]));
  }

  getDashboards() {
    return this.deviceOrder.map((id) => this.dashboardFor(this.devices.get(id)));
  }

  dashboardFor(state) {
    if (!state?.lastReport) return this.waitingDashboard(state?.meta);
    const meta = state.meta;
    const ageMs = this.now() - Date.parse(state.lastReport.updatedAt);
    const stale = ageMs > this.config.nasStaleAfterMs;
    const staleMessage = meta.type === 'nas' ? 'NAS monitor data is stale' : 'Cloud monitor data is stale';
    return {
      id: meta.id,
      name: state.lastReport.server.name,
      type: meta.type === 'cloud' ? 'cloud' : 'nas',
      mode: 'push',
      sampledAt: state.lastReport.sampledAt,
      updatedAt: state.lastReport.updatedAt,
      refreshIntervalMs: this.config.nasReportIntervalMs,
      stale,
      error: stale ? { code: 'stale_report', message: staleMessage } : null,
      server: {
        ...state.lastReport.server,
        status: stale ? 'offline' : 'online',
      },
      metrics: {
        cpu: cpuWithHistory(state.lastReport.server.cpuPercent, state.cpuHistory),
        memory: metricWithHistory(state.lastReport.metrics.memory, state.memoryHistory, 'memory used GiB'),
        disk: {
          ...metricWithHistory(state.lastReport.metrics.disk, state.diskHistory, 'disk used GiB'),
          volumes: state.lastReport.metrics.disk.volumes,
          partial: Boolean(state.lastReport.metrics.disk.partial),
          missingVolumes: state.lastReport.metrics.disk.missingVolumes ?? [],
        },
      },
    };
  }

  waitingDashboard(meta = null) {
    const device = meta ?? {
      id: this.config.nasDeviceId,
      type: 'nas',
      name: this.config.nasDeviceName,
      host: this.config.nasDeviceHost,
      region: null,
      ip: null,
    };
    const type = device.type === 'cloud' ? 'cloud' : 'nas';
    const waitingMessage = type === 'nas' ? 'Waiting for NAS monitor report' : 'Waiting for cloud monitor report';
    return {
      id: device.id,
      name: device.name,
      type,
      mode: 'push',
      sampledAt: null,
      updatedAt: null,
      refreshIntervalMs: this.config.nasReportIntervalMs,
      stale: false,
      error: { code: 'waiting_for_report', message: waitingMessage },
      server: {
        id: device.id,
        name: device.name,
        host: device.host ?? device.ip ?? null,
        ip: type === 'cloud' ? (device.ip ?? null) : null,
        region: type === 'cloud' ? (device.region ?? null) : null,
        os: null,
        vcpu: null,
        status: 'waiting',
        uptimeSeconds: null,
        cpuPercent: null,
        loadAverage: null,
      },
      metrics: {
        cpu: emptyCpuMetric(),
        memory: {
          used: null,
          total: null,
          available: null,
          reserved: null,
          unit: 'GiB',
          history: [],
          historyLabel: 'memory used GiB',
          error: null,
        },
        disk: {
          used: null,
          total: null,
          available: null,
          reserved: null,
          unit: 'GiB',
          history: [],
          historyLabel: 'disk used GiB',
          volumes: [],
          error: null,
        },
      },
    };
  }

  pruneNonces() {
    const oldest = this.now() - this.config.nasMaxClockSkewMs;
    for (const [nonce, timestamp] of this.nonces) {
      if (timestamp < oldest) this.nonces.delete(nonce);
    }
  }
}

export function cloudDashboardDevice(dashboard, config) {
  return {
    id: 'liveCloud',
    name: dashboard.server?.name ?? config.serverName,
    type: 'cloud',
    mode: dashboard.mode,
    sampledAt: dashboard.sampledAt ?? dashboard.updatedAt ?? null,
    updatedAt: dashboard.updatedAt ?? null,
    refreshIntervalMs: dashboard.refreshIntervalMs ?? config.monitoringRefreshIntervalMs,
    stale: Boolean(dashboard.stale),
    error: dashboard.error ?? null,
    server: dashboard.server,
    metrics: dashboard.metrics,
  };
}
