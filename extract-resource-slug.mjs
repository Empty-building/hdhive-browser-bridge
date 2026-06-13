#!/usr/bin/env node
// 从 movie 页面提取真实的 resource slug
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  await client._ensureBrowser();

  // 访问 /movie/905baf2b... 页面
  await client._page.goto('https://hdhive.com/movie/905baf2b010911ee89d70242ac130004', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await client._page.waitForTimeout(8000);

  // 提取所有 /resource/189/ 链接
  const links = await client._page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/resource/189/"]')].map(a => ({
      href: a.href,
      text: a.innerText?.slice(0, 100)
    }));
    const html = document.documentElement.outerHTML;
    const matches = [...html.matchAll(/\/resource\/189\/([a-f0-9]{32})/g)].map(m => m[1]);
    return { anchors, matches: [...new Set(matches)] };
  });

  console.log('resource 链接:');
  for (const a of links.anchors) console.log(' ', a.href, '→', a.text);
  console.log('\n从 HTML 提取的 slug:');
  for (const slug of links.matches) console.log(' ', slug);

  if (links.matches.length > 0) {
    const realSlug = links.matches[0];
    console.log(`\n[step] 用真实 slug ${realSlug} 查询`);
    const r = await client.getResource(realSlug);
    console.log(JSON.stringify(r.data, null, 2).slice(0, 1500));
  }
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}