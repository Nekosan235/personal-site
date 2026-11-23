// Filesystem-backed meeting archive. Each meeting is one directory under the
// configured root: meta.json plus the audio file and the transcript exports.
// The audio file is optional after upload — deleting it frees the space while
// the transcript exports stay on disk.
//
// Every read-modify-write of one meeting goes through update(), which runs
// under a per-meeting promise chain. The HTTP handler and the queue worker can
// therefore make conditional transitions ("only if still queued and still the
// same recording") without losing each other's writes.

import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildTranscriptMarkdown, buildTranscriptText } from './render.js';

export const MEETING_STATUSES = ['draft', 'queued', 'transcribing', 'done', 'failed'];

export const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.amr', '.wma',
]);

const ID_PATTERN = /^[a-z0-9]{8,32}$/;

export function isValidMeetingId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function newId(now) {
  const stamp = Math.floor(now() / 1000).toString(36);
  return `${stamp}${randomBytes(5).toString('hex')}`.slice(0, 24);
}

function mergeMeta(meta, partial, timestamp) {
  const next = { ...meta, ...partial, updatedAt: timestamp };
  if (Object.prototype.hasOwnProperty.call(partial, 'audio')) {
    next.audio = partial.audio ? { ...(meta.audio ?? {}), ...partial.audio } : null;
  }
  if (Object.prototype.hasOwnProperty.call(partial, 'transcript')) {
    next.transcript = partial.transcript ? { ...(meta.transcript ?? {}), ...partial.transcript } : null;
  }
  if (Object.prototype.hasOwnProperty.call(partial, 'queue')) {
    next.queue = { ...(meta.queue ?? {}), ...partial.queue };
  }
  return next;
}

function sanitizeTitle(value, fallback) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 120);
}

export class MeetingStore {
  constructor({ root, now = () => Date.now() }) {
    this.root = resolve(root);
    this.now = now;
    this.locks = new Map();
    mkdirSync(this.root, { recursive: true });
  }

  /** Run fn with exclusive access to one meeting (in-process). */
  async withLock(id, fn) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  dir(id) {
    if (!isValidMeetingId(id)) throw new Error('invalid meeting id');
    return join(this.root, id);
  }

  audioFile(id, meta) {
    const ext = meta?.audio?.ext && AUDIO_EXTENSIONS.has(meta.audio.ext) ? meta.audio.ext : '.audio';
    return join(this.dir(id), `audio${ext}`);
  }

  metaPath(id) {
    return join(this.dir(id), 'meta.json');
  }

  async list() {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const meetings = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidMeetingId(entry.name)) continue;
      try {
        const raw = await readFile(this.metaPath(entry.name), 'utf8');
        const meta = JSON.parse(raw);
        if (meta && meta.id === entry.name) meetings.push(meta);
      } catch {
        // A half-written or foreign directory is ignored rather than breaking the list.
      }
    }
    meetings.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return meetings;
  }

  async get(id) {
    if (!isValidMeetingId(id)) return null;
    try {
      const raw = await readFile(this.metaPath(id), 'utf8');
      const meta = JSON.parse(raw);
      return meta && meta.id === id ? meta : null;
    } catch {
      return null;
    }
  }

  // Never creates the directory: a write that lands after remove() must fail
  // instead of resurrecting a deleted meeting. create() makes the directory.
  async save(meta) {
    const target = this.metaPath(meta.id);
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(meta, null, 2), 'utf8');
    await rename(temporary, target);
    return meta;
  }

  async create({ title, audio = null } = {}) {
    const timestamp = this.now();
    const id = newId(this.now);
    const meta = {
      id,
      title: sanitizeTitle(title, `会议 ${new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'draft',
      audio,
      transcript: null,
      summary: null,
      error: null,
      queue: { enqueuedAt: null, startedAt: null, finishedAt: null },
    };
    await mkdir(this.dir(id), { recursive: true });
    await this.save(meta);
    return meta;
  }

  /**
   * Locked read-modify-write. `mutator(meta)` may be async and returns the
   * partial to merge, or a falsy value to leave the meeting untouched.
   * Resolves to the saved meta, or null when the meeting is gone or the
   * mutator declined.
   */
  async update(id, mutator) {
    return this.withLock(id, async () => {
      const meta = await this.get(id);
      if (!meta) return null;
      const partial = await mutator(meta);
      if (!partial) return null;
      const next = mergeMeta(meta, partial, this.now());
      await this.save(next);
      return next;
    });
  }

  async patch(id, partial) {
    return this.update(id, () => partial);
  }

  /**
   * Move a finished upload into place and record it in one locked write.
   * `extra` is merged into the same write (e.g. the queued status) so a crash
   * can never leave new audio behind an old status.
   */
  async attachAudio(id, { temporaryPath, ext, bytes, mime, filename }, extra = {}) {
    const safeExt = AUDIO_EXTENSIONS.has(ext) ? ext : '.audio';
    return this.update(id, async (meta) => {
      if (meta.audio && !meta.audio.deleted && meta.audio.ext !== safeExt) {
        await rm(this.audioFile(id, meta), { force: true });
      }
      await rename(temporaryPath, join(this.dir(id), `audio${safeExt}`));
      return {
        ...extra,
        audio: {
          filename,
          ext: safeExt,
          bytes,
          mime,
          deleted: false,
          uploadedAt: this.now(),
          uploadId: randomBytes(6).toString('hex'),
        },
      };
    });
  }

  /**
   * Identifies one specific audio upload. A transcription that finishes after
   * the audio was replaced or deleted must not overwrite the archive.
   */
  audioToken(meta) {
    const audio = meta?.audio;
    if (!audio) return 'none';
    return [
      audio.filename,
      audio.bytes,
      audio.uploadedAt,
      audio.uploadId ?? '',
      audio.deleted ? 'deleted' : 'present',
    ].join('|');
  }

  /**
   * Delete the recording, keep everything else. `settle(meta)` may return
   * extra fields (e.g. a final status) written in the same locked update.
   */
  async deleteAudio(id, { settle } = {}) {
    return this.update(id, async (meta) => {
      if (meta.audio && !meta.audio.deleted) {
        await rm(this.audioFile(id, meta), { force: true });
      }
      return { ...(settle?.(meta) ?? {}), audio: meta.audio ? { deleted: true } : null };
    });
  }

  /**
   * Write the exports and mark the meeting done. With `expectToken`, nothing
   * is written unless the meeting still holds that exact recording, so a late
   * result can't attach itself to replaced or deleted audio.
   */
  async writeTranscript(id, transcript, { expectToken } = {}) {
    return this.update(id, async (meta) => {
      if (expectToken !== undefined && this.audioToken(meta) !== expectToken) return null;
      const directory = this.dir(id);
      const json = JSON.stringify(transcript, null, 2);
      const markdown = buildTranscriptMarkdown({ ...meta, transcript: { completedAt: this.now() } }, transcript);
      const text = buildTranscriptText(transcript);
      await writeFile(join(directory, 'transcript.json'), json, 'utf8');
      await writeFile(join(directory, 'transcript.md'), markdown, 'utf8');
      await writeFile(join(directory, 'transcript.txt'), text, 'utf8');
      return this.transcriptFields(transcript, json);
    });
  }

  transcriptFields(transcript, json) {
    return {
      status: 'done',
      error: null,
      transcript: {
        model: transcript.model ?? null,
        language: transcript.language ?? null,
        durationMs: transcript.durationMs ?? 0,
        speakers: transcript.speakers ?? [],
        completedAt: this.now(),
        chars: (transcript.text ?? '').length,
        bytes: Buffer.byteLength(json),
      },
      queue: { finishedAt: this.now() },
    };
  }

  async readTranscript(id) {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'transcript.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async readTranscriptExport(id, format) {
    const name = format === 'md' ? 'transcript.md' : 'transcript.txt';
    try {
      return await readFile(join(this.dir(id), name), 'utf8');
    } catch {
      return null;
    }
  }

  async audioStat(id, meta) {
    try {
      const info = await stat(this.audioFile(id, meta));
      return info.isFile() ? info : null;
    } catch {
      return null;
    }
  }

  /** `range` is the inclusive { start, end } of a 206 response. */
  openAudio(id, meta, range) {
    return createReadStream(this.audioFile(id, meta), range ? { start: range.start, end: range.end } : undefined);
  }

  async remove(id) {
    if (!isValidMeetingId(id)) return false;
    await this.withLock(id, () => rm(this.dir(id), { recursive: true, force: true, maxRetries: 3 }));
    return true;
  }

  /** Remove half-written upload parts and abandoned meta temp files. */
  async cleanupTemp(id) {
    let entries;
    try {
      entries = await readdir(this.dir(id));
    } catch {
      return;
    }
    for (const name of entries) {
      if (/^upload-\d+\.part$/.test(name) || /^meta\.json\.[0-9a-f]+\.tmp$/.test(name)) {
        await rm(join(this.dir(id), name), { force: true });
      }
    }
  }

  /** Boot recovery: a crash can leave a meeting marked transcribing. */
  async recover() {
    const meetings = await this.list();
    const resumable = [];
    for (const meta of meetings) {
      await this.cleanupTemp(meta.id);
      if (meta.status === 'transcribing') {
        await this.patch(meta.id, {
          status: 'queued',
          error: null,
          queue: { startedAt: null, finishedAt: null },
        });
        resumable.push(meta.id);
      } else if (meta.status === 'queued') {
        if (meta.audio && !meta.audio.deleted) {
          resumable.push(meta.id);
        } else {
          // Queued without audio means the upload never landed.
          await this.patch(meta.id, { status: 'failed', error: '没有录音文件，可能上传未完成。' });
        }
      }
    }
    return resumable;
  }

  /** Bytes still occupied by audio across the archive. */
  async audioBytes() {
    const meetings = await this.list();
    return meetings.reduce((sum, meta) => sum + (meta.audio && !meta.audio.deleted ? Number(meta.audio.bytes) || 0 : 0), 0);
  }
}
