# 影巢 API 桥接（hdhive-browser-bridge）

Hybrid 桥接服务：优先用 **纯 Node WASM API** 完成搜索/解锁，必要时回落 **Playwright 浏览器**。  
对外仍提供 cloud189-auto-save 兼容的 `/hdhive/*` 接口。

推荐！[Docker快速部署](DEPLOY.md)

> ⚠️ 本项目仅用于学习研究，请遵守影巢的服务条款。

---

## 📑 目录

1. [核心特性](#核心特性)
2. [Hybrid 模式](#hybrid-模式)
3. [安装](#安装)
4. [准备 Cookie / bindSecret](#准备-cookie--bindsecret)
5. [快速开始](#快速开始)
6. [HTTP 接口](#http-接口)
7. [SDK 用法](#sdk-用法)
8. [Docker](#docker)
9. [性能基准](#性能基准)
10. [架构原理](#架构原理)
11. [故障排查](#故障排查)
12. [常见问题](#常见问题)

---

## 核心特性

- ⚡ **Hybrid**：`pure-api` 优先，失败自动回落浏览器；对外接口不变
- 🚀 冷搜索约 **6s**（pure），缓存命中 **毫秒级**；旧浏览器桥常见 30–40s
- 🔐 只需 cookie + `bindSecret`，不必每次账号密码登录
- 🎯 支持 TMDB ID / resource slug / 分享解锁等常用路径
- 🧩 兼容 cloud189-auto-save 的 `media-resources` / `resources/:id/unlock`
- 🛡️ 浏览器路径保留 stealth / 验证码求解 / 登录导出

---

## Hybrid 模式

| `HYBRID_MODE` | 行为 |
|---------------|------|
| `auto`（默认） | pure 优先，失败回落浏览器 |
| `pure` | 只走 pure，不回落 |
| `browser` | 只走 Playwright |

| 能力 | pure | 浏览器 |
|------|------|--------|
| 用户/积分/未读/通用 customer API | ✅ | ✅ |
| TMDB → 内部 slug（`NEXT_REDIRECT`） | ✅ | ✅ |
| 资源列表（movie 页 `groupData.189`） | ✅ | ✅ DOM |
| 解锁 + 提取码（unlock API） | ✅ | ✅ |
| 登录导出 cookie / bindSecret | ❌ | ✅ |
| 签到空间点选验证码 | ❌ | ✅ |
| `unlock/share` 创建资源等 | 部分/回落 | ✅ |

环境变量：

```bash
HYBRID_MODE=auto
AUTO_WARMUP=true
AUTO_WARMUP_BROWSER=false   # pure 就绪即可对外，默认不预热 Chromium
HDHIVE_PROXY=socks5://127.0.0.1:1081
HDHIVE_COOKIE=...
HDHIVE_BIND_SECRET=...      # 2026-07 后握手 bind_token 必需
BRIDGE_TOKEN=hdhive-local-token
```

`/health` 会返回：

```json
{
  "ready": true,
  "hybrid": {
    "mode": "auto",
    "pureReady": true,
    "browserReady": false,
    "lastEngine": "pure",
    "pureCalls": 16,
    "pureFallbacks": 0
  }
}
```

---

## 安装

```bash
cd hdhive-browser-bridge
npm install
# 只有需要浏览器回落/登录/验证码时才装 Chromium
npx playwright install chromium
```

**依赖**：

- `express` — HTTP 服务
- `pg` — 可选 Postgres cookie 持久化
- `playwright` — 浏览器回落 / 登录 / 验证码
- 无额外 pure 依赖：WASM + 原生 SOCKS5

源码分层：

| 文件 | 作用 |
|------|------|
| `server.mjs` | REST 壳，hybrid 调度，对外接口 |
| `pure-api-client.mjs` | 纯 Node：WASM 签名 + HTML 解析 |
| `api-client.mjs` | Playwright 引擎 |
| `vendor/hdh-security.wasm` | 官方签名 WASM |
| `dump-cookies.mjs` | 登录导出 cookie + bindSecret |

---

## 准备 Cookie / bindSecret

### 方式 A：自动导出（推荐）

```bash
# 需要可达代理时：
export HDHIVE_PROXY=socks5://127.0.0.1:1081
node dump-cookies.mjs "your@email.com" "your-password"
```

输出：

- `/tmp/hdhive-cookies.txt`
- `/tmp/hdhive-bind-secret.txt`（IndexedDB `bindSecret`，握手 `bind_token`）

### 方式 B：手动

1. 浏览器登录 https://hdhive.com
2. 复制 cookie：`hdh_sa_token` / `csrf_access_token` / `hdh_uid` / `token` / `refresh_token`
3. bindSecret 从站点 IndexedDB `hdh-secure-bind` → `bindSecret` 读取，或登录接口返回

### 有效期

- JWT `token` 约 7 天
- 过期后重新 `dump-cookies` 或 `POST /hdhive/login`
- 缺 bindSecret 时 customer API 易出现 `session_user_mismatch`

---

## 快速开始

### 1）启动 Bridge（推荐）

```bash
# 本地脚本（hybrid auto，不预热浏览器）
bash start-local.sh

# 或手动
export BRIDGE_TOKEN=hdhive-local-token
export HDHIVE_COOKIE="$(tr -d '\r\n' </tmp/hdhive-cookies.txt)"
export HDHIVE_BIND_SECRET="$(tr -d '\r\n' </tmp/hdhive-bind-secret.txt)"
export HDHIVE_PROXY=socks5://127.0.0.1:1081
export HYBRID_MODE=auto
export AUTO_WARMUP_BROWSER=false
node server.mjs
```

### 2）搜资源 + 解锁

```bash
# 列表（不扣积分）
curl -s -X POST \
  -H 'x-bridge-token: hdhive-local-token' \
  -H 'content-type: application/json' \
  -d '{"type":"movie","tmdbId":"568160"}' \
  http://127.0.0.1:10000/hdhive/customer/media-resources

# 解锁（已拥有不重复扣费）
curl -s -X POST \
  -H 'x-bridge-token: hdhive-local-token' \
  http://127.0.0.1:10000/hdhive/customer/resources/<slug>/unlock
```

### 3）纯 SDK（不启 HTTP）

```js
import { PureHdhiveClient } from './pure-api-client.mjs';
import fs from 'node:fs';

const client = new PureHdhiveClient({
  cookie: fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim(),
  bindSecret: fs.readFileSync('/tmp/hdhive-bind-secret.txt', 'utf8').trim(),
  proxy: 'socks5://127.0.0.1:1081'
});

const list = await client.mediaResourcesByTmdb(568160, 'movie');
const unlocked = await client.unlockByResourceSlug(list.resources[0].slug);
console.log(unlocked.link, unlocked.accessCode);
```

浏览器 SDK 仍可用：

```js
import { HdhiveClient } from './api-client.mjs';
```

---

## HTTP 接口

鉴权：除 `/health` 外，需 `x-bridge-token: <BRIDGE_TOKEN>` 或 `?token=`。

| Method | Path | 扣积分 | Hybrid |
|--------|------|--------|--------|
| GET | `/health` | 否 | pure/browser 就绪信息 |
| GET | `/metrics` | 否 | 含 hybrid 计数 |
| GET | `/hdhive/customer/current` | 否 | pure→browser |
| GET | `/hdhive/customer/points-logs` | 否 | pure→browser |
| POST | `/hdhive/customer/checkin` | 否 | 无验证码 pure；`autoVerify` 强制浏览器 |
| POST | `/hdhive/customer/media-resources` | 否 | pure HTML 列表→browser |
| POST | `/hdhive/preview/tmdb/:tmdbId` | 否 | pure→browser |
| GET | `/hdhive/customer/resources/:id` | 否* | pure unlock 取链→browser |
| POST | `/hdhive/customer/resources/:id/unlock` | 可能 | pure→browser |
| POST | `/hdhive/unlock/tmdb/:tmdbId` | 可能 | pure→browser |
| POST | `/hdhive/unlock/resource/:slug` | 可能 | pure→browser |
| GET | `/hdhive/resource/:slug/cloud189` | 否* | pure→browser |
| POST | `/hdhive/login` | 否 | 浏览器 |
| POST | `/hdhive/unlock/share` | 可能 | 浏览器 |

\* 已解锁资源走 unlock 接口通常 `already_owned`，不重复扣费。

### media-resources 示例响应

```json
{
  "success": true,
  "data": {
    "engine": "pure",
    "movieSlug": "3a427573e1e111ed8d4e0242ac190003",
    "resources": [
      {
        "id": "17dd11eba9a543998470f3fb3a49dc11",
        "slug": "17dd11eba9a543998470f3fb3a49dc11",
        "title": "4K原盘REMUX DV & HDR ...",
        "uploader": "最爱你的人望眼欲穿",
        "sizeFormatted": "66.69 GB",
        "points": 1,
        "isFree": false,
        "cloudType": "cloud189"
      }
    ]
  }
}
```

### 积分保护建议

1. 先 `POST /hdhive/preview/tmdb/:id` 或 `media-resources`
2. 确认 `points` / 是否已解锁
3. 再调用 unlock

---

## SDK 用法

### PureHdhiveClient（推荐给 API 路径）

```js
const client = new PureHdhiveClient({ cookie, bindSecret, proxy });
await client.handshake();
await client.getCurrentUser();
await client.resolveTmdbToInternal(568160, 'movie');
await client.mediaResourcesByTmdb(568160, 'movie');
await client.unlockByResourceSlug(slug);
```

CLI：

```bash
node pure-api-client.mjs                 # current + resolve 自检
node pure-api-client.mjs 568160 movie    # 列表
node pure-api-client.mjs <resourceSlug>  # 解锁
```

### HdhiveClient（浏览器路径）

保留原能力：`unlockByTmdbId` / `findResourcesFromMoviePage` / `checkin({autoVerify:true})` / `getCloud189Links` 等。更多细节见 `API-CLIENT.md`。

---

## Docker

分支 `feat/hybrid-pure-api` 起，镜像需包含：

- `server.mjs`
- `api-client.mjs`
- `pure-api-client.mjs`
- `vendor/hdh-security.wasm`

```bash
export BRIDGE_TOKEN=hdhive-local-token
export HDHIVE_COOKIE='...'
export HDHIVE_BIND_SECRET='...'
# 容器访问宿主机代理：不要用 127.0.0.1
export HDHIVE_PROXY=socks5://172.17.0.1:1081
export HYBRID_MODE=auto
export AUTO_WARMUP_BROWSER=false

docker compose build hdhive-api
docker compose up -d hdhive-api
curl -s http://127.0.0.1:10000/health
```

说明：

- 旧 ghcr 镜像可能仍是纯浏览器桥，需用本分支重新 build
- 登录/验证码回落仍依赖 Playwright 基础镜像
- 完整部署说明见 [DEPLOY.md](DEPLOY.md)

---

## 性能基准

### Hybrid pure（本机 + socks5 代理，无 Chromium）

| 接口 | 耗时 |
|------|------|
| `/health` | ~20ms |
| `current` | ~2.5–3s |
| `media-resources` 冷 | ~6s |
| `media-resources` 缓存 | ~5ms |
| `unlock`（已拥有） | ~2.5s |

### 旧浏览器桥（对比）

| 场景 | 耗时 |
|------|------|
| 冷搜索 `media-resources` | 常 30–40s |
| 端到端解锁（历史优化后） | ~8–10s 量级 |

瓶颈通常是 **代理 RTT**，不是 WASM 签名本身。

---

## 架构原理

```
客户端
  │
  ▼
server.mjs  (对外 /hdhive/* 不变)
  │
  ├─ pure-api-client.mjs
  │    ├─ WASM signRequest / handshake(+bind_token)
  │    ├─ /tmdb/* HTML → NEXT_REDIRECT → movie slug
  │    └─ /movie/* HTML → __next_f groupData["189"] 列表
  │
  └─ api-client.mjs (Playwright 回落)
       ├─ 登录 / 验证码 / DOM 兜底
       └─ webpack 39154 signedFetch
```

### 签名要点

```
X-HDH-Cid / X-HDH-TS / X-HDH-Nonce / X-HDH-Sig / X-HDH-Kid
handshake body: { client_pub, ua_fingerprint, ts, bind_token }
```

- WASM：`vendor/hdh-security.wasm`（官方 `hdh_security_bg.wasm`）
- 胶水：webpack 模块 **1918**
- signedFetch 调度：模块 **39154**（旧 9110 已失效）

---

## 故障排查

### 1. Docker 启动报找不到 pure-api-client / WASM

用包含 hybrid 打包的提交重建镜像（Dockerfile 需 COPY `pure-api-client.mjs` + `vendor/`）。

### 2. `session_user_mismatch` / 请先登录

缺 `HDHIVE_BIND_SECRET` 或 cookie 不完整。重新 dump-cookies / login。

### 3. 容器内 pure 全超时

代理写成了 `127.0.0.1`。容器里应指向宿主机网关，或 `network_mode: host`。

### 4. `cannot resolve TMDB`

代理不通或页面无 `NEXT_REDIRECT`。先：

```bash
curl --proxy socks5h://127.0.0.1:1081 -s https://hdhive.com/tmdb/movie/568160 | rg NEXT_REDIRECT
```

### 5. 搜索有列表但 title 像用户名

旧 DOM 解析问题；hybrid pure 从 `remark` 取资源名，uploader 单独字段。

### 6. 验证码签到失败

`autoVerify=true` 必须走浏览器，并配置 `CAPTCHA_AI_*` 或 heuristic。

---

## 常见问题

### Q: 必须用 Playwright 吗？

日常搜/解锁：**不必须**（hybrid pure）。登录、验证码、部分兜底：**需要**。

### Q: 对外接口变了吗？

**没有。** cloud189 继续打原 `/hdhive/*` 即可；响应可多一个 `engine: pure|browser` 字段。

### Q: 会不会更容易封控？

pure 走官方签名协议，正常个人用量风险低。避免高频扫库/多 IP 狂刷。

### Q: 能并发吗？

pure 可多连接；浏览器路径仍建议串行（单 page）。`server.mjs` 对浏览器操作有队列。

### Q: cookie 安全吗？

只放服务端环境变量/加密 DB，不要提交到 git。

---

## 测试文件

- `node pure-api-client.mjs 568160 movie`
- `npm run check` — 语法检查
- `bash start-local.sh` 后打 `/health` + `media-resources`

更多逆向细节见 `API-CLIENT.md`，部署见 `DEPLOY.md`。

---

## 限制与免责

- 仅供学习研究，遵守站点条款与当地法律
- 影巢改版可能导致 webpack 模块号 / HTML 结构变化
- 本项目不附带任何可用性或积分安全保证

---

## 更新日志

### v3.0（Hybrid）

- 新增 `pure-api-client.mjs`：WASM 签名 + TMDB/列表 HTML 解析
- `server.mjs` hybrid 调度：`HYBRID_MODE=auto|pure|browser`
- 搜索/解锁默认可无 Chromium
- Docker 打包补齐 pure + `vendor/hdh-security.wasm`
- 资源 title 修复：不再把上传者昵称当标题

### v2.0（浏览器优化版）

- 资源列表/取链提速，约 40s → 8s 量级
- 验证码自动求解、cookie DB、cloud189 兼容契约

### v1.0

- Playwright + signedFetch 基础桥接

---

## License

仅供学习研究使用。
