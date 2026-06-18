# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

影巢（hdhive.com）API 反爬逆向 + 浏览器桥接服务。
核心思路：**影巢把 X25519 ECDH + HMAC 签名算在浏览器 WASM 里**，所以本项目用 Playwright 跑一个常驻 Chromium 上下文，在页面内调用 webpack 模块的 `signedFetch`（模块 9110 的 `t5()`）完成 API 调用，通过 HTTP 暴露给外部。

代码分两层（一个引擎 + 一个 HTTP 壳）：

- `api-client.mjs` — **真正的引擎**：`HdhiveClient` 类，承载所有浏览器生命周期、stealth、签名调用、TMDB 解锁链路、签到验证码求解。既是 SDK 也是 server 的依赖。
- `server.mjs` — **薄 REST 包装**（生产部署）：`import { HdhiveClient } from './api-client.mjs'`，把它包成 `/hdhive/*` HTTP 接口，加上 Token 鉴权、只读短缓存、Postgres 加密 cookie 存储。**自身不含任何浏览器/签名逻辑。**
- `hdhive-client.mjs` — 纯 Node.js + WASM 原型（实验性，依赖外部 `/tmp/hdh-wasm-glue-full.js`，不推荐，基本跑不起来）。
- `server.mjs.backup` — ⚠️ **旧版独立桥接服务**（2241 行，自管 `actionQueue`/`ensurePage`/`installStealthInitScript`/`customerRequest`）。已被 git 跟踪但已废弃，**不要据它改功能**，它只是历史快照。

完整说明见 `README.md`（用户面文档）、`API-CLIENT.md`（逆向成果 + 接口表）、`DEPLOY.md`（容器化/生产部署指南）。**所有源码注释都是中文，新代码注释请保持中文。**

## 常用命令

```bash
# 安装依赖 + Playwright 浏览器
npm install
npx playwright install chromium

# 启动生产桥接服务（默认 :10000；dev 是 start 的别名）
npm start
npm run dev

# 语法检查（server.mjs 与 api-client.mjs 两个都查）
npm run check          # node --check server.mjs && node --check api-client.mjs

# 健康检查（503 = 浏览器/cookie 未就绪）
curl -s localhost:10000/health | jq

# 登录态导出（一次性，登录后写入 /tmp/hdhive-cookies.txt）
node dump-cookies.mjs "<email>" "<password>"

# 封装好的测试/基准脚本（npm run）
npm run test:api          # node test-api-client.mjs（基础 API 调用）
npm run test:bench        # node benchmark-v3.mjs（性能基准，应 < 10s）
npm run test:stability    # node stability.mjs（连续解锁稳定性）

# Docker
npm run docker:build      # docker build -t hdhive-api:latest .
npm run docker:run        # 带 BRIDGE_TOKEN=test + 透传 $HDHIVE_COOKIE

# 调试模式（启动可见 Chromium）
BROWSER_HEADLESS=false node test-tmdb-final.mjs
DEBUG=pw:api node benchmark-v3.mjs
```

单脚本直接 `node xxx.mjs` 即可。**没有统一的测试 runner**——`test-*.mjs` 各自独立。

## 核心架构

### 1. 引擎 `api-client.mjs`（`HdhiveClient`，~1940 行）

单 Playwright 持久化 context（`launchPersistentContext`，临时 `os.tmpdir()` profile），注入 cookie 后在 `page.evaluate` 内调用官方 `signedFetch`。

- **签名调用核心** `call(method, path, {query, body})`（`api-client.mjs:430`）：在页面内执行 `REGISTER_AND_RUN` 字符串（`api-client.mjs:13-59`）——通过 `window.webpackChunk_N_E` 注入探针拿到 `webpackRequire`，定位 webpack 模块 **9110**（缺失时 `await webpackRequire.e(9110)` 重载），用 `mod9110.P$({getUserId})` 注册 userId 钩子，再 `await mod9110.t5(fullPath, init)` 发起官方 signedFetch。`getUserId` 从 cookie `hdh_uid` 或解 `token` JWT 取值。
- **签名失败自愈**：`call()` 的 catch 块（`api-client.mjs:445-451`）匹配 `/WASM|wasm|SignedFetchError|签名|加载失败/i`，命中则 `_reloadPage()` 后重试一次（应对 navigate 导致模块 9110 卸载）。
- **5x 速度优化**（40s → 8s）：复用 browser；`_ensureBrowser` 内 `context.route` 拦截 image/font/media + umami 统计 abort（`api-client.mjs:357-366`）；`getCloud189Links` 用 `page.content()` 正则匹配替代 RSC 拦截（`:1773`）；`_waitForMoviePageReady` 智能 LOADING 轮询（`:403`）；`resolveTmdbToInternal` 优先复用当前 page，否则开独立临时 context + 重试（`:1547`）。
- **端到端入口** `unlockByTmdbId(tmdbId, type='movie')`（`:1850`）最常用：`resolve → findResourcesFromMoviePage → unlockResource → getCloud189Links` 一条龙。
- **无登录获取 cloud189**：`findResourcesFromMoviePage`（`:1644`）+ `getCloud189Links`（`:1773`）只用 DOM 抓 `/resource/189/{slug}` 页面的 `cloud.189.cn/t/...` 链接 + 访问码。
- **查积分不扣分** `getResourceUnlockInfo(resourceOrSlug)`（`:1426`）：优先读 DOM 字段（`unlock_points`/`default_unlock_points`/`is_free`），缺失才用 `checkResource` 兜底；`previewTmdb`（`:1490`）靠它做解锁前预算（`{currentPoints, totalCost, cheapestCost}`）。
- **其它便捷方法**：`getUnreadCount`/`getBulletins`/`getPlaylists`/`checkSubscription`/`unlockByResourceSlug`/`unlockByShareUrl`，以及通用 `get/post/put/delete`（透传 `call`）。
- **导出**：具名 `export { STEALTH_SCRIPT, RSC_INTERCEPTOR_SCRIPT }`（`:148`）、`export class HdhiveClient`（`:320`）、`export default HdhiveClient`（`:1940`）。

### 2. HTTP 壳 `server.mjs`（~1077 行，生产部署）

`import { HdhiveClient, STEALTH_SCRIPT, RSC_INTERCEPTOR_SCRIPT } from './api-client.mjs'`，纯 Express 包装层：

- **单例 client** `getClient(cookieOverride)`（`server.mjs:68-97`）：全局只有一个 `state.client`（`HdhiveClient` 实例），cookie 与现有实例不同则 `close()` 旧的并重建。**没有 actionQueue/enqueueAction/ensurePage**——并发安全靠 `HdhiveClient` 内部单 page。
- **超时封装** `withTimeout(actionName, fn)`（`:282-306`）：`Promise.race` + setTimeout，超时常量 `config.actionTimeoutMs`（默认 **180000ms**）。`state.activeAction` 只记录当前动作名，不是排队。
- **Token 中间件**（`:58-65`）：`config.bridgeToken` 为空时**整体放行**（关闭鉴权）；否则除 `/health` 外所有路由要求 `x-bridge-token` 头或 `?token=` 等于 `BRIDGE_TOKEN`。**无独立的「敏感」中间件**，全局统一一道。
- **Cookie 优先级** `getRequestCookieAsync(req)`（`:100`）：`body.cookie` > `x-hdhive-cookie` 头 > `HDHIVE_COOKIE` env > Postgres `loadCookieFromDb`。
- **只读短缓存**（`:113-150`）：`state.readCache`（Map），TTL `config.readCacheTtlMs`（`READ_CACHE_TTL_MS` 或旧名 `MEDIA_RESOURCES_CACHE_TTL_MS`，默认 60s，0 关闭）。缓存键 = 参数小写 + cookie 的 sha256 前 16 位指纹（**隔离不同账号**）。**只有 `POST /hdhive/customer/media-resources` 和 `POST /hdhive/preview/tmdb/:tmdbId` 用缓存**；命中返回 `cache.hit:true`。**所有写操作（checkin/unlock*/browser restart）都调 `clearReadCache()`**——新增写路由记得加。
- **Postgres 加密 cookie 存储**（`:152-279`）：配置 `DATABASE_URL`（或 `BRIDGE_STATE_DATABASE_URL`）后建表 `hdhive_cookies`，cookie 用 aes-256-gcm 加密（密钥 = `sha256(BRIDGE_STATE_SECRET || BRIDGE_TOKEN)`），按 `COOKIE_KEY`（或 `BRIDGE_STATE_KEY`，默认 `'default'`）存。`/hdhive/login` 成功自动落库；启动时 env ↔ DB 双向同步。
- **启动钩子** `app.listen`（`:1028-1068`）：初始化 DB → cookie 同步 → 若 `AUTO_WARMUP !== 'false'` 且有 `defaultCookie` 则一次性 `client._ensureBrowser()` 预热设 `warmupOk`。**没有 keepAlive/warmup 周期定时器，没有 setInterval。** `/health` 就绪条件 = `state.client && state.warmupOk`。

### 3. 签到验证码自动求解（空间点选 space captcha）

近期新增、CLAUDE.md 旧版完全没覆盖的大块逻辑（全在 `api-client.mjs`，约 `:201-1412`）。`checkin(options)`（`:1346`）支持 `autoVerify`：

1. 先 `POST /api/customer/user/checkin`，若返回挑战（`challenge_ticket`/`captcha_mode`）且 `autoVerify=true` → `_solveSpaceCaptcha`（`:1232`）。
2. 拉 `/captcha-api/slider` 取图 → 三种 solver 定位点击坐标 → `POST /captcha-api/slider/verify` 提交拿 `verify_token`（最多 `verificationAttempts` 次，夹到 1–5）。
   - `heuristic`：`_locateSpaceCaptchaTarget`（`:493`）在 `page.evaluate` 内做像素级分割（HSV 颜色匹配、连通域、形状/大小评分），解析中文提示任务选坐标。
   - `ai`：`_locateSpaceCaptchaTargetWithAi`（`:1031`）画带坐标网格的图，调 OpenAI 兼容 `${captchaAiBaseUrl}/chat/completions`（默认模型 `web2api/gemini-auto`）让视觉模型返回 `{x,y,id}`。**只发图不发 cookie。**
   - `auto`（调度器 `_locateSpaceCaptchaTargetWithSolver` `:1165`）：AI 失败回退 heuristic。
3. 拿到 `verify_token` 后用 `_callCheckinServerAction`（`:1184`）通过 Next.js server action 重放签到：`webpackRequire(41607).createServerReference(actionId='60529bb5...22ea', ..., 'checkIn')`，必要时 `webpackRequire.e(5530)` 加载 chunk。
4. 用积分前后快照（`pointsDelta`）兜底判定成功；`sanitizeCaptchaVerification` 剔除 `verify_token` 不外泄。

`HdhiveClient` 构造函数读 `CAPTCHA_AI_BASE_URL`/`CAPTCHA_AI_API_KEY`/`CAPTCHA_AI_MODEL`/`CAPTCHA_SOLVER`（`:331-334`）。

### 4. cloud189-auto-save 兼容契约

`GET /hdhive/customer/resources/:resourceId`、`POST .../:resourceId/unlock`、`POST /hdhive/customer/media-resources` 三个接口专为对接 [cloud189-auto-save](https://github.com/) 设计：响应同时给**扁平字段** `link`/`code`/`accessCode`/`fullUrl` 和**嵌套** `resources[]`/`detail`/`payload`/`raw`，`cloudType` 固定 `'cloud189'`，`sizeFormatted` 由 `formatSize` 生成。**改这三个接口的返回结构会破坏 SDK 兼容**——`test-cloud189-compat.mjs` 直接 import 它的真实 SDK 工具来校验字段。

### 5. WASM 原型 `hdhive-client.mjs`（不推荐）

`loadWasmModule` 直接 `WebAssembly.instantiate` 加载 `node_modules/hdh-security.wasm`，手工实现 `__wbg_*` 桥接，**需要 `/tmp/hdh-wasm-glue-full.js`**（浏览器提取的 glue，未纳入 git）。仅作「不依赖浏览器」的可行性验证用，目前基本跑不起来。

### 6. 反爬机制（`STEALTH_SCRIPT`，单一来源）

`STEALTH_SCRIPT` 定义在 `api-client.mjs:64-107`，由 `HdhiveClient._ensureBrowser` 注入；`server.mjs` 仅 `import` 它，在 `/hdhive/login` 临时 context 复用一次（`server.mjs:744`）。**现在只有一份，无需两边同步。** patch 项：

- `navigator.webdriver` → `false`
- `navigator.languages` → `['zh-CN','zh','en']`
- `navigator.plugins` → 5 元素
- `WebGLRenderingContext.getParameter(37445/37446)` → Intel UHD 630 假数据
- `navigator.userAgentData` → Chrome Windows（提供 `getHighEntropyValues`）
- 删除/隐藏 `window.__playwright__binding__` 和 `window.__pwInitScripts`

## 路由速查（`server.mjs`）

`/health` 始终公开；其余路由在 `BRIDGE_TOKEN` 非空时全部需要 token（无「敏感」分级）。

| Method | Path | 作用 |
|--------|------|------|
| GET | `/health` | 探活（503 = client/warmup 未就绪），**唯一公开** |
| GET | `/metrics` | 状态（含 `readCache.enabled/ttlMs/size`、calls/errors） |
| POST | `/warmup` | 主动预热 ⚠️ **见已知陷阱 #2** |
| POST | `/browser/restart` | 关闭重建 client |
| GET | `/hdhive/customer/current` | 当前用户信息 |
| GET | `/hdhive/customer/points-logs` | 积分日志 |
| POST | `/hdhive/customer/checkin` | 签到（`autoVerify`/`verificationSolver`/`verificationAttempts`/`includeUser`） |
| GET | `/hdhive/customer/messages/unread-count` | 未读消息数 |
| GET | `/hdhive/customer/playlists/my` | 我的播放列表 |
| POST | `/hdhive/customer/subscriptions/check` | 订阅检查 |
| GET | `/hdhive/customer/resources/:resourceId` | 资源详情（cloud189 兼容格式） |
| POST | `/hdhive/customer/resources/:resourceId/unlock` | 解锁资源（cloud189 兼容，消耗积分） |
| POST | `/hdhive/customer/check/resource` | 检查分享 URL（注意是 `check/resource` 带斜杠） |
| POST | `/hdhive/customer/media-resources` | TMDB → 资源列表（不消耗积分，**有读缓存**） |
| POST/GET | `/hdhive/customer/:action*` | 通用代理（任意 `/api/customer/*` 透传给 `client.call`） |
| GET | `/hdhive/public/bulletins/latest` | 最新公告 |
| POST | `/hdhive/login` | 用密码登录（独立临时 context，成功落库 cookie） |
| GET | `/hdhive/cookies` | 导出 cookie 快照 |
| GET | `/admin/cookies` | 列出 DB 里的 cookie key（不含明文） |
| DELETE | `/admin/cookies/:key` | 删除指定 cookie |
| POST | `/admin/cookies/:key` | 手动写入 cookie |
| POST | `/hdhive/unlock/tmdb/:tmdbId` | TMDB 一键解锁（消耗积分） |
| POST | `/hdhive/preview/tmdb/:tmdbId` | TMDB 解锁预览（不消耗积分，**有读缓存**） |
| POST | `/hdhive/unlock/resource/:slug` | 按 slug 解锁 |
| POST | `/hdhive/unlock/share` | 按分享 URL 解锁 |
| GET | `/hdhive/resource/:slug/cloud189` | 抽取 189 链接 |

## 关键环境变量

`server.mjs:13-37` 实际读取的全部变量（`.env` 列本地默认）：

```
PORT=10000
BRIDGE_TOKEN=...               # API 鉴权；空字符串 = 关闭鉴权（也是 cookie 加密密钥的回退值）
HDHIVE_COOKIE=...              # 默认 cookie（注入到 client）
HDHIVE_USERNAME=...            # 仅 POST /hdhive/login 用
HDHIVE_PASSWORD=...
HDHIVE_BASE_URL=https://hdhive.com
BROWSER_HEADLESS=true          # 'false' 显示浏览器
ACTION_TIMEOUT_MS=180000       # 单请求超时（默认 180s）
AUTO_WARMUP=true               # 'false' 关闭启动预热
READ_CACHE_TTL_MS=60000        # 只读短缓存 TTL；0 关闭（旧名 MEDIA_RESOURCES_CACHE_TTL_MS）
CAPTCHA_AI_BASE_URL=...        # 验证码 AI 求解（OpenAI 兼容）
CAPTCHA_AI_API_KEY=...
CAPTCHA_AI_MODEL=web2api/gemini-auto
CAPTCHA_SOLVER=                # ai | auto | heuristic（默认空 = 走传入参数）
DATABASE_URL=...               # 可选 Postgres（旧名 BRIDGE_STATE_DATABASE_URL）
BRIDGE_STATE_SECRET=...        # cookie 加密密钥（回退 BRIDGE_TOKEN）
COOKIE_KEY=default             # DB cookie key 前缀（旧名 BRIDGE_STATE_KEY）
```

⚠️ 以下变量是旧 bridge 残留，**当前 `server.mjs` 已不读取**：`BROWSER_PROFILE_DIR`、`WARMUP_URLS`、`WARMUP_INTERVAL_MS`、`KEEPALIVE_INTERVAL_MS`、`IDLE_PAGE_URL`、`LOGIN_TIMEOUT_MS`、`CUSTOMER_API_TIMEOUT_MS`、`NAVIGATION_TIMEOUT_MS`、`MAX_HTML_CHARS`。`render.yaml` 里仍写着这些（已失效，待清理）。

## 部署

- **`Dockerfile`** 基于 `mcr.microsoft.com/playwright:v1.49.1-noble`：`COPY package.json package-lock.json*` → `npm ci --omit=dev` → `COPY api-client.mjs` + `COPY server.mjs`（**两个源文件都要**，因 server 依赖 api-client），装中文字体 `fonts-noto-cjk`，设 `TMPDIR=/tmp/hdhive-cache`，带 `HEALTHCHECK`，`CMD ["node","server.mjs"]`。
- **`docker-compose.yml`** `postgres:15-alpine` + `hdhive-api` 双服务（api 依赖 postgres healthy），注入 `DATABASE_URL`/`COOKIE_KEY`/`BRIDGE_STATE_SECRET`/`AUTO_WARMUP`，是 `DEPLOY.md` 推荐的生产方式。
- **`render.yaml`** Render Web Service + 1GB 持久盘（`/data`）；注意里面的环境变量大半已废弃。
- **CI** `.github/workflows/docker-publish.yml`：push main / tag `v*` / PR / 手动触发，buildx 构建 `linux/amd64` 推到 `ghcr.io/<owner>/hdhive-bridge`（PR 只构建不推）。
- 完整部署 / 故障排查 / 性能基准见 **`DEPLOY.md`**（766 行，含 docker run / compose / Render / K8s 四种方式）。

## 调试脚本分类（`*.mjs` 都在根目录）

**注意：这些脚本现已全部纳入 git**（早期未跟踪，现在 `git ls-files` 全在）。它们是研究痕迹——**修改核心功能时不要清理**，但新加功能请直接进 `server.mjs` / `api-client.mjs`。

| 前缀 / 文件 | 用途 |
|------|------|
| `test-*.mjs` | 可运行的功能/性能测试（手动跑），含 `test-cloud189-compat.mjs`（用真实 SDK 校验兼容契约） |
| `benchmark*.mjs` | 优化前后性能对比（`benchmark-v3.mjs` 是最新） |
| `stability.mjs` | 连续 5 个 TMDB ID 解锁稳定性（挂在 `npm run test:stability`） |
| `example.mjs` | 最简集成示例：cookie → `HdhiveClient` → 分享链接解锁 |
| `dump-*.mjs` | 一次性抓取（cookies/sources/requests） |
| `probe-*.mjs` | 探针（探测单个 API 行为，如 `probe-points*.mjs` 逆向 `unlock_points`） |
| `extract-*/find-*/trigger-*.mjs` | 逆向时定位 webpack 模块 / WASM glue |
| `intercept.mjs`/`inspect-*.mjs` | 早期抓包分析 |

## 已知陷阱

1. **不要并发调用同一个 `HdhiveClient` 实例**：内部单 page、共享 navigation 状态；`server.mjs` 全局也只有一个 `state.client`。
2. **`POST /warmup` 有 bug**：`server.mjs:359` 调用了未定义的同步 `getRequestCookie(req)`（全文件只有 `getRequestCookieAsync`，`:100`），命中会抛 `ReferenceError`。修 warmup 时改成 `await getRequestCookieAsync(req)`。
3. **WASM 模块可能卸载**：page navigate 导致 `webpackRequire.m['9110']` 丢失时，`call()` 的 catch 块（`api-client.mjs:445-451`）自动 `_reloadPage()` 重试一次。
4. **Cookie 失效**：`token` JWT 默认 7 天过期；服务端不自动续签，需重新 `POST /hdhive/login` 或更新 `HDHIVE_COOKIE`/DB cookie。
5. **影巢改版后**：签名机制（X25519 + HMAC，WASM）通常不变，但 webpack 模块 ID 会变——生产用到的是 **9110**（signedFetch `t5`/`P$`）和 **41607**（签到 server action，chunk 5530，`actionId 60529bb5...`）。改 `REGISTER_AND_RUN`（`api-client.mjs:13-59`）和 `_callCheckinServerAction`（`:1184`）。`41263` 只在调试脚本 `resolve-tmdb.mjs`，不在生产路径。
6. **验证码依赖外部 AI 服务**：`ai`/`auto` solver 会把验证码图发到 `CAPTCHA_AI_BASE_URL/chat/completions`；没配 key 时只能用 `heuristic`。
7. **改 cloud189 兼容接口要谨慎**：`media-resources`/`resources/:id`/`:id/unlock` 的返回结构是 cloud189-auto-save 的契约，改字段会破坏下游。
8. **写操作必须清缓存**：新增任何会改变只读查询结果的写路由，记得调 `clearReadCache()`（参考 checkin/unlock 路由）。
9. **`server.mjs.backup` 不是当前代码**：它是旧版独立桥接（含 `actionQueue`/`ensurePage`/`customerRequest`），被 git 误跟踪（`.gitignore:6` 列了它但无效，因先提交后忽略）。**别照它改功能。**

## 验证 / 自检清单（修改后跑）

```bash
npm run check                           # 语法（两个文件）
npm run test:api                        # 基础 API 调用
node test-resources.mjs                 # 资源查询
node test-full-chain.mjs                # 完整解锁链路
node test-tmdb-final.mjs                # TMDB → 189 一条龙
node test-cloud189-compat.mjs           # cloud189-auto-save 兼容契约
npm run test:bench                      # 性能（应 < 10s）
```

健康检查：`curl -s localhost:10000/health` 返回 200 + `success: true` 表示就绪。
