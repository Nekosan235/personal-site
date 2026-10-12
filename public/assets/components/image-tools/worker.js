import { removeWhiteBackground } from './remove-white.js';
import { renderEditedFrame } from './frame-editor.js';
import { GifProject, MAX_BYTES } from './gif-project.js';

let gifProject = null;
const cancelled = new Set();

function send(id, payload, transfer = []) { self.postMessage({ id, ...payload }, transfer); }
function transferFrame(id, result, original, extra = {}) {
  const originalCopy = original.slice();
  send(id, { result: result.buffer, original: originalCopy.buffer, ...extra }, [result.buffer, originalCopy.buffer]);
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'image') {
      const original = new Uint8ClampedArray(data.buffer);
      const base = removeWhiteBackground(original, data.width, data.height, data.settings).data;
      transferFrame(id, renderEditedFrame(base, original, data.width, data.height, data.strokes), original);
    } else if (type === 'gif-load') {
      gifProject = new GifProject(new Uint8Array(data.buffer));
      const original = gifProject.original(0);
      transferFrame(id, gifProject.render(0), original, { meta: {
        width: gifProject.width, height: gifProject.height, frameCount: gifProject.gif.frameCount,
        totalDurationMs: gifProject.gif.totalDurationMs,
        loopCount: gifProject.gif.loopCount,
        delays: gifProject.gif.frames.map((frame) => frame.delay * 10 || 100),
      } });
    } else if (type === 'gif-frame' || type === 'gif-settings') {
      if (!gifProject) throw new Error('请先选择 GIF 文件');
      if (data.settings) gifProject.settings = { ...gifProject.settings, ...data.settings };
      const original = gifProject.original(data.frame);
      transferFrame(id, gifProject.render(data.frame), original, { hasUndo: gifProject.strokes[data.frame].length > 0 });
    } else if (type === 'gif-stroke' || type === 'gif-undo') {
      if (!gifProject) throw new Error('请先选择 GIF 文件');
      if (type === 'gif-stroke') gifProject.addStroke(data.frame, data.stroke);
      else gifProject.undo(data.frame);
      const original = gifProject.original(data.frame);
      transferFrame(id, gifProject.render(data.frame), original, { hasUndo: gifProject.strokes[data.frame].length > 0 });
    } else if (type === 'gif-export') {
      if (!gifProject) throw new Error('请先选择 GIF 文件');
      cancelled.delete(id);
      const bytes = await gifProject.encode({
        cancelled: () => cancelled.has(id),
        progress: (current, total) => send(id, { progress: current / total, current, total }),
        yieldFrame: () => new Promise((resolve) => setTimeout(resolve, 0)),
      });
      if (cancelled.has(id)) throw new Error('已取消生成');
      send(id, { bytes: bytes.buffer }, [bytes.buffer]);
      cancelled.delete(id);
    } else if (type === 'cancel') cancelled.add(data.jobId);
    else if (type === 'clear-gif') gifProject = null;
  } catch (error) {
    if (type === 'gif-export') cancelled.delete(id);
    send(id, { error: error?.message || '处理失败，请换一个文件重试。' });
  }
};
