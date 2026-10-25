import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isAllowedCdn } from '../server/media/allowlist.js';
import { MEDIA_MESSAGES } from '../server/media/errors.js';
import {
  createDouyinFetch,
  douyinPlayUrl,
  douyinVideoId,
  isAllowedDouyinPage,
  mapDouyinQualities,
  parseDouyinEntry2,
  resolveDouyinAwemeId,
} from '../server/media/douyin-direct.js';

const AWEME_ID = '7123456789012345678';
const VIDEO_ID = 'v0300fg10000examplevideo0000000001';

function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const entry = { address: '1.1.1.1', family: 4 };
  if (options.all) callback(null, [entry]);
  else callback(null, entry.address, entry.family);
}

function blockedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const entry = { address: '127.0.0.1', family: 4 };
  if (options.all) callback(null, [entry]);
  else callback(null, entry.address, entry.family);
}

function detailFixture() {
  return {
    status_code: 0,
    aweme_detail: {
      aweme_id: AWEME_ID,
      desc: '示例作品',
      author: { nickname: '示例作者' },
      aweme_type: 0,
      video: {
        width: 1920,
        height: 1080,
        play_addr: {
          uri: VIDEO_ID,
          width: 1024,
          height: 576,
          data_size: 21029366,
          url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=' + VIDEO_ID],
        },
        cover: { url_list: ['https://p3-sign.douyinpic.com/cover.jpeg', 'https://evil.example/cover.jpg'] },
        bit_rate: [
          {
            gear_name: 'normal_1080_0',
            quality_type: 1,
            bit_rate: 997011,
            FPS: 30,
            is_h265: 0,
            is_bytevc1: 0,
            play_addr: {
              uri: VIDEO_ID,
              width: 1920,
              height: 1080,
              data_size: 27940001,
              url_list: [
                'https://v5-dy.zjcdn.com/video/tos/high.mp4',
                'https://www.douyin.com/aweme/v1/play/?video_id=' + VIDEO_ID,
                'https://evil.example/secret.mp4',
                'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=' + VIDEO_ID,
                'https://v5-dy.zjcdn.com/logo/watermark.mp4',
                'http://127.0.0.1/secret.mp4',
              ],
            },
          },
          {
            gear_name: 'low_1080',
            quality_type: 2,
            bit_rate: 1000,
            FPS: 30,
            is_h265: 0,
            play_addr: {
              uri: VIDEO_ID,
              width: 1920,
              height: 1080,
              data_size: 1000,
              url_list: ['https://v5-dy.zjcdn.com/video/tos/low.mp4'],
            },
          },
          {
            gear_name: '720_1_1',
            quality_type: 11,
            bit_rate: 523944,
            FPS: 30,
            is_h265: 1,
            is_bytevc1: 1,
            play_addr: {
              uri: VIDEO_ID,
              width: 1280,
              height: 720,
              data_size: 14000000,
              url_list: ['https://v26-web.douyinvod.com/video/mid.mp4'],
            },
          },
          {
            gear_name: 'bad',
            play_addr: { url_list: ['http://127.0.0.1/secret.mp4', 'https://evil.example/a.mp4'] },
          },
        ],
      },
    },
  };
}

test('parses aweme id and video id separately, and builds a cookie-free play URL', () => {
  assert.equal(douyinVideoId({ play_addr: { uri: VIDEO_ID } }), VIDEO_ID);
  assert.equal(douyinVideoId({ aweme_id: AWEME_ID, play_addr: { uri: AWEME_ID } }), '');
  assert.equal(douyinVideoId({ video: { play_addr: { uri: VIDEO_ID } } }), VIDEO_ID);
  const play = new URL(douyinPlayUrl(VIDEO_ID));
  assert.equal(play.origin, 'https://aweme.snssdk.com');
  assert.equal(play.pathname, '/aweme/v1/play/');
  assert.equal(play.searchParams.get('video_id'), VIDEO_ID);
  assert.equal(play.searchParams.get('ratio'), 'default');
  assert.equal(play.searchParams.get('line'), '0');
  assert.equal(play.searchParams.get('watermark'), '0');
  assert.equal(play.searchParams.get('video_id') === AWEME_ID, false);
  assert.equal(douyinPlayUrl(AWEME_ID), '');
  assert.doesNotMatch(play.href, /playwm|\/logo\//);
  assert.equal(isAllowedCdn(play.href), true);
});

test('maps bit_rate entries to labeled qualities and drops non-Douyin or watermarked URLs', () => {
  const mapped = mapDouyinQualities(detailFixture().aweme_detail);
  assert.equal(mapped.kind, 'video');
  assert.equal(mapped.videoId, VIDEO_ID);
  assert.equal(mapped.thumbUrl, 'https://p3-sign.douyinpic.com/cover.jpeg');
  assert.deepEqual(mapped.qualities.map((quality) => quality.label), [
    '原画',
    '1920×1080 · 26.6 MB · H.264 · 30 fps',
    '1280×720 · 13.4 MB · H.265 · 30 fps',
  ]);
  assert.equal(mapped.qualities[0].id, 'original');
  assert.equal(mapped.qualities[0].gearName, 'ratio=default');
  assert.equal(mapped.qualities[1].gearName, 'normal_1080_0');
  assert.equal(mapped.qualities[1].downloadUrl, 'https://v5-dy.zjcdn.com/video/tos/high.mp4');
  assert.equal(mapped.qualities[2].codec, 'H.265');
  const urls = mapped.qualities.map((quality) => quality.downloadUrl).join('\n');
  assert.match(mapped.qualities[0].downloadUrl, new RegExp(`video_id=${VIDEO_ID}`));
  assert.doesNotMatch(urls, /evil\.example|127\.0\.0\.1|playwm|\/logo\/|www\.douyin\.com/);
  assert.equal(urls.includes(AWEME_ID), false);
  for (const quality of mapped.qualities) assert.equal(isAllowedCdn(quality.downloadUrl), true);
});

test('treats a slideshow without a video as images', () => {
  const mapped = mapDouyinQualities({ aweme_type: 68, desc: '图文', images: [{ url_list: ['https://evil.example/a.jpg'] }] });
  assert.equal(mapped.kind, 'images');
  assert.equal(mapped.qualities.length, 0);
});

test('allows only Douyin page hosts', () => {
  assert.equal(isAllowedDouyinPage('https://v.douyin.com/iABC123/'), true);
  assert.equal(isAllowedDouyinPage('https://www.iesdouyin.com/share/video/7123456789012345678/'), true);
  assert.equal(isAllowedDouyinPage('https://jingxuan.douyin.com/m/video/7123456789012345678?app=yumme'), true);
  assert.equal(isAllowedDouyinPage('https://www.douyin.com.evil.example/video/1'), false);
  assert.equal(isAllowedDouyinPage('https://evil.example/a'), false);
  assert.equal(isAllowedDouyinPage('http://v.douyin.com/a'), false);
  assert.equal(isAllowedDouyinPage('https://user:pass@v.douyin.com/a'), false);
  assert.equal(isAllowedDouyinPage('https://127.0.0.1/'), false);
  assert.equal(isAllowedDouyinPage('https://aweme.snssdk.com/aweme/v1/play/'), false);
});

test('stops a short-link redirect that leaves Douyin and does not request the next host', async () => {
  const calls = [];
  await assert.rejects(
    () => resolveDouyinAwemeId('https://v.douyin.com/iABC123/', {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/secret' } });
      },
      lookup: publicLookup,
      timeoutMs: 1000,
    }),
    (error) => error.message === MEDIA_MESSAGES.douyinEntry2Redirect,
  );
  assert.deepEqual(calls, ['https://v.douyin.com/iABC123/']);
});

test('does not connect when Douyin DNS resolves to a blocked address', async () => {
  const calls = [];
  await assert.rejects(
    () => resolveDouyinAwemeId('https://v.douyin.com/iABC123/', {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response('');
      },
      lookup: blockedLookup,
      timeoutMs: 1000,
    }),
    (error) => error.message === MEDIA_MESSAGES.outside,
  );
  assert.equal(calls.length, 0);
});

test('reads the aweme id from the short-link Location and does not fetch the share page', async () => {
  const calls = [];
  const id = await resolveDouyinAwemeId('https://v.douyin.com/iABC123/', {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response('', {
        status: 302,
        headers: { Location: 'https://www.iesdouyin.com/share/video/7123456789012345678/?region=CN' },
      });
    },
    lookup: publicLookup,
    timeoutMs: 1000,
  });
  assert.equal(id, AWEME_ID);
  assert.deepEqual(calls, ['https://v.douyin.com/iABC123/']);
});

test('prefers modal_id on a long link and does not request the page', async () => {
  const calls = [];
  const id = await resolveDouyinAwemeId('https://www.douyin.com/video/111111111111111111?modal_id=222222222222222222', {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response('');
    },
    lookup: publicLookup,
    timeoutMs: 1000,
  });
  assert.equal(id, '222222222222222222');
  assert.equal(calls.length, 0);
});

test('entry 2 asks the detail API with Origin and never sends a Douyin cookie', async () => {
  const calls = [];
  const signed = [];
  const work = await parseDouyinEntry2(`复制打开抖音 https://www.douyin.com/video/${AWEME_ID}/ 看看`, {
    config: { douyinCookie: 'session=secret' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: { ...init.headers }, redirect: init.redirect });
      if (String(url).includes('jingxuan.douyin.com')) {
        return new Response('{"play_count":42}', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return Response.json(detailFixture());
    },
    lookup: publicLookup,
    timeoutMs: 1000,
    playCountGraceMs: 200,
    proxify: (url, meta) => {
      signed.push({ url, meta });
      return `/api/media/file?n=${signed.length}`;
    },
  });
  assert.equal(work.entry, 2);
  assert.equal(work.awemeId, AWEME_ID);
  assert.equal(work.playCount, 42);
  assert.equal(work.qualities[0].label, '原画');
  assert.match(work.qualities[0].url, /^\/api\/media\/file\?/);
  assert.equal(work.qualities[0].downloadUrl, undefined);
  const detail = calls.find((call) => call.url.includes('/aweme/v1/web/aweme/detail/'));
  const detailUrl = new URL(detail.url);
  assert.equal(detailUrl.searchParams.get('aweme_id'), AWEME_ID);
  assert.equal(detailUrl.searchParams.get('aid'), '6383');
  assert.equal(detailUrl.searchParams.get('device_platform'), 'webapp');
  assert.equal(detail.headers.Origin, 'https://open.douyin.com');
  assert.equal(detail.headers.Referer, 'https://open.douyin.com/');
  assert.equal(detail.redirect, 'manual');
  assert.equal(JSON.stringify(calls).includes('session=secret'), false);
  assert.equal(calls.some((call) => /iteminfo|\/douyin\/detail|\/douyin\/share/.test(call.url)), false);
  assert.equal(signed[0].url, douyinPlayUrl(VIDEO_ID));
  assert.equal(signed.some((item) => /evil\.example|playwm|127\.0\.0\.1/.test(item.url)), false);
});

test('does not wait on a slow play-count page', async () => {
  const started = Date.now();
  const work = await parseDouyinEntry2(`https://www.douyin.com/video/${AWEME_ID}`, {
    fetchImpl: (url, init) => {
      if (String(url).includes('jingxuan')) {
        return new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return Response.json(detailFixture());
    },
    lookup: publicLookup,
    timeoutMs: 1000,
    playCountTimeoutMs: 40,
    playCountGraceMs: 20,
    proxify: () => '/api/media/file?n=1',
  });
  assert.equal(work.playCount, null);
  assert.ok(Date.now() - started < 500);
  assert.equal(work.qualities.length, 3);
});

test('a rejected detail tells the user to use entry 1 and does not invent a file', async () => {
  await assert.rejects(
    () => parseDouyinEntry2(`https://www.douyin.com/video/${AWEME_ID}`, {
      fetchImpl: async () => new Response('blocked', { status: 403 }),
      lookup: publicLookup,
      timeoutMs: 1000,
      playCountGraceMs: 1,
      proxify: () => '/api/media/file?n=1',
    }),
    (error) => error.message === MEDIA_MESSAGES.douyinEntry2Blocked && /入口 1/.test(error.message),
  );
});

test('entry 2 refuses a non-Douyin link before any request', async () => {
  const calls = [];
  await assert.rejects(
    () => parseDouyinEntry2('https://www.xiaohongshu.com/explore/640d6dca000000001203f0f9?xsec_token=ABCdef', {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response('');
      },
      lookup: publicLookup,
      proxify: () => '/api/media/file?n=1',
    }),
    (error) => error.message === MEDIA_MESSAGES.douyinEntry2Link,
  );
  assert.equal(calls.length, 0);
});

test('the direct client rejects IP URLs and does not follow a redirect', async (t) => {
  await assert.rejects(
    () => createDouyinFetch()('http://127.0.0.1/secret'),
    (error) => error.message === MEDIA_MESSAGES.outside,
  );
  let secretHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/secret') {
      secretHits += 1;
      res.end('secret');
      return;
    }
    res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/secret` });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const fetchImpl = createDouyinFetch({ lookup: blockedLookup });
  const response = await fetchImpl(`http://v.douyin.com:${server.address().port}/start`);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /\/secret$/);
  assert.equal(secretHits, 0);
});
