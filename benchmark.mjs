#!/usr/bin/env node
// 速度基准测试
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();

async function timeIt(name, fn) {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  console.log(`  ${name}: ${elapsed}ms`);
  return { result, elapsed };
}

async function runTest(tmdbId) {
  console.log(`\n━━━ TMDB ${tmdbId} 完整链路 ━━━`);
  const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });
  const totalStart = Date.now();

  try {
    // 步骤 1：解析 TMDB（无 cookie）
    const t1 = await timeIt('1. resolveTmdbToInternal', () => client.resolveTmdbToInternal(tmdbId, 'movie'));

    // 步骤 2：找资源（无 cookie）
    const t2 = await timeIt('2. findResourcesFromMoviePage', () => client.findResourcesFromMoviePage(t1.result.url));

    // 步骤 3：查询资源（需 cookie + 握手）
    const t3 = await timeIt('3. getResource', () => client.getResource(t2.result[0].slug));

    // 步骤 4：解锁（需 cookie）
    const t4 = await timeIt('4. unlockResource', () => client.unlockResource(t2.result[0].slug));

    // 步骤 5：爬 189 链接（需 cookie + 页面访问）
    const t5 = await timeIt('5. getCloud189Links', () => client.getCloud189Links(t2.result[0].slug));

    const total = Date.now() - totalStart;
    console.log(`\n  总耗时: ${total}ms (${(total/1000).toFixed(2)}s)`);
    console.log(`  找到 ${t2.result.length} 个资源`);
    console.log(`  189 链接: ${t5.result.cloud189Direct[0] || '无'}`);
    console.log(`  访问码: ${t5.result.accessCode || '无'}`);

    return { total, steps: [t1.elapsed, t2.elapsed, t3.elapsed, t4.elapsed, t5.elapsed] };
  } finally {
    await client.close();
  }
}

// 预热（启动浏览器一次）
console.log('[预热] 启动浏览器...');
const warmupClient = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });
const warmupStart = Date.now();
await warmupClient._ensureBrowser();
console.log(`  浏览器启动: ${Date.now() - warmupStart}ms`);
await warmupClient.close();

// 真实测试
const results = [];
for (const id of [372058, 550, 129]) {
  const r = await runTest(id);
  results.push({ id, ...r });
}

console.log('\n━━━ 汇总 ━━━');
console.log('TMDB ID  | 总耗时 | resolve | findRes | getRes | unlock | get189');
for (const r of results) {
  const [a, b, c, d, e] = r.steps;
  console.log(`${String(r.id).padEnd(8)} | ${String(r.total+'ms').padEnd(6)} | ${a+'ms'.padEnd(6)} | ${b+'ms'.padEnd(6)} | ${c+'ms'.padEnd(6)} | ${d+'ms'.padEnd(6)} | ${e+'ms'.padEnd(6)}`);
}