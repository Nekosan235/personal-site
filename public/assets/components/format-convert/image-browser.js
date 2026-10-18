import { GifEncoder } from '../image-tools/gif-encoder.js?v=1.4.0';
import { IMAGE_TARGETS } from './catalog.js?v=1.6.0';
import { clampQuality, outputPixelSize, prepareImageSource } from './images.js?v=1.6.0';

function aborted() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function blobFromCanvas(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(type === 'image/webp' ? '当前浏览器不能导出 WebP，请改用 PNG 或 JPG。' : '无法生成图片。'));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const image = new Image();
    const abort = () => {
      image.removeAttribute('src');
      reject(aborted());
    };
    image.onload = () => {
      signal?.removeEventListener('abort', abort);
      resolve(image);
    };
    image.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('无法读取这张 SVG。'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}

async function rasterSource(file, prepared, signal) {
  if (prepared.kind === 'svg') {
    const hasSize = /<svg\b[^>]*\bwidth=/i.test(prepared.text) && /<svg\b[^>]*\bheight=/i.test(prepared.text);
    const text = hasSize ? prepared.text : prepared.text.replace(/<svg\b/i, `<svg width="${prepared.width}" height="${prepared.height}"`);
    const blob = new Blob([text], { type: 'image/svg+xml' });
    try {
      const bitmap = await createImageBitmap(blob);
      return { width: bitmap.width || prepared.width, height: bitmap.height || prepared.height, draw: bitmap, close() { bitmap.close(); } };
    } catch {
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
      const image = await loadImage(url, signal);
      return { width: image.naturalWidth || prepared.width, height: image.naturalHeight || prepared.height, draw: image, close() {} };
    }
  }
  if (signal?.aborted) throw aborted();
  try {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, draw: bitmap, close() { bitmap.close(); } };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('无法读取这张图片，请换一张静态 PNG、JPG、WebP、GIF 或 SVG。');
  }
}

function paint(source, width, height, flatten) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (flatten) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

export async function convertImageFile(file, targetId, { quality = 0.92, signal, onProgress } = {}) {
  if (!file) throw new Error('请先选择图片。');
  onProgress?.(0.12);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw aborted();
  onProgress?.(0.35);
  const prepared = prepareImageSource(bytes, file.size);
  const target = IMAGE_TARGETS.find((item) => item.id === targetId);
  if (!target) throw new Error('请选择目标格式。');
  const source = await rasterSource(file, prepared, signal);
  try {
    if (signal?.aborted) throw aborted();
    onProgress?.(0.68);
    const fitted = outputPixelSize(source.width, source.height, { gif: target.id === 'gif' });
    const canvas = paint(source.draw, fitted.width, fitted.height, target.id === 'jpg');
    const blob = target.id === 'gif' ? gifBlob(canvas) : await blobFromCanvas(canvas, target.mime, target.id === 'png' ? undefined : clampQuality(quality));
    onProgress?.(1);
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      scaled: Boolean(fitted.scaled || prepared.scaled),
      extension: target.extension,
      source: prepared.kind,
      animated: Boolean(prepared.animated),
    };
  } finally {
    source.close();
  }
}

function gifBlob(canvas) {
  const frame = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const encoder = new GifEncoder(canvas.width, canvas.height, { loopCount: null, maxBytes: 20 * 1024 * 1024 });
  encoder.addFrame(frame.data, 10);
  return new Blob([encoder.finish()], { type: 'image/gif' });
}
