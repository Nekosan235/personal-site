// A tiny FIFO queue with a fixed number of workers. One meeting is transcribed
// at a time by default, which keeps a self-hosted box from fighting itself.

export function createTranscriptionQueue({ concurrency = 1, run, now = () => Date.now(), logger = console } = {}) {
  const waiting = [];
  const active = new Set();
  const tasks = new Map();
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
        active.add(id);
        const task = Promise.resolve()
          .then(() => run(id))
          .catch((error) => {
            logger?.error?.('[meetings] 队列任务异常:', error?.message ?? error);
          })
          .finally(() => {
            active.delete(id);
            tasks.delete(id);
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
    if (active.has(id) || waiting.includes(id)) return false;
    waiting.push(id);
    pump();
    return true;
  }

  function dequeue(id) {
    const index = waiting.indexOf(id);
    if (index !== -1) waiting.splice(index, 1);
  }

  /** Resolves once no worker is running, so shutdown can wait for writes. */
  function drain() {
    return Promise.allSettled([...tasks.values()]);
  }

  function stop() {
    stopped = true;
    waiting.length = 0;
  }

  return { enqueue, dequeue, position, size, isActive, drain, stop, now };
}
