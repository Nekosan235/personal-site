import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller, PollTimeoutError } from '../public/assets/components/poller.js';
import { readMetric, createMetricPanel, metricViewKey, readMetricView, setMetricViewMode } from '../public/assets/components/metric.js';
import { createDashboardView, dashboardHealth, sampleTime, formatCpu } from '../public/assets/pages/dashboard.js';

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

class Clock {
  time = 0;
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimer = (id) => this.timers.delete(id);
  async advance(milliseconds) {
    const target = this.time + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

class Visibility {
  visibilityState = 'visible';
  listeners = new Set();
  addEventListener(_type, callback) { this.listeners.add(callback); }
  removeEventListener(_type, callback) { this.listeners.delete(callback); }
  change(state) {
    this.visibilityState = state;
    for (const callback of this.listeners) callback();
  }
}

function harness(options = {}) {
  const clock = new Clock();
  const visibility = new Visibility();
  const route = new AbortController();
  const poller = createPoller({
    onData() {}, onError() {}, request: async () => ({}),
    ...options, signal: route.signal, visibility,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
  });
  return { clock, visibility, route, poller };
}

test('polling waits five seconds, pauses while hidden, resumes immediately, and cleans up on route abort', async () => {
  let requests = 0;
  const { clock, visibility, route, poller } = harness({ request: async () => { requests += 1; return {}; } });
  poller.start();
  await settle();
  assert.equal(requests, 1);
  await clock.advance(4999);
  assert.equal(requests, 1);
  await clock.advance(1);
  assert.equal(requests, 2);
  visibility.change('hidden');
  await clock.advance(20_000);
  assert.equal(requests, 2);
  visibility.change('visible');
  await settle();
  assert.equal(requests, 3);
  route.abort();
  await settle();
  assert.equal(clock.timers.size, 0);
  assert.equal(visibility.listeners.size, 0);
  await clock.advance(20_000);
  assert.equal(requests, 3);
});

test('refresh requests do not overlap an in-flight request', async () => {
  let requests = 0;
  let finish;
  const { clock, route, poller } = harness({ request: () => {
    requests += 1;
    return new Promise((resolve) => { finish = resolve; });
  } });
  poller.start();
  await settle();
  poller.refresh();
  poller.refresh();
  await clock.advance(5000);
  assert.equal(requests, 1);
  finish({});
  await settle();
  await clock.advance(0);
  assert.equal(requests, 2);
  route.abort();
  await settle();
  assert.equal(clock.timers.size, 0);
});

test('a hanging request is aborted after eight seconds, reported, and retried', async () => {
  const signals = [];
  const errors = [];
  const { clock, route, poller } = harness({
    request: (signal) => { signals.push(signal); return new Promise(() => {}); },
    onError: (error) => errors.push(error),
  });
  poller.start();
  await settle();
  await clock.advance(8000);
  assert.equal(signals[0].aborted, true);
  assert.ok(errors[0] instanceof PollTimeoutError);
  assert.equal(signals.length, 2);
  route.abort();
  await settle();
  assert.equal(clock.timers.size, 0);
});

test('hidden in-flight responses are discarded and a 401 stops all retries', async () => {
  let finish;
  let received = 0;
  const hidden = harness({
    request: () => new Promise((resolve) => { finish = resolve; }),
    onData: () => { received += 1; },
  });
  hidden.poller.start();
  await settle();
  hidden.visibility.change('hidden');
  finish({});
  await settle();
  assert.equal(received, 0);
  assert.equal(hidden.clock.timers.size, 0);
  hidden.route.abort();
  const unauthorized = harness({ request: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); } });
  unauthorized.poller.start();
  await settle();
  assert.equal(unauthorized.clock.timers.size, 0);
  assert.equal(unauthorized.visibility.listeners.size, 0);
});

test('availability and reserved space come from the collector, with no false zero for null values', () => {
  const disk = readMetric({ used: 8, total: 40, available: 30, reserved: 1.99, history: [8], unit: 'GiB' });
  assert.equal(disk.available, 30);
  assert.equal(disk.capacityDifference, 1.99);
  assert.equal(readMetric({ used: 0.58, total: 1.71, available: 1.12 }).capacityDifference, 0);
  assert.equal(readMetric({ used: null, total: null, available: null }), null);
  assert.equal(readMetric({ used: 8, total: 40, error: { code: 'unavailable' } }), null);
  assert.equal(readMetric({ used: 8, total: 40 }).available, null);
  assert.deepEqual(readMetric({ used: 20, total: 100, available: 80, unit: '%', history: [10, 140, 20, -1] }).history, [10, 20]);
  assert.equal(formatCpu(null), '采样积累中');
  assert.equal(formatCpu(0), '0%');
});

const baseTime = Date.parse('2026-10-06T04:00:00.000Z');
const sample = () => ({
  mode: 'live', sampledAt: new Date(baseTime).toISOString(), updatedAt: new Date(baseTime).toISOString(),
  stale: false, error: null, server: { name: 'Cloud 01', status: 'online', cpuPercent: null, uptimeSeconds: 3600 },
  metrics: {
    memory: { used: 0.7, total: 2, available: 1.3, history: [0.7] },
    disk: { used: 8, total: 40, available: 30, reserved: 2, history: [8] },
  },
});

test('first failure timestamps and stale or partial payloads cannot be marked healthy', () => {
  assert.equal(dashboardHealth(sample(), baseTime), 'healthy');
  assert.equal(dashboardHealth(sample(), baseTime + 16_000), 'stale');
  assert.equal(dashboardHealth({ ...sample(), stale: true }, baseTime), 'stale');
  assert.equal(dashboardHealth({ ...sample(), error: { code: 'partial' } }, baseTime), 'partial');
  assert.equal(dashboardHealth({
    ...sample(), mode: 'push', sampledAt: null, server: { ...sample().server, status: 'waiting' },
    error: { code: 'waiting_for_report' },
  }, baseTime), 'waiting');
  assert.equal(sampleTime({ sampledAt: null, updatedAt: new Date(baseTime).toISOString() }), null);
  assert.equal(dashboardHealth({ ...sample(), sampledAt: null, metrics: null }, baseTime), 'unavailable');
});

class DomNode {
  children = [];
  attributes = new Map();
  className = '';
  value = '';
  listeners = new Map();
  append(...children) { this.children.push(...children); }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); }
  addEventListener(type, callback) {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== callback));
  }
  click() {
    for (const callback of [...(this.listeners.get('click') ?? [])]) callback({ type: 'click', currentTarget: this });
  }
  classList = { toggle: (name, enabled) => {
    const values = new Set(this.className.split(/\s+/).filter(Boolean));
    if (enabled) values.add(name); else values.delete(name);
    this.className = [...values].join(' ');
  } };
}

function findClass(node, name) {
  if (node.className.split(/\s+/).includes(name)) return node;
  for (const child of node.children) { const found = findClass(child, name); if (found) return found; }
  return null;
}

function withDom(callback) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new DomNode(), createElementNS: () => new DomNode() };
  try { callback(); } finally { globalThis.document = previous; }
}

test('the view keeps the same metric nodes, retains failed readings, removes online status, and recovers', () => withDom(() => {
  const view = createDashboardView({ modules: [], now: () => baseTime });
  view.update(sample());
  const memoryNode = findPanel(view.element, '内存');
  const used = findClass(memoryNode, 'metric-used');
  const status = findClass(view.element, 'server-status');
  assert.equal(used.textContent, '0.7');
  assert.match(memoryNode.textContent, /采样积累中/);
  assert.match(status.className, /is-online/);
  view.fail();
  assert.equal(findPanel(view.element, '内存'), memoryNode);
  assert.equal(used.textContent, '0.7');
  assert.match(memoryNode.textContent, /上次读数/);
  assert.doesNotMatch(status.className, /is-online/);
  assert.match(view.element.textContent, /连接中断/);
  const recovered = sample();
  recovered.metrics.memory.used = 0.8;
  recovered.metrics.memory.available = 1.2;
  view.update(recovered);
  assert.equal(used.textContent, '0.8');
  assert.match(status.className, /is-online/);
}));

test('the first failed sample shows unavailable values, no previous-reading label, and unavailable CPU', () => withDom(() => {
  const view = createDashboardView({ modules: [], now: () => baseTime });
  view.update({ ...sample(), sampledAt: null, metrics: null, server: { status: 'error', cpuPercent: null }, error: { code: 'unsupported_platform' } });
  assert.match(view.element.textContent, /CPU 暂不可用/);
  assert.doesNotMatch(findClass(view.element, 'metric-panel').textContent, /上次读数/);
  assert.match(view.element.textContent, /尚未取得数据/);
  const panel = createMetricPanel('硬盘');
  panel.update(sample().metrics.disk, { simulated: true });
  assert.match(panel.element.textContent, /示例趋势/);
  assert.doesNotMatch(panel.element.textContent, /真实采样/);
}));

function findPanel(node, title) {
  return findClasses(node, 'metric-panel').find((panel) => findClass(panel, 'metric-title')?.textContent === title);
}

function findButtons(node, text) {
  const matches = node.className.split(/\s+/).includes('metric-view-option') && node.textContent === text ? [node] : [];
  return matches.concat(node.children.flatMap((child) => findButtons(child, text)));
}

function findClasses(node, name) {
  const result = node.className.split(/\s+/).includes(name) ? [node] : [];
  return result.concat(node.children.flatMap((child) => findClasses(child, name)));
}

test('cloud and push NAS keep independent stable cards and volume readings without resetting the welcome title', () => withDom(() => {
  const view = createDashboardView({ modules: [], now: () => baseTime });
  const cloud = { ...sample(), id: 'cloud', type: 'cloud' };
  const nas = {
    ...sample(), id: 'nas', type: 'nas', mode: 'push', refreshIntervalMs: 5000,
    server: { ...sample().server, name: 'NAS', host: 'nas.local', cpuPercent: 4 },
    metrics: {
      memory: { used: 5, total: 8, available: 3, history: [5] },
      disk: { used: 300, total: 1000, available: 680, reserved: 20, history: [300], volumes: [
        { path: '/vol1', used: 200, total: 700, available: 480, reserved: 20 },
        { path: '/vol2', used: 100, total: 300, available: 200, reserved: 0 },
      ] },
    },
  };
  assert.equal(dashboardHealth(nas, baseTime), 'healthy');
  view.update({ mode: 'live', devices: [cloud, nas] });
  const cards = findClasses(view.element, 'device-card');
  assert.equal(cards.length, 2);
  assert.match(view.element.textContent, /2 台设备/);
  assert.match(cards[1].textContent, /NAS · 设备监控/);
  assert.match(cards[1].textContent, /主机地址nas.local/);
  const volumes = findClasses(cards[1], 'device-volumes')[0];
  assert.equal(volumes.children.length, 2);
  assert.match(volumes.textContent, /\/vol1/);
  assert.match(volumes.textContent, /200/);
  const names = cards.map((card) => findClass(card, 'device-name').getAttribute('id'));
  assert.notEqual(names[0], names[1]);
  view.title.textContent = '保持专注';
  view.update({ mode: 'live', devices: [cloud, { ...nas, stale: true }] });
  assert.deepEqual(findClasses(view.element, 'device-card'), cards);
  assert.match(findClass(cards[0], 'server-status').className, /is-online/);
  assert.doesNotMatch(findClass(cards[1], 'server-status').className, /is-online/);
  assert.match(volumes.textContent, /上次读数/);
  assert.equal(view.title.textContent, '保持专注');
  view.update({ mode: 'live', devices: [cloud, nas] });
  assert.match(findClass(cards[1], 'server-status').className, /is-online/);
  view.fail();
  assert.match(volumes.textContent, /上次读数/);
  assert.doesNotMatch(findClass(cards[0], 'server-status').className, /is-online/);
}));

test('remote cloud cards keep cloud facts and waiting or stale states beside NAS', () => withDom(() => {
  const view = createDashboardView({ modules: [], now: () => baseTime });
  const cloud = { ...sample(), id: 'liveCloud', type: 'cloud', server: { ...sample().server, name: '阿里云', region: '上海 · 阿里云', ip: '203.0.113.10' } };
  const nas = {
    ...sample(), id: 'fnos-nas', type: 'nas', mode: 'push',
    server: { ...sample().server, name: 'NAS', host: 'nas.local', cpuPercent: 4 },
  };
  const southeast = {
    ...sample(), id: 'huawei-ap-southeast-1', type: 'cloud', mode: 'push',
    server: { ...sample().server, name: '华为云 · 东南亚', region: '东南亚 · ap-southeast-1', ip: '198.51.100.20', cpuPercent: 3 },
  };
  const east = {
    id: 'huawei-cn-east-3', type: 'cloud', mode: 'push', sampledAt: null, stale: false,
    error: { code: 'waiting_for_report' },
    server: { name: '华为云 · 华东', status: 'waiting', region: '华东 · cn-east-3', ip: '192.0.2.10' },
    metrics: {
      memory: { used: null, total: null, available: null },
      disk: { used: null, total: null, available: null },
    },
  };
  assert.equal(dashboardHealth(southeast, baseTime), 'healthy');
  assert.equal(dashboardHealth(east, baseTime), 'waiting');
  view.update({ mode: 'live', devices: [cloud, nas, southeast, east] });
  const cards = findClasses(view.element, 'device-card');
  assert.equal(cards.length, 4);
  assert.match(view.element.textContent, /1 台设备尚未收到监控上报/);
  assert.match(cards[0].textContent, /云端 · 设备监控/);
  assert.match(cards[0].textContent, /IP 地址203.0.113.10/);
  assert.match(cards[2].textContent, /云端 · 设备监控/);
  assert.match(cards[2].textContent, /华为云 · 东南亚/);
  assert.match(cards[2].textContent, /位置东南亚 · ap-southeast-1/);
  assert.match(cards[2].textContent, /IP 地址198.51.100.20/);
  assert.match(findClass(cards[2], 'server-status').className, /is-online/);
  assert.match(cards[3].textContent, /华为云 · 华东/);
  assert.match(cards[3].textContent, /等待上报/);
  assert.match(cards[3].textContent, /IP 地址192.0.2.10/);
  assert.doesNotMatch(findClass(cards[3], 'server-status').className, /is-online/);
  view.update({ mode: 'live', devices: [cloud, nas, { ...southeast, stale: true, server: { ...southeast.server, status: 'offline' } }, east] });
  assert.equal(findClasses(view.element, 'device-card').length, 4);
  assert.doesNotMatch(findClass(cards[2], 'server-status').className, /is-online/);
  assert.match(cards[2].textContent, /数据已过期/);
  assert.match(findClass(cards[0], 'server-status').className, /is-online/);
  assert.match(findClass(cards[1], 'server-status').className, /is-online/);
}));

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('device cards default to waveforms, toggle to progress bars, and share one stored preference', () => withDom(() => {
  const previous = globalThis.localStorage;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  setMetricViewMode('wave', storage);
  try {
    storage.setItem(metricViewKey, 'later');
    assert.equal(readMetricView(storage), 'wave');
    storage.removeItem(metricViewKey);

    const short = createMetricPanel('CPU', { metric: 'cpu', pendingLabel: '采样积累中', unavailableLabel: 'CPU 暂不可用' });
    short.setViewMode('wave');
    short.update({ used: 10, total: 100, available: 90, unit: '%', history: [10] });
    assert.equal(findClass(short.element, 'metric-sparkline').getAttribute('hidden'), '');
    assert.match(short.element.textContent, /采样积累中/);
    short.update({ used: 12, total: 100, available: 88, unit: '%', history: [10, 12] });
    assert.equal(findClass(short.element, 'metric-sparkline').getAttribute('hidden'), null);
    assert.match(findClass(short.element, 'metric-sparkline').children[0].getAttribute('points'), /,/);

    const payload = sample();
    payload.server.cpuPercent = 22;
    payload.metrics.cpu = { used: 22, total: 100, available: 78, unit: '%', history: [10, 16, 22] };
    payload.metrics.memory.history = [0.4, 0.5, 0.7];
    payload.metrics.disk.history = [8, 8.2, 8.4];
    const view = createDashboardView({ modules: [], now: () => baseTime });
    view.update(payload);
    const cpuPanel = findPanel(view.element, 'CPU');
    const memoryPanel = findPanel(view.element, '内存');
    const diskPanel = findPanel(view.element, '硬盘');
    assert.equal(cpuPanel.getAttribute('data-view'), 'wave');
    assert.equal(findClass(cpuPanel, 'metric-progress').getAttribute('hidden'), '');
    assert.equal(findClass(cpuPanel, 'metric-chart').getAttribute('hidden'), null);
    assert.match(findClass(cpuPanel, 'metric-used').textContent, /22%/);
    assert.match(findClass(cpuPanel, 'metric-sparkline').children[0].getAttribute('points'), /,/);
    assert.equal(findClass(memoryPanel, 'metric-progress').getAttribute('hidden'), '');
    assert.match(findClass(memoryPanel, 'metric-sparkline').children[0].getAttribute('points'), /,/);
    assert.match(memoryPanel.textContent, /最近 3 次真实采样/);
    assert.equal(findButtons(view.element, '波形')[0].getAttribute('aria-pressed'), 'true');
    assert.equal(findButtons(view.element, '进度')[0].getAttribute('aria-pressed'), 'false');

    view.update({ ...payload, stale: true, server: { ...payload.server, status: 'offline' } });
    assert.equal(cpuPanel.getAttribute('data-stale'), '');
    assert.equal(memoryPanel.getAttribute('data-stale'), '');
    assert.match(findClass(cpuPanel, 'metric-used').textContent, /22%/);
    assert.match(findClass(memoryPanel, 'metric-used').textContent, /0\.7/);
    assert.match(findClass(cpuPanel, 'metric-sparkline').children[0].getAttribute('points'), /,/);
    assert.match(cpuPanel.textContent, /上次读数/);

    view.update(payload);
    assert.equal(cpuPanel.getAttribute('data-stale'), null);
    findButtons(view.element, '进度')[0].click();
    assert.equal(storage.getItem(metricViewKey), 'bar');
    assert.equal(cpuPanel.getAttribute('data-view'), 'bar');
    assert.equal(findClass(cpuPanel, 'metric-chart').getAttribute('hidden'), '');
    assert.equal(findClass(cpuPanel, 'metric-progress').getAttribute('hidden'), null);
    assert.equal(findClass(memoryPanel, 'metric-chart').getAttribute('hidden'), '');
    assert.equal(findClass(diskPanel, 'metric-chart').getAttribute('hidden'), '');
    assert.equal(findClass(diskPanel, 'metric-progress').getAttribute('hidden'), null);
    assert.equal(findButtons(view.element, '波形')[0].getAttribute('aria-pressed'), 'false');
    assert.equal(findButtons(view.element, '进度')[0].getAttribute('aria-pressed'), 'true');

    const restored = createDashboardView({ modules: [], now: () => baseTime });
    restored.update(payload);
    assert.equal(findPanel(restored.element, 'CPU').getAttribute('data-view'), 'bar');
    assert.equal(findButtons(restored.element, '进度')[0].getAttribute('aria-pressed'), 'true');

    const nas = {
      ...sample(), id: 'nas', type: 'nas', mode: 'push',
      server: { ...sample().server, name: 'NAS', host: 'nas.local', cpuPercent: 4 },
      metrics: {
        cpu: { used: 4, total: 100, available: 96, unit: '%', history: [3, 4] },
        memory: { used: 5, total: 8, available: 3, history: [4, 5] },
        disk: {
          used: 300, total: 1000, available: 680, reserved: 20, history: [280, 300],
          volumes: [{ path: '/vol1', used: 200, total: 700, available: 480, reserved: 20 }],
        },
      },
    };
    view.update({ mode: 'live', devices: [{ ...payload, id: 'cloud' }, nas] });
    const cards = findClasses(view.element, 'device-card');
    assert.equal(cards.length, 2);
    assert.equal(findPanel(cards[1], 'CPU').getAttribute('data-view'), 'bar');
    const volume = findClasses(cards[1], 'device-volumes')[0].children[0];
    assert.equal(findClass(volume, 'metric-chart').getAttribute('hidden'), '');
    assert.equal(findClass(volume, 'metric-progress').getAttribute('hidden'), null);
    findButtons(restored.element, '波形')[0].click();
    assert.equal(storage.getItem(metricViewKey), 'wave');
    assert.equal(findPanel(cards[0], '内存').getAttribute('data-view'), 'wave');
    assert.equal(findPanel(cards[1], '硬盘').getAttribute('data-view'), 'wave');
    assert.equal(findClass(volume, 'metric-chart').getAttribute('hidden'), '');
    assert.equal(findClass(volume, 'metric-progress').getAttribute('hidden'), null);
    assert.equal(findButtons(cards[0], '波形')[0].getAttribute('aria-pressed'), 'true');
    assert.equal(findButtons(cards[1], '波形')[0].getAttribute('aria-pressed'), 'true');
  } finally {
    setMetricViewMode('wave', storage);
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}));
