import { element } from './dom.js?v=1.3.0';
import { icon } from './icons.js?v=1.3.0';

export function loadingView() {
  return element('div', { className: 'page-loading', attributes: { role: 'status' } }, [
    element('span', { className: 'loading-indicator', attributes: { 'aria-hidden': 'true' } }),
    element('p', { text: '正在载入…' }),
  ]);
}

export function errorView(onRetry) {
  const button = element('button', {
    className: 'btn btn-primary',
    text: '重新加载',
    attributes: { type: 'button' },
  });
  button.addEventListener('click', onRetry);
  return element('section', { className: 'empty-state', attributes: { role: 'alert' } }, [
    icon('unavailable', 'empty-icon'),
    element('h1', { text: '页面暂时无法加载。' }),
    element('p', { text: '稍后再试一次，你的空间仍在这里。' }),
    button,
  ]);
}
