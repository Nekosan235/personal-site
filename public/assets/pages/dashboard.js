import { apiRequest } from '../components/api.js?v=1.4.0';
import { element, pageHeading, internalLink, externalLink, safeExternalHref } from '../components/dom.js?v=1.4.0';
import { createMetricPanel, readMetric } from '../components/metric.js?v=1.4.0';
import { createPoller } from '../components/poller.js?v=1.4.0';
import { createWelcomeRotation } from '../components/welcome.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.4.0';
import { renderHomeProjects } from '../components/portfolio-view.js?v=1.5.0';

const intervalMs = 5000;
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function volumeMetrics(data) {
  const volumes = data?.metrics?.disk?.volumes || data?.volumes || data?.metrics?.volumes;
  return Array.isArray(volumes) ? volumes.slice(0, 16) : [];
}

function isRealData(data) { return data?.mode === 'live' || data?.mode === 'push'; }

function staleAfter(data) {
  const reported = data?.refreshIntervalMs;
  return typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? Math.max(intervalMs * 3, Math.min(300_000, reported * 3)) : intervalMs * 3;
}

export function sampleTime(data) {
  const value = Object.hasOwn(data || {}, 'sampledAt') ? data.sampledAt : data?.updatedAt;
  if (typeof value !== 'string') return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time : null;
}

export function dashboardHealth(data, now = Date.now()) {
  if (data?.server?.status === 'waiting' || data?.error?.code === 'waiting_for_report') return 'waiting';
  const sampledAt = sampleTime(data);
  if (!isRealData(data) || !sampledAt) return 'unavailable';
  if (data.stale || now - sampledAt.getTime() > staleAfter(data)) return 'stale';
  const memory = readMetric(data.metrics?.memory);
  const disk = readMetric(data.metrics?.disk);
  const volumes = volumeMetrics(data);
  if (!memory && !disk && !volumes.some((volume) => readMetric(volume?.metrics || volume))) return 'unavailable';
  if (data.error || !memory || !disk || memory.available === null || disk.available === null
    || data.metrics?.disk?.partial || volumes.some((volume) => !readMetric(volume?.metrics || volume))
    || data.server?.status !== 'online') return 'partial';
  return 'healthy';
}

export function formatCpu(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${numberFormat.format(value)}%` : '采样积累中';
}

export function formatUptime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '暂不可用';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return minutes ? `${minutes} 分钟` : '不到 1 分钟';
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function createDeviceView({ now, index }) {
  const notice = element('p', {
    className: 'device-note', text: '正在获取设备数据…',
    attributes: { role: 'status' },
  });
  const headingId = `device-name-${index}`;
  const name = element('h2', { className: 'device-name', text: '设备', attributes: { id: headingId } });
  const kind = element('p', { className: 'eyebrow', text: '设备监控' });
  const status = element('span', { className: 'server-status badge bg-secondary-lt', text: '连接中' });
  const memory = createMetricPanel('内存');
  const disk = createMetricPanel('硬盘');
  const sampledAtLabel = element('span', { text: '最后采样 ' });
  const sampledAtTime = element('time', { text: '尚未取得数据' });
  const refreshHint = element('span', { className: 'refresh-hint', text: '每 5 秒刷新' });
  const failureTime = element('span', { className: 'monitor-failure-time' });
  const cpu = element('span', { text: 'CPU 待获取' });
  const uptime = element('span', { text: '运行时间待获取' });
  const page = element('div', { className: 'device-card card' });
  const metrics = element('div', { className: 'metrics-grid' }, [memory.element, disk.element]);
  const volumeList = element('div', { className: 'device-volumes', attributes: { hidden: '' } });
  const volumes = new Map();
  const serverFacts = element('dl', { className: 'server-facts' });
  const facts = new Map();
  const factLabels = new Map();
  for (const [label, key] of [['位置', 'region'], ['系统', 'os'], ['配置', 'vcpu'], ['IP 地址', 'ip']]) {
    const value = element('dd', { text: '待获取' });
    const title = element('dt', { text: label });
    facts.set(key, value);
    factLabels.set(key, title);
    serverFacts.append(element('div', { className: 'server-fact' }, [
      title, value,
    ]));
  }
  page.append(element('section', { className: 'server-overview', attributes: { 'aria-labelledby': headingId } }, [
    element('div', { className: 'server-heading card-header' }, [
      element('div', { className: 'device-identity' }, [
        element('span', { className: 'device-avatar avatar bg-blue-lt' }, [icon('server', 'icon')]),
        element('div', {}, [kind, name]),
      ]),
      status,
    ]),
    element('div', { className: 'server-content card-body' }, [
      serverFacts,
      element('div', { className: 'server-runtime' }, [cpu, uptime]),
      metrics, volumeList,
    ]),
  ]));
  page.append(element('div', { className: 'device-footer card-footer' }, [
    element('div', { className: 'monitoring-meta' }, [
      element('p', { className: 'updated-at' }, [sampledAtLabel, sampledAtTime]), refreshHint, failureTime,
    ]),
    notice,
  ]));

  let lastSample = null;
  let lastData = null;
  let health = 'connecting';
  let firstFailure = null;
  let paused = false;

  function showHealth() {
    const display = paused ? 'paused' : health;
    const copy = {
      connecting: ['实时监控', '连接中', '正在获取服务器数据…'],
      healthy: ['实时监控', '在线', '每 5 秒自动刷新；页面隐藏时暂停。'],
      waiting: ['等待上报', '等待上报', '尚未收到这台设备的监控上报。'],
      partial: ['数据不完整', '待恢复', '部分数据暂不可用。缺失指标保留上次读数，正在等待恢复。'],
      stale: ['数据已过期', '待恢复', '采样数据已过期。当前保留最后读数，正在等待恢复。'],
      failed: ['连接中断', '连接中断', '监控连接已中断。当前保留最后读数，将自动重试。'],
      unavailable: ['数据不可用', '待恢复', '暂时无法获取实时监控数据，将自动重试。'],
      paused: ['已暂停刷新', '刷新已暂停', '页面不可见，已暂停刷新；返回后立即更新。'],
      mock: ['模拟数据', '示例状态', '当前环境展示示例数据，尚未启用实时监控。'],
    }[display];
    const quiet = ['healthy', 'connecting', 'paused', 'mock', 'waiting'];
    setText(status, copy[1]);
    setText(notice, copy[2]);
    status.classList.toggle('is-online', display === 'healthy');
    status.classList.toggle('bg-green-lt', display === 'healthy');
    status.classList.toggle('bg-yellow-lt', !quiet.includes(display));
    status.classList.toggle('bg-secondary-lt', quiet.includes(display) && display !== 'healthy');
    notice.classList.toggle('is-warning', !quiet.includes(display));
    setText(sampledAtLabel, display === 'mock' ? '示例更新 '
      : ['failed', 'stale', 'partial', 'paused'].includes(display) ? '最后有效采样 ' : '最后采样 ');
    setText(failureTime, firstFailure ? `异常始于 ${timeFormat.format(firstFailure)}` : '');
  }

  function update(data) {
    const simulated = data?.mode === 'mock';
    const nextHealth = simulated ? 'mock' : dashboardHealth(data, now());
    const sampledAt = sampleTime(data);
    const server = data?.server;
    health = nextHealth;
    lastData = data;
    if (health === 'healthy' || health === 'mock' || health === 'waiting') firstFailure = null;
    else if (!firstFailure) firstFailure = new Date(now());
    if (sampledAt && (readMetric(data.metrics?.memory) || readMetric(data.metrics?.disk)
      || volumeMetrics(data).some((volume) => readMetric(volume?.metrics || volume)))) {
      lastSample = sampledAt;
      setText(sampledAtTime, timeFormat.format(sampledAt));
      sampledAtTime.setAttribute('datetime', sampledAt.toISOString());
    }
    if (server) {
      if (typeof server.name === 'string' || typeof data?.name === 'string') setText(name, server.name || data.name);
      const nas = data?.type === 'nas' || data?.kind === 'nas' || server.kind === 'nas';
      setText(factLabels.get('region'), nas ? '设备类型' : '位置');
      setText(factLabels.get('ip'), nas ? '主机地址' : 'IP 地址');
      for (const [key, node] of facts) {
        const value = nas && key === 'region' ? 'NAS' : key === 'ip' ? server.ip || server.host : server[key];
        if (value !== null && value !== undefined) setText(node, key === 'vcpu' ? `${value} vCPU` : String(value));
      }
      const cpuUnavailable = server.cpuError || (isRealData(data) && (!sampledAt || server.status === 'error'));
      setText(cpu, cpuUnavailable ? 'CPU 暂不可用' : `CPU ${formatCpu(server.cpuPercent)}`);
      setText(uptime, formatUptime(server.uptimeSeconds) === '暂不可用'
        ? '运行时间暂不可用' : `已运行 ${formatUptime(server.uptimeSeconds)}`);
    }
    setText(kind, data?.type === 'nas' || data?.kind === 'nas' || server?.kind === 'nas' ? 'NAS · 设备监控' : '云端 · 设备监控');
    const stale = ['stale', 'failed', 'unavailable'].includes(health);
    memory.update(isRealData(data) || simulated ? data.metrics?.memory : null, { stale, sampledAt, simulated });
    disk.update(isRealData(data) || simulated ? data.metrics?.disk : null, { stale, sampledAt, simulated });
    const volumeData = volumeMetrics(data);
    const seen = new Set();
    for (const [position, volume] of volumeData.slice(0, 16).entries()) {
      if (!volume || typeof volume !== 'object') continue;
      const key = String(volume.id || volume.path || `volume-${position}`);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!volumes.has(key)) {
        const label = volume.name || volume.label || volume.path || `存储卷 ${position + 1}`;
        const panel = createMetricPanel(String(label), { showHistory: false });
        volumes.set(key, panel);
        volumeList.append(panel.element);
      }
      volumes.get(key).update(isRealData(data) || simulated ? volume.metrics || volume : null,
        { stale, sampledAt, simulated });
    }
    for (const [key, panel] of volumes) if (!seen.has(key)) panel.update(null, { stale: true });
    const hasVolumes = volumes.size > 0;
    volumeList.toggleAttribute('hidden', !hasVolumes);
    showHealth();
  }

  function fail() {
    health = lastSample ? 'failed' : 'unavailable';
    if (!firstFailure) firstFailure = new Date(now());
    memory.update(null, { stale: true });
    disk.update(null, { stale: true });
    for (const panel of volumes.values()) panel.update(null, { stale: true });
    showHealth();
  }

  function activity(state) {
    paused = state === 'paused';
    if (!paused && lastSample && now() - lastSample.getTime() > staleAfter(lastData) && health === 'healthy') {
      health = 'stale';
      if (!firstFailure) firstFailure = new Date(lastSample.getTime() + staleAfter(lastData));
      memory.update(lastData?.metrics?.memory, { stale: true, sampledAt: lastSample });
      disk.update(lastData?.metrics?.disk, { stale: true, sampledAt: lastSample });
      for (const panel of volumes.values()) panel.update(null, { stale: true });
    }
    setText(refreshHint, state === 'paused' ? '已暂停自动刷新'
      : state === 'fetching' ? '正在刷新 · 每 5 秒' : '每 5 秒刷新');
    showHealth();
  }

  return { element: page, update, fail, activity, get health() { return paused ? 'paused' : health; } };
}

export function createDashboardView({ modules, now = Date.now }) {
  const badge = element('span', { className: 'monitor-badge badge bg-blue-lt', text: '实时监控' });
  const notice = element('p', {
    className: 'data-notice monitoring-notice', text: '正在获取设备数据…',
    attributes: { role: 'status', 'aria-live': 'polite' },
  });
  const heading = pageHeading('欢迎回来', '你的设备与常用工具，都在这里。', badge);
  const title = heading.children[0].children[0];
  const list = element('div', { className: 'device-list', attributes: { 'aria-label': '设备监控' } });
  const page = element('div', { className: 'dashboard-page page-enter' }, [heading, renderHomeProjects(), notice, list]);
  const links = [internalLink('/tools', '查看工具箱', 'btn btn-outline-primary')];
  const codex = modules.find((module) => module.id === 'codex-web');
  const href = codex && safeExternalHref(codex.href);
  if (href) links.push(externalLink(href, '打开 Codex Web', 'btn btn-primary'));
  page.append(element('div', { className: 'dashboard-links' }, links));
  let nextIndex = 1;
  const primary = createDeviceView({ now, index: nextIndex });
  const devices = new Map([['primary', primary]]);
  list.append(primary.element);

  function showSummary() {
    const health = [...devices.values()].map((view) => view.health);
    const all = (state) => health.every((value) => value === state);
    const quiet = ['healthy', 'connecting', 'paused', 'mock', 'waiting'];
    const errors = health.filter((value) => !quiet.includes(value)).length;
    const waiting = health.filter((value) => value === 'waiting').length;
    const [label, message] = all('paused') ? ['已暂停刷新', '页面不可见，已暂停刷新；返回后立即更新。']
      : all('mock') ? ['模拟数据', '当前环境展示示例数据，尚未启用实时监控。']
        : all('connecting') ? ['实时监控', '正在获取设备数据…']
          : errors ? ['设备待恢复', `${errors} 台设备的数据暂不可用或不完整，正在等待恢复。`]
            : waiting ? ['等待上报', `${waiting} 台设备尚未收到监控上报。`]
              : ['实时监控', `${devices.size} 台设备 · 每 5 秒自动刷新；页面隐藏时暂停。`];
    setText(badge, label);
    setText(notice, message);
    badge.classList.toggle('monitor-warning', errors > 0);
    badge.classList.toggle('bg-yellow-lt', errors > 0);
    badge.classList.toggle('bg-blue-lt', errors === 0);
    notice.classList.toggle('monitoring-warning', errors > 0);
  }

  function update(data) {
    const incoming = Array.isArray(data?.devices) ? data.devices : [data];
    if (!incoming.length) { fail(); return; }
    const seen = new Set();
    for (const [position, item] of incoming.slice(0, 16).entries()) {
      if (!item || typeof item !== 'object') continue;
      const key = Array.isArray(data?.devices) ? String(item.id || item.server?.id || `device-${position}`) : 'primary';
      if (seen.has(key)) continue;
      seen.add(key);
      if (!devices.has(key)) {
        if (devices.size === 1 && devices.has('primary')) {
          devices.delete('primary');
          devices.set(key, primary);
        } else {
          const view = createDeviceView({ now, index: ++nextIndex });
          devices.set(key, view);
          list.append(view.element);
        }
      }
      const mode = item.mode || data?.mode;
      devices.get(key).update({ ...item, mode });
    }
    for (const [key, view] of devices) if (!seen.has(key)) view.fail();
    showSummary();
  }

  function fail() {
    for (const view of devices.values()) view.fail();
    showSummary();
  }
  function activity(state) {
    for (const view of devices.values()) view.activity(state);
    showSummary();
  }
  return { element: page, title, update, fail, activity };
}

export function renderDashboard({ modules, signal }) {
  const view = createDashboardView({ modules });
  createWelcomeRotation({ onTitle: (text) => setText(view.title, text), signal });
  const poller = createPoller({
    request: (requestSignal) => apiRequest('/api/dashboard', { signal: requestSignal }),
    onData: view.update, onError: view.fail, onState: view.activity, signal,
    intervalMs, timeoutMs: 8000,
  });
  poller.start();
  return view.element;
}
