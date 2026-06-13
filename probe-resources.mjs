#!/usr/bin/env node
// 探测 /api/customer/resources 的正确 body 格式
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const SHARE_URLS = [
  'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004',
  'https://hdhive.com/resource/189/4e9f3df3010811ee89d70242ac130004'
];
const attempts = [];
for (const share_url of SHARE_URLS) {
  attempts.push({ movie_id: 550, share_url });
  attempts.push({ movie_id: 1903, share_url });
  attempts.push({ type: 'movie', movie_id: 550, share_url });
  attempts.push({ movie_id: 905, share_url });
  attempts.push({ share_url });
}

for (const body of attempts) {
  const r = await client.post('/api/customer/resources', body);
  const ok = r.data?.success;
  const msg = r.data?.description || r.data?.message || '?';
  console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(body).padEnd(70)} → ${msg.slice(0, 80)}`);
  if (ok) console.log('   data:', JSON.stringify(r.data.data).slice(0, 400));
}

await client.close();