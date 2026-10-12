import { element, internalLink, externalLink, safeExternalHref, safeInternalPath } from './dom.js?v=1.3.0';
import { icon } from './icons.js?v=1.3.0';

export function createNavigation({ modules, username, onLogout, onAppearance }) {
  const brand = internalLink('/', '', 'brand navbar-brand');
  brand.setAttribute('aria-label', '个人空间首页');
  brand.append(
    element('span', { className: 'brand-mark' }, [icon('dashboard', 'icon')]),
    element('span', {}, [element('strong', { text: '个人空间' }), element('small', { text: '设备与工具工作台' })]),
  );
  const toggle = element('button', {
    className: 'menu-toggle btn btn-icon btn-ghost-secondary',
    attributes: { type: 'button', 'aria-label': '打开导航菜单', 'aria-expanded': 'false', 'aria-controls': 'main-navigation' },
  }, [icon('menu', 'icon')]);
  const list = element('ul', { className: 'nav-links navbar-nav' });
  const trackedLinks = [];
  for (const module of modules.filter((item) => item.nav || item.id === 'dashboard')) {
    let link;
    if (module.external) {
      const href = safeExternalHref(module.href);
      if (!href) continue;
      link = externalLink(href, '', 'nav-link');
      link.setAttribute('aria-label', `${module.title}（在新标签页打开）`);
    } else {
      const path = safeInternalPath(module.path);
      if (!path) continue;
      link = internalLink(path, '', 'nav-link');
      trackedLinks.push({ link, path });
    }
    link.append(element('span', { className: 'nav-link-icon' }, [icon(module.id, 'icon')]),
      element('span', { className: 'nav-link-title', text: module.title }));
    if (module.external) link.append(icon('external', 'external-icon icon'));
    list.append(element('li', { className: 'nav-item' }, [link]));
  }
  const logoutLabel = element('span', { text: '退出登录' });
  const logout = element('button', {
    className: 'logout-button btn btn-ghost-secondary',
    attributes: { type: 'button' },
  }, [icon('logout', 'icon'), logoutLabel]);
  const appearance = element('button', {
    className: 'appearance-button btn btn-ghost-secondary',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': '打开外观设置' },
  }, [icon('appearance', 'icon'), element('span', { text: '外观设置' })]);
  appearance.addEventListener('click', () => {
    if (toggle.getAttribute('aria-expanded') === 'true') closeMenu({ restoreFocus: true });
    onAppearance?.();
  });
  const sidebarClose = element('button', {
    className: 'sidebar-close btn btn-icon btn-ghost-secondary',
    attributes: { type: 'button', 'aria-label': '关闭导航菜单' },
  }, [icon('close', 'icon')]);
  const sidebar = element('aside', {
    className: 'app-sidebar navbar navbar-vertical navbar-expand-lg',
    attributes: { id: 'main-navigation', 'aria-label': '工作台导航' },
  }, [
    element('div', { className: 'sidebar-brand' }, [brand, sidebarClose]),
    element('nav', { className: 'main-navigation', attributes: { 'aria-label': '主导航' } }, [list]),
    element('div', { className: 'sidebar-bottom' }, [
      element('div', { className: 'nav-account' }, [
        element('span', { className: 'avatar avatar-sm bg-blue-lt', text: [...String(username)][0]?.toUpperCase() || 'N', attributes: { 'aria-hidden': 'true' } }),
        element('div', { className: 'account-copy' }, [
          element('span', { className: 'account-name', text: username, attributes: { 'aria-label': `当前账户：${username}` } }),
          element('span', { className: 'account-caption', text: '个人账户' }),
        ]),
      ]),
      appearance, logout,
    ]),
  ]);
  const breadcrumb = element('span', { className: 'topbar-page', text: '概览' });
  const topbar = element('header', { className: 'app-topbar navbar' }, [
    element('div', { className: 'topbar-path' }, [toggle, element('span', { className: 'topbar-space', text: '工作台' }), icon('chevron', 'icon topbar-chevron'), breadcrumb]),
    element('span', { className: 'topbar-private' }, [icon('lock', 'icon'), element('span', { text: '私人空间' })]),
  ]);
  const backdrop = element('button', {
    className: 'sidebar-backdrop',
    attributes: { type: 'button', hidden: '', tabindex: '-1', 'aria-label': '关闭导航菜单' },
  });
  const shell = element('div', { className: 'navigation-shell' }, [sidebar, backdrop, topbar]);
  const content = document.querySelector('.page-wrapper');
  const desktop = window.matchMedia('(min-width: 992px)');

  function closeMenu({ restoreFocus = false } = {}) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', '打开导航菜单');
    sidebar.removeAttribute('data-open');
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    backdrop.hidden = true;
    if (content) content.inert = false;
    topbar.inert = false;
    document.body.removeAttribute('data-menu-open');
    if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-expanded') === 'true') { closeMenu(); return; }
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', '关闭导航菜单');
    sidebar.setAttribute('data-open', 'true');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    backdrop.hidden = false;
    if (content) content.inert = true;
    topbar.inert = true;
    document.body.setAttribute('data-menu-open', 'true');
    brand.focus();
  });
  sidebarClose.addEventListener('click', () => closeMenu({ restoreFocus: true }));
  backdrop.addEventListener('click', () => closeMenu({ restoreFocus: true }));
  shell.addEventListener('keydown', (event) => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu({ restoreFocus: true });
    } else if (event.key === 'Tab') {
      const controls = [...sidebar.querySelectorAll('a[href], button:not([disabled])')];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  });
  const handleBreakpoint = () => { if (desktop.matches) closeMenu(); };
  desktop.addEventListener('change', handleBreakpoint);
  logout.addEventListener('click', async () => {
    if (toggle.getAttribute('aria-expanded') === 'true') closeMenu({ restoreFocus: true });
    logout.disabled = true;
    logoutLabel.textContent = '正在退出…';
    try { await onLogout(); }
    finally { logout.disabled = false; logoutLabel.textContent = '退出登录'; }
  });

  return {
    element: shell,
    destroy() { desktop.removeEventListener('change', handleBreakpoint); closeMenu(); },
    update(pathname) {
      for (const { link, path } of trackedLinks) {
        const active = pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      const current = modules.find((module) => !module.external && module.path === pathname);
      breadcrumb.textContent = current?.title || '页面未找到';
      closeMenu();
    },
  };
}
