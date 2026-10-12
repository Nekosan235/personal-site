const namespace = 'http://www.w3.org/2000/svg';
const paths = {
  dashboard: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  tools: ['M4 7h16v13H4zM9 7V4h6v3M4 12h16M10 12v3h4v-3'],
  'codex-web': ['M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  close: ['M6 6l12 12M18 6L6 18'],
  appearance: ['M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  logout: ['M10 5H5v14h5M9 12h12M17 8l4 4-4 4'],
  chevron: ['M9 6l6 6-6 6'],
  external: ['M14 3h7v7M21 3l-9 9M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6'],
  lock: ['M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3'],
  server: ['M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6'],
  'remove-background': [
    'M6 3H3v3M18 3h3v3M3 18v3h3M21 18v3h-3',
    'M16 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 20a7 7 0 0 1 14 0',
  ],
  'gif-editor': ['M3 5h18v14H3zM7 9h3M7 12h3M7 15h3M14 9l4 3-4 3z'],
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
