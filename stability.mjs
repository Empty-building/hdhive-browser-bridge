#!/usr/bin/env node
// 稳定性测试：连续 5 次解锁，看是否稳定
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const TMDB_IDS = [372058, 550, 129, 13, 680]; // 你的名字、搏击俱乐部、千与千寻、阿甘、辛德勒

let successCount = 0;
let failCount = 0;
const results = [];

console.log('━━━ 稳定性测试：5 次连续 TMDB 解锁 ━━━\n');

for (let i = 0; i < TMDB_IDS.length; i++) {
  const tmdbId = TMDB_IDS[i];
  const start = Date.now();
  try {
    const r = await client.unlockByTmdbId(tmdbId, 'movie');
    const elapsed = Date.now() - start;
    if (r.success) {
      successCount++;
      results.push({
        id: tmdbId,
        ok: true,
        time: elapsed,
        cloud189: r.cloud189.fullText
      });
      console.log(`✓ [${i+1}/5] TMDB ${tmdbId}: ${elapsed}ms → ${r.cloud189.fullText}`);
    } else {
      failCount++;
      results.push({ id: tmdbId, ok: false, time: elapsed, error: r.error });
      console.log(`⊘ [${i+1}/5] TMDB ${tmdbId}: ${elapsed}ms → ${r.error}`);
    }
  } catch (e) {
    failCount++;
    const elapsed = Date.now() - start;
    results.push({ id: tmdbId, ok: false, time: elapsed, error: e.message });
    console.log(`✗ [${i+1}/5] TMDB ${tmdbId}: ${elapsed}ms → ${e.message.slice(0, 100)}`);
  }
}

console.log('\n━━━ 稳定性结果 ━━━');
console.log(`成功(拿到网盘): ${successCount}/5`);
console.log(`失败(无资源/异常): ${failCount}/5`);
if (results.length > 0) {
  const okResults = results.filter(r => r.ok);
  if (okResults.length > 0) {
    const times = okResults.map(r => r.time);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    const min = Math.min(...times);
    console.log(`耗时: 平均 ${avg.toFixed(0)}ms, 最快 ${min}ms, 最慢 ${max}ms`);
  }
}

const noResource = results.filter(r => !r.ok && r.error?.includes('no 189'));
if (noResource.length > 0) {
  console.log(`\n注: ${noResource.length} 个电影本身没有 189 资源（数据问题，不是代码问题）`);
}

await client.close();
process.exit(failCount > 0 ? 1 : 0);