import { element, pageHeading } from '../dom.js?v=1.4.0';

function button(text, className = 'btn btn-outline-secondary', attributes = {}) {
  return element('button', { className, text, attributes: { type: 'button', ...attributes } });
}

export function createWorkbench({ kind, title, description }) {
  const gif = kind === 'gif';
  const fileInput = element('input', {
    className: 'form-control editor-file-input',
    attributes: { type: 'file', accept: gif ? 'image/gif,.gif' : 'image/png,image/jpeg,image/webp', 'aria-label': gif ? '选择 GIF 文件' : '选择图片' },
  });
  const canvas = element('canvas', { className: 'editor-canvas', attributes: { hidden: '', role: 'img', 'aria-label': '本地图片预览' } });
  const empty = element('div', { className: 'editor-empty' }, [
    element('span', { className: 'editor-empty-icon', text: gif ? 'GIF' : 'PNG' }),
    element('strong', { text: gif ? '选择一个 GIF 开始编辑' : '选择一张图片开始处理' }),
    element('span', { text: gif ? '文件只在浏览器本地处理，不会上传。' : '支持 PNG、JPEG 和 WebP，本地处理，不会上传。' }),
    button(gif ? '选择 GIF 文件' : '选择图片', 'btn btn-primary editor-pick'),
  ]);
  const stage = element('div', { className: 'editor-stage', attributes: { 'data-background': 'checker', 'data-zoom': '1' } }, [empty, canvas]);
  const previewOriginal = button('原图', 'btn btn-sm btn-outline-secondary', { 'aria-pressed': 'false' });
  const previewResult = button('去白效果', 'btn btn-sm btn-outline-primary active', { 'aria-pressed': 'true' });
  const background = element('select', { className: 'form-select form-select-sm editor-background', attributes: { 'aria-label': '预览背景' } }, [
    element('option', { text: '棋盘格', attributes: { value: 'checker' } }),
    element('option', { text: '白色背景', attributes: { value: 'white' } }),
    element('option', { text: '深色背景', attributes: { value: 'dark' } }),
  ]);
  const previewMeta = element('span', { className: 'editor-dimensions text-secondary', text: '仅在浏览器处理' });
  const frameRange = element('input', { className: 'form-range editor-frame-range', attributes: { type: 'range', min: 0, max: 0, value: 0, disabled: '', 'aria-label': '选择 GIF 帧' } });
  const frameLabel = element('span', { className: 'editor-frame-label', text: '尚未载入' });
  const previous = button('上一帧', 'btn btn-sm btn-outline-secondary', { disabled: '' });
  const play = button('播放', 'btn btn-sm btn-outline-primary', { disabled: '' });
  const next = button('下一帧', 'btn btn-sm btn-outline-secondary', { disabled: '' });
  const timeline = element('section', { className: 'editor-timeline', attributes: { hidden: '' } }, [
    element('div', { className: 'editor-timeline-heading' }, [element('strong', { text: '动画帧' }), frameLabel]),
    frameRange,
    element('div', { className: 'editor-timeline-actions' }, [previous, play, next]),
  ]);
  const visual = element('section', { className: 'card editor-visual' }, [
    element('div', { className: 'card-header editor-card-header' }, [
      element('div', {}, [element('h2', { className: 'card-title', text: '预览' }), previewMeta]),
      element('label', { className: 'btn btn-outline-primary btn-sm editor-file-label' }, [
        fileInput, element('span', { text: gif ? '选择 GIF' : '更换图片' }),
      ]),
    ]),
    element('div', { className: 'editor-preview-switch' }, [previewOriginal, previewResult, background]),
    stage, timeline,
    element('div', { className: 'card-footer editor-visual-footer' }, [
      element('span', { className: 'text-secondary', text: '文件仅在当前浏览器中处理，不会上传。' }),
      element('div', { className: 'editor-zoom-controls' }, [
        button('−', 'btn btn-sm btn-ghost-secondary', { 'data-zoom-step': '-1', 'aria-label': '缩小预览' }),
        element('span', { className: 'editor-zoom-value', text: '1×' }),
        button('+', 'btn btn-sm btn-ghost-secondary', { 'data-zoom-step': '1', 'aria-label': '放大预览' }),
        button('适应', 'btn btn-sm btn-ghost-secondary', { 'data-zoom-reset': '', 'aria-label': '适应窗口' }),
      ]),
    ]),
  ]);
  const tolerance = element('input', { className: 'form-range', attributes: { id: 'white-strength', type: 'range', min: 0, max: 80, value: 32, 'data-control': '', 'aria-label': '去白强度' } });
  const toleranceValue = element('output', { className: 'editor-range-value', text: '32' });
  const mode = element('select', { className: 'form-select', attributes: { 'data-control': '', 'aria-label': '去白范围' } }, [
    element('option', { text: '只去除边缘连通的白底', attributes: { value: 'edge' } }),
    element('option', { text: '去除整张图片中的白色', attributes: { value: 'all' } }),
  ]);
  const brushModes = element('div', { className: 'editor-brush-modes', attributes: { role: 'group', 'aria-label': '手动修整工具' } });
  const toolButtons = new Map();
  for (const [value, label] of [['erase', '擦除'], ['restore', '还原'], ['paint', '画笔'], ['sample', '取色'], ['move', '移动']]) {
    const control = button(label, `btn btn-sm ${value === 'erase' ? 'btn-primary' : 'btn-outline-secondary'}`, { 'data-tool': value, 'aria-pressed': value === 'erase' ? 'true' : 'false' });
    brushModes.append(control);
    toolButtons.set(value, control);
  }
  const brushSize = element('input', { className: 'form-range', attributes: { id: 'brush-size', type: 'range', min: 1, max: 40, value: 12, 'data-control': '', 'aria-label': '画笔大小' } });
  const brushValue = element('output', { className: 'editor-range-value', text: '12 px' });
  const color = element('input', { className: 'form-control form-control-color', attributes: { type: 'color', value: '#1c1c1e', 'aria-label': '画笔颜色', 'data-control': '' } });
  const colorRow = element('label', { className: 'editor-color-control' }, [element('span', { text: '画笔颜色' }), color]);
  const undo = button('撤销上一笔', 'btn btn-outline-secondary', { 'data-control': '', disabled: '' });
  const status = element('div', { className: 'editor-status alert alert-info', attributes: { role: 'status', 'aria-live': 'polite' }, text: '请选择本地文件开始编辑。' });
  const progress = element('progress', { className: 'editor-progress', attributes: { max: 1, value: 0, hidden: '' } });
  const cancel = button('取消生成', 'btn btn-sm btn-outline-secondary', { hidden: '' });
  const exportButton = button(gif ? '生成透明 GIF' : '保存透明 PNG', 'btn btn-primary editor-export', { 'data-control': '', disabled: '' });
  const controls = element('section', { className: 'card editor-controls' }, [
    element('div', { className: 'card-header' }, [element('h2', { className: 'card-title', text: '编辑' })]),
    element('div', { className: 'card-body editor-controls-body' }, [
      element('section', { className: 'editor-control-group' }, [
        element('div', { className: 'editor-control-heading' }, [element('label', { className: 'form-label', text: '去白强度', attributes: { for: 'white-strength' } }), toleranceValue]),
        tolerance,
        element('p', { className: 'form-hint', text: '只处理与背景颜色接近的白色；透明边缘会柔化。' }), mode,
      ]),
      element('section', { className: 'editor-control-group' }, [
        element('label', { className: 'form-label', text: '手动修整' }), brushModes,
        element('div', { className: 'editor-control-heading editor-brush-size-heading' }, [element('label', { className: 'form-label', text: '画笔大小', attributes: { for: 'brush-size' } }), brushValue]),
        brushSize, colorRow, undo,
      ]),
      element('p', { className: 'editor-privacy-note' }, [element('strong', { text: '本机处理' }), element('span', { text: gif ? 'GIF 内容不会发送到服务器。最多 8 MB、60 帧。' : '图片不会发送到服务器。最多 10 MB，长边缩至 2048 像素。' })]),
      status, progress, cancel, exportButton,
    ]),
  ]);
  const page = element('div', { className: `page-enter ${gif ? 'gif-editor-page' : 'image-editor-page'}` }, [
    pageHeading(title, description), element('div', { className: 'editor-layout' }, [visual, controls]),
  ]);
  let editorBusy = false;
  let frameCount = 0;
  const setBusy = (busy) => {
    editorBusy = busy;
    page.toggleAttribute('aria-busy', busy);
    for (const control of page.querySelectorAll('[data-control]')) control.disabled = busy;
    fileInput.disabled = busy;
    frameRange.disabled = busy || frameCount < 2;
    previous.disabled = play.disabled = next.disabled = busy || frameCount < 2;
    exportButton.disabled = busy || canvas.hidden;
  };
  const setMessage = (message, tone = 'info') => {
    status.textContent = message;
    status.className = `editor-status alert alert-${tone}`;
  };
  const setFrame = (index, total, delay) => {
    frameCount = total;
    frameRange.max = String(Math.max(0, total - 1));
    frameRange.value = String(index);
    frameRange.disabled = editorBusy || total < 2;
    frameLabel.textContent = total ? `第 ${index + 1} / ${total} 帧 · ${delay} 毫秒` : '尚未载入';
    previous.disabled = play.disabled = next.disabled = editorBusy || total < 2;
  };
  const draw = (data, width, height) => {
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(data, width, height), 0, 0);
    canvas.hidden = false;
    empty.hidden = true;
    exportButton.disabled = false;
    previewMeta.textContent = `${width} × ${height} 像素 · 仅在浏览器处理`;
  };
  const setPreviewMode = (mode) => page.dispatchEvent(new CustomEvent('preview-mode', { detail: mode }));
  previewOriginal.addEventListener('click', () => setPreviewMode('original'));
  previewResult.addEventListener('click', () => setPreviewMode('result'));
  background.addEventListener('change', () => stage.setAttribute('data-background', background.value));
  page.addEventListener('preview-mode', ({ detail }) => {
    const original = detail === 'original';
    previewOriginal.classList.toggle('btn-primary', original);
    previewOriginal.classList.toggle('btn-outline-secondary', !original);
    previewOriginal.setAttribute('aria-pressed', String(original));
    previewResult.classList.toggle('btn-primary', !original);
    previewResult.classList.toggle('btn-outline-primary', !original);
    previewResult.classList.toggle('btn-outline-secondary', original);
    previewResult.classList.toggle('active', !original);
    previewResult.setAttribute('aria-pressed', String(!original));
  });
  page.querySelector('.editor-pick').addEventListener('click', () => fileInput.click());
  return { page, fileInput, canvas, stage, empty, tolerance, toleranceValue, mode, brushModes,
    toolButtons, brushSize, brushValue, color, undo, status, progress, cancel, exportButton,
    frameRange, frameLabel, previous, play, next, timeline, previewMeta, setBusy, setMessage, setFrame, draw, setPreviewMode };
}
