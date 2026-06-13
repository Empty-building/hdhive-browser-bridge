#!/usr/bin/env node
// 测试：传 TMDB ID 直接解锁
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('━━━ TMDB ID 一键解锁测试 ━━━\n');

  // 传 TMDB ID = 550 (搏击俱乐部)
  console.log('[输入] TMDB movie ID = 550');
  const result = await client.unlockByTmdbId(550, 'movie');

  if (result.success) {
    console.log(`\n✅ 解锁成功！`);
    console.log(`   slug: ${result.slug}`);
    console.log(`   resource ID: ${result.resourceId}`);
    console.log(`   unlock message: ${result.unlock.message}`);

    // 爬 189 网盘链接
    console.log('\n[step 5] 爬取 189 网盘链接');
    const links = await client.getCloud189Links(result.slug);
    console.log('  189 链接:', links.cloud189Direct);
    console.log('  访问码:', links.accessCode);
    console.log('  分享大小:', links.shareSize);
  } else {
    console.log('\n❌ 失败:', JSON.stringify(result, null, 2).slice(0, 500));
  }
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}