import { element, pageHeading, statusBadge, internalLink } from '../components/dom.js?v=1.2.0';
import { icon } from '../components/icons.js?v=1.2.0';

export function renderPlaceholder({ module }) {
  return element('div', { className: 'placeholder-page page-enter' }, [
    internalLink(module.group === 'tools' ? '/tools' : '/', module.group === 'tools' ? '← 工具箱' : '← 概览', 'text-link back-link'),
    pageHeading(module.title, module.description || '为常用能力，留好位置。', statusBadge(module.status)),
    element('section', { className: 'empty-state tool-empty-state' }, [
      icon(module.id, 'empty-icon'),
      element('h2', { text: '这个工具还在规划中。' }),
      element('p', { text: '功能开放后，你可以在这里使用。当前页面仅展示工具介绍。' }),
      internalLink('/tools', '返回工具箱 →'),
    ]),
  ]);
}
