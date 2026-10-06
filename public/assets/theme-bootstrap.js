// Apply the saved appearance before the stylesheet is painted.
(() => {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('personal-space.appearance.v1') || 'null'); } catch { saved = null; }
  const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const theme = ['light', 'dark'].includes(saved?.mode) ? saved.mode
    : saved?.mode === 'solar' && ['light', 'dark'].includes(saved?.resolved) ? saved.resolved : system;
  document.documentElement.setAttribute('data-theme', theme);
})();
