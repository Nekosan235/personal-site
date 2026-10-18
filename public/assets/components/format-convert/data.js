import { LIMITS, assertText } from './limits.js';

const TRUE_WORDS = new Set(['true', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'off']);
const NULL_WORDS = new Set(['null', '~']);

function parseJson(text, label = 'JSON') {
  try {
    return JSON.parse(assertText(text, label));
  } catch (error) {
    if (error instanceof TypeError || /不能超过/.test(error.message)) throw error;
    throw new Error('JSON 无法解析。');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function quoteYaml(value) {
  let out = '"';
  for (const char of value) {
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += char;
  }
  return `${out}"`;
}

function yamlScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('YAML 不能表示非有限数字。');
    return String(value);
  }
  if (typeof value !== 'string') throw new Error('YAML 只能转换 JSON 数据。');
  if (value === '' || /^(?:true|false|null|yes|no|on|off|~)$/i.test(value)) return quoteYaml(value);
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return quoteYaml(value);
  if (/^\s|\s$|[\n\r\t:#{}[\],&*!|>%@`"']/.test(value) || value.includes(': ')) return quoteYaml(value);
  return value;
}

function yamlKey(value) {
  if (typeof value !== 'string' || value === '' || /[\n\r:#{}[\],&*!|>%@`"']/.test(value) || /^\s|\s$/.test(value)) return quoteYaml(String(value));
  return value;
}

function isEmptyCollection(value) {
  return (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);
}

function emitYaml(value, indent) {
  if (!isPlainObject(value) && !Array.isArray(value)) return yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => emitListItem(item, indent)).join('\n');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return entries.map(([key, child]) => emitKey(key, child, indent)).join('\n');
}

function emitListItem(item, indent) {
  const pad = ' '.repeat(indent);
  if (!isPlainObject(item) || Object.keys(item).length === 0) {
    const rendered = emitYaml(item, indent + 2);
    if (!rendered.includes('\n')) return `${pad}- ${rendered}`;
    return `${pad}-\n${rendered}`;
  }
  const entries = Object.entries(item);
  const [firstKey, firstValue] = entries[0];
  const lines = [];
  const nested = emitYaml(firstValue, indent + 4);
  if (!nested.includes('\n')) lines.push(`${pad}- ${yamlKey(firstKey)}: ${nested}`);
  else lines.push(`${pad}- ${yamlKey(firstKey)}:\n${nested}`);
  for (const [key, child] of entries.slice(1)) lines.push(emitKey(key, child, indent + 2));
  return lines.join('\n');
}

function emitKey(key, child, indent) {
  const pad = ' '.repeat(indent);
  const rendered = emitYaml(child, indent + 2);
  if (!rendered.includes('\n') && (!isPlainObject(child) && !Array.isArray(child) || isEmptyCollection(child))) {
    return `${pad}${yamlKey(key)}: ${rendered}`;
  }
  return `${pad}${yamlKey(key)}:\n${rendered}`;
}

export function jsonToYaml(text) {
  const value = parseJson(text);
  if (typeof value === 'undefined') throw new Error('JSON 无法解析。');
  return `${emitYaml(value, 0)}\n`;
}

function stripComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function unescapeDouble(text) {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') {
      out += text[index];
      continue;
    }
    const next = text[index + 1];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === '"' || next === '\\' || next === '/') out += next;
    else throw new Error('YAML 字符串转义无法识别。');
    index += 1;
  }
  return out;
}

function unquote(text) {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return unescapeDouble(text.slice(1, -1));
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.startsWith('|') || text.startsWith('>')) throw new Error('不支持 YAML 多行文本块。');
  if (/[[\]{}]/.test(text) && !(text.startsWith('"') || text.startsWith("'"))) throw new Error('仅支持块式 YAML，空数组和空对象可以写成 [] 与 {}。');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return unquote(text);
  if (NULL_WORDS.has(text.toLowerCase()) || text === '~' || text === '') return null;
  if (TRUE_WORDS.has(text.toLowerCase())) return true;
  if (FALSE_WORDS.has(text.toLowerCase())) return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function splitKey(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ':') {
      const key = unquote(text.slice(0, index).trim());
      if (!key) throw new Error('YAML 键不能为空。');
      return { key, value: text.slice(index + 1).trim() };
    }
  }
  return null;
}

function hasForbiddenYaml(content) {
  let quote = '';
  let token = '';
  const flagged = (value) => /^[&*][\w]/.test(value) || value.startsWith('!') || value.startsWith('<<');
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      token = '';
      continue;
    }
    if (char === ' ' || char === '\t' || char === ':') {
      if (flagged(token)) return true;
      token = '';
      continue;
    }
    token += char;
  }
  return flagged(token);
}

class YamlParser {
  constructor(text) {
    this.lines = [];
    this.index = 0;
    this.nodes = 0;
    const source = assertText(text, 'YAML').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const rawLine of source.split('\n')) {
      if (rawLine.includes('\t')) throw new Error('YAML 缩进只能使用空格。');
      const stripped = stripComment(rawLine);
      if (!stripped.trim()) continue;
      const indent = stripped.match(/^ */)?.[0].length ?? 0;
      const content = stripped.trim();
      if (hasForbiddenYaml(content)) throw new Error('不支持 YAML 锚点、别名或标签。');
      this.lines.push({ indent, text: content });
    }
  }

  peek() {
    return this.lines[this.index];
  }

  take() {
    const line = this.lines[this.index];
    this.index += 1;
    return line;
  }

  node() {
    this.nodes += 1;
    if (this.nodes > LIMITS.yamlNodes) throw new Error('YAML 节点过多。');
  }

  parse() {
    if (!this.lines.length) throw new Error('YAML 是空的。');
    const value = this.parseBlock(0, 0);
    if (this.peek()) throw new Error('YAML 存在无法归属的内容。');
    return value;
  }

  parseBlock(minIndent, depth) {
    if (depth > LIMITS.yamlDepth) throw new Error('YAML 嵌套过深。');
    const line = this.peek();
    if (!line || line.indent < minIndent) return null;
    if (line.text === '-' || line.text.startsWith('- ')) return this.parseList(line.indent, depth);
    if (splitKey(line.text)) return this.parseMap(line.indent, depth);
    if (line.indent !== minIndent && minIndent !== 0) throw new Error('YAML 缩进无法识别。');
    this.take();
    this.node();
    return parseScalar(line.text);
  }

  parseList(indent, depth) {
    const items = [];
    while (this.peek()?.indent === indent && (this.peek().text === '-' || this.peek().text.startsWith('- '))) {
      const line = this.take();
      this.node();
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      if (!rest) {
        items.push(this.parseBlock(indent + 1, depth + 1));
        continue;
      }
      if (rest.startsWith('-')) throw new Error('不支持同一行嵌套列表。');
      const key = splitKey(rest);
      if (key) {
        const map = {};
        this.assign(map, key, indent + 2, depth + 1);
        while (this.peek() && this.peek().indent > indent && !this.peek().text.startsWith('-')) {
          const nested = this.take();
          const nestedKey = splitKey(nested.text);
          if (!nestedKey) throw new Error('YAML 列表项格式无法识别。');
          this.node();
          this.assign(map, nestedKey, nested.indent + 2, depth + 1);
        }
        items.push(map);
        continue;
      }
      items.push(parseScalar(rest));
    }
    return items;
  }

  parseMap(indent, depth) {
    const map = {};
    while (this.peek()?.indent === indent && splitKey(this.peek().text) && !this.peek().text.startsWith('- ')) {
      const line = this.take();
      this.node();
      this.assign(map, splitKey(line.text), indent + 2, depth);
    }
    return map;
  }

  assign(map, pair, childIndent, depth) {
    if (Object.prototype.hasOwnProperty.call(map, pair.key)) throw new Error('YAML 出现重复键。');
    map[pair.key] = pair.value === '' ? this.parseBlock(childIndent, depth + 1) : parseScalar(pair.value);
  }
}

export function parseYaml(text) {
  return new YamlParser(text).parse();
}

export function yamlToJson(text) {
  return `${JSON.stringify(parseYaml(text), null, 2)}\n`;
}

function parseCsv(text) {
  const source = assertText(text, 'CSV').replace(/^\uFEFF/, '');
  if (!source.trim()) throw new Error('CSV 是空的。');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  if (quoted) throw new Error('CSV 引号没有闭合。');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item, index) => item.some((value) => value !== '') || index === 0);
}

export function csvToJson(text) {
  const rows = parseCsv(text);
  const headers = rows[0]?.map((header) => header.trim()) ?? [];
  if (!headers.length || headers.some((header) => !header)) throw new Error('CSV 需要非空表头。');
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头不能重复。');
  const records = rows.slice(1).filter((row) => row.some((value) => value !== '')).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function jsonToCsv(text) {
  const value = parseJson(text);
  if (!Array.isArray(value)) throw new Error('JSON 需要是对象数组。');
  if (value.some((item) => !isPlainObject(item))) throw new Error('JSON 需要是对象数组。');
  if (!value.length) throw new Error('JSON 数组是空的，没有可写的表头。');
  const headers = [];
  for (const item of value) {
    for (const key of Object.keys(item)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  if (!headers.length) throw new Error('JSON 对象没有字段。');
  const lines = [headers.map(csvCell).join(',')];
  for (const item of value) lines.push(headers.map((key) => csvCell(item[key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function encodeBytes(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function encodeBase64(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(assertText(input, '文本')) : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Base64 需要文本或二进制。');
  if (bytes.byteLength > LIMITS.textBytes) throw new Error('内容不能超过 1 MB。');
  return encodeBytes(bytes);
}

export function decodeBase64(input) {
  const text = assertText(input, 'Base64').replace(/\s+/g, '');
  if (!text || text.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(text)) throw new Error('不是有效的 Base64。');
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw new Error('不是有效的 Base64。');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeBase64Text(input) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(input));
  } catch (error) {
    if (error.message === '不是有效的 Base64。' || error instanceof TypeError || /不能超过/.test(error.message)) throw error;
    throw new Error('Base64 解码结果不是 UTF-8 文本。');
  }
}

export function encodeUrl(input) {
  return encodeURIComponent(assertText(input, '文本'));
}

export function decodeUrl(input) {
  try {
    return decodeURIComponent(assertText(input, '文本'));
  } catch (error) {
    if (error instanceof TypeError || /不能超过/.test(error.message)) throw error;
    throw new Error('不是有效的 URL 编码。');
  }
}

export const DATA_CONVERSIONS = [
  { id: 'json-yaml', label: 'JSON → YAML', extension: 'yaml', mime: 'application/yaml' },
  { id: 'yaml-json', label: 'YAML → JSON', extension: 'json', mime: 'application/json' },
  { id: 'csv-json', label: 'CSV → JSON', extension: 'json', mime: 'application/json' },
  { id: 'json-csv', label: 'JSON → CSV', extension: 'csv', mime: 'text/csv;charset=utf-8' },
  { id: 'base64-encode', label: 'Base64 编码', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'base64-decode', label: 'Base64 解码', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'url-encode', label: 'URL 编码', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'url-decode', label: 'URL 解码', extension: 'txt', mime: 'text/plain;charset=utf-8' },
];

export function convertData(id, input) {
  switch (id) {
    case 'json-yaml': return { text: jsonToYaml(input), extension: 'yaml', mime: 'application/yaml' };
    case 'yaml-json': return { text: yamlToJson(input), extension: 'json', mime: 'application/json' };
    case 'csv-json': return { text: csvToJson(input), extension: 'json', mime: 'application/json' };
    case 'json-csv': return { text: jsonToCsv(input), extension: 'csv', mime: 'text/csv;charset=utf-8' };
    case 'base64-encode': return { text: `${encodeBase64(input)}\n`, extension: 'txt', mime: 'text/plain;charset=utf-8' };
    case 'base64-decode': return { text: decodeBase64Text(input), extension: 'txt', mime: 'text/plain;charset=utf-8' };
    case 'url-encode': return { text: encodeUrl(input), extension: 'txt', mime: 'text/plain;charset=utf-8' };
    case 'url-decode': return { text: decodeUrl(input), extension: 'txt', mime: 'text/plain;charset=utf-8' };
    default: throw new Error('未知的数据转换。');
  }
}
