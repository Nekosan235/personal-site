import { isIP } from 'node:net';

export function clientIp(req) {
  const remote = req.socket?.remoteAddress ?? '';
  const normalizedRemote = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  const isTrustedProxy = normalizedRemote === '127.0.0.1' || normalizedRemote === '::1';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (isTrustedProxy && typeof forwarded === 'string' && forwarded.trim()) {
    const candidate = forwarded.split(',')[0].trim();
    if (isIP(candidate)) return candidate;
  }
  return isIP(normalizedRemote) ? normalizedRemote : 'unknown';
}
