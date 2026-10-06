export function getModules(config) {
  return [
    { id: 'dashboard', path: '/', title: '概览', nav: false, status: 'ready' },
    { id: 'tools', path: '/tools', title: '工具箱', nav: true, status: 'ready' },
    { id: 'agents', path: '/agents', title: '我的 Agent', nav: true, status: 'planned' },
    {
      id: 'remove-background',
      path: '/tools/remove-background',
      title: '抠图',
      nav: false,
      status: 'planned',
      group: 'tools',
      description: '上传图片并移除背景的预留工具入口。',
    },
    {
      id: 'file-converter',
      path: '/tools/file-converter',
      title: '文件转换',
      nav: false,
      status: 'planned',
      group: 'tools',
      description: '常见文档与图片格式转换的预留工具入口。',
    },
    {
      id: 'codex-web',
      href: config.codexWebUrl,
      title: 'Codex Web',
      nav: true,
      external: true,
      status: 'ready',
    },
  ];
}
