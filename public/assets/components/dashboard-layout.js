import { element } from './dom.js?v=1.4.0';

export const dashboardLayoutKey = 'personal-space.dashboard-layout.v1';
export const defaultModuleOrder = ['work', 'monitor'];

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const SECRET_HINT = /PRIVATE KEY|BEGIN [A-Z0-9 ]{0,24}KEY|ssh-rsa |ssh-ed25519 |ssh-dss /i;
const NAME_LIMIT = 64;
const NAME_COUNT_LIMIT = 32;

function layoutStore(storage) {
  if (storage !== undefined) return storage;
  try {
    const store = globalThis.localStorage;
    if (!store || typeof store.getItem !== 'function') return null;
    return store;
  } catch {
    return null;
  }
}

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

export function shanghaiToday(now = Date.now()) {
  return shanghaiCalendarDate(now);
}

export function expiryPresentation(value, now = Date.now()) {
  const date = normalizeExpiresAt(value);
  if (!date) return { text: '到期 未设置', expired: false, date: null };
  const today = shanghaiToday(now);
  return { text: `到期 ${date}`, expired: Boolean(today) && date < today, date };
}

export function normalizeModuleOrder(order) {
  const next = [];
  const source = Array.isArray(order) ? order : [];
  for (const id of source) {
    if ((id === 'work' || id === 'monitor') && !next.includes(id)) next.push(id);
  }
  for (const id of defaultModuleOrder) if (!next.includes(id)) next.push(id);
  return next;
}

export function sanitizeCustomName(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_LIMIT);
  if (!cleaned || SECRET_HINT.test(cleaned)) return '';
  return cleaned;
}

function sanitizeLayout(value) {
  const names = {};
  const source = value && typeof value === 'object' ? value.names : null;
  if (source && typeof source === 'object') {
    for (const key of Object.keys(source)) {
      if (!ID_PATTERN.test(key)) continue;
      const clean = sanitizeCustomName(source[key]);
      if (!clean) continue;
      names[key] = clean;
      if (Object.keys(names).length >= NAME_COUNT_LIMIT) break;
    }
  }
  return { order: normalizeModuleOrder(value?.order), names };
}

export function readDashboardLayout(storage) {
  const fallback = { order: [...defaultModuleOrder], names: {} };
  const store = layoutStore(storage);
  if (!store) return fallback;
  try {
    const raw = store.getItem(dashboardLayoutKey);
    if (typeof raw !== 'string' || !raw) return fallback;
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export function writeDashboardLayout(layout, storage) {
  const clean = sanitizeLayout(layout);
  const store = layoutStore(storage);
  if (!store) return clean;
  try {
    store.setItem(dashboardLayoutKey, JSON.stringify(clean));
  } catch {
    /* Private browsing can disable storage. */
  }
  return clean;
}

export function writeModuleOrder(order, storage) {
  const layout = readDashboardLayout(storage);
  layout.order = normalizeModuleOrder(order);
  return writeDashboardLayout(layout, storage);
}

export function resetModuleOrder(storage) {
  const layout = readDashboardLayout(storage);
  layout.order = [...defaultModuleOrder];
  return writeDashboardLayout(layout, storage);
}

export function readCustomName(id, storage) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return '';
  return readDashboardLayout(storage).names[id] || '';
}

export function setCustomName(id, name, storage) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return '';
  const layout = readDashboardLayout(storage);
  const clean = sanitizeCustomName(name);
  if (clean) layout.names[id] = clean;
  else delete layout.names[id];
  writeDashboardLayout(layout, storage);
  return clean;
}

export function deviceLayoutId(data) {
  const candidates = [data?.server?.id, data?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && ID_PATTERN.test(candidate)) return candidate;
  }
  return '';
}

export function moduleOrderFrom(parent) {
  const order = [];
  for (const child of parent?.children || []) {
    const id = child.getAttribute?.('data-dashboard-module');
    if (id === 'work' || id === 'monitor') order.push(id);
  }
  return normalizeModuleOrder(order);
}

export function placeChildren(parent, nodes) {
  const list = nodes.filter(Boolean);
  if (typeof parent.replaceChildren === 'function') {
    parent.replaceChildren(...list);
    return;
  }
  parent.children = list;
  for (const node of list) node.parentNode = parent;
}

export function nudgedOrder(order, id, direction) {
  const next = normalizeModuleOrder(order);
  const index = next.indexOf(id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function layoutAxis(rects, order) {
  const boxes = (order || []).map((id) => rects?.[id]).filter((rect) => (
    rect && Number.isFinite(rect.top) && Number.isFinite(rect.left)
      && Number.isFinite(rect.width) && Number.isFinite(rect.height)
  ));
  if (boxes.length < 2) return 'column';
  const [first, second] = boxes;
  const overlapY = Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top);
  return overlapY > Math.min(first.height, second.height) * 0.5 ? 'row' : 'column';
}

export function dropOrder(currentOrder, draggingId, pointer, rects) {
  const order = normalizeModuleOrder(currentOrder);
  const otherId = order.find((id) => id !== draggingId);
  const rect = rects?.[otherId];
  if (!otherId || !rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.left)) return order;
  const before = layoutAxis(rects, order) === 'row'
    ? (pointer?.x ?? 0) < rect.left + rect.width / 2
    : (pointer?.y ?? 0) < rect.top + rect.height / 2;
  return before ? [draggingId, otherId] : [otherId, draggingId];
}

export function dragMode({ editing = false, matchMedia } = {}) {
  const media = matchMedia ?? globalThis.matchMedia;
  let coarse = false;
  try {
    coarse = Boolean(media?.('(pointer: coarse)')?.matches);
  } catch {
    coarse = false;
  }
  if (!coarse) return 'immediate';
  return editing ? 'armed' : 'locked';
}

export function bindModuleDrag(handle, hooks) {
  const delay = hooks.longPressMs ?? 450;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let timer = null;

  function clearTimer() {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    pointerId = event.pointerId ?? 1;
    startX = event.clientX ?? 0;
    startY = event.clientY ?? 0;
    dragging = false;
    clearTimer();
    const mode = hooks.getMode?.() ?? 'immediate';
    if (mode === 'locked') {
      timer = setTimeout(() => {
        timer = null;
        dragging = true;
        handle.setPointerCapture?.(pointerId);
        hooks.onDragStart?.({ ...event, longPress: true, pointerId });
      }, delay);
      return;
    }
    event.preventDefault?.();
    dragging = true;
    handle.setPointerCapture?.(pointerId);
    hooks.onDragStart?.({ ...event, longPress: false, pointerId });
  }

  function onPointerMove(event) {
    if ((event.pointerId ?? 1) !== pointerId) return;
    const dx = (event.clientX ?? 0) - startX;
    const dy = (event.clientY ?? 0) - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) > 8) clearTimer();
      return;
    }
    event.preventDefault?.();
    hooks.onDrag?.(event);
  }

  function finish(event) {
    if ((event.pointerId ?? 1) !== pointerId && pointerId != null && event.type !== 'pointercancel') return;
    clearTimer();
    const moved = dragging;
    dragging = false;
    pointerId = null;
    if (moved) hooks.onDrop?.(event);
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  return () => {
    clearTimer();
    handle.removeEventListener?.('pointerdown', onPointerDown);
    handle.removeEventListener?.('pointermove', onPointerMove);
    handle.removeEventListener?.('pointerup', finish);
    handle.removeEventListener?.('pointercancel', finish);
  };
}

export function createLayoutPlaceholder(label) {
  return element('div', {
    className: 'layout-placeholder',
    text: label ? `${label}放到这里` : '放到这里',
    attributes: { 'data-layout-placeholder': '', 'aria-hidden': 'true' },
  });
}

export function createDeviceRename({ storage, onName }) {
  let deviceId = '';
  let configName = '设备';
  let open = false;
  let saving = false;
  const input = element('input', {
    className: 'device-rename-input',
    attributes: {
      type: 'text',
      maxlength: String(NAME_LIMIT),
      'aria-label': '显示名称',
      autocomplete: 'off',
      enterkeyhint: 'done',
      spellcheck: 'false',
    },
  });
  const saveButton = element('button', {
    className: 'btn btn-primary device-rename-save',
    text: '保存',
    attributes: { type: 'button' },
  });
  const cancelButton = element('button', {
    className: 'btn btn-outline-primary device-rename-cancel',
    text: '取消',
    attributes: { type: 'button' },
  });
  const form = element('form', {
    className: 'device-rename-form',
    attributes: { hidden: '' },
  }, [input, saveButton, cancelButton]);
  const editButton = element('button', {
    className: 'btn btn-outline-primary device-rename',
    text: '改名',
    attributes: { type: 'button', 'aria-label': '编辑显示名称', 'aria-expanded': 'false' },
  });

  function shown() {
    const custom = deviceId ? readCustomName(deviceId, storage) : '';
    return custom || configName || '设备';
  }

  function setOpen(next) {
    open = next;
    form.classList.toggle('is-open', next);
    form.toggleAttribute('hidden', !next);
    editButton.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (!next) return;
    input.value = deviceId ? readCustomName(deviceId, storage) : '';
    input.focus?.();
  }

  function commitName(event) {
    event?.preventDefault?.();
    if (saving) return;
    saving = true;
    try {
      if (deviceId) setCustomName(deviceId, String(input.value ?? ''), storage);
      setOpen(false);
      onName?.(shown());
    } finally {
      saving = false;
    }
  }

  editButton.addEventListener('click', () => setOpen(!open));
  cancelButton.addEventListener('click', () => setOpen(false));
  saveButton.addEventListener('click', commitName);
  form.addEventListener('submit', commitName);

  return {
    editButton,
    form,
    shown,
    isOpen: () => open,
    setSource(id, name) {
      deviceId = typeof id === 'string' ? id : '';
      configName = typeof name === 'string' && name.trim() ? name.trim() : '设备';
      return shown();
    },
  };
}
