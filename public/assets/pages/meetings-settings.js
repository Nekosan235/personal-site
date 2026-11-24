import { apiRequest, ApiError } from '../components/api.js?v=1.7.0';
import { element, internalLink, pageHeading } from '../components/dom.js?v=1.4.0';

const KEY_SOURCE_LABEL = {
  saved: '已在本页保存',
  env: '来自服务器环境变量',
  none: '未配置',
};

/**
 * Build the PUT body from the form state. Pure so it can be tested without a
 * DOM. Only fields the user touched are sent; an empty key input means "keep
 * the current key", the explicit clear checkbox means "drop the saved key".
 */
export function settingsPayload(form) {
  const body = { transcription: {}, summary: {} };
  if (form.provider) body.transcription.provider = form.provider;
  const keys = {};
  for (const [id, entry] of Object.entries(form.keys ?? {})) {
    if (entry?.clear) keys[id] = null;
    else if (entry?.value && entry.value.trim()) keys[id] = entry.value.trim();
  }
  if (Object.keys(keys).length) body.transcription.keys = keys;
  const models = {};
  for (const [id, value] of Object.entries(form.models ?? {})) {
    if (value !== undefined) models[id] = value || null;
  }
  if (Object.keys(models).length) body.transcription.models = models;
  if (form.keyterms !== undefined) {
    body.transcription.keyterms = form.keyterms.trim() ? form.keyterms : null;
  }
  if (form.summaryProvider) body.summary.provider = form.summaryProvider;
  if (form.prompt !== undefined) body.summary.prompt = form.prompt.trim() ? form.prompt : null;
  if (form.autoAfterTranscript !== undefined) body.summary.autoAfterTranscript = Boolean(form.autoAfterTranscript);
  return body;
}

let fieldCounter = 0;
function labelled(text, control, hint) {
  fieldCounter += 1;
  const id = control.id || `ms-field-${fieldCounter}`;
  control.id = id;
  return element('div', { className: 'ms-field' }, [
    element('label', { className: 'form-label', text, attributes: { for: id } }),
    control,
    hint ? element('small', { className: 'ms-hint text-secondary', text: hint }) : null,
  ]);
}

export async function renderMeetingsSettings({ session, signal, flash = '' }) {
  const page = element('div', { className: 'meetings-settings-page page-enter' });
  const notice = element('p', {
    className: 'data-notice',
    attributes: { hidden: '', role: 'status', 'aria-live': 'polite' },
  });
  const form = element('form', { className: 'ms-form', attributes: { novalidate: '' } });
  page.append(
    pageHeading(
      '会议记录设置',
      'API Key 只保存在服务器上，页面只显示末四位。留空的项沿用服务器环境变量。',
      internalLink('/meetings', '← 返回会议记录', 'btn btn-outline-secondary'),
    ),
    notice,
    form,
  );

  function showNotice(message, tone = 'info') {
    notice.textContent = message;
    notice.dataset.tone = tone;
    notice.hidden = !message;
  }

  if (flash) showNotice(flash);

  let data;
  try {
    data = (await apiRequest('/api/meetings/settings', { signal })).settings;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return page;
    showNotice('暂时无法读取设置，请稍后刷新。', 'error');
    return page;
  }

  // ── transcription ──────────────────────────────────────────────────────
  const providerSelect = element('select', { className: 'form-select', attributes: { name: 'provider' } });
  for (const provider of data.transcription.providers) {
    const option = element('option', { text: provider.label, attributes: { value: provider.id } });
    if (provider.id === data.transcription.provider) option.selected = true;
    providerSelect.append(option);
  }

  const providerCards = element('div', { className: 'ms-providers' });
  const keyInputs = new Map();
  const clearBoxes = new Map();
  const modelSelects = new Map();

  for (const provider of data.transcription.providers) {
    const keyInput = element('input', {
      className: 'form-control',
      attributes: {
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: provider.keyHint ? `当前 ${provider.keyHint}，留空不修改` : '粘贴 API Key',
        name: `key-${provider.id}`,
      },
    });
    keyInputs.set(provider.id, keyInput);

    const clear = element('input', { className: 'form-check-input', attributes: { type: 'checkbox', name: `clear-${provider.id}` } });
    clearBoxes.set(provider.id, clear);
    const clearLabel = element('label', { className: 'form-check ms-clear' }, [
      clear,
      element('span', { className: 'form-check-label', text: '清除本页保存的 Key（改用环境变量）' }),
    ]);
    clearLabel.hidden = provider.keySource !== 'saved';

    const modelSelect = element('select', { className: 'form-select', attributes: { name: `model-${provider.id}` } });
    modelSelect.append(element('option', { text: `默认（${provider.defaultModel}）`, attributes: { value: '' } }));
    for (const model of provider.models) {
      const option = element('option', { text: model, attributes: { value: model } });
      if (model === provider.model) option.selected = true;
      modelSelect.append(option);
    }
    modelSelects.set(provider.id, modelSelect);

    const status = element('span', {
      className: `ms-key-status badge ${provider.keySource === 'none' ? 'bg-secondary-lt' : 'bg-green-lt'}`,
      text: `${KEY_SOURCE_LABEL[provider.keySource] ?? ''}${provider.keyHint ? ` · ${provider.keyHint}` : ''}`,
    });

    providerCards.append(element('section', {
      className: 'ms-provider card',
      attributes: { 'data-provider': provider.id, 'data-active': String(provider.id === data.transcription.provider) },
    }, [
      element('div', { className: 'ms-provider-head' }, [
        element('h3', { className: 'ms-provider-title', text: provider.label }),
        status,
      ]),
      element('p', { className: 'ms-provider-desc text-secondary', text: provider.description }),
      labelled('API Key', keyInput),
      clearLabel,
      labelled('模型', modelSelect),
    ]));
  }

  providerSelect.addEventListener('change', () => {
    for (const card of providerCards.children) {
      card.dataset.active = String(card.dataset.provider === providerSelect.value);
    }
  });

  const keyterms = element('textarea', {
    className: 'form-control ms-keyterms',
    attributes: { rows: '4', name: 'keyterms', placeholder: '例如：PG, 产线, 自动化, OEE, 节拍' },
  });
  keyterms.value = (data.transcription.keyterms ?? []).join(', ');

  form.append(element('fieldset', { className: 'ms-section card' }, [
    element('legend', { className: 'ms-section-title', text: '转写服务' }),
    labelled('当前使用', providerSelect, '切换后从下一条转写开始生效，正在转写的不受影响。'),
    providerCards,
    labelled('专有名词（keyterms）', keyterms, '逗号或换行分隔，最多 400 个。会传给支持的服务以提高命中率；留空沿用环境变量 MEETINGS_KEYTERMS。'),
  ]));

  // ── summary ────────────────────────────────────────────────────────────
  const summarySelect = element('select', { className: 'form-select', attributes: { name: 'summaryProvider' } });
  for (const provider of data.summary.providers) {
    const label = provider.id === 'disabled' || provider.available ? provider.label : `${provider.label}（服务器未配置）`;
    const option = element('option', { text: label, attributes: { value: provider.id } });
    if (provider.id === data.summary.provider) option.selected = true;
    summarySelect.append(option);
  }
  const summaryHint = element('small', { className: 'ms-hint text-secondary' });
  function updateSummaryHint() {
    const provider = data.summary.providers.find((item) => item.id === summarySelect.value);
    summaryHint.textContent = provider
      ? `${provider.description}${provider.id !== 'disabled' && !provider.available ? ' 需要管理员在服务器 site.env 里配置后才能使用。' : ''}`
      : '';
  }
  summarySelect.addEventListener('change', updateSummaryHint);
  updateSummaryHint();

  const prompt = element('textarea', {
    className: 'form-control ms-prompt',
    attributes: { rows: '12', name: 'prompt', maxlength: '8000' },
  });
  prompt.value = data.summary.prompt;
  const resetPrompt = element('button', {
    className: 'btn btn-sm btn-outline-secondary',
    text: '恢复默认提示词',
    attributes: { type: 'button' },
  });
  resetPrompt.addEventListener('click', () => { prompt.value = data.summary.defaultPrompt; });

  const auto = element('input', { className: 'form-check-input', attributes: { type: 'checkbox', name: 'autoAfterTranscript' } });
  auto.checked = Boolean(data.summary.autoAfterTranscript);

  form.append(element('fieldset', { className: 'ms-section card' }, [
    element('legend', { className: 'ms-section-title', text: '会议纪要（Codex）' }),
    labelled('纪要服务', summarySelect),
    summaryHint,
    labelled('提示词', prompt, '会与会议信息和完整转写稿一起发给 Codex。'),
    element('div', { className: 'ms-row' }, [resetPrompt]),
    element('label', { className: 'form-check' }, [
      auto,
      element('span', { className: 'form-check-label', text: '转写完成后自动生成纪要' }),
    ]),
  ]));

  // ── save ───────────────────────────────────────────────────────────────
  const save = element('button', { className: 'btn btn-primary', text: '保存设置', attributes: { type: 'submit' } });
  form.append(element('div', { className: 'ms-actions' }, [save]));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = {
      provider: providerSelect.value,
      keys: Object.fromEntries([...keyInputs].map(([id, input]) => [id, { value: input.value, clear: clearBoxes.get(id).checked }])),
      models: Object.fromEntries([...modelSelects].map(([id, select]) => [id, select.value])),
      keyterms: keyterms.value,
      summaryProvider: summarySelect.value,
      prompt: prompt.value === data.summary.defaultPrompt ? '' : prompt.value,
      autoAfterTranscript: auto.checked,
    };
    save.disabled = true;
    save.textContent = '正在保存…';
    try {
      const result = await apiRequest('/api/meetings/settings', {
        method: 'PUT',
        csrfToken: session.csrfToken,
        body: settingsPayload(state),
        signal,
      });
      data = result.settings;
      // Re-render so key status badges reflect the saved state.
      const fresh = await renderMeetingsSettings({ session, signal, flash: '设置已保存，从下一条转写开始生效。' });
      page.replaceWith(fresh);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      showNotice(error?.message || '保存失败，请稍后重试。', 'error');
    } finally {
      save.disabled = false;
      save.textContent = '保存设置';
    }
  });

  return page;
}
