#!/usr/bin/env node
// 验证不同 movie_id 是否都能成功
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const URL = 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';

const attempts = [
  // server.mjs 抓到的真实 ID
  1903,
  // 从 slug 推断
  2421927723,  // 905baf2b hex
  905,         // 前 3 位
  90500,       // 前 5 位
  // 完全瞎猜
  1, 100, 1000, 10000, 999999
];

for (const movieId of attempts) {
  const r = await client.call('POST', '/api/customer/resources', {
    body: { url: URL, movie_id: movieId }
  });
  const desc = r.data?.description || r.data?.message || '';
  const status = r.data?.success ? '✅' : (desc.includes('已存在') ? '✅(已存在)' : '❌');
  console.log(`${status} movie_id=${movieId.toString().padEnd(12)} → ${desc.slice(0, 60)}`);
}

await client.close();