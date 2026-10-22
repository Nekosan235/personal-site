import { createHash, timingSafeEqual } from 'node:crypto';

export const HOSTKEY_UNSET_MESSAGE = '未配置主机指纹，已拒绝连接';
export const HOSTKEY_MISMATCH_MESSAGE = '主机指纹不匹配';
export const HOSTKEY_INVALID_MESSAGE = '主机指纹配置无效，已拒绝连接';

export function fingerprintHostKey(key) {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export function parseHostFingerprints(value) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: true, fingerprints: [] };
  const token = () => /SHA256:[A-Za-z0-9+/]{20,128}={0,2}/gi;
  const fingerprints = [];
  const seen = new Set();
  for (const match of text.matchAll(token())) {
    const normalized = `SHA256:${match[0].replace(/^SHA256:/i, '').replace(/=+$/, '')}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    fingerprints.push(normalized);
  }
  const leftover = text.replace(token(), '');
  if (/SHA256:/i.test(leftover) || fingerprints.length === 0) return { ok: false, fingerprints: [] };
  return { ok: true, fingerprints };
}

export function isAcceptableFingerprint(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  const parsed = parseHostFingerprints(text);
  return parsed.ok && parsed.fingerprints.join(',') === text;
}

export function hostKeyAccepted(fingerprints, key) {
  const bytes = Buffer.isBuffer(key) ? key : (typeof key === 'string' ? Buffer.from(key) : null);
  if (!bytes || !fingerprints?.length) return false;
  const actual = Buffer.from(fingerprintHostKey(bytes));
  return fingerprints.some((expected) => {
    const wanted = Buffer.from(String(expected));
    return wanted.length === actual.length && timingSafeEqual(wanted, actual);
  });
}
