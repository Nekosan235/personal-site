import { createWorkbench } from '../components/image-tools/editor-ui.js?v=1.5.0';
import { createImageWorker } from '../components/image-tools/worker-client.js?v=1.4.0';
import { clampZoom } from '../components/image-tools/editor-view.js?v=1.4.0';

export function renderGifEditor({ signal }) {
  const ui = createWorkbench({ kind: 'gif', title: 'GIF 逐帧编辑', description: '去除动画背景，逐帧修整并导出保留延时的透明 GIF。' });
  ui.timeline.hidden = false;
  const worker = createImageWorker(signal);
  const state = { meta: null, frame: 0, original: null, result: null, preview: 'result', tool: 'erase', zoom: 1, busy: false, playing: false, playTimer: null, frameJob: 0, exportUrl: null };
  const on = (node, type, listener) => node.addEventListener(type, listener, { signal });
  const stop = () => { clearTimeout(state.playTimer); state.playing = false; ui.play.textContent = '播放'; };
  const revoke = () => { if (state.exportUrl) URL.revokeObjectURL(state.exportUrl); state.exportUrl = null; ui.page.querySelector('.editor-download-link')?.remove(); };
  const settings = () => ({ tolerance: Number(ui.tolerance.value), mode: ui.mode.value, feather: 12 });
  const draw = () => {
    if (!state.meta || !state.result || !state.original) return;
    ui.draw(state.preview === 'original' ? state.original : state.result, state.meta.width, state.meta.height);
    ui.setFrame(state.frame, state.meta.frameCount, state.meta.delays[state.frame]);
  };
  async function showFrame(frame, nextSettings) {
    if (!state.meta || state.busy || signal.aborted) return;
    state.frame = Math.max(0, Math.min(state.meta.frameCount - 1, Math.round(frame)));
    const job = ++state.frameJob; state.busy = true; ui.setBusy(true);
    try {
      const output = await worker.request('gif-frame', { frame: state.frame, settings: nextSettings });
      if (job !== state.frameJob || signal.aborted) return;
      state.original = new Uint8ClampedArray(output.original); state.result = new Uint8ClampedArray(output.result);
      draw(); ui.undo.disabled = !output.hasUndo;
      ui.setMessage(`${state.meta.frameCount} 帧 · 第 ${state.frame + 1} 帧 · 修改只作用于当前帧。`);
    } catch (error) { if (error.name !== 'AbortError') ui.setMessage(error.message, 'danger'); }
    finally { state.busy = false; if (!signal.aborted) ui.setBusy(false); }
  }
  async function load(file) {
    if (!file || signal.aborted || ui.page.hasAttribute('aria-busy')) return;
    stop(); revoke();
    if (file.size > 8 * 1024 * 1024) return ui.setMessage('GIF 文件不能超过 8 MB。', 'danger');
    if (file.type && file.type !== 'image/gif') return ui.setMessage('请选择 GIF 文件。', 'danger');
    state.busy = true; ui.setBusy(true); ui.setMessage('正在读取并检查 GIF…');
    try {
      const buffer = await file.arrayBuffer();
      const output = await worker.request('gif-load', { buffer }, [buffer]);
      if (signal.aborted) return;
      state.meta = output.meta; state.frame = 0;
      state.original = new Uint8ClampedArray(output.original); state.result = new Uint8ClampedArray(output.result);
      state.preview = 'result'; state.busy = false;
      ui.setPreviewMode('result');
      ui.setBusy(false);
      ui.setFrame(0, state.meta.frameCount, state.meta.delays[0]);
      ui.page.querySelector('.editor-preview-switch button:last-of-type').textContent = '当前帧效果';
      draw(); ui.setMessage(`已载入 ${state.meta.frameCount} 帧 · 最长边 ${Math.max(state.meta.width, state.meta.height)} 像素。`);
    } catch (error) { state.busy = false; ui.setBusy(false); ui.setMessage(error.message || '无法读取 GIF，请选择有效文件。', 'danger'); }
  }
  on(ui.fileInput, 'change', () => load(ui.fileInput.files?.[0]));
  on(ui.stage, 'dragover', (event) => { event.preventDefault(); ui.stage.classList.add('is-drop-target'); });
  on(ui.stage, 'dragleave', () => ui.stage.classList.remove('is-drop-target'));
  on(ui.stage, 'drop', (event) => { event.preventDefault(); ui.stage.classList.remove('is-drop-target'); load(event.dataTransfer.files?.[0]); });
  on(ui.frameRange, 'input', () => { stop(); showFrame(Number(ui.frameRange.value)); });
  on(ui.previous, 'click', () => { stop(); showFrame(state.frame - 1); });
  on(ui.next, 'click', () => { stop(); showFrame(state.frame + 1); });
  on(ui.play, 'click', () => state.playing ? stop() : playNext());
  on(ui.tolerance, 'input', () => { ui.toleranceValue.value = ui.tolerance.value; invalidate(); showFrame(state.frame, settings()); });
  on(ui.mode, 'change', () => { invalidate(); showFrame(state.frame, settings()); });
  on(ui.page, 'preview-mode', (event) => { state.preview = event.detail; draw(); });
  for (const tool of ['erase', 'restore', 'paint', 'sample', 'move']) on(ui.toolButtons.get(tool), 'click', () => setTool(tool));
  on(ui.brushSize, 'input', () => { ui.brushValue.value = `${ui.brushSize.value} px`; });
  on(ui.canvas, 'pointerdown', startStroke); on(ui.canvas, 'pointermove', moveStroke);
  on(ui.canvas, 'pointerup', endStroke); on(ui.canvas, 'pointercancel', endStroke);
  on(ui.stage, 'pointerdown', startPan); on(ui.stage, 'pointermove', movePan);
  on(ui.stage, 'pointerup', endPan); on(ui.stage, 'pointercancel', endPan);
  const zoom = ui.page.querySelectorAll('[data-zoom-step]');
  on(zoom[0], 'click', () => setZoom(state.zoom - 1)); on(zoom[1], 'click', () => setZoom(state.zoom + 1));
  on(ui.page.querySelector('[data-zoom-reset]'), 'click', () => setZoom(1));
  on(ui.undo, 'click', undo); on(ui.exportButton, 'click', exportGif);
  on(ui.cancel, 'click', () => { worker.cancel(); ui.setMessage('正在取消…'); });
  on(signal, 'abort', () => { stop(); revoke(); worker.destroy(); });

  function setTool(tool) {
    state.tool = tool;
    for (const [key, control] of ui.toolButtons) {
      const active = key === tool;
      control.classList.toggle('btn-primary', active); control.classList.toggle('btn-outline-secondary', !active);
      control.setAttribute('aria-pressed', String(active));
    }
    ui.canvas.classList.toggle('is-moving', tool === 'move');
  }
  function setZoom(value) {
    state.zoom = clampZoom(value); ui.stage.setAttribute('data-zoom', String(state.zoom));
    ui.page.querySelector('.editor-zoom-value').textContent = `${state.zoom}×`;
  }
  function point(event) {
    const rect = ui.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(state.meta.width - 1, (event.clientX - rect.left) * state.meta.width / rect.width)),
      y: Math.max(0, Math.min(state.meta.height - 1, (event.clientY - rect.top) * state.meta.height / rect.height)) };
  }
  function startStroke(event) {
    if (!state.meta || state.busy || state.tool === 'move' || event.button !== 0) return;
    const at = point(event);
    if (state.tool === 'sample') {
      const offset = (Math.floor(at.y) * state.meta.width + Math.floor(at.x)) * 4;
      const pixels = state.result[offset + 3] ? state.result : state.original;
      ui.color.value = `#${[pixels[offset], pixels[offset + 1], pixels[offset + 2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      setTool('paint'); return;
    }
    event.preventDefault(); stop(); ui.canvas.setPointerCapture(event.pointerId);
    state.stroke = { tool: state.tool, radius: Number(ui.brushSize.value), points: [at], color: state.tool === 'paint' ? [1, 3, 5].map((i) => Number.parseInt(ui.color.value.slice(i, i + 2), 16)) : undefined };
  }
  function moveStroke(event) {
    if (!state.stroke || !ui.canvas.hasPointerCapture(event.pointerId)) return;
    const at = point(event), previous = state.stroke.points.at(-1);
    if (Math.hypot(at.x - previous.x, at.y - previous.y) >= .35 && state.stroke.points.length < 1024) state.stroke.points.push(at);
  }
  async function endStroke(event) {
    if (event.type === 'pointercancel') { state.stroke = null; return; }
    if (!state.stroke || (event.pointerId != null && !ui.canvas.hasPointerCapture(event.pointerId))) return;
    const stroke = state.stroke; state.stroke = null; invalidate(); state.busy = true; ui.setBusy(true);
    try {
      const output = await worker.request('gif-stroke', { frame: state.frame, stroke });
      state.original = new Uint8ClampedArray(output.original); state.result = new Uint8ClampedArray(output.result);
      draw(); ui.undo.disabled = !output.hasUndo; ui.setMessage('已修整当前帧；导出时会应用到对应帧。');
    } catch (error) { ui.setMessage(error.message, 'danger'); }
    finally { state.busy = false; if (!signal.aborted) ui.setBusy(false); }
  }
  async function undo() {
    if (!state.meta || state.busy) return;
    invalidate(); state.busy = true; ui.setBusy(true);
    try {
      const output = await worker.request('gif-undo', { frame: state.frame });
      state.original = new Uint8ClampedArray(output.original); state.result = new Uint8ClampedArray(output.result);
      draw(); ui.undo.disabled = !output.hasUndo; ui.setMessage('已撤销当前帧的上一笔。');
    } catch (error) { ui.setMessage(error.message, 'danger'); }
    finally { state.busy = false; if (!signal.aborted) ui.setBusy(false); }
  }
  function invalidate() { revoke(); ui.setMessage('设置或帧内容已更改；旧导出已失效。'); }
  function playNext() {
    if (!state.meta || state.meta.frameCount < 2) return;
    if (!state.playing) { state.playing = true; state.loopsRemaining = state.meta.loopCount; }
    ui.play.textContent = '暂停';
    let nextFrame = state.frame + 1;
    if (nextFrame >= state.meta.frameCount) {
      if (state.meta.loopCount === null || (state.meta.loopCount > 0 && state.loopsRemaining === 0)) return stop();
      if (state.meta.loopCount > 0) state.loopsRemaining -= 1;
      nextFrame = 0;
    }
    state.playTimer = setTimeout(async () => { await showFrame(nextFrame); if (state.playing) playNext(); }, state.meta.delays[state.frame] || 100);
  }
  async function exportGif() {
    if (!state.meta || state.busy) return;
    stop(); state.busy = true; ui.setBusy(true); ui.progress.hidden = false; ui.progress.value = 0; ui.cancel.hidden = false;
    ui.setMessage('正在逐帧生成透明 GIF…');
    try {
      const output = await worker.request('gif-export', {}, [], ({ progress, current, total }) => {
        ui.progress.value = progress; ui.setMessage(`正在生成第 ${current} / ${total} 帧…`);
      });
      state.exportUrl = URL.createObjectURL(new Blob([output.bytes], { type: 'image/gif' }));
      const link = document.createElement('a');
      link.className = 'btn btn-outline-primary editor-download-link'; link.href = state.exportUrl;
      link.download = 'transparent-animation.gif'; link.textContent = '下载透明 GIF'; ui.exportButton.after(link);
      ui.setMessage('透明 GIF 已生成。下载后可发送文件，避免相册将动画转换为静态图片。', 'success');
    } catch (error) {
      ui.setMessage(error.message || 'GIF 导出失败。', error.message === '已取消生成' ? 'warning' : 'danger');
    } finally { state.busy = false; ui.setBusy(false); ui.progress.hidden = true; ui.cancel.hidden = true; }
  }
  let pan;
  function startPan(event) {
    if (state.tool !== 'move' || ui.canvas.hidden || event.target !== ui.canvas) return;
    pan = { x: event.clientX, y: event.clientY, left: ui.stage.scrollLeft, top: ui.stage.scrollTop, id: event.pointerId };
    ui.stage.setPointerCapture(event.pointerId);
  }
  function movePan(event) {
    if (!pan || pan.id !== event.pointerId) return;
    ui.stage.scrollLeft = pan.left - (event.clientX - pan.x); ui.stage.scrollTop = pan.top - (event.clientY - pan.y);
  }
  function endPan(event) { if (pan?.id === event.pointerId) pan = null; }
  return ui.page;
}
