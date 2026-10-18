#!/usr/bin/env node
import { checkMediaBackends } from '../server/media/health.js';

const config = {
  xhsApiUrl: process.env.XHS_API_URL || 'http://127.0.0.1:5556',
  douyinApiUrl: process.env.DOUYIN_API_URL || 'http://127.0.0.1:5555',
  xhsApiToken: process.env.XHS_API_TOKEN || '',
  xhsApiTokenFile: process.env.XHS_API_TOKEN_FILE || '',
  mediaProbeTimeoutMs: Number(process.env.MEDIA_PROBE_TIMEOUT_MS || 4000),
};

const result = await checkMediaBackends(config);
let failed = false;
for (const name of ['xiaohongshu', 'douyin']) {
  const item = result[name];
  const state = item.ok ? 'ok' : `fail ${item.reason || 'down'}`;
  console.log(`${name} ${state} ${item.url}`);
  if (!item.ok) failed = true;
}
if (failed) process.exit(1);
