import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../public/assets/styles.css', import.meta.url));
const css = await readFile(cssPath, 'utf8');
const light = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="dark"]'));
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('html, body'));

test('light theme locks ink, paper, and the four accents', () => {
  for (const [name, value] of Object.entries({
    '--bg': '#FFFFFF', '--text': '#000000', '--border': '#000000', '--pink': '#FF006E',
    '--lime': '#CCFF00', '--sky': '#00D9FF', '--tangerine': '#FF9500', '--slab': '#F4F4F4', '--shadow-ink': '#000000',
  })) assert.match(light, new RegExp(`${name}:\\s*${value}`), name);
});

test('dark theme flips ink and shadows to near-white on near-black', () => {
  for (const [name, value] of Object.entries({
    '--bg': '#0E0E0E', '--paper': '#171717', '--text': '#F2F2F2', '--border': '#F2F2F2', '--shadow-ink': '#F2F2F2',
  })) assert.match(dark, new RegExp(`${name}:\\s*${value}`), name);
});

test('bundled Archivo and Space Mono faces load from the site itself', () => {
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  assert.equal(faces.length, 4);
  for (const face of faces) assert.match(face, /src: url\("\/assets\/fonts\/[a-z0-9-]+\.woff2"\) format\("woff2"\)/);
  assert.doesNotMatch(css, /url\(["']?https?:/);
});

test('blocks are square with hard, zero-blur shadows and no blurred elevation', () => {
  assert.match(css, /--radius:\s*0;/);
  assert.match(css, /--shadow-sm: 4px 4px 0 0 var\(--shadow-ink\)/);
  assert.match(css, /--shadow-lg: 8px 8px 0 0 var\(--shadow-ink\)/);
  assert.match(css, /\.card \{ background: var\(--paper\); border: var\(--bw\) solid var\(--ink\); border-radius: 0; box-shadow: var\(--shadow-sm\); \}/);
  assert.match(css, /\.btn:active:not\(:disabled\) \{ transform: translate\(4px, 4px\); box-shadow: none; \}/);
  for (const shadow of css.match(/box-shadow:[^;]*rgb\([^;]*/g) ?? []) assert.fail(`soft shadow: ${shadow}`);
  for (const radius of css.match(/border-radius:\s*(?!0[;\s])[1-9][^;]*/g) ?? []) {
    assert.match(radius, /50%/, `rounded corner: ${radius}`);
  }
  assert.match(css, /--mono:[^;]*Cascadia Mono/);
  assert.match(css, /\.metric-used \{[^}]*font-family: var\(--font-display\)[^}]*font-variant-numeric: tabular-nums/);
  assert.match(css, /\.media-actions \.btn\s*\{[^}]*min-height:\s*48px/);
  assert.match(css, /\.media-download-all,\s*\n\s*\.media-import-mode,\s*\n\s*\.media-save,\s*\n\s*\.media-history-button \{[^}]*min-height:\s*48px/);
});
