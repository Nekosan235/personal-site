import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig, normalizeExpiresAt } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { sessionCookie } from '../server/auth/cookies.js';
import { NasMonitorStore } from '../server/providers/nas.js';
import { createDashboardView } from '../public/assets/pages/dashboard.js';
import {
  bindModuleDrag,
  dashboardLayoutKey,
  dragMode,
  dropOrder,
  expiryPresentation,
  readCustomName,
  readDashboardLayout,
  resetModuleOrder,
  sanitizeCustomName,
  setCustomName,
  writeModuleOrder,
} from '../public/assets/components/dashboard-layout.js';

const cssPath = fileURLToPath(new URL('../public/assets/styles.css', import.meta.url));
const baseTime = Date.parse('2026-10-06T04:00:00.000Z');
const PRIVATE_KEY = 'SENTINEL_PRIVATE_KEY_do_not_leak';
const MONITOR_SECRET = 'SENTINEL_MONITOR_SECRET_do_not_leak_032';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

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

function withDom(callback) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new DomNode(), createElementNS: () => new DomNode() };
  try { return callback(); } finally { globalThis.document = previous; }
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findClass(node, name) {
  let found = null;
  walk(node, (current) => {
    if (!found && current.className?.split(/\s+/).includes(name)) found = current;
  });
  return found;
}

function findAttr(node, name, expected) {
  let found = null;
  walk(node, (current) => {
    if (!found && current.getAttribute?.(name) === expected) found = current;
  });
  return found;
}

function findButtons(node, text) {
  const matches = [];
  walk(node, (current) => {
    if (current.textContent === text && current.listeners?.has('click')) matches.push(current);
  });
  return matches;
}

function fire(node, type, extras = {}) {
  const event = {
    type, button: 0, pointerId: 1, clientX: 0, clientY: 0,
    preventDefault() { event.defaultPrevented = true; },
    ...extras,
  };
  for (const callback of [...(node.listeners.get(type) ?? [])]) callback(event);
  return event;
}

function findPanel(node, title) {
  let found = null;
  walk(node, (current) => {
    if (found || !current.className?.split(/\s+/).includes('metric-panel')) return;
    if (findClass(current, 'metric-title')?.textContent === title) found = current;
  });
  return found;
}

function moduleOrder(view) {
  return findClass(view.element, 'dashboard-board').getAttribute('data-module-order');
}

const sample = () => ({
  mode: 'live',
  sampledAt: new Date(baseTime).toISOString(),
  updatedAt: new Date(baseTime).toISOString(),
  stale: false,
  error: null,
  server: {
    id: 'cloud-01', name: 'Cloud 01', region: '上海 · 阿里云', ip: '203.0.113.10',
    status: 'online', cpuPercent: 12, uptimeSeconds: 3600, os: 'Debian 13', vcpu: 2,
  },
  metrics: {
    cpu: { used: 12, total: 100, available: 88, unit: '%', history: [10, 12] },
    memory: { used: 0.7, total: 2, available: 1.3, history: [0.7] },
    disk: { used: 8, total: 40, available: 30, reserved: 2, history: [8] },
  },
});

test('expiry dates render in Asia/Shanghai and invalid values stay unset', () => {
  assert.equal(normalizeExpiresAt('2027-03-01'), '2027-03-01');
  assert.equal(normalizeExpiresAt('2026-02-31'), null);
  assert.equal(normalizeExpiresAt('tomorrow'), null);
  assert.equal(normalizeExpiresAt('2026-01-15T16:30:00Z'), '2026-01-16');
  assert.equal(normalizeExpiresAt('2026-03-01T08:30:00'), '2026-03-01');
  assert.equal(normalizeExpiresAt(''), null);
  const today = expiryPresentation('2026-10-06', baseTime);
  assert.equal(today.text, '到期 2026-10-06');
  assert.equal(today.expired, false);
  const past = expiryPresentation('2020-01-02', baseTime);
  assert.equal(past.text, '到期 2020-01-02');
  assert.equal(past.expired, true);
  assert.deepEqual(expiryPresentation('not-a-date', baseTime), { text: '到期 未设置', expired: false, date: null });
});

test('layout order and custom names persist without storing key material', () => {
  const storage = memoryStorage();
  assert.deepEqual(readDashboardLayout(storage).order, ['work', 'monitor']);
  writeModuleOrder(['monitor', 'work'], storage);
  assert.deepEqual(readDashboardLayout(storage).order, ['monitor', 'work']);
  assert.equal(setCustomName('cloud-01', '  家里的云  ', storage), '家里的云');
  assert.equal(readCustomName('cloud-01', storage), '家里的云');
  assert.equal(setCustomName('cloud-01', '   ', storage), '');
  assert.equal(readCustomName('cloud-01', storage), '');
  assert.equal(setCustomName('huawei-ap-southeast-1', '东南节点', storage), '东南节点');
  assert.equal(sanitizeCustomName('-----BEGIN OPENSSH PRIVATE KEY-----'), '');
  assert.equal(setCustomName('cloud-01', '-----BEGIN OPENSSH PRIVATE KEY-----', storage), '');
  assert.doesNotMatch(storage.getItem(dashboardLayoutKey), /PRIVATE KEY|BEGIN /);
  const reset = resetModuleOrder(storage);
  assert.deepEqual(reset.order, ['work', 'monitor']);
  assert.equal(reset.names['huawei-ap-southeast-1'], '东南节点');
  assert.equal(dropOrder(['work', 'monitor'], 'work', { x: 10, y: 500 }, {
    work: { top: 0, left: 0, width: 800, height: 180 },
    monitor: { top: 200, left: 0, width: 800, height: 320 },
  }).join(','), 'monitor,work');
  assert.equal(dropOrder(['work', 'monitor'], 'monitor', { x: 40, y: 20 }, {
    work: { top: 0, left: 0, width: 400, height: 300 },
    monitor: { top: 0, left: 420, width: 400, height: 300 },
  }).join(','), 'monitor,work');
  assert.equal(dragMode({ editing: false, matchMedia: () => ({ matches: false }) }), 'immediate');
  assert.equal(dragMode({ editing: false, matchMedia: () => ({ matches: true }) }), 'locked');
  assert.equal(dragMode({ editing: true, matchMedia: () => ({ matches: true }) }), 'armed');
});

test('a coarse pointer does not start a drag until the long-press arms it', async () => {
  const handle = new DomNode();
  let starts = 0;
  let drops = 0;
  bindModuleDrag(handle, {
    longPressMs: 30,
    getMode: () => 'locked',
    onDragStart: () => { starts += 1; },
    onDrop: () => { drops += 1; },
  });
  fire(handle, 'pointerdown', { clientX: 0, clientY: 0 });
  fire(handle, 'pointerup', { clientX: 0, clientY: 4 });
  assert.equal(starts, 0);
  fire(handle, 'pointerdown', { clientX: 0, clientY: 0 });
  fire(handle, 'pointermove', { clientX: 30, clientY: 0 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(starts, 0);
  fire(handle, 'pointerdown', { clientX: 2, clientY: 2 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(starts, 1);
  fire(handle, 'pointerup', { clientX: 2, clientY: 2 });
  assert.equal(drops, 1);
});

test('overview modules swap by drag or nudge, restore, and keep names off the server id', () => withDom(() => {
  const storage = memoryStorage();
  const view = createDashboardView({ modules: [], now: () => baseTime, storage });
  assert.equal(moduleOrder(view), 'work,monitor');
  assert.equal(findButtons(view.element, '恢复默认布局').length, 1);
  findButtons(view.element, '下移').find((node) => node.getAttribute('data-module') === 'work').click();
  assert.equal(moduleOrder(view), 'monitor,work');
  assert.equal(JSON.parse(storage.getItem(dashboardLayoutKey)).order.join(','), 'monitor,work');

  const restored = createDashboardView({ modules: [], now: () => baseTime, storage });
  assert.equal(moduleOrder(restored), 'monitor,work');
  findButtons(restored.element, '恢复默认布局')[0].click();
  assert.equal(moduleOrder(restored), 'work,monitor');

  const cloud = {
    ...sample(), id: 'liveCloud', type: 'cloud', expiresAt: '2027-03-01',
  };
  const southeast = {
    ...sample(), id: 'huawei-ap-southeast-1', type: 'cloud', mode: 'push', expiresAt: '2020-01-02',
    server: { ...sample().server, id: 'huawei-ap-southeast-1', name: '华为云 · 东南亚', region: '东南亚 · ap-southeast-1', ip: '198.51.100.20' },
    metrics: {
      ...sample().metrics,
      memory: { used: 2, total: 4, available: 2, history: [2] },
    },
  };
  view.update({ mode: 'live', devices: [cloud, southeast] });
  const cards = [];
  walk(view.element, (node) => { if (node.className.split(/\s+/).includes('device-card')) cards.push(node); });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute('data-server-id'), 'cloud-01');
  assert.equal(cards[1].getAttribute('data-server-id'), 'huawei-ap-southeast-1');
  const name = findClass(cards[1], 'device-name');
  const nameId = name.getAttribute('id');
  const memoryPanel = findPanel(cards[1], '内存');
  assert.equal(name.textContent, '华为云 · 东南亚');
  assert.match(cards[1].textContent, /198\.51\.100\.20/);
  findButtons(cards[1], '改名')[0].click();
  const input = findClass(cards[1], 'device-rename-input');
  input.value = '东南节点';
  findButtons(cards[1], '保存')[0].click();
  assert.equal(name.textContent, '东南节点');
  assert.equal(name.getAttribute('id'), nameId);
  assert.equal(cards[1].getAttribute('data-server-id'), 'huawei-ap-southeast-1');
  assert.match(cards[1].textContent, /198\.51\.100\.20/);
  assert.equal(findClass(memoryPanel, 'metric-used').textContent, '2');
  view.update({
    mode: 'live',
    devices: [{ ...southeast, server: { ...southeast.server, name: '华为云 · 东南亚' }, metrics: { ...southeast.metrics, memory: { used: 3, total: 4, available: 1, history: [3] } } }],
  });
  assert.equal(name.textContent, '东南节点');
  assert.equal(findClass(memoryPanel, 'metric-used').textContent, '3');
  assert.match(cards[1].textContent, /198\.51\.100\.20/);
  findButtons(cards[1], '改名')[0].click();
  findClass(cards[1], 'device-rename-input').value = '   ';
  findButtons(cards[1], '保存')[0].click();
  assert.equal(name.textContent, '华为云 · 东南亚');

  findButtons(cards[0], '改名')[0].click();
  findClass(cards[0], 'device-rename-input').value = '-----BEGIN OPENSSH PRIVATE KEY-----';
  findButtons(cards[0], '保存')[0].click();
  assert.equal(findClass(cards[0], 'device-name').textContent, 'Cloud 01');
  assert.doesNotMatch(storage.getItem(dashboardLayoutKey) ?? '', /PRIVATE KEY/);

  const future = findClass(cards[0], 'device-expiry');
  assert.equal(future.textContent, '到期 2027-03-01');
  assert.equal(future.className.includes('is-expired'), false);
  assert.equal(cards[0].className.includes('is-expired'), false);
  const expired = findClass(cards[1], 'device-expiry');
  assert.equal(expired.textContent, '到期 2020-01-02');
  assert.equal(expired.className.includes('is-expired'), true);
  assert.equal(cards[1].className.includes('is-expired'), false);

  const waiting = createDashboardView({ modules: [], now: () => baseTime, storage });
  waiting.update({ mode: 'push', devices: [{ id: 'fnos-nas', type: 'nas', mode: 'push', server: { id: 'fnos-nas', name: 'NAS', host: 'nas.local', status: 'waiting' }, metrics: {} }] });
  const nasCard = findAttr(waiting.element, 'data-server-id', 'fnos-nas');
  assert.equal(findClass(nasCard, 'device-expiry').textContent, '到期 未设置');
  assert.equal(findClass(nasCard, 'device-expiry').className.includes('is-expired'), false);
}));

test('dragging the work module shows a placeholder and saves the new order on drop', () => withDom(() => {
  const storage = memoryStorage();
  const view = createDashboardView({ modules: [], now: () => baseTime, storage });
  const work = findAttr(view.element, 'data-dashboard-module', 'work');
  const monitor = findAttr(view.element, 'data-dashboard-module', 'monitor');
  work.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: 200 });
  monitor.getBoundingClientRect = () => ({ top: 220, left: 0, width: 800, height: 400 });
  const handle = findAttr(view.element, 'data-layout-handle', 'work');
  const start = fire(handle, 'pointerdown', { clientY: 20 });
  assert.equal(start.defaultPrevented, true);
  assert.ok(findClass(view.element, 'layout-placeholder'));
  assert.match(findClass(view.element, 'layout-placeholder').textContent, /放到这里/);
  fire(handle, 'pointermove', { clientY: 500 });
  assert.equal(moduleOrder(view), 'monitor,work');
  fire(handle, 'pointerup', { clientY: 500 });
  assert.equal(findClass(view.element, 'layout-placeholder'), null);
  assert.equal(moduleOrder(view), 'monitor,work');
  assert.equal(JSON.parse(storage.getItem(dashboardLayoutKey)).order.join(','), 'monitor,work');
  assert.equal(work.className.includes('is-dragging'), false);

  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: String(query).includes('coarse') });
  try {
    const coarse = createDashboardView({ modules: [], now: () => baseTime, storage: memoryStorage() });
    const coarseHandle = findAttr(coarse.element, 'data-layout-handle', 'monitor');
    const event = fire(coarseHandle, 'pointerdown', { clientY: 8 });
    assert.equal(event.defaultPrevented, undefined);
    assert.equal(findClass(coarse.element, 'layout-placeholder'), null);
    fire(coarseHandle, 'pointerup', { clientY: 8 });
  } finally {
    if (previous === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = previous;
  }
}));

test('mobile layout controls stay inside the card and use 44px targets', async () => {
  const css = await readFile(cssPath, 'utf8');
  assert.match(css, /\.dashboard-page \{[^}]*overflow-x:\s*clip/);
  assert.match(css, /\.dashboard-board \{[^}]*min-width:\s*0/);
  assert.match(css, /\.device-rename-input \{[^}]*max-width:\s*100%/);
  assert.match(css, /\.device-expiry\.is-expired \{[^}]*color:\s*var\(--warning\)/);
  assert.match(css, /@media \(max-width: 991\.98px\) \{[\s\S]*?\.layout-handle[\s\S]*?min-height:\s*44px/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.device-rename-input \{[^}]*font-size:\s*16px/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.layout-nudge \{ display: none; \}/);
});

test('dashboard expiry comes from server config and the payload omits secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-layout-'));
  const config = loadConfig({}, {
    NODE_ENV: 'production',
    SITE_ORIGIN: 'https://layout.example',
    DATA_DIR: join(directory, 'data'),
    AUTH_USERNAME: 'layout-user',
    AUTH_PASSWORD_HASH: await hashPassword('layout-test-password'),
    AUTH_SECRET: randomBytes(48).toString('hex'),
    MONITORING_MODE: 'mock',
    SERVER_ID: 'cloud-01',
    SERVER_EXPIRES_AT: '2027-03-01',
    NAS_MONITOR_SECRET: MONITOR_SECRET,
    NAS_DEVICE_ID: 'fnos-nas',
    NAS_DEVICE_NAME: 'Test NAS',
    NAS_DEVICE_HOST: 'nas.local',
    NAS_DEVICE_EXPIRES_AT: '2028-12-31',
    REMOTE_CLOUD_1_ID: 'huawei-ap-southeast-1',
    REMOTE_CLOUD_1_NAME: '华为云 · 东南亚',
    REMOTE_CLOUD_1_IP: '198.51.100.20',
    REMOTE_CLOUD_1_SECRET: MONITOR_SECRET,
    REMOTE_CLOUD_1_EXPIRES_AT: '2026-01-15T16:30:00Z',
    REMOTE_CLOUD_2_ID: 'huawei-cn-east-3',
    REMOTE_CLOUD_2_EXPIRES_AT: 'not-a-date',
    SSH_1_ID: 'cloud-01',
    SSH_1_HOST: '127.0.0.1',
    SSH_1_USERNAME: 'root',
    SSH_1_PRIVATE_KEY: `-----BEGIN OPENSSH PRIVATE KEY-----\n${PRIVATE_KEY}\n-----END OPENSSH PRIVATE KEY-----`,
  });
  assert.equal(config.serverExpiresAt, '2027-03-01');
  assert.equal(config.remoteDevices[1].expiresAt, '2026-01-16');
  assert.equal(config.remoteDevices[2].expiresAt, null);
  const store = new NasMonitorStore(config, { now: () => baseTime });
  store.acceptReport({
    deviceId: 'fnos-nas',
    sampledAt: new Date(baseTime).toISOString(),
    server: { name: 'Test NAS', expiresAt: '1999-01-01', cpuPercent: 1, uptimeSeconds: 10 },
    metrics: { memory: { used: 1, total: 8, available: 7 }, disk: { used: 1, total: 10, available: 9 } },
  }, 'fnos-nas');
  assert.equal(store.getDashboards()[0].expiresAt, '2028-12-31');
  assert.equal(store.getDashboards()[0].server.expiresAt, '2028-12-31');

  const server = createApplication({ config, nasMonitorStore: store });
  t.after(async () => {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const anonymous = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);

  const session = server.sessionStore.create('layout-user', 60_000);
  const response = await fetch(`${base}/api/dashboard`, {
    headers: { Cookie: sessionCookie(session.token, config) },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const encoded = JSON.stringify(body);
  assert.equal(body.devices[0].id, 'liveCloud');
  assert.equal(body.devices[0].server.id, 'cloud-01');
  assert.equal(body.devices[0].expiresAt, '2027-03-01');
  assert.equal(body.devices[1].id, 'fnos-nas');
  assert.equal(body.devices[1].expiresAt, '2028-12-31');
  assert.equal(body.devices[2].expiresAt, '2026-01-16');
  assert.equal(body.devices[2].server.name, '华为云 · 东南亚');
  assert.equal(body.devices[3].expiresAt, null);
  assert.doesNotMatch(encoded, new RegExp(PRIVATE_KEY));
  assert.doesNotMatch(encoded, new RegExp(MONITOR_SECRET));
  assert.doesNotMatch(encoded, /PRIVATE KEY|privateKey|password/);
  const keys = [];
  JSON.stringify(body, (key, value) => { keys.push(key); return value; });
  assert.equal(keys.some((key) => /secret|privateKey|password/i.test(key)), false);
});
