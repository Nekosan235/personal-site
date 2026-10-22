import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  HOSTKEY_INVALID_MESSAGE,
  HOSTKEY_MISMATCH_MESSAGE,
  HOSTKEY_UNSET_MESSAGE,
  hostKeyAccepted,
  parseHostFingerprints,
} from './hostkey.js';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

export function publicSshError(error) {
  if (typeof error?.publicMessage === 'string' && error.publicMessage) return error.publicMessage;
  const code = String(error?.code || '');
  const text = `${code} ${error?.level || ''} ${error?.message || ''}`;
  if (code === 'HOSTKEY_UNSET') return HOSTKEY_UNSET_MESSAGE;
  if (code === 'HOSTKEY_MISMATCH') return HOSTKEY_MISMATCH_MESSAGE;
  if (code === 'HOSTKEY_INVALID') return HOSTKEY_INVALID_MESSAGE;
  if (['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) {
    return '无法连接这台服务器';
  }
  if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(text)) return '连接超时';
  if (code === 'EACCES' || code === 'ENOENT' || code === 'EPERM') return '这台服务器的登录凭据不可用';
  if (/privateKey|passphrase/i.test(text)) return '这台服务器的登录凭据不可用';
  if (/fingerprint|host key verification|verification failed|host denied/i.test(text)) return HOSTKEY_MISMATCH_MESSAGE;
  if (/authentication/i.test(text)) return '登录失败';
  return '连接失败';
}

function failure(error) {
  const message = publicSshError(error);
  return Object.assign(new Error(message), { publicMessage: message, code: error?.code || 'ssh_failed' });
}

function readCredentials(target) {
  const credentials = {};
  try {
    if (target.privateKeyFile) credentials.privateKey = readFileSync(target.privateKeyFile);
    else if (target.privateKey) credentials.privateKey = target.privateKey;
    if (target.passwordFile) {
      const password = readFileSync(target.passwordFile, 'utf8').replace(/\r?\n$/, '');
      if (!password) throw Object.assign(new Error('empty password file'), { code: 'ENOENT' });
      credentials.password = password;
    } else if (target.password) credentials.password = target.password;
  } catch (error) {
    throw failure({ code: error?.code === 'ENOENT' ? 'ENOENT' : 'EACCES' });
  }
  if (!credentials.privateKey && !credentials.password) throw failure({ code: 'EACCES' });
  return credentials;
}

function logRefusal(target, code) {
  const id = String(target?.id || 'unknown').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  console.info(`personal-site terminal: refused target=${id} reason=${code}`);
}

function refused(target, code, publicMessage) {
  logRefusal(target, code);
  const error = failure({ code, publicMessage });
  return { done: Promise.reject(error), cancel() {} };
}

export function dialSsh(target) {
  const parsed = parseHostFingerprints(target.hostFingerprint);
  if (String(target.hostFingerprint || '').trim() && !parsed.ok) {
    return refused(target, 'HOSTKEY_INVALID', HOSTKEY_INVALID_MESSAGE);
  }
  if (!parsed.fingerprints.length && !target.trustOnFirstUse) {
    return refused(target, 'HOSTKEY_UNSET', HOSTKEY_UNSET_MESSAGE);
  }

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
    const connectOptions = {
      host: target.dialHost,
      port: target.port || 22,
      username: target.username,
      readyTimeout: target.readyTimeoutMs || 15_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: false,
      ...credentials,
      hostVerifier(key) {
        if (!parsed.fingerprints.length) return Boolean(target.trustOnFirstUse);
        if (hostKeyAccepted(parsed.fingerprints, key)) return true;
        logRefusal(target, 'HOSTKEY_MISMATCH');
        fail({
          code: 'HOSTKEY_MISMATCH',
          message: 'host key verification failed',
          publicMessage: HOSTKEY_MISMATCH_MESSAGE,
        });
        return false;
      },
    };
    if (credentials.privateKey) {
      connectOptions.authHandler = credentials.password ? ['publickey', 'password'] : ['publickey'];
    }
    client.connect(connectOptions);
  } catch (error) {
    fail(error);
  }

  return { done, cancel };
}
