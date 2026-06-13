#!/usr/bin/env node
// 测试 TMDB ID 一键解锁（无 cookie 也能 resolve）
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  console.log('━━━ TMDB ID 一键解锁测试 ━━━\n');

  // 主人提供的 TMDB ID
  console.log('[输入] TMDB movie ID = 372058\n');

  // 第一步：解析 TMDB → 内部 URL（无 cookie 也能跑）
  console.log('[step 1] 不登录解析 TMDB ID');
  const resolved = await client.resolveTmdbToInternal(372058, 'movie');
  console.log(`  → ${resolved.url}`);
  console.log(`  → 内部 slug: ${resolved.slug}\n`);

  // 第二步：爬 movie 页面找 189 资源
  console.log('[step 2] 找 189 资源');
  const resources = await client.findResourcesFromMoviePage(resolved.url);
  console.log(`  → 找到 ${resources.length} 个资源`);
  for (const r of resources.slice(0, 5)) {
    console.log(`     slug: ${r.slug}`);
    console.log(`     text: ${r.text}`);
  }

  if (resources.length === 0) {
    console.log('\n该电影没有 189 资源，跳过解锁');
  } else {
    const target = resources[0];
    console.log(`\n[step 3] 解锁第一个资源: ${target.slug}`);
    const unlock = await client.unlockResource(target.slug);
    console.log('  结果:', JSON.stringify(unlock.data));

    console.log(`\n[step 4] 爬 189 网盘链接`);
    const links = await client.getCloud189Links(target.slug);
    console.log('  189 链接:', links.cloud189Direct);
    console.log('  访问码:', links.accessCode);
    console.log('  分享大小:', links.shareSize);
  }
} catch (e) {
  console.error('[error]', e.message);
} finally {
  await client.close();
}