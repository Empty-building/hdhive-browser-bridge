#!/usr/bin/env node
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('\n[尝试 7] body={ movie: { tmdb_id: 550 } }');
  const r = await client.post('/api/customer/resources', { movie: { tmdb_id: 550 } });
  console.log(JSON.stringify(r.data).slice(0, 500));

  console.log('\n[尝试 8] body={ movie: { id: 550 } }');
  const r2 = await client.post('/api/customer/resources', { movie: { id: 550 } });
  console.log(JSON.stringify(r2.data).slice(0, 500));

  console.log('\n[尝试 9] body={ movie: { tmdbId: 550 } }');
  const r3 = await client.post('/api/customer/resources', { movie: { tmdbId: 550 } });
  console.log(JSON.stringify(r3.data).slice(0, 500));

  console.log('\n[尝试 10] body={ target: { type: "movie", tmdb_id: 550 } }');
  const r4 = await client.post('/api/customer/resources', { target: { type: 'movie', tmdb_id: 550 } });
  console.log(JSON.stringify(r4.data).slice(0, 500));

  console.log('\n[尝试 11] 列出所有 resources');
  const r5 = await client.get('/api/customer/resources');
  console.log(JSON.stringify(r5.data).slice(0, 500));

  console.log('\n[尝试 12] check/resource with url');
  const r6 = await client.post('/api/customer/check/resource', { url: 'https://hdhive.com/resource/189/test' });
  console.log(JSON.stringify(r6.data).slice(0, 500));

  console.log('\n[尝试 13] query 直接传 tmdb_id=550');
  const r7 = await client.post('/api/customer/resources?movie_id=550', {});
  console.log(JSON.stringify(r7.data).slice(0, 500));

  console.log('\n[尝试 14] body={ type, movie_id }');
  const r8 = await client.post('/api/customer/resources', { type: 'movie', movie_id: 550 });
  console.log(JSON.stringify(r8.data).slice(0, 500));
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}