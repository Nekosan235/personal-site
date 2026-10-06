const namespace = 'http://www.w3.org/2000/svg';
const paths = {
  'remove-background': [
    'M6 3H3v3M18 3h3v3M3 18v3h3M21 18v3h-3',
    'M16 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 20a7 7 0 0 1 14 0',
  ],
  'file-converter': ['M8 3h8l4 4v10H8V3ZM16 3v5h4', 'M4 7v14h12', 'M11 12h6M14 9l3 3-3 3'],
  agents: ['M9 5h6M12 2v3M5 8h14v12H5V8ZM2 12h3M19 12h3M8 20v2M16 20v2', 'M9 12h.01M15 12h.01M9 16h6'],
  unavailable: ['M12 3v7M12 14v.01', 'M20 21H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1Z'],
};

export function icon(name, className = 'line-icon') {
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  for (const data of paths[name] || paths.unavailable) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}
