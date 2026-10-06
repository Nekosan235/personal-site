const COOKIE_NAMES = Object.freeze({
  session: 'ps_session',
  prelogin: 'ps_prelogin',
});

export { COOKIE_NAMES };

export function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function clearCookie(name, config) {
  return serializeCookie(name, '', {
    maxAge: 0,
    expires: new Date(0),
    secure: config.cookieSecure,
  });
}

export function sessionCookie(token, config) {
  return serializeCookie(COOKIE_NAMES.session, token, {
    maxAge: Math.floor(config.sessionTtlMs / 1000),
    secure: config.cookieSecure,
  });
}

export function preloginCookie(value, config) {
  return serializeCookie(COOKIE_NAMES.prelogin, value, {
    maxAge: Math.floor(config.loginTtlMs / 1000),
    secure: config.cookieSecure,
  });
}
