import { assertText } from './limits.js';

const CASES = new Set(['keep', 'upper', 'lower', 'title']);
const SPACES = new Set(['keep', 'trim', 'trim-lines', 'collapse']);
const NEWLINES = new Set(['keep', 'lf', 'crlf']);

function splitLines(value) {
  return value.split(/\r\n|\n|\r/);
}

function lineEnding(value) {
  return value.includes('\r\n') ? '\r\n' : '\n';
}

export function transformText(input, options = {}) {
  const letter = options.letter || 'keep';
  const space = options.space || 'keep';
  const newline = options.newline || 'keep';
  if (!CASES.has(letter)) throw new Error('未知的大小写转换。');
  if (!SPACES.has(space)) throw new Error('未知的空白转换。');
  if (!NEWLINES.has(newline)) throw new Error('未知的换行转换。');
  if (letter === 'keep' && space === 'keep' && newline === 'keep') throw new Error('请至少选择一种文本转换。');

  let value = assertText(input, '文本');
  if (newline === 'lf') value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  else if (newline === 'crlf') value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');

  if (space === 'trim') value = value.trim();
  else if (space === 'trim-lines' || space === 'collapse') {
    const ending = lineEnding(value);
    value = splitLines(value)
      .map((line) => (space === 'collapse' ? line.replace(/[ \t\f\v]+/g, ' ').trim() : line.trim()))
      .join(ending);
  }

  if (letter === 'upper') value = value.toLocaleUpperCase('en-US');
  else if (letter === 'lower') value = value.toLocaleLowerCase('en-US');
  else if (letter === 'title') {
    value = value.toLocaleLowerCase('en-US').replace(/\p{L}+/gu, (word) => word.charAt(0).toLocaleUpperCase('en-US') + word.slice(1));
  }
  return value;
}
