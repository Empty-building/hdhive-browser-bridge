# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

影巢（hdhive.com）API 反爬逆向 + 浏览器桥接服务。
核心思路：**影巢把 X25519 ECDH + HMAC 签名算在浏览器 WASM 里**，所以本项目用 Playwright 跑一个常驻 Chromium 上下文,在页面内调用 webpack 模块的 `signedFetch` 完成 API 调用,通过 HTTP 暴露给外部。

- `server.mjs` — 生产用 Express 桥接服务（部署到 Render）
- `api-client.mjs` — 优化版独立客户端（推荐作为 SDK 集成）
- `hdhive-client.mjs` — 纯 Node.js + WASM 原型（实验性，依赖外部 `/tmp/hdh-wasm-glue-full.js`，不推荐）

完整说明见 `README.md`（用户面文档）和 `API-CLIENT.md`（逆向成果 + 接口表）。**所有源码注释都是中文，新代码注释请保持中文。**

## 常用命令

```bash
# 安装依赖 + Playwright 浏览器
npm install
npx playwright install chromium

# 启动生产桥接服务（默认 :10000）
npm start

# 语法检查
npm run check          # 等价于 node --check server.mjs

# 健康检查（服务是否就绪）
curl -s localhost:10000/health | jq

# 登录态导出（一次性，登录后写入 /tmp/hdhive-cookies.txt）
node dump-cookies.mjs "<email>" "<password>"

# 跑端到端 / 性能基准
node test-e2e.mjs
node benchmark-v3.mjs      # 优化后基准
node benchmark.mjs         # 优化前基准

# 调试模式（启动可见 Chromium）
BROWSER_HEADLESS=false node test-tmdb-final.mjs
DEBUG=pw:api node benchmark-v3.mjs
```

单脚本直接 `node xxx.mjs` 即可。**没有统一的测试 runner**——`test-*.mjs` 各自独立。

## 核心架构

### 1. 桥接服务 `server.mjs`（生产部署）

单文件 Express 服务，关键机制：

- **持久化 Playwright context**：`ensurePage()` 单例化管理 `state.context` / `state.page`，context 崩溃会监听 `close` 事件置空以便重建（最多重试 2 次）。
- **Action 队列** `state.actionQueue` + `enqueueAction(name, action)`：所有浏览器操作严格串行化（共享 page 状态，不能并发），每个 action 用 `runActionWithTimeout` 包 `ACTION_TIMEOUT_MS`（默认 120s）防止卡死。
- **Bridge Token 中间件**：除 `/health` 外所有路由要求 `x-bridge-token` 或 `?token=...` 头等于 `BRIDGE_TOKEN`。
- **Stealth 反检测** `installStealthInitScript`：每个 context 启动时注入 navigator.webdriver / languages / plugins / WebGL / userAgentData / `__playwright__binding__` 全部 patch（见 `server.mjs:355-435`）。
- **自动登录** `ensureLoggedIn`：基于 `HDHIVE_USERNAME` / `HDHIVE_PASSWORD` 启动时登录；5 分钟内最多失败 3 次的限流；keepAlive 时每 5 分钟验证一次 `/api/customer/user/current` 真实有效性。
- **定时器**（listen 钩子启动）：
  - `KEEPALIVE_INTERVAL_MS`（默认 25s）— 健康探活 + 软恢复（先 goto 空闲页恢复，失败才重建 context）+ 登录态续签
  - `WARMUP_INTERVAL_MS`（默认 5min）— 访问 `WARMUP_URLS`（默认 `/,/search`）保持 session warm
- **状态持久化** `persistBrowserState` / `restoreBrowserState`（可选 Postgres 存储，配置 `BRIDGE_STATE_DATABASE_URL` + `BRIDGE_STATE_KEY` + `BRIDGE_STATE_SECRET`；不配置时仅落本地 `BROWSER_PROFILE_DIR`）。
- **Customer API 调用** `customerRequest`：在 `page.evaluate` 内通过 `window.webpackChunk_N_E` 注入新 chunk 拿到 webpack require，启发式定位 axios client（先 `require(41263)`，再扫 `webpackRequire.c` 和 factories 找带 `X-CSRF-TOKEN` 的模块），再用原 axios 实例发起请求；同时 wrap `window.fetch` 拦截并捕获响应（含 `x-hdh-rsig` / `x-hdh-rts` 响应签名头）。

### 2. 优化版客户端 `api-client.mjs`（推荐 SDK）

单 Playwright 上下文，注入 cookie 后通过 `REGISTER_AND_RUN` 字符串（page.evaluate 内）调用 `webpackRequire(9110).P$()` 注册 `getUserId` 钩子，再 `t5(path, init)` 调官方 `signedFetch`。

- **5x 速度优化**（40s → 8s）：复用 browser、拦截 image/font/media + umami 统计、取消滚动、`page.content()` 替代 RSC 拦截、智能 LOADING 轮询、`resolveTmdbToInternal` 独立临时 context + 重试。
- **端到端入口** `unlockByTmdbId(tmdbId, type='movie')` 是最常用方法：`resolve → findResources → unlock → getCloud189` 一条龙。
- **无登录获取 cloud189**：`findResourcesFromMoviePage` + `getCloud189Links` 只用 DOM 抓 `/resource/189/{slug}` 页面的 `cloud.189.cn/t/...` 链接 + 访问码。

### 3. WASM 原型 `hdhive-client.mjs`（不推荐）

`loadWasmModule` 直接 `WebAssembly.instantiate` 加载 `node_modules/hdh-security.wasm`，手工实现 `__wbg_*` 桥接（`webcrypto.getRandomValues` 等），**需要 `/tmp/hdh-wasm-glue-full.js` 文件存在**——目前 glue 来源是浏览器提取的，文件未纳入 git。仅作"不依赖浏览器"的可行性验证用。

### 4. 反爬机制（必须保持同步）

- `navigator.webdriver` → `false`
- `navigator.languages` → `['zh-CN','zh','en']`
- `navigator.plugins` → 5 元素
- `WebGLRenderingContext.getParameter(37445/37446)` → Intel UHD 630 假数据
- `navigator.userAgentData` → Chrome 125 Windows（提供 `getHighEntropyValues`）
- 删除/隐藏 `window.__playwright__binding__` 和 `window.__pwInitScripts`

修改 `server.mjs:355-435` 或 `api-client.mjs:63-106` 时要两边同步。

## 路由速查（`server.mjs`）

| Method | Path | 作用 | 鉴权 |
|--------|------|------|------|
| GET | `/health` | 探活（503 表示 context 未就绪） | 公开 |
| GET | `/metrics` | 详细状态（warmup/keepAlive 计数、最近错误） | 公开 |
| GET/POST | `/warmup` | 主动 warmup | 公开 |
| POST | `/browser/restart` | 关闭重建 context | 公开 |
| GET | `/hdhive/status` | 当前页 title/cookies/storage | token |
| GET/POST | `/hdhive/open` | 打开任意影巢页面 | token |
| GET | `/hdhive/cookies` | 导出 cookie 快照 | 敏感 |
| POST | `/hdhive/login` | 用密码登录 | 敏感 |
| GET | `/hdhive/customer/current` | 当前用户信息 | 敏感 |
| POST | `/hdhive/customer/checkin` | 签到 | 敏感 |
| GET | `/hdhive/customer/points-logs` | 积分日志 | 敏感 |
| POST | `/hdhive/customer/resources` | 资源查询（GET/POST 二选一） | 敏感 |
| GET | `/hdhive/customer/resources/:id` | 资源详情 | 敏感 |
| POST | `/hdhive/customer/resources/:id/unlock` | 解锁资源 | 敏感 |
| POST | `/hdhive/customer/check-resource` | 检查分享 URL | 敏感 |
| POST | `/hdhive/customer/media-resources` | TMDB → 189 资源 | 敏感 |

`requireSensitiveEndpoint` = token 鉴权 + "敏感" 标志（仅日志层面差别，统一走 token 中间件）。

## 关键环境变量（`.env` 已列出本地默认值）

```
PORT=10000
HDHIVE_BASE_URL=https://hdhive.com
HDHIVE_USERNAME=...            # 启动自动登录用
HDHIVE_PASSWORD=...
HDHIVE_COOKIE=...              # 可选，优先于 username/password（注入到 context）
BRIDGE_TOKEN=...               # API 鉴权；空字符串 = 关闭鉴权
BROWSER_HEADLESS=true
BROWSER_PROFILE_DIR=/data/hdhive-profile
KEEPALIVE_INTERVAL_MS=25000
WARMUP_INTERVAL_MS=300000
WARMUP_URLS=/,/search
IDLE_PAGE_URL=/
ACTION_TIMEOUT_MS=120000
LOGIN_TIMEOUT_MS=45000
CUSTOMER_API_TIMEOUT_MS=30000
NAVIGATION_TIMEOUT_MS=30000
BRIDGE_STATE_DATABASE_URL=...  # 可选 Postgres
BRIDGE_STATE_KEY=hdhive-default
BRIDGE_STATE_SECRET=...        # 加密 cloud state
MAX_HTML_CHARS=0               # 0 = 不返回 html
```

## 部署

`Dockerfile` 基于 `mcr.microsoft.com/playwright:v1.49.1-noble`，只 `COPY server.mjs`，启动 `node server.mjs`。`render.yaml` 配 Web Service + 1GB 持久盘（`/data`）保存浏览器 profile。

## 调试脚本分类（`*.mjs` 都在根目录）

| 前缀 | 用途 | 是否纳入 git |
|------|------|------------|
| `test-*.mjs` | 可运行的功能/性能测试（手动跑） | 当前未跟踪 |
| `benchmark*.mjs` | 优化前后性能对比 | 当前未跟踪 |
| `dump-*.mjs` | 一次性抓取（cookies/sources/requests） | 当前未跟踪 |
| `probe-*.mjs` | 探针（探测单个 API 行为） | 当前未跟踪 |
| `extract-*.mjs` / `find-*.mjs` / `trigger-*.mjs` | 逆向时定位 webpack 模块 / WASM glue | 当前未跟踪 |
| `intercept.mjs` / `inspect-*.mjs` | 早期抓包分析 | 当前未跟踪 |

这些脚本是研究痕迹——**修改核心功能时不要清理它们**，但新加功能请直接进 `server.mjs` / `api-client.mjs`。

## 已知陷阱

1. **不要并发调用同一个 HdhiveClient 实例**：`api-client.mjs` 内部是单 page，共享 navigation 状态。
2. **WASM 模块可能卸载**：page navigate 导致 `webpackRequire.m['9110']` 丢失时 `api-client.mjs:236-241` 自动 reload 重试。
3. **Cookie 失效**：`token` JWT 默认 7 天过期；服务端通过 `ensureLoggedIn` + 5min 验证间隔 + 3 次/5min 失败限流自愈。
4. **登录页"出现了很奇怪的错误"**：浏览器指纹被识破，调试办法：`BROWSER_HEADLESS=false` 重试或删 `~/.cache/ms-playwright/` 重建。
5. **影巢改版后**：签名机制（X25519 + HMAC，WASM 实现）通常不变，但 webpack 模块 ID（9110/41263）和 API 路径可能变——改 `customerRequest` 的 client 定位 + `api-client.mjs` 的端点常量。
6. **WASM 路径**：`hdhive-client.mjs` 期望 `node_modules/hdh-security.wasm`（脚本提示 `curl -Lo node_modules/hdh-security.wasm https://hdhive.com/wasm/hdh_security_bg.wasm`），并依赖 `/tmp/hdh-wasm-glue-full.js`——这个 glue 文件目前没进 git，所以这个文件基本不能直接跑。
7. **`context 崩溃后疯狂重建**：`state.context.on('close')` 把引用置空是唯一保险；如果只靠 `state.page.isClosed()` 判断会拿到已死 context 引用导致 `newPage()` 持续抛错（已在 `ensurePage` 重试 2 次兜底）。
8. **actionQueue 是单例全局串行化**：所有路由都过 `enqueueAction`，所以 `/hdhive/customer/*` 之间是顺序执行；不要试图用 worker_threads 加速——会和 keepAlive 抢 page。

## 验证 / 自检清单（修改后跑）

```bash
npm run check                           # 语法
node test-api-client.mjs                # 基础 API 调用
node test-resources.mjs                 # 资源查询
node test-full-chain.mjs                # 完整解锁链路
node test-tmdb-final.mjs                # TMDB → 189 一条龙
node benchmark-v3.mjs                   # 性能（应 < 10s）
```

健康检查：`curl -s localhost:10000/health` 返回 200 + `success: true` 表示就绪。
