export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export function internalLink(path, text, className = 'text-link') {
  return element('a', {
    className,
    text,
    attributes: { href: path, 'data-internal-link': '' },
  });
}

export function externalLink(href, text, className = 'text-link') {
  return element('a', {
    className,
    text,
    attributes: {
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `${text}（在新标签页打开）`,
    },
  });
}

export function statusLabel(status) {
  if (status === 'ready') return '可用';
  if (status === 'planned') return '规划中';
  return '暂未开放';
}

export function statusBadge(status) {
  return element('span', {
    className: `status-badge badge ${status === 'ready' ? 'status-ready bg-green-lt' : 'status-planned bg-secondary-lt'}`,
    text: statusLabel(status),
  });
}

export function pageHeading(title, description, trailing) {
  return element('header', { className: 'page-heading page-header' }, [
    element('div', { className: 'page-heading-copy' }, [
      element('h1', { className: 'page-title', text: title }),
      element('p', { className: 'page-description text-secondary', text: description }),
    ]),
    trailing,
  ]);
}

export function safeExternalHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function safeInternalPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\?#\u0000-\u001f]/.test(value)) return null;
  return value.replace(/\/+$/, '') || '/';
}
