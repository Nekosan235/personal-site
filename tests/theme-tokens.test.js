import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../public/assets/styles.css', import.meta.url));
const css = await readFile(cssPath, 'utf8');
const light = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="dark"]'));
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('html, body'));

const lockedLight = {
  '--bg': '#FAF9F5',
  '--surface-1': '#FFFFFF',
  '--border': '#E8E6DC',
  '--text': '#141413',
  '--accent': '#C96442',
  '--accent-soft': '#F6E9E2',
};

const lockedDark = {
  '--bg': '#262624',
  '--surface': '#262624',
  '--surface-1': '#30302E',
  '--paper': '#30302E',
  '--surface-2': '#2C2C2A',
  '--surface-3': '#3A3936',
  '--border': '#3F3E3A',
  '--line': '#3F3E3A',
  '--border-strong': '#55534D',
  '--text': '#F5F4EE',
  '--ink': '#F5F4EE',
  '--text-muted': '#B4B1A7',
  '--secondary': '#B4B1A7',
  '--text-dim': '#8A877E',
  '--accent': '#D97757',
  '--accent-soft': '#3F2F28',
  '--positive': '#94BF7C',
  '--warning': '#E3AE5C',
  '--negative': '#E8806F',
};

test('light theme locks the warm paper palette', () => {
  for (const [name, value] of Object.entries(lockedLight)) {
    assert.match(light, new RegExp(`${name}:\\s*${value}`), name);
  }
});

test('dark theme locks the warm charcoal palette', () => {
  assert.ok(dark.startsWith(':root[data-theme="dark"]'));
  for (const [name, value] of Object.entries(lockedDark)) {
    assert.match(dark, new RegExp(`${name}:\\s*${value}`), name);
  }
});

test('shell uses serif display type, soft radii, and readable touch targets', () => {
  assert.match(css, /--radius:\s*10px/);
  assert.match(css, /--font-serif:[^;]*serif/);
  assert.match(css, /\.page-title[^{]*\{[^}]*font-family:\s*var\(--font-serif\)/);
  assert.match(css, /--mono:[^;]*Cascadia Mono/);
  assert.match(css, /\.badge, \.work-badge\s*\{[^}]*border-radius:\s*999px/);
  assert.doesNotMatch(css, /box-shadow:\s*0\s+20px/);
  assert.match(css, /\.nav-link\[aria-current="page"\]\s*\{[^}]*border-left:\s*0/);
  assert.match(css, /\.metric-used\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.eyebrow,[^{]*\{[^}]*text-transform:\s*none/);
  assert.match(css, /\.media-actions \.btn\s*\{[^}]*min-height:\s*48px/);
  assert.match(css, /\.media-download-all,\s*\n\s*\.media-import-mode,\s*\n\s*\.media-save,\s*\n\s*\.media-history-button \{[^}]*min-height:\s*48px/);
});
