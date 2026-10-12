export function createImageWorker(signal) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let sequence = 0;
  let activeExport = 0;
  worker.addEventListener('message', ({ data }) => {
    const item = pending.get(data.id);
    if (!item) return;
    if (data.progress !== undefined) { item.onProgress?.(data); return; }
    pending.delete(data.id);
    if (item.type === 'gif-export') activeExport = 0;
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data);
  });
  worker.addEventListener('error', (error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  });
  const terminate = () => {
    worker.terminate();
    for (const item of pending.values()) item.reject(new DOMException('页面已关闭', 'AbortError'));
    pending.clear();
  };
  signal?.addEventListener('abort', terminate, { once: true });
  return {
    request(type, payload = {}, transfer = [], onProgress) {
      const id = ++sequence;
      if (type === 'gif-export') activeExport = id;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress, type });
        worker.postMessage({ id, type, ...payload }, transfer);
      });
    },
    cancel() { if (activeExport) worker.postMessage({ id: ++sequence, type: 'cancel', jobId: activeExport }); },
    destroy() { signal?.removeEventListener('abort', terminate); terminate(); },
  };
}
