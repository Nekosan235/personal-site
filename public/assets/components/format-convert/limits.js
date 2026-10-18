export const LIMITS = {
  textBytes: 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  decodePixels: 32_000_000,
  outputPixels: 4_194_304,
  maxEdge: 8192,
  svgBytes: 512 * 1024,
  yamlDepth: 32,
  yamlNodes: 10_000,
};

export function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

export function assertText(value, label = '文本') {
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串。`);
  const text = value.replace(/^\uFEFF/, '');
  if (byteLength(text) > LIMITS.textBytes) throw new Error(`${label}不能超过 1 MB。`);
  return text;
}
