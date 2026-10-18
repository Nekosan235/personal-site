import { apiRequest, ApiError } from '../components/api.js?v=1.7.0';
import { element, internalLink, pageHeading, statusBadge } from '../components/dom.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.7.0';
import { extractShareTarget, xhsLinkNeedsToken } from '../components/media-links.js?v=1.7.0';

const HISTORY_KEY = 'personal-site.media-history';
const PLATFORM_LABEL = { xiaohongshu: '小红书', douyin: '抖音' };
const HEALTH_LABEL = {
  ok: '在线',
  down: '离线',
  missing_token: '未配置令牌',
  token_rejected: '令牌无效',
  token_file: '令牌不可读',
};

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.text === 'string' && typeof item.title === 'string').slice(0, 10);
  } catch {
    return [];
  }
}

function writeHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 10)));
}

function downloadHref(url) {
  return `${url}${url.includes('?') ? '&' : '?'}dl=1`;
}

function safeMediaPath(value) {
  return typeof value === 'string' && value.startsWith('/api/media/file?') ? value : '';
}

export function renderMediaDownload({ module, session, signal }) {
  const page = element('div', { className: 'media-page page-enter' });
  const on = (node, type, listener) => node.addEventListener(type, listener, { signal });
  const paste = element('textarea', {
    className: 'form-control media-paste',
    attributes: {
      rows: '6',
      placeholder: '把小红书或抖音的分享文字粘贴到这里',
      'aria-label': '分享文字',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      autocomplete: 'off',
    },
  });
  const pasteButton = element('button', {
    className: 'btn btn-outline-primary media-paste-button',
    text: '粘贴',
    attributes: { type: 'button' },
  });
  const parseButton = element('button', {
    className: 'btn btn-primary media-parse-button',
    text: '解析',
    attributes: { type: 'submit' },
  });
  const detection = element('p', {
    className: 'media-detect',
    attributes: { role: 'status', 'aria-live': 'polite' },
    text: '粘贴后会自动识别平台。',
  });
  const alert = element('div', {
    className: 'alert alert-danger media-alert',
    attributes: { role: 'alert', hidden: '' },
  });
  const xhsBadge = healthBadge('小红书');
  const douyinBadge = healthBadge('抖音');
  const results = element('div', { className: 'media-results' });
  const history = element('div', { className: 'media-history-list' });
  const form = element('form', { className: 'media-form card' }, [
    element('div', { className: 'card-body' }, [
      element('label', { className: 'form-label', text: '分享文字', attributes: { for: 'media-paste' } }),
      paste,
      element('div', { className: 'media-actions' }, [pasteButton, parseButton]),
      detection,
      alert,
      element('p', { className: 'media-save-hint', text: 'iPhone 无法强制下载：长按图片保存 / 视频点分享→存储。' }),
    ]),
  ]);
  paste.id = 'media-paste';

  page.append(
    internalLink('/tools', '← 工具箱', 'text-link back-link'),
    pageHeading(
      module?.title || '无水印下载',
      '粘贴小红书或抖音的分享文字，解析图片和视频后保存到手机。',
      statusBadge(module?.status || 'ready'),
    ),
    element('div', { className: 'media-health', attributes: { role: 'status', 'aria-label': '解析服务状态' } }, [xhsBadge, douyinBadge]),
    form,
    results,
    element('section', { className: 'media-history card' }, [
      element('div', { className: 'card-body' }, [
        element('h2', { className: 'card-title', text: '最近解析' }),
        history,
      ]),
    ]),
    element('p', { className: 'media-note', text: '仅供个人保存自己或已获授权的内容。' }),
  );

  on(paste, 'input', showDetection);
  on(paste, 'paste', () => setTimeout(showDetection, 0));
  on(pasteButton, 'click', pasteClipboard);
  on(form, 'submit', (event) => {
    event.preventDefault();
    parseShare();
  });
  renderHistory();
  loadHealth();
  return page;

  function healthBadge(label) {
    return element('span', {
      className: 'badge media-health-badge',
      text: `${label} · 检测中`,
      attributes: { 'data-state': 'unknown' },
    });
  }

  function setBadge(node, label, status) {
    const reason = status?.ok ? 'ok' : (status?.reason || 'down');
    node.dataset.state = reason;
    node.textContent = `${label} · ${HEALTH_LABEL[reason] || '离线'}`;
  }

  function showDetection() {
    const target = extractShareTarget(paste.value);
    if (!target) {
      detection.textContent = paste.value.trim() ? '还没有识别到小红书或抖音链接。' : '粘贴后会自动识别平台。';
      return;
    }
    const label = PLATFORM_LABEL[target.platform] || target.platform;
    detection.textContent = xhsLinkNeedsToken(target.url)
      ? `已识别为${label}。这条链接没有 xsec_token，用 App 里的完整分享更稳妥。`
      : `已识别为${label}。`;
  }

  function setAlert(message) {
    alert.hidden = !message;
    alert.textContent = message || '';
  }

  function setBusy(busy) {
    parseButton.disabled = busy;
    pasteButton.disabled = busy;
    parseButton.textContent = busy ? '正在解析…' : '解析';
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (signal.aborted) return;
      paste.value = text;
      showDetection();
      paste.focus();
    } catch {
      setAlert('当前浏览器不允许读取剪贴板，请在输入框里长按粘贴。');
    }
  }

  async function loadHealth() {
    try {
      const status = await apiRequest('/api/media/health', { signal });
      if (signal.aborted) return;
      setBadge(xhsBadge, '小红书', status.xiaohongshu);
      setBadge(douyinBadge, '抖音', status.douyin);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || (error instanceof ApiError && error.status === 401)) return;
      setBadge(xhsBadge, '小红书', { ok: false, reason: 'down' });
      setBadge(douyinBadge, '抖音', { ok: false, reason: 'down' });
    }
  }

  async function parseShare() {
    setAlert('');
    const text = paste.value.trim();
    if (!text) {
      setAlert('请先粘贴分享内容。');
      return;
    }
    setBusy(true);
    results.replaceChildren();
    try {
      const work = await apiRequest('/api/media/parse', {
        method: 'POST',
        csrfToken: session.csrfToken,
        body: { text },
        signal,
      });
      if (signal.aborted) return;
      renderWork(work);
      remember(text, work);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || (error instanceof ApiError && error.status === 401)) return;
      setAlert(error instanceof ApiError && error.message && error.message !== 'Request failed'
        ? error.message
        : '解析失败，请稍后再试。');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  function remember(text, work) {
    const next = [
      { text: text.slice(0, 500), title: work.title || '未命名作品', platform: work.platform, at: Date.now() },
      ...readHistory().filter((item) => item.text !== text),
    ].slice(0, 10);
    writeHistory(next);
    renderHistory();
  }

  function renderHistory() {
    const items = readHistory();
    history.replaceChildren();
    if (!items.length) {
      history.append(element('p', { className: 'text-secondary media-history-empty', text: '解析成功后会留在这台手机上，最多 10 条。' }));
      return;
    }
    for (const item of items) {
      const button = element('button', {
        className: 'btn btn-outline-secondary media-history-button',
        attributes: { type: 'button' },
      }, [
        element('span', { className: 'media-history-platform', text: PLATFORM_LABEL[item.platform] || '链接' }),
        element('span', { className: 'media-history-title', text: item.title }),
      ]);
      on(button, 'click', () => {
        paste.value = item.text;
        showDetection();
        paste.focus();
      });
      history.append(button);
    }
  }

  function renderWork(work) {
    const items = Array.isArray(work?.items) ? work.items : [];
    const heading = element('div', { className: 'media-result-head' }, [
      element('p', { className: 'media-platform', text: PLATFORM_LABEL[work.platform] || '' }),
      element('h2', { className: 'media-title', text: work.title || '未命名作品' }),
      work.author ? element('p', { className: 'media-author text-secondary', text: work.author }) : null,
    ]);
    const all = items.length > 1
      ? element('button', {
        className: 'btn btn-primary media-download-all',
        text: '全部下载',
        attributes: { type: 'button' },
      })
      : null;
    if (all) on(all, 'click', () => downloadAll(items, all, work.title));
    const grid = element('div', {
      className: work.type === 'video' && items.length === 1 ? 'media-single' : 'media-grid',
      attributes: { 'data-count': String(items.length) },
    });
    items.forEach((item, index) => grid.append(renderItem(item, index, work.title)));
    const progress = element('p', { className: 'media-progress', attributes: { role: 'status', 'aria-live': 'polite' } });
    results.replaceChildren(element('section', { className: 'card media-result-card' }, [
      element('div', { className: 'card-body' }, [heading, all, grid, progress]),
    ]));
  }

  function renderItem(item, index, title) {
    const href = safeMediaPath(item.url);
    const thumb = safeMediaPath(item.thumb);
    const name = typeof item.name === 'string' && item.name ? item.name : `media-${index + 1}`;
    const frame = element('div', { className: item.kind === 'video' ? 'media-player-wrap' : 'media-thumb' });
    if (item.kind === 'video' && href) {
      const video = element('video', { className: 'media-player', attributes: { controls: '', playsinline: '', preload: 'metadata' } });
      video.setAttribute('webkit-playsinline', '');
      if (thumb) video.poster = thumb;
      video.src = href;
      frame.append(video);
    } else if (href) {
      const image = element('img', { attributes: { src: href, alt: title || '图片' } });
      const fallback = element('span', { className: 'media-fallback', text: '预览加载失败，仍可保存', attributes: { hidden: '' } });
      on(image, 'error', () => { image.hidden = true; fallback.hidden = false; });
      frame.append(image, fallback);
    } else {
      frame.append(element('span', { className: 'media-fallback', text: '没有可预览的文件' }));
    }
    const save = element('a', {
      className: 'btn btn-outline-primary media-save',
      text: '保存',
      attributes: { href: href ? downloadHref(href) : '#', download: name, rel: 'noopener' },
    });
    if (!href) save.setAttribute('aria-disabled', 'true');
    return element('article', { className: 'media-card' }, [frame, save]);
  }

  async function downloadAll(items, button, title) {
    button.disabled = true;
    const progress = results.querySelector('.media-progress');
    for (let index = 0; index < items.length; index += 1) {
      if (signal.aborted) return;
      if (progress) progress.textContent = `正在保存 ${index + 1}/${items.length}`;
      const href = safeMediaPath(items[index].url);
      if (!href) continue;
      const link = document.createElement('a');
      link.href = downloadHref(href);
      link.download = typeof items[index].name === 'string' ? items[index].name : `media-${index + 1}`;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    if (progress) progress.textContent = '已逐个开始保存。若浏览器拦截了多个文件，请逐张点保存。';
    button.disabled = false;
    if (title) button.setAttribute('aria-label', `全部下载 ${title}`);
  }
}
