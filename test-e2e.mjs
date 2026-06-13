#!/usr/bin/env node
// 完整链路测试：输入分享链接 → 拿到解锁后的网盘链接
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('━━━ 链路 1：分享链接 → check → details → 网盘链接 ━━━\n');

  // 步骤 1：用 check/resource 接口探测分享链接
  const testUrl = 'https://hdhive.com/resource/189/4e9f3df3010811ee89d70242ac130004';
  console.log(`[1] 检查分享链接: ${testUrl}`);
  const check = await client.post('/api/customer/check/resource', { url: testUrl });
  console.log('    结果:', JSON.stringify(check.data));

  if (check.data?.success && check.data?.data?.url) {
    const resourceUrl = check.data.data.url;
    const match = resourceUrl.match(/\/resource\/189\/([a-f0-9]+)/);
    if (match) {
      const resourceId = match[1];
      console.log(`\n[2] 解析出 resource ID: ${resourceId}`);

      // 步骤 2：获取资源详情
      console.log(`[3] GET /api/customer/resources/${resourceId}`);
      const detail = await client.get(`/api/customer/resources/${resourceId}`);
      console.log('    结果:', JSON.stringify(detail.data, null, 2).slice(0, 1500));

      // 步骤 3：如果需要解锁
      const hasUnlocked = detail.data?.data?.some?.(r => r.unlocked || r.cloud189_url);
      if (!hasUnlocked) {
        console.log(`\n[4] 资源未解锁，尝试解锁: POST /api/customer/resources/${resourceId}/unlock`);
        const unlock = await client.post(`/api/customer/resources/${resourceId}/unlock`);
        console.log('    解锁结果:', JSON.stringify(unlock.data, null, 2).slice(0, 1500));
      }
    }
  }

  console.log('\n━━━ 链路 2：TMDB ID → 查资源 → 分享链接 ━━━\n');

  // 先访问一个真实页面找到资源的内部 ID
  // 我们已知 movie:1903 是 Fight Club（搏击俱乐部）
  console.log('[1] 尝试 subscriptions/check target_key=movie:1903');
  const sub = await client.get('/api/customer/subscriptions/check', {
    target_type: 'media_resource',
    target_key: 'movie:1903'
  });
  console.log('    结果:', JSON.stringify(sub.data));

  console.log('\n[2] 尝试 /api/customer/resources 不同 body');
  for (const body of [
    { movie_id: 1903 },
    { movie: { id: 1903 } },
    { type: 'movie', id: 1903 },
    { share_url: 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004' },
    { share_url: 'https://hdhive.com/resource/189/4e9f3df3010811ee89d70242ac130004' }
  ]) {
    const r = await client.post('/api/customer/resources', body);
    console.log(`    body=${JSON.stringify(body)}`);
    console.log(`    → ${JSON.stringify(r.data).slice(0, 300)}`);
  }

} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}