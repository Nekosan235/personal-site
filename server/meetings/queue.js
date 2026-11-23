// A tiny FIFO queue with a fixed number of workers. One meeting is transcribed
// at a time by default, which keeps a self-hosted box from fighting itself.
//
// Enqueuing an id whose job is already running is not dropped: it is marked
// for one more run after the current one ends (the recording was replaced or a
// retry came in, and the running job's result will be discarded). stop()
// aborts running jobs through their AbortSignal so shutdown doesn't hang on a
// 45-minute transcription; the service leaves those meetings for recovery.

export function createTranscriptionQueue({ concurrency = 1, run, now = () => Date.now(), logger = console } = {}) {
  const waiting = [];
  const active = new Set();
  const tasks = new Map();
  const controllers = new Map();
  const rerun = new Set();
  let pumping = false;
  let stopped = false;

  function position(id) {
    if (active.has(id)) return 0;
    const index = waiting.indexOf(id);
    return index === -1 ? null : index + 1;
  }

  function size() {
    return waiting.length + active.size;
  }

  function isActive(id) {
    return active.has(id);
  }

  function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped && active.size < concurrency && waiting.length) {
        const id = waiting.shift();
        const controller = new AbortController();
        active.add(id);
        controllers.set(id, controller);
        const task = Promise.resolve()
          .then(() => run(id, { signal: controller.signal }))
          .catch((error) => {
            logger?.error?.('[meetings] 队列任务异常:', error?.message ?? error);
          })
          .finally(() => {
            active.delete(id);
            tasks.delete(id);
            controllers.delete(id);
            if (rerun.delete(id) && !stopped) waiting.push(id);
            pump();
          });
        tasks.set(id, task);
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue(id) {
    if (stopped || !id) return false;
    if (active.has(id)) {
      rerun.add(id);
      return true;
    }
    if (waiting.includes(id)) return false;
    waiting.push(id);
    pump();
    return true;
  }

  function dequeue(id) {
    rerun.delete(id);
    const index = waiting.indexOf(id);
    if (index !== -1) waiting.splice(index, 1);
  }

  /** Resolves once no worker is running, so shutdown can wait for writes. */
  function drain() {
    return Promise.allSettled([...tasks.values()]);
  }

  /** Stop taking work and abort running jobs (their meetings stay recoverable). */
  function stop() {
    stopped = true;
    waiting.length = 0;
    rerun.clear();
    for (const controller of controllers.values()) controller.abort(new Error('服务正在关闭'));
  }

  return { enqueue, dequeue, position, size, isActive, drain, stop, now };
}
