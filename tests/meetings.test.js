import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig } from '../server/config.js';
import { hashPassword } from '../server/auth/password.js';
import { request as httpRequest } from 'node:http';
import { MeetingStore } from '../server/meetings/store.js';
import { createTranscriptionQueue } from '../server/meetings/queue.js';
import { createAssemblyAiClient, TranscriptionError } from '../server/meetings/transcribe.js';
import { meetingActions } from '../public/assets/pages/meetings.js';

const USER = 'meeting-user';
const PASSWORD = 'meeting-test-password';
const ORIGIN = 'https://personal-site.example';
const passwordHash = await hashPassword(PASSWORD);

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async transcribeFile({ filePath, size, mime, filename }) {
      calls.push({ filePath, size, mime, filename });
      return {
        model: 'fake-stt',
        language: 'zh',
        durationMs: 65_000,
        speakers: ['A', 'B'],
        text: '我们 来 看 一下 PG 的 layout。 好 的，开始 吧。',
        utterances: [
          { speaker: 'A', start: 0, end: 30_000, text: '我们 来 看 一下 PG 的 layout。' },
          { speaker: 'B', start: 30_000, end: 65_000, text: '好 的，开始 吧。' },
        ],
        words: [],
        jobId: 'fake-job',
        completedAt: Date.now(),
      };
    },
    ...overrides,
  };
}

async function waitFor(check, { timeout = 5000, interval = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function appFixture(t, { overrides = {}, client = fakeClient(), storeFactory } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-meetings-'));
  await mkdir(join(directory, 'public'), { recursive: true });
  await writeFile(
    join(directory, 'public', 'login.html'),
    '<html><meta name="csrf-token" content="{{CSRF_TOKEN}}"></html>',
  );
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
  const meetingStore = storeFactory ? storeFactory(config) : undefined;
  const server = createApplication({ config, meetingsClient: client, meetingStore });
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
        ...(method === 'POST' || method === 'DELETE' ? { Origin: ORIGIN } : {}),
        ...(isJson ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/Max-Age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  }
  async function login() {
    const challenge = await request('/login');
    const html = await challenge.text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { username: USER, password: PASSWORD },
      headers: { 'X-CSRF-Token': csrf },
    });
    assert.equal(response.status, 200);
    const session = await (await request('/api/session')).json();
    return session.csrfToken;
  }
  return { request, login, config, directory, client, server, baseUrl, cookies };
}

async function createMeeting(f, csrf, title = 'PG 产线周会') {
  const response = await f.request('/api/meetings', {
    method: 'POST',
    body: { title },
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(response.status, 201);
  return (await response.json()).meeting;
}

async function uploadAudio(f, csrf, id, { name = 'weekly.wav', bytes = 2048, body, type = 'audio/wav' } = {}) {
  return f.request(`/api/meetings/${id}/audio?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: body ?? Buffer.alloc(bytes, 1),
    headers: { 'X-CSRF-Token': csrf, 'Content-Type': type },
  });
}

async function meetingOf(f, id) {
  return (await (await f.request(`/api/meetings/${id}`)).json()).meeting;
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test('meetings API requires a session', async (t) => {
  const f = await appFixture(t);
  assert.equal((await f.request('/api/meetings')).status, 401);
  assert.equal((await f.request('/api/meetings/aaaaaaaa')).status, 401);
});

test('upload queues the meeting and the transcript is archived', async (t) => {
  const client = fakeClient();
  const f = await appFixture(t, { client });
  const csrf = await f.login();

  const meeting = await createMeeting(f, csrf);
  assert.equal(meeting.status, 'draft');
  assert.equal(meeting.title, 'PG 产线周会');

  const uploaded = await uploadAudio(f, csrf, meeting.id);
  assert.equal(uploaded.status, 201);
  const uploadedBody = await uploaded.json();
  assert.equal(uploadedBody.meeting.audio.filename, 'weekly.wav');
  assert.equal(uploadedBody.meeting.audio.bytes, 2048);

  const done = await waitFor(async () => {
    const payload = await (await f.request(`/api/meetings/${meeting.id}`)).json();
    return payload.meeting.status === 'done' ? payload.meeting : null;
  });
  assert.equal(done.transcript.model, 'fake-stt');
  assert.deepEqual(done.transcript.speakers, ['A', 'B']);
  assert.equal(done.error, null);

  const transcriptPayload = await (await f.request(`/api/meetings/${meeting.id}/transcript`)).json();
  assert.equal(transcriptPayload.transcript.utterances[0].speaker, 'A');

  const markdown = await readFile(join(f.config.meetingsDir, meeting.id, 'transcript.md'), 'utf8');
  assert.match(markdown, /Speaker A/);
  assert.match(markdown, /我们来看一下 PG 的 layout。/);
  assert.match(markdown, /## 发言统计/);

  const text = await (await f.request(`/api/meetings/${meeting.id}/transcript?format=txt`)).text();
  assert.match(text, /^\[00:00:00\] Speaker A: 我们来看一下 PG 的 layout。$/m);

  assert.equal(client.calls.length, 1);
  assert.ok(client.calls[0].size > 0);

  const list = await (await f.request('/api/meetings')).json();
  assert.equal(list.stats.total, 1);
  assert.equal(list.stats.counts.done, 1);
  assert.equal(list.stats.audioBytes, 2048);
});

test('deleting the audio frees the file but keeps the transcript', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf, '音频可删');
  await uploadAudio(f, csrf, meeting.id, { name: 'keep.mp3' });
  await waitFor(async () => {
    const payload = await (await f.request(`/api/meetings/${meeting.id}`)).json();
    return payload.meeting.status === 'done';
  });

  const audioPath = join(f.config.meetingsDir, meeting.id, 'audio.mp3');
  assert.ok((await stat(audioPath)).isFile());

  const deleted = await f.request(`/api/meetings/${meeting.id}/audio`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(deleted.status, 200);
  const payload = await deleted.json();
  assert.equal(payload.meeting.audio.deleted, true);

  await assert.rejects(() => stat(audioPath));
  assert.ok((await stat(join(f.config.meetingsDir, meeting.id, 'transcript.md'))).isFile());

  const transcript = await f.request(`/api/meetings/${meeting.id}/transcript`);
  assert.equal(transcript.status, 200);

  const list = await (await f.request('/api/meetings')).json();
  assert.equal(list.stats.audioBytes, 0);
});

test('deleting a meeting removes its archive folder', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const directory = join(f.config.meetingsDir, meeting.id);
  assert.ok((await stat(directory)).isDirectory());

  const response = await f.request(`/api/meetings/${meeting.id}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(response.status, 200);
  await assert.rejects(() => stat(directory));
  assert.equal((await f.request(`/api/meetings/${meeting.id}`)).status, 404);
});

test('mutations need the CSRF token', async (t) => {
  const f = await appFixture(t);
  await f.login();
  const response = await f.request('/api/meetings', { method: 'POST', body: { title: 'x' } });
  assert.equal(response.status, 403);
});

test('rejects unsupported audio formats', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const response = await f.request(`/api/meetings/${meeting.id}/audio?name=notes.txt`, {
    method: 'POST',
    body: Buffer.from('not audio'),
    headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'text/plain' },
  });
  assert.equal(response.status, 415);
});

test('rejects uploads over the configured limit', async (t) => {
  const f = await appFixture(t, { overrides: { MEETINGS_MAX_UPLOAD_BYTES: String(1024 * 1024) } });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const response = await uploadAudio(f, csrf, meeting.id, { bytes: 1024 * 1024 + 512 });
  assert.equal(response.status, 413);
});

test('a failed transcription is reported and can be retried', async (t) => {
  let attempts = 0;
  const client = fakeClient({
    async transcribeFile() {
      attempts += 1;
      if (attempts === 1) throw new TranscriptionError('转写服务返回 500');
      return {
        model: 'fake-stt',
        language: 'zh',
        durationMs: 1000,
        speakers: ['A'],
        text: '重试成功',
        utterances: [{ speaker: 'A', start: 0, end: 1000, text: '重试成功' }],
      };
    },
  });
  const f = await appFixture(t, { client });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  await uploadAudio(f, csrf, meeting.id);

  const failed = await waitFor(async () => {
    const payload = await (await f.request(`/api/meetings/${meeting.id}`)).json();
    return payload.meeting.status === 'failed' ? payload.meeting : null;
  });
  assert.match(failed.error, /转写服务返回 500/);

  const retried = await f.request(`/api/meetings/${meeting.id}/transcribe`, {
    method: 'POST',
    body: {},
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(retried.status, 200);

  await waitFor(async () => {
    const payload = await (await f.request(`/api/meetings/${meeting.id}`)).json();
    return payload.meeting.status === 'done';
  });
  assert.equal(attempts, 2);
});

test('a created meeting stays a draft until audio lands', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  assert.equal(meeting.status, 'draft');
  const list = await (await f.request('/api/meetings')).json();
  assert.equal(list.stats.counts.draft, 1);
  assert.equal(list.stats.counts.queued, 0);
});

test('deleting the audio of a queued meeting cancels it without resurrecting the job', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = fakeClient({
    async transcribeFile() {
      await gate;
      return {
        model: 'fake-stt',
        language: 'zh',
        durationMs: 1000,
        speakers: ['A'],
        text: '迟到结果',
        utterances: [{ speaker: 'A', start: 0, end: 1000, text: '迟到结果' }],
      };
    },
  });
  const f = await appFixture(t, { client });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  try {
    await uploadAudio(f, csrf, meeting.id);
    const deleted = await f.request(`/api/meetings/${meeting.id}/audio`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrf },
    });
    assert.equal(deleted.status, 200);
    const payload = await deleted.json();
    assert.equal(payload.meeting.audio.deleted, true);
    assert.equal(payload.meeting.status, 'failed');
  } finally {
    release();
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await (await f.request(`/api/meetings/${meeting.id}`)).json();
  assert.equal(after.meeting.audio.deleted, true);
  assert.equal(after.meeting.status, 'failed');
  assert.equal(after.meeting.transcript, null);
});

test('serves the recording with byte ranges', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  await uploadAudio(f, csrf, meeting.id, { bytes: 2048 });
  await waitFor(async () => {
    const payload = await (await f.request(`/api/meetings/${meeting.id}`)).json();
    return payload.meeting.status === 'done';
  });

  const full = await f.request(`/api/meetings/${meeting.id}/audio`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');

  const partial = await f.request(`/api/meetings/${meeting.id}/audio`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-length'), '10');
  assert.equal(partial.headers.get('content-range'), 'bytes 0-9/2048');

  const suffix = await f.request(`/api/meetings/${meeting.id}/audio`, { headers: { Range: 'bytes=-10' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 2038-2047/2048');

  const invalid = await f.request(`/api/meetings/${meeting.id}/audio`, { headers: { Range: 'bytes=-' } });
  assert.equal(invalid.status, 416);
});

test('rejects an unknown transcript format', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const response = await f.request(`/api/meetings/${meeting.id}/transcript?format=../x`);
  assert.equal(response.status, 400);
});

test('the Codex summary hook reports that it is not connected yet', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const response = await f.request(`/api/meetings/${meeting.id}/summary`, {
    method: 'POST',
    body: {},
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(response.status, 501);
  const payload = await response.json();
  assert.match(payload.error, /Codex/);
});

test('a meeting left transcribing is re-queued on boot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-meetings-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MeetingStore({ root: join(directory, 'meetings') });
  const meta = await store.create({ title: '崩溃恢复' });
  await store.patch(meta.id, { status: 'transcribing' });
  const orphan = await store.create({ title: '上传未完成' });
  await store.patch(orphan.id, { status: 'queued' });

  const resumable = await store.recover();
  assert.deepEqual(resumable, [meta.id]);
  assert.equal((await store.get(meta.id)).status, 'queued');
  const orphanMeta = await store.get(orphan.id);
  assert.equal(orphanMeta.status, 'failed');
  assert.match(orphanMeta.error, /没有录音文件/);
});

// ── review fixes (2026-11-23) ───────────────────────────────────────────────

test('byte-range responses carry exactly the requested bytes', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const body = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251));
  await uploadAudio(f, csrf, meeting.id, { body });
  await waitFor(async () => (await meetingOf(f, meeting.id)).status === 'done');

  const middle = await f.request(`/api/meetings/${meeting.id}/audio`, { headers: { Range: 'bytes=100-109' } });
  assert.equal(middle.status, 206);
  assert.deepEqual(Buffer.from(await middle.arrayBuffer()), body.subarray(100, 110));

  const open = await f.request(`/api/meetings/${meeting.id}/audio`, { headers: { Range: 'bytes=2040-' } });
  assert.equal(open.headers.get('content-range'), 'bytes 2040-2047/2048');
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), body.subarray(2040));

  const suffix = await f.request(`/api/meetings/${meeting.id}/audio`, { headers: { Range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), body.subarray(2043));

  const full = await f.request(`/api/meetings/${meeting.id}/audio`);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), body);
});

test('a meeting enqueued again while its job runs is run once more afterwards', async () => {
  const runs = [];
  const first = gate();
  const queue = createTranscriptionQueue({
    run: async (id) => {
      runs.push(id);
      if (runs.length === 1) await first.promise;
    },
    logger: null,
  });
  assert.equal(queue.enqueue('aaaaaaaa'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.isActive('aaaaaaaa'), true);
  assert.equal(queue.enqueue('aaaaaaaa'), true);
  first.open();
  await waitFor(() => runs.length === 2);
  await queue.drain();
  assert.deepEqual(runs, ['aaaaaaaa', 'aaaaaaaa']);

  // A rerun that is cancelled before the job ends does not fire.
  const second = gate();
  let more = 0;
  const cancelling = createTranscriptionQueue({ run: async () => { more += 1; await second.promise; }, logger: null });
  cancelling.enqueue('bbbbbbbb');
  await new Promise((resolve) => setImmediate(resolve));
  cancelling.enqueue('bbbbbbbb');
  cancelling.dequeue('bbbbbbbb');
  second.open();
  await cancelling.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(more, 1);
});

// Pauses the worker after it has seen the audio on disk but before it marks the
// job as started: the window in which a request can change the meeting.
function gatedStore(config) {
  const store = new MeetingStore({ root: config.meetingsDir });
  const original = store.audioStat.bind(store);
  store.workerGate = gate();
  store.workerArrived = gate();
  let gated = true;
  store.audioStat = async (id, meta) => {
    const info = await original(id, meta);
    if (gated && info) {
      gated = false;
      store.workerArrived.open();
      await store.workerGate.promise;
    }
    return info;
  };
  return store;
}

test('deleting the audio as the worker starts does not leave the meeting stuck transcribing', async (t) => {
  let store;
  const client = fakeClient();
  const f = await appFixture(t, { client, storeFactory: (config) => (store = gatedStore(config)) });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  assert.equal((await uploadAudio(f, csrf, meeting.id)).status, 201);
  await store.workerArrived.promise;

  const deleted = await f.request(`/api/meetings/${meeting.id}/audio`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
  assert.equal((await deleted.json()).meeting.status, 'failed');
  store.workerGate.open();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const after = await meetingOf(f, meeting.id);
  assert.equal(after.status, 'failed');
  assert.equal(client.calls.length, 0);
  // The failed record can be revived by uploading again.
  assert.equal((await uploadAudio(f, csrf, meeting.id)).status, 201);
  await waitFor(async () => (await meetingOf(f, meeting.id)).status === 'done');
});

test('a recording replaced while the old one is being picked up is transcribed afterwards', async (t) => {
  let store;
  const client = fakeClient();
  const f = await appFixture(t, { client, storeFactory: (config) => (store = gatedStore(config)) });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  await uploadAudio(f, csrf, meeting.id, { name: 'first.wav' });
  await store.workerArrived.promise;

  // The meeting is still "queued", so a replacement upload is accepted.
  const replaced = await uploadAudio(f, csrf, meeting.id, { name: 'second.mp3', bytes: 4096, type: 'audio/mpeg' });
  assert.equal(replaced.status, 201);
  store.workerGate.open();

  const done = await waitFor(async () => {
    const current = await meetingOf(f, meeting.id);
    return current.status === 'done' ? current : null;
  });
  assert.equal(done.audio.filename, 'second.mp3');
  assert.equal(client.calls.at(-1).filename, 'second.mp3');
  assert.match(client.calls.at(-1).filePath, /audio\.mp3$/);
  await assert.rejects(() => stat(join(f.config.meetingsDir, meeting.id, 'audio.wav')));
});

test('re-uploading in another format replaces the old recording and transcribes again', async (t) => {
  const client = fakeClient();
  const f = await appFixture(t, { client });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  await uploadAudio(f, csrf, meeting.id, { name: 'take1.wav' });
  await waitFor(async () => (await meetingOf(f, meeting.id)).status === 'done');
  const second = await uploadAudio(f, csrf, meeting.id, { name: 'take2.mp3', bytes: 1000, type: 'audio/mpeg' });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).meeting.status, 'queued');
  const done = await waitFor(async () => {
    const current = await meetingOf(f, meeting.id);
    return current.status === 'done' && current.audio.filename === 'take2.mp3' ? current : null;
  });
  assert.equal(done.audio.bytes, 1000);
  assert.equal(client.calls.length, 2);
  await assert.rejects(() => stat(join(f.config.meetingsDir, meeting.id, 'audio.wav')));
  assert.ok((await stat(join(f.config.meetingsDir, meeting.id, 'audio.mp3'))).isFile());
});

test('internal errors are logged but never shown to the user verbatim', async (t) => {
  const client = fakeClient({
    async transcribeFile() {
      throw Object.assign(new Error("EACCES: permission denied, open '/var/lib/personal-site/meetings/x/audio.wav'"), { code: 'EACCES' });
    },
  });
  const f = await appFixture(t, { client });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = original; });
  await uploadAudio(f, csrf, meeting.id);
  const failed = await waitFor(async () => {
    const current = await meetingOf(f, meeting.id);
    return current.status === 'failed' ? current : null;
  });
  console.error = original;
  assert.doesNotMatch(failed.error, /EACCES|\/var\/lib/);
  assert.match(failed.error, /转写失败/);
  assert.ok(errors.some((line) => line.includes('EACCES')));
});

test('shutting down aborts an in-flight transcription and leaves it for recovery', { timeout: 10_000 }, async (t) => {
  const started = gate();
  const client = fakeClient({
    async transcribeFile({ signal }) {
      started.open();
      await new Promise((resolve, reject) => {
        if (!signal) return; // old behaviour: never settles
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const f = await appFixture(t, { client });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  await uploadAudio(f, csrf, meeting.id);
  await started.promise;
  assert.equal((await meetingOf(f, meeting.id)).status, 'transcribing');

  const began = Date.now();
  await new Promise((resolve) => f.server.close(resolve));
  assert.ok(Date.now() - began < 3000, 'close waited for the transcription');

  const store = new MeetingStore({ root: f.config.meetingsDir });
  const meta = await store.get(meeting.id);
  assert.equal(meta.status, 'queued');
  assert.equal(meta.error, null);
  assert.deepEqual(await store.recover(), [meeting.id]);
});

test('an interrupted upload releases the lock and leaves no partial file', async (t) => {
  const f = await appFixture(t);
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  const url = new URL(`/api/meetings/${meeting.id}/audio?name=cut.wav`, f.baseUrl);
  await new Promise((resolve) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        Cookie: [...f.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        Origin: ORIGIN,
        'X-CSRF-Token': csrf,
        'Content-Type': 'audio/wav',
        'Content-Length': '100000',
      },
    });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.write(Buffer.alloc(4096, 2), () => setTimeout(() => req.destroy(), 50));
  });
  const directory = join(f.config.meetingsDir, meeting.id);
  await waitFor(async () => {
    const { readdir } = await import('node:fs/promises');
    return !(await readdir(directory)).some((name) => name.endsWith('.part'));
  });
  assert.equal((await meetingOf(f, meeting.id)).status, 'draft');
  const retried = await uploadAudio(f, csrf, meeting.id);
  assert.equal(retried.status, 201);
});

test('removing a meeting while it is transcribing does not resurrect its folder', async (t) => {
  const release = gate();
  const started = gate();
  const client = fakeClient();
  const transcribe = client.transcribeFile;
  client.transcribeFile = async (args) => {
    started.open();
    await release.promise;
    return transcribe(args);
  };
  const f = await appFixture(t, { client });
  const csrf = await f.login();
  const meeting = await createMeeting(f, csrf);
  await uploadAudio(f, csrf, meeting.id);
  await started.promise;
  const removed = await f.request(`/api/meetings/${meeting.id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
  assert.equal(removed.status, 200);
  release.open();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(() => stat(join(f.config.meetingsDir, meeting.id)));
  assert.equal((await f.request(`/api/meetings/${meeting.id}`)).status, 404);
});

test('card actions never offer a retry that the server would refuse', () => {
  const base = { id: 'aaaaaaaa', title: 'x', transcript: null };
  assert.deepEqual(meetingActions({ ...base, status: 'draft', audio: null }), ['remove']);
  assert.deepEqual(
    meetingActions({ ...base, status: 'failed', audio: { deleted: false } }),
    ['retry', 'deleteAudio', 'remove'],
  );
  assert.deepEqual(meetingActions({ ...base, status: 'failed', audio: { deleted: true } }), ['remove']);
  assert.deepEqual(meetingActions({ ...base, status: 'transcribing', audio: { deleted: false } }), ['remove']);
  assert.deepEqual(
    meetingActions({ ...base, status: 'done', audio: { deleted: true }, transcript: { chars: 1 } }),
    ['view', 'download', 'remove'],
  );
});

// ── AssemblyAI client (fake fetch, no network) ──────────────────────────────

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

async function audioFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-meetings-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'a.wav');
  await writeFile(filePath, Buffer.alloc(64, 3));
  return filePath;
}

test('the AssemblyAI client retries a reset connection and cleans the Chinese text', async (t) => {
  const filePath = await audioFixture(t);
  const seen = [];
  let submits = 0;
  const client = createAssemblyAiClient({
    apiKey: 'test-key',
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      seen.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/v2/upload')) {
        for await (const chunk of init.body) void chunk; // consume the stream like a real server
        return jsonResponse(200, { upload_url: 'https://cdn.example/a' });
      }
      if (url.endsWith('/v2/transcript')) {
        submits += 1;
        if (submits === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        assert.equal(JSON.parse(init.body).speech_models[0], 'assemblyai-stt-3-7');
        return jsonResponse(200, { id: 'job1' });
      }
      return jsonResponse(200, {
        status: 'completed',
        language_code: 'zh',
        audio_duration: 2.5,
        text: '我们 来 看 一下 F Y 二 八',
        utterances: [{ speaker: 'A', start: 0, end: 2500, text: '我们 来 看 一下 F Y 二 八' }],
      });
    },
  });
  const result = await client.transcribeFile({ filePath, size: 64, mime: 'audio/wav' });
  assert.equal(submits, 2);
  assert.equal(result.text, '我们来看一下 FY 二八');
  assert.equal(result.durationMs, 2500);
  assert.deepEqual(result.speakers, ['A']);
  assert.equal(result.words, undefined);
  assert.deepEqual(seen, ['POST /v2/upload', 'POST /v2/transcript', 'POST /v2/transcript', 'GET /v2/transcript/job1']);
});

test('the AssemblyAI client reports a bad key once and does not retry it', async (t) => {
  const filePath = await audioFixture(t);
  let calls = 0;
  const client = createAssemblyAiClient({
    apiKey: 'wrong',
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls += 1;
      if (url.endsWith('/v2/upload')) {
        for await (const chunk of init.body) void chunk;
        return jsonResponse(200, { upload_url: 'https://cdn.example/a' });
      }
      return jsonResponse(401, { error: 'Invalid API key' });
    },
  });
  await assert.rejects(
    () => client.transcribeFile({ filePath, size: 64 }),
    (error) => error instanceof TranscriptionError && /ASSEMBLYAI_API_KEY/.test(error.message),
  );
  assert.equal(calls, 2);
});

test('the AssemblyAI client stops polling as soon as it is aborted', async (t) => {
  const filePath = await audioFixture(t);
  const controller = new AbortController();
  let polls = 0;
  const client = createAssemblyAiClient({
    apiKey: 'k',
    pollIntervalMs: 60_000,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/v2/upload')) {
        for await (const chunk of init.body) void chunk;
        return jsonResponse(200, { upload_url: 'https://cdn.example/a' });
      }
      if (url.endsWith('/v2/transcript')) return jsonResponse(200, { id: 'job2' });
      polls += 1;
      setTimeout(() => controller.abort(), 10);
      return jsonResponse(200, { status: 'processing' });
    },
  });
  const began = Date.now();
  await assert.rejects(() => client.transcribeFile({ filePath, size: 64, signal: controller.signal }));
  assert.ok(Date.now() - began < 2000);
  assert.equal(polls, 1);
});
