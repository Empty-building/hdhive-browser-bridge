#!/usr/bin/env node
// 找到真实解锁的资源 ID
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  // 找所有解锁日志
  console.log('[step] 查询更详细的积分日志');
  const logs = await client.get('/api/customer/points-logs', { page: 1, page_size: 50 });
  for (const log of logs.data?.data || []) {
    if (log.change_type === '解锁资源') {
      console.log(`  ${log.created_at} | ${log.remark} | extra: ${JSON.stringify(log)}`);
    }
  }

  // 试试其他接口
  console.log('\n[step] 查询资源解锁历史接口');
  for (const url of [
    '/api/customer/unlocks',
    '/api/customer/my-resources',
    '/api/customer/user/unlocks',
    '/api/customer/resources?is_unlocked=true',
    '/api/customer/resources?user_id=30804'
  ]) {
    try {
      const r = await client.get(url);
      console.log(`  ${url} → ${JSON.stringify(r.data).slice(0, 200)}`);
    } catch (e) {
      console.log(`  ${url} → ERROR`);
    }
  }
} catch (e) {
  console.error(e.message);
} finally {
  await client.close();
}