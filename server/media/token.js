import { readFile, stat } from 'node:fs/promises';

const cache = new Map();

export function clearXhsTokenCache() {
  cache.clear();
}

function cleanToken(value) {
  const token = String(value ?? '').trim();
  if (!token) return '';
  if (/[\r\n]/.test(token)) {
    const error = new Error('invalid token');
    error.code = 'EINVAL';
    throw error;
  }
  return token;
}

async function readTokenFile(file) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    error.code = error.code || 'EACCES';
    throw error;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && Date.now() - cached.readAt < 60_000) return cached.token;
  let token = '';
  try {
    token = cleanToken(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'EINVAL') throw error;
    error.code = error.code || 'EACCES';
    throw error;
  }
  cache.set(file, { token, mtimeMs: info.mtimeMs, readAt: Date.now() });
  return token;
}

export async function readXhsToken({ xhsApiToken = '', xhsApiTokenFile = '' } = {}) {
  const inline = cleanToken(xhsApiToken);
  if (inline) return inline;
  const file = String(xhsApiTokenFile || '').trim();
  if (!file) return '';
  return readTokenFile(file);
}
