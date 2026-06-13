#!/usr/bin/env node
// 测试 /resource/189/{slug} 格式
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('━━━ 用 resource URL 测试 ━━━\n');

  // 已有的真实 resource slug
  const RESOURCE_URL = 'https://hdhive.com/resource/189/f9873cbb15df4a8f828c050532165b40';
  const m = RESOURCE_URL.match(/\/resource\/189\/([a-f0-9]{32})/);
  const slug = m[1];
  console.log('[输入] resource slug:', slug);

  // 步骤 1：查询详情
  console.log('\n[1] 查询');
  const detail = await client.getResource(slug);
  console.log('  标题:', detail.data?.data?.title);
  console.log('  is_unlocked:', detail.data?.data?.is_unlocked);
  console.log('  movie_id:', detail.data?.data?.movie_id);
  console.log('  url:', detail.data?.data?.url);

  // 步骤 2：解锁
  console.log('\n[2] 解锁');
  const unlock = await client.unlockResource(slug);
  console.log('  结果:', JSON.stringify(unlock.data));

  // 步骤 3：爬 189 链接
  console.log('\n[3] 爬 189 网盘');
  const links = await client.getCloud189Links(slug);
  console.log('  189 链接:', links.cloud189Direct);
  console.log('  访问码:', links.accessCode);
  console.log('  bodyText:', links.bodyText?.slice(0, 300));
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}