#!/usr/bin/env node
// 测试 api-client.mjs
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
console.log('[cookie]', cookie.length, 'chars');

const client = new HdhiveClient({
  baseUrl: 'https://hdhive.com',
  cookie
});

try {
  console.log('\n[step 1] 获取当前用户...');
  const user = await client.get('/api/customer/user/current');
  console.log('[user]', JSON.stringify(user, null, 2).slice(0, 800));

  console.log('\n[step 2] 查询积分日志...');
  const logs = await client.get('/api/customer/points-logs', { page: 1, page_size: 5 });
  console.log('[logs]', JSON.stringify(logs, null, 2).slice(0, 800));

  console.log('\n[step 3] 查询未读消息数...');
  const unread = await client.get('/api/customer/messages/unread-count');
  console.log('[unread]', JSON.stringify(unread, null, 2));

  console.log('\n[step 4] 查询电影资源...');
  const movies = await client.post('/api/customer/resources', {
    type: 'movie',
    tmdbId: '550'
  });
  console.log('[movies]', JSON.stringify(movies, null, 2).slice(0, 1000));

  console.log('\n[step 5] 查询公告...');
  const bulletins = await client.get('/api/public/bulletins/latest');
  console.log('[bulletins]', JSON.stringify(bulletins, null, 2).slice(0, 500));
} catch (e) {
  console.error('[error]', e.message);
  console.error(e.stack);
} finally {
  await client.close();
}