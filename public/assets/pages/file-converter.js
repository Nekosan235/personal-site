import { element, internalLink, pageHeading, statusBadge } from '../components/dom.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.6.0';
import { DATA_CONVERSIONS, convertData, decodeBase64, encodeBase64 } from '../components/format-convert/data.js?v=1.6.0';
import { IMAGE_TARGETS, TEXT_CASES, TEXT_NEWLINES, TEXT_SPACES, UNAVAILABLE_CONVERTERS } from '../components/format-convert/catalog.js?v=1.6.0';
import { convertImageFile } from '../components/format-convert/image-browser.js?v=1.6.0';
import { LIMITS } from '../components/format-convert/limits.js?v=1.6.0';
import { downloadName } from '../components/format-convert/images.js?v=1.6.0';
import { markdownToHtmlDocument, previewPlain } from '../components/format-convert/markdown.js?v=1.6.0';
import { transformText } from '../components/format-convert/text.js?v=1.6.0';

const CATEGORIES = [
  ['image', '图片'],
  ['document', '文档'],
  ['data', '数据'],
  ['text', '文本'],
  ['unavailable', '暂不可用'],
];

function button(text, className, attributes = {}) {
  return element('button', { className, text, attributes: { type: 'button', ...attributes } });
}

function select(label, options, value) {
  const control = element('select', { className: 'form-select', attributes: { 'aria-label': label } }, options.map((item) => (
    element('option', { text: item.label, attributes: { value: item.id } })
  )));
  control.value = value;
  return control;
}

function field(label, control, hint) {
  return element('label', { className: 'converter-field' }, [
    element('span', { className: 'form-label', text: label }),
    control,
    hint ? element('span', { className: 'form-hint', text: hint }) : null,
  ]);
}

function filePicker(accept, label) {
  const input = element('input', {
    className: 'editor-file-input',
    attributes: { type: 'file', accept, 'aria-label': label },
  });
  const picker = element('label', { className: 'btn btn-outline-primary btn-sm editor-file-label' }, [
    input,
    element('span', { text: label }),
  ]);
  return { input, picker };
}

export function renderFileConverter({ module, signal }) {
  const page = element('div', { className: 'converter-page page-enter' });
  const panels = new Map();
  const tabs = element('div', { className: 'converter-nav', attributes: { role: 'tablist', 'aria-label': '转换类型' } });
  let active = 'image';
  const urls = new Set();
  const on = (node, type, listener) => node.addEventListener(type, listener, { signal });

  function remember(url) {
    urls.add(url);
    return url;
  }
  function revoke(url) {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.delete(url);
  }
  on(signal, 'abort', () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  });

  function showCategory(id) {
    active = id;
    for (const [key, panel] of panels) {
      panel.hidden = key !== id;
      const tab = tabs.querySelector(`[data-category="${key}"]`);
      const selected = key === id;
      tab.classList.toggle('active', selected);
      tab.classList.toggle('btn-primary', selected);
      tab.classList.toggle('btn-outline-secondary', !selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
  }

  for (const [id, label] of CATEGORIES) {
    const tab = button(label, `btn btn-sm converter-tab ${id === active ? 'btn-primary active' : 'btn-outline-secondary'}`, {
      role: 'tab',
      'data-category': id,
      'aria-selected': String(id === active),
      'aria-controls': `converter-${id}`,
      tabindex: id === active ? '0' : '-1',
    });
    on(tab, 'click', () => showCategory(id));
    tabs.append(tab);
  }

  panels.set('image', imagePanel());
  panels.set('document', documentPanel());
  panels.set('data', dataPanel());
  panels.set('text', textPanel());
  panels.set('unavailable', unavailablePanel());
  showCategory('image');

  page.append(
    internalLink('/tools', '← 工具箱', 'text-link back-link'),
    pageHeading(module?.title || '格式转换', '在浏览器本地转换常见图片、文档、数据和文本。文件不会上传，也不会向远程地址发起请求。', statusBadge(module?.status || 'ready')),
    tabs,
    ...panels.values(),
  );
  return page;

  function statusLine() {
    return element('p', {
      className: 'editor-status alert alert-info',
      attributes: { role: 'status', 'aria-live': 'polite' },
      text: '选择文件或贴上文本后开始转换。',
    });
  }
  function progressLine() {
    return element('progress', { className: 'editor-progress', attributes: { max: '1', value: '0', hidden: '' } });
  }
  function setStatus(node, message, tone = 'info') {
    node.className = `editor-status alert alert-${tone}`;
    node.textContent = message;
  }
  function setBusy(root, busy, progress) {
    root.toggleAttribute('aria-busy', busy);
    progress.hidden = !busy;
    if (!busy) progress.value = 0;
    for (const control of root.querySelectorAll('button, input, select, textarea')) {
      if (control.dataset.locked === 'true') continue;
      control.disabled = busy;
    }
  }
  async function guard(root, progress, status, task) {
    const job = Number(root.dataset.job || 0) + 1;
    root.dataset.job = String(job);
    const current = () => root.dataset.job === String(job) && !signal.aborted;
    setBusy(root, true, progress);
    progress.value = 0.08;
    try {
      await task(current, (value) => {
        if (current()) progress.value = value;
      });
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      setStatus(status, error.message || '转换失败。', 'danger');
    } finally {
      if (current()) setBusy(root, false, progress);
    }
  }
  function saveResult(download, holder, result) {
    revoke(holder.url);
    holder.blob = result.blob;
    holder.filename = result.filename;
    holder.url = result.previewUrl || '';
    if (holder.url) remember(holder.url);
    download.disabled = !result.blob;
    if (result.blob) delete download.dataset.locked;
    else download.dataset.locked = 'true';
  }
  function bindDownload(download, holder) {
    download.dataset.locked = 'true';
    on(download, 'click', () => {
      if (!holder.blob) return;
      const url = URL.createObjectURL(holder.blob);
      const link = element('a', { attributes: { href: url, download: holder.filename } });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  }
  function bindDrop(zone, onFile) {
    on(zone, 'dragover', (event) => {
      event.preventDefault();
      zone.classList.add('is-drop-target');
    });
    on(zone, 'dragleave', () => zone.classList.remove('is-drop-target'));
    on(zone, 'drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-drop-target');
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    });
  }
  async function readTextFile(file) {
    if (!file) return '';
    if (file.size > LIMITS.textBytes) throw new Error('文本不能超过 1 MB。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('文件不是 UTF-8 文本。');
    }
  }

  function imagePanel() {
    const picker = filePicker('image/png,image/jpeg,image/webp,image/gif,.svg,image/svg+xml', '选择图片');
    const target = select('目标格式', IMAGE_TARGETS, 'png');
    const quality = element('input', { className: 'form-range', attributes: { type: 'range', min: '50', max: '95', value: '92', 'aria-label': '画质' } });
    const qualityValue = element('output', { className: 'editor-range-value', text: '92' });
    const qualityField = field('画质', element('div', { className: 'converter-inline' }, [quality, qualityValue]), '只影响 JPG 和 WebP。');
    const empty = element('div', { className: 'editor-empty' }, [
      element('span', { className: 'editor-empty-icon', text: 'IMG' }),
      element('strong', { text: '拖入图片，或点击选择' }),
      element('span', { text: '支持 PNG、JPG、WebP、GIF 和安全的 SVG。文件只在浏览器中处理。' }),
    ]);
    const preview = element('img', { className: 'converter-preview-image', attributes: { alt: '', hidden: '' } });
    const stage = element('div', { className: 'editor-stage converter-stage', attributes: { tabindex: '0', 'aria-label': '图片拖放区域' } }, [empty, preview]);
    const status = statusLine();
    const progress = progressLine();
    const convert = button('转换图片', 'btn btn-primary converter-run', { disabled: '', 'data-locked': 'true' });
    const download = button('下载结果', 'btn btn-outline-primary', { disabled: '' });
    const holder = { blob: null, filename: '', url: '' };
    const chosen = { file: null };
    setStatus(status, '支持 PNG、JPG、WebP、静态 GIF 和安全的 SVG。动态 GIF 只保留第一帧。');
    const syncQuality = () => { qualityField.hidden = target.value !== 'jpg' && target.value !== 'webp'; };
    syncQuality();
    const useFile = (file) => {
      chosen.file = file;
      convert.disabled = !file;
      if (file) delete convert.dataset.locked;
      else convert.dataset.locked = 'true';
      setStatus(status, file ? `已选择 ${file.name}。选择目标格式后转换。` : '请选择图片。');
    };
    on(picker.input, 'change', () => useFile(picker.input.files?.[0] || null));
    on(target, 'change', syncQuality);
    on(quality, 'input', () => { qualityValue.textContent = quality.value; });
    bindDrop(stage, useFile);
    bindDownload(download, holder);
    on(convert, 'click', () => guard(panel, progress, status, async (current, report) => {
      const result = await convertImageFile(chosen.file, target.value, {
        quality: Number(quality.value) / 100,
        signal,
        onProgress: report,
      });
      if (!current()) return;
      revoke(holder.url);
      const previewUrl = URL.createObjectURL(result.blob);
      preview.src = previewUrl;
      preview.hidden = false;
      preview.alt = `转换为 ${result.extension.toUpperCase()} 的预览`;
      empty.hidden = true;
      saveResult(download, holder, {
        blob: result.blob,
        filename: downloadName(chosen.file.name, result.extension),
        previewUrl,
      });
      const notes = ['转换完成，可以下载。'];
      if (result.animated) notes.push('动图只保留了第一帧。');
      if (result.scaled) notes.push(`已缩小到 ${result.width}×${result.height}。`);
      if (target.value === 'jpg') notes.push('透明区域已铺成白色。');
      setStatus(status, notes.join(''), 'success');
    }));
    const panel = element('section', { className: 'converter-layout', attributes: { id: 'converter-image', role: 'tabpanel' } }, [
      element('section', { className: 'card' }, [
        element('div', { className: 'card-header editor-card-header' }, [
          element('h2', { className: 'card-title', text: '图片预览' }),
          picker.picker,
        ]),
        stage,
        element('div', { className: 'card-footer text-secondary', text: '不读取远程地址。含脚本、外链或嵌入对象的 SVG 会被拒绝。' }),
      ]),
      element('section', { className: 'card' }, [
        element('div', { className: 'card-body converter-controls' }, [
          field('目标格式', target, 'GIF 导出为单帧。'),
          qualityField,
          convert,
          download,
          progress,
          status,
        ]),
      ]),
    ]);
    return panel;
  }

  function documentPanel() {
    const picker = filePicker('.md,.markdown,.txt,text/plain,text/markdown', '选择文档');
    const input = element('textarea', { className: 'form-control converter-text', attributes: { rows: '12', 'aria-label': 'Markdown 或纯文本', placeholder: '在这里贴上 Markdown 或纯文本' } });
    const preview = element('pre', { className: 'converter-preview', text: '预览会显示在这里。HTML 只作为源码展示，不会在页面里执行。' });
    const status = statusLine();
    const progress = progressLine();
    const plain = button('预览纯文本', 'btn btn-outline-secondary');
    const html = button('转为 HTML', 'btn btn-primary converter-run');
    const clear = button('改用文本框', 'btn btn-outline-secondary', { disabled: '', 'data-locked': 'true' });
    const download = button('下载结果', 'btn btn-outline-primary', { disabled: '' });
    const holder = { blob: null, filename: '', url: '' };
    const chosen = { file: null, name: 'document.md' };
    setStatus(status, 'Markdown 转为转义后的 HTML。纯文本预览不会解释标记。');
    bindDownload(download, holder);
    const source = async () => chosen.file ? readTextFile(chosen.file) : input.value;
    const publish = (current, text, filename, mime, message) => {
      if (!current()) return;
      preview.textContent = text;
      saveResult(download, holder, { blob: new Blob([text], { type: mime }), filename });
      setStatus(status, message, 'success');
    };
    const useFile = (file) => {
      chosen.file = file;
      chosen.name = file?.name || 'document.md';
      clear.disabled = !file;
      if (file) delete clear.dataset.locked;
      else clear.dataset.locked = 'true';
      setStatus(status, file ? `已选择 ${file.name}。文件优先于文本框。` : '已改回文本框里的内容。');
    };
    on(picker.input, 'change', () => useFile(picker.input.files?.[0] || null));
    on(clear, 'click', () => {
      picker.input.value = '';
      useFile(null);
    });
    bindDrop(input, useFile);
    on(plain, 'click', () => guard(panel, progress, status, async (current, report) => {
      report(0.45);
      const text = previewPlain(await source());
      report(1);
      publish(current, text, downloadName(chosen.name, 'txt'), 'text/plain;charset=utf-8', '纯文本预览已更新，可以下载。');
    }));
    on(html, 'click', () => guard(panel, progress, status, async (current, report) => {
      report(0.45);
      const text = markdownToHtmlDocument(await source());
      report(1);
      publish(current, text, downloadName(chosen.name, 'html'), 'text/html;charset=utf-8', 'HTML 已生成。预览是源码，下载后用浏览器打开。');
    }));
    const panel = element('section', { className: 'converter-layout', attributes: { id: 'converter-document', role: 'tabpanel' } }, [
      element('section', { className: 'card' }, [
        element('div', { className: 'card-header editor-card-header' }, [
          element('h2', { className: 'card-title', text: '文档' }),
          picker.picker,
        ]),
        element('div', { className: 'card-body' }, [input, preview]),
      ]),
      element('section', { className: 'card' }, [
        element('div', { className: 'card-body converter-controls' }, [
          element('p', { className: 'form-hint', text: '选择文件后优先使用文件。文本上限 1 MB。' }),
          clear,
          plain,
          html,
          download,
          progress,
          status,
        ]),
      ]),
    ]);
    return panel;
  }

  function dataPanel() {
    const picker = filePicker('.json,.yaml,.yml,.csv,.txt,.b64,application/json,text/csv,text/plain', '选择文件');
    const operation = select('转换', DATA_CONVERSIONS, 'json-yaml');
    const input = element('textarea', { className: 'form-control converter-text', attributes: { rows: '12', 'aria-label': '待转换数据', placeholder: '贴上 JSON、YAML、CSV、Base64 或 URL 文本' } });
    const preview = element('pre', { className: 'converter-preview', text: '转换结果会显示在这里。' });
    const status = statusLine();
    const progress = progressLine();
    const convert = button('转换数据', 'btn btn-primary converter-run');
    const clear = button('改用文本框', 'btn btn-outline-secondary', { disabled: '', 'data-locked': 'true' });
    const download = button('下载结果', 'btn btn-outline-primary', { disabled: '' });
    const holder = { blob: null, filename: '', url: '' };
    const chosen = { file: null };
    setStatus(status, 'JSON、YAML、CSV、Base64 和 URL 编解码都在本地完成。');
    bindDownload(download, holder);
    const useFile = (file) => {
      chosen.file = file;
      clear.disabled = !file;
      if (file) delete clear.dataset.locked;
      else clear.dataset.locked = 'true';
      setStatus(status, file ? `已选择 ${file.name}。文件优先于文本框。` : '已改回文本框里的内容。');
    };
    on(picker.input, 'change', () => useFile(picker.input.files?.[0] || null));
    on(clear, 'click', () => {
      picker.input.value = '';
      useFile(null);
    });
    bindDrop(input, useFile);
    on(convert, 'click', () => guard(panel, progress, status, async (current, report) => {
      report(0.4);
      const id = operation.value;
      let payload;
      if (!chosen.file) payload = { text: input.value };
      else if (chosen.file.size > LIMITS.textBytes) throw new Error('文件不能超过 1 MB。');
      else payload = { bytes: new Uint8Array(await chosen.file.arrayBuffer()), name: chosen.file.name };
      const converted = payload.bytes && id === 'base64-encode'
        ? { text: `${encodeBase64(payload.bytes)}\n`, extension: 'txt', mime: 'text/plain;charset=utf-8' }
        : await dataResult(id, payload);
      if (!current()) return;
      report(1);
      preview.textContent = converted.binary ? '结果是二进制，页面不展示内容。请下载文件。' : converted.text;
      const filename = downloadName(chosen.file?.name || `converted.${converted.extension}`, converted.extension);
      saveResult(download, holder, {
        blob: converted.binary ? converted.blob : new Blob([converted.text], { type: converted.mime }),
        filename,
      });
      setStatus(status, converted.binary ? '已解码为二进制文件，可以下载。' : '转换完成，可以下载。', 'success');
    }));
    const panel = element('section', { className: 'converter-layout', attributes: { id: 'converter-data', role: 'tabpanel' } }, [
      element('section', { className: 'card' }, [
        element('div', { className: 'card-header editor-card-header' }, [
          element('h2', { className: 'card-title', text: '数据' }),
          picker.picker,
        ]),
        element('div', { className: 'card-body' }, [input, preview]),
      ]),
      element('section', { className: 'card' }, [
        element('div', { className: 'card-body converter-controls' }, [
          field('转换', operation, 'YAML 使用空格缩进，不支持锚点、标签和多行文本块。CSV 第一行是表头，字段保持文本。'),
          clear,
          convert,
          download,
          progress,
          status,
        ]),
      ]),
    ]);
    return panel;
  }

  function textPanel() {
    const picker = filePicker('.txt,text/plain', '选择文本');
    const input = element('textarea', { className: 'form-control converter-text', attributes: { rows: '12', 'aria-label': '待整理文本', placeholder: '贴上需要整理的文本' } });
    const preview = element('pre', { className: 'converter-preview', text: '整理结果会显示在这里。' });
    const letter = select('大小写', TEXT_CASES, 'keep');
    const space = select('空白', TEXT_SPACES, 'trim');
    const newline = select('换行', TEXT_NEWLINES, 'lf');
    const status = statusLine();
    const progress = progressLine();
    const convert = button('整理文本', 'btn btn-primary converter-run');
    const clear = button('改用文本框', 'btn btn-outline-secondary', { disabled: '', 'data-locked': 'true' });
    const download = button('下载结果', 'btn btn-outline-primary', { disabled: '' });
    const holder = { blob: null, filename: '', url: '' };
    const chosen = { file: null };
    setStatus(status, '按换行、空白、大小写的顺序处理。大小写规则面向拉丁字母。');
    bindDownload(download, holder);
    const useFile = (file) => {
      chosen.file = file;
      clear.disabled = !file;
      if (file) delete clear.dataset.locked;
      else clear.dataset.locked = 'true';
      setStatus(status, file ? `已选择 ${file.name}。文件优先于文本框。` : '已改回文本框里的内容。');
    };
    on(picker.input, 'change', () => useFile(picker.input.files?.[0] || null));
    on(clear, 'click', () => {
      picker.input.value = '';
      useFile(null);
    });
    bindDrop(input, useFile);
    on(convert, 'click', () => guard(panel, progress, status, async (current, report) => {
      report(0.45);
      const text = transformText(chosen.file ? await readTextFile(chosen.file) : input.value, {
        letter: letter.value,
        space: space.value,
        newline: newline.value,
      });
      if (!current()) return;
      report(1);
      preview.textContent = text;
      saveResult(download, holder, {
        blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
        filename: downloadName(chosen.file?.name || 'text.txt', 'txt'),
      });
      setStatus(status, '文本已整理，可以下载。', 'success');
    }));
    const panel = element('section', { className: 'converter-layout', attributes: { id: 'converter-text', role: 'tabpanel' } }, [
      element('section', { className: 'card' }, [
        element('div', { className: 'card-header editor-card-header' }, [
          element('h2', { className: 'card-title', text: '文本' }),
          picker.picker,
        ]),
        element('div', { className: 'card-body' }, [input, preview]),
      ]),
      element('section', { className: 'card' }, [
        element('div', { className: 'card-body converter-controls' }, [
          field('大小写', letter),
          field('空白', space),
          field('换行', newline),
          clear,
          convert,
          download,
          progress,
          status,
        ]),
      ]),
    ]);
    return panel;
  }

  function unavailablePanel() {
    const list = element('div', { className: 'converter-unavailable' });
    for (const item of UNAVAILABLE_CONVERTERS) {
      list.append(element('section', { className: 'card' }, [
        element('div', { className: 'card-body' }, [
          element('h2', { className: 'card-title', text: item.title }),
          element('p', { className: 'text-secondary mb-0', text: item.reason }),
        ]),
      ]));
    }
    return element('section', {
      className: 'converter-unavailable-panel',
      attributes: { id: 'converter-unavailable', role: 'tabpanel' },
    }, [
      element('div', { className: 'converter-unavailable-head' }, [
        icon('unavailable', 'icon'),
        element('p', { text: '这些转换没有放进当前工具。页面不会为此调用系统命令，也不会把文件上传到服务器。' }),
      ]),
      list,
    ]);
  }

  async function dataResult(id, payload) {
    if (!payload.bytes) {
      if (id !== 'base64-decode') return convertData(id, payload.text);
      try {
        return convertData(id, payload.text);
      } catch (error) {
        if (error.message !== 'Base64 解码结果不是 UTF-8 文本。') throw error;
        return { binary: true, blob: new Blob([decodeBase64(payload.text)], { type: 'application/octet-stream' }), extension: 'bin' };
      }
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload.bytes);
    } catch {
      throw new Error('文件不是 UTF-8 文本。Base64 编码可以直接选择这个文件。');
    }
    if (id !== 'base64-decode') return convertData(id, text);
    try {
      return convertData(id, text);
    } catch (error) {
      if (error.message !== 'Base64 解码结果不是 UTF-8 文本。') throw error;
      return { binary: true, blob: new Blob([decodeBase64(text)], { type: 'application/octet-stream' }), extension: 'bin' };
    }
  }
}
