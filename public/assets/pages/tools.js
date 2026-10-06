import { element, pageHeading, internalLink, externalLink, statusBadge, safeExternalHref } from '../components/dom.js?v=1.2.0';
import { icon } from '../components/icons.js?v=1.2.0';

export function renderTools({ modules }) {
  const page = element('div', { className: 'tools-page page-enter' }, [
    pageHeading('工具箱', '把常用能力，放在顺手的位置。'),
  ]);
  const tools = modules.filter((module) => module.group === 'tools' && module.path);
  const grid = element('div', { className: 'tool-grid' });
  for (const tool of tools) {
    const link = internalLink(tool.path, '', 'tool-tile');
    link.append(
      element('div', { className: 'tool-tile-top' }, [icon(tool.id, 'tool-icon'), statusBadge(tool.status)]),
      element('h2', { text: tool.title }),
      element('p', { className: 'tool-description', text: tool.description || '查看这个工具的介绍与开放状态。' }),
      element('span', { className: 'tool-action', text: '了解更多 →' }),
    );
    grid.append(link);
  }
  if (tools.length) page.append(grid);
  else page.append(element('p', { className: 'data-notice', text: '这里暂时没有工具。' }));

  const codex = modules.find((module) => module.id === 'codex-web');
  const href = codex && safeExternalHref(codex.href);
  if (href) {
    page.append(element('section', { className: 'companion-section' }, [
      element('div', {}, [
        element('p', { className: 'eyebrow', text: '继续创作' }),
        element('h2', { text: codex.title }),
        element('p', { className: 'section-description', text: '在独立工作空间里，继续你的代码与项目。' }),
      ]),
      externalLink(href, '打开 Codex Web ↗', 'button button-secondary'),
    ]));
  }
  return page;
}
