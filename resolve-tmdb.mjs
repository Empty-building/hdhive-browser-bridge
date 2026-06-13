#!/usr/bin/env node
// 测试 TMDB → 内部 movie_id 转换
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('[step] 用内部方法解析 TMDB ID');
  // 用 client 内部浏览器访问 /tmdb/movie/550
  await client._ensureBrowser();

  const result = await client._page.evaluate(async () => {
    // 检查 module 41263（axios 客户端）
    let webpackRequire = window.__hdhiveRequire;
    if (!webpackRequire) {
      window.webpackChunk_N_E.push([['__p__'], {}, (req) => { webpackRequire = req; window.__hdhiveRequire = req; }]);
    }
    const mod41263 = webpackRequire(41263);
    return Object.keys(mod41263);
  });
  console.log('mod 41263 exports:', result);

  // 直接 navigate 到 /tmdb/movie/550，看重定向后的 URL
  console.log('\n[step] 访问 /tmdb/movie/550');
  await client._page.goto('https://hdhive.com/tmdb/movie/550', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await client._page.waitForTimeout(8000);

  const info = await client._page.evaluate(() => ({
    url: location.href,
    title: document.title,
    // 查找 __NEXT_DATA__ 或 RSC payload
    nextData: window.__NEXT_DATA__ ? JSON.stringify(window.__NEXT_DATA__).slice(0, 1000) : null,
    // RSC payload in script tags
    rscPayload: [...document.querySelectorAll('script')].map(s => s.textContent).find(t => t && t.includes('"target_key"'))?.slice(0, 1000),
    bodyText: document.body?.innerText?.slice(0, 200)
  }));
  console.log('  最终 URL:', info.url);
  console.log('  title:', info.title);
  console.log('  __NEXT_DATA__:', info.nextData);
  console.log('  RSC:', info.rscPayload);
  console.log('  bodyText:', info.bodyText);

  // 提取内部 movie_id
  const m = info.url.match(/\/movie\/([a-f0-9]{24})/);
  if (m) {
    const internalSlug = m[1];
    console.log('\n[step] 找到内部 slug:', internalSlug);
    // 内部 movie_id 可能是 hex 转 10 进制
    const numericId = parseInt(internalSlug.slice(0, 8), 16);
    console.log('  尝试转 10 进制:', numericId);

    // 试试用这个 slug 创建资源（无需 movie_id）
    console.log('\n[step] 用 slug 创建资源');
    const r1 = await client.call('POST', '/api/customer/resources', {
      body: { url: info.url, movie_id: numericId }
    });
    console.log('  结果:', JSON.stringify(r1.data).slice(0, 500));
  }
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}