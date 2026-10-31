import { apiRequest, ApiError } from '../components/api.js?v=1.7.0';
import { element, internalLink, pageHeading, statusBadge } from '../components/dom.js?v=1.4.0';
import { mediaImportHandoff, selectImportSources } from '../components/import-handoff.js?v=1.9.0';
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

function formatCount(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function renderMediaDownload({ module, session, signal }) {
  const page = element('div', { className: 'media-page page-enter' });
  const on = (node, type, listener) => node.addEventListener(type, listener, { signal });

  const paste = field('把小红书或抖音的分享文字粘贴到这里', '分享文字');
  const paste2 = field('把抖音分享链接或整段分享文字粘贴到这里', '抖音分享文字');
  paste.id = 'media-paste';
  paste2.id = 'media-paste-entry2';
  const pasteButton = actionButton('粘贴', 'btn btn-outline-primary media-paste-button');
  const pasteButton2 = actionButton('粘贴', 'btn btn-outline-primary media-paste-button');
  const parseButton = actionButton('解析', 'btn btn-primary media-parse-button', 'submit');
  const parseButton2 = actionButton('查看清晰度', 'btn btn-primary media-parse-button', 'submit');
  const detection = liveText('粘贴后会自动识别平台。', 'media-detect');
  const detection2 = liveText('入口 2 只解析抖音视频，不使用 Cookie。', 'media-detect');
  const alert = errorBox();
  const alert2 = errorBox();
  const xhsBadge = healthBadge('小红书');
  const douyinBadge = healthBadge('抖音');
  const results = element('div', { className: 'media-results' });
  const results2 = element('div', { className: 'media-results' });
  const history = element('div', { className: 'media-history-list' });
  const health = element('div', { className: 'media-health', attributes: { role: 'status', 'aria-label': '解析服务状态' } }, [xhsBadge, douyinBadge]);
  const tab1 = entryTab('入口 1', 'DouK', true);
  const tab2 = entryTab('入口 2', '免 Cookie', false);
  const entry1 = element('div', { className: 'media-entry', attributes: { 'data-entry': '1', role: 'tabpanel' } });
  const entry2 = element('div', { className: 'media-entry', attributes: { 'data-entry': '2', role: 'tabpanel', hidden: '' } });
  const form = element('form', { className: 'media-form card' }, [
    element('div', { className: 'card-body' }, [
      labeledField('分享文字', paste),
      element('div', { className: 'media-actions' }, [pasteButton, parseButton]),
      detection,
      alert,
      element('p', { className: 'media-save-hint', text: 'iPhone 无法强制下载：长按图片保存 / 视频点分享→存储。' }),
    ]),
  ]);
  const form2 = element('form', { className: 'media-form card' }, [
    element('div', { className: 'card-body' }, [
      labeledField('抖音分享文字', paste2),
      element('div', { className: 'media-actions' }, [pasteButton2, parseButton2]),
      detection2,
      alert2,
      element('p', { className: 'media-entry-note', text: '直接向抖音请求清晰度。不使用抖音 Cookie，也不经过本机 DouK。失败时请改用入口 1。' }),
      element('p', { className: 'media-save-hint', text: 'iPhone 无法强制下载：长按图片保存 / 视频点分享→存储。' }),
    ]),
  ]);
  entry1.append(health, form, results);
  entry2.append(form2, results2);

  page.append(
    internalLink('/tools', '← 工具箱', 'text-link back-link'),
    pageHeading(
      module?.title || '无水印下载',
      '粘贴分享文字后保存。抖音可以走入口 1（DouK）或入口 2（不需要 Cookie）。',
      statusBadge(module?.status || 'ready'),
    ),
    element('div', { className: 'media-entries', attributes: { role: 'tablist', 'aria-label': '抖音下载入口' } }, [tab1, tab2]),
    entry1,
    entry2,
    element('section', { className: 'media-history card' }, [
      element('div', { className: 'card-body' }, [
        element('h2', { className: 'card-title', text: '最近解析' }),
        history,
      ]),
    ]),
    element('p', { className: 'media-note', text: '仅供个人保存自己或已获授权的内容。' }),
  );

  on(paste, 'input', () => showDetection(1));
  on(paste, 'paste', () => setTimeout(() => showDetection(1), 0));
  on(paste2, 'input', () => showDetection(2));
  on(paste2, 'paste', () => setTimeout(() => showDetection(2), 0));
  on(pasteButton, 'click', () => pasteClipboard(paste, 1, alert));
  on(pasteButton2, 'click', () => pasteClipboard(paste2, 2, alert2));
  on(tab1, 'click', () => showEntry(1));
  on(tab2, 'click', () => showEntry(2));
  on(form, 'submit', (event) => {
    event.preventDefault();
    parseShare();
  });
  on(form2, 'submit', (event) => {
    event.preventDefault();
    parseEntry2();
  });
  renderHistory();
  loadHealth();
  return page;

  function field(placeholder, label) {
    return element('textarea', {
      className: 'form-control media-paste',
      attributes: {
        rows: '6',
        placeholder,
        'aria-label': label,
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        autocomplete: 'off',
      },
    });
  }

  function actionButton(text, className, type = 'button') {
    return element('button', { className, text, attributes: { type } });
  }

  function liveText(text, className) {
    return element('p', { className, attributes: { role: 'status', 'aria-live': 'polite' }, text });
  }

  function errorBox() {
    return element('div', { className: 'alert alert-danger media-alert', attributes: { role: 'alert', hidden: '' } });
  }

  function labeledField(label, node) {
    const id = node.id || '';
    return element('div', { className: 'media-field' }, [
      element('label', { className: 'form-label', text: label, attributes: id ? { for: id } : {} }),
      node,
    ]);
  }

  function entryTab(name, hint, selected) {
    return element('button', {
      className: 'media-entry-tab',
      attributes: { type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false' },
    }, [
      element('span', { className: 'media-entry-name', text: name }),
      element('span', { className: 'media-entry-hint', text: hint }),
    ]);
  }

  function showEntry(entry) {
    const second = entry === 2;
    tab1.setAttribute('aria-selected', second ? 'false' : 'true');
    tab2.setAttribute('aria-selected', second ? 'true' : 'false');
    entry1.hidden = second;
    entry2.hidden = !second;
    if (second) paste2.focus();
    else paste.focus();
  }

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

  function showDetection(entry) {
    const box = entry === 2 ? paste2 : paste;
    const output = entry === 2 ? detection2 : detection;
    const target = extractShareTarget(box.value);
    if (!target) {
      output.textContent = box.value.trim()
        ? (entry === 2 ? '还没有识别到抖音链接。' : '还没有识别到小红书或抖音链接。')
        : (entry === 2 ? '入口 2 只解析抖音视频，不使用 Cookie。' : '粘贴后会自动识别平台。');
      return;
    }
    if (entry === 2 && target.platform !== 'douyin') {
      output.textContent = '入口 2 只接受抖音链接。小红书请用入口 1。';
      return;
    }
    const label = PLATFORM_LABEL[target.platform] || target.platform;
    output.textContent = xhsLinkNeedsToken(target.url)
      ? `已识别为${label}。这条链接没有 xsec_token，用 App 里的完整分享更稳妥。`
      : `已识别为${label}。`;
  }

  function setAlert(node, message) {
    node.hidden = !message;
    node.textContent = message || '';
  }

  function setBusy(button, pasteControl, formNode, busy, idleText) {
    button.disabled = busy;
    pasteControl.disabled = busy;
    button.textContent = busy ? '正在解析…' : idleText;
    formNode.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function pasteClipboard(box, entry, alertNode) {
    try {
      const text = await navigator.clipboard.readText();
      if (signal.aborted) return;
      box.value = text;
      showDetection(entry);
      box.focus();
    } catch {
      setAlert(alertNode, '当前浏览器不允许读取剪贴板，请在输入框里长按粘贴。');
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
    setAlert(alert, '');
    const text = paste.value.trim();
    if (!text) {
      setAlert(alert, '请先粘贴分享内容。');
      return;
    }
    setBusy(parseButton, pasteButton, form, true, '解析');
    results.replaceChildren();
    try {
      const work = await apiRequest('/api/media/parse', {
        method: 'POST',
        csrfToken: session.csrfToken,
        body: { text },
        signal,
      });
      if (signal.aborted) return;
      renderWork(results, work);
      remember(text, work, 1);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || (error instanceof ApiError && error.status === 401)) return;
      setAlert(alert, error instanceof ApiError && error.message && error.message !== 'Request failed'
        ? error.message
        : '解析失败，请稍后再试。');
    } finally {
      if (!signal.aborted) setBusy(parseButton, pasteButton, form, false, '解析');
    }
  }

  async function parseEntry2() {
    setAlert(alert2, '');
    const text = paste2.value.trim();
    if (!text) {
      setAlert(alert2, '请先粘贴分享内容。');
      return;
    }
    const target = extractShareTarget(text);
    if (!target || target.platform !== 'douyin') {
      setAlert(alert2, '入口 2 只接受抖音分享链接。');
      return;
    }
    setBusy(parseButton2, pasteButton2, form2, true, '查看清晰度');
    results2.replaceChildren();
    try {
      const work = await apiRequest('/api/media/douyin/entry2', {
        method: 'POST',
        csrfToken: session.csrfToken,
        body: { text },
        signal,
      });
      if (signal.aborted) return;
      renderQualities(work);
      remember(text, work, 2);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || (error instanceof ApiError && error.status === 401)) return;
      setAlert(alert2, error instanceof ApiError && error.message && error.message !== 'Request failed'
        ? error.message
        : '入口 2 解析失败。请改用入口 1。');
    } finally {
      if (!signal.aborted) setBusy(parseButton2, pasteButton2, form2, false, '查看清晰度');
    }
  }

  function remember(text, work, entry) {
    const next = [
      {
        text: text.slice(0, 500),
        title: work.title || '未命名作品',
        platform: work.platform,
        entry,
        at: Date.now(),
      },
      ...readHistory().filter((item) => item.text !== text || item.entry !== entry),
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
      const entry = item.entry === 2 ? 2 : 1;
      const button = element('button', {
        className: 'btn btn-outline-secondary media-history-button',
        attributes: { type: 'button' },
      }, [
        element('span', { className: 'media-history-platform', text: `${entry === 2 ? '入口 2' : '入口 1'} · ${PLATFORM_LABEL[item.platform] || '链接'}` }),
        element('span', { className: 'media-history-title', text: item.title }),
      ]);
      on(button, 'click', () => {
        showEntry(entry);
        const box = entry === 2 ? paste2 : paste;
        box.value = item.text;
        showDetection(entry);
        box.focus();
      });
      history.append(button);
    }
  }

  function renderQualities(work) {
    const qualities = Array.isArray(work?.qualities) ? work.qualities : [];
    const count = Number.isSafeInteger(work?.playCount) ? `播放 ${formatCount(work.playCount)}` : '';
    const heading = element('div', { className: 'media-result-head' }, [
      element('p', { className: 'media-platform', text: '抖音 · 入口 2' }),
      element('h2', { className: 'media-title', text: work.title || '未命名作品' }),
      work.author ? element('p', { className: 'media-author text-secondary', text: work.author }) : null,
      count ? element('p', { className: 'media-author text-secondary', text: count }) : null,
    ]);
    const chosen = element('div', { className: 'media-chosen' });
    const list = element('div', { className: 'media-quality-list', attributes: { role: 'listbox', 'aria-label': '清晰度' } });
    for (const quality of qualities) {
      const button = element('button', {
        className: 'btn btn-outline-secondary media-quality',
        attributes: { type: 'button', role: 'option', 'aria-selected': 'false' },
      }, [
        element('span', { className: 'media-quality-label', text: quality.label || '视频' }),
        quality.gearName ? element('span', { className: 'media-quality-gear', text: quality.gearName }) : null,
      ]);
      on(button, 'click', () => selectQuality(list, button, chosen, quality, work.title));
      list.append(button);
    }
    results2.replaceChildren(element('section', { className: 'card media-result-card' }, [
      element('div', { className: 'card-body' }, [
        heading,
        importChooser(work),
        element('p', { className: 'media-entry-note', text: '选择一个清晰度后再播放或保存。文件经本站转发，不会直接打开抖音 CDN。' }),
        list,
        chosen,
      ]),
    ]));
  }

  function selectQuality(list, button, chosen, quality, title) {
    for (const node of list.querySelectorAll('.media-quality')) {
      node.setAttribute('aria-selected', 'false');
      node.classList.remove('is-selected');
    }
    button.setAttribute('aria-selected', 'true');
    button.classList.add('is-selected');
    chosen.replaceChildren(renderItem({
      kind: 'video',
      url: quality.url,
      thumb: quality.thumb,
      name: quality.name,
    }, 0, title));
  }

  function renderWork(root, work) {
    const items = Array.isArray(work?.items) ? work.items : [];
    const heading = element('div', { className: 'media-result-head' }, [
      element('p', { className: 'media-platform', text: PLATFORM_LABEL[work.platform] || '' }),
      element('h2', { className: 'media-title', text: work.title || '未命名作品' }),
      work.author ? element('p', { className: 'media-author text-secondary', text: work.author }) : null,
    ]);
    const chooser = importChooser(work);
    const all = items.length > 1
      ? element('button', {
        className: 'btn btn-primary media-download-all',
        text: '全部下载',
        attributes: { type: 'button' },
      })
      : null;
    if (all) on(all, 'click', () => downloadAll(root, items, all, work.title));
    const grid = element('div', {
      className: work.type === 'video' && items.length === 1 ? 'media-single' : 'media-grid',
      attributes: { 'data-count': String(items.length) },
    });
    items.forEach((item, index) => grid.append(renderItem(item, index, work.title)));
    const progress = element('p', { className: 'media-progress', attributes: { role: 'status', 'aria-live': 'polite' } });
    root.replaceChildren(element('section', { className: 'card media-result-card' }, [
      element('div', { className: 'card-body' }, [heading, chooser, all, grid, progress]),
    ]));
  }

  function importChooser(work) {
    const plan = selectImportSources(work);
    const note = element('p', {
      className: 'media-import-note',
      attributes: { role: 'status', 'aria-live': 'polite' },
    });
    if (!plan.items.length) {
      if (!plan.skippedVideos) return null;
      note.textContent = '这条是视频，没有可导入的封面。视频文件不会送去处理。';
      return element('div', { className: 'media-import' }, [note]);
    }
    const count = plan.items.length > 1 ? ` · ${plan.items.length}` : '';
    const hints = ['选择处理方式。图片会带到下一页，不用重新上传。'];
    if (plan.kind === 'covers') hints.unshift('这是视频，只带封面，不带视频文件。');
    else if (plan.skippedVideos) hints.push('视频已跳过。');
    if (plan.truncated) hints.push(`一次最多 ${plan.items.length} 张，多出的 ${plan.omitted} 张不会带上。`);
    const actions = element('div', { className: 'media-import-actions' }, [
      modeLink('white', `去白底${count}`),
      modeLink('smart', `智能抠图${count}`),
    ]);
    return element('div', { className: 'media-import', attributes: { role: 'group', 'aria-label': '选择导入方式' } }, [
      element('p', { className: 'media-import-label', text: '送到图片工具' }),
      actions,
      element('p', { className: 'media-import-hint', text: hints.join('') }),
      note,
    ]);

    function modeLink(mode, label) {
      const link = element('a', {
        className: `btn media-import-mode ${mode === 'smart' ? 'btn-primary' : 'btn-outline-primary'}`,
        text: label,
        attributes: { href: '/tools/remove-background', 'data-internal-link': '' },
      });
      on(link, 'click', (event) => {
        const staged = mediaImportHandoff.stage(work, mode);
        if (!staged.ok) {
          event.preventDefault();
          event.stopPropagation();
          note.textContent = '无法暂存图片列表，请直接在图片工具里上传。';
        }
      });
      return link;
    }
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

  async function downloadAll(root, items, button, title) {
    button.disabled = true;
    const progress = root.querySelector('.media-progress');
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
