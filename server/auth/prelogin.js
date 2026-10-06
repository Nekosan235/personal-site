import { createHmac, timingSafeEqual } from 'node:crypto';

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createPreloginToken({ csrf, expires }, secret) {
  const payload = Buffer.from(JSON.stringify({ csrf, expires })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPreloginToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, mac, extra] = String(token).split('.');
  if (!payload || !mac || extra) return null;
  if (!safeEqual(mac, sign(payload, secret))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.csrf || !data.expires || Number(data.expires) <= now) return null;
    return { csrf: String(data.csrf), expires: Number(data.expires) };
  } catch {
    return null;
  }
}
