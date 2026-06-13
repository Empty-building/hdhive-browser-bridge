#!/usr/bin/env node
// 验证：能不能直接传 TMDB ID？
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

// 试试所有可能传 TMDB ID 的方式
const attempts = [
  { tmdb_id: 550 },
  { tmdb_id: 550, type: 'movie' },
  { tmdb_id: 550, url: 'https://www.themoviedb.org/movie/550' },
  { tmdb_id: 550, url: 'https://hdhive.com/tmdb/movie/550' },
  { tmdb_id: 550, movie_id: 550 },
  { movie_id: 550 },
  { tmdb_id: 550, movie_id: 550, url: 'https://www.themoviedb.org/movie/550' },
  // 也许有专门的端点
];

console.log('━━━ 验证：直接传 TMDB ID 能否成功 ━━━\n');
for (const body of attempts) {
  try {
    const r = await client.post('/api/customer/resources', body);
    const msg = (r.data?.description || r.data?.message || '').slice(0, 80);
    console.log(`❌ ${JSON.stringify(body).slice(0, 60).padEnd(62)} → ${msg}`);
  } catch (e) {
    console.log(`💥 ${JSON.stringify(body).slice(0, 60)} → ${e.message.slice(0, 60)}`);
  }
}

console.log('\n━━━ 关键发现 ━━━');
console.log('POST /api/customer/resources 强制要求：');
console.log('  • url (影巢分享链接)');
console.log('  • movie_id (影巢内部数字 ID，非 TMDB)');
console.log('  → 没有"TMDB → 影巢内部 ID"转换接口');

await client.close();