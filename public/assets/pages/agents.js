import { element, pageHeading, statusBadge, internalLink } from '../components/dom.js?v=1.2.0';
import { icon } from '../components/icons.js?v=1.2.0';

export function renderAgents({ module }) {
  return element('div', { className: 'agents-page page-enter' }, [
    pageHeading(module.title, '给未来的助手，留好位置。', statusBadge(module.status)),
    element('section', { className: 'empty-state agent-empty-state' }, [
      icon('agents', 'empty-icon'),
      element('h2', { text: '这里还没有 Agent。' }),
      element('p', { text: '这个模块还在规划中。之后可以在这里集中查看和管理你的 Agent。' }),
      internalLink('/tools', '先去看看工具箱 →'),
    ]),
  ]);
}
