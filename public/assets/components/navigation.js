import { element, internalLink, externalLink, safeExternalHref } from './dom.js?v=1.2.0';

export function createNavigation({ modules, username, onLogout, onAppearance }) {
  const brand = internalLink('/', '', 'brand');
  brand.setAttribute('aria-label', '个人空间首页');
  brand.append(
    element('img', { attributes: { src: '/assets/favicon.svg?v=1.2.0', alt: '', width: '28', height: '28' } }),
    element('span', { text: '个人空间' }),
  );
  const toggle = element('button', {
    className: 'menu-toggle button button-subtle',
    text: '菜单',
    attributes: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'main-navigation' },
  });
  const list = element('div', { className: 'nav-links' });
  const trackedLinks = [];
  for (const module of modules.filter((item) => item.nav)) {
    let link;
    if (module.external) {
      const href = safeExternalHref(module.href);
      if (!href) continue;
      link = externalLink(href, `${module.title} ↗`, 'nav-link');
    } else {
      if (!module.path?.startsWith('/') || module.path.startsWith('//')) continue;
      link = internalLink(module.path, module.title, 'nav-link');
      trackedLinks.push({ link, path: module.path });
    }
    list.append(link);
  }
  const logout = element('button', {
    className: 'logout-button button button-subtle',
    text: '退出登录',
    attributes: { type: 'button' },
  });
  const appearance = element('button', {
    className: 'appearance-button button button-subtle', text: '外观',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': '打开外观设置' },
  });
  appearance.addEventListener('click', () => onAppearance?.());
  const nav = element('nav', {
    className: 'main-navigation',
    attributes: { id: 'main-navigation', 'aria-label': '主导航' },
  }, [
    list,
    element('div', { className: 'nav-account' }, [
      element('span', { className: 'account-name', text: username, attributes: { 'aria-label': `当前账户：${username}` } }),
      appearance,
      logout,
    ]),
  ]);
  const header = element('header', { className: 'site-header' }, [
    element('div', { className: 'header-content container' }, [brand, toggle, nav]),
  ]);

  function closeMenu() {
    toggle.setAttribute('aria-expanded', 'false');
    nav.removeAttribute('data-open');
  }

  toggle.addEventListener('click', () => {
    const opening = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) nav.setAttribute('data-open', 'true');
    else closeMenu();
  });
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      toggle.focus();
    }
  });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    logout.textContent = '正在退出…';
    try {
      await onLogout();
    } finally {
      logout.disabled = false;
      logout.textContent = '退出登录';
    }
  });

  return {
    element: header,
    update(pathname) {
      for (const { link, path } of trackedLinks) {
        const active = pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      closeMenu();
    },
  };
}
