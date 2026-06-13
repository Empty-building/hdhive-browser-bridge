#!/usr/bin/env node
// 最简调用示例：从分享链接 → 拿到 189 网盘链接
import { HdhiveClient } from './api-client.mjs';

// ────────────────────────────────────────────────
// 1. 准备 cookie（一次性从浏览器导出）
// ────────────────────────────────────────────────
// 方式 A：用 dump-cookies.mjs 登录导出（一次性，需要账号密码）
//   $ node dump-cookies.mjs "your@email.com" "your-password"
//   → 输出到 /tmp/hdhive-cookies.txt
//
// 方式 B：手动从浏览器 DevTools 复制 cookie
//   F12 → Application → Cookies → hdhive.com
//   复制这几个：hdh_sa_token, csrf_access_token, hdh_uid, token, refresh_token
// ────────────────────────────────────────────────

import fs from 'node:fs';
const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();

// ────────────────────────────────────────────────
// 2. 创建客户端
// ────────────────────────────────────────────────
const client = new HdhiveClient({
  baseUrl: 'https://hdhive.com',
  cookie  // 只要 cookie，不需要账号密码
});

// ────────────────────────────────────────────────
// 3. 调用 API
// ────────────────────────────────────────────────

// (A) 简单查询
const user = await client.get('/api/customer/user/current');
console.log('当前用户:', user.data?.data?.nickname, '| 积分:', user.data?.data?.user_meta?.points);

// (B) 完整流程：分享链接 → 解锁 → 网盘链接
//     注意：movie_id 是影巢内部 ID，需要从真实分享链接获取
const SHARE_URL = 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';
const MOVIE_ID = 905;  // 影巢内部 ID（不是 TMDB ID）

const result = await client.unlockByShareUrl(SHARE_URL, MOVIE_ID);
if (result.success) {
  console.log('解锁成功！slug =', result.slug);

  // 爬取 189 网盘链接
  const links = await client.getCloud189Links(result.slug);
  console.log('189 网盘链接:', links.cloud189Direct);
  console.log('访问码:', links.accessCode);
}

// (C) 通用调用（POST + 查询参数）
const logs = await client.get('/api/customer/points-logs', { page: 1, page_size: 10 });
console.log('积分日志:', logs.data?.data?.length, '条');

// 签到
const checkin = await client.post('/api/customer/user/checkin');
console.log('签到结果:', checkin.data?.message);

await client.close();