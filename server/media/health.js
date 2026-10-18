import { assertLoopbackBase } from './allowlist.js';
import { readXhsToken } from './token.js';

function originOf(value) {
  return assertLoopbackBase(value);
}

async function cancel(response) {
  await response?.body?.cancel?.().catch(() => {});
}

export async function probeXhs(baseUrl, token, fetchImpl, timeoutMs) {
  const origin = originOf(baseUrl);
  if (!origin) return { ok: false, reason: 'down' };
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const response = await fetchImpl(new URL('/xhs/detail', `${origin}/`), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: 'healthcheck', download: false }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      await cancel(response);
      return { ok: false, reason: 'token_rejected' };
    }
    if (response.status >= 200 && response.status < 500) {
      await cancel(response);
      return { ok: true };
    }
    await cancel(response);
    return { ok: false, reason: 'down' };
  } catch {
    return { ok: false, reason: 'down' };
  }
}

export async function probeDouyin(baseUrl, fetchImpl, timeoutMs) {
  const origin = originOf(baseUrl);
  if (!origin) return { ok: false, reason: 'down' };
  try {
    const response = await fetchImpl(new URL('/openapi.json', `${origin}/`), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 200 && response.status < 400) {
      await cancel(response);
      return { ok: true };
    }
    await cancel(response);
    return { ok: false, reason: 'down' };
  } catch {
    return { ok: false, reason: 'down' };
  }
}

export async function checkMediaBackends(config, fetchImpl = globalThis.fetch) {
  const timeoutMs = Number(config.mediaProbeTimeoutMs || config.timeoutMs || 4000);
  let token = '';
  let tokenFailure = null;
  try {
    token = await readXhsToken(config);
  } catch (error) {
    tokenFailure = error?.code === 'ENOENT' ? 'token_file' : 'token_file';
  }
  const [xiaohongshu, douyin] = await Promise.all([
    tokenFailure
      ? Promise.resolve({ ok: false, reason: tokenFailure })
      : probeXhs(config.xhsApiUrl, token, fetchImpl, timeoutMs),
    probeDouyin(config.douyinApiUrl, fetchImpl, timeoutMs),
  ]);
  return {
    xiaohongshu: { ...xiaohongshu, url: config.xhsApiUrl },
    douyin: { ...douyin, url: config.douyinApiUrl },
  };
}

export function publicMediaStatus(result) {
  function one(item) {
    if (item?.ok) return { ok: true };
    return { ok: false, reason: item?.reason || 'down' };
  }
  return { xiaohongshu: one(result.xiaohongshu), douyin: one(result.douyin) };
}
