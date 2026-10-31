export const MATTING_MODELS = Object.freeze([
  'u2netp',
  'isnet-general-use',
  'birefnet-general-lite',
]);

export const MATTING_REFINES = Object.freeze(['none', 'dc', 'alpha', 'vitmatte']);

export const MATTING_MAX_BYTES = 10 * 1024 * 1024;
export const MATTING_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export const MATTING_MESSAGES = Object.freeze({
  csrf: '请求未通过安全校验，请刷新页面后再试。',
  rate: '抠图请求太频繁，请稍后再试。',
  busy: '抠图服务正在处理另一张图片，请稍后再试。',
  model: '不支持这个抠图模型。',
  refine: '不支持这个精修方式。',
  type: '请上传 PNG、JPEG 或 WebP。',
  empty: '图片文件为空。',
  tooLarge: '图片不能超过 10 MB。',
  resultTooLarge: '抠图结果过大，已停止。可改用去白底。',
  loopback: '抠图服务只能使用本机地址。',
  down: '智能抠图服务暂时连不上。请确认本机回环代理已启动，或改用去白底。',
  timeout: '智能抠图超时。请改用更快的 u2netp，或把精修改成不精修，也可以改用去白底。',
  overloaded: '抠图服务暂时没有返回结果。请改用更快的 u2netp，或改用去白底。',
  oom: '抠图服务内存不足，这次没有完成。请改用更快的 u2netp，精细模型更容易占满内存。也可以改用去白底。',
  redirect: '抠图服务返回了跳转，已停止。',
  rejected: '抠图服务没有接受这张图片。可换一张，或改用去白底。',
  notImage: '智能抠图没有返回图片。可改用去白底后再试。',
});

const INPUT_TYPES = new Map([
  ['image/png', 'image.png'],
  ['image/jpeg', 'image.jpg'],
  ['image/jpg', 'image.jpg'],
  ['image/webp', 'image.webp'],
]);

export function parseMattingQuery(url) {
  const model = url.searchParams.get('model') || '';
  const refine = url.searchParams.get('refine') || 'none';
  if (!MATTING_MODELS.includes(model)) return { error: MATTING_MESSAGES.model };
  if (!MATTING_REFINES.includes(refine)) return { error: MATTING_MESSAGES.refine };
  return { model, refine };
}

export function refinementFields(refine) {
  if (refine === 'dc') return { dc: 'true' };
  if (refine === 'alpha') return { a: 'true' };
  if (refine === 'vitmatte') return { vm: 'true' };
  return {};
}

export function describeUpstreamFailure(status, bodyText = '') {
  const text = String(bodyText || '');
  if (/out of memory|cannot allocate|memoryerror|bad_alloc|oom-kill|oom killed|killed process/i.test(text)) {
    return MATTING_MESSAGES.oom;
  }
  if (status === 502 || status === 503 || status === 504) return MATTING_MESSAGES.overloaded;
  return MATTING_MESSAGES.rejected;
}

export function inputImageType(header) {
  const type = String(header || '').split(';')[0].trim().toLowerCase();
  const filename = INPUT_TYPES.get(type);
  return filename ? { type: type === 'image/jpg' ? 'image/jpeg' : type, filename } : null;
}
