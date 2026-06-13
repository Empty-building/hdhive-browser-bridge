#!/usr/bin/env node
// 拦截 /api/customer/resources/{id}/file-list 响应
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

await client._ensureBrowser();

let capturedFileList = null;
await client._page.route('**/api/customer/resources/*/file-list*', async (route) => {
  const response = await route.fetch();
  const body = await response.text();
  capturedFileList = { url: route.request().url(), status: response.status(), body };
  console.log('[捕获 file-list 响应]', response.status(), body.slice(0, 500));
  await route.fulfill({ response });
});

await client._page.goto('https://hdhive.com/resource/189/3fb1cb6823c64ae4a7a0f8f23bd4bed3', { waitUntil: 'domcontentloaded', timeout: 30000 });
await client._page.waitForTimeout(8000);

console.log('\n=== file-list 响应 ===');
console.log(JSON.stringify(capturedFileList, null, 2));

await client.close();