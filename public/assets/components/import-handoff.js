export const IMPORT_STORAGE_KEY = 'personal-site.image-import';
export const IMPORT_LIMIT = 20;
export const IMPORT_TTL_MS = 14 * 60 * 1000;

const memory = { current: null };

export function safeMediaFilePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/media/file?')) return '';
  if (value.length > 4096 || value.includes('\\') || /[\u0000-\u001f\s]/.test(value)) return '';
  return value;
}

function safeName(value, index) {
  const raw = typeof value === 'string' ? value.split(/[/\\]/).pop() : '';
  const cleaned = String(raw || '').replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  if (!cleaned || cleaned === '.' || cleaned === '..') return `image-${index + 1}.jpg`;
  return cleaned;
}

function coverName(item, index) {
  const base = safeName(item?.name, index).replace(/\.[^.]+$/, '');
  return `${base || 'cover'}-cover.jpg`;
}

export function selectImportSources(work, limit = IMPORT_LIMIT) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : IMPORT_LIMIT;
  const items = Array.isArray(work?.items) ? work.items : [];
  const images = [];
  const covers = [];
  const seen = new Set();
  let skippedVideos = 0;

  for (const item of items) {
    if (item?.kind === 'image') {
      const url = safeMediaFilePath(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      images.push({ url, name: safeName(item.name, images.length) });
    } else if (item?.kind === 'video') {
      skippedVideos += 1;
      const thumb = safeMediaFilePath(item.thumb);
      if (!thumb || seen.has(thumb)) continue;
      seen.add(thumb);
      covers.push({ url: thumb, name: coverName(item, covers.length) });
    }
  }

  if (!items.length && Array.isArray(work?.qualities)) {
    const quality = work.qualities.find((entry) => safeMediaFilePath(entry?.thumb));
    const thumb = quality ? safeMediaFilePath(quality.thumb) : '';
    if (thumb) {
      covers.push({ url: thumb, name: coverName(quality, 0) });
      skippedVideos = Math.max(skippedVideos, 1);
    }
  }

  const pool = images.length ? images : covers;
  const kind = images.length ? 'images' : covers.length ? 'covers' : 'none';
  return {
    items: pool.slice(0, cap),
    kind,
    skippedVideos,
    truncated: pool.length > cap,
    omitted: Math.max(0, pool.length - cap),
  };
}

function clipTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function parseRecord(raw, now) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== 1 || (parsed.mode !== 'white' && parsed.mode !== 'smart')) return null;
  if (!Number.isFinite(parsed.at)) return null;
  if (!Array.isArray(parsed.items) || !parsed.items.length) return null;
  const items = [];
  for (const item of parsed.items) {
    const url = safeMediaFilePath(item?.url);
    if (!url) continue;
    items.push({ url, name: safeName(item?.name, items.length) });
    if (items.length >= IMPORT_LIMIT) break;
  }
  if (!items.length) return null;
  return {
    v: 1,
    at: parsed.at,
    title: clipTitle(parsed.title),
    mode: parsed.mode,
    items,
    now,
  };
}

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function createImportHandoff({
  getStorage = browserSessionStorage,
  now = () => Date.now(),
  memorySlot = memory,
  ttlMs = IMPORT_TTL_MS,
} = {}) {
  function storage() {
    try {
      return getStorage?.() ?? null;
    } catch {
      return null;
    }
  }

  function readStorage() {
    const store = storage();
    if (!store) return null;
    try {
      const raw = store.getItem(IMPORT_STORAGE_KEY);
      store.removeItem(IMPORT_STORAGE_KEY);
      return parseRecord(raw, now());
    } catch {
      return null;
    }
  }

  return {
    stage(work, mode) {
      const plan = selectImportSources(work);
      if (mode !== 'white' && mode !== 'smart') return { ok: false, reason: 'mode', plan };
      if (!plan.items.length) return { ok: false, reason: 'empty', plan };
      const record = {
        v: 1,
        at: now(),
        title: clipTitle(work?.title),
        mode,
        items: plan.items,
      };
      memorySlot.current = record;
      let persisted = false;
      try {
        storage()?.setItem(IMPORT_STORAGE_KEY, JSON.stringify(record));
        persisted = Boolean(storage());
      } catch {
        persisted = false;
      }
      return { ok: true, persisted, plan, record };
    },
    take() {
      const fromStorage = readStorage();
      const fromMemory = memorySlot.current ? parseRecord(memorySlot.current, now()) : null;
      memorySlot.current = null;
      const candidates = [fromStorage, fromMemory].filter(Boolean);
      const fresh = candidates
        .filter((record) => now() - record.at <= ttlMs)
        .sort((left, right) => right.at - left.at);
      if (!fresh.length) return { ok: false, reason: candidates.length ? 'expired' : 'empty' };
      return { ok: true, record: fresh[0] };
    },
  };
}

export const mediaImportHandoff = createImportHandoff();

export async function materializeImport(record, { fetchImpl = globalThis.fetch, signal } = {}) {
  const files = [];
  const failures = [];
  const items = Array.isArray(record?.items) ? record.items : [];
  for (const item of items) {
    if (signal?.aborted) {
      const error = new Error('已取消导入');
      error.name = 'AbortError';
      throw error;
    }
    try {
      const response = await fetchImpl(item.url, { credentials: 'same-origin', signal, cache: 'no-store' });
      const type = String(response.headers?.get?.('content-type') || '');
      const normalized = type.split(';')[0].trim().toLowerCase();
      if (response.status === 401) throw new Error('登录已失效，请重新登录后再导入。');
      if (!response.ok) throw new Error('图片链接已失效，请回到下载页重新解析。');
      if (!normalized.startsWith('image/')) throw new Error('返回的不是图片，请回到下载页重新解析。');
      if (!/^image\/(?:jpeg|png|webp|jpg)$/.test(normalized)) {
        throw new Error('去白底和智能抠图只接受 PNG、JPEG 或 WebP。');
      }
      const blob = await response.blob();
      const fileType = normalized === 'image/jpg' ? 'image/jpeg' : normalized;
      files.push(new File([blob], item.name, { type: fileType || blob.type || 'image/jpeg' }));
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      failures.push({ name: item.name || '图片', message: error?.message || '导入失败' });
    }
  }
  return { files, failures };
}
