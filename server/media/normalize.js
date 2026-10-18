import { isAllowedCdn } from './allowlist.js';

const EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'gif']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function urlList(value) {
  const source = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const urls = [];
  for (const entry of source) {
    const candidate = text(entry);
    if (!candidate || candidate.toLowerCase() === 'nan') continue;
    if (!isAllowedCdn(candidate)) continue;
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  return urls;
}

function positiveSize(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

export function mediaExtension(value, kind) {
  try {
    const url = new URL(value);
    const fromPath = url.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (fromPath && EXTENSIONS.has(fromPath[1].toLowerCase())) {
      return fromPath[1].toLowerCase() === 'jpeg' ? 'jpg' : fromPath[1].toLowerCase();
    }
    const fromQuery = `${url.search}`.match(/format\/(png|webp|jpe?g|heic|gif|mp4|mov|m4v|webm)/i);
    if (fromQuery) return fromQuery[1].toLowerCase() === 'jpeg' ? 'jpg' : fromQuery[1].toLowerCase();
  } catch {
    // Fall through to the kind default.
  }
  return kind === 'video' ? 'mp4' : 'jpg';
}

export function mediaFilename(title, index, kind, cdnUrl) {
  const base = text(title).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'media';
  return `${base}-${index + 1}.${mediaExtension(cdnUrl, kind)}`;
}

function isVideoUrl(value) {
  return /^(mp4|mov|m4v|webm)$/.test(mediaExtension(value, 'image'));
}

function item(proxify, { cdnUrl, kind, title, index, platform, width, height, thumbUrl }) {
  const filename = mediaFilename(title, index, kind, cdnUrl);
  const url = proxify(cdnUrl, { kind, filename, platform });
  let thumb = null;
  if (kind === 'image') thumb = url;
  else if (thumbUrl && isAllowedCdn(thumbUrl)) {
    thumb = proxify(thumbUrl, {
      kind: 'image',
      filename: mediaFilename(title, index, 'image', thumbUrl).replace(/\.[^.]+$/, '') + '-cover.' + mediaExtension(thumbUrl, 'image'),
      platform,
    });
  }
  return { kind, url, thumb, width, height, name: filename };
}

function coverUrl(value) {
  const urls = urlList(value);
  return urls[0] || '';
}

export function normalizeXhsWork(data, proxify) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const downloads = urlList(data['下载地址']);
  const live = urlList(data['动图地址']);
  const title = text(data['作品标题']) || text(data['作品描述']).split(/\r?\n/)[0] || text(data['作品ID']) || '未命名作品';
  const author = text(data['作者昵称']) || text(data['作者ID']);
  const declared = text(data['作品类型']);
  const type = declared === '视频' || (declared !== '图文' && declared !== '图集' && downloads.length === 1 && isVideoUrl(downloads[0]))
    ? 'video'
    : 'images';
  const fallbackKind = type === 'video' ? 'video' : 'image';
  const thumbSource = coverUrl(data['封面地址']);
  const items = [];
  downloads.forEach((cdnUrl, index) => {
    const kind = type === 'video' ? 'video' : (isVideoUrl(cdnUrl) ? 'video' : 'image');
    items.push(item(proxify, {
      cdnUrl,
      kind: kind || fallbackKind,
      title,
      index,
      platform: 'xiaohongshu',
      width: null,
      height: null,
      thumbUrl: kind === 'video' ? thumbSource : '',
    }));
  });
  for (const cdnUrl of live) {
    if (downloads.includes(cdnUrl)) continue;
    items.push(item(proxify, {
      cdnUrl,
      kind: 'video',
      title,
      index: items.length,
      platform: 'xiaohongshu',
      width: null,
      height: null,
      thumbUrl: thumbSource,
    }));
  }
  if (!items.length) return null;
  return { platform: 'xiaohongshu', title, author, type: type === 'video' ? 'video' : 'images', items };
}

export function normalizeDouyinWork(data, proxify) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const downloads = urlList(data.downloads);
  const title = text(data.desc) || text(data.id) || '未命名作品';
  const author = text(data.nickname) || text(data.author?.nickname) || text(data['作者昵称']);
  const declared = text(data.type);
  const width = positiveSize(data.width);
  const height = positiveSize(data.height);
  const thumbSource = coverUrl(data.static_cover) || coverUrl(data.dynamic_cover);
  const type = declared === '视频' || (declared !== '图集' && declared !== '实况' && downloads.length === 1 && isVideoUrl(downloads[0]))
    ? 'video'
    : 'images';
  const items = downloads.map((cdnUrl, index) => {
    const kind = type === 'video' ? 'video' : (isVideoUrl(cdnUrl) ? 'video' : 'image');
    return item(proxify, {
      cdnUrl,
      kind,
      title,
      index,
      platform: 'douyin',
      width: kind === 'video' ? width : null,
      height: kind === 'video' ? height : null,
      thumbUrl: kind === 'video' ? thumbSource : '',
    });
  });
  if (!items.length) return null;
  return { platform: 'douyin', title, author, type, items };
}
