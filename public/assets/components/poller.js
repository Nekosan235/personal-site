export class PollTimeoutError extends Error {
  constructor() {
    super('Monitoring request timed out');
    this.name = 'PollTimeoutError';
  }
}

function abortError() {
  const error = new Error('Monitoring request aborted');
  error.name = 'AbortError';
  return error;
}

/** One request at a time, scoped to a visible page and its route lifetime. */
export function createPoller({
  request, onData, onError, onState = () => {}, signal,
  intervalMs = 5000, timeoutMs = 8000, visibility = document,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
}) {
  let started = false;
  let stopped = false;
  let running = false;
  let refreshRequested = false;
  let scheduled;
  let activeRequest;
  const isVisible = () => visibility.visibilityState !== 'hidden';

  function clearSchedule() {
    if (scheduled !== undefined) clearTimer(scheduled);
    scheduled = undefined;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    refreshRequested = false;
    clearSchedule();
    activeRequest?.abort(abortError());
    visibility.removeEventListener('visibilitychange', handleVisibility);
    signal?.removeEventListener('abort', stop);
  }

  async function run() {
    if (stopped || !started || !isVisible()) return;
    if (running) {
      refreshRequested = true;
      return;
    }
    clearSchedule();
    running = true;
    refreshRequested = false;
    const startedAt = now();
    const controller = new AbortController();
    activeRequest = controller;
    onState('fetching');
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason || abortError());
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timeout = setTimer(() => controller.abort(new PollTimeoutError()), timeoutMs);

    try {
      const data = await Promise.race([
        Promise.resolve().then(() => request(controller.signal)),
        aborted,
      ]);
      if (!stopped && isVisible() && !controller.signal.aborted) onData(data);
    } catch (error) {
      if (error?.status === 401) stop();
      else if (!stopped && isVisible() && error?.name !== 'AbortError') onError(error);
    } finally {
      clearTimer(timeout);
      controller.signal.removeEventListener('abort', rejectAbort);
      activeRequest = undefined;
      running = false;
      if (!stopped && isVisible()) {
        onState('waiting');
        const delay = refreshRequested ? 0 : Math.max(0, intervalMs - (now() - startedAt));
        scheduled = setTimer(() => {
          scheduled = undefined;
          void run();
        }, delay);
      }
    }
  }

  function handleVisibility() {
    if (isVisible()) void run();
    else {
      clearSchedule();
      refreshRequested = false;
      activeRequest?.abort(abortError());
      onState('paused');
    }
  }

  return {
    start() {
      if (started || stopped || signal?.aborted) return;
      started = true;
      visibility.addEventListener('visibilitychange', handleVisibility);
      signal?.addEventListener('abort', stop, { once: true });
      if (isVisible()) void run();
      else onState('paused');
    },
    refresh() { void run(); },
    stop,
  };
}
