import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../public/assets/styles.css', import.meta.url));
const css = await readFile(cssPath, 'utf8');
const light = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="dark"]'));
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('html, body'));

const lockedLight = {
  '--bg': '#E6E5E0',
  '--surface-1': '#F4F3EF',
  '--border': '#D3D1CA',
  '--text': '#1D1E20',
  '--accent': '#00796E',
  '--rail': '#1E1F21',
  '--graphite': '#232427',
  '--signal': '#00857A',
};

const lockedDark = {
  '--bg': '#161719',
  '--paper': '#1F2023',
  '--surface-2': '#1A1B1E',
  '--border': '#2D2E33',
  '--text': '#E7E5E0',
  '--text-muted': '#A3A29B',
  '--accent': '#3CC2B2',
  '--positive': '#6CC08B',
  '--warning': '#E6A740',
  '--negative': '#E97C6E',
  '--rail': '#0F1012',
  '--signal': '#3CC2B2',
};

test('light theme locks the aluminium instrument palette', () => {
  for (const [name, value] of Object.entries(lockedLight)) assert.match(light, new RegExp(`${name}:\\s*${value}`), name);
});

test('dark theme locks the graphite instrument palette', () => {
  assert.ok(dark.startsWith(':root[data-theme="dark"]'));
  for (const [name, value] of Object.entries(lockedDark)) assert.match(dark, new RegExp(`${name}:\\s*${value}`), name);
});

test('bundled Barlow faces load from the site itself', () => {
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  assert.equal(faces.length, 5);
  for (const face of faces) {
    assert.match(face, /src: url\("\/assets\/fonts\/[a-z0-9-]+\.woff2"\) format\("woff2"\)/);
    assert.match(face, /font-display: swap/);
  }
  assert.doesNotMatch(css, /url\(["']?https?:/);
  assert.doesNotMatch(css, /--font-serif/);
});

test('shell uses machined radii, a sheen-lit ground, graphite primary buttons, and readable targets', () => {
  assert.match(css, /--radius:\s*6px/);
  assert.match(css, /--mono:[^;]*Cascadia Mono/);
  assert.match(css, /body.app-body, body.login-body \{[^}]*background-image: radial-gradient/);
  assert.match(css, /--text-dim: #6F6F69/);
  assert.match(css, /\.btn-primary \{\s*--tblr-btn-color: var\(--on-graphite\); --tblr-btn-bg: var\(--graphite\)/);
  assert.match(css, /\.nav-link\[aria-current="page"\]::after \{[^}]*background: var\(--signal\)/);
  assert.doesNotMatch(css, /box-shadow:\s*0\s+20px/);
  assert.match(css, /\.metric-used \{[^}]*font-family: var\(--font-display\)[^}]*font-variant-numeric: tabular-nums/);
  assert.match(css, /\.eyebrow,[^{]*\{[^}]*text-transform:\s*none/);
  assert.match(css, /\.media-actions \.btn\s*\{[^}]*min-height:\s*48px/);
  assert.match(css, /\.media-download-all,\s*\n\s*\.media-import-mode,\s*\n\s*\.media-save,\s*\n\s*\.media-history-button \{[^}]*min-height:\s*48px/);
});
