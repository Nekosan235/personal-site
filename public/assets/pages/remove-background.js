import { createWorkbench } from '../components/image-tools/editor-ui.js?v=1.4.0';
import { createImageWorker } from '../components/image-tools/worker-client.js?v=1.4.0';
import { clampZoom } from '../components/image-tools/editor-view.js?v=1.4.0';
import { inspectImageFile } from '../components/image-tools/image-file.js?v=1.4.0';

const MAX_EDGE = 2048;

export function renderRemoveBackground({ signal }) {
  const ui = createWorkbench({ kind: 'image', title: '图片去白底', description: '移除与白色接近的背景，再用画笔修整并导出透明 PNG。' });
  const worker = createImageWorker(signal);
  const state = { source: null, result: null, width: 0, height: 0, strokes: [], tool: 'erase', preview: 'result', job: 0, timer: null, zoom: 1 };
  const on = (node, type, listener) => node.addEventListener(type, listener, { signal });
  const paint = () => {
    if (!state.source || !state.result) return;
    ui.draw(state.preview === 'original' ? state.source : state.result, state.width, state.height);
  };
  const settings = () => ({ tolerance: Number(ui.tolerance.value), mode: ui.mode.value, feather: 12 });
  const render = () => {
    if (!state.source || signal.aborted) return;
    clearTimeout(state.timer);
    const job = ++state.job;
    state.timer = setTimeout(async () => {
      ui.setBusy(true);
      ui.setMessage('正在处理图片…');
      try {
        const copy = state.source.slice();
        const result = await worker.request('image', {
          buffer: copy.buffer, width: state.width, height: state.height,
          settings: settings(), strokes: state.strokes,
        }, [copy.buffer]);
        if (job !== state.job || signal.aborted) return;
        state.result = new Uint8ClampedArray(result.result);
        paint();
        ui.setMessage(`${state.strokes.length} 笔修整已保留；重复调整会从原始像素重新计算。`);
        ui.undo.disabled = state.strokes.length === 0;
      } catch (error) {
        if (error.name !== 'AbortError') ui.setMessage(error.message, 'danger');
      } finally {
        if (job === state.job && !signal.aborted) ui.setBusy(false);
      }
    }, 75);
  };

  async function load(file) {
    if (!file || signal.aborted || ui.page.hasAttribute('aria-busy')) return;
    ui.setBusy(true);
    ui.setMessage('正在检查并读取图片…');
    let bitmap;
    try {
      await inspectImageFile(file);
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 32_000_000) throw new Error('解码后的图片尺寸超过 3200 万像素。');
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      state.width = Math.max(1, Math.round(bitmap.width * scale));
      state.height = Math.max(1, Math.round(bitmap.height * scale));
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = state.width; sourceCanvas.height = state.height;
      const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, state.width, state.height);
      state.source = context.getImageData(0, 0, state.width, state.height).data;
      state.strokes = [];
      state.preview = 'result';
      ui.setPreviewMode('result');
      ui.exportButton.disabled = true;
      ui.undo.disabled = true;
      ui.stage.setAttribute('data-zoom', '1');
      state.zoom = 1;
      ui.setBusy(false);
      render();
    } catch (error) {
      ui.setMessage(error.message || '无法读取这张图片，请尝试 PNG、JPEG 或 WebP。', 'danger');
    } finally {
      bitmap?.close();
      if (!signal.aborted && ui.page.hasAttribute('aria-busy')) ui.setBusy(false);
    }
  }

  on(ui.fileInput, 'change', () => load(ui.fileInput.files?.[0]));
  on(ui.stage, 'dragover', (event) => { event.preventDefault(); ui.stage.classList.add('is-drop-target'); });
  on(ui.stage, 'dragleave', () => ui.stage.classList.remove('is-drop-target'));
  on(ui.stage, 'drop', (event) => { event.preventDefault(); ui.stage.classList.remove('is-drop-target'); load(event.dataTransfer.files?.[0]); });
  on(ui.tolerance, 'input', () => { ui.toleranceValue.value = ui.tolerance.value; render(); });
  on(ui.mode, 'change', render);
  on(ui.page, 'preview-mode', (event) => { state.preview = event.detail; paint(); });
  for (const tool of ['erase', 'restore', 'paint', 'sample', 'move']) on(ui.toolButtons.get(tool), 'click', () => setTool(tool));
  on(ui.brushSize, 'input', () => { ui.brushValue.value = `${ui.brushSize.value} px`; });
  on(ui.undo, 'click', () => { if (state.strokes.length) { state.strokes.pop(); render(); } });
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
  on(ui.exportButton, 'click', exportPng);
  on(signal, 'abort', () => { clearTimeout(state.timer); worker.destroy(); });

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
    return { x: Math.max(0, Math.min(state.width - 1, (event.clientX - rect.left) * state.width / rect.width)),
      y: Math.max(0, Math.min(state.height - 1, (event.clientY - rect.top) * state.height / rect.height)) };
  }
  function startPointer(event) {
    if (!state.source || ui.page.hasAttribute('aria-busy') || state.tool === 'move' || event.button !== 0) return;
    const at = point(event);
    if (state.tool === 'sample') {
      const offset = (Math.floor(at.y) * state.width + Math.floor(at.x)) * 4;
      const pixels = state.result[offset + 3] ? state.result : state.source;
      const hex = [pixels[offset], pixels[offset + 1], pixels[offset + 2]].map((value) => value.toString(16).padStart(2, '0')).join('');
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
    const stroke = state.stroke; state.stroke = null;
    if (stroke.points.length && state.strokes.length < 100) { state.strokes.push(stroke); render(); }
    else ui.setMessage('每张图片最多保留 100 笔。', 'warning');
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
    const output = document.createElement('canvas'); output.width = state.width; output.height = state.height;
    output.getContext('2d').putImageData(new ImageData(state.result, state.width, state.height), 0, 0);
    output.toBlob((blob) => {
      if (!blob) return ui.setMessage('无法生成 PNG，请重试。', 'danger');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = 'transparent-image.png'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      ui.setMessage('透明 PNG 已生成并下载。', 'success');
    }, 'image/png');
  }
  return ui.page;
}
