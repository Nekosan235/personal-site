// Same thresholds as metric.js loadBand; copied so the login page needs no protected module.
function loadBand(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  if (ratio >= 0.85) return 'hot';
  if (ratio >= 0.6) return 'busy';
  return 'calm';
}

/**
 * Decorative circuit backdrop: sparse PCB-style traces along the viewport edges,
 * with a few signal pulses whose speed follows server CPU load.
 *
 * Trace shape returned by generateTraces():
 *   {
 *     d: string,                       // SVG path data, "M x y L x y …" (integers, 8px grid)
 *     points: [{ x, y }],              // the drawn polyline, chamfer points included
 *     nodes: [{ x, y, kind }],         // kind: 'pad' (ring) | 'square' (SMD pad) | 'via' (dot on a bend)
 *     pulse: boolean,                  // carries an animated signal pulse
 *     length: number,                  // drawn length in px
 *     group: number,                   // traces generated together as one bus share a group
 *   }
 * Routes are orthogonal with 45° chamfered corners. Pulses travel from the first
 * point to the last; traces entering from a viewport edge start off-screen-side.
 */

export const GRID = 8;
export const MOBILE_BREAKPOINT = 760;
export const SIDEBAR_BREAKPOINT = 992;
export const SIDEBAR_WIDTH = 248;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SLOW_PERIOD = 7;
const FAST_PERIOD = 1.6;
const BUS_SPACING = 16;
const BUS_CHAMFER_STEP = 24; // ≈ 16px × √2, keeps parallel diagonals evenly spaced

const floorGrid = (value) => Math.floor(value / GRID) * GRID;
const ceilGrid = (value) => Math.ceil(value / GRID) * GRID;
const roundGrid = (value) => Math.round(value / GRID) * GRID;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function hashSeed(seed) {
  const text = String(seed ?? 0);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: tiny, fast, deterministic. */
function random(seed) {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The off-limits reading area. Desktop: x in [0.28w, 0.78w] below 0.18h.
 * Mobile (< 760px): everything except thin strips at the left and right edges.
 */
export function quietZone(width, height) {
  if (width < MOBILE_BREAKPOINT) return { x0: width * 0.12, x1: width * 0.88, y0: 0, y1: height };
  return { x0: width * 0.28, x1: width * 0.78, y0: height * 0.18, y1: height };
}

/**
 * Page headings sit on bare ground at the top-left of the content column, so
 * that block stays clear too: from the sidebar edge to 62% of the remaining
 * width, top 300px. Mobile already keeps everything but the edge strips quiet.
 */
export function headingZone(width) {
  if (width < MOBILE_BREAKPOINT) return null;
  const left = width >= SIDEBAR_BREAKPOINT ? SIDEBAR_WIDTH : 0;
  return { x0: left, x1: left + (width - left) * 0.62, y0: 0, y1: 300 };
}

const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const perpendicular = (dir) => (dir[0] === 0 ? [DIRS.left, DIRS.right] : [DIRS.up, DIRS.down]);

function context(width, height) {
  const w = floorGrid(Math.max(0, width));
  const h = floorGrid(Math.max(0, height));
  const mobile = width < MOBILE_BREAKPOINT;
  const sidebar = width >= SIDEBAR_BREAKPOINT ? SIDEBAR_WIDTH : 0;
  const zone = quietZone(width, height);
  const heading = headingZone(width);
  const cols = w / GRID + 1;
  const rows = h / GRID + 1;
  return { width, height, w, h, mobile, sidebar, zone, heading, cols, rows, occupied: new Uint8Array(cols * rows) };
}

/** Quiet zone grown by one grid step so nothing even grazes it. */
function inZone(ctx, x, y) {
  const { x0, x1, y0, y1 } = ctx.zone;
  if (x > x0 - GRID && x < x1 + GRID && y > y0 - GRID && y <= y1) return true;
  const head = ctx.heading;
  return Boolean(head) && x > head.x0 + GRID && x < head.x1 + GRID && y >= head.y0 && y < head.y1 + GRID;
}

function occupiedNear(ctx, x, y) {
  const cx = Math.round(x / GRID);
  const cy = Math.round(y / GRID);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const col = cx + dx;
      const row = cy + dy;
      if (col >= 0 && row >= 0 && col < ctx.cols && row < ctx.rows && ctx.occupied[row * ctx.cols + col]) return true;
    }
  }
  return false;
}

function blocked(ctx, x, y, { underSidebar = false } = {}) {
  if (x < 0 || y < 0 || x > ctx.w || y > ctx.h) return true;
  if (inZone(ctx, x, y)) return true;
  if (!underSidebar && ctx.sidebar && x < ctx.sidebar + 2 * GRID) return true;
  return occupiedNear(ctx, x, y);
}

/** How far (px) a route can travel from (x, y) in dir before hitting something. */
function reach(ctx, x, y, dir, options) {
  let distance = 0;
  for (;;) {
    const nx = x + dir[0] * (distance + GRID);
    const ny = y + dir[1] * (distance + GRID);
    if (blocked(ctx, nx, ny, options)) return distance;
    distance += GRID;
  }
}

/** Sample points along a polyline every 4px. */
function* samples(points) {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let step = 0; step <= steps; step += 1) {
      yield { x: a.x + ((b.x - a.x) * step) / steps, y: a.y + ((b.y - a.y) * step) / steps };
    }
  }
}

function mark(ctx, points) {
  for (const { x, y } of samples(points)) {
    const col = Math.round(x / GRID);
    const row = Math.round(y / GRID);
    if (col >= 0 && row >= 0 && col < ctx.cols && row < ctx.rows) ctx.occupied[row * ctx.cols + col] = 1;
  }
}

function valid(ctx, points, edgeStart) {
  for (const p of points) {
    if (p.x < 0 || p.y < 0 || p.x > ctx.w || p.y > ctx.h || p.x % GRID || p.y % GRID) return false;
  }
  for (const s of samples(points)) {
    if (inZone(ctx, s.x, s.y) || occupiedNear(ctx, s.x, s.y)) return false;
  }
  const end = points[points.length - 1];
  if (ctx.sidebar && end.x < ctx.sidebar + 2 * GRID) return false;
  if (!edgeStart && ctx.sidebar && points[0].x < ctx.sidebar + 2 * GRID) return false;
  return true;
}

const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
const direction = (a, b) => [sign(b.x - a.x), sign(b.y - a.y)];
const turnsLeft = (din, dout) => din[0] * dout[1] - din[1] * dout[0] < 0; // screen coords, y down

/** Offset an orthogonal polyline sideways (left-hand normal) by `offset` px. */
function offsetPolyline(points, offset) {
  if (!offset) return points.map((p) => ({ ...p }));
  const normals = [];
  for (let index = 1; index < points.length; index += 1) {
    const [dx, dy] = direction(points[index - 1], points[index]);
    normals.push([dy, -dx]);
  }
  return points.map((p, index) => {
    const before = normals[index - 1];
    const after = normals[index];
    let x = p.x;
    let y = p.y;
    if (before) { x += before[0] * offset; y += before[1] * offset; }
    if (after) { x += after[0] * offset; y += after[1] * offset; }
    return { x, y };
  });
}

/**
 * Replace every corner with a 45° chamfer. `chamfers[k]` is the size for corner k
 * (points[k + 1]); returns null when a segment is too short for the requested cuts.
 */
function chamfer(corners, chamfers) {
  const out = [{ ...corners[0] }];
  const bends = [];
  for (let index = 1; index < corners.length - 1; index += 1) {
    const prev = corners[index - 1];
    const p = corners[index];
    const next = corners[index + 1];
    const din = direction(prev, p);
    const dout = direction(p, next);
    const c = chamfers[index - 1];
    out.push({ x: p.x - din[0] * c, y: p.y - din[1] * c });
    out.push({ x: p.x + dout[0] * c, y: p.y + dout[1] * c });
    bends.push({ x: p.x + ((dout[0] - din[0]) * c) / 2, y: p.y + ((dout[1] - din[1]) * c) / 2, c });
  }
  out.push({ ...corners[corners.length - 1] });
  for (let index = 1; index < out.length; index += 1) {
    const a = out[index - 1];
    const b = out[index];
    // Cuts must not overlap and every straight run must keep at least one grid step.
    const straight = index % 2 === 1;
    if (straight && Math.hypot(b.x - a.x, b.y - a.y) < GRID) return null;
    if (straight && (b.x - a.x) * (corners[(index - 1) / 2 + 1].x - corners[(index - 1) / 2].x) < 0) return null;
    if (straight && (b.y - a.y) * (corners[(index - 1) / 2 + 1].y - corners[(index - 1) / 2].y) < 0) return null;
  }
  return { points: out, bends };
}

function pathData(points) {
  return points.map((p, index) => `${index ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
}

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return Math.round(total);
}

function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }
function between(rng, low, high) { return low + rng() * (high - low); }

/** Where routes may start, grouped into regions with a share of the total. */
function regions(ctx) {
  const { w, h, sidebar, mobile, zone } = ctx;
  const left = sidebar ? sidebar + 3 * GRID : 2 * GRID;
  const y = (low, high) => roundGrid(between(ctx.rng, low, high));
  const x = y;
  if (mobile) {
    return [{ share: 1, entries: [
      { weight: 3, edge: true, make: () => ({ x: w, y: y(0.04 * h, 0.96 * h), dir: DIRS.left }) },
      { weight: 3, edge: true, make: () => ({ x: 0, y: y(0.04 * h, 0.96 * h), dir: DIRS.right }) },
      { weight: 1, edge: true, make: (rng) => ({
        x: rng() < 0.5 ? x(8, zone.x0 - 16) : x(zone.x1 + 16, w - 8), y: rng() < 0.5 ? 0 : h, dir: null }) },
    ] }];
  }
  const list = [{ share: 0.45, entries: [
    { weight: 4, edge: true, make: () => ({ x: w, y: y(0.05 * h, 0.95 * h), dir: DIRS.left }) },
    { weight: 1.5, edge: true, make: () => ({ x: x(zone.x1 + 24, w - 16), y: h, dir: DIRS.up }) },
    { weight: 1.5, edge: true, make: () => ({ x: x(zone.x1 + 24, w - 24), y: 0, dir: DIRS.down }) },
    { weight: 1, edge: true, corner: true, make: (rng) => (rng() < 0.5
      ? { x: w, y: rng() < 0.5 ? y(16, 0.08 * h) : y(0.92 * h, h - 16), dir: DIRS.left }
      : { x: x(w - 0.08 * w, w - 16), y: rng() < 0.5 ? 0 : h, dir: null }) },
    { weight: 1, edge: false, make: () => ({ x: x(zone.x1 + 24, w - 24), y: y(16, h - 16), dir: null }) },
  ] }];
  if (zone.y0 >= 64) {
    list.push({ share: 0.3, entries: [
      { weight: 3, edge: true, make: () => ({ x: x(left, zone.x1), y: 0, dir: DIRS.down }) },
      { weight: 1, edge: false, make: () => ({ x: x(left, zone.x1), y: y(16, zone.y0 - 16), dir: null }) },
      { weight: 1, edge: true, underSidebar: true, make: () => ({ x: 0, y: y(16, zone.y0 - 16), dir: DIRS.right }) },
    ] });
  }
  if (zone.x0 - left >= 48) {
    list.push({ share: 0.25, entries: [
      { weight: 2, edge: true, make: () => ({ x: x(left, zone.x0 - 24), y: h, dir: DIRS.up }) },
      { weight: 2, edge: true, underSidebar: true, make: () => ({ x: 0, y: y(zone.y0, 0.95 * h), dir: DIRS.right }) },
      { weight: 1, edge: false, make: () => ({ x: x(left, zone.x0 - 24), y: y(zone.y0, h - 16), dir: null }) },
    ] });
  }
  return list;
}

function chooseEntry(rng, list) {
  const total = list.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of list) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return list[list.length - 1];
}

/** Random orthogonal walk from an entry point; returns corner points or null. */
function walk(ctx, rng, entry) {
  const start = entry.make(rng);
  if (!entry.edge && blocked(ctx, start.x, start.y)) return null;
  let dir = start.dir;
  if (!dir) {
    const options = start.y === 0 ? [DIRS.down] : start.y === ctx.h ? [DIRS.up]
      : [DIRS.left, DIRS.right, DIRS.up, DIRS.down];
    dir = pick(rng, options);
  }
  const corners = [{ x: start.x, y: start.y }];
  // Never double back: once a route has moved along an axis, it keeps that sign.
  const heading = { x: 0, y: 0 };
  const legs = 1 + Math.floor(rng() * (ctx.mobile ? 2 : 3));
  let { x, y } = start;
  const span = Math.max(ctx.w, ctx.h);
  for (let leg = 0; leg <= legs; leg += 1) {
    const underSidebar = Boolean(entry.underSidebar && leg === 0);
    const room = reach(ctx, x, y, dir, { underSidebar });
    let minimum = leg === 0 ? 3 * GRID : 4 * GRID;
    if (underSidebar) minimum = ctx.sidebar + 6 * GRID;
    const maximum = Math.min(room, leg === 0 && entry.edge ? span * 0.5 : span * (ctx.mobile ? 0.4 : 0.26));
    if (maximum < minimum) {
      if (leg === 0) return null;
      break;
    }
    const length = clamp(roundGrid(between(rng, minimum, maximum)), minimum, floorGrid(maximum));
    x += dir[0] * length;
    y += dir[1] * length;
    corners.push({ x, y });
    if (dir[0]) heading.x = dir[0];
    else heading.y = dir[1];
    if (leg === legs) break;
    const [a, b] = perpendicular(dir);
    const allowed = (d) => (d[0] ? !heading.x || heading.x === d[0] : !heading.y || heading.y === d[1]);
    const roomA = allowed(a) ? reach(ctx, x, y, a) : 0;
    const roomB = allowed(b) ? reach(ctx, x, y, b) : 0;
    if (roomA + roomB < 4 * GRID) break;
    dir = rng() * (roomA + roomB) < roomA ? a : b;
  }
  return corners.length >= 2 ? { corners, start, edge: entry.edge, corner: Boolean(entry.corner) } : null;
}

/**
 * Pure and deterministic: same (width, height, seed) → same traces.
 * Coordinates stay inside [0, width] × [0, height] on an 8px grid.
 */
export function generateTraces(width, height, seed = 0) {
  const ctx = context(Number(width) || 0, Number(height) || 0);
  if (ctx.w < 4 * GRID || ctx.h < 4 * GRID) return [];
  const rng = random(`${seed}:${ctx.w}x${ctx.h}`);
  const scale = (ctx.w * ctx.h) / (1440 * 900);
  const target = ctx.mobile
    ? 4 + Math.floor(rng() * 3)
    : clamp(Math.round((12 + Math.floor(rng() * 5)) * clamp(Math.sqrt(scale), 0.7, 1.12)), 8, 18);
  const maximum = ctx.mobile ? 6 : 18;
  ctx.rng = rng;
  const areas = regions(ctx).map((region) => ({ ...region, count: 0, failures: 0 }));
  const traces = [];
  let group = 0;
  let wideBus = false;

  for (let attempt = 0; attempt < 600 && traces.length < target; attempt += 1) {
    // Fill the region furthest behind its share, so no edge ends up crowded.
    const open = areas.filter((region) => region.failures < 80);
    if (!open.length) break;
    const area = open
      .map((region) => ({ region, need: region.share * target - region.count + rng() * 0.75 }))
      .sort((a, b) => b.need - a.need)[0].region;
    const route = walk(ctx, rng, chooseEntry(rng, area.entries));
    if (!route || route.corners.length < 2) { area.failures += 1; continue; }
    const bends = route.corners.length - 2;
    const room = Math.min(target, maximum) - traces.length;
    let count = 1;
    if (route.edge && bends > 0 && room >= 2 && rng() < (ctx.mobile ? 0.15 : 0.4)) count = !wideBus && rng() < 0.5 ? 3 : 2;
    count = Math.min(count, room);
    const base = route.corner ? 40 + 8 * Math.floor(rng() * 3) : rng() < 0.75 ? 16 : 8;

    let tracks = null;
    for (; count >= 1 && !tracks; count -= 1) {
      const built = [];
      for (let index = 0; index < count; index += 1) {
        const corners = offsetPolyline(route.corners, index * BUS_SPACING);
        if (count > 1) {
          // Stagger the far ends of a bus so it doesn't read as a ribbon.
          const last = corners.length - 1;
          const [dx, dy] = direction(corners[last - 1], corners[last]);
          const extra = GRID * (Math.floor(rng() * 5) - 2);
          corners[last] = { x: corners[last].x + dx * extra, y: corners[last].y + dy * extra };
        }
        const sizes = [];
        for (let k = 1; k < corners.length - 1; k += 1) {
          const inside = turnsLeft(direction(corners[k - 1], corners[k]), direction(corners[k], corners[k + 1]));
          const rank = count === 1 ? 0 : inside ? count - 1 - index : index;
          sizes.push(base + BUS_CHAMFER_STEP * rank);
        }
        let shaped = chamfer(corners, sizes);
        if (!shaped && count === 1) {
          shaped = chamfer(corners, sizes.map(() => GRID));
        }
        if (!shaped || !valid(ctx, shaped.points, route.edge)) break;
        built.push({ shaped, corners });
      }
      if (built.length === count) tracks = built;
    }
    if (!tracks) { area.failures += 1; continue; }
    area.count += tracks.length;
    if (tracks.length === 3) wideBus = true;

    const kind = rng() < 0.65 ? 'pad' : 'square';
    for (const { shaped } of tracks) {
      const nodes = [];
      const first = shaped.points[0];
      const last = shaped.points[shaped.points.length - 1];
      if (!route.edge) nodes.push({ x: first.x, y: first.y, kind });
      for (const bend of shaped.bends) {
        if (tracks.length === 1 && bend.c % 16 === 0 && bend.c <= 16 && rng() < 0.35) {
          nodes.push({ x: bend.x, y: bend.y, kind: 'via' });
        }
      }
      nodes.push({ x: last.x, y: last.y, kind });
      traces.push({
        d: pathData(shaped.points),
        points: shaped.points,
        nodes,
        pulse: false,
        length: polylineLength(shaped.points),
        group,
      });
      mark(ctx, shaped.points);
    }
    group += 1;
  }

  // Signal pulses: prefer long routes that enter from an edge, one per bus.
  const wanted = Math.min(traces.length, ctx.mobile ? 2 + Math.floor(rng() * 2) : 3 + Math.floor(rng() * 3));
  const atEdge = ({ x, y }) => x === 0 || y === 0 || x === ctx.w || y === ctx.h;
  const ranked = traces
    .map((trace) => ({ trace, score: trace.length * (atEdge(trace.points[0]) ? 1.4 : 1) * (0.6 + rng() * 0.8) }))
    .filter(({ trace }) => trace.length >= 96)
    .sort((a, b) => b.score - a.score);
  const usedGroups = new Set();
  for (const { trace } of ranked) {
    if (usedGroups.size >= wanted) break;
    if (usedGroups.has(trace.group)) continue;
    usedGroups.add(trace.group);
    trace.pulse = true;
  }
  for (const { trace } of ranked) {
    if (traces.filter((item) => item.pulse).length >= wanted) break;
    trace.pulse = true;
  }
  return traces;
}

/** CPU ratio → pulse period, log-linear so equal load steps feel like equal speed steps. */
export function signalPeriod(ratio) {
  const r = typeof ratio === 'number' && Number.isFinite(ratio) ? clamp(ratio, 0, 1) : 0;
  return Number((SLOW_PERIOD * (FAST_PERIOD / SLOW_PERIOD) ** r).toFixed(1));
}

let pageSeed;
function defaultSeed() {
  pageSeed ??= Math.floor(Math.random() * 2 ** 31);
  return pageSeed;
}

function viewport(win, doc) {
  const width = Number(win?.innerWidth) || Number(doc?.documentElement?.clientWidth) || 0;
  const height = Number(win?.innerHeight) || Number(doc?.documentElement?.clientHeight) || 0;
  return { width, height };
}

function svgElement(doc, name, attributes) {
  const node = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/**
 * Mount the backdrop as the first child of `root`.
 * Returns { element, setActivity(ratio), refresh(), stop() }.
 */
export function createBackdrop({
  root, signal, win = globalThis.window ?? globalThis, doc = globalThis.document, seed,
} = {}) {
  const host = root ?? doc?.body;
  const inert = { element: null, setActivity() {}, refresh() {}, stop() {} };
  if (signal?.aborted || !doc || !host) return inert;

  const traceSeed = seed ?? defaultSeed();
  const element = doc.createElement('div');
  element.setAttribute('class', 'backdrop');
  element.setAttribute('aria-hidden', 'true');
  const svg = svgElement(doc, 'svg', { class: 'backdrop-svg', 'aria-hidden': 'true', focusable: 'false' });
  element.append(svg);
  if (typeof host.prepend === 'function') host.prepend(element);
  else host.append?.(element);

  let stopped = false;
  let frame;
  let drawn = { width: -1, height: -1 };
  let period = null;
  const requestFrame = typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
  const cancelFrame = typeof win?.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null;

  function draw(size = viewport(win, doc)) {
    drawn = size;
    // Generate on a grid-rounded canvas so edge runs reach the real viewport edge.
    const traces = generateTraces(ceilGrid(size.width), ceilGrid(size.height), traceSeed);
    const rng = random(`${traceSeed}:pulses`);
    const layer = svgElement(doc, 'g', { transform: 'translate(.5 .5)' });
    const lines = svgElement(doc, 'g', { class: 'backdrop-traces' });
    const pads = svgElement(doc, 'g', { class: 'backdrop-nodes' });
    const pulses = svgElement(doc, 'g', { class: 'backdrop-pulses' });
    for (const trace of traces) {
      lines.append(svgElement(doc, 'path', { class: 'backdrop-trace', d: trace.d }));
      for (const node of trace.nodes) {
        if (node.kind === 'square') {
          pads.append(svgElement(doc, 'rect', {
            class: 'backdrop-node', 'data-kind': 'square', x: node.x - 2.5, y: node.y - 2.5, width: 5, height: 5,
          }));
        } else {
          pads.append(svgElement(doc, 'circle', {
            class: node.kind === 'via' ? 'backdrop-node backdrop-via' : 'backdrop-node',
            'data-kind': node.kind, cx: node.x, cy: node.y, r: node.kind === 'via' ? 1.75 : 2.75,
          }));
        }
      }
      if (!trace.pulse) continue;
      const k = clamp(trace.length / 640, 0.6, 2).toFixed(2);
      const delay = `${(-rng() * Number(k) * SLOW_PERIOD).toFixed(2)}s`;
      for (const extra of ['backdrop-pulse-glow', '']) {
        const pulse = svgElement(doc, 'path', {
          class: extra ? `backdrop-pulse ${extra}` : 'backdrop-pulse',
          d: trace.d, pathLength: 100, 'stroke-dasharray': '6 94',
        });
        pulse.style?.setProperty?.('--pulse-k', k);
        pulse.style?.setProperty?.('--pulse-delay', delay);
        pulses.append(pulse);
      }
    }
    layer.append(lines, pads, pulses);
    if (typeof svg.replaceChildren === 'function') svg.replaceChildren(layer);
    else {
      svg.textContent = '';
      svg.append(layer);
    }
  }

  function update() {
    frame = undefined;
    if (stopped) return;
    const size = viewport(win, doc);
    const dw = Math.abs(size.width - drawn.width);
    const dh = Math.abs(size.height - drawn.height);
    // Mobile URL bars resize the viewport while scrolling; ignore those small height shifts.
    const heightSlack = size.width < MOBILE_BREAKPOINT ? 140 : 48;
    if (dw < 16 && dh < heightSlack) return;
    draw(size);
  }

  function schedule() {
    if (stopped || frame !== undefined) return;
    if (requestFrame) frame = requestFrame(update);
    else update();
  }

  function visibilityChanged() {
    if (doc.visibilityState === 'hidden') element.setAttribute('data-paused', '');
    else element.removeAttribute('data-paused');
  }

  function setActivity(ratio) {
    const ok = typeof ratio === 'number' && Number.isFinite(ratio);
    const value = ok ? clamp(ratio, 0, 1) : 0;
    const next = signalPeriod(value);
    if (next !== period) {
      period = next;
      element.style?.setProperty?.('--signal-period', `${next}s`);
    }
    element.setAttribute('data-activity', (ok && loadBand(value)) || 'calm');
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) cancelFrame?.(frame);
    frame = undefined;
    win?.removeEventListener?.('resize', schedule);
    doc.removeEventListener?.('visibilitychange', visibilityChanged);
    signal?.removeEventListener?.('abort', stop);
    if (typeof element.remove === 'function') element.remove();
    else element.parentNode?.removeChild?.(element);
  }

  setActivity(undefined);
  visibilityChanged();
  draw();
  win?.addEventListener?.('resize', schedule, { passive: true });
  doc.addEventListener?.('visibilitychange', visibilityChanged);
  signal?.addEventListener?.('abort', stop, { once: true });

  return {
    element,
    setActivity,
    refresh() { if (!stopped) draw(); },
    stop,
  };
}
