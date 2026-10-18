import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeDouyinWork, normalizeXhsWork } from '../server/media/normalize.js';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/media/${name}.json`, import.meta.url), 'utf8'));
}

function proxify(url, meta) {
  return `proxy:${meta.kind}:${meta.filename}:${url}`;
}

test('normalizes a Xiaohongshu image note, including a live-photo URL', async () => {
  const payload = await fixture('xhs-images');
  const work = normalizeXhsWork(payload.data, proxify);
  assert.equal(work.platform, 'xiaohongshu');
  assert.equal(work.type, 'images');
  assert.equal(work.title, '婚礼上的妈妈');
  assert.equal(work.author, '抱走阿茗');
  assert.equal(work.items.length, 3);
  assert.equal(work.items[0].kind, 'image');
  assert.equal(work.items[0].width, null);
  assert.equal(work.items[0].height, null);
  assert.match(work.items[0].url, /^proxy:image:婚礼上的妈妈-1\.png:https:\/\/ci\.xiaohongshu\.com\/demo-a/);
  assert.equal(work.items[0].thumb, work.items[0].url);
  assert.match(work.items[1].url, /demo-b/);
  assert.equal(work.items[2].kind, 'video');
  assert.match(work.items[2].url, /live-b\.mp4/);
  assert.match(work.items[2].thumb, /cover\.jpg/);
});

test('normalizes a Xiaohongshu video and uses the cover as the thumb', async () => {
  const payload = await fixture('xhs-video');
  const work = normalizeXhsWork(payload.data, proxify);
  assert.equal(work.type, 'video');
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].kind, 'video');
  assert.match(work.items[0].url, /example\.mp4/);
  assert.match(work.items[0].thumb, /cover\.jpg/);
  assert.notEqual(work.items[0].thumb, work.items[0].url);
});

test('normalizes Douyin video and image responses, including string or array downloads', async () => {
  const video = normalizeDouyinWork((await fixture('douyin-video')).data, proxify);
  assert.equal(video.platform, 'douyin');
  assert.equal(video.type, 'video');
  assert.equal(video.title, '示例视频描述');
  assert.equal(video.author, '示例作者');
  assert.equal(video.items[0].kind, 'video');
  assert.equal(video.items[0].width, 1080);
  assert.equal(video.items[0].height, 1920);
  assert.match(video.items[0].url, /douyinvod\.com/);
  assert.match(video.items[0].thumb, /douyinpic\.com\/cover\.jpeg/);
  assert.doesNotMatch(video.items.map((item) => item.url).join(' '), /music\.mp3/);

  const images = normalizeDouyinWork((await fixture('douyin-images')).data, proxify);
  assert.equal(images.type, 'images');
  assert.equal(images.items.length, 2);
  assert.deepEqual(images.items.map((item) => item.kind), ['image', 'image']);
  assert.equal(images.items[0].width, null);
  assert.equal(images.items[0].height, null);
  assert.equal(images.items[0].thumb, images.items[0].url);
});

test('drops download URLs that are not on the CDN allowlist', async () => {
  const payload = await fixture('douyin-images');
  payload.data.downloads.push('http://127.0.0.1/secret.jpg', 'https://evil.example/a.jpg', 'https://user:pass@p3-sign.douyinpic.com/c.jpg');
  const work = normalizeDouyinWork(payload.data, proxify);
  assert.equal(work.items.length, 2);
  assert.equal(normalizeXhsWork({}, proxify), null);
  assert.equal(normalizeDouyinWork(null, proxify), null);
});
