import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocation, solarTimes, solarIsDay, referenceCities } from '../public/assets/components/solar.js';
import { createThemeController, normalizePreference, appearanceKey } from '../public/assets/components/theme.js';
import { createWelcomeRotation, welcomePhrases } from '../public/assets/components/welcome.js';
import { createAmbientBackground } from '../public/assets/components/ambient.js';

class Events {
  handlers = new Map();
  visibilityState = 'visible';
  matches = false;
  addEventListener(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.handlers.get(name)?.delete(callback); }
  emit(name, event = {}) { for (const callback of this.handlers.get(name) || []) callback(event); }
  get listenerCount() { return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0); }
}

class Clock {
  time = 0;
  next = 0;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = ++this.next;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimer = (id) => this.timers.delete(id);
  advance(duration) {
    const until = this.time + duration;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = until;
  }
}

class Root {
  attributes = new Map();
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
}

test('automatic sunrise location follows the detected time zone, with a clearly marked fallback', () => {
  assert.equal(resolveLocation({ source: 'timezone' }, 'Asia/Shanghai').name, '上海');
  assert.equal(resolveLocation({ source: 'timezone' }, 'Asia/Tokyo').name, '东京');
  assert.equal(resolveLocation({ source: 'timezone' }, 'Europe/London').name, '伦敦');
  assert.equal(resolveLocation({ source: 'timezone' }, 'America/New_York').name, '纽约');
  const fallback = resolveLocation({ source: 'timezone' }, 'Pacific/Chatham', new Date('2026-10-06'));
  assert.equal(fallback.approximate, true);
  assert.equal(fallback.latitude, 0);
  assert.match(fallback.name, /近似/);
  assert.equal(fallback.timeZone, 'Pacific/Chatham');
  assert.equal(resolveLocation({ source: 'preset', city: 'beijing' }, 'Europe/London').name, '北京');
});

test('solar computation preserves the local calendar date across UTC boundaries and switches at sunrise and sunset', () => {
  const date = new Date('2026-10-06T10:00:00Z');
  const shanghai = solarTimes(date, resolveLocation({ source: 'timezone' }, 'Asia/Shanghai'));
  assert.equal(shanghai.date, '2026-10-06');
  assert.ok(Math.abs(shanghai.sunrise.getTime() - Date.parse('2026-10-05T21:50:00Z')) < 300_000);
  assert.ok(Math.abs(shanghai.sunset.getTime() - Date.parse('2026-10-06T09:34:00Z')) < 300_000);
  assert.equal(solarIsDay(new Date(shanghai.sunrise.getTime() - 1), shanghai), false);
  assert.equal(solarIsDay(shanghai.sunrise, shanghai), true);
  assert.equal(solarIsDay(shanghai.sunset, shanghai), false);
  for (const city of referenceCities) {
    const times = solarTimes(date, city);
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: city.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    assert.equal(format.format(times.sunrise), format.format(date));
    assert.equal(format.format(times.sunset), format.format(date));
    assert.ok(times.sunrise < times.sunset);
  }
  const north = { latitude: 80, longitude: 0, timeZone: 'UTC' };
  assert.equal(solarTimes(new Date('2026-06-21T12:00:00Z'), north).polar, 'day');
  assert.equal(solarTimes(new Date('2026-12-21T12:00:00Z'), north).polar, 'night');
});

test('preferences default to solar, reject invalid coordinates, and retain only appearance fields', () => {
  assert.deepEqual(normalizePreference(null), { mode: 'solar', location: { source: 'timezone' } });
  assert.deepEqual(normalizePreference({ mode: 'dark', token: 'do-not-store', location: { source: 'custom', latitude: null, longitude: 0 } }),
    { mode: 'dark', location: { source: 'timezone' } });
  assert.deepEqual(normalizePreference({ mode: 'solar', location: { source: 'custom', latitude: -33.87, longitude: 151.21, privateField: 'unused' } }),
    { mode: 'solar', location: { source: 'custom', latitude: -33.87, longitude: 151.21 } });
  assert.equal(normalizePreference({ location: { source: 'custom', latitude: 91, longitude: 0 } }).location.source, 'timezone');
});

test('custom coordinates remain correct when their daylight interval crosses midnight in the browser time zone', () => {
  const custom = resolveLocation({ source: 'custom', latitude: 40.71, longitude: -74.01 }, 'Asia/Shanghai');
  const preset = resolveLocation({ source: 'preset', city: 'new-york' }, 'Asia/Shanghai');
  for (const [time, daytime] of [['2026-10-06T16:00:00Z', true], ['2026-10-06T23:00:00Z', false],
    ['2026-10-07T10:00:00Z', false], ['2026-10-07T12:00:00Z', true]]) {
    const date = new Date(time);
    assert.equal(solarIsDay(date, solarTimes(date, custom)), daytime);
    assert.equal(solarIsDay(date, solarTimes(date, preset)), daytime);
  }
  const times = solarTimes(new Date('2026-10-06T16:00:00Z'), custom);
  assert.ok(times.sunrise > times.sunset);
});

function themeHarness(saved, time = Date.parse('2026-10-06T10:00:00Z')) {
  const clock = new Clock();
  clock.time = time;
  const root = new Root();
  const visibility = new Events();
  const media = new Events();
  const events = new Events();
  const values = new Map(saved ? [[appearanceKey, JSON.stringify(saved)]] : []);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const theme = createThemeController({ root, visibility, media, events, storage, timeZone: 'Asia/Shanghai',
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, root, visibility, media, events, values, theme };
}

test('default solar appearance is dark after Shanghai sunset and system appearance reacts immediately', () => {
  const h = themeHarness();
  assert.equal(h.theme.getState().preference.mode, 'solar');
  assert.equal(h.root.getAttribute('data-theme'), 'dark');
  assert.equal(h.theme.getState().location.name, '上海');
  h.theme.setPreference({ mode: 'system' });
  assert.equal(h.root.getAttribute('data-theme'), 'light');
  h.media.matches = true;
  h.media.emit('change');
  assert.equal(h.root.getAttribute('data-theme'), 'dark');
  assert.equal(h.clock.timers.size, 0);
  h.theme.setPreference({ mode: 'light' });
  h.media.emit('change');
  assert.equal(h.root.getAttribute('data-theme'), 'light');
  const saved = JSON.parse(h.values.get(appearanceKey));
  assert.deepEqual(Object.keys(saved).sort(), ['location', 'mode', 'resolved']);
  h.theme.stop();
  assert.equal(h.media.listenerCount + h.visibility.listenerCount + h.events.listenerCount, 0);
});

test('solar theme switches at the solar boundary, pauses hidden timers, resumes with current time, and cleans up', () => {
  const city = resolveLocation({ source: 'timezone' }, 'Asia/Shanghai');
  const sunrise = solarTimes(new Date('2026-10-06T00:00:00Z'), city).sunrise.getTime();
  const h = themeHarness(null, sunrise - 500);
  assert.equal(h.root.getAttribute('data-theme'), 'dark');
  h.clock.advance(500);
  assert.equal(h.root.getAttribute('data-theme'), 'light');
  h.visibility.visibilityState = 'hidden';
  h.visibility.emit('visibilitychange');
  assert.equal(h.clock.timers.size, 0);
  h.clock.time = Date.parse('2026-10-06T11:00:00Z');
  h.visibility.visibilityState = 'visible';
  h.visibility.emit('visibilitychange');
  assert.equal(h.root.getAttribute('data-theme'), 'dark');
  h.theme.stop();
  assert.equal(h.clock.timers.size, 0);
});

test('storage changes are synchronized while blocked storage remains usable', () => {
  const h = themeHarness({ mode: 'light' });
  h.events.emit('storage', { key: appearanceKey, newValue: JSON.stringify({ mode: 'dark' }) });
  assert.equal(h.root.getAttribute('data-theme'), 'dark');
  h.theme.stop();
  const root = new Root();
  const events = new Events();
  const theme = createThemeController({ root, events, visibility: events, media: events, timeZone: 'Asia/Shanghai',
    storage: { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } },
    now: () => Date.parse('2026-10-06T11:00:00Z') });
  assert.equal(root.getAttribute('data-theme'), 'dark');
  theme.stop();
});

test('welcome waits three visible minutes, stays independent of refresh, and cleans up when leaving the route', () => {
  const clock = new Clock();
  const visibility = new Events();
  const route = new AbortController();
  const titles = [];
  createWelcomeRotation({ onTitle: (title) => titles.push(title), signal: route.signal, visibility,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.deepEqual(titles, ['欢迎回来']);
  clock.advance(120_000);
  visibility.visibilityState = 'hidden';
  visibility.emit('visibilitychange');
  clock.advance(600_000);
  assert.deepEqual(titles, ['欢迎回来']);
  visibility.visibilityState = 'visible';
  visibility.emit('visibilitychange');
  clock.advance(59_999);
  assert.equal(titles.length, 1);
  clock.advance(1);
  assert.equal(titles[1], welcomePhrases[0]);
  clock.advance(180_000);
  assert.equal(titles[2], welcomePhrases[1]);
  route.abort();
  assert.equal(clock.timers.size, 0);
  assert.equal(visibility.listenerCount, 0);
  clock.advance(600_000);
  assert.equal(titles.length, 3);
});

test('scroll background follows actual progress with one pending frame, disables on mobile or reduced motion, and cleans up', () => {
  const root = new Root();
  root.scrollHeight = 3000;
  const events = new Events();
  events.innerHeight = 1000;
  events.scrollY = 1000;
  const page = new Events();
  const media = new Events();
  const route = new AbortController();
  const frames = new Map();
  let id = 0;
  createAmbientBackground({ root, events, page, media, signal: route.signal,
    requestFrame: (callback) => { frames.set(++id, callback); return id; }, cancelFrame: (value) => frames.delete(value) });
  events.emit('scroll');
  events.emit('scroll');
  assert.equal(frames.size, 1);
  const callback = [...frames.values()][0];
  frames.clear();
  callback();
  assert.equal(root.getAttribute('data-scroll-step'), '10');
  assert.equal(frames.size, 0);
  media.matches = true;
  media.emit('change');
  assert.equal(root.getAttribute('data-scroll-step'), undefined);
  events.emit('scroll');
  assert.equal(frames.size, 0);
  media.matches = false;
  media.emit('change');
  assert.equal(frames.size, 1);
  route.abort();
  assert.equal(frames.size, 0);
  assert.equal(events.listenerCount + page.listenerCount + media.listenerCount, 0);
});
