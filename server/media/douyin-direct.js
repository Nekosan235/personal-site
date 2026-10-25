import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { douyinDetailId, extractShareTarget } from '../../public/assets/components/media-links.js';
import { isAllowedCdn, isBlockedAddress } from './allowlist.js';
import { safeLookup } from './cdn.js';
import { MEDIA_MESSAGES, MediaError } from './errors.js';
import { mediaFilename } from './normalize.js';

const PAGE_SUFFIXES = ['douyin.com', 'iesdouyin.com'];
const VIDEO_ID = /^v[0-9A-Za-z]{16,80}$/;
const AWEME_ID = /^\d{6,32}$/;
const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const PLAY_COUNT_GRACE_MS = 0;
const MAX_BYTES = 2 * 1024 * 1024;

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const DETAIL_HEADERS = {
  Accept: 'application/json',
  Origin: 'https://open.douyin.com',
  Referer: 'https://open.douyin.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent': DESKTOP_UA,
};

const SHARE_HEADERS = {
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  Referer: 'https://www.douyin.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent': MOBILE_UA,
};

const PLAY_COUNT_HEADERS = {
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  Referer: 'https://jingxuan.douyin.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent': MOBILE_UA,
};

function pageHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || isIP(host)) return false;
  return PAGE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isAllowedDouyinPage(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:') return false;
  if (url.port && url.port !== '443') return false;
  return pageHost(url.hostname);
}

function httpsPage(value) {
  const url = new URL(value);
  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  url.port = '';
  return url.href;
}

export function douyinVideoId(video) {
  const uri = video?.play_addr?.uri ?? video?.video?.play_addr?.uri;
  return typeof uri === 'string' && VIDEO_ID.test(uri) ? uri : '';
}

export function douyinPlayUrl(videoId) {
  if (!VIDEO_ID.test(videoId || '')) return '';
  const url = new URL('https://aweme.snssdk.com/aweme/v1/play/');
  url.searchParams.set('video_id', videoId);
  url.searchParams.set('ratio', 'default');
  url.searchParams.set('line', '0');
  url.searchParams.set('watermark', '0');
  return url.href;
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return number;
}

function codecOf(item) {
  const h265 = Number(item?.is_h265) === 1 || Number(item?.is_bytevc1) === 1;
  if (h265) return 'H.265';
  if (Number(item?.is_h265) === 0 || Number(item?.is_bytevc1) === 0) return 'H.264';
  return '';
}

function fpsOf(item) {
  const value = Number(item?.FPS);
  if (!Number.isFinite(value) || value <= 0 || value > 240) return null;
  return Math.round(value * 100) / 100;
}

function gearOf(item) {
  const text = typeof item?.gear_name === 'string' ? item.gear_name.trim() : '';
  if (!text || text.length > 40 || !/^[A-Za-z0-9._-]+$/.test(text)) return '';
  return text;
}

function formatBytes(value) {
  if (value >= 1024 * 1024) {
    const mb = value / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
  if (value >= 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${value} B`;
}

export function qualityLabel(quality) {
  if (quality?.original) return '原画';
  const parts = [];
  if (quality?.width && quality?.height) parts.push(`${quality.width}×${quality.height}`);
  if (quality?.dataSize) parts.push(formatBytes(quality.dataSize));
  if (quality?.codec) parts.push(quality.codec);
  if (quality?.fps) parts.push(`${quality.fps} fps`);
  return parts.join(' · ') || '视频';
}

function watermarked(value) {
  return /playwm|\/logo\//i.test(value);
}

export function usableDouyinMediaUrl(list) {
  const source = Array.isArray(list) ? list : list == null || list === '' ? [] : [list];
  for (const entry of source) {
    if (typeof entry !== 'string' || watermarked(entry)) continue;
    let url;
    try {
      url = new URL(entry);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || watermarked(`${url.pathname}${url.search}`)) continue;
    if (!isAllowedCdn(url)) continue;
    return url.href;
  }
  return '';
}

function coverUrl(video) {
  for (const key of ['origin_cover', 'cover', 'dynamic_cover']) {
    const found = usableDouyinMediaUrl(video?.[key]?.url_list);
    if (found) return found;
  }
  return '';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function mapDouyinQualities(aweme) {
  if (!aweme || typeof aweme !== 'object' || Array.isArray(aweme)) return null;
  const video = aweme.video && typeof aweme.video === 'object' ? aweme.video : {};
  const images = Array.isArray(aweme.images) ? aweme.images.filter(Boolean) : [];
  const videoId = douyinVideoId(video);
  const playUrl = douyinPlayUrl(videoId);
  const best = new Map();
  const bitRate = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  for (const item of bitRate) {
    const play = item?.play_addr && typeof item.play_addr === 'object' ? item.play_addr : {};
    const downloadUrl = usableDouyinMediaUrl(play.url_list);
    if (!downloadUrl) continue;
    const width = positiveInt(play.width);
    const height = positiveInt(play.height);
    const codec = codecOf(item);
    const dataSize = positiveInt(play.data_size);
    const key = width && height ? `${width}x${height}|${codec}` : downloadUrl;
    const candidate = {
      original: false,
      downloadUrl,
      width,
      height,
      codec,
      dataSize,
      fps: fpsOf(item),
      bitRate: positiveInt(item?.bit_rate),
      gearName: gearOf(item),
    };
    const current = best.get(key);
    if (current && (current.dataSize || 0) >= (candidate.dataSize || 0)) continue;
    best.set(key, candidate);
  }
  const qualities = [...best.values()].sort((left, right) => {
    const pixels = (right.width || 0) * (right.height || 0) - (left.width || 0) * (left.height || 0);
    if (pixels) return pixels;
    return (right.dataSize || 0) - (left.dataSize || 0);
  });
  if (playUrl && isAllowedCdn(playUrl)) {
    qualities.unshift({
      id: 'original',
      original: true,
      downloadUrl: playUrl,
      width: null,
      height: null,
      dataSize: null,
      codec: '',
      fps: null,
      bitRate: null,
      gearName: 'ratio=default',
    });
  }
  qualities.forEach((quality, index) => {
    if (!quality.id) quality.id = `q${index}`;
    quality.label = qualityLabel(quality);
  });
  const title = text(aweme.desc).split(/\r?\n/)[0].slice(0, 120) || '未命名作品';
  const author = text(aweme.author?.nickname) || text(aweme.nickname);
  const kind = qualities.length
    ? 'video'
    : (Number(aweme.aweme_type) === 68 || images.length ? 'images' : 'video');
  return {
    kind,
    title,
    author,
    videoId,
    thumbUrl: coverUrl(video),
    qualities,
  };
}

function lookupAll(hostname, lookup) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses || [])));
  });
}

export async function assertPublicDouyinHost(hostname, lookup = safeLookup) {
  let addresses;
  try {
    addresses = await lookupAll(hostname, lookup);
  } catch (error) {
    if (error?.code === 'EBLOCKED') throw new MediaError(MEDIA_MESSAGES.outside, 400, 'blocked');
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Down, 502, 'backend_down');
  }
  const usable = (Array.isArray(addresses) ? addresses : []).filter((entry) => entry && !isBlockedAddress(entry.address));
  if (!usable.length) throw new MediaError(MEDIA_MESSAGES.outside, 400, 'blocked');
}

async function drain(response) {
  await response?.body?.cancel?.().catch(() => {});
}

async function requestPage(url, deps, headers, timeoutMs) {
  if (!isAllowedDouyinPage(url)) throw new MediaError(MEDIA_MESSAGES.douyinEntry2Redirect, 400, 'allowlist');
  const target = new URL(url);
  await assertPublicDouyinHost(target.hostname, deps.lookup || safeLookup);
  try {
    return await deps.fetchImpl(target.href, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Down, 502, 'backend_down');
  }
}

export async function resolveDouyinAwemeId(pageUrl, deps) {
  const timeoutMs = deps.timeoutMs ?? 25_000;
  let current;
  try {
    current = httpsPage(pageUrl);
  } catch {
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Id, 400, 'parse_failed');
  }
  if (!isAllowedDouyinPage(current)) throw new MediaError(MEDIA_MESSAGES.douyinEntry2Redirect, 400, 'allowlist');
  const direct = douyinDetailId(current);
  if (direct && AWEME_ID.test(direct)) return direct;
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await requestPage(current, deps, SHARE_HEADERS, timeoutMs);
    const location = response.headers.get('location');
    await drain(response);
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      throw new MediaError(MEDIA_MESSAGES.douyinEntry2Id, 502, 'parse_failed');
    }
    let next;
    try {
      next = httpsPage(new URL(location, current).href);
    } catch {
      throw new MediaError(MEDIA_MESSAGES.douyinEntry2Id, 502, 'parse_failed');
    }
    if (!isAllowedDouyinPage(next)) throw new MediaError(MEDIA_MESSAGES.douyinEntry2Redirect, 400, 'allowlist');
    const id = douyinDetailId(next);
    if (id && AWEME_ID.test(id)) return id;
    current = next;
  }
  throw new MediaError(MEDIA_MESSAGES.douyinEntry2Id, 502, 'parse_failed');
}

async function fetchDetail(awemeId, deps) {
  const url = new URL(DETAIL_URL);
  url.searchParams.set('aweme_id', awemeId);
  url.searchParams.set('aid', '6383');
  url.searchParams.set('device_platform', 'webapp');
  const response = await requestPage(url.href, deps, DETAIL_HEADERS, deps.timeoutMs ?? 25_000);
  if (response.status === 401 || response.status === 403 || [301, 302, 303, 307, 308].includes(response.status)) {
    await drain(response);
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Blocked, 502, 'cookie');
  }
  if (response.status !== 200) {
    await drain(response);
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Down, 502, 'backend_down');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Blocked, 502, 'cookie');
  }
  if (!payload || typeof payload !== 'object' || !payload.aweme_detail || (payload.status_code != null && payload.status_code !== 0)) {
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Blocked, 502, 'cookie');
  }
  return payload.aweme_detail;
}

async function fetchPlayCount(awemeId, deps) {
  const timeoutMs = deps.playCountTimeoutMs ?? 3000;
  try {
    const response = await requestPage(
      `https://jingxuan.douyin.com/m/video/${awemeId}?app=yumme`,
      deps,
      PLAY_COUNT_HEADERS,
      timeoutMs,
    );
    if (response.status !== 200) {
      await drain(response);
      return null;
    }
    const html = await response.text();
    const match = html.match(/"play_count"\s*:\s*(\d{1,12})/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function waitForCount(countPromise, graceMs) {
  let timer;
  const limited = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), graceMs);
  });
  return Promise.race([countPromise, limited]).finally(() => clearTimeout(timer));
}

export async function parseDouyinEntry2(text, deps) {
  const target = extractShareTarget(text);
  if (!target || target.platform !== 'douyin') {
    throw new MediaError(MEDIA_MESSAGES.douyinEntry2Link, 400, 'no_link');
  }
  const awemeId = await resolveDouyinAwemeId(target.url, deps);
  const countPromise = fetchPlayCount(awemeId, deps);
  const detail = await fetchDetail(awemeId, deps);
  const playCount = await waitForCount(countPromise, deps.playCountGraceMs ?? PLAY_COUNT_GRACE_MS);
  const mapped = mapDouyinQualities(detail);
  if (!mapped) throw new MediaError(MEDIA_MESSAGES.douyinEntry2Blocked, 502, 'parse_failed');
  if (mapped.kind === 'images') throw new MediaError(MEDIA_MESSAGES.douyinEntry2Images, 502, 'parse_failed');
  if (!mapped.qualities.length) throw new MediaError(MEDIA_MESSAGES.douyinEntry2Empty, 502, 'parse_failed');
  const qualities = mapped.qualities.map((quality, index) => {
    const name = mediaFilename(mapped.title, index, 'video', quality.downloadUrl);
    const url = deps.proxify(quality.downloadUrl, { platform: 'douyin', kind: 'video', filename: name });
    let thumb = null;
    if (mapped.thumbUrl) {
      thumb = deps.proxify(mapped.thumbUrl, {
        platform: 'douyin',
        kind: 'image',
        filename: mediaFilename(mapped.title, index, 'image', mapped.thumbUrl),
      });
    }
    return {
      id: quality.id,
      label: quality.label,
      width: quality.width,
      height: quality.height,
      dataSize: quality.dataSize,
      codec: quality.codec || '',
      fps: quality.fps,
      bitRate: quality.bitRate,
      gearName: quality.gearName || '',
      url,
      thumb,
      name,
    };
  });
  return {
    platform: 'douyin',
    entry: 2,
    title: mapped.title,
    author: mapped.author,
    awemeId,
    playCount: Number.isSafeInteger(playCount) ? playCount : null,
    type: 'video',
    qualities,
  };
}

function headerPairs(headers) {
  const pairs = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null || value === '') continue;
    pairs.push([key, String(value)]);
  }
  return pairs;
}

export function createDouyinFetch({ lookup = safeLookup, maxBytes = MAX_BYTES } = {}) {
  return function douyinFetch(url, init = {}) {
    let target;
    try {
      target = new URL(url);
    } catch {
      return Promise.reject(new MediaError(MEDIA_MESSAGES.outside, 400, 'allowlist'));
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || isIP(host)) {
      return Promise.reject(new MediaError(MEDIA_MESSAGES.outside, 400, 'allowlist'));
    }
    const lib = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const timeoutMs = init.signal?.aborted ? 1 : 20_000;
    return new Promise((resolve, reject) => {
      const req = lib({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method || 'GET',
        headers: Object.fromEntries(headerPairs(init.headers)),
        lookup,
        timeout: timeoutMs,
      }, (response) => {
        const chunks = [];
        let size = 0;
        let failed = false;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            failed = true;
            response.destroy();
            reject(Object.assign(new Error('response too large'), { code: 'EMAX' }));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          if (failed) return;
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value == null) continue;
            const list = Array.isArray(value) ? value : [value];
            for (const item of list) headers.append(key, item);
          }
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers }));
        });
        response.on('error', reject);
      });
      const abort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal) {
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      }
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end();
    });
  };
}
