import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { loadConfig } from '../server/config.js';
import { getModules } from '../server/modules/catalog.js';
import { hashPassword } from '../server/auth/password.js';
import { createDashboardView } from '../public/assets/pages/dashboard.js';
import { renderPortfolio } from '../public/assets/pages/portfolio.js';
import {
  allProjects,
  featuredProjects,
  honors,
  otherProjects,
  profile,
  projectFigures,
} from '../public/assets/components/portfolio-data.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const origin = 'https://portfolio.example';
const password = 'test-only-portfolio-password';
const passwordHash = await hashPassword(password);

class DomNode {
  constructor() {
    this.className = '';
    this.value = '';
    this.children = [];
    this.attributes = new Map();
  }
  append(...children) { this.children.push(...children); }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); }
  addEventListener() {}
  removeEventListener() {}
  classList = { toggle() {} };
}

function withDom(callback) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new DomNode(), createElementNS: () => new DomNode() };
  try { return callback(); } finally { globalThis.document = previous; }
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function attrValues(node, name) {
  const values = [];
  walk(node, (current) => {
    const value = current.getAttribute?.(name);
    if (value) values.push(value);
  });
  return values;
}

function findAttr(node, name, expected) {
  let found = null;
  walk(node, (current) => {
    if (!found && current.getAttribute?.(name) === expected) found = current;
  });
  return found;
}

test('featured projects stay in interview order with certificate badges', () => {
  assert.deepEqual(featuredProjects.map((item) => item.title), [
    '无人机森林消防系统',
    '风光制氢自动化控制系统',
    'S7-1200 + V90 伺服丝杆传动',
    '汇川杯工业视觉',
  ]);
  assert.deepEqual(featuredProjects.map((item) => item.badge), [
    '华东初赛一等奖',
    '华东三等奖',
    '课程项目',
    '全国铜牌 · 区域金牌',
  ]);
  assert.equal(profile.tagline, '自动化本科｜PLC·视觉·系统联调｜南京');
  assert.deepEqual(otherProjects.map((item) => item.id), ['mcu-music', 'advantech-elevator', 'ican-elevator']);
  for (const project of allProjects()) {
    assert.equal(project.tech.length, 3, project.id);
    assert.equal(project.background.split('。').filter(Boolean).length, 1, project.id);
    assert.ok(project.duties.length >= 1, project.id);
    assert.ok(project.results.length >= 1, project.id);
    assert.ok(projectFigures(project).length >= 1, project.id);
  }
  assert.deepEqual(featuredProjects.map((item) => item.modelSlot || null), [
    'forest-drone-cabin',
    'hydrogen-skid',
    'servo-screw',
    null,
  ]);
  const copy = JSON.stringify({ profile, featuredProjects, otherProjects, honors });
  assert.doesNotMatch(copy, /省一等奖|前5%|9-13K|1[3-9]\d{9}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.match(copy, /江浙赛区三等奖/);
  assert.match(copy, /优秀奖/);
  assert.match(copy, /初赛一等奖/);
});

test('award files exist and catalog routes match the portfolio pages', async () => {
  const srcs = new Set(honors.map((item) => item.src));
  for (const project of allProjects()) {
    for (const image of projectFigures(project)) srcs.add(image.src);
  }
  assert.equal(srcs.size, 8);
  for (const src of srcs) {
    const fullPath = join(publicDir, src);
    await access(fullPath);
    const bytes = await readFile(fullPath);
    if (src.endsWith('.jpg')) {
      assert.equal(bytes[0], 0xff, src);
      assert.equal(bytes[1], 0xd8, src);
    } else {
      assert.match(bytes.toString('utf8'), /<svg/, src);
    }
  }
  const modules = getModules({ codexWebUrl: 'https://catalog.example' });
  assert.equal(modules.find((item) => item.nav).id, 'work');
  assert.equal(modules.find((item) => item.id === 'work').title, '作品');
  for (const project of allProjects()) {
    const module = modules.find((item) => item.id === project.id);
    assert.equal(module.path, project.path, project.id);
    assert.equal(module.nav, false, project.id);
    assert.equal(module.title, project.title, project.id);
  }
  assert.equal(modules.find((item) => item.id === 'work-honors').path, '/work/honors');
  const appSource = await readFile(join(publicDir, 'assets/app.js'), 'utf8');
  for (const id of ['work', 'work-honors', ...allProjects().map((item) => item.id)]) {
    assert.match(appSource, new RegExp(`\\['${id}', renderPortfolio\\]`));
  }
});

test('the home wall lists four cards in order and keeps secondary work off the overview', () => withDom(() => {
  const view = createDashboardView({ modules: [], now: () => Date.parse('2026-10-16T00:00:00Z') });
  const home = findAttr(view.element, 'data-home-work', '');
  assert.ok(home);
  assert.deepEqual(attrValues(home, 'data-project-id'), featuredProjects.map((item) => item.id));
  assert.match(home.textContent, /卢涵煜 · 自动化本科｜PLC·视觉·系统联调｜南京/);
  assert.match(home.textContent, /华东初赛一等奖/);
  assert.match(home.textContent, /华东三等奖/);
  assert.match(home.textContent, /课程项目/);
  assert.match(home.textContent, /全国铜牌 · 区域金牌/);
  assert.doesNotMatch(home.textContent, /51单片机|研华|iCAN|工程思维/);
}));

test('project pages keep background, duties, three points, results, and a picture', () => withDom(() => {
  const drone = renderPortfolio({ module: { id: 'forest-drone' } });
  assert.match(drone.textContent, /背景/);
  assert.match(drone.textContent, /职责/);
  assert.match(drone.textContent, /关键技术/);
  assert.match(drone.textContent, /成果/);
  assert.deepEqual(attrValues(drone, 'src'), ['/assets/portfolio/siemens-cup-2025-east-first.jpg']);
  assert.deepEqual(attrValues(drone, 'data-model-slot'), ['forest-drone-cabin']);

  const vision = renderPortfolio({ module: { id: 'inovance-vision' } });
  assert.deepEqual(attrValues(vision, 'src'), [
    '/assets/portfolio/inovance-cup-2026-regional-gold.jpg',
    '/assets/portfolio/inovance-cup-2026-national-bronze.jpg',
  ]);
  assert.deepEqual(attrValues(vision, 'data-model-slot'), []);
  assert.match(vision.textContent, /简历没有单列/);

  const ican = renderPortfolio({ module: { id: 'ican-elevator' } });
  assert.match(ican.textContent, /江浙赛区三等奖/);
  assert.doesNotMatch(ican.textContent, /省一等奖/);

  const wall = renderPortfolio({ module: { id: 'work' } });
  assert.match(wall.textContent, /其他/);
  assert.match(wall.textContent, /51单片机音乐播放器/);
  const honorsPage = renderPortfolio({ module: { id: 'work-honors' } });
  assert.match(honorsPage.textContent, /工程思维与创新实践赛三等奖/);
  assert.equal(attrValues(honorsPage, 'src').length, honors.length);
}));

test('award images stay behind login and are served to an authenticated session', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-site-portfolio-'));
  const config = loadConfig({}, {
    HOST: '127.0.0.1', PORT: 0, SITE_ORIGIN: origin, NODE_ENV: 'production',
    DATA_DIR: directory, PUBLIC_DIR: publicDir, MONITORING_MODE: 'mock',
    AUTH_USERNAME: 'portfolio-user', AUTH_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('hex'),
  });
  const server = createApplication({ config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, options) => fetch(base + path, { redirect: 'manual', ...options });
  const image = '/assets/portfolio/siemens-cup-2025-east-first.jpg';
  assert.notEqual((await request(image)).status, 200);
  assert.equal((await request('/work')).status, 303);

  const challenge = await request('/login');
  const html = await challenge.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const prelogin = challenge.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, Cookie: prelogin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ username: 'portfolio-user', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().filter((value) => !/Max-Age=0/.test(value)).map((value) => value.split(';')[0]).join('; ');
  const authed = await request(image, { headers: { Cookie: cookie } });
  assert.equal(authed.status, 200);
  assert.match(authed.headers.get('content-type'), /^image\/jpeg/);
  const bytes = new Uint8Array(await authed.arrayBuffer());
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  const page = await request('/work/forest-drone', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="navigation-root"/);
});
