// Meeting settings saved from the /meetings/settings page.
//
// Stored next to the archive as one JSON file (mode 0600). Environment
// variables stay the fallback: a value saved here wins, an empty value means
// "use the environment". API keys are write-only — public() only ever reports
// whether a key is set and its last four characters, never the key itself.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { renameWithRetry } from './store.js';

export const DEFAULT_SUMMARY_PROMPT = [
  '你是一名资深会议记录员。下面是一场会议的自动转写稿，说话人用 Speaker A/B/C 区分，可能夹杂英文术语和少量识别错误。',
  '请整理成一份中文会议纪要，使用 Markdown，包含以下小节：',
  '1. 会议概要（3-5 句话）',
  '2. 讨论要点（按议题分组）',
  '3. 结论与决策',
  '4. 待办事项（表格：事项 / 负责人 / 截止时间；转写里没有提到的写“待定”）',
  '5. 待确认问题与存疑词（转写里明显识别有误或含义不明的专有名词）',
  '要求：只依据转写内容，不要编造；保留英文术语原文；不要输出与纪要无关的解释。',
].join('\n');

const KEY_PATTERN = /^[\x21-\x7e]{8,256}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_PROMPT = 8000;
const MAX_KEYTERMS = 400;

export class SettingsError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'SettingsError';
    this.statusCode = 400;
    this.field = field;
  }
}

function mask(key) {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

function cleanKeyterms(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,，\n]/);
  const seen = new Set();
  const terms = [];
  for (const raw of list) {
    const term = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 50);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_KEYTERMS) break;
  }
  return terms;
}

/**
 * providerIds: the transcription providers that may be selected.
 * summaryIds: the summary providers that may be selected.
 * env: fallback values from config (apiKeys, model, keyterms, provider).
 */
export class MeetingSettings {
  constructor({ path, providers, summaryProviders, env = {}, now = () => Date.now(), logger = console }) {
    this.path = path;
    this.providers = providers;
    this.summaryProviders = summaryProviders;
    this.env = env;
    this.now = now;
    this.logger = logger;
    this.data = null;
    this.writing = Promise.resolve();
  }

  empty() {
    return {
      version: 1,
      transcription: { provider: null, keys: {}, models: {}, keyterms: null },
      summary: { provider: null, prompt: null, autoAfterTranscript: false },
      updatedAt: null,
    };
  }

  async load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      const base = this.empty();
      this.data = {
        ...base,
        ...raw,
        transcription: { ...base.transcription, ...(raw.transcription ?? {}) },
        summary: { ...base.summary, ...(raw.summary ?? {}) },
      };
      this.data.transcription.keys = { ...(raw.transcription?.keys ?? {}) };
      this.data.transcription.models = { ...(raw.transcription?.models ?? {}) };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.error?.('[meetings] 设置文件无法读取，使用默认值:', error?.message ?? error);
      }
      this.data = this.empty();
    }
    return this.data;
  }

  async save(data = this.data) {
    data.updatedAt = this.now();
    const temporary = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    const write = this.writing.then(async () => {
      await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      try {
        await renameWithRetry(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    // Later saves wait for this one, but its failure must not block them;
    // the caller still sees this save's own error.
    this.writing = write.catch(() => {});
    await write;
  }

  providerIdOrDefault(id) {
    if (id && this.providers.has(id)) return id;
    const fromEnv = this.env.provider;
    if (fromEnv && this.providers.has(fromEnv)) return fromEnv;
    return this.providers.defaultId;
  }

  /** Everything a transcription job needs, with env fallbacks applied. */
  async resolveTranscription() {
    const data = await this.load();
    const providerId = this.providerIdOrDefault(data.transcription.provider);
    const provider = this.providers.get(providerId);
    const savedKey = data.transcription.keys[providerId];
    const apiKey = savedKey || this.env.apiKeys?.[providerId] || '';
    const model = data.transcription.models[providerId] || (providerId === this.env.provider ? this.env.model : '') || provider.defaultModel;
    const keyterms = data.transcription.keyterms ?? this.env.keyterms ?? [];
    return { providerId, provider, apiKey, model, keyterms };
  }

  async resolveSummary() {
    const data = await this.load();
    const id = data.summary.provider && this.summaryProviders.has(data.summary.provider)
      ? data.summary.provider
      : (this.env.summaryProvider && this.summaryProviders.has(this.env.summaryProvider) ? this.env.summaryProvider : 'disabled');
    return {
      providerId: id,
      provider: this.summaryProviders.get(id),
      prompt: data.summary.prompt || DEFAULT_SUMMARY_PROMPT,
      autoAfterTranscript: Boolean(data.summary.autoAfterTranscript),
    };
  }

  /** The shape sent to the browser: no secrets, only "set" + last four. */
  async public() {
    const data = await this.load();
    const resolved = await this.resolveTranscription();
    const summary = await this.resolveSummary();
    const providers = this.providers.list().map((provider) => {
      const saved = data.transcription.keys[provider.id] || '';
      const fromEnv = this.env.apiKeys?.[provider.id] || '';
      return {
        id: provider.id,
        label: provider.label,
        description: provider.description,
        models: provider.models,
        defaultModel: provider.defaultModel,
        model: data.transcription.models[provider.id] || '',
        keySource: saved ? 'saved' : (fromEnv ? 'env' : 'none'),
        keyHint: mask(saved || fromEnv),
        docsUrl: provider.docsUrl,
      };
    });
    return {
      transcription: {
        provider: resolved.providerId,
        providers,
        keyterms: resolved.keyterms,
        keytermsSource: data.transcription.keyterms ? 'saved' : 'env',
      },
      summary: {
        provider: summary.providerId,
        providers: this.summaryProviders.list().map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          available: item.available(),
        })),
        prompt: summary.prompt,
        promptIsDefault: !data.summary.prompt,
        defaultPrompt: DEFAULT_SUMMARY_PROMPT,
        autoAfterTranscript: summary.autoAfterTranscript,
      },
      updatedAt: data.updatedAt,
    };
  }

  /**
   * Apply a partial update from the settings page. Unknown fields are
   * ignored. Keys: a string sets the key, null clears the saved key (falls
   * back to the environment), a missing field leaves it alone.
   */
  async update(input = {}) {
    const data = await this.load();
    const next = structuredClone(data);
    const transcription = input.transcription ?? {};
    const summary = input.summary ?? {};

    if (transcription.provider !== undefined) {
      if (!this.providers.has(transcription.provider)) throw new SettingsError('不支持的转写服务。', 'provider');
      next.transcription.provider = transcription.provider;
    }
    if (transcription.keys && typeof transcription.keys === 'object') {
      for (const [id, value] of Object.entries(transcription.keys)) {
        if (!this.providers.has(id)) throw new SettingsError('不支持的转写服务。', `keys.${id}`);
        if (value === null || value === '') {
          delete next.transcription.keys[id];
          continue;
        }
        const key = String(value).trim();
        if (!KEY_PATTERN.test(key)) throw new SettingsError('API Key 格式不正确（8–256 个可见字符，不含空格）。', `keys.${id}`);
        next.transcription.keys[id] = key;
      }
    }
    if (transcription.models && typeof transcription.models === 'object') {
      for (const [id, value] of Object.entries(transcription.models)) {
        if (!this.providers.has(id)) throw new SettingsError('不支持的转写服务。', `models.${id}`);
        if (value === null || value === '') {
          delete next.transcription.models[id];
          continue;
        }
        const model = String(value).trim();
        if (!MODEL_PATTERN.test(model)) throw new SettingsError('模型名称不正确。', `models.${id}`);
        next.transcription.models[id] = model;
      }
    }
    if (transcription.keyterms !== undefined) {
      next.transcription.keyterms = transcription.keyterms === null ? null : cleanKeyterms(transcription.keyterms);
    }

    if (summary.provider !== undefined) {
      if (!this.summaryProviders.has(summary.provider)) throw new SettingsError('不支持的纪要服务。', 'summary.provider');
      next.summary.provider = summary.provider;
    }
    if (summary.prompt !== undefined) {
      if (summary.prompt === null || String(summary.prompt).trim() === '') {
        next.summary.prompt = null;
      } else {
        const prompt = String(summary.prompt).replace(/\r\n/g, '\n').trim();
        if (prompt.length > MAX_PROMPT) throw new SettingsError(`提示词不能超过 ${MAX_PROMPT} 字。`, 'summary.prompt');
        next.summary.prompt = prompt;
      }
    }
    if (summary.autoAfterTranscript !== undefined) {
      next.summary.autoAfterTranscript = Boolean(summary.autoAfterTranscript);
    }

    // Only adopt the new settings once they are on disk.
    await this.save(next);
    this.data = next;
    return this.public();
  }
}
