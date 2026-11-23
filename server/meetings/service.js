// Orchestrates one transcription: queued -> transcribing -> done | failed.
// Kept separate from the HTTP handler so the queue worker and a manual retry
// share exactly the same path.
//
// Every transition is a conditional, locked store.update(): the worker only
// moves a meeting forward if it is still in the state it expects and still
// holds the same recording (audio token). Whatever the HTTP handler decided in
// the meantime (audio deleted or replaced, meeting removed) wins.

import { TranscriptionError } from './transcribe.js';

const GENERIC_FAILURE = '转写失败，请稍后重试。';

/** Only messages written for users reach meta.error; raw fs/Node errors don't. */
function userMessage(error) {
  if (error instanceof TranscriptionError || error?.name === 'TranscriptionError') {
    return String(error.message || GENERIC_FAILURE);
  }
  return GENERIC_FAILURE;
}

export function createMeetingService({ store, client, now = () => Date.now(), logger = console }) {
  /** Audio is gone: keep the transcript if there is one, otherwise report it. */
  function settleWithoutAudio(id) {
    return store.update(id, (meta) => {
      if (meta.status !== 'queued') return null;
      return meta.transcript
        ? { status: 'done', error: null, queue: { finishedAt: now() } }
        : { status: 'failed', error: '没有可用的录音文件，无法转写。', queue: { finishedAt: now() } };
    });
  }

  async function run(id, { signal } = {}) {
    const meta = await store.get(id);
    // Anything but "queued" means the handler already settled this meeting
    // (deleted, cancelled, removed) after it was enqueued.
    if (!meta || meta.status !== 'queued') return;
    if (!meta.audio || meta.audio.deleted) {
      await settleWithoutAudio(id);
      return;
    }
    const token = store.audioToken(meta);
    const info = await store.audioStat(id, meta);
    if (!info) {
      await settleWithoutAudio(id);
      return;
    }

    const started = await store.update(id, (current) => (
      current.status === 'queued' && store.audioToken(current) === token
        ? { status: 'transcribing', error: null, queue: { startedAt: now(), finishedAt: null } }
        : null
    ));
    if (!started) return;

    const stillOurs = (current) => current.status === 'transcribing' && store.audioToken(current) === token;
    try {
      const transcript = await client.transcribeFile({
        filePath: store.audioFile(id, meta),
        size: info.size,
        mime: meta.audio.mime,
        filename: meta.audio.filename,
        signal,
      });
      // Discarded (returns null) if the recording was replaced or deleted
      // while the job ran.
      await store.writeTranscript(id, transcript, { expectToken: token });
    } catch (error) {
      if (signal?.aborted) {
        // Shutdown: hand the job back to the queue for the next boot.
        await store.update(id, (current) => (
          stillOurs(current) ? { status: 'queued', queue: { startedAt: null, finishedAt: null } } : null
        )).catch(() => {});
        return;
      }
      logger?.error?.(`[meetings] ${id} 转写失败:`, error?.message ?? error);
      await store.update(id, (current) => (
        stillOurs(current)
          ? { status: 'failed', error: userMessage(error), queue: { finishedAt: now() } }
          : null
      ));
    }
  }

  return { run };
}
