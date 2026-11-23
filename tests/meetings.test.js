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
import { MeetingStore } from '../server/meetings/store.js';

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

async function appFixture(t, { overrides = {}, client = fakeClient() } = {}) {
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
  const server = createApplication({ config, meetingsClient: client });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
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
  return { request, login, config, directory, client };
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

async function uploadAudio(f, csrf, id, { name = 'weekly.wav', bytes = 2048 } = {}) {
  return f.request(`/api/meetings/${id}/audio?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: Buffer.alloc(bytes, 1),
    headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'audio/wav' },
  });
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
      if (attempts === 1) throw new Error('转写服务返回 500');
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
