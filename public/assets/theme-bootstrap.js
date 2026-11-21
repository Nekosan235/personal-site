// Apply the saved appearance before the stylesheet is painted.
(() => {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('personal-space.appearance.v1') || 'null'); } catch { saved = null; }
  const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const theme = ['light', 'dark'].includes(saved?.mode) ? saved.mode
    : saved?.mode === 'solar' && ['light', 'dark'].includes(saved?.resolved) ? saved.resolved : system;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-bs-theme', theme);
  // Motion tier: low-end or data-saver devices keep transitions but skip looping effects.
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const lite = Boolean(nav && ((nav.hardwareConcurrency && nav.hardwareConcurrency <= 2)
    || (nav.deviceMemory && nav.deviceMemory <= 2) || nav.connection?.saveData));
  document.documentElement.setAttribute('data-motion', lite ? 'lite' : 'full');
})();
