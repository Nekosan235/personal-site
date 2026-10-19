import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

export function publicSshError(error) {
  if (typeof error?.publicMessage === 'string' && error.publicMessage) return error.publicMessage;
  const code = String(error?.code || '');
  const text = `${code} ${error?.level || ''} ${error?.message || ''}`;
  if (['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) {
    return '无法连接这台服务器';
  }
  if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(text)) return '连接超时';
  if (code === 'EACCES' || code === 'ENOENT' || code === 'EPERM') return '这台服务器的登录凭据不可用';
  if (/fingerprint|host key verification/i.test(text)) return '主机指纹不匹配';
  if (/authentication/i.test(text)) return '登录失败';
  return '连接失败';
}

function failure(error) {
  const message = publicSshError(error);
  return Object.assign(new Error(message), { publicMessage: message, code: error?.code || 'ssh_failed' });
}

function readCredentials(target) {
  try {
    if (target.privateKeyFile) return { privateKey: readFileSync(target.privateKeyFile) };
    if (target.privateKey) return { privateKey: target.privateKey };
    if (target.passwordFile) {
      const password = readFileSync(target.passwordFile, 'utf8').replace(/\r?\n$/, '');
      if (!password) throw Object.assign(new Error('empty password file'), { code: 'ENOENT' });
      return { password };
    }
    if (target.password) return { password: target.password };
  } catch (error) {
    throw failure({ code: error?.code === 'ENOENT' ? 'ENOENT' : 'EACCES' });
  }
  throw failure({ code: 'EACCES' });
}

function fingerprintMatches(expected, key) {
  const actual = Buffer.from(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`);
  const wanted = Buffer.from(String(expected).trim());
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function dialSsh(target) {
  const client = new Client();
  let stream = null;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    try { client.end(); } catch { /* already closing */ }
    rejectPromise(failure(error));
  };
  let rejectPromise = () => {};
  let resolvePromise = () => {};
  const done = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function cancel() {
    try { stream?.close(); } catch { /* stream may not exist */ }
    try { client.end(); } catch { /* already closing */ }
  }

  client.on('error', (error) => {
    if (!settled) fail(error);
  });
  client.on('close', () => {
    if (!settled) fail({ code: 'ECONNREFUSED', message: 'closed' });
  });
  client.on('ready', () => {
    if (settled) {
      client.end();
      return;
    }
    client.shell({
      term: 'xterm-256color',
      cols: target.cols || 80,
      rows: target.rows || 24,
    }, (error, channel) => {
      if (error) {
        fail(error);
        return;
      }
      stream = channel;
      settled = true;
      const bridge = {
        write(chunk) {
          stream.write(chunk);
        },
        resize(cols, rows) {
          stream.setWindow(rows, cols, 0, 0);
        },
        close: cancel,
        onData(callback) {
          stream.on('data', (chunk) => callback(Buffer.from(chunk)));
          stream.stderr?.on('data', (chunk) => callback(Buffer.from(chunk)));
        },
        onClose(callback) {
          stream.on('close', callback);
        },
        onError(callback) {
          client.on('error', callback);
          stream.on('error', callback);
        },
      };
      resolvePromise(bridge);
    });
  });

  try {
    const credentials = readCredentials(target);
    client.connect({
      host: target.dialHost,
      port: target.port || 22,
      username: target.username,
      readyTimeout: target.readyTimeoutMs || 15_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: false,
      ...credentials,
      hostVerifier(key) {
        if (!target.hostFingerprint) return true;
        return fingerprintMatches(target.hostFingerprint, key);
      },
    });
  } catch (error) {
    fail(error);
  }

  return { done, cancel };
}
