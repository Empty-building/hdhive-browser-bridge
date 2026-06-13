#!/usr/bin/env node
// 优化后基准测试
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();

async function timeIt(name, fn) {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  return { result, elapsed, name };
}

async function runTest(tmdbId) {
  console.log(`\n━━━ TMDB ${tmdbId} ━━━`);
  const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });
  const totalStart = Date.now();
  const steps = [];

  try {
    const t1 = await timeIt('1. resolveTmdbToInternal', () => client.resolveTmdbToInternal(tmdbId, 'movie'));
    steps.push(t1);
    console.log(`  [${t1.elapsed}ms] ${t1.name} → ${t1.result.url}`);

    const t2 = await timeIt('2. findResourcesFromMoviePage', () => client.findResourcesFromMoviePage(t1.result.url));
    steps.push(t2);
    console.log(`  [${t2.elapsed}ms] ${t2.name} → ${t2.result.length} 个资源`);

    if (t2.result.length === 0) {
      console.log('  无资源，跳过');
      return;
    }

    const target = t2.result[0];
    const t3 = await timeIt('3. unlockResource', () => client.unlockResource(target.slug));
    steps.push(t3);
    console.log(`  [${t3.elapsed}ms] ${t3.name} → ${t3.result.data?.message}`);

    const t4 = await timeIt('4. getCloud189Links', () => client.getCloud189Links(target.slug));
    steps.push(t4);
    console.log(`  [${t4.elapsed}ms] ${t4.name} → ${t4.result.fullText}`);

    const total = Date.now() - totalStart;
    console.log(`\n  🎯 总耗时: ${total}ms (${(total/1000).toFixed(2)}s)`);
    return { total, steps: steps.map(s => s.elapsed) };
  } finally {
    await client.close();
  }
}

// 预热
console.log('[预热] 启动浏览器...');
const warmup = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });
const warmupStart = Date.now();
await warmup._ensureBrowser();
console.log(`  ${Date.now() - warmupStart}ms`);
await warmup.close();

// 测试
const ids = [372058, 550, 129];
const results = [];
for (const id of ids) {
  const r = await runTest(id);
  if (r) results.push({ id, ...r });
}

console.log('\n━━━ 优化后汇总 ━━━');
console.log('TMDB ID  | 总耗时 | resolve | findRes | unlock | get189');
for (const r of results) {
  const [a, b, c, d] = r.steps;
  console.log(`${String(r.id).padEnd(8)} | ${String(r.total).padEnd(5)}ms | ${a+'ms'.padEnd(5)} | ${b+'ms'.padEnd(5)} | ${c+'ms'.padEnd(5)} | ${d+'ms'.padEnd(5)}`);
}
const avg = results.reduce((s, r) => s + r.total, 0) / results.length;
console.log(`\n平均: ${avg.toFixed(0)}ms (${(avg/1000).toFixed(2)}s)`);