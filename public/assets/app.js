import { apiRequest, ApiError } from './components/api.js?v=1.7.0';
import { createNavigation } from './components/navigation.js?v=1.10.0';
import { element, internalLink, pageHeading, safeInternalPath, safeExternalHref } from './components/dom.js?v=1.4.0';
import { errorView, loadingView } from './components/feedback.js?v=1.4.0';
import { renderDashboard } from './pages/dashboard.js?v=1.11.0';
import { renderPortfolio } from './pages/portfolio.js?v=1.11.0';
import { renderTools } from './pages/tools.js?v=1.8.0';
import { renderAgents } from './pages/agents.js?v=1.4.0';
import { renderPlaceholder } from './pages/placeholder.js?v=1.4.0';
import { renderRemoveBackground } from './pages/remove-background.js?v=1.5.0';
import { renderGifEditor } from './pages/gif-editor.js?v=1.5.0';
import { renderFileConverter } from './pages/file-converter.js?v=1.6.0';
import { renderMediaDownload } from './pages/media-download.js?v=1.9.0';
import { renderTerminal } from './pages/terminal.js?v=1.10.0';
import { createThemeController } from './components/theme.js?v=1.4.0';
import { createAppearanceSettings } from './components/appearance.js?v=1.6.0';

const main = document.querySelector('#main-content');
const navigationRoot = document.querySelector('#navigation-root');
const notice = document.querySelector('#app-notice');
const pageRegistry = new Map([
  ['dashboard', renderDashboard],
  ['work', renderPortfolio],
  ['work-honors', renderPortfolio],
  ['forest-drone', renderPortfolio],
  ['hydrogen', renderPortfolio],
  ['servo-screw', renderPortfolio],
  ['inovance-vision', renderPortfolio],
  ['mcu-music', renderPortfolio],
  ['advantech-elevator', renderPortfolio],
  ['ican-elevator', renderPortfolio],
  ['tools', renderTools],
  ['agents', renderAgents],
  ['remove-background', renderRemoveBackground],
  ['gif-editor', renderGifEditor],
  ['file-converter', renderFileConverter],
  ['media-download', renderMediaDownload],
  ['terminal', renderTerminal],
]);
let session;
let modules = [];
let navigation;
let currentRequest;
let bootstrapPending = false;
const theme = createThemeController();
const appearance = createAppearanceSettings(theme);
document.body.append(appearance.element);

function pathname() {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = !message;
}

function routeNotFound() {
  return element('div', { className: 'page-enter' }, [
    pageHeading('这个页面不在这里。', '从概览出发，重新找到你需要的内容。'),
    internalLink('/', '返回概览 →'),
  ]);
}

async function renderRoute({ focus = false } = {}) {
  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  const path = pathname();
  const module = modules.find((item) => !item.external && item.path === path);
  navigation?.update(path);
  main.setAttribute('aria-busy', 'true');
  main.replaceChildren(loadingView());
  showNotice('');

  try {
    const render = module ? pageRegistry.get(module.id) || renderPlaceholder : null;
    const view = render ? await render({ module, modules, session, signal: request.signal }) : routeNotFound();
    if (request.signal.aborted) return;
    main.replaceChildren(view);
    document.title = `${module?.title || '页面未找到'} · 个人空间`;
    if (focus) main.focus({ preventScroll: true });
  } catch (error) {
    if (request.signal.aborted || error.name === 'AbortError' || (error instanceof ApiError && error.status === 401)) return;
    main.replaceChildren(errorView(() => renderRoute({ focus: true })));
    document.title = '载入失败 · 个人空间';
  } finally {
    if (currentRequest === request && !request.signal.aborted) main.removeAttribute('aria-busy');
  }
}

async function logout() {
  currentRequest?.abort();
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', csrfToken: session.csrfToken, body: {} });
    window.location.assign('/login');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    await renderRoute();
    showNotice('暂时无法退出登录，请稍后重试。');
  }
}

async function bootstrap() {
  if (bootstrapPending) return;
  bootstrapPending = true;
  main.setAttribute('aria-busy', 'true');
  main.replaceChildren(loadingView());
  try {
    session = await apiRequest('/api/session');
    const catalog = await apiRequest('/api/modules');
    if (!session?.user?.username || !session.csrfToken || !Array.isArray(catalog.modules)) {
      throw new Error('Invalid session or catalog');
    }
    modules = catalog.modules
      .filter((module) => module && typeof module.id === 'string' && typeof module.title === 'string')
      .map((module) => module.external
        ? { ...module, href: safeExternalHref(module.href) }
        : { ...module, path: safeInternalPath(module.path) })
      .filter((module) => module.external ? module.href : module.path);
    navigation?.destroy?.();
    navigation = createNavigation({ modules, username: session.user.username, onLogout: logout, onAppearance: appearance.open });
    navigationRoot.replaceChildren(navigation.element);
    await renderRoute();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    main.replaceChildren(errorView(bootstrap));
    main.removeAttribute('aria-busy');
  } finally {
    bootstrapPending = false;
  }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-internal-link]');
  if (!link || !session || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  event.preventDefault();
  if (url.pathname !== window.location.pathname) history.pushState({}, '', url.pathname);
  renderRoute({ focus: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
});

window.addEventListener('popstate', () => {
  if (session) renderRoute({ focus: true });
});

bootstrap();
