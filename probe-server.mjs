#!/usr/bin/env node
// 简化探针：找 "积分" 上下文
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  await client._ensureBrowser();
  const movieUrl = 'https://hdhive.com/movie/3a427573e1e111ed8d4e0242ac190003';
  await client._page.goto(movieUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await client._page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
  await client._page.waitForTimeout(5000);

  // 等 LOADING
  for (let i = 0; i < 20; i++) {
    const loaded = await client._page.evaluate(() => {
      const t = document.body?.innerText || '';
      return t && !t.includes('LOADING') && t.length > 100;
    });
    if (loaded) break;
    await client._page.waitForTimeout(500);
  }

  // 点天翼云盘 tab
  await client._page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('button, [role="tab"]'));
    const t = c.find(el => /天翼云盘|189/.test(el.innerText || ''));
    if (t) t.click();
  });
  await client._page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) {
    await client._page.mouse.wheel(0, 800).catch(() => {});
    await client._page.waitForTimeout(800);
  }

  // 输出 bodyText 中所有 "1 积分" 附近
  const result = await client._page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const html = document.documentElement.outerHTML;

    // 找 "1 积分" 周围的文本
    const lines = bodyText.split('\n');
    const pointsContext = [];
    for (let i = 0; i < lines.length; i++) {
      if (/积分/.test(lines[i])) {
        const ctx = lines.slice(Math.max(0, i - 3), i + 4).join(' / ');
        pointsContext.push({ line: i, text: ctx });
      }
    }

    // 找 HTML 中 slug 模式
    const slugPatterns = [
      /\/resource\/189\/([a-zA-Z0-9_-]{20,})/g,
      /"resourceId"\s*:\s*"([a-zA-Z0-9_-]{20,})"/g,
      /"id"\s*:\s*"([a-zA-Z0-9_-]{20,})"/g,
      /"slug"\s*:\s*"([a-zA-Z0-9_-]{20,})"/g
    ];
    const allSlugs = new Set();
    for (const pat of slugPatterns) {
      const matches = [...html.matchAll(pat)].map(m => m[1]);
      for (const s of matches) allSlugs.add(s);
    }

    // 找 HTML 中含 "积分" 附近的 slug
    const htmlPointsContext = [];
    const idxList = [...html.matchAll(/积分/g)].map(m => m.index);
    for (const idx of idxList.slice(0, 5)) {
      const snippet = html.slice(Math.max(0, idx - 200), Math.min(html.length, idx + 500));
      htmlPointsContext.push(snippet.replace(/\\?\"/g, '"').replace(/\\n/g, '\n'));
    }

    return {
      bodyTextLength: bodyText.length,
      pointsContext,
      allSlugs: [...allSlugs].slice(0, 20),
      htmlPointsContext
    };
  });

  console.log('=== bodyText "积分" 上下文 ===');
  for (const c of result.pointsContext) {
    console.log(`  [line ${c.line}] ${c.text}`);
  }

  console.log('\n=== 所有 slug 候选 ===');
  console.log(' ', result.allSlugs);

  console.log('\n=== HTML "积分" 上下文（去转义）===');
  for (const c of result.htmlPointsContext) {
    console.log('  ---');
    console.log('  ', c);
  }
} finally {
  await client.close();
}