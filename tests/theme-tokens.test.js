import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../public/assets/styles.css', import.meta.url));
const css = await readFile(cssPath, 'utf8');
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('html, body'));

const locked = {
  '--bg': '#0B0E11',
  '--surface': '#0B0E11',
  '--surface-1': '#12161C',
  '--paper': '#12161C',
  '--surface-2': '#181E27',
  '--surface-3': '#1E2633',
  '--border': '#2A3341',
  '--line': '#2A3341',
  '--border-strong': '#3A4658',
  '--text': '#E8EDF4',
  '--ink': '#E8EDF4',
  '--text-muted': '#8B98A8',
  '--secondary': '#8B98A8',
  '--text-dim': '#5C6B7A',
  '--accent': '#3D8BFF',
  '--accent-soft': '#1A2A44',
  '--positive': '#3DDC97',
  '--warning': '#F0B429',
  '--negative': '#F07178',
};

test('dark theme locks the terminal palette', () => {
  assert.ok(dark.startsWith(':root[data-theme="dark"]'));
  for (const [name, value] of Object.entries(locked)) {
    assert.match(dark, new RegExp(`${name}:\\s*${value}`), name);
  }
});

test('shell keeps thin borders, a 4px radius, and no heavy shadows', () => {
  assert.match(css, /--radius:\s*4px/);
  assert.match(css, /--mono:[^;]*Cascadia Mono/);
  assert.match(css, /\.badge\s*\{[^}]*border-radius:\s*2px/);
  assert.match(css, /\.card[\s\S]*box-shadow:\s*none/);
  assert.doesNotMatch(css, /box-shadow:\s*0\s+20px/);
  assert.match(css, /border-left:\s*2px solid var\(--accent\)/);
  assert.match(css, /background:\s*var\(--accent-soft\)/);
  assert.match(css, /\.metric-used\s*\{[^}]*font-family:\s*var\(--mono\)/);
  assert.match(css, /\.metric-used\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.media-actions \.btn\s*\{[^}]*min-height:\s*48px/);
  assert.match(css, /\.media-download-all,\s*\n\s*\.media-import-mode,\s*\n\s*\.media-save,\s*\n\s*\.media-history-button \{[^}]*min-height:\s*48px/);
});
