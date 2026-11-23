// Filesystem-backed meeting archive. Each meeting is one directory under the
// configured root: meta.json plus the audio file and the transcript exports.
// The audio file is optional after upload — deleting it frees the space while
// the transcript exports stay on disk.

import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildTranscriptMarkdown, buildTranscriptText } from './render.js';

export const MEETING_STATUSES = ['queued', 'transcribing', 'done', 'failed'];

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

function sanitizeTitle(value, fallback) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 120);
}

export class MeetingStore {
  constructor({ root, now = () => Date.now() }) {
    this.root = resolve(root);
    this.now = now;
    mkdirSync(this.root, { recursive: true });
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

  async save(meta) {
    const directory = this.dir(meta.id);
    await mkdir(directory, { recursive: true });
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
    await this.save(meta);
    return meta;
  }

  async patch(id, partial) {
    const meta = await this.get(id);
    if (!meta) return null;
    const next = { ...meta, ...partial, updatedAt: this.now() };
    if (Object.prototype.hasOwnProperty.call(partial, 'audio')) {
      next.audio = partial.audio ? { ...(meta.audio ?? {}), ...partial.audio } : null;
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'transcript')) {
      next.transcript = partial.transcript ? { ...(meta.transcript ?? {}), ...partial.transcript } : null;
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'queue')) {
      next.queue = { ...(meta.queue ?? {}), ...partial.queue };
    }
    await this.save(next);
    return next;
  }

  async attachAudio(id, { temporaryPath, ext, bytes, mime, filename }) {
    const meta = await this.get(id);
    if (!meta) return null;
    const safeExt = AUDIO_EXTENSIONS.has(ext) ? ext : '.audio';
    const target = join(this.dir(id), `audio${safeExt}`);
    await rename(temporaryPath, target);
    return this.patch(id, {
      audio: { filename, ext: safeExt, bytes, mime, deleted: false, uploadedAt: this.now() },
    });
  }

  /**
   * Identifies one specific audio upload. A transcription that finishes after
   * the audio was replaced or deleted must not overwrite the archive.
   */
  audioToken(meta) {
    const audio = meta?.audio;
    if (!audio) return 'none';
    return [audio.filename, audio.bytes, audio.uploadedAt, audio.deleted ? 'deleted' : 'present'].join('|');
  }

  async deleteAudio(id) {
    const meta = await this.get(id);
    if (!meta) return null;
    if (meta.audio && !meta.audio.deleted) {
      await rm(this.audioFile(id, meta), { force: true });
    }
    return this.patch(id, { audio: meta.audio ? { deleted: true } : null });
  }

  async writeTranscript(id, transcript) {
    const meta = await this.get(id);
    if (!meta) return null;
    const directory = this.dir(id);
    const json = JSON.stringify(transcript, null, 2);
    const markdown = buildTranscriptMarkdown({ ...meta, transcript: { completedAt: this.now() } }, transcript);
    const text = buildTranscriptText(transcript);
    await writeFile(join(directory, 'transcript.json'), json, 'utf8');
    await writeFile(join(directory, 'transcript.md'), markdown, 'utf8');
    await writeFile(join(directory, 'transcript.txt'), text, 'utf8');
    return this.patch(id, {
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
    });
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

  openAudio(id, meta) {
    return createReadStream(this.audioFile(id, meta));
  }

  async remove(id) {
    if (!isValidMeetingId(id)) return false;
    await rm(this.dir(id), { recursive: true, force: true });
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
