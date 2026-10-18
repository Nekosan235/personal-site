import { DATA_CONVERSIONS } from './data.js';

export const TEXT_CASES = [
  { id: 'keep', label: '保持大小写' },
  { id: 'upper', label: '全大写' },
  { id: 'lower', label: '全小写' },
  { id: 'title', label: '单词首字母大写' },
];

export const TEXT_SPACES = [
  { id: 'keep', label: '保持空白' },
  { id: 'trim', label: '去除首尾空白' },
  { id: 'trim-lines', label: '去除每行首尾空白' },
  { id: 'collapse', label: '压缩连续空格' },
];

export const TEXT_NEWLINES = [
  { id: 'keep', label: '保持换行' },
  { id: 'lf', label: '转为 LF' },
  { id: 'crlf', label: '转为 CRLF' },
];

export const IMAGE_TARGETS = [
  { id: 'png', label: 'PNG', mime: 'image/png', extension: 'png' },
  { id: 'jpg', label: 'JPG', mime: 'image/jpeg', extension: 'jpg' },
  { id: 'webp', label: 'WebP', mime: 'image/webp', extension: 'webp' },
  { id: 'gif', label: 'GIF（静态）', mime: 'image/gif', extension: 'gif' },
];

export const UNAVAILABLE_CONVERTERS = [
  {
    id: 'heic',
    title: 'HEIC → JPG',
    reason: 'HEIC 解码依赖系统或原生库。当前站点不引入这类依赖，因此不提供 HEIC 转换。',
  },
  {
    id: 'pdf',
    title: 'PDF',
    reason: '没有与现有无依赖栈匹配的轻量 PDF 工具，因此不转换 PDF。',
  },
  {
    id: 'media',
    title: '音频与视频',
    reason: '不检测或调用 ffmpeg，也不在服务器上执行命令。音视频转换不可用。',
  },
];

export function converterCatalog() {
  return {
    images: ['png', 'jpeg', 'webp', 'gif', 'svg'],
    imageTargets: IMAGE_TARGETS.map((item) => item.id),
    documents: ['markdown-html', 'plain-preview'],
    data: DATA_CONVERSIONS.map((item) => item.id),
    text: ['case', 'whitespace', 'newlines'],
    unavailable: UNAVAILABLE_CONVERTERS.map((item) => item.id),
  };
}
