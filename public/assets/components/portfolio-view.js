import { element, internalLink, pageHeading } from './dom.js?v=1.5.0';
import {
  featuredProjects,
  honors,
  otherProjects,
  profile,
  projectFigures,
} from './portfolio-data.js?v=1.5.0';

// mesgro-model-slot: [data-model-slot] is the mount for a future equipment viewer.
// Do not add Three.js, a canvas, or model files in this pass.

function awardBadge(project) {
  const tone = project.tone === 'award' ? 'bg-yellow-lt' : 'bg-secondary-lt';
  return element('span', { className: `badge work-badge ${tone}`, text: project.badge });
}

export function renderProjectCard(project) {
  return element('a', {
    className: 'work-card card card-link',
    attributes: { href: project.path, 'data-internal-link': '', 'data-project-id': project.id },
  }, [
    element('div', { className: 'card-body' }, [
      element('div', { className: 'work-card-top' }, [
        element('span', { className: 'work-kicker', text: project.kicker }),
        awardBadge(project),
      ]),
      element('h3', { className: 'card-title', text: project.title }),
      element('p', { className: 'work-summary text-secondary', text: project.summary }),
    ]),
  ]);
}

export function renderFeaturedGrid() {
  return element('div', {
    className: 'work-grid',
    attributes: { 'aria-label': '主要项目' },
  }, featuredProjects.map(renderProjectCard));
}

export function renderHomeProjects() {
  return element('section', {
    className: 'work-home',
    attributes: { 'aria-labelledby': 'home-work-title', 'data-home-work': '', 'data-dashboard-module': 'work' },
  }, [
    element('div', { className: 'work-home-head' }, [
      element('div', {}, [
        element('h2', { className: 'work-home-title', text: '作品', attributes: { id: 'home-work-title' } }),
        element('p', { className: 'work-tagline', text: `${profile.name} · ${profile.tagline}` }),
      ]),
      internalLink('/work', '打开作品墙', 'btn btn-outline-primary'),
    ]),
    renderFeaturedGrid(),
  ]);
}

function itemList(tag, items) {
  return element(tag, { className: 'work-list' }, items.map((item) => element('li', { text: item })));
}

function awardFigure(image) {
  return element('figure', { className: 'award-figure' }, [
    element('img', { attributes: { src: image.src, alt: image.alt, loading: 'lazy' } }),
    element('figcaption', { text: image.caption }),
    element('a', {
      className: 'text-link award-open',
      text: '查看原图',
      attributes: { href: image.src, target: '_blank', rel: 'noopener noreferrer' },
    }),
  ]);
}

function modelSlot(id) {
  return element('section', {
    className: 'model-slot',
    attributes: { 'data-model-slot': id, 'aria-label': '设备三维查看预留位' },
  }, [
    element('h2', { text: '设备模型' }),
    element('p', { text: '预留位。以后可以在这里挂设备三维查看，当前不加载模型。' }),
  ]);
}

function projectMeta(project) {
  const rows = [
    ['时间', project.period],
    ['角色', project.role],
    ['团队', project.team],
    ['指导教师', project.advisor],
  ].filter(([, value]) => value);
  return element('dl', { className: 'work-meta' }, rows.map(([label, value]) => element('div', {}, [
    element('dt', { text: label }),
    element('dd', { text: value }),
  ])));
}

export function renderProjectPage(project) {
  const photos = projectFigures(project);
  return element('div', { className: 'work-detail page-enter' }, [
    internalLink('/work', '← 作品', 'text-link back-link'),
    pageHeading(project.title, project.summary, awardBadge(project)),
    projectMeta(project),
    element('section', { className: 'work-block' }, [
      element('h2', { text: '背景' }),
      element('p', { text: project.background }),
    ]),
    element('section', { className: 'work-block' }, [
      element('h2', { text: '职责' }),
      itemList('ul', project.duties),
      project.note ? element('p', { className: 'work-note', text: project.note }) : null,
    ]),
    element('section', { className: 'work-block' }, [
      element('h2', { text: project.techHeading || '关键技术' }),
      itemList('ol', project.tech),
    ]),
    element('section', { className: 'work-block' }, [
      element('h2', { text: '成果' }),
      itemList('ul', project.results),
    ]),
    element('section', { className: 'work-block' }, [
      element('h2', { text: '图片' }),
      element('div', { className: 'work-figures' }, photos.map(awardFigure)),
    ]),
    project.modelSlot ? modelSlot(project.modelSlot) : null,
  ]);
}

export function renderWorkPage() {
  return element('div', { className: 'work-page page-enter' }, [
    pageHeading('作品', profile.tagline),
    element('p', { className: 'work-intro', text: `${profile.name}（${profile.handle}）· ${profile.school}` }),
    element('h2', { className: 'work-section-title', text: '主要项目' }),
    renderFeaturedGrid(),
    element('h2', { className: 'work-section-title', text: '其他' }),
    element('div', {
      className: 'work-grid work-grid-other',
      attributes: { 'aria-label': '其他项目' },
    }, otherProjects.map(renderProjectCard)),
    element('p', { className: 'work-more' }, [
      internalLink('/work/honors', '荣誉与奖状 →'),
    ]),
  ]);
}

export function renderHonorPage() {
  return element('div', { className: 'work-honors page-enter' }, [
    internalLink('/work', '← 作品', 'text-link back-link'),
    pageHeading('荣誉', '按奖状原文记录。和四个主要项目不是同一件事的，单独放在这里。'),
    element('div', { className: 'award-gallery' }, honors.map((item) => element('article', { className: 'card' }, [
      element('div', { className: 'card-body' }, [
        element('h2', { className: 'card-title', text: item.title }),
        awardFigure(item),
        item.projectPath ? internalLink(item.projectPath, '查看对应项目') : null,
      ]),
    ]))),
  ]);
}
