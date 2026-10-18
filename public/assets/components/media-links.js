const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、【】]+/gi;
const TRAILING_PUNCTUATION = /[),.;:!?，。！？、）】》>]+$/u;

const PLATFORM_HOSTS = [
  ['xiaohongshu', ['xhslink.com', 'xiaohongshu.com']],
  ['douyin', ['douyin.com', 'iesdouyin.com']],
];

function normalizedHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

function hostMatches(hostname, domain) {
  const host = normalizedHost(hostname);
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectPlatform(value) {
  let hostname = '';
  try {
    hostname = new URL(value).hostname;
  } catch {
    return null;
  }
  for (const [platform, domains] of PLATFORM_HOSTS) {
    if (domains.some((domain) => hostMatches(hostname, domain))) return platform;
  }
  return null;
}

export function extractUrls(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(URL_PATTERN)) {
    const cleaned = match[0].replace(TRAILING_PUNCTUATION, '');
    try {
      const url = new URL(cleaned);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (url.username || url.password) continue;
      found.push(url.href);
    } catch {
      // Ignore pieces of text that only look like URLs.
    }
  }
  return found;
}

export function extractShareTarget(text) {
  for (const url of extractUrls(text)) {
    const platform = detectPlatform(url);
    if (platform) return { platform, url };
  }
  return null;
}

export function douyinDetailId(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const fromQuery = url.searchParams.get('modal_id') || url.searchParams.get('aweme_id');
  if (fromQuery && /^\d{6,}$/.test(fromQuery)) return fromQuery;
  const named = url.pathname.match(/\/(?:video|note|slides|share\/video|share\/note)\/(\d{6,})/);
  if (named) return named[1];
  const tail = url.pathname.match(/\/(\d{15,})\/?$/);
  return tail ? tail[1] : null;
}

export function xhsLinkNeedsToken(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!hostMatches(url.hostname, 'xiaohongshu.com') || hostMatches(url.hostname, 'xhslink.com')) return false;
  return !url.searchParams.get('xsec_token');
}
