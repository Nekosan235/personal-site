import { element, pageHeading, statusBadge, internalLink } from '../components/dom.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.4.0';

export function renderAgents({ module }) {
  return element('div', { className: 'agents-page page-enter' }, [
    pageHeading(module.title, 'Agent 管理功能尚未开放。', statusBadge(module.status)),
    element('section', { className: 'card' }, [
      element('div', { className: 'empty-state agent-empty-state card-body text-center' }, [
        icon('agents', 'empty-icon icon mb-3'),
        element('h2', { className: 'card-title justify-content-center', text: 'Agent 管理仍在规划中' }),
        element('p', { className: 'text-secondary', text: '当前没有接入任何 Agent，也不提供创建或管理功能。' }),
        internalLink('/tools', '查看工具箱', 'text-link btn btn-outline-primary'),
      ]),
    ]),
  ]);
}
