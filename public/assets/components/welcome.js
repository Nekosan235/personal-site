export const welcomePhrases = [
  '把时间留给真正重要的事。',
  '慢一点，也是一种向前。',
  '愿每一次专注，都有所回响。',
  '看见当下，路就清晰了。',
  '日子有序，心便从容。',
];

export function createWelcomeRotation({
  onTitle, signal, visibility = document, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 180_000,
} = {}) {
  let timer;
  let remaining = intervalMs;
  let visibleSince;
  let index = 0;
  let stopped = false;

  function pause() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (visibleSince !== undefined) remaining = Math.max(0, remaining - (now() - visibleSince));
    visibleSince = undefined;
  }

  function resume() {
    if (stopped || visibility.visibilityState === 'hidden') return;
    visibleSince = now();
    timer = setTimer(() => {
      timer = undefined;
      onTitle(welcomePhrases[index % welcomePhrases.length]);
      index += 1;
      remaining = intervalMs;
      visibleSince = undefined;
      resume();
    }, remaining);
  }

  function visibilityChanged() { pause(); resume(); }
  function stop() {
    stopped = true;
    pause();
    visibility.removeEventListener('visibilitychange', visibilityChanged);
    signal?.removeEventListener('abort', stop);
  }
  onTitle('欢迎回来');
  if (!signal?.aborted) {
    visibility.addEventListener('visibilitychange', visibilityChanged);
    signal?.addEventListener('abort', stop, { once: true });
    resume();
  }
  return { stop };
}
