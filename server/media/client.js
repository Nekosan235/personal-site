import { douyinDetailId, extractShareTarget } from '../../public/assets/components/media-links.js';
import { assertLoopbackBase } from './allowlist.js';
import { MEDIA_MESSAGES, MediaError } from './errors.js';
import { normalizeDouyinWork, normalizeXhsWork } from './normalize.js';
import { readXhsToken } from './token.js';

function endpoint(origin, path) {
  return new URL(path, `${origin}/`);
}

function tokenError(error) {
  if (error?.code === 'ENOENT') return new MediaError(MEDIA_MESSAGES.xhsTokenFileMissing, 502, 'token_file');
  if (error?.code === 'EINVAL' || error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new MediaError(MEDIA_MESSAGES.xhsTokenUnreadable, 502, 'token_file');
  }
  return new MediaError(MEDIA_MESSAGES.xhsTokenUnreadable, 502, 'token_file');
}

async function postJson(fetchImpl, url, body, headers, timeoutMs, downMessage, rejectedMessage) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new MediaError(downMessage, 502, 'backend_down');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel?.().catch(() => {});
    throw new MediaError(rejectedMessage, 502, 'token_rejected');
  }
  if (response.status >= 500 || response.status < 200 || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {});
    throw new MediaError(downMessage, 502, 'backend_down');
  }
  try {
    return await response.json();
  } catch {
    throw new MediaError(downMessage, 502, 'backend_down');
  }
}

function emptyData(data) {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data !== 'object') return true;
  return Object.keys(data).length === 0;
}

async function xhsAuthorization(config) {
  let token = '';
  try {
    token = await readXhsToken(config);
  } catch (error) {
    throw tokenError(error);
  }
  if (!token) throw new MediaError(MEDIA_MESSAGES.xhsTokenMissing, 502, 'missing_token');
  return { Authorization: `Bearer ${token}` };
}

async function parseXhs(url, deps) {
  const origin = assertLoopbackBase(deps.config.xhsApiUrl);
  if (!origin) throw new MediaError(MEDIA_MESSAGES.loopback, 500, 'config');
  const headers = await xhsAuthorization(deps.config);
  const payload = await postJson(
    deps.fetchImpl,
    endpoint(origin, '/xhs/detail'),
    { url, download: false },
    headers,
    deps.timeoutMs,
    MEDIA_MESSAGES.xhsDown,
    MEDIA_MESSAGES.xhsTokenRejected,
  );
  const message = typeof payload?.message === 'string' ? payload.message : '';
  if (message.includes('提取小红书作品链接失败')) throw new MediaError(MEDIA_MESSAGES.xhsLink, 502, 'parse_failed');
  if (message === '获取小红书作品数据失败' || emptyData(payload?.data)) {
    throw new MediaError(MEDIA_MESSAGES.xhsFailed, 502, 'parse_failed');
  }
  const work = normalizeXhsWork(payload.data, deps.proxify);
  if (!work) throw new MediaError(MEDIA_MESSAGES.noFile, 502, 'parse_failed');
  return work;
}

function shareUrl(payload) {
  if (typeof payload?.url === 'string' && payload.url.startsWith('http')) return payload.url;
  if (typeof payload?.data === 'string' && payload.data.startsWith('http')) return payload.data;
  return '';
}

async function parseDouyin(url, deps) {
  const origin = assertLoopbackBase(deps.config.douyinApiUrl);
  if (!origin) throw new MediaError(MEDIA_MESSAGES.loopback, 500, 'config');
  const headers = {};
  if (deps.config.douyinApiToken && !/[\r\n]/.test(deps.config.douyinApiToken)) headers.token = deps.config.douyinApiToken;
  const shared = await postJson(
    deps.fetchImpl,
    endpoint(origin, '/douyin/share'),
    { text: url },
    headers,
    deps.timeoutMs,
    MEDIA_MESSAGES.douyinDown,
    MEDIA_MESSAGES.douyinTokenRejected,
  );
  const resolved = shareUrl(shared);
  const detailId = resolved ? douyinDetailId(resolved) : '';
  if (!detailId) throw new MediaError(MEDIA_MESSAGES.douyinShare, 502, 'parse_failed');
  const detailBody = { detail_id: detailId };
  if (deps.config.douyinCookie) detailBody.cookie = deps.config.douyinCookie;
  const detail = await postJson(
    deps.fetchImpl,
    endpoint(origin, '/douyin/detail'),
    detailBody,
    headers,
    deps.timeoutMs,
    MEDIA_MESSAGES.douyinDown,
    MEDIA_MESSAGES.douyinTokenRejected,
  );
  if (detail?.data == null || detail?.message === '获取数据失败！') {
    throw new MediaError(MEDIA_MESSAGES.douyinCookie, 502, 'cookie');
  }
  const work = normalizeDouyinWork(detail.data, deps.proxify);
  if (!work) throw new MediaError(MEDIA_MESSAGES.noFile, 502, 'parse_failed');
  return work;
}

export async function parseShareText(text, deps) {
  const target = extractShareTarget(text);
  if (!target) throw new MediaError(MEDIA_MESSAGES.noLink, 400, 'no_link');
  if (target.platform === 'xiaohongshu') return parseXhs(target.url, deps);
  return parseDouyin(target.url, deps);
}
