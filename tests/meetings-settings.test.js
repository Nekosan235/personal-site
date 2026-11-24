import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApplication } from '../server/index.js';
import { loadConfig, validateRuntimeConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { MeetingSettings, DEFAULT_SUMMARY_PROMPT } from '../server/meetings/settings.js';
import { createProviderRegistry, createElevenLabsClient, createOpenAiClient, wordsToUtterances } from '../server/meetings/providers.js';
import {
  buildSummaryInput,
  cleanSummaryMarkdown,
  createCodexExecProvider,
  createCodexHttpProvider,
  createDisabledProvider,
  createSummaryRegistry,
  SummaryError,
} from '../server/meetings/summary.js';
import { settingsPayload } from '../public/assets/pages/meetings-settings.js';
import { meetingActions } from '../public/assets/pages/meetings.js';

const USER = 'settings-user';
const PASSWORD = 'settings-test-password';
const ORIGIN = 'https://personal-site.example';
const passwordHash = await hashPassword(PASSWORD);

async function waitFor(check, { timeout = 5000, interval = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function fakeTranscriber() {
  return {
    async transcribeFile() {
      return {
        model: 'fake-stt',
        language: 'zh',
        durationMs: 60_000,
        speakers: ['A', 'B'],
        text: '我们 讨论 PG 产线',
        utterances: [
          { speaker: 'A', start: 0, end: 30_000, text: '我们 讨论 PG 产线' },
          { speaker: 'B', start: 30_000, end: 60_000, text: '好 的' },
        ],
      };
    },
  };
}

function fakeSummaryProvider({ markdown = '# 纪要\n\n- 结论 A', gate, fail } = {}) {
  const calls = [];
  return {
    calls,
    id: 'codex-http',
    label: 'Codex（本机 HTTP 桥）',
    description: 'fake',
    available: () => true,
    async summarize(input) {
      calls.push(input);
      if (gate) await gate;
      if (fail) throw fail;
      return { markdown, model: 'fake-codex' };
    },
  };
}

async function appFixture(t, { overrides = {}, summaryProviders, client = fakeTranscriber() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-msettings-'));
  await mkdir(join(directory, 'public'), { recursive: true });
  await writeFile(join(directory, 'public', 'login.html'), '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"></html>');
  const config = loadConfig({}, {
    SITE_ORIGIN: ORIGIN,
    NODE_ENV: 'production',
    DATA_DIR: join(directory, 'data'),
    PUBLIC_DIR: join(directory, 'public'),
    AUTH_USERNAME: USER,
    AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'),
    HOST: '127.0.0.1',
    PORT: 0,
    MONITORING_MODE: 'mock',
    ...overrides,
  });
  const server = createApplication({ config, meetingsClient: client, summaryProviders });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const cookies = new Map();
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const isJson = body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string';
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(['POST', 'PUT', 'DELETE'].includes(method) ? { Origin: ORIGIN } : {}),
        ...(isJson ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (/Max-Age=0(?:;|$)/i.test(cookie)) cookies.delete(pair.slice(0, separator));
      else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  async function login() {
    const html = await (await request('/login')).text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
    const response = await request('/api/auth/login', {
      method: 'POST', body: { username: USER, password: PASSWORD }, headers: { 'X-CSRF-Token': csrf },
    });
    assert.equal(response.status, 200);
    return (await (await request('/api/session')).json()).csrfToken;
  }
  return { request, login, config, directory };
}

async function transcribedMeeting(f, csrf) {
  const created = await (await f.request('/api/meetings', {
    method: 'POST', body: { title: '周会' }, headers: { 'X-CSRF-Token': csrf },
  })).json();
  const id = created.meeting.id;
  const upload = await f.request(`/api/meetings/${id}/audio?name=a.wav`, {
    method: 'POST', body: Buffer.alloc(1024, 1), headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'audio/wav' },
  });
  assert.equal(upload.status, 201);
  await waitFor(async () => (await (await f.request(`/api/meetings/${id}`)).json()).meeting.status === 'done');
  return id;
}

// ── settings API ───────────────────────────────────────────────────────────

test('settings require a session and never return a key', async (t) => {
  const f = await appFixture(t, { overrides: { ASSEMBLYAI_API_KEY: 'env-assembly-key-1234' } });
  assert.equal((await f.request('/api/meetings/settings')).status, 401);
  const csrf = await f.login();

  const initial = (await (await f.request('/api/meetings/settings')).json()).settings;
  assert.equal(initial.transcription.provider, 'assemblyai');
  const assembly = initial.transcription.providers.find((item) => item.id === 'assemblyai');
  assert.equal(assembly.keySource, 'env');
  assert.equal(assembly.keyHint, '••••1234');

  const saved = await f.request('/api/meetings/settings', {
    method: 'PUT',
    headers: { 'X-CSRF-Token': csrf },
    body: { transcription: { provider: 'elevenlabs', keys: { elevenlabs: 'sk_eleven_secret_ABCD' } } },
  });
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.doesNotMatch(text, /sk_eleven_secret/);
  const body = JSON.parse(text).settings;
  assert.equal(body.transcription.provider, 'elevenlabs');
  const eleven = body.transcription.providers.find((item) => item.id === 'elevenlabs');
  assert.equal(eleven.keySource, 'saved');
  assert.equal(eleven.keyHint, '••••ABCD');

  // The key is on disk, the file is private, and GET still hides it.
  const file = await readFile(f.config.meetingsSettingsPath, 'utf8');
  assert.match(file, /sk_eleven_secret_ABCD/);
  if (process.platform !== 'win32') assert.equal((await stat(f.config.meetingsSettingsPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await (await f.request('/api/meetings/settings')).text(), /sk_eleven_secret/);
});

test('settings writes need CSRF and reject bad input with a field', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  assert.equal((await f.request('/api/meetings/settings', { method: 'PUT', body: {} })).status, 403);

  const badProvider = await f.request('/api/meetings/settings', {
    method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: { transcription: { provider: 'whisper-local' } },
  });
  assert.equal(badProvider.status, 400);
  assert.equal((await badProvider.json()).field, 'provider');

  const badKey = await f.request('/api/meetings/settings', {
    method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: { transcription: { keys: { openai: 'has space in it' } } },
  });
  assert.equal(badKey.status, 400);
  assert.equal((await badKey.json()).field, 'keys.openai');

  const longPrompt = await f.request('/api/meetings/settings', {
    method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: { summary: { prompt: 'x'.repeat(8001) } },
  });
  assert.equal(longPrompt.status, 400);
});

test('clearing a saved key falls back to the environment', async (t) => {
  const f = await appFixture(t, { overrides: { OPENAI_API_KEY: 'sk-env-openai-9999' } });
  const csrf = await f.login();
  const put = (body) => f.request('/api/meetings/settings', { method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body });
  await put({ transcription: { keys: { openai: 'sk-saved-openai-1111' } } });
  let openai = (await (await f.request('/api/meetings/settings')).json()).settings.transcription.providers.find((p) => p.id === 'openai');
  assert.equal(openai.keyHint, '••••1111');
  await put({ transcription: { keys: { openai: null } } });
  openai = (await (await f.request('/api/meetings/settings')).json()).settings.transcription.providers.find((p) => p.id === 'openai');
  assert.equal(openai.keySource, 'env');
  assert.equal(openai.keyHint, '••••9999');
});

test('the meetings list reports whether the provider has a key and whether summaries are on', async (t) => {
  const f = await appFixture(t);
  await f.login();
  const list = await (await f.request('/api/meetings')).json();
  assert.equal(list.features.provider, 'assemblyai');
  assert.equal(list.features.providerReady, false);
  assert.equal(list.features.summaryEnabled, false);
});

test('MeetingSettings resolves provider, key, model and keyterms with env fallbacks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'msettings-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new MeetingSettings({
    path: join(directory, 's.json'),
    providers: createProviderRegistry(),
    summaryProviders: createSummaryRegistry([createDisabledProvider()]),
    env: { provider: 'assemblyai', model: 'universal-2', keyterms: ['PG'], apiKeys: { assemblyai: 'env-key-aaaa' } },
  });
  let resolved = await settings.resolveTranscription();
  assert.deepEqual([resolved.providerId, resolved.apiKey, resolved.model, resolved.keyterms], ['assemblyai', 'env-key-aaaa', 'universal-2', ['PG']]);

  await settings.update({ transcription: { provider: 'elevenlabs', keys: { elevenlabs: 'eleven-key-bbbb' }, keyterms: 'OEE，节拍\n节拍, 产线' } });
  resolved = await settings.resolveTranscription();
  assert.equal(resolved.providerId, 'elevenlabs');
  assert.equal(resolved.apiKey, 'eleven-key-bbbb');
  assert.equal(resolved.model, 'scribe_v3', 'env model belongs to the env provider only');
  assert.deepEqual(resolved.keyterms, ['OEE', '节拍', '产线']);

  // A second instance reads the same file (survives restart).
  const again = new MeetingSettings({
    path: join(directory, 's.json'),
    providers: createProviderRegistry(),
    summaryProviders: createSummaryRegistry([createDisabledProvider()]),
    env: {},
  });
  assert.equal((await again.resolveTranscription()).providerId, 'elevenlabs');
  assert.equal((await again.resolveSummary()).prompt, DEFAULT_SUMMARY_PROMPT);
});

// ── providers ──────────────────────────────────────────────────────────────

async function audioFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mprov-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'a.wav');
  await writeFile(filePath, Buffer.alloc(128, 2));
  return filePath;
}

test('ElevenLabs words are grouped into lettered speaker turns', async (t) => {
  const filePath = await audioFile(t);
  let sent;
  const client = createElevenLabsClient({
    apiKey: 'xi-key',
    keyterms: ['PG', 'bad<term>'],
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, form: init.body };
      return Response.json({
        language_code: 'zho',
        text: '我们 讨论 PG 好的',
        audio_duration_secs: 4,
        transcription_id: 'tr1',
        words: [
          { text: '我们', type: 'word', start: 0, end: 0.5, speaker_id: 'speaker_3' },
          { text: ' ', type: 'spacing', start: 0.5, end: 0.6, speaker_id: 'speaker_3' },
          { text: '讨论 PG', type: 'word', start: 0.6, end: 1.5, speaker_id: 'speaker_3' },
          { text: '(laughter)', type: 'audio_event', start: 1.5, end: 2, speaker_id: 'speaker_3' },
          { text: '好的', type: 'word', start: 2, end: 3, speaker_id: 'speaker_1' },
        ],
      });
    },
  });
  const result = await client.transcribeFile({ filePath, size: 128, mime: 'audio/wav', filename: 'a.wav' });
  assert.equal(sent.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(sent.headers['xi-api-key'], 'xi-key');
  assert.equal(sent.form.get('model_id'), 'scribe_v3');
  assert.equal(sent.form.get('diarize'), 'true');
  assert.deepEqual(sent.form.getAll('secondary_language_codes'), ['en']);
  assert.deepEqual(sent.form.getAll('keyterms'), ['PG']);
  assert.deepEqual(result.utterances.map((item) => [item.speaker, item.text]), [['A', '我们讨论 PG'], ['B', '好的']]);
  assert.deepEqual(result.speakers, ['A', 'B']);
  assert.equal(result.durationMs, 4000);
});

test('OpenAI refuses files over 25 MB before calling the API', async (t) => {
  const filePath = await audioFile(t);
  let called = false;
  const client = createOpenAiClient({ apiKey: 'sk', fetchImpl: async () => { called = true; return Response.json({}); } });
  await assert.rejects(() => client.transcribeFile({ filePath, size: 26 * 1024 * 1024 }), /25 MB/);
  assert.equal(called, false);
});

test('OpenAI diarized segments become speaker turns', async (t) => {
  const filePath = await audioFile(t);
  let form;
  const client = createOpenAiClient({
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      form = init.body;
      assert.equal(init.headers.authorization, 'Bearer sk-test');
      return Response.json({
        duration: 5,
        text: 'hello 大家好',
        segments: [
          { speaker: 'spk_a', start: 0, end: 2, text: 'hello' },
          { speaker: 'spk_b', start: 2, end: 5, text: '大家 好' },
        ],
      });
    },
  });
  const result = await client.transcribeFile({ filePath, size: 128 });
  assert.equal(form.get('response_format'), 'diarized_json');
  assert.equal(form.get('chunking_strategy'), 'auto');
  assert.deepEqual(result.utterances.map((item) => [item.speaker, item.text]), [['A', 'hello'], ['B', '大家好']]);
  assert.equal(result.durationMs, 5000);
});

test('the dynamic client uses whatever provider and key are saved now', async (t) => {
  const seen = [];
  const providers = [
    { id: 'assemblyai', label: 'A', models: ['m1'], defaultModel: 'm1', create: (o) => ({ transcribeFile: async () => { seen.push(['assemblyai', o.apiKey, o.model]); return { utterances: [] }; } }) },
    { id: 'elevenlabs', label: 'E', models: ['m2'], defaultModel: 'm2', create: (o) => ({ transcribeFile: async () => { seen.push(['elevenlabs', o.apiKey, o.model]); return { utterances: [] }; } }) },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'mdyn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createProviderRegistry(providers);
  const settings = new MeetingSettings({
    path: join(directory, 's.json'), providers: registry,
    summaryProviders: createSummaryRegistry([createDisabledProvider()]),
    env: { provider: 'assemblyai', apiKeys: { assemblyai: 'k-env' } },
  });
  const { createDynamicTranscriptionClient } = await import('../server/meetings/dynamic-client.js');
  const client = createDynamicTranscriptionClient({ settings, registry });
  assert.equal((await client.transcribeFile({})).provider, 'assemblyai');
  await settings.update({ transcription: { provider: 'elevenlabs', keys: { elevenlabs: 'k-saved-eleven' } } });
  await client.transcribeFile({});
  assert.deepEqual(seen, [['assemblyai', 'k-env', 'm1'], ['elevenlabs', 'k-saved-eleven', 'm2']]);
});

test('renameWithRetry rides out a transient EPERM and gives up on a real error', async (t) => {
  const { renameWithRetry } = await import('../server/meetings/store.js');
  const directory = await mkdtemp(join(tmpdir(), 'mrename-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const from = join(directory, 'a.tmp');
  const to = join(directory, 'a.json');
  await writeFile(from, '{"ok":true}');
  await writeFile(to, '{}');
  // Hold the target open the way a concurrent reader does on Windows.
  const { open } = await import('node:fs/promises');
  const handle = await open(to, 'r');
  setTimeout(() => { void handle.close(); }, 40);
  await renameWithRetry(from, to);
  assert.equal(await readFile(to, 'utf8'), '{"ok":true}');
  await assert.rejects(() => renameWithRetry(join(directory, 'missing.tmp'), to), { code: 'ENOENT' });
});

test('wordsToUtterances splits on long pauses within one speaker', () => {
  const turns = wordsToUtterances([
    { s: 'A', a: 0, b: 1000, t: '一' },
    { s: 'A', a: 4000, b: 5000, t: '二' },
  ], { speakerOf: (w) => w.s, startOf: (w) => w.a, endOf: (w) => w.b, textOf: (w) => w.t });
  assert.equal(turns.length, 2);
});

// ── summaries ──────────────────────────────────────────────────────────────

test('summary input carries the prompt, meeting facts and the full transcript', () => {
  const input = buildSummaryInput({
    prompt: '请整理纪要',
    meeting: { title: 'PG 周会' },
    transcript: { model: 'm', durationMs: 120_000, speakers: ['A', 'B'], utterances: [{ speaker: 'A', start: 61_000, text: '开始' }] },
  });
  assert.match(input, /^请整理纪要/);
  assert.match(input, /会议标题：PG 周会/);
  assert.match(input, /录音时长：2 分钟/);
  assert.match(input, /<transcript>\n\[00:01:01\] Speaker A: 开始\n<\/transcript>/);
  assert.equal(cleanSummaryMarkdown('```markdown\n# 纪要\n```'), '# 纪要');
});

test('a summary is generated through the selected provider and archived as summary.md', async (t) => {
  const provider = fakeSummaryProvider();
  const f = await appFixture(t, { summaryProviders: [createDisabledProvider(), provider] });
  const csrf = await f.login();
  await f.request('/api/meetings/settings', {
    method: 'PUT', headers: { 'X-CSRF-Token': csrf },
    body: { summary: { provider: 'codex-http', prompt: '只列结论' } },
  });
  assert.equal((await (await f.request('/api/meetings')).json()).features.summaryEnabled, true);
  const id = await transcribedMeeting(f, csrf);

  const accepted = await f.request(`/api/meetings/${id}/summary`, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } });
  assert.equal(accepted.status, 202);
  const done = await waitFor(async () => {
    const meeting = (await (await f.request(`/api/meetings/${id}`)).json()).meeting;
    return meeting.summary?.status === 'done' ? meeting : null;
  });
  assert.equal(done.summary.provider, 'codex-http');
  assert.equal(provider.calls[0].prompt, '只列结论');
  assert.equal(provider.calls[0].transcript.utterances[0].speaker, 'A');

  assert.equal(await readFile(join(f.config.meetingsDir, id, 'summary.md'), 'utf8'), '# 纪要\n\n- 结论 A');
  const json = await (await f.request(`/api/meetings/${id}/summary`)).json();
  assert.equal(json.markdown, '# 纪要\n\n- 结论 A');
  const md = await f.request(`/api/meetings/${id}/summary?format=md&download=1`);
  assert.match(md.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
});

test('a summary failure is shown with its own message and can be requested again', async (t) => {
  const provider = fakeSummaryProvider({ fail: new SummaryError('Codex 生成纪要超时。') });
  const f = await appFixture(t, { summaryProviders: [createDisabledProvider(), provider] });
  const csrf = await f.login();
  await f.request('/api/meetings/settings', { method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: { summary: { provider: 'codex-http' } } });
  const id = await transcribedMeeting(f, csrf);
  await f.request(`/api/meetings/${id}/summary`, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } });
  const failed = await waitFor(async () => {
    const meeting = (await (await f.request(`/api/meetings/${id}`)).json()).meeting;
    return meeting.summary?.status === 'failed' ? meeting : null;
  });
  assert.equal(failed.summary.error, 'Codex 生成纪要超时。');
  assert.equal((await f.request(`/api/meetings/${id}/summary`)).status, 409);
  const again = await f.request(`/api/meetings/${id}/summary`, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } });
  assert.equal(again.status, 202);
});

test('a second summary request while one is running is refused', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = fakeSummaryProvider({ gate });
  const f = await appFixture(t, { summaryProviders: [createDisabledProvider(), provider] });
  const csrf = await f.login();
  await f.request('/api/meetings/settings', { method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: { summary: { provider: 'codex-http' } } });
  const id = await transcribedMeeting(f, csrf);
  try {
    assert.equal((await f.request(`/api/meetings/${id}/summary`, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } })).status, 202);
    const second = await f.request(`/api/meetings/${id}/summary`, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } });
    assert.equal(second.status, 409);
  } finally {
    release();
  }
  await waitFor(async () => (await (await f.request(`/api/meetings/${id}`)).json()).meeting.summary?.status === 'done');
});

test('a summary needs a transcript', async (t) => {
  const f = await appFixture(t, { summaryProviders: [createDisabledProvider(), fakeSummaryProvider()] });
  const csrf = await f.login();
  await f.request('/api/meetings/settings', { method: 'PUT', headers: { 'X-CSRF-Token': csrf }, body: { summary: { provider: 'codex-http' } } });
  const created = await (await f.request('/api/meetings', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } })).json();
  const response = await f.request(`/api/meetings/${created.meeting.id}/summary`, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrf } });
  assert.equal(response.status, 409);
});

test('auto-summary runs after a transcription when enabled', async (t) => {
  const provider = fakeSummaryProvider();
  const f = await appFixture(t, { summaryProviders: [createDisabledProvider(), provider] });
  const csrf = await f.login();
  await f.request('/api/meetings/settings', {
    method: 'PUT', headers: { 'X-CSRF-Token': csrf },
    body: { summary: { provider: 'codex-http', autoAfterTranscript: true } },
  });
  const id = await transcribedMeeting(f, csrf);
  let last;
  try {
    await waitFor(async () => {
      last = (await (await f.request(`/api/meetings/${id}`)).json()).meeting;
      return last.summary?.status === 'done';
    });
  } catch (error) {
    throw new Error(`${error.message}; last=${JSON.stringify({ status: last?.status, summary: last?.summary, calls: provider.calls.length })}`);
  }
  assert.equal(provider.calls.length, 1);
});

test('codex-exec pipes the input on stdin and reads --output-last-message', async () => {
  let captured;
  const spawnImpl = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let stdin = '';
    child.stdin.on('data', (chunk) => { stdin += chunk; });
    child.stdin.on('finish', async () => {
      captured = { bin, args, cwd: options.cwd, stdin };
      const out = args[args.indexOf('--output-last-message') + 1];
      await writeFile(out, '```markdown\n# 会议纪要\n```');
      child.emit('close', 0);
    });
    child.kill = () => {};
    return child;
  };
  const provider = createCodexExecProvider({ bin: '/usr/local/bin/codex', args: ['--sandbox', 'read-only'], spawnImpl });
  assert.equal(provider.available(), true);
  const result = await provider.summarize({
    prompt: '整理纪要',
    meeting: { title: 'x' },
    transcript: { utterances: [{ speaker: 'A', start: 0, text: '你好' }] },
  });
  assert.equal(result.markdown, '# 会议纪要');
  assert.equal(captured.bin, '/usr/local/bin/codex');
  assert.deepEqual(captured.args.slice(0, 3), ['exec', '--sandbox', 'read-only']);
  assert.equal(captured.args.at(-1), '-');
  assert.match(captured.stdin, /^整理纪要/);
  assert.match(captured.stdin, /Speaker A: 你好/);
});

test('codex-exec reports a missing binary and a non-zero exit in Chinese', async () => {
  const missing = createCodexExecProvider({
    bin: 'codex',
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.kill = () => {};
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return child;
    },
  });
  await assert.rejects(() => missing.summarize({ prompt: 'p', transcript: { utterances: [] } }), /找不到 Codex/);

  const failing = createCodexExecProvider({
    bin: 'codex',
    logger: { error() {} },
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('finish', () => child.emit('close', 2));
      child.kill = () => {};
      return child;
    },
  });
  await assert.rejects(() => failing.summarize({ prompt: 'p', transcript: { utterances: [] } }), /退出码 2/);
});

test('codex-http posts JSON to the bridge with the bearer token', async () => {
  let seen;
  const provider = createCodexHttpProvider({
    url: 'http://127.0.0.1:3901/summarize',
    token: 'bridge-token',
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return Response.json({ markdown: '# 纪要', model: 'gpt-5-codex' });
    },
  });
  const result = await provider.summarize({
    prompt: 'p', meeting: { id: 'abc12345', title: 't' },
    transcript: { durationMs: 1000, speakers: ['A'], utterances: [{ speaker: 'A', start: 0, text: '嗨' }] },
  });
  assert.equal(result.markdown, '# 纪要');
  assert.equal(seen.init.headers.authorization, 'Bearer bridge-token');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.body.meeting.id, 'abc12345');
  assert.match(seen.body.input, /Speaker A: 嗨/);
});

test('production config refuses a non-loopback Codex URL and unknown providers', () => {
  const base = {
    NODE_ENV: 'production', SITE_ORIGIN: 'https://x.example', AUTH_USERNAME: 'u',
    AUTH_PASSWORD_HASH: 'h', AUTH_SECRET: 'x'.repeat(40), MONITORING_MODE: 'mock',
  };
  assert.throws(() => validateRuntimeConfig(loadConfig({}, { ...base, MEETINGS_CODEX_URL: 'https://codex.example/api' })), /MEETINGS_CODEX_URL/);
  assert.throws(() => validateRuntimeConfig(loadConfig({}, { ...base, MEETINGS_PROVIDER: 'whisper' })), /MEETINGS_PROVIDER/);
  assert.throws(() => validateRuntimeConfig(loadConfig({}, { ...base, MEETINGS_SUMMARY_PROVIDER: 'gpt' })), /MEETINGS_SUMMARY_PROVIDER/);
  assert.doesNotThrow(() => validateRuntimeConfig(loadConfig({}, { ...base, MEETINGS_CODEX_URL: 'http://127.0.0.1:3901/summarize' })));
});

// ── frontend pure helpers ──────────────────────────────────────────────────

test('settingsPayload sends only what changed and never an empty key', () => {
  const body = settingsPayload({
    provider: 'elevenlabs',
    keys: { assemblyai: { value: '  ' }, elevenlabs: { value: ' sk_new ' }, openai: { clear: true } },
    models: { elevenlabs: 'scribe_v2', openai: '' },
    keyterms: '',
    summaryProvider: 'codex-exec',
    prompt: '',
    autoAfterTranscript: true,
  });
  assert.deepEqual(body, {
    transcription: {
      provider: 'elevenlabs',
      keys: { elevenlabs: 'sk_new', openai: null },
      models: { elevenlabs: 'scribe_v2', openai: null },
      keyterms: null,
    },
    summary: { provider: 'codex-exec', prompt: null, autoAfterTranscript: true },
  });
});

test('card actions offer a summary only when the service is on and nothing is running', () => {
  const done = { status: 'done', audio: null, transcript: { chars: 1 } };
  assert.ok(!meetingActions(done).includes('summarize'));
  assert.ok(meetingActions(done, { summaryEnabled: true }).includes('summarize'));
  assert.ok(!meetingActions({ ...done, summary: { status: 'running' } }, { summaryEnabled: true }).includes('summarize'));
  assert.ok(meetingActions({ ...done, summary: { status: 'done' } }).includes('viewSummary'));
  assert.ok(!meetingActions({ ...done, status: 'transcribing' }, { summaryEnabled: true }).includes('summarize'));
});

test('the summary text sets its own colour so Tabler\'s light <pre> colour never leaks in', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../public/assets/styles.css', import.meta.url), 'utf8');
  const rule = /\.meetings-summary-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /(^|;)\s*color:\s*var\(--ink\)/);
  assert.match(rule, /background:\s*var\(--surface-2\)/);
});