import { projectById } from '../components/portfolio-data.js?v=1.5.0';
import { renderHonorPage, renderProjectPage, renderWorkPage } from '../components/portfolio-view.js?v=1.5.0';

export function renderPortfolio({ module }) {
  if (module.id === 'work') return renderWorkPage();
  if (module.id === 'work-honors') return renderHonorPage();
  const project = projectById(module.id);
  return project ? renderProjectPage(project) : renderWorkPage();
}
