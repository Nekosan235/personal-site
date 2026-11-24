import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile, readFile } from 'node:fs/promises';
import { createCodexHttpProvider } from '../server/meetings/summary.js';
import { createBridge, codexArgs, codexEnv, MODEL_PATTERN, parseAddr, loadToken, runCodex } from '../scripts/codex-bridge.js';

const TOKEN = 'test-token-0123456789abcdef-xyz';
const quiet = { info() {}, error() {} };

/** Fake codex: records args/stdin, writes the -o file, exits with `code`. */
function fakeSpawn({ text = '# 会议纪要\n\n- 结论', code = 0, hang = false, calls = [] } = {}) {
  return (bin, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    const call = { bin, args, options, stdin: '', killedWith: null };
    calls.push(call);
    child.kill = (signal) => {
      child.killed = true;
      call.killedWith = signal;
      setImmediate(() => { child.exitCode = 143; child.emit('close', null, signal); });
      return true;
    };
    child.stdin.on('data', (chunk) => { call.stdin += chunk; });
    child.stdin.on('end', async () => {
      if (hang) return;
      const out = args[args.indexOf('--output-last-message') + 1];
      if (code === 0 && text !== null) await writeFile(out, text);
      child.exitCode = code;
      child.emit('close', code, null);
    });
    return child;
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('codex runs read-only, ephemeral, in a temp dir, reading the prompt from stdin', () => {
  const args = codexArgs({ cwd: '/tmp/x', outputFile: '/tmp/x/o.md', model: '' });
  assert.deepEqual(args, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '-C', '/tmp/x', '--output-last-message', '/tmp/x/o.md', '-']);
  assert.deepEqual(codexArgs({ cwd: '/c', outputFile: '/c/o', model: 'gpt-6.1-sol' }).slice(-3), ['-m', 'gpt-6.1-sol', '-']);
});

test('relay model ids with a namespace are accepted', () => {
  assert.ok(MODEL_PATTERN.test('group/auto-deepseek'));
  assert.ok(MODEL_PATTERN.test('gpt-6.1-sol'));
  assert.ok(!MODEL_PATTERN.test('a b'));
  assert.ok(!MODEL_PATTERN.test('x;rm -rf /'));
});

test('the relay key file is exported to codex under its env_key name, never the bridge token', () => {
  const read = () => 'sk-relay-0123456789\n';
  const env = codexEnv({ PATH: '/bin', CODEX_BRIDGE_API_KEY_FILE: '/k', CODEX_BRIDGE_TOKEN: TOKEN }, read);
  assert.equal(env.MAGPIE_API_KEY, 'sk-relay-0123456789');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CODEX_BRIDGE_TOKEN, undefined);
  assert.equal(codexEnv({ CODEX_BRIDGE_API_KEY_FILE: '/k', CODEX_BRIDGE_API_KEY_ENV: 'OTHER_KEY' }, read).OTHER_KEY, 'sk-relay-0123456789');
  const plain = { PATH: '/bin' };
  assert.equal(codexEnv(plain), plain, 'no key file: env passes through unchanged');
  assert.throws(() => codexEnv({ CODEX_BRIDGE_API_KEY_FILE: '/k' }, () => ''), /usable key/);
  assert.throws(() => codexEnv({ CODEX_BRIDGE_API_KEY_FILE: '/k', CODEX_BRIDGE_API_KEY_ENV: 'bad name' }, read), /variable name/);
});

test('the env given to the bridge reaches the codex child', async () => {
  const calls = [];
  await runCodex({ input: 'x', bin: 'codex', timeoutMs: 5000, spawn: fakeSpawn({ calls }), logger: quiet, env: { MAGPIE_API_KEY: 'k1' } });
  assert.equal(calls[0].options.env.MAGPIE_API_KEY, 'k1');
});

test('the bridge only binds loopback and needs a real token', () => {
  assert.deepEqual(parseAddr('127.0.0.1:3461'), { host: '127.0.0.1', port: 3461 });
  assert.deepEqual(parseAddr('[::1]:9000'), { host: '::1', port: 9000 });
  assert.throws(() => parseAddr('0.0.0.0:3461'), /loopback/);
  assert.throws(() => parseAddr('192.168.1.2:3461'), /loopback/);
  assert.throws(() => loadToken({ CODEX_BRIDGE_TOKEN: 'short' }), /24\+/);
  assert.equal(loadToken({ CODEX_BRIDGE_TOKEN_FILE: '/t' }, () => `${TOKEN}\n`), TOKEN);
});

test('end to end with the real codex-http provider: input on stdin, markdown back', async (t) => {
  const calls = [];
  const server = createBridge({ token: TOKEN, spawn: fakeSpawn({ calls }), logger: quiet });
  t.after(() => server.close());
  const base = await listen(server);
  const provider = createCodexHttpProvider({ url: `${base}/summarize`, token: TOKEN });
  const result = await provider.summarize({
    prompt: '只列结论',
    meeting: { id: 'm1', title: 'PG 周会' },
    transcript: { model: 'assemblyai-stt-3-7', durationMs: 60000, speakers: ['A'], utterances: [{ speaker: 'A', start: 0, text: '今天讨论产线。' }], text: '今天讨论产线。' },
  });
  assert.equal(result.markdown, '# 会议纪要\n\n- 结论');
  assert.equal(calls.length, 1);
  assert.match(calls[0].stdin, /只列结论/);
  assert.match(calls[0].stdin, /PG 周会/);
  assert.ok(calls[0].args.includes('read-only'));
  assert.equal(calls[0].options.cwd, calls[0].args[calls[0].args.indexOf('-C') + 1]);
});

test('wrong or missing token is refused before codex runs', async (t) => {
  const calls = [];
  const server = createBridge({ token: TOKEN, spawn: fakeSpawn({ calls }), logger: quiet });
  t.after(() => server.close());
  const base = await listen(server);
  for (const auth of [undefined, 'Bearer nope', `Basic ${TOKEN}`]) {
    const response = await fetch(`${base}/summarize`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: '{"input":"x"}',
    });
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
});

test('bad requests get 4xx; a failing codex becomes a retryable Chinese error in the provider', async (t) => {
  const server = createBridge({ token: TOKEN, spawn: fakeSpawn({ code: 1 }), logger: quiet });
  t.after(() => server.close());
  const base = await listen(server);
  const post = (body, type = 'application/json') => fetch(`${base}/summarize`, {
    method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${TOKEN}` }, body,
  });
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('{"input":"  "}')).status, 400);
  assert.equal((await post('{"input":"x"}', 'text/plain')).status, 415);
  assert.equal((await post('{"input":"x"}')).status, 502);
  const provider = createCodexHttpProvider({ url: `${base}/summarize`, token: TOKEN });
  await assert.rejects(provider.summarize({ prompt: 'p', meeting: { id: 'm', title: 't' }, transcript: { text: 'x', utterances: [] } }),
    (error) => error.retryable === true && /502/.test(error.message));
});

test('one job at a time: a second request while busy gets 503', async (t) => {
  const server = createBridge({ token: TOKEN, spawn: fakeSpawn({ hang: true }), logger: quiet });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = await listen(server);
  const first = new AbortController();
  const pending = fetch(`${base}/summarize`, {
    method: 'POST', signal: first.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{"input":"x"}',
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.busy, true);
  const second = await fetch(`${base}/summarize`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{"input":"y"}',
  });
  assert.equal(second.status, 503);
  first.abort();
  await pending;
});

test('codex is killed when the caller aborts or the job times out', async () => {
  const calls = [];
  const controller = new AbortController();
  const job = runCodex({ input: 'x', bin: 'codex', timeoutMs: 60_000, signal: controller.signal, spawn: fakeSpawn({ hang: true, calls }), logger: quiet });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(job, (error) => error.status === 499);
  assert.equal(calls[0].killedWith, 'SIGTERM');

  const slow = [];
  await assert.rejects(runCodex({ input: 'x', bin: 'codex', timeoutMs: 30, spawn: fakeSpawn({ hang: true, calls: slow }), logger: quiet }),
    (error) => error.status === 504);
  assert.equal(slow[0].killedWith, 'SIGTERM');
});

test('a missing codex binary is reported, and the request body is never logged', async () => {
  const logged = [];
  const logger = { info: (m) => logged.push(m), error: (m) => logged.push(m) };
  const missing = () => { const error = new Error('spawn codex ENOENT'); error.code = 'ENOENT'; throw error; };
  await assert.rejects(runCodex({ input: 'SECRET-TRANSCRIPT', bin: 'codex', timeoutMs: 1000, spawn: missing, logger }), /not found|ENOENT/);
  const server = createBridge({ token: TOKEN, spawn: fakeSpawn(), logger });
  const base = await listen(server);
  await fetch(`${base}/summarize`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{"input":"SECRET-TRANSCRIPT"}' });
  server.close();
  assert.ok(logged.length > 0);
  for (const line of logged) assert.doesNotMatch(line, /SECRET-TRANSCRIPT/);
  const source = await readFile(new URL('../scripts/codex-bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /shell:\s*true/);
});
