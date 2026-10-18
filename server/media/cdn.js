import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAllowedCdn, isBlockedAddress } from './allowlist.js';
import { MEDIA_MESSAGES, MediaError } from './errors.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REFERERS = {
  xiaohongshu: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
};

export function cdnRequestHeaders(platform, range) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: REFERERS[platform] || REFERERS.douyin,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (range) headers.Range = range;
  return headers;
}

export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    const usable = (addresses || []).filter((entry) => !isBlockedAddress(entry.address));
    if (!usable.length) {
      callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
      return;
    }
    if (options.all) {
      callback(null, usable.map((entry) => ({ address: entry.address, family: entry.family })));
      return;
    }
    callback(null, usable[0].address, usable[0].family);
  });
}

function openRequest(target, headers, lookup, timeoutMs) {
  const lib = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      lookup,
      timeout: timeoutMs,
    }, (response) => {
      resolve({ statusCode: response.statusCode ?? 502, headers: response.headers, body: response });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

function mediaFailure(error) {
  if (error instanceof MediaError) return error;
  if (error?.code === 'EBLOCKED') return new MediaError(MEDIA_MESSAGES.outside, 400, 'blocked');
  return new MediaError(MEDIA_MESSAGES.file, 502, 'upstream');
}

export function createCdnTransport({ allow = isAllowedCdn, lookup = safeLookup, timeoutMs = 20_000 } = {}) {
  async function requestOnce(input, redirects) {
    if (!allow(input.url)) throw new MediaError(MEDIA_MESSAGES.outside, 400, 'allowlist');
    let target;
    try {
      target = new URL(input.url);
    } catch {
      throw new MediaError(MEDIA_MESSAGES.outside, 400, 'allowlist');
    }
    let upstream;
    try {
      upstream = await openRequest(target, cdnRequestHeaders(input.platform, input.range), lookup, timeoutMs);
    } catch (error) {
      throw mediaFailure(error);
    }
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
      const location = upstream.headers.location;
      upstream.body.resume();
      if (!location || redirects >= 2) throw new MediaError(MEDIA_MESSAGES.outside, 400, 'redirect');
      const next = new URL(location, target);
      return requestOnce({ ...input, url: next.href }, redirects + 1);
    }
    return upstream;
  }

  return function requestCdn(input) {
    return requestOnce(input, 0);
  };
}
