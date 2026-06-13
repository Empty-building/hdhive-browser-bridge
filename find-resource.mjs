#!/usr/bin/env node
// 找真实解锁过的资源 ID
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('[1] 我的资源列表');
  const my = await client.get('/api/customer/resources/my', { page: 1, page_size: 20 });
  console.log(JSON.stringify(my.data, null, 2).slice(0, 2000));

  console.log('\n[2] 已解锁资源');
  const unlocked = await client.get('/api/customer/resources/unlocked', { page: 1, page_size: 20 });
  console.log(JSON.stringify(unlocked.data, null, 2).slice(0, 2000));

  console.log('\n[3] 试试看 /me/resources');
  const me = await client.get('/api/customer/me/resources', { page: 1, page_size: 20 });
  console.log(JSON.stringify(me.data).slice(0, 500));

  console.log('\n[4] 试试 my-unlocks');
  const unlocks = await client.get('/api/customer/my-unlocks', { page: 1, page_size: 20 });
  console.log(JSON.stringify(unlocks.data).slice(0, 500));

  console.log('\n[5] 试试 unlock-logs');
  const ul = await client.get('/api/customer/unlock-logs', { page: 1, page_size: 20 });
  console.log(JSON.stringify(ul.data).slice(0, 1500));

} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}