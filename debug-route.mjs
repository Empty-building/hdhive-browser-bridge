#!/usr/bin/env node
// 调试：用 page.route 拦截 fetch 响应
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

await client._ensureBrowser();

// 拦截 fetch 响应
await client._page.route('**/*', async (route) => {
  const response = await route.fetch();
  const url = route.request().url();
  if (url.includes('cloud.189') || url.includes('__next_f') || url.includes('/api/customer/') || url.includes('_next/data')) {
    console.log('[route]', url);
  }
  await route.fulfill({ response });
});

await client._page.goto('https://hdhive.com/resource/189/3fb1cb6823c64ae4a7a0f8f23bd4bed3', { waitUntil: 'domcontentloaded', timeout: 30000 });
await client._page.waitForTimeout(8000);

const info = await client._page.evaluate(() => ({
  nextFLen: window.__next_f?.length || 0,
  nextFType: typeof window.__next_f,
  capturedLen: (window.__rscCaptured || []).length,
  // 看下页面所有 script 标签
  scriptsCount: document.querySelectorAll('script').length,
  // 看下页面是否有 cloud189
  bodyContains189: document.body.innerHTML.includes('cloud.189')
}));
console.log('info:', info);

// 查找所有内联 script 包含 cloud189
const allScripts = await client._page.evaluate(() => {
  return [...document.querySelectorAll('script')]
    .map(s => s.textContent)
    .filter(t => t && t.includes('cloud.189'))
    .map(t => t.slice(0, 300));
});
console.log('\n含 cloud189 的脚本:', allScripts.length);
for (const s of allScripts.slice(0, 3)) console.log(s, '\n---');

await client.close();