#!/usr/bin/env node
// Loopback bridge between personal-site's meeting summaries (MEETINGS_SUMMARY_PROVIDER=codex-http)
// and the Codex CLI. It runs as the account that owns the Codex login, so personal-site's own
// systemd sandbox never needs access to that login.
//
//   POST /summarize   Authorization: Bearer <token>
//        { input: "<prompt + meeting info + transcript>", ... }   ->   200 { markdown, model }
//   GET  /healthz     -> 200 { ok: true, busy }
//
// Codex runs as:  codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never
//                   -C <fresh empty dir> -o <dir>/last-message.md [-m <model>] -
// with the input on stdin. No shell, one job at a time, killed when the caller goes away.
//
// Environment:
//   CODEX_BRIDGE_ADDR        127.0.0.1:3461 (must be a loopback address)
//   CODEX_BRIDGE_TOKEN       shared secret, 24+ characters (or CODEX_BRIDGE_TOKEN_FILE)
//   CODEX_BRIDGE_BIN         codex executable (default: codex on PATH)
//   CODEX_BRIDGE_MODEL       optional -m value; empty = Codex's own config.toml default
//   CODEX_BRIDGE_TIMEOUT_MS  per job, default 600000 (10 min)
//   CODEX_BRIDGE_MAX_BYTES   request body cap, default 4 MiB
//   CODEX_BRIDGE_API_KEY_FILE optional: read once at startup and exported to Codex as
//                            $CODEX_BRIDGE_API_KEY_ENV (default MAGPIE_API_KEY), matching
//                            `env_key` in the bridge's own CODEX_HOME/config.toml. Keeps the
//                            relay key out of the unit file and the process listing.
// Nothing from the request body is ever logged.

import { createServer } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const KILL_GRACE_MS = 5000;
const STDERR_TAIL = 2000;

export class BridgeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

export function parseAddr(value = '127.0.0.1:3461') {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(value).trim());
  if (!match) throw new Error(`CODEX_BRIDGE_ADDR must look like 127.0.0.1:3461, got ${value}`);
  const [, host, portText] = match;
  const port = Number(portText);
  if (!LOOPBACK.has(host)) throw new Error('CODEX_BRIDGE_ADDR must be a loopback address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CODEX_BRIDGE_ADDR port is invalid');
  return { host, port };
}

export function loadToken(env = process.env, read = (path) => readFileSync(path, 'utf8')) {
  const token = (env.CODEX_BRIDGE_TOKEN_FILE ? read(env.CODEX_BRIDGE_TOKEN_FILE) : env.CODEX_BRIDGE_TOKEN ?? '').trim();
  if (token.length < 24 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('CODEX_BRIDGE_TOKEN (or CODEX_BRIDGE_TOKEN_FILE) must be 24+ visible ASCII characters');
  }
  return token;
}

// Relay model ids often carry a namespace ("group/auto-deepseek").
export const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,96}$/;

/** Environment for the Codex child: the bridge's own env plus the relay key, if configured. */
export function codexEnv(env = process.env, read = (path) => readFileSync(path, 'utf8')) {
  const file = (env.CODEX_BRIDGE_API_KEY_FILE ?? '').trim();
  if (!file) return env;
  const name = (env.CODEX_BRIDGE_API_KEY_ENV ?? 'MAGPIE_API_KEY').trim();
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) throw new Error('CODEX_BRIDGE_API_KEY_ENV must be an environment variable name');
  const key = read(file).trim();
  if (key.length < 8 || !/^[\x21-\x7e]+$/.test(key)) throw new Error('CODEX_BRIDGE_API_KEY_FILE does not contain a usable key');
  const { CODEX_BRIDGE_TOKEN: _token, ...rest } = env; // never hand the bridge token to Codex
  return { ...rest, [name]: key };
}

export function codexArgs({ cwd, outputFile, model }) {
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '-C', cwd, '--output-last-message', outputFile];
  if (model) args.push('-m', model);
  args.push('-');
  return args;
}

function sameToken(header, token) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { reject(new BridgeError('request too large', 413)); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new BridgeError('request too large', 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Runs one Codex job; resolves with the last message text. */
export async function runCodex({ input, bin, model, timeoutMs, signal, spawn = nodeSpawn, logger = console, env = process.env }) {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-bridge-'));
  const outputFile = join(cwd, 'last-message.md'); // written by the CLI itself after the run
  let child;
  let killTimer;
  let stdout = '';
  let stderr = '';
  try {
    const exit = await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new BridgeError('caller went away', 499)); return; }
      try {
        child = spawn(bin, codexArgs({ cwd, outputFile, model }), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch (error) {
        reject(error?.code === 'ENOENT' ? new BridgeError('codex executable not found', 500) : error);
        return;
      }
      const stop = (reason) => {
        if (!child || child.exitCode !== null || child.killed) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
        reject(reason);
      };
      // Not unref'd: the job deadline must fire even if nothing else keeps the process busy.
      const timer = setTimeout(() => stop(new BridgeError('codex timed out', 504)), timeoutMs);
      const onAbort = () => stop(new BridgeError('caller went away', 499));
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (text) => { if (stdout.length < 2_000_000) stdout += text; });
      child.stderr?.on('data', (text) => { stderr = (stderr + text).slice(-STDERR_TAIL); });
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error?.code === 'ENOENT' ? new BridgeError('codex executable not found', 500) : error);
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, sig });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
    if (exit.code !== 0) {
      logger.error?.(`codex-bridge: codex exited code=${exit.code} signal=${exit.sig} stderr_tail=${JSON.stringify(stderr.slice(-500))}`);
      throw new BridgeError(`codex exited with code ${exit.code}`, 502);
    }
    let text = '';
    try { text = await readFile(outputFile, 'utf8'); } catch { text = stdout; }
    text = text.trim();
    if (!text) throw new BridgeError('codex returned no text', 502);
    return text;
  } finally {
    clearTimeout(killTimer);
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export function createBridge({
  token, bin = 'codex', model = '', timeoutMs = 10 * 60 * 1000, maxBytes = 4 * 1024 * 1024,
  spawn = nodeSpawn, logger = console, now = () => Date.now(), env = process.env,
}) {
  if (!token) throw new Error('token is required');
  let busy = false;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bridge');
    if (req.method === 'GET' && url.pathname === '/healthz') { send(res, 200, { ok: true, busy }); return; }
    if (url.pathname !== '/summarize') { send(res, 404, { error: 'not found' }); return; }
    if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
    if (!sameToken(req.headers.authorization, token)) { send(res, 401, { error: 'unauthorized' }); return; }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) { send(res, 415, { error: 'expected application/json' }); return; }
    if (busy) { send(res, 503, { error: 'busy' }); return; }
    busy = true;
    const started = now();
    const controller = new AbortController();
    // The caller (personal-site) aborts on delete, shutdown or its own timeout: stop Codex too.
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      let payload;
      try { payload = JSON.parse(await readBody(req, maxBytes)); } catch (error) {
        throw error instanceof BridgeError ? error : new BridgeError('invalid JSON', 400);
      }
      const input = typeof payload?.input === 'string' ? payload.input : '';
      if (!input.trim()) throw new BridgeError('input is required', 400);
      const markdown = await runCodex({ input, bin, model, timeoutMs, signal: controller.signal, spawn, logger, env });
      logger.info?.(`codex-bridge: done in ${now() - started}ms input_chars=${input.length} output_chars=${markdown.length}`);
      send(res, 200, { markdown, model: model || null });
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500;
      if (status !== 499) logger.error?.(`codex-bridge: failed status=${status} after ${now() - started}ms: ${error?.message}`);
      send(res, status === 499 ? 503 : status, { error: error instanceof BridgeError ? error.message : 'internal error' });
    } finally {
      busy = false;
    }
  });
}

function main() {
  const { host, port } = parseAddr(process.env.CODEX_BRIDGE_ADDR || '127.0.0.1:3461');
  const token = loadToken();
  const timeoutMs = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS || 10 * 60 * 1000);
  const maxBytes = Number(process.env.CODEX_BRIDGE_MAX_BYTES || 4 * 1024 * 1024);
  if (!(timeoutMs >= 10_000 && timeoutMs <= 60 * 60 * 1000)) throw new Error('CODEX_BRIDGE_TIMEOUT_MS must be 10000..3600000');
  const model = (process.env.CODEX_BRIDGE_MODEL || '').trim();
  if (model && !MODEL_PATTERN.test(model)) throw new Error('CODEX_BRIDGE_MODEL is invalid');
  const env = codexEnv();
  const server = createBridge({ token, bin: process.env.CODEX_BRIDGE_BIN || 'codex', model, timeoutMs, maxBytes, env });
  server.requestTimeout = timeoutMs + 30_000;
  server.headersTimeout = 30_000;
  server.listen(port, host, () => console.info(`codex-bridge listening on http://${host}:${port}`));
  const shutdown = () => { server.close(); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  try { main(); } catch (error) { console.error(`codex-bridge: ${error.message}`); process.exit(1); }
}
