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

function headerValue(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

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

function sumDisk(volumes) {
  if (!volumes.length) return {
    used: null,
    total: null,
    available: null,
    reserved: null,
    unit: 'GiB',
    error: { code: 'no_volumes', message: 'NAS volume metrics are unavailable' },
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

export class NasMonitorStore {
  constructor(config, options = {}) {
    this.config = config;
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = Math.min(60, Math.max(1, Number(config.monitoringHistoryLimit) || 60));
    this.nonces = new Map();
    this.memoryHistory = [];
    this.diskHistory = [];
    this.lastReport = null;
    this.nonceLimit = options.nonceLimit ?? 2048;
  }

  isEnabled() {
    return Boolean(this.config.nasMonitorSecret);
  }

  verifyHeaders(headers, body) {
    if (!this.isEnabled()) {
      return { ok: false, statusCode: 404, error: 'nas_monitor_disabled' };
    }
    const deviceId = headerValue(headers, 'x-nas-device-id');
    const timestamp = headerValue(headers, 'x-nas-timestamp');
    const nonce = headerValue(headers, 'x-nas-nonce');
    const signature = headerValue(headers, 'x-nas-signature');
    if (!deviceId || !timestamp || !nonce || !signature) {
      return { ok: false, statusCode: 401, error: 'missing_signature_headers' };
    }
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(deviceId)
      || !/^\d{10}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)
      || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
      return { ok: false, statusCode: 401, error: 'malformed_signature_headers' };
    }
    if (deviceId !== this.config.nasDeviceId) {
      return { ok: false, statusCode: 403, error: 'unknown_device' };
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
      secret: this.config.nasMonitorSecret,
      deviceId,
      timestamp,
      nonce,
      body,
    });
    if (!safeEqual(signature, expected)) {
      return { ok: false, statusCode: 401, error: 'bad_signature' };
    }
    this.nonces.set(nonceKey, timestampMs);
    return { ok: true };
  }

  acceptReport(report) {
    this.validateReport(report);
    const normalized = this.normalizeReport(report);
    this.lastReport = normalized;
    this.pushHistory(normalized);
    return normalized;
  }

  validateReport(report) {
    if (!report || typeof report !== 'object') throw reportError('invalid_report');
    const sampledAtMs = Date.parse(report.sampledAt ?? '');
    if (!Number.isFinite(sampledAtMs)) throw reportError('missing_sampled_at');
    if (Math.abs(this.now() - sampledAtMs) > this.config.nasMaxClockSkewMs) {
      throw reportError('stale_sampled_at');
    }
  }

  normalizeReport(report) {
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
      : sumDisk(volumes);
    const diskPartial = Boolean(report?.metrics?.disk?.partial || disk.partial || missingVolumes.length > 0);
    const diskError = disk.error ?? (diskPartial ? { code: 'partial_volumes', message: 'Some NAS volume metrics are unavailable' } : null);
    return {
      deviceId: this.config.nasDeviceId,
      sampledAt: new Date(sampledAtMs).toISOString(),
      updatedAt,
      server: {
        id: this.config.nasDeviceId,
        name: typeof report?.server?.name === 'string' ? report.server.name : this.config.nasDeviceName,
        host: this.config.nasDeviceHost,
        os: typeof report?.server?.os === 'string' ? report.server.os : null,
        vcpu: nullableNumber(report?.server?.vcpu),
        status: 'online',
        uptimeSeconds: nullableNumber(report?.server?.uptimeSeconds) == null ? null : Math.floor(nullableNumber(report.server.uptimeSeconds)),
        cpuPercent: nullableNumber(report?.server?.cpuPercent) == null ? null : round(nullableNumber(report.server.cpuPercent), 1),
        loadAverage: normalizeLoadAverage(report?.server?.loadAverage),
      },
      metrics: {
        memory: normalizeMetric(report?.metrics?.memory) ?? {
          used: null,
          total: null,
          available: null,
          unit: 'GiB',
          error: { code: 'memory_unavailable', message: 'NAS memory metrics are unavailable' },
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

  pushHistory(report) {
    if (report.metrics.memory.used != null && report.metrics.memory.error == null) {
      this.memoryHistory.push(report.metrics.memory.used);
      while (this.memoryHistory.length > this.historyLimit) this.memoryHistory.shift();
    }
    if (report.metrics.disk.used != null && report.metrics.disk.error == null) {
      this.diskHistory.push(report.metrics.disk.used);
      while (this.diskHistory.length > this.historyLimit) this.diskHistory.shift();
    }
  }

  getDashboard() {
    if (!this.lastReport) return this.waitingDashboard();
    const ageMs = this.now() - Date.parse(this.lastReport.updatedAt);
    const stale = ageMs > this.config.nasStaleAfterMs;
    return {
      id: this.config.nasDeviceId,
      name: this.lastReport.server.name,
      type: 'nas',
      mode: 'push',
      sampledAt: this.lastReport.sampledAt,
      updatedAt: this.lastReport.updatedAt,
      refreshIntervalMs: this.config.nasReportIntervalMs,
      stale,
      error: stale ? { code: 'stale_report', message: 'NAS monitor data is stale' } : null,
      server: {
        ...this.lastReport.server,
        status: stale ? 'offline' : 'online',
      },
      metrics: {
        memory: metricWithHistory(this.lastReport.metrics.memory, this.memoryHistory, 'memory used GiB'),
        disk: {
          ...metricWithHistory(this.lastReport.metrics.disk, this.diskHistory, 'disk used GiB'),
          volumes: this.lastReport.metrics.disk.volumes,
          partial: Boolean(this.lastReport.metrics.disk.partial),
          missingVolumes: this.lastReport.metrics.disk.missingVolumes ?? [],
        },
      },
    };
  }

  waitingDashboard() {
    return {
      id: this.config.nasDeviceId,
      name: this.config.nasDeviceName,
      type: 'nas',
      mode: 'push',
      sampledAt: null,
      updatedAt: null,
      refreshIntervalMs: this.config.nasReportIntervalMs,
      stale: false,
      error: { code: 'waiting_for_report', message: 'Waiting for NAS monitor report' },
      server: {
        id: this.config.nasDeviceId,
        name: this.config.nasDeviceName,
        host: this.config.nasDeviceHost,
        os: null,
        vcpu: null,
        status: 'waiting',
        uptimeSeconds: null,
        cpuPercent: null,
        loadAverage: null,
      },
      metrics: {
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
