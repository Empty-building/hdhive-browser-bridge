#!/usr/bin/env node
// 探测 share 字段名
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const SHARE_URL = 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';
const attempts = [
  { url: SHARE_URL, movie_id: 905 },
  { url: SHARE_URL, movie_id: 905, type: 'movie' },
  { url: SHARE_URL, movie_id: 1903 },
  { url: SHARE_URL },
  { url: SHARE_URL, type: 'movie' },
  // 嵌套结构
  { movie: { id: 905, url: SHARE_URL } },
  { media: { id: 905, url: SHARE_URL } },
  // share_url + url 都有
  { url: SHARE_URL, share_url: SHARE_URL, movie_id: 905 },
  // 从积分日志里看到的"你的名字" 资源链接（如果知道 ID）
  // 我们已知 /movie/905baf2b010911ee89d70242ac130004 是 movie 内页
  // 它的内部数字 ID 可能是 905baf2b 转为 10 进制
  { url: SHARE_URL, movie_id: 1515540244 },  // 905baf2b hex → 10 进制
  // 16 进制格式
  { url: SHARE_URL, movie_id: '905baf2b' }
];

for (const body of attempts) {
  try {
    const r = await client.post('/api/customer/resources', body);
    const ok = r.data?.success;
    const msg = r.data?.description || r.data?.message || '?';
    console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(body).slice(0, 90).padEnd(92)} → ${msg.slice(0, 80)}`);
    if (ok && r.data.data) {
      const data = Array.isArray(r.data.data) ? r.data.data : [r.data.data];
      console.log('   Resources:', data.length, 'items');
      if (data.length > 0) {
        const sample = data[0];
        console.log('   Sample:', JSON.stringify(sample).slice(0, 300));
      }
    }
  } catch (e) {
    console.log(`💥 ${JSON.stringify(body).slice(0, 80)} → ${e.message.slice(0, 100)}`);
  }
}

await client.close();