import { element } from './dom.js?v=1.4.0';

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

/** Load bands drive CSS only: calm < 60% ≤ busy < 85% ≤ hot. */
export function loadBand(ratio) {
  if (!isFiniteNumber(ratio)) return null;
  if (ratio >= 0.85) return 'hot';
  if (ratio >= 0.6) return 'busy';
  return 'calm';
}

/** Full motion only in a real browser, without reduced motion, and not in lite/off mode. */
export function motionAllowed(scope = globalThis) {
  if (typeof scope.requestAnimationFrame !== 'function') return false;
  try {
    if (scope.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  } catch { /* Older engines without matchMedia keep motion. */ }
  const level = scope.document?.documentElement?.getAttribute?.('data-motion');
  return level !== 'off';
}

const tweenMs = 600;
const easeOut = (t) => 1 - (1 - t) ** 3;
const slideEasing = 'cubic-bezier(.2,.7,.2,1)';

/** Threshold rules drawn across the bar chart; they match the loadBand() cut points. */
export const metricThresholds = Object.freeze([60, 85]);

const sameSeries = (left, right) => left.length === right.length
  && left.every((value, index) => value === right[index]);

/**
 * How the sample window changed between two renders:
 * 'append' (one new sample, window not yet full), 'shift' (full window slid by one),
 * 'same' (re-render of identical data) or 'reset' (anything else — no animation).
 */
export function historyStep(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length < 1) return 'reset';
  if (sameSeries(previous, next)) return 'same';
  if (next.length === previous.length + 1 && sameSeries(previous, next.slice(0, -1))) return 'append';
  if (next.length === previous.length && sameSeries(previous.slice(1), next.slice(0, -1))) return 'shift';
  return 'reset';
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
  // 采样柱: one HTML block per sample. HTML (not a stretched SVG) keeps ink edges crisp.
  const track = element('div', { className: 'metric-track' });
  const bars = [];
  const barWindow = element('div', { className: 'metric-bars' }, [track]);
  const rules = metricThresholds.map((threshold) => element('span', {
    className: 'metric-rule',
    attributes: { 'data-threshold': threshold },
  }, [element('span', { className: 'metric-rule-label', text: String(threshold) })]));
  const stage = element('div', {
    className: 'metric-stage',
    attributes: { role: 'img', 'aria-label': `${label}真实采样变化`, hidden: '' },
  }, [barWindow, ...rules]);
  const stat = (name, key) => {
    const keyNode = element('span', { className: 'metric-stat-key', text: key });
    const valueNode = element('span', { className: 'metric-stat-value', text: '—' });
    return {
      key: keyNode,
      value: valueNode,
      cell: element('span', { className: 'metric-stat', attributes: { 'data-stat': name } }, [keyNode, valueNode]),
    };
  };
  const minStat = stat('min', 'MIN');
  const maxStat = stat('max', 'MAX');
  const nowStat = stat('now', 'NOW');
  // The stage's aria-label already speaks these figures; the strip is visual only.
  const readout = element('div', {
    className: 'metric-readout',
    attributes: { 'aria-hidden': 'true', hidden: '' },
  }, [minStat.cell, maxStat.cell, nowStat.cell]);
  const chart = element('div', { className: 'metric-chart' }, [chartCaption, stage, readout]);
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
  let shownValue = null;
  let tweenFrame = null;
  let lastHistory = null;

  function formatUsed(value, percent) {
    return percent ? `${numberFormat.format(value)}%` : numberFormat.format(value);
  }

  function formatAmount(value, unit) {
    return unit === '%' ? `${numberFormat.format(value)}%` : `${numberFormat.format(value)} ${unit}`;
  }

  function stopTween() {
    if (tweenFrame !== null) globalThis.cancelAnimationFrame?.(tweenFrame);
    tweenFrame = null;
  }

  /** Counts from the previous reading to the new one; the final text is always exact. */
  function showUsed(value, percent) {
    const from = shownValue;
    shownValue = value;
    stopTween();
    if (from === null || from === value || !motionAllowed()) {
      setText(used, formatUsed(value, percent));
      return;
    }
    const start = globalThis.performance?.now?.() ?? Date.now();
    const step = (time) => {
      const t = Math.min(1, (time - start) / tweenMs);
      const current = t >= 1 ? value : from + (value - from) * easeOut(t);
      setText(used, formatUsed(t >= 1 ? value : Math.round(current * 100) / 100, percent));
      tweenFrame = t >= 1 ? null : globalThis.requestAnimationFrame(step);
    };
    tweenFrame = globalThis.requestAnimationFrame(step);
  }

  /** One bar per sample; nodes are reused and surplus ones hidden, never re-created. */
  function renderBars(history, capacity) {
    const count = history.length;
    while (bars.length < count) {
      const bar = element('span', { className: 'metric-bar' });
      bars.push(bar);
      track.append(bar);
    }
    stage.setAttribute('data-count', String(count));
    for (const [index, bar] of bars.entries()) {
      if (index >= count) {
        bar.setAttribute('hidden', '');
        bar.removeAttribute('data-live');
        continue;
      }
      const ratio = Math.max(0, Math.min(1, history[index] / capacity));
      bar.removeAttribute('hidden');
      bar.setAttribute('data-band', loadBand(ratio));
      bar.toggleAttribute('data-live', index === count - 1);
      // CSSOM, not a style attribute: the site CSP is style-src 'self'.
      bar.style?.setProperty('--h', ratio.toFixed(3));
    }
  }

  /** Distance between two settled (non-live) bars, i.e. one sample step in pixels. */
  function slotDistance(count) {
    const left = bars[count - 3]?.offsetLeft;
    const right = bars[count - 2]?.offsetLeft;
    if (Number.isFinite(left) && Number.isFinite(right) && right > left) return `${right - left}px`;
    return `calc(100% / ${count})`;
  }

  /** A full window slides left by one sample; the new live bar grows up from the baseline. */
  function animateStep(step, count) {
    if ((step !== 'shift' && step !== 'append') || count < 2) return;
    if (!showHistory || mode !== 'wave' || !motionAllowed()) return;
    if (step === 'shift' && typeof track.animate === 'function') {
      track.animate([{ transform: `translateX(${slotDistance(count)})` }, { transform: 'translateX(0)' }],
        { duration: tweenMs, easing: slideEasing });
    }
    const live = bars[count - 1];
    if (!live) return;
    live.setAttribute('data-grow', '');
    void live.offsetWidth; // Commit scaleY(0) so removing the flag runs the CSS transition.
    live.removeAttribute('data-grow');
  }

  function setLoad(ratio) {
    const band = loadBand(ratio);
    if (!band) {
      section.removeAttribute('data-load');
      section.style?.removeProperty('--load');
      return;
    }
    section.setAttribute('data-load', band);
    // CSSOM, not a style attribute: the site CSP is style-src 'self'.
    section.style?.setProperty('--load', Math.max(0, Math.min(1, ratio)).toFixed(3));
  }

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
      stopTween();
      shownValue = null;
      lastHistory = null;
      setLoad(null);
      setText(used, '—');
      setText(total, '');
      setText(percentage, loading ? pendingLabel : unavailableLabel);
      setText(available, '');
      setText(capacityNote, '');
      progress.setAttribute('value', '0');
      progress.setAttribute('max', '1');
      progress.setAttribute('aria-label', `${label}数据暂不可用`);
      stage.setAttribute('hidden', '');
      readout.setAttribute('hidden', '');
      setText(chartCaption, loading ? '等待首次采样' : '暂无采样数据');
      syncChrome();
      return;
    }

    const percent = shown.unit === '%';
    showUsed(shown.used, percent);
    setLoad(shown.used / shown.total);
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

    const { history } = shown;
    const charted = history.length >= 2;
    stage.toggleAttribute('hidden', !charted);
    readout.toggleAttribute('hidden', !charted);
    if (charted) {
      const step = historyStep(lastHistory, history);
      renderBars(history, shown.total);
      const low = formatAmount(Math.min(...history), shown.unit);
      const high = formatAmount(Math.max(...history), shown.unit);
      const now = formatAmount(shown.used, shown.unit);
      setText(minStat.value, low);
      setText(maxStat.value, high);
      setText(nowStat.key, old ? 'LAST' : 'NOW');
      setText(nowStat.value, now);
      stage.setAttribute('aria-label', `${label}${lastReadingSimulated ? '示例趋势' : '真实采样变化'}：`
        + `最近 ${history.length} 次，最低 ${low}，最高 ${high}，${old ? '上次读数' : '当前'} ${now}`);
      animateStep(step, history.length);
    }
    lastHistory = history.slice();
    setText(chartCaption, lastReadingSimulated ? '示例趋势'
      : !charted ? '采样积累中' : `最近 ${history.length} 次真实采样`);
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
