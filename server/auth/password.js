import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });

let activeChecks = 0;
const queue = [];
let maxConcurrentChecks = 2;
let maxQueuedChecks = 16;

export class PasswordCheckOverloadedError extends Error {
  constructor() {
    super('Password verification queue is overloaded');
    this.statusCode = 503;
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

function parseHash(encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('Unsupported password hash format');
  }
  const [, N, r, p, salt, key] = parts;
  return {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    salt: fromBase64url(salt),
    key: fromBase64url(key),
  };
}

function runLimited(task) {
  return new Promise((resolve, reject) => {
    if (queue.length >= maxQueuedChecks) {
      reject(new PasswordCheckOverloadedError());
      return;
    }
    queue.push({ task, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (activeChecks < maxConcurrentChecks && queue.length > 0) {
    const item = queue.shift();
    activeChecks += 1;
    item
      .task()
      .then(item.resolve, item.reject)
      .finally(() => {
        activeChecks -= 1;
        drainQueue();
      });
  }
}

export function configurePasswordChecks({ maxConcurrent = 2, maxQueued = 16 } = {}) {
  maxConcurrentChecks = Math.max(1, Number(maxConcurrent) || 1);
  maxQueuedChecks = Math.max(1, Number(maxQueued) || 1);
}

export async function hashPassword(password, params = DEFAULT_PARAMS) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${base64url(salt)}$${base64url(key)}`;
}

export async function verifyPassword(password, encodedHash) {
  if (!encodedHash || typeof password !== 'string') return false;

  try {
    const parsed = parseHash(encodedHash);
    const derived = await runLimited(() =>
      scrypt(password, parsed.salt, parsed.key.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
      }),
    );
    return parsed.key.length === derived.length && timingSafeEqual(parsed.key, derived);
  } catch (error) {
    if (error instanceof PasswordCheckOverloadedError) throw error;
    return false;
  }
}
