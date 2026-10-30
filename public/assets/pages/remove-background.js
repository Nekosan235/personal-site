import { apiRequest, ApiError } from '../components/api.js?v=1.7.0';
import { element } from '../components/dom.js?v=1.4.0';
import { createWorkbench } from '../components/image-tools/editor-ui.js?v=1.5.0';
import { createImageWorker } from '../components/image-tools/worker-client.js?v=1.4.0';
import { clampZoom } from '../components/image-tools/editor-view.js?v=1.4.0';
import { inspectImageFile } from '../components/image-tools/image-file.js?v=1.4.0';
import { renderEditedFrame } from '../components/image-tools/frame-editor.js?v=1.4.0';
import { IMPORT_LIMIT, materializeImport, mediaImportHandoff } from '../components/import-handoff.js?v=1.9.0';

const MAX_EDGE = 2048;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MODELS = [
  ['u2netp', 'u2netp · 更快'],
  ['isnet-general-use', 'isnet · 通用'],
  ['birefnet-general-lite', 'birefnet 轻量 · 推荐'],
  ['birefnet-portrait', 'birefnet · 人像'],
];
const REFINES = [
  ['none', '不精修'],
  ['dc', '去色边'],
  ['alpha', '精细蒙版'],
  ['vitmatte', 'ViTMatte 精修'],
];
const REFINE_HINT = {
  none: '只用模型给出的蒙版。',
  dc: '去掉边缘上残留的背景色，速度接近不精修。',
  alpha: '重算发丝这类柔边，会更慢。',
  vitmatte: '再用一套模型修柔边，最慢。',
};

export function renderRemoveBackground({ signal, session }) {
  const pendingImport = mediaImportHandoff.take();
  const ui = createWorkbench({
    kind: 'image',
    title: '图片去白底',
    description: '本地去掉白色背景，或切换到智能抠图。可一次导入多张。',
  });
  const worker = createImageWorker(signal);
  const queue = [];
  const state = {
    source: null,
    result: null,
    matte: null,
    width: 0,
    height: 0,
    strokes: [],
    tool: 'erase',
    preview: 'result',
    job: 0,
    timer: null,
    zoom: 1,
    activeId: null,
    cutout: pendingImport.ok && pendingImport.record.mode === 'smart' ? 'smart' : 'white',
    model: 'birefnet-general-lite',
    refine: 'none',
  };
  const on = (node, type, listener) => node.addEventListener(type, listener, { signal });
  const whiteGroup = ui.page.querySelector('.editor-control-group');
  const privacy = ui.page.querySelector('.editor-privacy-note span');
  const modeButtons = new Map();
  const modeSwitch = element('div', { className: 'editor-mode-switch', attributes: { role: 'group', 'aria-label': '处理方式' } });
  for (const [value, label] of [['white', '去白底'], ['smart', '智能抠图']]) {
    const control = element('button', {
      className: 'btn',
      text: label,
      attributes: { type: 'button', 'data-control': '', 'data-cutout': value },
    });
    modeButtons.set(value, control);
    modeSwitch.append(control);
    on(control, 'click', () => setCutoutMode(value));
  }
  const modelSelect = element('select', { className: 'form-select', attributes: { 'aria-label': '抠图模型', 'data-control': '' } }, MODELS.map(([value, label]) => element('option', { text: label, attributes: { value, ...(value === state.model ? { selected: '' } : {}) } })));
  const refineSelect = element('select', { className: 'form-select', attributes: { 'aria-label': '精修', 'data-control': '' } }, REFINES.map(([value, label]) => element('option', { text: label, attributes: { value } })));
  const refineHint = element('p', { className: 'form-hint', text: REFINE_HINT.none });
  const health = element('p', { className: 'editor-matting-health', attributes: { role: 'status' }, text: '正在检查抠图服务…' });
  const smartPanel = element('section', { className: 'editor-smart-panel', attributes: { hidden: '' } }, [
    element('label', { className: 'form-label', text: '抠图模型' }),
    modelSelect,
    element('label', { className: 'form-label', text: '精修' }),
    refineSelect,
    refineHint,
    element('p', { className: 'form-hint', text: '一次只提交一张。多图会排队，不会同时发给抠图服务。' }),
    health,
  ]);
  const queueBar = element('div', { className: 'editor-queue', attributes: { role: 'list', 'aria-label': '已导入的图片', hidden: '' } });
  const batch = element('button', {
    className: 'btn btn-outline-primary editor-batch',
    text: '全部去白并保存',
    attributes: { type: 'button', 'data-control': '', disabled: '' },
  });
  ui.stage.before(queueBar);
  const controlsBody = ui.page.querySelector('.editor-controls-body');
  controlsBody.prepend(smartPanel);
  controlsBody.prepend(modeSwitch);
  ui.exportButton.before(batch);

  const paint = () => {
    if (!state.source || !state.result) return;
    ui.draw(state.preview === 'original' ? state.source : state.result, state.width, state.height);
  };
  const settings = () => ({ tolerance: Number(ui.tolerance.value), mode: ui.mode.value, feather: 12 });
  const releaseBusy = (job) => {
    if (job === state.job && !signal.aborted) ui.setBusy(false);
    ui.undo.disabled = state.strokes.length === 0;
    syncControls();
  };

  function syncControls() {
    const smart = state.cutout === 'smart';
    if (whiteGroup) whiteGroup.hidden = smart;
    smartPanel.hidden = !smart;
    for (const [key, control] of modeButtons) {
      const active = key === state.cutout;
      control.classList.toggle('btn-primary', active);
      control.classList.toggle('btn-outline-secondary', !active);
      control.setAttribute('aria-pressed', String(active));
    }
    batch.textContent = smart ? '全部抠图并保存' : '全部去白并保存';
    if (!ui.page.hasAttribute('aria-busy')) batch.disabled = queue.length === 0;
    refineHint.textContent = REFINE_HINT[state.refine] || REFINE_HINT.none;
    if (privacy) {
      privacy.textContent = smart
        ? '智能抠图会把当前图片经本站交给抠图服务，一次一张。去白底仍只在本地处理。'
        : '去白底只在这台设备上处理，不会上传。最多 10 MB，长边缩至 2048 像素。';
    }
  }

  function setCutoutMode(next, { process = true } = {}) {
    if (next !== 'white' && next !== 'smart') return;
    if (state.cutout === next) {
      syncControls();
      return;
    }
    state.cutout = next;
    syncControls();
    if (process && state.source) void runActive();
  }

  function rememberStrokes() {
    const item = queue.find((entry) => entry.id === state.activeId);
    if (!item) return;
    item.strokes = state.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
      color: stroke.color ? [...stroke.color] : undefined,
    }));
  }

  function paintQueue() {
    queueBar.hidden = queue.length === 0;
    queueBar.replaceChildren();
    queue.forEach((item, index) => {
      const busy = ui.page.hasAttribute('aria-busy');
      const select = element('button', {
        className: 'editor-queue-select',
        attributes: {
          type: 'button',
          'aria-pressed': item.id === state.activeId ? 'true' : 'false',
          'aria-label': `编辑第 ${index + 1} 张 ${item.name}`,
          ...(busy ? { disabled: '' } : {}),
        },
      }, [
        item.thumbUrl
          ? element('img', { attributes: { src: item.thumbUrl, alt: '' } })
          : element('span', { className: 'editor-queue-fallback', text: '无预览' }),
        element('span', { className: 'editor-queue-name', text: item.name }),
        element('span', { className: 'editor-queue-state', text: statusLabel(item) }),
      ]);
      const remove = element('button', {
        className: 'btn btn-outline-secondary editor-queue-remove',
        text: '移除',
        attributes: { type: 'button', 'data-control': '', 'aria-label': `移除第 ${index + 1} 张`, ...(busy ? { disabled: '' } : {}) },
      });
      on(select, 'click', () => { void openItem(item.id); });
      on(remove, 'click', () => removeItem(item.id));
      const card = element('div', { className: `editor-queue-card${item.status === 'failed' ? ' is-failed' : ''}`, attributes: { role: 'listitem' } }, [select, remove]);
      queueBar.append(card);
    });
    syncControls();
  }

  function statusLabel(item) {
    if (item.status === 'failed') return '失败';
    if (item.status === 'done') return '已处理';
    if (item.status === 'processing') return '处理中';
    return '待处理';
  }

  function renderWhite() {
    if (!state.source || signal.aborted) return;
    clearTimeout(state.timer);
    const job = ++state.job;
    state.timer = setTimeout(async () => {
      ui.setBusy(true);
      ui.setMessage('正在去除白底…');
      try {
        const copy = state.source.slice();
        const result = await worker.request('image', {
          buffer: copy.buffer,
          width: state.width,
          height: state.height,
          settings: settings(),
          strokes: state.strokes,
        }, [copy.buffer]);
        if (job !== state.job || signal.aborted) return;
        state.matte = null;
        state.result = new Uint8ClampedArray(result.result);
        paint();
        const item = queue.find((entry) => entry.id === state.activeId);
        if (item) {
          item.status = 'done';
          item.error = '';
          paintQueue();
        }
        ui.setMessage(`${state.strokes.length} 笔修整已保留；重复调整会从原始像素重新计算。`);
      } catch (error) {
        if (error.name !== 'AbortError') ui.setMessage(error.message, 'danger');
      } finally {
        releaseBusy(job);
      }
    }, 75);
  }

  async function processSmart(job) {
    if (!state.source || signal.aborted) return;
    ui.setBusy(true);
    ui.progress.hidden = false;
    ui.progress.max = 1;
    ui.progress.value = 0;
    ui.setMessage('正在提交智能抠图…');
    const item = queue.find((entry) => entry.id === state.activeId);
    if (item) {
      item.status = 'processing';
      item.error = '';
      paintQueue();
    }
    try {
      const blob = await uploadBlob(state.source, state.width, state.height);
      ui.setMessage(progressLabel());
      const output = await requestMatting(blob);
      if (job !== state.job || signal.aborted) return;
      const matte = await blobToPixels(output, state.width, state.height);
      if (job !== state.job || signal.aborted) return;
      state.matte = matte;
      state.result = renderEditedFrame(matte, state.source, state.width, state.height, state.strokes);
      paint();
      if (item) {
        item.status = 'done';
        item.error = '';
      }
      ui.setMessage('智能抠图完成。画笔只改这一张，不会重新上传。', 'success');
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) return;
      const message = error.message || '智能抠图失败。';
      const text = message.includes('去白底') ? message : `${message} 可改用「去白底」。`;
      if (item) {
        item.status = 'failed';
        item.error = message;
      }
      ui.setMessage(text, 'danger');
    } finally {
      ui.progress.hidden = true;
      paintQueue();
      releaseBusy(job);
    }
  }

  function runActive() {
    if (!state.source || signal.aborted) return undefined;
    if (state.cutout === 'smart') {
      clearTimeout(state.timer);
      const job = ++state.job;
      return processSmart(job);
    }
    renderWhite();
    return undefined;
  }

  async function decodeScaled(file) {
    await inspectImageFile(file);
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('无法读取这张图片，请使用 PNG、JPEG 或 WebP。');
    }
    try {
      if (bitmap.width * bitmap.height > 32_000_000) throw new Error('解码后的图片尺寸超过 3200 万像素。');
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, width, height);
      return { data: context.getImageData(0, 0, width, height).data, width, height };
    } finally {
      bitmap?.close?.();
    }
  }

  async function thumbFor(file) {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const edge = 96;
        const scale = Math.min(edge / bitmap.width, edge / bitmap.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await canvasToBlob(canvas, 'image/jpeg', 0.72);
        return URL.createObjectURL(blob);
      } finally {
        bitmap.close?.();
      }
    } catch {
      return '';
    }
  }

  async function addFiles(files, { activate = false } = {}) {
    if (!files.length || signal.aborted || ui.page.hasAttribute('aria-busy')) return;
    ui.setBusy(true);
    ui.setMessage('正在检查图片…');
    const accepted = [];
    const rejected = [];
    try {
      for (const file of files) {
        if (signal.aborted) return;
        if (queue.length + accepted.length >= IMPORT_LIMIT) {
          rejected.push({ name: file.name || '图片', message: `一次最多 ${IMPORT_LIMIT} 张` });
          continue;
        }
        try {
          await inspectImageFile(file);
          accepted.push(file);
        } catch (error) {
          rejected.push({ name: file.name || '图片', message: error.message || '无法读取' });
        }
        await yieldToUi();
      }
      for (const file of accepted) {
        const thumbUrl = await thumbFor(file);
        queue.push({
          id: globalThis.crypto?.randomUUID?.() || `img-${Date.now()}-${queue.length}`,
          file,
          name: file.name || `image-${queue.length + 1}.png`,
          thumbUrl,
          status: 'queued',
          error: '',
          strokes: [],
        });
        await yieldToUi();
      }
      paintQueue();
      const extra = rejected.length ? ` ${rejected.length} 张没有加入：${rejected[0].message}` : '';
      ui.setMessage(accepted.length ? `已加入 ${accepted.length} 张。${extra}` : (rejected[0]?.message || '没有可加入的图片。'), accepted.length ? 'info' : 'warning');
    } finally {
      if (!signal.aborted) ui.setBusy(false);
      syncControls();
    }
    if (activate) {
      const first = queue.find((item) => accepted.includes(item.file)) || queue[0];
      if (first) await openItem(first.id);
    }
  }

  async function openItem(id) {
    if (!id || signal.aborted || ui.page.hasAttribute('aria-busy')) return;
    rememberStrokes();
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    state.activeId = id;
    item.status = 'processing';
    paintQueue();
    ui.setBusy(true);
    ui.setMessage('正在读取图片…');
    try {
      const decoded = await decodeScaled(item.file);
      if (signal.aborted) return;
      state.source = decoded.data;
      state.width = decoded.width;
      state.height = decoded.height;
      state.strokes = item.strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
        color: stroke.color ? [...stroke.color] : undefined,
      }));
      state.result = null;
      state.matte = null;
      state.preview = 'result';
      ui.setPreviewMode('result');
      ui.stage.setAttribute('data-zoom', '1');
      state.zoom = 1;
      ui.page.querySelector('.editor-zoom-value').textContent = '1×';
    } catch (error) {
      item.status = 'failed';
      item.error = error.message || '无法读取这张图片。';
      ui.setMessage(item.error, 'danger');
      paintQueue();
      return;
    } finally {
      if (ui.page.hasAttribute('aria-busy')) ui.setBusy(false);
      syncControls();
    }
    await runActive();
  }

  function removeItem(id) {
    if (ui.page.hasAttribute('aria-busy')) return;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [removed] = queue.splice(index, 1);
    if (removed.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
    if (state.activeId === id) {
      state.activeId = null;
      state.source = null;
      state.result = null;
      state.matte = null;
      state.strokes = [];
      ui.canvas.hidden = true;
      ui.empty.hidden = false;
      ui.exportButton.disabled = true;
      ui.undo.disabled = true;
      const neighbor = queue[index] || queue[index - 1];
      paintQueue();
      if (neighbor) void openItem(neighbor.id);
      else ui.setMessage('图片已移除。');
      return;
    }
    paintQueue();
  }

  async function processAll() {
    if (!queue.length || signal.aborted || ui.page.hasAttribute('aria-busy')) return;
    rememberStrokes();
    ui.setBusy(true);
    ui.progress.hidden = false;
    ui.progress.max = queue.length;
    const failures = [];
    try {
      for (let index = 0; index < queue.length; index += 1) {
        if (signal.aborted) return;
        const item = queue[index];
        item.status = 'processing';
        paintQueue();
        ui.progress.value = index;
        ui.setMessage(`正在处理 ${index + 1}/${queue.length}：${item.name}`);
        try {
          const decoded = await decodeScaled(item.file);
          const strokes = item.id === state.activeId ? state.strokes : item.strokes;
          let pixels;
          if (state.cutout === 'smart') {
            const blob = await uploadBlob(decoded.data, decoded.width, decoded.height);
            const output = await requestMatting(blob);
            const matte = await blobToPixels(output, decoded.width, decoded.height);
            pixels = renderEditedFrame(matte, decoded.data, decoded.width, decoded.height, strokes);
            if (item.id === state.activeId) {
              state.source = decoded.data;
              state.width = decoded.width;
              state.height = decoded.height;
              state.matte = matte;
              state.result = pixels;
              paint();
            }
          } else {
            const copy = decoded.data.slice();
            const result = await worker.request('image', {
              buffer: copy.buffer,
              width: decoded.width,
              height: decoded.height,
              settings: settings(),
              strokes,
            }, [copy.buffer]);
            pixels = new Uint8ClampedArray(result.result);
            if (item.id === state.activeId) {
              state.source = decoded.data;
              state.width = decoded.width;
              state.height = decoded.height;
              state.matte = null;
              state.result = pixels;
              paint();
            }
          }
          const png = await pixelsToBlob(pixels, decoded.width, decoded.height, 'image/png');
          downloadBlob(png, downloadName(item.name));
          item.status = 'done';
          item.error = '';
          await delay(450);
        } catch (error) {
          if (error.name === 'AbortError' || signal.aborted) throw error;
          item.status = 'failed';
          item.error = error.message || '处理失败';
          failures.push(item);
        }
        paintQueue();
      }
    } catch (error) {
      if (error.name !== 'AbortError' && !signal.aborted) ui.setMessage(error.message || '处理中断。', 'danger');
    } finally {
      ui.progress.hidden = true;
      if (!signal.aborted) ui.setBusy(false);
      ui.undo.disabled = state.strokes.length === 0;
      syncControls();
    }
    if (signal.aborted) return;
    if (failures.length) {
      ui.setMessage(`完成 ${queue.length - failures.length} 张，失败 ${failures.length} 张：${failures[0].error} 可改用「去白底」后重试。`, 'warning');
    } else {
      ui.setMessage(`已逐张保存 ${queue.length} 张。若浏览器拦截了多个文件，请逐张点保存。`, 'success');
    }
  }

  function progressLabel() {
    const model = MODELS.find(([value]) => value === state.model)?.[1] || state.model;
    const refine = REFINES.find(([value]) => value === state.refine)?.[1] || '不精修';
    return `正在抠图：${model}，${refine}。一次一张，请稍等。`;
  }

  async function requestMatting(blob) {
    const params = new URLSearchParams({ model: state.model, refine: state.refine });
    let response;
    try {
      response = await fetch(`/api/matting/remove?${params}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': blob.type || 'image/png',
          Accept: 'image/png',
          'X-CSRF-Token': session?.csrfToken || '',
        },
        body: blob,
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('网络中断，没有拿到抠图结果。');
    }
    if (response.status === 401) {
      window.location.assign('/login');
      const error = new Error('登录已失效');
      error.name = 'AbortError';
      throw error;
    }
    if (!response.ok) throw new Error(await readError(response));
    const type = String(response.headers.get('content-type') || '');
    if (!type.startsWith('image/')) throw new Error('抠图服务没有返回图片。');
    return response.blob();
  }

  async function loadHealth() {
    try {
      const status = await apiRequest('/api/matting/health', { signal });
      if (signal.aborted) return;
      health.textContent = status?.ok ? '抠图服务在线。' : '抠图服务离线。可先用去白底。';
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || (error instanceof ApiError && error.status === 401)) return;
      health.textContent = '暂时无法确认抠图服务。可先用去白底。';
    }
  }

  async function importPending(record) {
    ui.setBusy(true);
    ui.setMessage(record.mode === 'smart' ? '正在带入图片，并使用智能抠图…' : '正在带入图片，并使用去白底…');
    try {
      const { files, failures } = await materializeImport(record, { signal });
      if (signal.aborted) return;
      ui.setBusy(false);
      if (!files.length) {
        const reason = failures[0]?.message || '没有拿到可处理的图片。';
        ui.setMessage(`${reason} 可回到下载页重新解析。`, 'warning');
        return;
      }
      await addFiles(files, { activate: true });
      if (failures.length && !signal.aborted) {
        ui.setMessage(`已带入 ${files.length} 张，${failures.length} 张失败：${failures[0].message}`, 'warning');
      }
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) return;
      ui.setBusy(false);
      ui.setMessage(error.message || '导入失败。', 'danger');
    }
  }

  on(ui.fileInput, 'change', () => {
    const files = [...(ui.fileInput.files || [])];
    ui.fileInput.value = '';
    void addFiles(files, { activate: !state.activeId });
  });
  on(ui.stage, 'dragover', (event) => { event.preventDefault(); ui.stage.classList.add('is-drop-target'); });
  on(ui.stage, 'dragleave', () => ui.stage.classList.remove('is-drop-target'));
  on(ui.stage, 'drop', (event) => {
    event.preventDefault();
    ui.stage.classList.remove('is-drop-target');
    const files = [...(event.dataTransfer?.files || [])];
    void addFiles(files, { activate: !state.activeId });
  });
  on(ui.tolerance, 'input', () => { ui.toleranceValue.value = ui.tolerance.value; if (state.cutout === 'white') renderWhite(); });
  on(ui.mode, 'change', () => { if (state.cutout === 'white') renderWhite(); });
  on(modelSelect, 'change', () => { state.model = modelSelect.value; if (state.cutout === 'smart') void runActive(); });
  on(refineSelect, 'change', () => { state.refine = refineSelect.value; syncControls(); if (state.cutout === 'smart') void runActive(); });
  on(ui.page, 'preview-mode', (event) => { state.preview = event.detail; paint(); });
  for (const tool of ['erase', 'restore', 'paint', 'sample', 'move']) on(ui.toolButtons.get(tool), 'click', () => setTool(tool));
  on(ui.brushSize, 'input', () => { ui.brushValue.value = `${ui.brushSize.value} px`; });
  on(ui.undo, 'click', () => {
    if (!state.strokes.length) return;
    state.strokes.pop();
    rememberStrokes();
    if (state.cutout === 'smart' && state.matte) {
      state.result = renderEditedFrame(state.matte, state.source, state.width, state.height, state.strokes);
      paint();
      ui.undo.disabled = state.strokes.length === 0;
      return;
    }
    renderWhite();
  });
  on(ui.canvas, 'pointerdown', startPointer);
  on(ui.canvas, 'pointermove', movePointer);
  on(ui.canvas, 'pointerup', endPointer);
  on(ui.canvas, 'pointercancel', endPointer);
  on(ui.stage, 'pointerdown', startPan);
  on(ui.stage, 'pointermove', movePan);
  on(ui.stage, 'pointerup', endPan);
  on(ui.stage, 'pointercancel', endPan);
  const zoomButtons = ui.page.querySelectorAll('[data-zoom-step]');
  on(zoomButtons[0], 'click', () => setZoom(state.zoom - 1));
  on(zoomButtons[1], 'click', () => setZoom(state.zoom + 1));
  on(ui.page.querySelector('[data-zoom-reset]'), 'click', () => setZoom(1));
  on(batch, 'click', () => { void processAll(); });
  on(ui.exportButton, 'click', exportPng);
  on(signal, 'abort', () => {
    clearTimeout(state.timer);
    worker.destroy();
    for (const item of queue) if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  });
  syncControls();
  void loadHealth();
  if (pendingImport.ok) void importPending(pendingImport.record);
  else if (pendingImport.reason === 'expired') ui.setMessage('导入的图片已过期，请回到下载页重新解析。', 'warning');

  function setTool(tool) {
    state.tool = tool;
    for (const [key, control] of ui.toolButtons) {
      const active = key === tool;
      control.classList.toggle('btn-primary', active);
      control.classList.toggle('btn-outline-secondary', !active);
      control.setAttribute('aria-pressed', String(active));
    }
    ui.canvas.classList.toggle('is-moving', tool === 'move');
    ui.setMessage(tool === 'move' ? '拖动画面查看细节；滚动不会裁切导出。' : '擦除只清除透明度；还原恢复原始像素。');
  }
  function setZoom(value) {
    state.zoom = clampZoom(value);
    ui.stage.setAttribute('data-zoom', String(state.zoom));
    ui.page.querySelector('.editor-zoom-value').textContent = `${state.zoom}×`;
  }
  function point(event) {
    const rect = ui.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(state.width - 1, (event.clientX - rect.left) * state.width / rect.width)),
      y: Math.max(0, Math.min(state.height - 1, (event.clientY - rect.top) * state.height / rect.height)),
    };
  }
  function startPointer(event) {
    if (!state.source || ui.page.hasAttribute('aria-busy') || state.tool === 'move' || event.button !== 0) return;
    const at = point(event);
    if (state.tool === 'sample') {
      const offset = (Math.floor(at.y) * state.width + Math.floor(at.x)) * 4;
      const sample = state.result && state.result[offset + 3] ? state.result : state.source;
      const hex = [sample[offset], sample[offset + 1], sample[offset + 2]].map((value) => value.toString(16).padStart(2, '0')).join('');
      ui.color.value = `#${hex}`;
      setTool('paint');
      return;
    }
    event.preventDefault();
    ui.canvas.setPointerCapture(event.pointerId);
    state.stroke = { tool: state.tool, radius: Number(ui.brushSize.value), points: [at], color: state.tool === 'paint' ? hexRgb(ui.color.value) : undefined };
  }
  function movePointer(event) {
    if (!state.stroke || !ui.canvas.hasPointerCapture(event.pointerId)) return;
    const at = point(event);
    const previous = state.stroke.points.at(-1);
    if (Math.hypot(at.x - previous.x, at.y - previous.y) < .35 || state.stroke.points.length >= 1024) return;
    state.stroke.points.push(at);
  }
  function endPointer(event) {
    if (event.type === 'pointercancel') { state.stroke = null; return; }
    if (!state.stroke || (event.pointerId != null && !ui.canvas.hasPointerCapture(event.pointerId))) return;
    const stroke = state.stroke;
    state.stroke = null;
    if (!stroke.points.length || state.strokes.length >= 100) {
      ui.setMessage('每张图片最多保留 100 笔。', 'warning');
      return;
    }
    state.strokes.push(stroke);
    rememberStrokes();
    if (state.cutout === 'smart' && state.matte && state.source) {
      state.result = renderEditedFrame(state.matte, state.source, state.width, state.height, state.strokes);
      paint();
      ui.undo.disabled = false;
      return;
    }
    renderWhite();
  }
  let pan;
  function startPan(event) {
    if (state.tool !== 'move' || ui.canvas.hidden || event.target !== ui.canvas) return;
    pan = { x: event.clientX, y: event.clientY, left: ui.stage.scrollLeft, top: ui.stage.scrollTop, id: event.pointerId };
    ui.stage.setPointerCapture(event.pointerId);
  }
  function movePan(event) {
    if (!pan || pan.id !== event.pointerId) return;
    ui.stage.scrollLeft = pan.left - (event.clientX - pan.x);
    ui.stage.scrollTop = pan.top - (event.clientY - pan.y);
  }
  function endPan(event) { if (pan?.id === event.pointerId) pan = null; }
  function hexRgb(hex) { return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)); }
  function exportPng() {
    if (!state.result) return;
    pixelsToBlob(state.result, state.width, state.height, 'image/png').then((blob) => {
      downloadBlob(blob, 'transparent-image.png');
      ui.setMessage('透明 PNG 已生成并下载。', 'success');
    }).catch(() => ui.setMessage('无法生成 PNG，请重试。', 'danger'));
  }
  return ui.page;
}

function yieldToUi() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('无法准备图片。'))), type, quality);
  });
}

async function pixelsToBlob(data, width, height, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvasToBlob(canvas, type, quality);
}

async function uploadBlob(data, width, height) {
  const png = await pixelsToBlob(data, width, height, 'image/png');
  if (png.size <= MAX_UPLOAD) return png;
  const jpeg = await pixelsToBlob(data, width, height, 'image/jpeg', 0.9);
  if (jpeg.size > MAX_UPLOAD) throw new Error('图片不能超过 10 MB。');
  return jpeg;
}

async function blobToPixels(blob, width, height) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    return canvas.getContext('2d').getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close?.();
  }
}

function downloadBlob(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

function downloadName(name) {
  const base = String(name || 'image').replace(/\.[^.]+$/, '').slice(0, 60) || 'image';
  return `${base}.png`;
}

async function readError(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
  } catch {
    // The body is not JSON.
  }
  if (response.status === 429) return '抠图服务正在处理另一张图片，请稍后再试。';
  return '智能抠图失败。';
}
