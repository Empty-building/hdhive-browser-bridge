#!/usr/bin/env node
// 共享浏览器的基准测试
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();

async function timeIt(name, fn) {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  return { result, elapsed, name };
}

async function runTest(client, tmdbId) {
  console.log(`\n━━━ TMDB ${tmdbId} ━━━`);
  const totalStart = Date.now();

  const t1 = await timeIt('resolveTmdbToInternal', () => client.resolveTmdbToInternal(tmdbId, 'movie'));
  console.log(`  [${t1.elapsed}ms] ${t1.name}`);

  const t2 = await timeIt('findResourcesFromMoviePage', () => client.findResourcesFromMoviePage(t1.result.url));
  console.log(`  [${t2.elapsed}ms] ${t2.name} → ${t2.result.length} 个资源`);

  if (t2.result.length === 0) return null;

  const target = t2.result[0];
  const t3 = await timeIt('unlockResource', () => client.unlockResource(target.slug));
  console.log(`  [${t3.elapsed}ms] ${t3.name} → ${t3.result.data?.message}`);

  const t4 = await timeIt('getCloud189Links', () => client.getCloud189Links(target.slug));
  console.log(`  [${t4.elapsed}ms] ${t4.name} → ${t4.result.fullText}`);

  const total = Date.now() - totalStart;
  console.log(`  🎯 总耗时: ${total}ms (${(total/1000).toFixed(2)}s)`);
  return { total, steps: [t1.elapsed, t2.elapsed, t3.elapsed, t4.elapsed] };
}

// 一个 client 跑所有
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

console.log('[启动] 浏览器 + 首页（首次较慢）');
const initStart = Date.now();
await client._ensureBrowser();
console.log(`  ${Date.now() - initStart}ms\n`);

const results = [];
for (const id of [372058, 550, 129, 13]) {
  const r = await runTest(client, id);
  if (r) results.push({ id, ...r });
}

await client.close();

console.log('\n━━━ 共享浏览器汇总 ━━━');
console.log('TMDB ID  | 总耗时 | resolve | findRes | unlock | get189');
for (const r of results) {
  const [a, b, c, d] = r.steps;
  console.log(`${String(r.id).padEnd(8)} | ${String(r.total).padEnd(5)}ms | ${a+'ms'.padEnd(5)} | ${b+'ms'.padEnd(5)} | ${c+'ms'.padEnd(5)} | ${d+'ms'.padEnd(5)}`);
}
const avg = results.reduce((s, r) => s + r.total, 0) / results.length;
console.log(`\n平均: ${avg.toFixed(0)}ms (${(avg/1000).toFixed(2)}s)`);