export function getModules(config) {
  return [
    { id: 'dashboard', path: '/', title: '概览', nav: false, status: 'ready' },
    { id: 'tools', path: '/tools', title: '工具箱', nav: true, status: 'ready' },
    { id: 'agents', path: '/agents', title: '我的 Agent', nav: true, status: 'planned' },
    {
      id: 'remove-background',
      path: '/tools/remove-background',
      title: '图片去白底',
      nav: false,
      status: 'ready',
      group: 'tools',
      description: '本地移除图片白色背景，手动修整并导出透明 PNG。',
    },
    {
      id: 'gif-editor',
      path: '/tools/gif-editor',
      title: 'GIF 逐帧编辑',
      nav: false,
      status: 'ready',
      group: 'tools',
      description: '逐帧去除白底、局部修整并导出透明 GIF。',
    },
    {
      id: 'file-converter',
      path: '/tools/file-converter',
      title: '文件转换',
      nav: false,
      status: 'planned',
      group: 'tools',
      description: '常见文件格式转换预留入口。',
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
