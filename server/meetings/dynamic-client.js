// A transcription client that looks up the selected provider, its key and its
// model from settings at the start of every job. The queue worker keeps
// calling transcribeFile() as before; switching provider or rotating a key on
// the settings page applies to the next job without a restart.

export function createDynamicTranscriptionClient({ settings, registry, baseOptions = {}, overrides = {} }) {
  async function transcribeFile(job) {
    const { providerId, apiKey, model, keyterms } = await settings.resolveTranscription();
    const provider = registry.getFull(providerId);
    const client = provider.create({
      ...baseOptions,
      ...(overrides[providerId] ?? {}),
      apiKey,
      model,
      keyterms,
    });
    const transcript = await client.transcribeFile(job);
    return { ...transcript, provider: providerId };
  }
  return { transcribeFile };
}
