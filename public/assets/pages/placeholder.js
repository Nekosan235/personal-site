import { element, pageHeading, statusBadge, internalLink } from '../components/dom.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.4.0';

export function renderPlaceholder({ module }) {
  return element('div', { className: 'placeholder-page page-enter' }, [
    internalLink(module.group === 'tools' ? '/tools' : '/', module.group === 'tools' ? '← 工具箱' : '← 概览', 'text-link back-link'),
    pageHeading(module.title, module.description || '此功能尚未开放，当前仅展示介绍。', statusBadge(module.status)),
    element('section', { className: 'card' }, [
      element('div', { className: 'empty-state tool-empty-state card-body text-center' }, [
        icon(module.id, 'empty-icon icon mb-3'),
        element('h2', { className: 'card-title justify-content-center', text: '这个工具还在规划中' }),
        element('p', { className: 'text-secondary', text: '当前仅展示工具介绍，尚不提供上传或处理功能。' }),
        internalLink('/tools', '返回工具箱', 'text-link btn btn-outline-primary'),
      ]),
    ]),
  ]);
}
