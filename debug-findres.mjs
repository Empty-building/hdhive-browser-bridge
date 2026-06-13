#!/usr/bin/env node
// debug findResourcesFromMoviePage 各步骤耗时
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

await client._ensureBrowser();

const URL = 'https://hdhive.com/movie/0816e198eae211ed8d4e0242ac190003';

console.log('[t=0] navigate 开始');
const t0 = Date.now();
try { await client._page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { console.log('  warn:', e.message.slice(0, 80)); }
console.log(`[t=${Date.now()-t0}ms] navigate 完成`);

// 立即检查
const r1 = await client._page.evaluate(() => ({
  url: location.href,
  text: (document.body?.innerText || '').slice(0, 100),
  readyState: document.readyState,
  nextFLen: window.__next_f?.length || 0
}));
console.log(`[t=${Date.now()-t0}ms] 初始检查:`, r1);

console.log(`[t=${Date.now()-t0}ms] 开始轮询 LOADING`);
const pollStart = Date.now();
let loaded = false;
let pollCount = 0;
while (Date.now() - pollStart < 15000) {
  loaded = await client._page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text && !text.includes('LOADING') && text.length > 100;
  });
  pollCount++;
  if (loaded) break;
  await client._page.waitForTimeout(300);
}
console.log(`[t=${Date.now()-t0}ms] LOADING 结束 (轮询 ${pollCount} 次, 用时 ${Date.now()-pollStart}ms)`);

// 检查
const r2 = await client._page.evaluate(() => ({
  text: document.body?.innerText?.slice(0, 80),
  hasTab: [...document.querySelectorAll('button, [role="tab"]')].some(b => /天翼/.test(b.innerText))
}));
console.log(`[t=${Date.now()-t0}ms] 检查 tab:`, r2);

console.log(`[t=${Date.now()-t0}ms] 点击天翼云盘`);
const clickStart = Date.now();
const clicked = await client._page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]'));
  const target = candidates.find(el => /天翼云盘|189/.test(el.innerText || ''));
  if (target) { target.click(); return true; }
  return false;
});
console.log(`[t=${Date.now()-t0}ms] 点击 ${clicked ? 'OK' : 'NO'} (用时 ${Date.now()-clickStart}ms)`);

await client._page.waitForTimeout(500);
const r3 = await client._page.evaluate(() => ({
  resourceLinkCount: [...document.querySelectorAll('a[href*="/resource/189/"]')].length,
  slugs: [...document.querySelectorAll('a[href*="/resource/189/"]')].map(a => a.href.match(/\/resource\/189\/([a-f0-9]{32})/)?.[1])
}));
console.log(`[t=${Date.now()-t0}ms] 最终结果:`, r3);

await client.close();