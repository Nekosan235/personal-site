export class MediaError extends Error {
  constructor(message, statusCode = 400, code = 'parse_failed') {
    super(message);
    this.name = 'MediaError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const MEDIA_MESSAGES = {
  paste: '请先粘贴分享内容。',
  tooLong: '分享内容太长。',
  unreadable: '分享内容无法读取。',
  noLink: '没有识别到小红书或抖音链接。',
  rate: '请求太频繁，请稍后再试。',
  csrf: '请求未通过安全校验，请刷新页面后再试。',
  xhsTokenMissing: '未配置小红书访问令牌。',
  xhsTokenFileMissing: '小红书令牌文件不存在，请检查 XHS_API_TOKEN_FILE。',
  xhsTokenUnreadable: '无法读取小红书访问令牌，请检查令牌文件权限。',
  xhsTokenRejected: '下载服务拒绝了访问令牌，请检查 XHS_API_TOKEN。',
  douyinTokenRejected: '下载服务拒绝了访问令牌，请检查 DOUYIN_API_TOKEN。',
  generic: '作品解析失败，请稍后再试。',
  xhsDown: '小红书解析服务暂时不可用，请确认本机下载服务已启动。',
  douyinDown: '抖音解析服务暂时不可用，请确认本机下载服务已启动。',
  xhsFailed: '作品解析失败。请粘贴 App 分享里的完整链接（需包含有效的 xsec_token）。',
  xhsLink: '没有识别到有效的小红书作品链接。',
  douyinShare: '没有解析到抖音作品，请换一条分享链接再试。',
  douyinCookie: '抖音 Cookie 可能失效',
  noFile: '作品里没有可下载的文件。',
  outside: '下载地址不在允许的资源站范围内。',
  expired: '链接已过期，请重新解析。',
  invalidLink: '链接无效，请重新解析。',
  file: '文件暂时无法下载，请重新解析。',
  loopback: '解析服务只能使用本机地址。',
};
