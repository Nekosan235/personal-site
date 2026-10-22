import { BlockList, isIP } from 'node:net';

const nat64 = new BlockList();
nat64.addSubnet('64:ff9b::', 96, 'ipv6');

const XHS_EXACT = new Set([
  'ci.xiaohongshu.com',
  'sns-img.xiaohongshu.com',
  'sns-video.xiaohongshu.com',
  'sns-webpic.xiaohongshu.com',
]);

const XHS_SUFFIXES = ['xhscdn.com'];

const DOUYIN_SUFFIXES = [
  'douyinvod.com',
  'douyinpic.com',
  'douyinstatic.com',
  'douyincdn.com',
  'byteimg.com',
  'ibyteimg.com',
  'bytecdn.cn',
  'bytecdn.com',
  'bytecdntp.com',
  'ibytedtos.com',
  'bytetos.com',
  'pstatp.com',
  'snssdk.com',
  'amemv.com',
  '365yg.com',
  'zjcdn.com',
];

function suffixMatch(host, suffixes) {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isAllowedCdn(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.port) {
    const expected = url.protocol === 'https:' ? '443' : '80';
    if (url.port !== expected) return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || isIP(host)) return false;
  return XHS_EXACT.has(host) || suffixMatch(host, XHS_SUFFIXES) || suffixMatch(host, DOUYIN_SUFFIXES);
}

export function isBlockedAddress(value) {
  let ip = String(value || '').trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    if (nat64.check(ip, 'ipv6')) return true;
    return false;
  }
  return true;
}

export function assertLoopbackBase(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
  if (url.username || url.password) return null;
  return url.origin;
}
