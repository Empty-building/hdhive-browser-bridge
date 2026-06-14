# 影巢 API 客户端（hdhive-api-client）

纯 Node.js 客户端，通过 Playwright + 浏览器内部 WASM 签名模块调用影巢（hdhive.com）的所有 customer API。**无需账号密码**，只需 cookie 即可使用。

> ⚠️ 本项目仅用于学习研究，请遵守影巢的服务条款。

---

## 📑 目录

1. [核心特性](#核心特性)
2. [安装](#安装)
3. [准备 Cookie](#准备-cookie)
4. [快速开始](#快速开始)
5. [API 文档](#api-文档)
6. [4 种调用方式](#4-种调用方式)
7. [完整示例](#完整示例)
8. [性能基准](#性能基准)
9. [架构原理](#架构原理)
10. [故障排查](#故障排查)
11. [常见问题](#常见问题)

---

## 核心特性

- 🚀 **8 秒拿到网盘链接**（优化后 5 倍提速）
- 🔐 **无需账号密码**，只用 cookie 即可调用所有 customer API
- 🎯 **支持 4 种输入格式**：TMDB ID / 影巢 movie URL / 影巢 resource URL / 纯 slug
- 🛡️ **完整反爬绕过**：WebGL patch / User-Agent / 浏览器指纹 / navigator.webdriver
- 🔄 **会话自动管理**：自动处理 WASM 握手、ECDH 密钥派生、签名过期重试
- 📊 **完整数据提取**：访问码、网盘链接、备注、分享大小

---

## 安装

```bash
# 1. 克隆或下载项目
cd hdhive-browser-bridge

# 2. 安装依赖（已经安装好则跳过）
npm install

# 3. 确保 Playwright 浏览器已安装
npx playwright install chromium
```

**依赖列表**（package.json）：
- `express` ^4.18.3 — Bridge HTTP 服务
- `pg` ^8.21.0 — Postgres 客户端
- `playwright` 1.49.1 — 浏览器自动化
- `playwright-extra` ^4.3.6 — 反检测插件
- `puppeteer-extra-plugin-stealth` ^2.11.2 — Stealth 模式

---

## 准备 Cookie

### 方式 A：自动导出（推荐）

```bash
node dump-cookies.mjs "your@email.com" "your-password"
```

会启动一个反检测浏览器自动登录，登录完成后把所有 cookie 写入 `/tmp/hdhive-cookies.txt`。

**输出文件格式**（一行 `name=value; name=value`）：
```
hdh_sa_token=xxx; csrf_access_token=xxx; hdh_uid=30804; token=eyJ...; refresh_token=eyJ...
```

### 方式 B：手动导出

1. 浏览器打开 https://hdhive.com 并登录
2. F12 → Application → Cookies → hdhive.com
3. 复制以下 5 个 cookie（按 `name=value` 格式，`; ` 分隔）：
   - `hdh_sa_token`（必需）
   - `csrf_access_token`（必需）
   - `hdh_uid`（必需）
   - `token`（必需，JWT）
   - `refresh_token`（可选）

### Cookie 有效期

- `token` JWT 默认 7 天过期
- `hdh_sa_token` 长期有效
- 过期后需要重新登录导出

---

## 快速开始

### 一行命令测试

```bash
# 解锁 TMDB ID 372058（你的名字）并拿网盘链接
node -e "
import('./api-client.mjs').then(async ({ HdhiveClient }) => {
  const fs = await import('node:fs');
  const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
  const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });
  const result = await client.unlockByTmdbId(372058, 'movie');
  console.log('网盘链接:', result.cloud189.fullText);
  await client.close();
});
"
```

### 最简项目集成

```js
// app.js
import { HdhiveClient } from './api-client.mjs';

const cookie = process.env.HDHIVE_COOKIE; // 从环境变量读
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

// 解锁 TMDB ID 并拿网盘
app.get('/unlock/:tmdbId', async (req, res) => {
  try {
    const result = await client.unlockByTmdbId(Number(req.params.tmdbId), 'movie');
    res.json({
      success: true,
      cloud189Url: result.cloud189.url,
      accessCode: result.cloud189.accessCode,
      fullText: result.cloud189.fullText
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

---

## API 文档

### 构造函数

```ts
new HdhiveClient(options?: {
  baseUrl?: string   // 默认 'https://hdhive.com'
  cookie?: string    // 必填，cookie 字符串
  userAgent?: string // 默认 Win10 Chrome 125
  headless?: boolean // 默认 true
})
```

### 通用方法

#### `call(method, path, options?)`
底层 API 调用方法，自动处理签名 + Cookie + CSRF。

```js
const r = await client.call('GET', '/api/customer/user/current');
// r = { status, ok, data }
```

#### `get(path, query?)` / `post(path, body?, query?)` / `put / delete`

便捷方法。

```js
const user = await client.get('/api/customer/user/current');
const logs = await client.get('/api/customer/points-logs', { page: 1, page_size: 10 });
const checkin = await client.post('/api/customer/user/checkin');
```

### 业务方法

#### `getCurrentUser()`
获取当前登录用户信息。
```js
const user = await client.getCurrentUser();
console.log(user.data.data.nickname, user.data.data.user_meta.points);
```

#### `getPointsLogs(query?)`
获取积分变更日志。
```js
const logs = await client.getPointsLogs({ page: 1, page_size: 20 });
for (const log of logs.data.data) {
  console.log(`${log.created_at} | ${log.change_type} | ${log.remark}`);
}
```

#### `checkin()`
每日签到。默认会在签到前后读取当前用户积分，用于返回本次积分变化；如只需要原始签到结果，可传 `{ includeUser: false }` 跳过额外查询。
```js
const r = await client.checkin();
console.log(r.message, r.checkedIn, r.alreadyCheckedIn, r.pointsDelta);
// {
//   success: true,
//   checkedIn: true,
//   alreadyCheckedIn: false,
//   requiresVerification: false,
//   challenge: null,
//   previousPoints: 100,
//   currentPoints: 101,
//   pointsDelta: 1,
//   data: { ...原始影巢响应 }
// }
```

如果当前环境触发 `space_captcha`，可启用自动验证：

```js
const r = await client.checkin({
  autoVerify: true,
  verificationSolver: 'ai',
  verificationAttempts: 3
});
```

AI 求解器只接收验证码图片、提示语和本地图像分割出的候选坐标，不会发送 Cookie、账号或 `challenge_ticket`。需要通过环境变量或构造参数配置：

```bash
CAPTCHA_AI_BASE_URL=https://cpar.114514heihei.eu.org/v1
CAPTCHA_AI_API_KEY=your-api-key
CAPTCHA_AI_MODEL=web2api/gemini-auto
```

当影巢返回验证码要求时，`success` 为 `false`，同时会包含结构化的 `challenge`：

```js
{
  requiresVerification: true,
  challengeTicket: '...',
  challengeType: 'space_captcha',
  captchaMode: 'space',
  challenge: {
    ticket: '...',
    type: 'space_captcha',
    captchaMode: 'space',
    action: 'checkin',
    expiresInSeconds: 600
  }
}
```

#### `getUnreadCount()`
获取未读消息数。
```js
const r = await client.getUnreadCount();
console.log('未读:', r.data.data.unread_count);
```

#### `getBulletins()`
获取最新公告。
```js
const r = await client.getBulletins();
console.log(r.data.data.title);
```

#### `getResource(slugOrId)`
查询资源详情。
```js
const r = await client.getResource('f9873cbb15df4a8f828c050532165b40');
console.log(r.data.data);
```

#### `unlockResource(slugOrId)`
解锁资源（消耗积分）。
```js
const r = await client.unlockResource('f9873cbb15df4a8f828c050532165b40');
// { data: { access_code, full_url, url, already_owned }, message }
```

#### `checkResource(url)`
检查分享链接（不消耗积分）。
```js
const r = await client.checkResource('https://hdhive.com/resource/189/abc123...');
// { data: { website, url, default_unlock_points }, message }
```

#### `createResource(shareUrl, movieId?)`
创建资源记录。
```js
const r = await client.createResource(
  'https://hdhive.com/movie/0816e198eae211ed8d4e0242ac190003',
  372058  // TMDB ID（实际不严格校验，可传任意数字）
);
```

#### `resolveTmdbToInternal(tmdbId, type?)`
TMDB ID → 影巢内部 URL（**无需登录**，拦截首次重定向）。
```js
const r = await client.resolveTmdbToInternal(372058, 'movie');
// { type: 'movie', slug: '0816e198...', url: 'https://hdhive.com/movie/0816e198...' }
```

#### `findResourcesFromMoviePage(movieInternalUrl)`
从 movie 页面找 189 资源列表（无需登录）。
```js
const resources = await client.findResourcesFromMoviePage(movieUrl);
// [{ slug, url, text }]
```

#### `getCloud189Links(slugOrUrl)`
从 resource 页面提取 189 网盘分享链接（含访问码）。
```js
const links = await client.getCloud189Links('3fb1cb6823c64ae4a7a0f8f23bd4bed3');
// {
//   url: 'https://cloud.189.cn/t/YnqE3aJJv2qy',
//   accessCode: 'f8bq',
//   shareSize: '...',
//   remark: '4K原盘REMUX...',
//   fullText: 'https://cloud.189.cn/t/YnqE3aJJv2qy（访问码：f8bq）'
// }
```

### 端到端方法

#### `unlockByTmdbId(tmdbId, type?)` ⭐ 推荐
**TMDB ID 一键解锁**（最常用）。
```js
const result = await client.unlockByTmdbId(372058, 'movie');
// {
//   success: true,
//   tmdbId: 372058,
//   type: 'movie',
//   movieSlug: '0816e198...',
//   resourceSlug: '3fb1cb68...',
//   unlock: { access_code, full_url, url, message },
//   cloud189: { url, accessCode, shareSize, fullText, source }
// }
```

#### `unlockByResourceSlug(slugOrUrl)`
用 resource slug 完整流程。
```js
const r = await client.unlockByResourceSlug('https://hdhive.com/resource/189/3fb1cb68...');
```

#### `unlockByShareUrl(shareUrl, movieId?)`
用任意分享 URL 完整流程。
```js
const r = await client.unlockByShareUrl(
  'https://hdhive.com/movie/0816e198...',
  372058  // 可选，任意数字
);
```

### 生命周期

#### `close()`
关闭浏览器实例。建议进程退出前调用。

```js
process.on('SIGINT', async () => {
  await client.close();
  process.exit(0);
});
```

---

## 4 种调用方式

| 场景 | 方法 | 输入示例 |
|------|------|----------|
| **有 TMDB ID**（最常见） | `unlockByTmdbId` | `client.unlockByTmdbId(372058, 'movie')` |
| **有影巢 movie URL** | `unlockByShareUrl` | `client.unlockByShareUrl('https://hdhive.com/movie/0816e198...', 1)` |
| **有影巢 resource URL/slug** | `unlockByResourceSlug` | `client.unlockByResourceSlug('3fb1cb6823c64ae4a7a0f8f23bd4bed3')` |
| **手动分步** | `getResource` + `unlockResource` + `getCloud189Links` | 见下方 |

### 手动分步（高级）

```js
// 1. 查询资源
const detail = await client.getResource('3fb1cb6823c64ae4a7a0f8f23bd4bed3');
console.log('需要积分:', detail.data.data.unlock_points);

// 2. 解锁
const unlock = await client.unlockResource('3fb1cb6823c64ae4a7a0f8f23bd4bed3');
console.log('访问码:', unlock.data.access_code);

// 3. 拿网盘链接
const links = await client.getCloud189Links('3fb1cb6823c64ae4a7a0f8f23bd4bed3');
console.log('网盘:', links.fullText);
```

---

## ⚠️ 确认调用流程（积分保护）

**`unlockByTmdbId` / `unlockByResourceSlug` / `unlockByShareUrl` / `/hdhive/unlock/*` 都会消耗积分！**

### 积分规则

| 资源状态 | 调用 unlock 接口后 |
|---------|-------------------|
| `unlock_points = 0`（免费） | ❌ 不扣 |
| `unlock_points > 0`（付费）+ 已解锁 | ❌ 不重复扣（返回 `already_owned: true`）|
| `unlock_points > 0`（付费）+ 未解锁 | ✅ **扣 unlock_points 积分** |

### 推荐流程（先预览后解锁）

```js
// ✅ 第 1 步：预览（不消耗积分）
const preview = await client.previewTmdb(372058, 'movie');
console.log(`当前积分: ${preview.currentPoints}`);
console.log(`该电影有 ${preview.resources.length} 个资源`);
console.log(`总扣费: ${preview.totalCost} 积分`);
for (const r of preview.resources) {
  console.log(`  - ${r.title}: ${r.unlock_points} 积分`);
}

// 确认后再解锁
if (preview.totalCost > 0 && preview.currentPoints >= preview.totalCost) {
  // ✅ 第 2 步：确认后一键解锁（消耗积分）
  const result = await client.unlockByTmdbId(372058, 'movie');
  console.log(result.cloud189.fullText);
}
```

### HTTP 等价接口

```bash
# 第 1 步：预览（不消耗积分）
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:10000/hdhive/preview/tmdb/372058

# 第 2 步：确认后一键解锁（消耗积分）
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:10000/hdhive/unlock/tmdb/372058
```

### 批量解锁 + 积分预算

```js
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const tmdbIds = [372058, 550, 129, 13, 680];
const MAX_POINTS_PER_MOVIE = 5;  // 每个电影最多花 5 积分
const POINTS_BUDGET = 50;         // 总预算 50 积分

let totalSpent = 0;

for (const tmdbId of tmdbIds) {
  // 第 1 步：预览
  const preview = await client.previewTmdb(tmdbId, 'movie');
  if (!preview.success) {
    console.log(`⊘ TMDB ${tmdbId}: 预览失败`);
    continue;
  }

  if (preview.resources.length === 0) {
    console.log(`⊘ TMDB ${tmdbId}: 没有 189 资源`);
    continue;
  }

  const cost = preview.totalCost;
  const cheapest = Math.min(...preview.resources.map(r => r.unlock_points || 0));

  // 预算检查
  if (totalSpent + cheapest > POINTS_BUDGET) {
    console.log(`⊘ TMDB ${tmdbId}: 预算不足（已花 ${totalSpent}/${POINTS_BUDGET}）`);
    continue;
  }

  if (cheapest > MAX_POINTS_PER_MOVIE) {
    console.log(`⊘ TMDB ${tmdbId}: 最便宜资源需 ${cheapest} 积分，超过单电影预算`);
    continue;
  }

  // 第 2 步：解锁
  try {
    const result = await client.unlockByTmdbId(tmdbId, 'movie');
    totalSpent += cost;
    console.log(`✓ TMDB ${tmdbId}: ${result.cloud189.fullText} (累计 ${totalSpent} 积分)`);
  } catch (e) {
    console.log(`✗ TMDB ${tmdbId}: ${e.message.slice(0, 80)}`);
  }
}

console.log(`\n总共花费 ${totalSpent} 积分`);
await client.close();
```

### 不消耗积分的接口（安全）

| 接口 | 说明 |
|------|------|
| `GET /hdhive/customer/current` | 当前用户 |
| `GET /hdhive/customer/points-logs` | 积分日志 |
| `GET /hdhive/customer/messages/unread-count` | 未读消息 |
| `POST /hdhive/customer/checkin` | **签到（增加积分；可用 `autoVerify=true` 自动处理验证码）** |
| `GET /hdhive/customer/playlists/my` | 我的播放列表 |
| `POST /hdhive/customer/subscriptions/check` | 订阅检查 |
| `GET /hdhive/customer/resources/:id` | 资源详情（限创建者）|
| `POST /hdhive/customer/check/resource` | 检查分享链接 |
| **`POST /hdhive/preview/tmdb/:id`** ⭐ | **预览资源（不消耗）** |
| `GET /hdhive/public/bulletins/latest` | 最新公告 |
| `GET /hdhive/resource/:slug/cloud189` | **已解锁资源**的网盘链接 |

### 会消耗积分的接口（谨慎调用）

| 接口 | 副作用 |
|------|--------|
| `POST /hdhive/unlock/tmdb/:id` | 解锁 + 扣积分 |
| `POST /hdhive/unlock/resource/:slug` | 解锁 + 扣积分 |
| `POST /hdhive/unlock/share` | 解锁 + 扣积分 |

### 积分不足的处理

影巢服务器在积分不足时会返回错误，不会强行扣分。建议：

```js
try {
  const result = await client.unlockByTmdbId(tmdbId);
  // 处理成功
} catch (e) {
  if (e.message.includes('积分不足') || e.message.includes('points')) {
    console.log('积分不足，跳过');
    // 可以调用 checkin() 增加积分
    await client.checkin();
  }
}
```

---

## 完整示例

### 示例 1：批量解锁多个 TMDB 电影（含积分保护）

参考上方 [确认调用流程](#-确认调用流程积分保护) 章节的"批量解锁 + 积分预算"示例。**建议**：

```js
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const tmdbIds = [372058, 550, 129, 13, 680];
const POINTS_BUDGET = 50;
let totalSpent = 0;

for (const tmdbId of tmdbIds) {
  // ✅ 先预览（不消耗积分）
  const preview = await client.previewTmdb(tmdbId, 'movie');
  if (!preview.success || preview.resources.length === 0) {
    console.log(`⊘ TMDB ${tmdbId}: 无资源`);
    continue;
  }

  // 预算检查
  if (totalSpent + preview.cheapestCost > POINTS_BUDGET) {
    console.log(`⊘ TMDB ${tmdbId}: 预算不足`);
    continue;
  }

  // ✅ 再解锁（消耗积分）
  try {
    const result = await client.unlockByTmdbId(tmdbId, 'movie');
    totalSpent += preview.cheapestCost;
    console.log(`✓ TMDB ${tmdbId}: ${result.cloud189.fullText}`);
  } catch (e) {
    console.error(`✗ TMDB ${tmdbId}: ${e.message}`);
  }
}

console.log(`\n总共花费 ${totalSpent} 积分`);
await client.close();
```

### 示例 2：Express HTTP 服务

```js
import express from 'express';
import { HdhiveClient } from './api-client.mjs';

const app = express();
const cookie = process.env.HDHIVE_COOKIE;
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

app.get('/user', async (req, res) => {
  const r = await client.getCurrentUser();
  res.json(r.data);
});

app.get('/unlock/:tmdbId', async (req, res) => {
  try {
    const r = await client.unlockByTmdbId(Number(req.params.tmdbId), 'movie');
    res.json({
      success: true,
      cloud189: r.cloud189.fullText,
      slug: r.resourceSlug
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/checkin', async (req, res) => {
  const r = await client.checkin();
  res.json(r.data);
});

app.listen(3000, () => {
  console.log('HDHive API 服务运行在 http://localhost:3000');
});

process.on('SIGTERM', () => client.close());
```

### 示例 3：解锁后写入文件

```js
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

const tmdbIds = JSON.parse(fs.readFileSync('./movies.json', 'utf8'));
const results = [];

for (const { tmdbId, title } of tmdbIds) {
  try {
    const r = await client.unlockByTmdbId(tmdbId, 'movie');
    results.push({
      title,
      tmdbId,
      cloud189Url: r.cloud189.url,
      accessCode: r.cloud189.accessCode
    });
  } catch (e) {
    results.push({ title, tmdbId, error: e.message });
  }
}

fs.writeFileSync('./unlocked.json', JSON.stringify(results, null, 2));
console.log('已保存', results.length, '条结果');

await client.close();
```

### 示例 4：批量解锁 + 转存到自己的网盘（思路）

```js
import { HdhiveClient } from './api-client.mjs';

const cookie = process.env.HDHIVE_COOKIE;
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });

// 步骤 1：解锁拿到 cloud189 链接
const r = await client.unlockByTmdbId(372058, 'movie');
console.log('源链接:', r.cloud189.fullText);

// 步骤 2：用其他工具（如 cloud189-cli）转存到自己网盘
// await transferCloud189(r.cloud189.url, r.cloud189.accessCode, myAccount);

await client.close();
```

---

## 性能基准

测试环境：Linux + Chromium + Node 24，TMDB ID `372058`（你的名字）。

| 阶段 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 1. `resolveTmdbToInternal` | 2.3s | 4.0s* | 持平 |
| 2. `findResourcesFromMoviePage` | **30.8s** | **3.5s** | 🚀 8.8 倍 |
| 3. `unlockResource` | 0.5s | 0.5s | 持平 |
| 4. `getCloud189Links` | **10.6s** | **0.7s** | 🚀 15 倍 |
| **总计** | **44.8s** | **8.7s** | **🚀 5 倍** |

*resolve 时间波动较大，因为是独立浏览器首次启动。

### 优化关键

1. **复用浏览器**：避免每次 resolve 都新建 ctx
2. **拦截图片/字体/广告**：节省 3-5s
3. **取消滚动**：点 tab 后资源列表立即在 DOM 中（节省 5s）
4. **用 `page.content()` 替代 RSC 拦截**：直接读 HTML（节省 10s）
5. **智能等待 LOADING**：轮询替代固定等待（节省 2s）

### 批量场景

解锁 N 个电影的总耗时 ≈ 8 + (N-1) × 8 秒（共享浏览器）。

| N | 首次 | 后续 | 总耗时 |
|---|------|------|--------|
| 1 | 8.7s | - | 8.7s |
| 5 | 8.7s | 4 × 8s | 40.7s |
| 10 | 8.7s | 9 × 8s | 80.7s |

---

## 架构原理

### 影巢的 API 保护机制

影巢使用 **X25519 ECDH + 自研哈希链** 对每个 API 请求签名：

```
请求头：
  X-HDH-Cid   会话 ID（handshake 返回）
  X-HDH-TS    毫秒时间戳
  X-HDH-Nonce 16字节十六进制随机数
  X-HDH-Sig   64字符十六进制签名
  X-HDH-Kid   固定为 "1"
  X-CSRF-TOKEN 从 cookie 的 csrf_access_token 读取
```

### 签名流程

```
1. 浏览器加载 webpack 模块 1918 + WASM
2. init() 生成 X25519 密钥对 → client_pub（32字节 base64）
3. POST /api/public/security/session/handshake
   客户端 → {client_pub, ua_fingerprint, ts}
   服务器 → {cid, server_pub, expires_at}
4. finalizeHandshake(cid, server_pub, 1) 派生 ECDH 共享密钥
5. 每次请求：signRequest(method, path, ts, nonce, body, userId) 计算签名
6. 发送请求并附带 5 个 X-HDH-* 头
```

### 客户端实现策略

```js
// 复用浏览器的 signedFetch（webpack 模块 9110 的 t5 export）
async call(method, path, options) {
  // 1. 在浏览器中获取 webpack require
  // 2. 调用 mod.t5(path, init) —— 这会自动：
  //    - 处理 session 握手（如果过期）
  //    - 调用 signRequest 生成签名
  //    - 附带 X-HDH-* 头发起 fetch
  // 3. 返回响应 JSON
}
```

### WASM 模块

- 路径：`https://hdhive.com/wasm/hdh_security_bg.wasm`（52KB）
- 依赖：`curve25519-dalek`、`hkdf`、`hmac`、`wasm-bindgen`
- 导出函数：`init()`, `finalizeHandshake()`, `signRequest()`, `verifyResponse()`

---

## 故障排查

### 1. `cannot resolve TMDB ...`
resolveTmdbToInternal 超时。影巢可能临时拒绝或网络问题。**已加重试机制**（最多 2 次）。

### 2. `登录表单未出现`（dump-cookies.mjs）
- 检查是否被反爬识别：访问 https://hdhive.com 看是否显示"出现了很奇怪的错误"
- 尝试：删除 `~/.cache/ms-playwright/` 重新下载浏览器
- 尝试：开启 `BROWSER_HEADLESS=false` 调试模式

### 3. `Module 9110 not loaded`
webpack 模块未加载。可能原因：
- 页面 navigate 不完整
- cookie 过期

解决：刷新页面（client 自动 retry）。

### 4. `权限不足 / 403`
调用 `/api/customer/resources/{id}` 时出现。说明该资源不是你创建的，普通 API 不返回完整数据。

解决：使用 `getCloud189Links(slug)` 从页面爬取（绕过权限检查）。

### 5. `WASM 模块加载失败`
页面导航导致 wasm chunk 被卸载。**已自动 reload 重试**。

### 6. `没有 189 资源`
`findResourcesFromMoviePage` 返回空。可能原因：
- 该电影没有 189 资源（只有磁链、115、quark 等）
- 资源需要先解锁才能看到（罕见）

解决：尝试不同 movie_id 或确认资源存在。

---

## 常见问题

### Q: 必须用 Playwright 吗？不能纯 HTTP？
**A:** 影巢的签名算法在 WASM 内（X25519 + HKDF + HMAC），完全逆向不现实。本项目通过 Playwright 在浏览器内调用官方 WASM 模块，最稳定。

理论上可以从浏览器提取 WASM + 胶水代码直接 Node.js 调用，但需要完整实现 `__wbindgen_*` 桥接，工作量大且易碎。

### Q: cookie 会不会泄露？
**A:** cookie 只存储在本地文件 `/tmp/hdhive-cookies.txt`，本项目不发送到任何外部服务器。建议：
- 文件权限设为 `chmod 600`
- 不要提交到 git
- 定期更换

### Q: 能并发调用吗？
**A:** 当前 `HdhiveClient` 内部是单浏览器实例。**不推荐并发调用同一个 client**（共享 page 状态）。

并发方案：每个请求创建独立 client（开销大）。

### Q: WASM 模块能不能本地缓存？
**A:** 可以。如果 `/tmp/hdh-rsc-payload.txt` 已经存在，会优先从本地加载。也可以下载 WASM：
```bash
curl -sLo /tmp/hdh_security_bg.wasm https://hdhive.com/wasm/hdh_security_bg.wasm
```

### Q: 如何调试？
```bash
# 开启浏览器调试模式
BROWSER_HEADLESS=false node test-tmdb-final.mjs

# 查看 network 日志
DEBUG=pw:api node benchmark-v3.mjs
```

### Q: 影巢改版后接口变了怎么办？
A: 需要更新：
1. `api-client.mjs` 中的 API 路径
2. `findResourcesFromMoviePage` 的 DOM 提取逻辑
3. `getCloud189Links` 的 HTML 提取正则

通常影巢改版不影响核心签名机制（WASM 不会轻易改）。

---

## 测试文件

| 文件 | 用途 |
|------|------|
| `dump-cookies.mjs` | 登录导出 cookie |
| `test-api-client.mjs` | 基础 API 测试 |
| `test-resources.mjs` | 资源查询不同 body 格式探测 |
| `test-full-chain.mjs` | 完整链路测试 |
| `test-tmdb-final.mjs` | TMDB ID 一键解锁测试 |
| `test-e2e.mjs` | 端到端测试 |
| `benchmark.mjs` | 优化前基准测试 |
| `benchmark-v3.mjs` | 优化后基准测试（推荐） |

## 辅助文件

| 文件 | 用途 |
|------|------|
| `intercept.mjs` | 抓包分析（早期） |
| `dump-sources.mjs` | 提取 webpack 模块源码 |
| `extract-full-glue.mjs` | 提取 WASM 胶水代码 |
| `probe-*.mjs` | 各种调试探针 |

---

## 限制与免责

- 本项目仅用于学习研究，请遵守影巢的服务条款
- 不要用于商业用途或大规模爬取
- 影巢 IP 在大陆被屏蔽，需要科学上网（参见影巢公告）
- 不要高频调用（影巢可能封号）
- cookie 泄露风险由使用者自行承担

---

## 更新日志

### v2.0（优化版）
- ✅ 5 倍速度优化（40s → 8s）
- ✅ 复用浏览器实例
- ✅ 拦截图片/广告加速
- ✅ 取消滚动加载
- ✅ 用 `page.content()` 替代 RSC 拦截
- ✅ 智能 LOADING 检测
- ✅ resolveTmdbToInternal 重试机制

### v1.0（基础版）
- 完整逆向影巢 API 签名机制
- 实现 4 种调用方式
- 基本功能可用（40s）

---

## License

MIT（仅供学习）
