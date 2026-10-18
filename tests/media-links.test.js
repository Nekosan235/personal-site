import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, douyinDetailId, extractShareTarget, xhsLinkNeedsToken } from '../public/assets/components/media-links.js';

test('extracts a Xiaohongshu link from a Chinese share caption and keeps xsec_token', () => {
  const text = '复制这段话，打开小红书 https://www.xiaohongshu.com/explore/640d6dca000000001203f0f9?xsec_token=ABCdef_12-xyz=&xsec_source=app_share 查看作品。';
  const target = extractShareTarget(text);
  assert.equal(target.platform, 'xiaohongshu');
  assert.equal(target.url, 'https://www.xiaohongshu.com/explore/640d6dca000000001203f0f9?xsec_token=ABCdef_12-xyz=&xsec_source=app_share');
  assert.equal(xhsLinkNeedsToken(target.url), false);
});

test('detects short hosts and ignores unrelated links', () => {
  assert.equal(detectPlatform('https://xhslink.com/a/Ab12'), 'xiaohongshu');
  assert.equal(detectPlatform('https://v.douyin.com/iABC123/'), 'douyin');
  assert.equal(detectPlatform('https://www.iesdouyin.com/share/video/7123456789012345678/'), 'douyin');
  assert.equal(detectPlatform('https://www.douyin.com/video/7123456789012345678'), 'douyin');
  assert.equal(detectPlatform('https://notxiaohongshu.com/explore/1'), null);
  assert.equal(detectPlatform('https://xiaohongshu.com.evil.example/a'), null);
  assert.equal(detectPlatform('https://evil.example/xhscdn.com'), null);
  assert.equal(extractShareTarget('今天没有链接'), null);
  assert.equal(extractShareTarget('先看 https://example.com/post 再看 https://v.douyin.com/abc/').platform, 'douyin');
});

test('strips trailing punctuation and prefers the first supported link', () => {
  const target = extractShareTarget('7.43 复制打开抖音 https://v.douyin.com/iABC123/。');
  assert.equal(target.platform, 'douyin');
  assert.equal(target.url, 'https://v.douyin.com/iABC123/');
  const first = extractShareTarget('https://xhslink.com/a/abc 以及 https://v.douyin.com/xyz/');
  assert.equal(first.platform, 'xiaohongshu');
});

test('reads a Douyin aweme id from resolved share URLs', () => {
  assert.equal(douyinDetailId('https://www.douyin.com/video/7123456789012345678?previous_page=app_code_link'), '7123456789012345678');
  assert.equal(douyinDetailId('https://www.douyin.com/note/7123456789012345678/'), '7123456789012345678');
  assert.equal(douyinDetailId('https://www.iesdouyin.com/share/video/7123456789012345678/'), '7123456789012345678');
  assert.equal(douyinDetailId('https://www.douyin.com/discover?modal_id=7123456789012345678'), '7123456789012345678');
  assert.equal(douyinDetailId('https://v.douyin.com/iABC123/'), null);
});

test('warns when a Xiaohongshu web link has no xsec_token', () => {
  assert.equal(xhsLinkNeedsToken('https://www.xiaohongshu.com/explore/640d6dca000000001203f0f9'), true);
  assert.equal(xhsLinkNeedsToken('https://xhslink.com/a/Ab12'), false);
  assert.equal(xhsLinkNeedsToken('https://v.douyin.com/iABC123/'), false);
});
