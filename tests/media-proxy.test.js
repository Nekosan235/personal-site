import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isAllowedCdn, isBlockedAddress } from '../server/media/allowlist.js';
import { cdnRequestHeaders, createCdnTransport } from '../server/media/cdn.js';
import { MEDIA_MESSAGES } from '../server/media/errors.js';

function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}

function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const entry = { address: '127.0.0.1', family: 4 };
  if (options.all) callback(null, [entry]);
  else callback(null, entry.address, entry.family);
}

test('CDN allowlist accepts known hosts and rejects open-proxy targets', () => {
  assert.equal(isAllowedCdn('https://sns-video-bd.xhscdn.com/stream/example.mp4'), true);
  assert.equal(isAllowedCdn('https://ci.xiaohongshu.com/demo-a?imageView2/format/png'), true);
  assert.equal(isAllowedCdn('https://sns-img-qc.xhscdn.com/cover.jpg'), true);
  assert.equal(isAllowedCdn('https://v26-web.douyinvod.com/video/example.mp4'), true);
  assert.equal(isAllowedCdn('https://aweme.snssdk.com/aweme/v1/play/?video_id=v0300fg10000examplevideo0000000001&ratio=default&line=0'), true);
  assert.equal(isAllowedCdn('https://v5-dy.zjcdn.com/video/tos/high.mp4'), true);
  assert.equal(isAllowedCdn('https://p3-sign.douyinpic.com/cover.jpeg'), true);
  assert.equal(isAllowedCdn('https://p9-sign.douyinpic.com/b.webp'), true);
  assert.equal(isAllowedCdn('http://127.0.0.1/secret'), false);
  assert.equal(isAllowedCdn('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isAllowedCdn('https://evil.example/a.jpg'), false);
  assert.equal(isAllowedCdn('https://xhscdn.com.evil.example/a.jpg'), false);
  assert.equal(isAllowedCdn('https://aweme.snssdk.com.evil.example/aweme/v1/play/'), false);
  assert.equal(isAllowedCdn('https://evil.example/aweme/v1/play/?video_id=v0300fg10000examplevideo0000000001'), false);
  assert.equal(isAllowedCdn('https://www.xiaohongshu.com/explore/1'), false);
  assert.equal(isAllowedCdn('https://user:pass@ci.xiaohongshu.com/a.jpg'), false);
  assert.equal(isAllowedCdn('https://ci.xiaohongshu.com:8443/a.jpg'), false);
  assert.equal(isAllowedCdn('file:///etc/passwd'), false);
});

test('blocked addresses include loopback, link-local, and private ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '100.64.1.1', '255.255.255.255', '198.18.0.1', '198.19.255.1', '::ffff:198.18.0.1', '64:ff9b::1', '64:ff9b::8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('198.20.0.1'), false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
  assert.equal(isBlockedAddress('64:ff9b:1::1'), false);
});

test('forwards the client Range header and a platform Referer to the upstream', async (t) => {
  let seen = null;
  const upstream = await listen((req, res) => {
    seen = { range: req.headers.range, referer: req.headers.referer, origin: req.headers.origin, agent: req.headers['user-agent'] };
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': 'bytes 0-3/10',
      'Content-Length': '4',
      'Accept-Ranges': 'bytes',
    });
    res.end('wxyz');
  });
  t.after(() => upstream.close());
  const port = upstream.address().port;
  const transport = createCdnTransport({ allow: () => true, lookup });
  const result = await transport({
    url: `http://v26-web.douyinvod.com:${port}/video.mp4`,
    range: 'bytes=0-3',
    platform: 'douyin',
  });
  const chunks = [];
  for await (const chunk of result.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'wxyz');
  assert.equal(result.statusCode, 206);
  assert.equal(seen.range, 'bytes=0-3');
  assert.equal(seen.referer, 'https://www.douyin.com/');
  assert.equal(seen.origin, undefined);
  assert.match(seen.agent, /Chrome/);
  const douyinHeaders = cdnRequestHeaders('douyin', 'bytes=0-1');
  assert.equal(douyinHeaders.Referer, 'https://www.douyin.com/');
  assert.equal(douyinHeaders.Origin, undefined);

  const xhs = await transport({
    url: `http://ci.xiaohongshu.com:${port}/a.jpg`,
    platform: 'xiaohongshu',
  });
  xhs.body.resume();
  await once(xhs.body, 'end');
  assert.equal(seen.referer, 'https://www.xiaohongshu.com/');
  assert.equal(seen.range, undefined);
});

test('does not follow a redirect off the CDN allowlist', async (t) => {
  let secretHits = 0;
  const upstream = await listen((req, res) => {
    if (req.url === '/secret') {
      secretHits += 1;
      res.end('secret-body');
      return;
    }
    res.writeHead(302, { Location: `http://127.0.0.1:${upstream.address().port}/secret` });
    res.end();
  });
  t.after(() => upstream.close());
  const transport = createCdnTransport({
    allow: (value) => new URL(value).hostname === 'v26-web.douyinvod.com',
    lookup,
  });
  await assert.rejects(
    () => transport({
      url: `http://v26-web.douyinvod.com:${upstream.address().port}/video.mp4`,
      platform: 'douyin',
    }),
    (error) => error.message === MEDIA_MESSAGES.outside,
  );
  assert.equal(secretHits, 0);
});
