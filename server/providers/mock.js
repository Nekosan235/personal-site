export function getDashboardMock(now = new Date()) {
  return {
    mode: 'mock',
    updatedAt: now.toISOString(),
    server: {
      id: 'cloud-01',
      name: 'Cloud 01',
      region: '上海 · 阿里云',
      ip: '203.0.113.10',
      os: 'Debian 13',
      vcpu: 2,
      status: 'online',
    },
    metrics: {
      memory: {
        used: 0.72,
        total: 2,
        unit: 'GiB',
        history: [0.61, 0.64, 0.66, 0.68, 0.7, 0.71, 0.72, 0.7, 0.69, 0.71, 0.72, 0.72],
      },
      disk: {
        used: 8.4,
        total: 40,
        unit: 'GiB',
        history: [8.1, 8.1, 8.2, 8.2, 8.3, 8.3, 8.35, 8.36, 8.38, 8.39, 8.4, 8.4],
      },
    },
  };
}
