#!/usr/bin/env node
// 看看资源列表到底什么时候加载
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

await client._ensureBrowser();

const URL = 'https://hdhive.com/movie/0816e198eae211ed8d4e0242ac190003';

async function inspect(label) {
  const r = await client._page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/resource/189/"]')];
    return {
      url: location.href,
      bodyText: document.body?.innerText?.slice(0, 100),
      resourceLinkCount: links.length,
      slugs: links.map(a => a.href.match(/\/resource\/189\/([a-f0-9]{32})/)?.[1]).filter(Boolean)
    };
  });
  console.log(`[${label}]`, JSON.stringify(r));
}

console.log('[step] navigate 到 movie 页面');
try { await client._page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await inspect('after navigate');
await client._page.waitForTimeout(2000);
await inspect('after 2s wait');
await client._page.waitForTimeout(3000);
await inspect('after 5s total');

console.log('\n[step] 点击天翼云盘 tab');
const clicked = await client._page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]'));
  const target = candidates.find(el => /天翼云盘|189/.test(el.innerText || ''));
  if (target) { target.click(); return target.innerText; }
  return null;
});
console.log('  clicked:', clicked);
await client._page.waitForTimeout(2000);
await inspect('after tab click');

console.log('\n[step] 滚动');
await client._page.mouse.wheel(0, 800);
await client._page.waitForTimeout(1500);
await inspect('after scroll 1');
await client._page.mouse.wheel(0, 800);
await client._page.waitForTimeout(1500);
await inspect('after scroll 2');

await client.close();