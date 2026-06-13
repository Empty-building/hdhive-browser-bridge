#!/usr/bin/env node
// 完整链路测试：从分享链接到网盘链接
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

try {
  const SHARE_URL = 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';
  console.log('━━━ 完整端到端测试：从分享链接到 189 网盘 ━━━\n');

  console.log('[阶段 1] API：创建/查询/解锁资源');
  const result = await client.unlockByShareUrl(SHARE_URL, 905);
  if (!result.success) {
    console.log('  ❌ 失败:', JSON.stringify(result));
    process.exit(1);
  }
  console.log(`  ✅ 资源已解锁，slug=${result.slug}`);

  console.log('\n[阶段 2] 爬取：访问详情页提取 189 网盘链接');
  const links = await client.getCloud189Links(result.slug);
  console.log(`  当前 URL: ${links.url}`);
  console.log(`  访问码: ${links.accessCode || '(无)'}`);
  console.log(`  分享大小: ${links.shareSize || '(无)'}`);
  console.log(`  189 链接数: ${links.cloud189Direct.length}`);
  if (links.cloud189Direct.length > 0) {
    console.log('\n  ━━━ 提取到的网盘分享链接 ━━━');
    for (const link of links.cloud189Direct) console.log(`  ${link}`);
  }
  console.log('\n  页面内容:');
  console.log('  ' + links.bodyText.split('\n').join('\n  '));

} catch (e) {
  console.error('[error]', e.message);
  console.error(e.stack);
} finally {
  await client.close();
}