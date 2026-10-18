import { assertText } from './limits.js';

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeHref(url) {
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return null;
    return url;
  } catch {
    return null;
  }
}

function inline(source) {
  let html = '';
  let rest = source;
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)\s]+)\))/;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) {
      html += escapeHtml(rest);
      break;
    }
    html += escapeHtml(rest.slice(0, match.index));
    if (match[1]) html += `<code>${escapeHtml(match[1].slice(1, -1))}</code>`;
    else if (match[2]) html += `<strong>${escapeHtml(match[2].slice(2, -2))}</strong>`;
    else if (match[3]) html += `<em>${escapeHtml(match[3].slice(1, -1))}</em>`;
    else {
      const href = safeHref(match[6]);
      const label = escapeHtml(match[5]);
      html += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return html;
}

export function markdownToHtml(markdown) {
  const lines = assertText(markdown, 'Markdown').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith('>')) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*[-*]\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s|```|>\s?|[-*]\s|\d+\.\s)/.test(lines[index]) && !/^(-{3,}|\*{3,})$/.test(lines[index].trim())) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return blocks.join('\n');
}

export function markdownToHtmlDocument(markdown) {
  const body = markdownToHtml(markdown);
  return `<!doctype html>\n<html lang="zh-CN">\n<meta charset="utf-8">\n<title>Markdown</title>\n<body>\n${body}\n</body>\n</html>\n`;
}

export function previewPlain(text) {
  return assertText(text, '文档').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
