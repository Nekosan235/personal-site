import { element } from './dom.js?v=1.4.0';

const namespace = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

export const metricViewKey = 'personal-space.metric-view.v1';

const subscribers = new Set();
let memoryMode = 'wave';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function metricStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    const store = globalThis.localStorage;
    if (!store || typeof store.getItem !== 'function') return null;
    return store;
  } catch {
    return null;
  }
}

export function readMetricView(storage) {
  const store = metricStorage(storage);
  if (!store) return memoryMode === 'bar' ? 'bar' : 'wave';
  try {
    const value = store.getItem(metricViewKey);
    if (value === 'bar' || value === 'wave') return value;
    return 'wave';
  } catch {
    return memoryMode === 'bar' ? 'bar' : 'wave';
  }
}

export function setMetricViewMode(mode, storage) {
  const next = mode === 'bar' ? 'bar' : 'wave';
  memoryMode = next;
  try { metricStorage(storage)?.setItem(metricViewKey, next); } catch { /* Private browsing can disable storage. */ }
  for (const listener of subscribers) listener(next);
  return next;
}

export function subscribeMetricView(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function readMetric(data) {
  if (!data || data.error || !isFiniteNumber(data.total) || data.total <= 0
    || !isFiniteNumber(data.used) || data.used < 0 || data.used > data.total) return null;
  const available = isFiniteNumber(data.available) && data.available >= 0 && data.available <= data.total
    ? data.available : null;
  const difference = available === null ? null : Math.max(0, data.total - data.used - available);
  const capacityDifference = isFiniteNumber(data.reserved) && data.reserved >= 0
    ? data.reserved : difference > 0.02 ? difference : 0;
  return {
    used: data.used,
    total: data.total,
    available,
    percentage: Math.round((data.used / data.total) * 100),
    unit: typeof data.unit === 'string' ? data.unit : 'GiB',
    capacityDifference,
    history: Array.isArray(data.history)
      ? data.history.filter((value) => isFiniteNumber(value) && value >= 0 && value <= data.total).slice(-60)
      : [],
  };
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

export function createMetricPanel(label, {
  showHistory = true,
  metric = '',
  pendingLabel = '正在获取数据',
  unavailableLabel = '数据暂不可用',
} = {}) {
  const used = element('span', { className: 'metric-used', text: '—' });
  const total = element('span', { className: 'metric-total' });
  const progress = element('progress', { className: 'metric-progress', attributes: { max: 1, value: 0 } });
  const percentage = element('span');
  const available = element('span');
  const readingNote = element('span', { className: 'metric-reading-note' });
  const capacityNote = element('p', { className: 'metric-capacity-note' });
  const chartCaption = element('span', { className: 'chart-caption', text: '采样积累中' });
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 300 76');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'metric-sparkline');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}真实采样变化`);
  const line = document.createElementNS(namespace, 'polyline');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  const chart = element('div', { className: 'metric-chart' }, [svg, chartCaption]);
  const section = element('section', {
    className: 'metric-panel',
    attributes: { 'aria-label': `${label}使用情况`, ...(metric ? { 'data-metric': metric } : {}) },
  }, [
    element('div', { className: 'metric-title-row' }, [element('h3', { className: 'metric-title', text: label }), readingNote]),
    element('p', { className: 'metric-value' }, [
      used, total,
    ]),
    progress,
    element('div', { className: 'metric-details' }, [percentage, available]),
    capacityNote,
    chart,
  ]);
  let lastReading = null;
  let lastReadingAt = null;
  let lastReadingSimulated = false;
  let mode = readMetricView();

  function syncChrome() {
    const wave = showHistory && mode === 'wave';
    progress.toggleAttribute('hidden', wave);
    chart.toggleAttribute('hidden', !wave);
    section.setAttribute('data-view', mode);
  }

  function update(data, { stale = false, retainLast = true, loading = false, sampledAt, simulated = false } = {}) {
    const reading = readMetric(data);
    if (reading) {
      lastReading = reading;
      lastReadingSimulated = simulated;
      if (sampledAt instanceof Date && Number.isFinite(sampledAt.getTime())) lastReadingAt = sampledAt;
    }
    else if (!retainLast) lastReading = null;
    const shown = lastReading;
    const old = Boolean(shown) && (stale || !reading);
    section.toggleAttribute('data-stale', old);
    section.toggleAttribute('data-unavailable', !shown);
    const readingTime = lastReadingAt ? new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(lastReadingAt) : '';
    setText(readingNote, old ? `上次读数${readingTime ? ` · ${readingTime}` : ''}` : '');

    if (!shown) {
      setText(used, '—');
      setText(total, '');
      setText(percentage, loading ? pendingLabel : unavailableLabel);
      setText(available, '');
      setText(capacityNote, '');
      progress.setAttribute('value', '0');
      progress.setAttribute('max', '1');
      progress.setAttribute('aria-label', `${label}数据暂不可用`);
      svg.setAttribute('hidden', '');
      setText(chartCaption, loading ? '等待首次采样' : '暂无采样数据');
      syncChrome();
      return;
    }

    const percent = shown.unit === '%';
    setText(used, percent ? `${numberFormat.format(shown.used)}%` : numberFormat.format(shown.used));
    setText(total, percent ? '' : `/ ${numberFormat.format(shown.total)} ${shown.unit}`);
    setText(percentage, percent ? '占用' : `${shown.percentage}% 已使用`);
    setText(available, percent
      ? (shown.available === null ? '' : `空闲 ${numberFormat.format(shown.available)}%`)
      : (shown.available === null
        ? '可用容量暂无数据'
        : `可用 ${numberFormat.format(shown.available)} ${shown.unit}`));
    setText(capacityNote, !percent && shown.capacityDifference > 0.005
      ? `${numberFormat.format(shown.capacityDifference)} ${shown.unit} 为系统保留或不可用容量。`
      : '');
    progress.setAttribute('max', String(shown.total));
    progress.setAttribute('value', String(shown.used));
    progress.setAttribute('aria-label', percent
      ? `${label} ${numberFormat.format(shown.used)}%${old ? '，上次读数' : ''}`
      : `${label}已使用 ${numberFormat.format(shown.used)} ${shown.unit}，共 ${numberFormat.format(shown.total)} ${shown.unit}${old ? '，上次读数' : ''}`);
    svg.toggleAttribute('hidden', shown.history.length < 2);
    svg.setAttribute('aria-label', `${label}${lastReadingSimulated ? '示例趋势' : '真实采样变化'}`);
    if (shown.history.length >= 2) {
      const points = shown.history.map((value, index) => {
        const x = 2 + (index / (shown.history.length - 1)) * 296;
        const y = 70 - (value / shown.total) * 62;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      });
      line.setAttribute('points', points.join(' '));
    }
    setText(chartCaption, lastReadingSimulated ? '示例趋势'
      : shown.history.length < 2 ? '采样积累中' : `最近 ${shown.history.length} 次真实采样`);
    syncChrome();
  }

  function setViewMode(next) {
    mode = next === 'bar' ? 'bar' : 'wave';
    syncChrome();
  }

  update(null, { loading: true });
  return {
    element: section,
    update,
    setViewMode,
    get hasReading() { return Boolean(lastReading); },
    get viewMode() { return mode; },
  };
}

export function metricPanel(label, data) {
  const panel = createMetricPanel(label);
  panel.update(data);
  return panel.element;
}
