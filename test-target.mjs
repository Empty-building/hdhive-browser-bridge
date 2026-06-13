#!/usr/bin/env node
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  // 试试不同 target_type / target_key 格式
  console.log('[1] target_key=movie:550 (TMDB 550 = Fight Club)');
  const r1 = await client.get('/api/customer/subscriptions/check', { target_type: 'media_resource', target_key: 'movie:550' });
  console.log(JSON.stringify(r1.data).slice(0, 300));

  console.log('\n[2] target_key=movie:tmdb:550');
  const r2 = await client.get('/api/customer/subscriptions/check', { target_type: 'media_resource', target_key: 'movie:tmdb:550' });
  console.log(JSON.stringify(r2.data).slice(0, 300));

  console.log('\n[3] target_key=tmdb:movie:550');
  const r3 = await client.get('/api/customer/subscriptions/check', { target_type: 'media_resource', target_key: 'tmdb:movie:550' });
  console.log(JSON.stringify(r3.data).slice(0, 300));

  console.log('\n[4] 用正确格式 movie:1903 (搏击俱乐部内部 ID)');
  const r4 = await client.get('/api/customer/subscriptions/check', { target_type: 'media_resource', target_key: 'movie:1903' });
  console.log(JSON.stringify(r4.data).slice(0, 300));

  console.log('\n[5] 用 resources API + movie:1903');
  const r5 = await client.post('/api/customer/resources', { target_type: 'media_resource', target_key: 'movie:1903' });
  console.log(JSON.stringify(r5.data).slice(0, 600));

  console.log('\n[6] resources API 不同 body');
  const r6 = await client.post('/api/customer/resources', { movie: { id: 1903 } });
  console.log(JSON.stringify(r6.data).slice(0, 600));

  console.log('\n[7] resources API 完整结构');
  const r7 = await client.post('/api/customer/resources', { movie_id: 1903 });
  console.log(JSON.stringify(r7.data).slice(0, 600));
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}