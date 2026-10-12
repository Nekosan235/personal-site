import { detectedTimeZone, referenceCities, resolveLocation, solarTimes, solarIsDay } from './solar.js?v=1.4.0';

export const appearanceKey = 'personal-space.appearance.v1';
export const themeModes = ['light', 'dark', 'system', 'solar'];

export function normalizePreference(value) {
  const mode = themeModes.includes(value?.mode) ? value.mode : 'solar';
  const input = value?.location;
  let location = { source: 'timezone' };
  if (input?.source === 'preset' && referenceCities.some((city) => city.id === input.city)) {
    location = { source: 'preset', city: input.city };
  } else if (input?.source === 'custom' && typeof input.latitude === 'number' && typeof input.longitude === 'number'
    && Number.isFinite(input.latitude) && Number.isFinite(input.longitude)
    && Math.abs(input.latitude) <= 90 && Math.abs(input.longitude) <= 180) {
    location = { source: 'custom', latitude: input.latitude, longitude: input.longitude };
  }
  return { mode, location };
}

export function resolveTheme(preference, darkSystem, date, times) {
  if (preference.mode === 'light' || preference.mode === 'dark') return preference.mode;
  if (preference.mode === 'solar') return solarIsDay(date, times) ? 'light' : 'dark';
  return darkSystem ? 'dark' : 'light';
}

export function createThemeController({
  root = document.documentElement, visibility = document, events = window,
  media = window.matchMedia('(prefers-color-scheme: dark)'),
  storage, timeZone = detectedTimeZone(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let localStore = storage;
  if (localStore === undefined) { try { localStore = window.localStorage; } catch { localStore = null; } }
  let saved;
  try { saved = JSON.parse(localStore?.getItem(appearanceKey) || 'null'); } catch { saved = null; }
  let preference = normalizePreference(saved);
  let state;
  let timer;
  let stopped = false;
  const listeners = new Set();

  function clearSchedule() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function refresh() {
    if (stopped) return;
    clearSchedule();
    const date = new Date(now());
    const location = resolveLocation(preference.location, timeZone, date);
    const times = solarTimes(date, location);
    const resolved = resolveTheme(preference, media.matches, date, times);
    state = { preference, resolved, location, times, timeZone };
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-bs-theme', resolved);
    try { localStore?.setItem(appearanceKey, JSON.stringify({ ...preference, resolved })); } catch { /* Private browsing can disable storage. */ }
    for (const listener of listeners) listener(state);
    if (preference.mode === 'solar' && visibility.visibilityState !== 'hidden') {
      const transitions = [times.sunrise, times.sunset].filter((value) => value && value.getTime() > date.getTime());
      const delay = Math.min(60_000, ...transitions.map((value) => value.getTime() - date.getTime()));
      timer = setTimer(refresh, Math.max(1, delay));
    }
  }

  function handleVisibility() {
    if (visibility.visibilityState === 'hidden') clearSchedule();
    else refresh();
  }

  function handleStorage(event) {
    if (event.key !== appearanceKey) return;
    try { preference = normalizePreference(JSON.parse(event.newValue || 'null')); } catch { preference = normalizePreference(null); }
    refresh();
  }

  media.addEventListener('change', refresh);
  visibility.addEventListener('visibilitychange', handleVisibility);
  events.addEventListener('storage', handleStorage);
  refresh();
  return {
    getState: () => state,
    setPreference(value) { preference = normalizePreference(value); refresh(); },
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    refresh,
    stop() {
      stopped = true;
      clearSchedule();
      media.removeEventListener('change', refresh);
      visibility.removeEventListener('visibilitychange', handleVisibility);
      events.removeEventListener('storage', handleStorage);
      listeners.clear();
    },
  };
}
