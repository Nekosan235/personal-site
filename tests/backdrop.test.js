import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  generateTraces, createBackdrop, quietZone, headingZone, signalPeriod, GRID, SIDEBAR_WIDTH,
} from '../public/assets/components/backdrop.js';

const source = await readFile(fileURLToPath(new URL('../public/assets/components/backdrop.js', import.meta.url)), 'utf8');
const stylesheet = await readFile(fileURLToPath(new URL('../public/assets/styles.css', import.meta.url)), 'utf8');
// The backdrop block is merged at the end of styles.css; check only that block.
const css = stylesheet.slice(stylesheet.indexOf('/* ── Circuit backdrop'));
const seeds = Array.from({ length: 40 }, (_, index) => index * 7919 + 3);

/** Every point along a trace, sampled every 2px. */
function* along(trace) {
  for (let index = 1; index < trace.points.length; index += 1) {
    const a = trace.points[index - 1];
    const b = trace.points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let step = 0; step <= steps; step += 1) {
      yield { x: a.x + ((b.x - a.x) * step) / steps, y: a.y + ((b.y - a.y) * step) / steps };
    }
  }
}

test('generation is deterministic per seed and varies across seeds', () => {
  assert.deepEqual(generateTraces(1440, 900, 42), generateTraces(1440, 900, 42));
  assert.deepEqual(generateTraces(390, 844, 'page'), generateTraces(390, 844, 'page'));
  assert.notDeepEqual(generateTraces(1440, 900, 42).map((t) => t.d), generateTraces(1440, 900, 43).map((t) => t.d));
});

test('traces are well formed: path data matches points, nodes sit on the trace', () => {
  for (const trace of generateTraces(1440, 900, 5)) {
    assert.equal(trace.d, trace.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '));
    assert.equal(typeof trace.pulse, 'boolean');
    assert.ok(trace.length > 0);
    assert.ok(trace.nodes.length >= 1);
    for (const node of trace.nodes) {
      assert.ok(['pad', 'square', 'via'].includes(node.kind));
      assert.ok([...along(trace)].some((p) => Math.hypot(p.x - node.x, p.y - node.y) < 1.5), 'node on trace');
    }
    assert.deepEqual(trace.nodes.at(-1), { ...trace.points.at(-1), kind: trace.nodes.at(-1).kind });
  }
});

test('routes are orthogonal or 45° and every point is in bounds on the 8px grid', () => {
  for (const [width, height] of [[1440, 900], [390, 844], [1024, 768], [1923, 1081], [801, 601]]) {
    for (const seed of seeds) {
      for (const trace of generateTraces(width, height, seed)) {
        for (const p of [...trace.points, ...trace.nodes]) {
          assert.ok(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height, `in bounds ${width}x${height}`);
          assert.equal(p.x % GRID, 0);
          assert.equal(p.y % GRID, 0);
        }
        for (let index = 1; index < trace.points.length; index += 1) {
          const dx = Math.abs(trace.points[index].x - trace.points[index - 1].x);
          const dy = Math.abs(trace.points[index].y - trace.points[index - 1].y);
          assert.ok(dx === 0 || dy === 0 || dx === dy, 'orthogonal or 45°');
          assert.ok(dx + dy > 0, 'no zero-length segments');
        }
      }
    }
  }
});

test('nothing enters the central quiet zone, and desktop pads stay clear of the sidebar', () => {
  assert.deepEqual(quietZone(1000, 1000), { x0: 280, x1: 780, y0: 180, y1: 1000 });
  for (const [width, height] of [[1440, 900], [390, 844], [1280, 720], [2560, 1440]]) {
    const zone = quietZone(width, height);
    for (const seed of seeds) {
      for (const trace of generateTraces(width, height, seed)) {
        for (const p of along(trace)) {
          assert.ok(!(p.x > zone.x0 && p.x < zone.x1 && p.y > zone.y0), `(${p.x},${p.y}) in quiet zone at ${width}x${height}`);
          const head = headingZone(width);
          if (head) assert.ok(!(p.x > head.x0 + 8 && p.x < head.x1 && p.y < head.y1), `(${p.x},${p.y}) behind page heading at ${width}x${height}`);
        }
        if (width >= 992) for (const node of trace.nodes) assert.ok(node.x > SIDEBAR_WIDTH, 'pad hidden under sidebar');
      }
    }
  }
});

test('density: sparse on desktop, at most six edge traces on mobile', () => {
  for (const seed of seeds) {
    const desktop = generateTraces(1440, 900, seed);
    assert.ok(desktop.length >= 10 && desktop.length <= 18, `desktop count ${desktop.length}`);
    const mobile = generateTraces(390, 844, seed);
    assert.ok(mobile.length >= 2 && mobile.length <= 6, `mobile count ${mobile.length}`);
    for (const trace of mobile) for (const p of along(trace)) assert.ok(p.x < 390 * 0.12 || p.x > 390 * 0.88, 'mobile edges only');
    assert.ok(generateTraces(2560, 1440, seed).length <= 18);
  }
  assert.deepEqual(generateTraces(0, 0, 1), []);
  assert.deepEqual(generateTraces(Number.NaN, 900, 1), []);
});

test('three to six pulses on desktop, fewer on mobile', () => {
  for (const seed of seeds) {
    const desktop = generateTraces(1440, 900, seed).filter((t) => t.pulse).length;
    assert.ok(desktop >= 3 && desktop <= 6, `desktop pulses ${desktop}`);
    const mobile = generateTraces(390, 844, seed).filter((t) => t.pulse).length;
    assert.ok(mobile >= 1 && mobile <= 3, `mobile pulses ${mobile}`);
  }
});

test('signal period maps CPU 0 → 7s and 1 → 1.6s, monotonic, invalid input calm', () => {
  assert.equal(signalPeriod(0), 7);
  assert.equal(signalPeriod(1), 1.6);
  assert.equal(signalPeriod(Number.NaN), 7);
  assert.equal(signalPeriod('0.9'), 7);
  assert.equal(signalPeriod(5), 1.6);
  let previous = Infinity;
  for (let r = 0; r <= 1.0001; r += 0.05) {
    const value = signalPeriod(r);
    assert.ok(value <= previous);
    previous = value;
  }
});

// ── Fake DOM ────────────────────────────────────────────────────────────────
class FakeNode {
  constructor(name, { withStyle = true } = {}) {
    this.name = name;
    this.children = [];
    this.attributes = new Map();
    this.parent = null;
    this.setAttributeCalls = [];
    if (withStyle) this.style = { props: new Map(), setProperty(k, v) { this.props.set(k, String(v)); } };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(n, v) { this.setAttributeCalls.push(n); this.attributes.set(n, String(v)); }
  getAttribute(n) { return this.attributes.get(n) ?? null; }
  hasAttribute(n) { return this.attributes.has(n); }
  removeAttribute(n) { this.attributes.delete(n); }
  set textContent(_) { this.children = []; }
  get classes() { return (this.getAttribute('class') ?? '').split(/\s+/); }
}
class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
function fakeDom({ withStyle = true, raf = false } = {}) {
  const created = [];
  const make = (name, ns) => { const n = new FakeNode(name, { withStyle }); n.ns = ns; created.push(n); return n; };
  const doc = Object.assign(new Events(), {
    visibilityState: 'visible',
    createElement: (name) => make(name, null),
    createElementNS: (ns, name) => make(name, ns),
  });
  const frames = [];
  const win = Object.assign(new Events(), { innerWidth: 1440, innerHeight: 900 });
  if (raf) {
    win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    win.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
  }
  const root = new FakeNode('body');
  root.append(new FakeNode('main'));
  const flush = () => { const queue = frames.splice(0); for (const fn of queue) fn?.(); };
  return { doc, win, root, created, flush };
}
const all = (node) => [node, ...node.children.flatMap(all)];
const byClass = (node, name) => all(node).filter((n) => n.classes?.includes(name));

test('createBackdrop builds an aria-hidden SVG of traces, pads and pulses, prepended to root', () => {
  const { doc, win, root } = fakeDom();
  const backdrop = createBackdrop({ root, win, doc, seed: 11 });
  const { element } = backdrop;
  assert.equal(root.children[0], element);
  assert.equal(element.getAttribute('class'), 'backdrop');
  assert.equal(element.getAttribute('aria-hidden'), 'true');
  const svg = element.children[0];
  assert.equal(svg.name, 'svg');
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('class'), 'backdrop-svg');

  const expected = generateTraces(1440, 904, 11);
  const traces = byClass(element, 'backdrop-trace');
  assert.equal(traces.length, expected.length);
  assert.deepEqual(traces.map((t) => t.getAttribute('d')), expected.map((t) => t.d));
  assert.equal(byClass(element, 'backdrop-node').length, expected.reduce((n, t) => n + t.nodes.length, 0));

  const pulses = byClass(element, 'backdrop-pulse').filter((p) => !p.classes.includes('backdrop-pulse-glow'));
  assert.equal(pulses.length, expected.filter((t) => t.pulse).length);
  for (const pulse of pulses) {
    assert.equal(pulse.getAttribute('pathLength'), '100');
    assert.equal(pulse.getAttribute('stroke-dasharray'), '6 94');
    assert.match(pulse.style.props.get('--pulse-k'), /^\d+\.\d\d$/);
    assert.match(pulse.style.props.get('--pulse-delay'), /^-?\d+\.\d\ds$/);
  }
  // Initial state is calm.
  assert.equal(element.getAttribute('data-activity'), 'calm');
  assert.equal(element.style.props.get('--signal-period'), '7s');
  backdrop.stop();
});

test('setActivity sets --signal-period and load bands at 0.6 / 0.85; invalid input falls back to calm', () => {
  const { doc, win, root } = fakeDom();
  const { element, setActivity, stop } = createBackdrop({ root, win, doc, seed: 1 });
  const period = () => element.style.props.get('--signal-period');
  setActivity(0);
  assert.equal(period(), '7s');
  assert.equal(element.getAttribute('data-activity'), 'calm');
  setActivity(1);
  assert.equal(period(), '1.6s');
  assert.equal(element.getAttribute('data-activity'), 'hot');
  setActivity(0.599);
  assert.equal(element.getAttribute('data-activity'), 'calm');
  setActivity(0.6);
  assert.equal(element.getAttribute('data-activity'), 'busy');
  setActivity(0.849);
  assert.equal(element.getAttribute('data-activity'), 'busy');
  setActivity(0.85);
  assert.equal(element.getAttribute('data-activity'), 'hot');
  assert.ok(parseFloat(period()) < 2.5 && parseFloat(period()) > 1.6);
  for (const bad of [Number.NaN, undefined, null, '0.9', Infinity, {}]) {
    setActivity(1);
    setActivity(bad);
    assert.equal(element.getAttribute('data-activity'), 'calm');
    assert.equal(period(), '7s');
  }
  setActivity(-3);
  assert.equal(element.getAttribute('data-activity'), 'calm');
  stop();
});

test('visibility toggles data-paused; resize regenerates once per frame and skips tiny changes', () => {
  const { doc, win, root, flush } = fakeDom({ raf: true });
  const { element, stop } = createBackdrop({ root, win, doc, seed: 9 });
  doc.visibilityState = 'hidden';
  doc.emit('visibilitychange');
  assert.equal(element.hasAttribute('data-paused'), true);
  doc.visibilityState = 'visible';
  doc.emit('visibilitychange');
  assert.equal(element.hasAttribute('data-paused'), false);

  const svg = element.children[0];
  const first = svg.children[0];
  win.innerWidth = 1446;
  win.emit('resize');
  flush();
  assert.equal(svg.children[0], first, 'tiny change ignored');

  win.innerWidth = 390;
  win.innerHeight = 844;
  win.emit('resize');
  win.emit('resize');
  flush();
  assert.notEqual(svg.children[0], first);
  assert.deepEqual(byClass(element, 'backdrop-trace').map((t) => t.getAttribute('d')), generateTraces(392, 848, 9).map((t) => t.d));

  const mobile = svg.children[0];
  win.innerHeight = 760; // URL bar shrink on mobile
  win.emit('resize');
  flush();
  assert.equal(svg.children[0], mobile);
  stop();
});

test('stop() and signal abort remove listeners and the element', () => {
  const dom = fakeDom({ raf: true });
  const backdrop = createBackdrop({ root: dom.root, win: dom.win, doc: dom.doc, seed: 2 });
  assert.ok(dom.win.count() > 0 && dom.doc.count() > 0);
  dom.win.emit('resize');
  backdrop.stop();
  assert.equal(dom.root.children.includes(backdrop.element), false);
  assert.equal(dom.win.count(), 0);
  assert.equal(dom.doc.count(), 0);
  dom.flush();
  backdrop.stop();

  const other = fakeDom();
  const controller = new AbortController();
  const aborted = createBackdrop({ root: other.root, win: other.win, doc: other.doc, signal: controller.signal });
  assert.equal(other.root.children[0], aborted.element);
  controller.abort();
  assert.equal(other.root.children.includes(aborted.element), false);
  assert.equal(other.win.count() + other.doc.count(), 0);

  const early = new AbortController();
  early.abort();
  const inert = createBackdrop({ root: other.root, win: other.win, doc: other.doc, signal: early.signal });
  assert.equal(inert.element, null);
  assert.doesNotThrow(() => { inert.setActivity(0.5); inert.refresh(); inert.stop(); });
});

test('a bare fake DOM without style, matchMedia or requestAnimationFrame does not throw', () => {
  const { doc, root } = fakeDom({ withStyle: false });
  const win = { innerWidth: 800, innerHeight: 600 };
  let backdrop;
  assert.doesNotThrow(() => {
    backdrop = createBackdrop({ root, win, doc, seed: 3 });
    backdrop.setActivity(0.9);
    backdrop.refresh();
  });
  assert.equal(backdrop.element.getAttribute('data-activity'), 'hot');
  assert.doesNotThrow(() => backdrop.stop());
  assert.doesNotThrow(() => createBackdrop({ doc: undefined }));
});

test('never sets the style attribute (CSP style-src self)', () => {
  const { doc, win, root, created } = fakeDom();
  const backdrop = createBackdrop({ root, win, doc, seed: 4 });
  backdrop.setActivity(0.7);
  backdrop.refresh();
  for (const node of created) {
    assert.equal(node.setAttributeCalls.includes('style'), false);
    assert.equal(node.hasAttribute('style'), false);
  }
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/);
  assert.doesNotMatch(source, /style\s*=\s*["']/);
  assert.doesNotMatch(source, /\.style\.cssText|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  backdrop.stop();
});

test('stylesheet: looping only under data-motion="full", pause and reduced-motion friendly', () => {
  const loops = css.match(/[^}]*infinite;/g);
  assert.ok(loops.length >= 1);
  for (const rule of loops) assert.match(rule, /:root\[data-motion="full"\]/);
  assert.match(css, /@keyframes backdrop-run \{ from \{ stroke-dashoffset: 100; \} to \{ stroke-dashoffset: 0; \} \}/);
  assert.match(css, /calc\(var\(--signal-period, 7s\) \* var\(--pulse-k, 1\)\)/);
  assert.match(css, /var\(--pulse-delay, 0s\)/);
  assert.match(css, /\.backdrop\[data-paused\] \.backdrop-pulse \{ animation-play-state: paused; \}/);
  assert.match(css, /\.backdrop-pulse \{[^}]*opacity: 0;/, 'pulses hidden unless motion is full');
  assert.match(css, /\.backdrop \{[^}]*position: fixed;[^}]*pointer-events: none;/);
  assert.match(css, /vector-effect: non-scaling-stroke/);
  for (const colour of css.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []) assert.fail(`hard-coded colour ${colour}`);
  assert.doesNotMatch(css, /filter:|url\(/);
});
