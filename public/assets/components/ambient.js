/** Coalesced scroll updates; CSS interpolates twenty small background steps. */
export function createAmbientBackground({
  signal, root = document.documentElement, page = document, events = window,
  media = window.matchMedia('(max-width: 760px), (prefers-reduced-motion: reduce)'),
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
} = {}) {
  let frame;
  let stopped = false;
  function cancel() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  }
  function update() {
    frame = undefined;
    if (stopped || media.matches || page.visibilityState === 'hidden') return;
    const range = Math.max(0, root.scrollHeight - events.innerHeight);
    const progress = range ? Math.max(0, Math.min(1, events.scrollY / range)) : 0;
    root.setAttribute('data-scroll-step', String(Math.round(progress * 20)));
  }
  function schedule() {
    if (stopped || media.matches || page.visibilityState === 'hidden' || frame !== undefined) return;
    frame = requestFrame(update);
  }
  function modeChanged() {
    cancel();
    if (media.matches) root.removeAttribute('data-scroll-step');
    else schedule();
  }
  function visibilityChanged() {
    if (page.visibilityState === 'hidden') cancel();
    else schedule();
  }
  function stop() {
    stopped = true;
    cancel();
    root.removeAttribute('data-scroll-step');
    events.removeEventListener('scroll', schedule);
    events.removeEventListener('resize', schedule);
    page.removeEventListener('visibilitychange', visibilityChanged);
    media.removeEventListener('change', modeChanged);
    signal?.removeEventListener('abort', stop);
  }
  if (!signal?.aborted) {
    events.addEventListener('scroll', schedule, { passive: true });
    events.addEventListener('resize', schedule, { passive: true });
    page.addEventListener('visibilitychange', visibilityChanged);
    media.addEventListener('change', modeChanged);
    signal?.addEventListener('abort', stop, { once: true });
    modeChanged();
  }
  return { stop, refresh: schedule };
}
