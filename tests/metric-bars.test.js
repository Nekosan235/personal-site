import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricPanel, historyStep, metricThresholds, setMetricViewMode } from '../public/assets/components/metric.js';

class Node {
  children = []; attributes = new Map(); className = ''; value = ''; log = []; animations = [];
  append(...c) { this.children.push(...c); }
  set textContent(v) { this.value = String(v); this.children = []; }
  get textContent() { return this.value + this.children.map((c) => c.textContent).join(''); }
  setAttribute(n, v) { this.log.push(`+${n}`); this.attributes.set(n, String(v)); if (n === 'class') this.className = String(v); }
  getAttribute(n) { return this.attributes.get(n) ?? null; }
  hasAttribute(n) { return this.attributes.has(n); }
  removeAttribute(n) { this.log.push(`-${n}`); this.attributes.delete(n); }
  toggleAttribute(n, on) { if (on) this.setAttribute(n, ''); else this.removeAttribute(n); }
  addEventListener() {}
  animate(keyframes, options) { this.animations.push({ keyframes, options }); return {}; }
  style = { props: new Map(), setProperty(k, v) { this.props.set(k, String(v)); }, removeProperty(k) { this.props.delete(k); } };
  classList = { toggle() {} };
}
const all = (node, name) => (node.className.split(/\s+/).includes(name) ? [node] : [])
  .concat(node.children.flatMap((c) => all(c, name)));
const find = (node, name) => all(node, name)[0] ?? null;
const visible = (node) => all(node, 'metric-bar').filter((bar) => !bar.hasAttribute('hidden'));
const every = (node) => [node, ...node.children.flatMap(every)];

function withDom(fn, { motion = false } = {}) {
  const previous = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = {
    createElement: () => new Node(), createElementNS: () => new Node(),
    documentElement: { getAttribute: () => 'full' },
  };
  if (motion) {
    // Run count-up frames synchronously to completion so text assertions stay exact.
    globalThis.requestAnimationFrame = (callback) => { callback(performance.now() + 10_000); return 1; };
    globalThis.cancelAnimationFrame = () => {};
  }
  setMetricViewMode('wave', null);
  try { return fn(); } finally {
    globalThis.document = previous.document;
    if (previous.raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previous.raf;
    if (previous.caf === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previous.caf;
  }
}

const cpu = (history, used = history.at(-1)) => ({ used, total: 100, available: 100 - used, unit: '%', history });

test('history steps classify append, shift, same and reset', () => {
  assert.equal(historyStep(null, [1, 2]), 'reset');
  assert.equal(historyStep([1, 2], [1, 2]), 'same');
  assert.equal(historyStep([1, 2], [1, 2, 3]), 'append');
  assert.equal(historyStep([1, 2, 3], [2, 3, 4]), 'shift');
  assert.equal(historyStep([1, 2, 3], [9, 9]), 'reset');
  assert.deepEqual([...metricThresholds], [60, 85]);
});

test('one bar per sample with band, height and a single live bar', () => withDom(() => {
  const panel = createMetricPanel('CPU', { metric: 'cpu' });
  panel.update(cpu([10, 65, 90, 18.4]));
  const bars = visible(panel.element);
  assert.equal(bars.length, 4);
  assert.deepEqual(bars.map((bar) => bar.getAttribute('data-band')), ['calm', 'busy', 'hot', 'calm']);
  assert.deepEqual(bars.map((bar) => bar.style.props.get('--h')), ['0.100', '0.650', '0.900', '0.184']);
  assert.deepEqual(bars.map((bar) => bar.hasAttribute('data-live')), [false, false, false, true]);
  assert.equal(find(panel.element, 'metric-stage').getAttribute('data-count'), '4');
  const rules = all(panel.element, 'metric-rule');
  assert.deepEqual(rules.map((rule) => rule.getAttribute('data-threshold')), ['60', '85']);
  assert.deepEqual(rules.map((rule) => rule.textContent), ['60', '85']);
  const stats = all(panel.element, 'metric-stat');
  assert.deepEqual(stats.map((cell) => cell.getAttribute('data-stat')), ['min', 'max', 'now']);
  assert.deepEqual(stats.map((cell) => cell.textContent), ['MIN10%', 'MAX90%', 'NOW18.4%']);
  assert.equal(find(panel.element, 'metric-readout').getAttribute('aria-hidden'), 'true');
  assert.equal(find(panel.element, 'metric-stage').getAttribute('role'), 'img');
  assert.equal(find(panel.element, 'metric-stage').getAttribute('aria-label'),
    'CPU真实采样变化：最近 4 次，最低 10%，最高 90%，当前 18.4%');
  assert.match(panel.element.textContent, /最近 4 次真实采样/);
  for (const node of every(panel.element)) assert.equal(node.getAttribute('style'), null);
}));

test('GiB panels show units in the readout; the window caps at 60 and shrinks without stray bars', () => withDom(() => {
  const panel = createMetricPanel('内存', { metric: 'memory' });
  const long = Array.from({ length: 70 }, (_, index) => 0.5 + (index % 10) / 10);
  panel.update({ used: 1.4, total: 2, available: 0.6, unit: 'GiB', history: long });
  assert.equal(visible(panel.element).length, 60);
  assert.equal(all(panel.element, 'metric-bar').length, 60);
  assert.equal(find(panel.element, 'metric-readout').textContent, 'MIN0.5 GiBMAX1.4 GiBNOW1.4 GiB');
  panel.update({ used: 0.6, total: 2, available: 1.4, unit: 'GiB', history: [0.5, 0.6, 0.6] });
  const bars = all(panel.element, 'metric-bar');
  assert.equal(bars.length, 60, 'nodes are reused, not re-created');
  assert.equal(visible(panel.element).length, 3);
  assert.deepEqual(bars.filter((bar) => bar.hasAttribute('data-live')), [bars[2]]);
  assert.equal(find(panel.element, 'metric-readout').textContent, 'MIN0.5 GiBMAX0.6 GiBNOW0.6 GiB');
}));

test('stale panels keep the bars and relabel NOW as LAST; simulated data says 示例趋势', () => withDom(() => {
  const panel = createMetricPanel('CPU', { metric: 'cpu' });
  panel.update(cpu([20, 30]));
  panel.update(null, { stale: true });
  assert.equal(panel.element.getAttribute('data-stale'), '');
  assert.equal(visible(panel.element).length, 2);
  assert.equal(find(panel.element, 'metric-stage').getAttribute('hidden'), null);
  assert.equal(find(panel.element, 'metric-readout').textContent, 'MIN20%MAX30%LAST30%');
  assert.match(find(panel.element, 'metric-stage').getAttribute('aria-label'), /上次读数 30%$/);
  panel.update(cpu([20, 30]));
  assert.equal(all(panel.element, 'metric-stat-key')[2].textContent, 'NOW');

  const demo = createMetricPanel('硬盘');
  demo.update({ used: 8, total: 40, available: 30, history: [7, 8] }, { simulated: true });
  assert.equal(find(demo.element, 'chart-caption').textContent, '示例趋势');
  assert.match(find(demo.element, 'metric-stage').getAttribute('aria-label'), /^硬盘示例趋势：/);
}));

test('a full window slides left and the new live bar grows only when motion is allowed', () => {
  withDom(() => {
    const panel = createMetricPanel('CPU', { metric: 'cpu' });
    const track = find(panel.element, 'metric-track');
    panel.update(cpu([10, 20, 30]));
    assert.equal(track.animations.length, 0, 'first render does not animate');
    panel.update(cpu([10, 20, 30]));
    assert.equal(track.animations.length, 0, 'identical data does not animate');
    panel.update(cpu([20, 30, 40]));
    assert.equal(track.animations.length, 1);
    const [{ keyframes, options }] = track.animations;
    assert.match(keyframes[0].transform, /^translateX\(/);
    assert.equal(keyframes[1].transform, 'translateX(0)');
    assert.equal(options.duration, 600);
    const live = visible(panel.element).at(-1);
    assert.deepEqual(live.log.slice(-2), ['+data-grow', '-data-grow']);
    assert.equal(live.hasAttribute('data-grow'), false);
    assert.equal(find(panel.element, 'metric-used').textContent, '40%');

    panel.update(cpu([20, 30, 40, 50]));
    assert.equal(track.animations.length, 1, 'a growing window does not slide');
    assert.deepEqual(visible(panel.element).at(-1).log.slice(-2), ['+data-grow', '-data-grow']);

    panel.setViewMode('bar');
    panel.update(cpu([30, 40, 50, 60]));
    assert.equal(track.animations.length, 1, 'hidden chart does not animate');
    for (const node of every(panel.element)) assert.equal(node.getAttribute('style'), null);
  }, { motion: true });

  withDom(() => {
    const panel = createMetricPanel('CPU', { metric: 'cpu' });
    panel.update(cpu([10, 20, 30]));
    panel.update(cpu([20, 30, 40]));
    assert.equal(find(panel.element, 'metric-track').animations.length, 0);
    assert.equal(visible(panel.element).some((bar) => bar.log.includes('+data-grow')), false);
  });
});
