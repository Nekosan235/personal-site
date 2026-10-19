import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

const GIB = 1024 ** 3;

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function metricError(code = 'metric_unavailable') {
  return { code, message: 'Live metric is unavailable' };
}

function dashboardError(error, code = 'collection_failed') {
  return { code: error?.code ?? code, message: 'Live monitoring is temporarily unavailable' };
}

function emptyMetric(label, extra = {}) {
  return {
    used: null,
    total: null,
    available: null,
    unit: 'GiB',
    history: [],
    historyLabel: label,
    error: null,
    ...extra,
  };
}

export function normalizeCpuPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = round(value, 1);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

function emptyCpuMetric(error = null) {
  return {
    used: null,
    total: null,
    available: null,
    unit: '%',
    history: [],
    historyLabel: 'cpu percent',
    error,
  };
}

export function bytesToGiB(bytes) {
  return round(bytes / GIB);
}

export function parseMeminfo(content) {
  const values = new Map();
  for (const line of String(content).split('\n')) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]));
  }
  const totalKb = values.get('MemTotal');
  const availableKb = values.get('MemAvailable');
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) {
    throw new Error('/proc/meminfo missing MemTotal or MemAvailable');
  }
  if (totalKb <= 0 || availableKb < 0 || availableKb > totalKb) {
    throw new Error('/proc/meminfo contains invalid memory values');
  }
  const total = totalKb * 1024;
  const available = availableKb * 1024;
  return { total, available, used: Math.max(0, total - available) };
}

export function parseProcStat(content) {
  const line = String(content).split('\n').find((item) => item.startsWith('cpu '));
  if (!line) throw new Error('/proc/stat missing aggregate cpu line');
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 5 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('/proc/stat contains invalid cpu counters');
  }
  const idle = values[3] + (values[4] ?? 0);
  const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

export function calculateCpuPercent(previousCpu, currentCpu) {
  if (!previousCpu) return null;
  const totalDelta = currentCpu.total - previousCpu.total;
  const idleDelta = currentCpu.idle - previousCpu.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return round(Math.min(100, Math.max(0, percent)), 1);
}

export function parseOsRelease(content) {
  const values = new Map();
  for (const line of String(content).split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    values.set(match[1], match[2].replace(/^"|"$/g, '').replace(/\\"/g, '"'));
  }
  return values.get('PRETTY_NAME') || values.get('NAME') || null;
}

export function computeDiskUsage(statfsResult) {
  const blockSize = Number(statfsResult.bsize);
  const blocks = Number(statfsResult.blocks);
  const bfree = Number(statfsResult.bfree);
  const bavail = Number(statfsResult.bavail);
  if (![blockSize, blocks, bfree, bavail].every(Number.isFinite)) {
    throw new Error('statfs returned invalid numeric values');
  }
  if (blockSize <= 0 || blocks <= 0 || bfree < 0 || bavail < 0 || bfree > blocks || bavail > bfree) {
    throw new Error('statfs returned inconsistent filesystem values');
  }
  const totalBytes = blocks * blockSize;
  const freeBytes = bfree * blockSize;
  const availableBytes = bavail * blockSize;
  return {
    used: totalBytes - freeBytes,
    total: totalBytes,
    available: availableBytes,
    reserved: Math.max(0, freeBytes - availableBytes),
  };
}

export async function collectLinuxMetrics({ config, previousCpu = null } = {}) {
  if (process.platform !== 'linux') {
    throw Object.assign(new Error('Live monitoring is available on Linux only'), { code: 'unsupported_platform' });
  }

  const sampledAt = new Date().toISOString();
  const loadAverage = os.loadavg();
  let osName = `${os.type()} ${os.release()}`;
  try {
    osName = parseOsRelease(await readFile('/etc/os-release', 'utf8')) ?? osName;
  } catch {
    // Keep the kernel fallback when distro metadata is unavailable.
  }

  let memory;
  try {
    const parsed = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
    memory = {
      used: bytesToGiB(parsed.used),
      total: bytesToGiB(parsed.total),
      available: bytesToGiB(parsed.available),
      unit: 'GiB',
      error: null,
    };
  } catch (error) {
    memory = emptyMetric('memory used GiB', { error: metricError(error.code) });
  }

  let disk;
  try {
    const root = computeDiskUsage(await statfs('/'));
    disk = {
      used: bytesToGiB(root.used),
      total: bytesToGiB(root.total),
      available: bytesToGiB(root.available),
      reserved: bytesToGiB(root.reserved),
      unit: 'GiB',
      error: null,
    };
  } catch (error) {
    disk = emptyMetric('disk used GiB', {
      reserved: null,
      error: metricError(error.code),
    });
  }

  let cpu = { current: null, percent: null, error: null };
  try {
    const current = parseProcStat(await readFile('/proc/stat', 'utf8'));
    cpu = {
      current,
      percent: calculateCpuPercent(previousCpu, current),
      error: null,
    };
  } catch (error) {
    cpu = { current: previousCpu, percent: null, error: metricError(error.code) };
  }

  return {
    sampledAt,
    server: {
      id: config.serverId,
      name: config.serverName,
      region: config.serverRegion,
      ip: config.serverIp,
      os: osName,
      vcpu: os.cpus().length,
      status: 'online',
      uptimeSeconds: Math.floor(os.uptime()),
      cpuPercent: cpu.percent,
      loadAverage,
      cpuError: cpu.error,
    },
    metrics: { memory, disk },
    cpuState: cpu.current,
  };
}

export class LiveDashboardProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.collector = options.collector ?? collectLinuxMetrics;
    this.refreshIntervalMs = Math.min(60_000, Math.max(1000, Number(options.refreshIntervalMs ?? config.monitoringRefreshIntervalMs ?? 5000) || 5000));
    this.historyLimit = Math.min(60, Math.max(1, Number(options.historyLimit ?? config.monitoringHistoryLimit ?? 60) || 60));
    this.setInterval = options.setInterval ?? globalThis.setInterval;
    this.clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.timer = null;
    this.inFlight = null;
    this.lastDashboard = null;
    this.previousCpu = null;
    this.cpuHistory = [];
    this.memoryHistory = [];
    this.diskHistory = [];
  }

  start() {
    if (this.timer || this.refreshIntervalMs <= 0) return;
    this.sample().catch(() => {});
    this.timer = this.setInterval(() => {
      this.sample().catch(() => {});
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    this.clearInterval(this.timer);
    this.timer = null;
  }

  async getDashboard() {
    if (!this.lastDashboard) return await this.sample();
    return this.lastDashboard;
  }

  async sample() {
    if (this.inFlight) return await this.inFlight;
    this.inFlight = this.collectSample().finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  async collectSample() {
    try {
      const sample = await this.collector({
        config: this.config,
        previousCpu: this.previousCpu,
      });
      if (sample.cpuState) this.previousCpu = sample.cpuState;
      const dashboard = this.buildDashboard(sample);
      this.lastDashboard = dashboard;
      return dashboard;
    } catch (error) {
      const failure = this.buildFailureDashboard(error);
      this.lastDashboard = failure;
      return failure;
    }
  }

  buildDashboard(sample) {
    const cpuPercent = normalizeCpuPercent(sample.server.cpuPercent);
    const cpuError = sample.server.cpuError ?? null;
    const cpu = this.buildCpuMetric(cpuPercent, cpuError);
    const memory = this.buildMetric(sample.metrics.memory, this.memoryHistory, 'memory used GiB');
    const disk = this.buildMetric(sample.metrics.disk, this.diskHistory, 'disk used GiB');
    const hasMetricError = Boolean(memory.error || disk.error || cpuError);
    return {
      mode: 'live',
      sampledAt: sample.sampledAt,
      updatedAt: sample.sampledAt,
      refreshIntervalMs: this.refreshIntervalMs,
      stale: false,
      error: hasMetricError ? dashboardError(new Error('Some live metrics are unavailable'), 'partial_metric_unavailable') : null,
      server: {
        ...sample.server,
        cpuPercent,
        cpuError,
      },
      metrics: { cpu, memory, disk },
    };
  }

  buildCpuMetric(percent, error) {
    if (percent != null && error == null) {
      this.cpuHistory.push(percent);
      while (this.cpuHistory.length > this.historyLimit) this.cpuHistory.shift();
    }
    return {
      used: percent,
      total: percent == null ? null : 100,
      available: percent == null ? null : round(100 - percent, 1),
      unit: '%',
      history: [...this.cpuHistory],
      historyLabel: 'cpu percent',
      error,
    };
  }

  buildMetric(metric, history, label) {
    if (metric.used != null && metric.error == null) {
      history.push(metric.used);
      while (history.length > this.historyLimit) history.shift();
    }
    return {
      ...metric,
      history: [...history],
      historyLabel: label,
      error: metric.error ?? null,
    };
  }

  buildFailureDashboard(error) {
    const now = new Date().toISOString();
    const normalized = dashboardError(error, error?.code ?? 'collection_failed');
    if (this.lastDashboard) {
      return {
        ...this.lastDashboard,
        stale: true,
        error: normalized,
        server: {
          ...this.lastDashboard.server,
          status: 'stale',
        },
      };
    }
    return {
      mode: 'live',
      sampledAt: null,
      updatedAt: now,
      refreshIntervalMs: this.refreshIntervalMs,
      stale: false,
      error: normalized,
      server: {
        id: this.config.serverId,
        name: this.config.serverName,
        region: this.config.serverRegion,
        ip: this.config.serverIp,
        os: null,
        vcpu: null,
        status: 'error',
        uptimeSeconds: null,
        cpuPercent: null,
        loadAverage: null,
      },
      metrics: {
        cpu: emptyCpuMetric(normalized),
        memory: emptyMetric('memory used GiB', { error: normalized }),
        disk: emptyMetric('disk used GiB', { reserved: null, error: normalized }),
      },
    };
  }
}

export function createLiveDashboardProvider(config, options = {}) {
  return new LiveDashboardProvider(config, options);
}
