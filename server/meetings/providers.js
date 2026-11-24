// Transcription provider registry. Every provider exposes the same
// createClient(options) -> { transcribeFile({ filePath, size, mime, filename, signal }) }
// contract the queue worker already uses, and returns the same normalized
// transcript shape: { model, language, durationMs, speakers, text, utterances }.
//
// Keys are passed in per job (resolved from saved settings, then env), so
// switching provider or rotating a key on the settings page applies to the
// next job without a restart.

import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssemblyAiClient, TranscriptionError } from './transcribe.js';
import { cleanCjkSpacing } from './render.js';

function requestSignal(signal, timeout) {
  const timer = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

function isNetworkError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError') return true;
  if (error.name === 'TypeError' && /fetch failed/i.test(error.message || '')) return true;
  const code = error?.cause?.code || error?.code || '';
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_)/.test(code);
}

/** Group word-level output (ElevenLabs, OpenAI) into speaker turns. */
export function wordsToUtterances(words, { speakerOf, startOf, endOf, textOf, gapMs = 1500 }) {
  const turns = [];
  let current = null;
  for (const word of words) {
    const speaker = speakerOf(word);
    const start = startOf(word);
    const end = endOf(word);
    const text = textOf(word);
    if (text == null) continue;
    const gap = current ? start - current.end : 0;
    if (!current || current.speaker !== speaker || gap > gapMs) {
      if (current) turns.push(current);
      current = { speaker, start, end, text: '' };
    }
    current.text += text;
    current.end = Math.max(current.end, end);
  }
  if (current) turns.push(current);
  return turns
    .map((turn) => ({ ...turn, text: cleanCjkSpacing(turn.text) }))
    .filter((turn) => turn.text);
}

/** ElevenLabs uses speaker_0, speaker_1… ; show them as A, B… like AssemblyAI. */
function speakerLetters() {
  const map = new Map();
  return (raw) => {
    const key = String(raw ?? 'speaker_0');
    if (!map.has(key)) {
      const index = map.size;
      map.set(key, index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}`);
    }
    return map.get(key);
  };
}

function multipartFile(blob, name, fields) {
  const form = new FormData();
  for (const [key, value] of fields) {
    if (value === undefined || value === null || value === '') continue;
    form.append(key, String(value));
  }
  form.append('file', blob, name);
  return form;
}

async function fileBlob(filePath, mime) {
  // FormData needs a Blob. Recordings are capped by MEETINGS_MAX_UPLOAD_BYTES
  // (default 200 MB); fs.openAsBlob streams from disk instead of buffering.
  if (typeof openAsBlob === 'function') return openAsBlob(filePath, { type: mime || 'application/octet-stream' });
  return new Blob([await readFile(filePath)], { type: mime || 'application/octet-stream' });
}

async function postWithRetry(label, fn, { attempts = 3, signal, sleep }) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      last = error;
      const retryable = error?.retryable || isNetworkError(error);
      if (!retryable || index === attempts - 1) break;
      await sleep(Math.min(15_000, 2000 * (index + 1)), signal);
    }
  }
  if (last instanceof TranscriptionError) throw last;
  throw new TranscriptionError(`${label}失败：${last?.message ?? '未知错误'}`, { retryable: true });
}

async function readError(response) {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

// ── ElevenLabs Scribe ───────────────────────────────────────────────────────
export function createElevenLabsClient({
  apiKey,
  baseUrl = 'https://api.elevenlabs.io',
  model = 'scribe_v3',
  keyterms = [],
  languageCode = 'zh',
  secondaryLanguages = ['en'],
  maxSpeakers = 8,
  timeoutMs = 45 * 60 * 1000,
  fetchImpl = globalThis.fetch,
  sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
  now = () => Date.now(),
} = {}) {
  const endpoint = String(baseUrl).replace(/\/+$/, '');

  async function transcribeFile({ filePath, mime, filename, signal }) {
    if (!apiKey) throw new TranscriptionError('尚未配置 ElevenLabs API Key，无法转写。', { status: 503 });
    const payload = await postWithRetry('ElevenLabs 转写', async () => {
      const blob = await fileBlob(filePath, mime);
      const fields = [
        ['model_id', model],
        ['diarize', 'true'],
        ['num_speakers', maxSpeakers],
        ['timestamps_granularity', 'word'],
        ['tag_audio_events', 'false'],
        ['language_code', languageCode],
      ];
      const form = multipartFile(blob, filename || 'audio', fields);
      for (const code of secondaryLanguages ?? []) form.append('secondary_language_codes', code);
      for (const term of (keyterms ?? []).slice(0, 1000)) {
        if (/[<>{}[\]\\]/.test(term) || term.length > 50) continue;
        form.append('keyterms', term);
      }
      let response;
      try {
        response = await fetchImpl(`${endpoint}/v1/speech-to-text`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: form,
          signal: requestSignal(signal, timeoutMs),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new TranscriptionError(`ElevenLabs 连接失败：${error?.message ?? '网络错误'}`, { retryable: true });
      }
      if (response.status === 401) throw new TranscriptionError('ElevenLabs 鉴权失败，请检查 API Key。');
      if (!response.ok) {
        throw new TranscriptionError(`ElevenLabs 返回 ${response.status}：${await readError(response)}`, {
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return response.json();
    }, { signal, sleep });

    const letter = speakerLetters();
    const words = Array.isArray(payload.words) ? payload.words.filter((word) => word.type !== 'audio_event') : [];
    const utterances = wordsToUtterances(words, {
      speakerOf: (word) => letter(word.speaker_id),
      startOf: (word) => Math.round((Number(word.start) || 0) * 1000),
      endOf: (word) => Math.round((Number(word.end) || 0) * 1000),
      textOf: (word) => (typeof word.text === 'string' ? word.text : null),
    });
    const durationMs = payload.audio_duration_secs
      ? Math.round(Number(payload.audio_duration_secs) * 1000)
      : (utterances.at(-1)?.end ?? 0);
    return {
      model,
      language: payload.language_code ?? null,
      durationMs,
      speakers: [...new Set(utterances.map((item) => item.speaker))].sort(),
      text: cleanCjkSpacing(payload.text ?? ''),
      utterances,
      jobId: payload.transcription_id ?? null,
      completedAt: now(),
    };
  }

  return { transcribeFile, model };
}

// ── OpenAI ─────────────────────────────────────────────────────────────────
// gpt-4o-transcribe-diarize returns speaker segments; the other models return
// plain text, which is stored as a single "A" utterance.
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

export function createOpenAiClient({
  apiKey,
  baseUrl = 'https://api.openai.com',
  model = 'gpt-4o-transcribe-diarize',
  keyterms = [],
  timeoutMs = 30 * 60 * 1000,
  fetchImpl = globalThis.fetch,
  sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
  now = () => Date.now(),
} = {}) {
  const endpoint = String(baseUrl).replace(/\/+$/, '');
  const diarize = /diarize/.test(model);

  async function transcribeFile({ filePath, size, mime, filename, signal }) {
    if (!apiKey) throw new TranscriptionError('尚未配置 OpenAI API Key，无法转写。', { status: 503 });
    if (size > OPENAI_MAX_BYTES) {
      throw new TranscriptionError('OpenAI 转写单个文件不能超过 25 MB，请改用 AssemblyAI 或 ElevenLabs，或先压缩录音。', { status: 413 });
    }
    const payload = await postWithRetry('OpenAI 转写', async () => {
      const blob = await fileBlob(filePath, mime);
      const fields = [
        ['model', model],
        ['response_format', diarize ? 'diarized_json' : 'json'],
      ];
      if (diarize) fields.push(['chunking_strategy', 'auto']);
      if (!diarize && keyterms?.length) fields.push(['prompt', keyterms.slice(0, 100).join(', ')]);
      const form = multipartFile(blob, filename || 'audio.wav', fields);
      let response;
      try {
        response = await fetchImpl(`${endpoint}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal: requestSignal(signal, timeoutMs),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new TranscriptionError(`OpenAI 连接失败：${error?.message ?? '网络错误'}`, { retryable: true });
      }
      if (response.status === 401) throw new TranscriptionError('OpenAI 鉴权失败，请检查 API Key。');
      if (!response.ok) {
        throw new TranscriptionError(`OpenAI 返回 ${response.status}：${await readError(response)}`, {
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return response.json();
    }, { signal, sleep });

    let utterances;
    if (Array.isArray(payload.segments) && payload.segments.length) {
      const letter = speakerLetters();
      utterances = payload.segments
        .map((segment) => ({
          speaker: letter(segment.speaker ?? 'A'),
          start: Math.round((Number(segment.start) || 0) * 1000),
          end: Math.round((Number(segment.end) || 0) * 1000),
          text: cleanCjkSpacing(segment.text),
        }))
        .filter((item) => item.text);
    } else {
      const text = cleanCjkSpacing(payload.text ?? '');
      const durationMs = Math.round((Number(payload.duration) || 0) * 1000);
      utterances = text ? [{ speaker: 'A', start: 0, end: durationMs, text }] : [];
    }
    const durationMs = payload.duration
      ? Math.round(Number(payload.duration) * 1000)
      : (utterances.at(-1)?.end ?? 0);
    return {
      model,
      language: payload.language ?? null,
      durationMs,
      speakers: [...new Set(utterances.map((item) => item.speaker))].sort(),
      text: cleanCjkSpacing(payload.text ?? utterances.map((item) => item.text).join('\n')),
      utterances,
      jobId: null,
      completedAt: now(),
    };
  }

  return { transcribeFile, model };
}

// ── registry ───────────────────────────────────────────────────────────────
export const PROVIDERS = [
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    description: '中英混说原生切换，说话人分离准确，支持长音频。默认推荐。',
    models: ['assemblyai-stt-3-7', 'universal-3-5-pro', 'universal-2'],
    defaultModel: 'assemblyai-stt-3-7',
    docsUrl: 'https://www.assemblyai.com/docs',
    keyUrl: 'https://www.assemblyai.com/dashboard',
    create: (options) => createAssemblyAiClient(options),
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs Scribe',
    description: '中文与说话人分离第一梯队，按中文为主、英文为次要语言设置。',
    models: ['scribe_v3', 'scribe_v2'],
    defaultModel: 'scribe_v3',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text/convert',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    create: (options) => createElevenLabsClient(options),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: '英文为主的会议表现好。单文件不超过 25 MB；diarize 模型带说话人。',
    models: ['gpt-4o-transcribe-diarize', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
    defaultModel: 'gpt-4o-transcribe-diarize',
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
    keyUrl: 'https://platform.openai.com/api-keys',
    create: (options) => createOpenAiClient(options),
  },
];

export function createProviderRegistry(list = PROVIDERS) {
  const byId = new Map(list.map((provider) => [provider.id, provider]));
  return {
    defaultId: list[0].id,
    has: (id) => byId.has(id),
    get: (id) => {
      const { create, ...rest } = byId.get(id) ?? byId.get(list[0].id);
      return rest;
    },
    getFull: (id) => byId.get(id) ?? byId.get(list[0].id),
    list: () => list.map(({ create, ...rest }) => rest),
  };
}
