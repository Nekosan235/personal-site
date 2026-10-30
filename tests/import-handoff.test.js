import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  IMPORT_LIMIT,
  createImportHandoff,
  materializeImport,
  selectImportSources,
} from '../public/assets/components/import-handoff.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const image = (url, name = 'photo.jpg') => ({ kind: 'image', url, name, thumb: url });
const video = (url, thumb, name = 'clip.mp4') => ({ kind: 'video', url, thumb, name });

test('image galleries are preferred over video covers', () => {
  const plan = selectImportSources({
    title: '图集',
    items: [
      image('/api/media/file?d=1&s=1', 'a.jpg'),
      video('/api/media/file?d=v&s=v', '/api/media/file?d=cover&s=cover', 'live.mp4'),
      image('/api/media/file?d=1&s=1', 'duplicate.jpg'),
      image('https://evil.example/a.jpg', 'remote.jpg'),
      { kind: 'image', url: '/api/media/file?d=bad\n&s=1', name: 'bad.jpg' },
    ],
  });
  assert.equal(plan.kind, 'images');
  assert.equal(plan.skippedVideos, 1);
  assert.deepEqual(plan.items.map((item) => item.url), ['/api/media/file?d=1&s=1']);
  assert.equal(plan.items[0].name, 'a.jpg');
});

test('a video imports one cover and entry 2 does not repeat every quality', () => {
  const single = selectImportSources({
    items: [video('/api/media/file?d=v&s=v', '/api/media/file?d=cover&s=cover', 'clip.mp4')],
  });
  assert.equal(single.kind, 'covers');
  assert.equal(single.items.length, 1);
  assert.equal(single.items[0].url, '/api/media/file?d=cover&s=cover');
  assert.match(single.items[0].name, /cover\.jpg$/);

  const bare = selectImportSources({ items: [video('/api/media/file?d=v&s=v', '')] });
  assert.equal(bare.kind, 'none');
  assert.equal(bare.items.length, 0);

  const entry2 = selectImportSources({
    title: '入口 2',
    qualities: [
      { thumb: '/api/media/file?d=cover&s=1', name: 'a.mp4' },
      { thumb: '/api/media/file?d=cover&s=2', name: 'b.mp4' },
    ],
  });
  assert.equal(entry2.items.length, 1);
  assert.equal(entry2.items[0].url, '/api/media/file?d=cover&s=1');
});

test('import keeps at most 20 images and the chosen tool mode', () => {
  const items = Array.from({ length: IMPORT_LIMIT + 3 }, (_, index) => image(`/api/media/file?d=${index}&s=1`, `n-${index}.jpg`));
  let clock = 1_000;
  const storage = memoryStorage();
  const handoff = createImportHandoff({
    getStorage: () => storage,
    now: () => clock,
    memorySlot: { current: null },
  });
  const staged = handoff.stage({ title: '很多图', items }, 'smart');
  assert.equal(staged.ok, true);
  assert.equal(staged.plan.truncated, true);
  assert.equal(staged.plan.omitted, 3);
  assert.equal(staged.record.mode, 'smart');
  assert.equal(staged.record.items.length, IMPORT_LIMIT);
  const rejected = handoff.stage({ items }, 'ink');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'mode');
  clock += 10;
  const taken = handoff.take();
  assert.equal(taken.ok, true);
  assert.equal(taken.record.mode, 'smart');
  assert.equal(handoff.take().reason, 'empty');
});

test('an expired list is discarded and a storage failure still hands off in memory', () => {
  let clock = 5_000;
  const storage = memoryStorage();
  const memorySlot = { current: null };
  const handoff = createImportHandoff({
    getStorage: () => storage,
    now: () => clock,
    memorySlot,
    ttlMs: 1_000,
  });
  handoff.stage({ items: [image('/api/media/file?d=1&s=1')] }, 'white');
  clock += 5_000;
  assert.equal(handoff.take().reason, 'expired');

  const broken = createImportHandoff({
    getStorage: () => ({
      getItem: () => { throw new Error('private'); },
      setItem: () => { throw new Error('private'); },
      removeItem: () => { throw new Error('private'); },
    }),
    now: () => 10,
    memorySlot: { current: null },
  });
  const staged = broken.stage({ items: [image('/api/media/file?d=2&s=2')] }, 'white');
  assert.equal(staged.ok, true);
  assert.equal(staged.persisted, false);
  assert.equal(broken.take().record.mode, 'white');
});

test('materializeImport keeps image files and records Chinese failures', async () => {
  const record = {
    items: [
      { url: '/api/media/file?d=ok&s=1', name: 'ok.jpg' },
      { url: '/api/media/file?d=old&s=1', name: 'old.jpg' },
      { url: '/api/media/file?d=heic&s=1', name: 'live.heic' },
    ],
  };
  const { files, failures } = await materializeImport(record, {
    fetchImpl: async (url) => {
      if (url.endsWith('d=old&s=1')) return { ok: false, status: 400, headers: { get: () => 'application/json' }, blob: async () => new Blob() };
      if (url.endsWith('d=heic&s=1')) return { ok: true, status: 200, headers: { get: () => 'image/heic' }, blob: async () => new Blob([new Uint8Array([1])]) };
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) };
    },
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'ok.jpg');
  assert.equal(files[0].type, 'image/jpeg');
  assert.equal(failures.length, 2);
  assert.match(failures[0].message, /重新解析/);
  assert.match(failures[1].message, /PNG、JPEG 或 WebP/);
});

test('the download page offers both destinations and the tool page switches mode', async () => {
  const download = await readFile(new URL('../public/assets/pages/media-download.js', import.meta.url), 'utf8');
  const tool = await readFile(new URL('../public/assets/pages/remove-background.js', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../public/assets/components/image-tools/editor-ui.js', import.meta.url), 'utf8');
  assert.match(download, /去白底/);
  assert.match(download, /智能抠图/);
  assert.match(download, /mediaImportHandoff\.stage\(work, mode\)/);
  assert.match(download, /\/tools\/remove-background/);
  assert.doesNotMatch(download, /一键导入去白底/);
  for (const model of ['u2netp', 'isnet-general-use', 'birefnet-general-lite', 'birefnet-portrait']) {
    assert.match(tool, new RegExp(model));
  }
  for (const refine of ['dc', 'alpha', 'vitmatte']) assert.match(tool, new RegExp(refine));
  assert.match(tool, /\/api\/matting\/remove/);
  assert.match(tool, /pendingImport\.record\.mode === 'smart'/);
  assert.match(editor, /multiple: ''/);
  assert.match(editor, /添加图片/);
});
