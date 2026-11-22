import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { loadBand, motionAllowed, createMetricPanel } from '../public/assets/components/metric.js';

const css = await readFile(fileURLToPath(new URL('../public/assets/styles.css', import.meta.url)), 'utf8');
const bootstrap = await readFile(fileURLToPath(new URL('../public/assets/theme-bootstrap.js', import.meta.url)), 'utf8');

class Node {
  children = []; attributes = new Map(); className = ''; value = '';
  append(...c) { this.children.push(...c); }
  set textContent(v) { this.value = String(v); this.children = []; }
  get textContent() { return this.value + this.children.map((c) => c.textContent).join(''); }
  setAttribute(n, v) { this.attributes.set(n, String(v)); if (n === 'class') this.className = String(v); }
  getAttribute(n) { return this.attributes.get(n) ?? null; }
  removeAttribute(n) { this.attributes.delete(n); }
  toggleAttribute(n, on) { if (on) this.setAttribute(n, ''); else this.removeAttribute(n); }
  addEventListener() {}
  style = { props: new Map(), setProperty(k, v) { this.props.set(k, String(v)); }, removeProperty(k) { this.props.delete(k); } };
  classList = { toggle() {} };
}
const find = (node, name) => node.className.split(/\s+/).includes(name) ? node
  : node.children.map((c) => find(c, name)).find(Boolean) ?? null;
function withDom(fn) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new Node(), createElementNS: () => new Node() };
  try { return fn(); } finally { globalThis.document = previous; }
}

test('load bands split at 60% and 85%', () => {
  assert.equal(loadBand(0.1), 'calm');
  assert.equal(loadBand(0.6), 'busy');
  assert.equal(loadBand(0.849), 'busy');
  assert.equal(loadBand(0.85), 'hot');
  assert.equal(loadBand(Number.NaN), null);
});

test('motion is off without animation frames, with reduced motion, or with data-motion=off', () => {
  assert.equal(motionAllowed({}), false);
  const root = (level) => ({ documentElement: { getAttribute: () => level } });
  assert.equal(motionAllowed({ requestAnimationFrame() {}, matchMedia: () => ({ matches: true }) }), false);
  assert.equal(motionAllowed({ requestAnimationFrame() {}, matchMedia: () => ({ matches: false }), document: root('off') }), false);
  assert.equal(motionAllowed({ requestAnimationFrame() {}, matchMedia: () => ({ matches: false }), document: root('full') }), true);
});

test('metric panels publish load for CSS and show the exact final value', () => withDom(() => {
  const panel = createMetricPanel('CPU', { metric: 'cpu' });
  panel.update({ used: 91, total: 100, unit: '%', history: [80, 91] });
  assert.equal(panel.element.getAttribute('data-load'), 'hot');
  assert.equal(panel.element.style.props.get('--load'), '0.910');
  assert.equal(panel.element.getAttribute('style'), null);
  assert.equal(find(panel.element, 'metric-used').textContent, '91%');
  const live = find(panel.element, 'metric-track').children[1];
  assert.equal(live.getAttribute('data-live'), '');
  assert.equal(live.getAttribute('data-band'), 'hot');
  assert.equal(live.style.props.get('--h'), '0.910');
  assert.equal(live.getAttribute('style'), null);
  assert.equal(find(panel.element, 'metric-stage').getAttribute('hidden'), null);
  panel.update({ used: 30, total: 100, unit: '%', history: [80, 91, 30] });
  assert.equal(panel.element.getAttribute('data-load'), 'calm');
  panel.update(null, { retainLast: false });
  assert.equal(panel.element.getAttribute('data-load'), null);
  assert.equal(panel.element.style.props.has('--load'), false);
  assert.equal(find(panel.element, 'metric-stage').getAttribute('hidden'), '');
  assert.equal(find(panel.element, 'metric-readout').getAttribute('hidden'), '');
}));

test('bootstrap picks a motion tier from device capability', () => {
  const run = (navigator) => {
    const attrs = new Map();
    runInNewContext(bootstrap, {
      localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }), navigator,
      document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v) } },
    });
    return attrs.get('data-motion');
  };
  assert.equal(run({ hardwareConcurrency: 8, deviceMemory: 8 }), 'full');
  assert.equal(run({ hardwareConcurrency: 2 }), 'lite');
  assert.equal(run({ hardwareConcurrency: 8, connection: { saveData: true } }), 'lite');
  assert.equal(run(undefined), 'full');
});

test('looping effects are gated on the full tier and reduced motion still disables animation', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none !important/);
  const loops = css.match(/[^}]*infinite;/g).filter((rule) => !rule.includes(".loading-indicator"));
  assert.ok(loops.length >= 3);
  for (const rule of loops) assert.match(rule, /:root\[data-motion="full"\]/);
  assert.match(css, /--pulse: 1s/);
});
