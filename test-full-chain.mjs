#!/usr/bin/env node
// 完整链路测试（修复：已存在的链接直接查询详情）
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const SLUG = 'f9873cbb15df4a8f828c050532165b40';
const SHARE_URL = 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';

try {
  console.log('━━━ 完整链路测试 ━━━\n');

  // 步骤 1: 查询资源详情（之前测试创建的）
  console.log(`[步骤 1] GET /api/customer/resources/${SLUG}`);
  const detail = await client.get(`/api/customer/resources/${SLUG}`);
  const detailJson = JSON.stringify(detail.data, null, 2);
  console.log('        详情:', detailJson.slice(0, 2000));

  // 步骤 2: 尝试解锁
  console.log(`\n[步骤 2] POST /api/customer/resources/${SLUG}/unlock`);
  const unlock = await client.post(`/api/customer/resources/${SLUG}/unlock`);
  console.log('        解锁结果:', JSON.stringify(unlock.data, null, 2).slice(0, 1500));

  // 步骤 3: 重新查询看 189 链接
  console.log(`\n[步骤 3] 重新查询 GET /api/customer/resources/${SLUG}`);
  const detail2 = await client.get(`/api/customer/resources/${SLUG}`);
  const fullDetail = JSON.stringify(detail2.data, null, 2);
  console.log('        完整详情:', fullDetail);

  // 步骤 4: 提取网盘链接
  const links = fullDetail.match(/https?:\/\/cloud\.189\.cn\/[^\s"']+/g) || [];
  const allLinks = fullDetail.match(/https?:\/\/[^\s"']+189[^\s"']+/g) || [];
  console.log('\n━━━ 提取到的网盘链接 ━━━');
  console.log('cloud189:', links.length ? links.join('\n') : '(无)');
  console.log('189 链接:', allLinks.length ? allLinks.join('\n') : '(无)');

  // 步骤 5: 创建一个新资源测试完整链路（用积分日志里的"你的名字"）
  // 我们用另一个 URL，但需要知道其对应的数字 ID
  // 跳过这步因为没有 ID

  // 步骤 6: 解锁点数确认
  console.log('\n[步骤 6] 检查解锁需要的积分');
  const check = await client.post('/api/customer/check/resource', { url: SHARE_URL });
  console.log('        解锁信息:', JSON.stringify(check.data));
} catch (e) {
  console.error('[error]', e.message);
  console.error(e.stack);
} finally {
  await client.close();
}