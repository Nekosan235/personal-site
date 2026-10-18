import { parseImageHeader } from '../image-tools/image-file.js';
import { LIMITS, assertText, byteLength } from './limits.js';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

function ascii(bytes, start, value) {
  if (start + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[start + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

export function detectContainer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) return 'gif';
  if (bytes.length >= 12 && ascii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (brand === 'avif') return 'avif';
  }
  if (bytes.length >= 5 && ascii(bytes, 0, '%PDF-')) return 'pdf';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 512))).replace(/^\uFEFF/, '').trimStart();
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return 'svg';
  return 'unknown';
}

export function readRasterSize(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = detectContainer(bytes);
  if (kind === 'png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { kind, width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (kind === 'gif' && bytes.length >= 10) {
    return { kind, width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  return { kind, width: 0, height: 0 };
}

export function assertImageBytes(size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('图片文件为空。');
  if (size > LIMITS.imageBytes) throw new Error('图片不能超过 10 MB。');
}

export function outputPixelSize(width, height, { gif = false } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('图片尺寸无效。');
  if (width * height > LIMITS.decodePixels) throw new Error('图片原始尺寸过大，请先缩小到 3200 万像素以内。');
  const pixelCap = gif ? LIMITS.outputPixels : LIMITS.decodePixels;
  const scale = Math.min(1, LIMITS.maxEdge / width, LIMITS.maxEdge / height, Math.sqrt(pixelCap / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scaled: scale < 0.999,
  };
}

const SVG_FORBIDDEN = /<\s*(?:script|foreignObject|iframe|embed|object|link|use|image|animate)\b|<!ENTITY|<!DOCTYPE|javascript:|data:\s*|https?:|\/\/|@import|\b(?:xlink:)?href\s*=/i;

export function assertSafeSvg(value) {
  const text = assertText(value, 'SVG').trim();
  if (byteLength(text) > LIMITS.svgBytes) throw new Error('SVG 不能超过 512 KB。');
  if (!/^(?:<\?xml[\s\S]*?)?<svg[\s>]/i.test(text)) throw new Error('这不是可转换的 SVG。');
  const withoutNamespace = text.replace(/\sxmlns(?::\w+)?\s*=\s*["']http:\/\/www\.w3\.org\/[^"']+["']/gi, '');
  if (SVG_FORBIDDEN.test(withoutNamespace)) throw new Error('SVG 含有脚本、外链或嵌入内容，已拒绝转换。');
  return text;
}

export function svgPixelSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const width = Number(/width=["']([\d.]+)/i.exec(tag)?.[1]);
  const height = Number(/height=["']([\d.]+)/i.exec(tag)?.[1]);
  const box = /viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(tag);
  const rawWidth = Number.isFinite(width) && width > 0 ? width : (box ? Number(box[1]) : 512);
  const rawHeight = Number.isFinite(height) && height > 0 ? height : (box ? Number(box[2]) : 512);
  return outputPixelSize(rawWidth, rawHeight);
}

export function clampQuality(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.92;
  return Math.min(0.95, Math.max(0.5, Math.round(number * 100) / 100));
}

export function prepareImageSource(input, size) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  assertImageBytes(size ?? bytes.byteLength);
  const kind = detectContainer(bytes);
  if (kind === 'heic') throw new Error('HEIC 需要系统解码器，当前工具不转换 HEIC。');
  if (kind === 'avif') throw new Error('AVIF 转换未提供。');
  if (kind === 'pdf') throw new Error('PDF 转换未提供。');
  if (kind === 'unknown') throw new Error('无法识别这个文件。支持 PNG、JPG、WebP、GIF 和安全的 SVG。');
  if (kind === 'svg') {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('SVG 需要是 UTF-8 文本。');
    }
    const safe = assertSafeSvg(text);
    return { kind, text: safe, ...svgPixelSize(safe) };
  }
  if (kind === 'gif') {
    const raster = readRasterSize(bytes);
    if (!raster.width || !raster.height) throw new Error('无法识别 GIF 尺寸。');
    const fitted = outputPixelSize(raster.width, raster.height, { gif: true });
    return { kind, sourceWidth: raster.width, sourceHeight: raster.height, ...fitted };
  }
  let header;
  try {
    header = parseImageHeader(bytes);
  } catch (error) {
    throw new Error(error.message || '无法识别图片尺寸。');
  }
  const fitted = outputPixelSize(header.width, header.height, { gif: false });
  return {
    kind,
    animated: Boolean(header.animated),
    sourceWidth: header.width,
    sourceHeight: header.height,
    ...fitted,
  };
}

export function downloadName(original, extension) {
  const leaf = String(original || 'converted').split(/[/\\]/).pop() || 'converted';
  const cleaned = leaf.replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_').replace(/^\.+/, '').slice(0, 80);
  const stem = (cleaned.replace(/\.[^.]+$/u, '') || 'converted').replace(/^\.+/, '') || 'converted';
  const ext = String(extension || 'bin').toLowerCase().replace(/[^\w]+/g, '').slice(0, 8) || 'bin';
  return `${stem}.${ext}`;
}
