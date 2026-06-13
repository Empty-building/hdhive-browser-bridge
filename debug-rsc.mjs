#!/usr/bin/env node
// 调试 RSC 拦截为啥失败
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

await client._ensureBrowser();
console.log('[1] 当前 URL:', client._page.url());

console.log('[2] 注入 RSC 拦截');
await client._page.addInitScript(`(() => {
  window.__rscCaptured = [];
  let rsc = window.__next_f;
  Object.defineProperty(window, '__next_f', {
    configurable: true,
    get() { return rsc; },
    set(v) {
      rsc = v;
      const origPush = Array.prototype.push;
      rsc.push = function(...args) {
        for (const arg of args) {
          if (typeof arg === 'object' && Array.isArray(arg) && arg[1] && typeof arg[1] === 'string') {
            window.__rscCaptured.push(arg[1]);
          }
        }
        return origPush.apply(rsc, args);
      };
    }
  });
})();`);

console.log('[3] navigate 到 /resource/189/3fb1cb68...');
try {
  await client._page.goto('https://hdhive.com/resource/189/3fb1cb6823c64ae4a7a0f8f23bd4bed3', { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) { console.log('  warn:', e.message.slice(0, 80)); }
await client._page.waitForTimeout(5000);

const rscState = await client._page.evaluate(() => ({
  hasCaptured: !!window.__rscCaptured,
  capturedLen: (window.__rscCaptured || []).length,
  hasNextF: !!window.__next_f,
  nextFLen: window.__next_f ? window.__next_f.length : 0
}));
console.log('[4] RSC state:', rscState);

if (rscState.capturedLen > 0) {
  const sample = await client._page.evaluate(() => (window.__rscCaptured || []).join('').slice(0, 500));
  console.log('[5] payload sample:', sample);
} else {
  console.log('[5] 没捕获到 RSC payload');
}

await client.close();