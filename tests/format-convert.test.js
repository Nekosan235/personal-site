import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertData, csvToJson, decodeBase64Text, decodeUrl, encodeBase64, encodeUrl, jsonToCsv, jsonToYaml, yamlToJson } from '../public/assets/components/format-convert/data.js';
import { converterCatalog } from '../public/assets/components/format-convert/catalog.js';
import { assertSafeSvg, detectContainer, downloadName, outputPixelSize, prepareImageSource } from '../public/assets/components/format-convert/images.js';
import { LIMITS } from '../public/assets/components/format-convert/limits.js';
import { markdownToHtml, markdownToHtmlDocument, previewPlain } from '../public/assets/components/format-convert/markdown.js';
import { transformText } from '../public/assets/components/format-convert/text.js';

const sample = {
  name: 'ada',
  count: 3,
  active: true,
  title: 'true',
  tags: ['a', 'b'],
  nested: { child: 1 },
  items: [{ name: 'a', qty: 2 }, { name: 'b', qty: 3 }],
  note: 'hello: world',
  site: 'https://example.com/a?b=1&c=2',
  empty: [],
  blank: {},
};

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

test('JSON and YAML round-trip nested data and quote ambiguous strings', () => {
  const yaml = jsonToYaml(JSON.stringify(sample));
  assert.match(yaml, /title: "true"/);
  assert.match(yaml, /site: "https:\/\/example.com\/a\?b=1&c=2"/);
  assert.deepEqual(JSON.parse(yamlToJson(yaml)), sample);
  assert.equal(JSON.parse(yamlToJson('note: "a & b"\n')).note, 'a & b');
  assert.equal(JSON.parse(yamlToJson('name: ada # person\n')).name, 'ada');
});

test('YAML subset rejects anchors, tags, tabs, duplicate keys, and excessive depth', () => {
  assert.throws(() => yamlToJson('a: &id 1\n'), /锚点/);
  assert.throws(() => yamlToJson('a: !!str hello\n'), /锚点|标签/);
  assert.throws(() => yamlToJson('a:\t1\n'), /空格/);
  assert.throws(() => yamlToJson('a: 1\na: 2\n'), /重复键/);
  assert.throws(() => yamlToJson('value: |\n  hello\n'), /多行文本块/);
  let deep = 'leaf: 1';
  for (let level = 0; level < 40; level += 1) deep = `level:\n${deep.replace(/^/gm, '  ')}`;
  assert.throws(() => yamlToJson(deep), /嵌套过深/);
  assert.throws(() => yamlToJson(`${Array.from({ length: LIMITS.yamlNodes + 1 }, () => '- 1').join('\n')}\n`), /节点过多/);
});

test('CSV and JSON preserve quoted commas and keep every field as text', () => {
  const csv = 'name,note\r\nada,"hello, world"\r\nbob,"say ""hi"""\r\n';
  const records = JSON.parse(csvToJson(csv));
  assert.deepEqual(records, [
    { name: 'ada', note: 'hello, world' },
    { name: 'bob', note: 'say "hi"' },
  ]);
  const exported = jsonToCsv(JSON.stringify([{ name: 'a', note: 'b,c' }, { name: 'd', extra: 1 }]));
  assert.match(exported, /"b,c"/);
  assert.match(exported, /\r\n/);
  assert.equal(JSON.parse(csvToJson(exported))[1].extra, '1');
  assert.throws(() => csvToJson('name,name\n'), /重复/);
  assert.throws(() => jsonToCsv('[]'), /空的/);
  assert.throws(() => jsonToCsv('{"name":"a"}'), /对象数组/);
});

test('Base64 and URL codecs round-trip Unicode and reject malformed input', () => {
  assert.equal(decodeBase64Text(encodeBase64('格式 转换')), '格式 转换');
  assert.equal(decodeUrl(encodeUrl('a b/格式')), 'a b/格式');
  assert.throws(() => decodeBase64Text('@@@@'), /Base64/);
  assert.throws(() => decodeUrl('%'), /URL 编码/);
  assert.equal(convertData('url-encode', 'a b').text, 'a%20b');
  assert.throws(() => encodeBase64('x'.repeat(LIMITS.textBytes + 1)), /1 MB/);
});

test('Markdown becomes escaped HTML and plain preview keeps the source text', () => {
  const html = markdownToHtml('# 标题\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(1))\n\n[站点](https://example.com)\n\n- **粗**\n- `code`\n');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(html, /<a href="https:\/\/example.com">站点<\/a>/);
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  const document = markdownToHtmlDocument('hello');
  assert.match(document, /<!doctype html>/);
  assert.equal(previewPlain('第一行\r\n第二行'), '第一行\n第二行');
});

test('text transforms apply newlines, then whitespace, then case', () => {
  assert.equal(transformText('  A  \r\n  b  ', { letter: 'lower', space: 'trim-lines', newline: 'lf' }), 'a\nb');
  assert.equal(transformText('  A   B  \r\n  c', { letter: 'keep', space: 'collapse', newline: 'lf' }), 'A B\nc');
  assert.equal(transformText('a\nb', { letter: 'upper', space: 'keep', newline: 'crlf' }), 'A\r\nB');
  assert.equal(transformText('hello world', { letter: 'title', space: 'keep', newline: 'keep' }), 'Hello World');
  assert.throws(() => transformText('a', { letter: 'keep', space: 'keep', newline: 'keep' }), /至少选择/);
});

test('image detection accepts common containers and blocks HEIC, PDF, and unsafe SVG', () => {
  assert.equal(detectContainer(pngHeader(8, 4)), 'png');
  assert.equal(detectContainer(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 16, 0, 32])), 'jpeg');
  const gif = new Uint8Array(10);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 32, 0, 24, 0]);
  assert.equal(detectContainer(gif), 'gif');
  const heic = new Uint8Array(12);
  heic.set([102, 116, 121, 112], 4);
  heic.set([104, 101, 105, 99], 8);
  assert.equal(detectContainer(heic), 'heic');
  assert.throws(() => prepareImageSource(heic), /HEIC/);
  assert.throws(() => prepareImageSource(new TextEncoder().encode('%PDF-1.7\n')), /PDF/);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"></svg>';
  assert.equal(assertSafeSvg(svg).startsWith('<svg'), true);
  assert.equal(prepareImageSource(new TextEncoder().encode(svg)).kind, 'svg');
  assert.throws(() => assertSafeSvg('<svg><script>alert(1)</script></svg>'), /脚本/);
  assert.throws(() => assertSafeSvg('<svg href="https://example.com/a.svg"></svg>'), /外链/);
  assert.throws(() => prepareImageSource(pngHeader(100000, 100000)), /3200 万像素/);
  const fitted = outputPixelSize(3000, 3000, { gif: true });
  assert.equal(fitted.scaled, true);
  assert.ok(fitted.width * fitted.height <= LIMITS.outputPixels);
  assert.equal(downloadName('../../照片 .png', 'jpg'), '照片_.jpg');
  assert.equal(downloadName('converted.yaml', 'yaml'), 'converted.yaml');
});

test('converter catalog keeps practical formats and marks HEIC, PDF, and media unavailable', () => {
  const catalog = converterCatalog();
  assert.deepEqual(catalog.images, ['png', 'jpeg', 'webp', 'gif', 'svg']);
  assert.ok(catalog.data.includes('json-yaml'));
  assert.ok(catalog.data.includes('csv-json'));
  assert.deepEqual(catalog.documents, ['markdown-html', 'plain-preview']);
  assert.deepEqual(catalog.unavailable, ['heic', 'pdf', 'media']);
});

test('format converter page does not shell out or upload files', async () => {
  const page = await readFile(new URL('../public/assets/pages/file-converter.js', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../public/assets/components/format-convert/image-browser.js', import.meta.url), 'utf8');
  for (const source of [page, browser]) {
    assert.doesNotMatch(source, /child_process|ffmpeg|spawn\(|exec\(|fetch\(|XMLHttpRequest/);
  }
  assert.match(page, /格式转换|转换图片|转为 HTML|转换数据|整理文本|暂不可用/);
});
