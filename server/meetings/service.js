// Orchestrates one transcription: queued -> transcribing -> done | failed.
// Kept separate from the HTTP handler so the queue worker and a manual retry
// share exactly the same path.

export function createMeetingService({ store, client, now = () => Date.now(), logger = console }) {
  /** Audio is gone: keep the transcript if there is one, otherwise report it. */
  async function settleWithoutAudio(id, meta) {
    if (meta?.transcript) {
      await store.patch(id, {
        status: 'done',
        error: null,
        queue: { finishedAt: now() },
      });
      return;
    }
    await store.patch(id, {
      status: 'failed',
      error: '没有可用的录音文件，无法转写。',
      queue: { finishedAt: now() },
    });
  }

  async function run(id) {
    const meta = await store.get(id);
    if (!meta) return;
    if (!meta.audio || meta.audio.deleted) {
      await settleWithoutAudio(id, meta);
      return;
    }
    const token = store.audioToken(meta);
    const info = await store.audioStat(id, meta);
    if (!info) {
      await settleWithoutAudio(id, meta);
      return;
    }

    try {
      await store.patch(id, {
        status: 'transcribing',
        error: null,
        queue: { startedAt: now(), finishedAt: null },
      });

      const transcript = await client.transcribeFile({
        filePath: store.audioFile(id, meta),
        size: info.size,
        mime: meta.audio.mime,
        filename: meta.audio.filename,
      });

      // The recording may have been replaced or deleted while the job ran.
      // Discard a stale result instead of attaching it to the wrong audio.
      const latest = await store.get(id);
      if (!latest) return;
      if (store.audioToken(latest) !== token) return;

      await store.writeTranscript(id, transcript);
    } catch (error) {
      logger?.error?.(`[meetings] ${id} 转写失败:`, error?.message ?? error);
      // If the recording was replaced or deleted meanwhile, the handler has
      // already decided the final state; don't stomp on it.
      const latest = await store.get(id);
      if (latest && store.audioToken(latest) !== token) return;
      await store.patch(id, {
        status: 'failed',
        error: String(error?.message ?? '转写失败'),
        queue: { finishedAt: now() },
      });
    }
  }

  return { run };
}
