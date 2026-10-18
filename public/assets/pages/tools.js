import { element, pageHeading, internalLink, externalLink, statusBadge, safeExternalHref, safeInternalPath } from '../components/dom.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.6.0';

export function renderTools({ modules }) {
  const page = element('div', { className: 'tools-page page-enter' }, [
    pageHeading('工具箱', '本地处理图片、动画和常见格式。素材只在你的浏览器中处理。'),
  ]);
  const tools = modules.filter((module) => module.group === 'tools' && safeInternalPath(module.path));
  const grid = element('div', { className: 'tool-grid' });
  for (const tool of tools) {
    const link = internalLink(safeInternalPath(tool.path), '', 'tool-tile card card-link');
    link.append(element('div', { className: 'card-body d-flex flex-column' }, [
      element('div', { className: 'tool-tile-top d-flex align-items-center justify-content-between mb-3' }, [
        icon(tool.id, 'tool-icon icon'), statusBadge(tool.status),
      ]),
      element('h2', { className: 'card-title', text: tool.title }),
      element('p', { className: 'tool-description text-secondary', text: tool.description || '查看这个工具的介绍与开放状态。' }),
      element('span', { className: 'tool-action text-primary mt-auto', text: tool.status === 'ready' ? '打开工具' : '查看介绍' }),
    ]));
    grid.append(link);
  }
  if (tools.length) page.append(grid);
  else page.append(element('p', { className: 'data-notice', text: '这里暂时没有工具。' }));

  const codex = modules.find((module) => module.id === 'codex-web');
  const href = codex && safeExternalHref(codex.href);
  if (href) {
    page.append(element('section', { className: 'card' }, [
      element('div', { className: 'companion-section card-body d-flex flex-wrap align-items-center justify-content-between gap-3' }, [
        element('div', {}, [
          element('h2', { className: 'card-title', text: codex.title }),
          element('p', { className: 'section-description text-secondary mb-0', text: '在新标签页打开独立的 Codex Web 工作空间。' }),
        ]),
        externalLink(href, '打开 Codex Web', 'button button-secondary btn btn-outline-primary'),
      ]),
    ]));
  }
  return page;
}
