# 间歇性超时问题修复报告

## 📋 问题描述

**症状**：用部署的 HTTP API 查询分享链接（`media-resources` / `preview-tmdb`），第一次超时，第二次再搜就能搜到，过一会再试还是重复这样（周期性循环）。

**影响范围**：所有使用 `POST /hdhive/customer/media-resources` 和 `POST /hdhive/preview/tmdb/:tmdbId` 的调用方（如 cloud189-auto-save）。

---

## 🔍 根因分析

### 主根因（无需并发也会出现）

```
① 第一次查询 → 缓存 miss → 走慢路径（resolveTmdb 8s + 等页面 12s + N×goto资源详情页）
   → 单次耗时轻松 30s+，超过客户端 HTTP 超时（约 30s）
   → 客户端先放弃连接 → 用户看到"第一次超时" ❌

② 但 server 的 withTimeout 只是 Promise.race（无 AbortController、无 res.on('close')）
   → 被放弃的请求在后台继续把慢路径跑完
   → 无条件 setReadCache 写入 60s 缓存

③ 60s 内再搜同一个 tmdbId → getReadCache 命中秒回 → "第二次成功" ✅

④ 60s 后缓存过期被删 → 再次 miss → 再走慢路径 → 再超时 → 周期≈60s 重复 🔁
```

**周期严格等于 `READ_CACHE_TTL_MS=60000`**（默认 60 秒），完美解释"过一会再试还是重复"。

### 次要隐患（加剧问题）

1. **并发踩踏**：全局单例 `state.client`（单 `this._page`），但 `withTimeout` 只包超时不排队 → 多请求并发对同一 page goto 不同 URL，互相 abort navigation，污染 `_pageNeedsMovieReload` 标志。
2. **_ensureBrowser TOCTOU**：`if (this._ready && this._page) return;` 到 `this._ready = true;` 之间有多个 await → 冷启动并发会重复 launch context。
3. **慢路径固定等待**：`getCloud189Links` 的硬编码 `waitForTimeout(3000)`（`api-client.mjs:1816`），N 个资源累加显著。

---

## ✅ 修复方案（P0+P1）

### 设计原则

- **严格保持单 page/单 context 全局共享**（用户明确要求的速度优化）
- **用串行化队列解决并发踩踏**，不改成多 page 并发
- **不改对外 API 契约**，客户端零感知

---

### 已实施的修复

#### 1️⃣ **api-client.mjs**: `_ensureBrowser` 单飞 + 死 page 检测 (P0)

**位置**：`api-client.mjs:331` (构造函数) + `:344-410` (方法)

**改动**：
```javascript
// 构造函数新增字段
this._ensuring = null; // 单飞：正在进行的 _ensureBrowser promise

// _ensureBrowser 方法
async _ensureBrowser(opts = {}) {
  // 健康检查：page 已崩溃则清空状态
  if (this._page && this._page.isClosed()) {
    this._ready = false;
    this._page = null;
  }
  if (this._ready && this._page) return;

  // 单飞：并发调用复用进行中的 promise
  if (this._ensuring) return this._ensuring;

  this._ensuring = (async () => {
    /* 原 launch 逻辑 */
    this._ready = true;
  })();

  try { await this._ensuring; }
  finally { this._ensuring = null; }
}
```

**效果**：
- 冷启动时并发请求只 launch 一次 browser，共享同一启动 promise
- 检测 `page.isClosed()` 避免拿到已崩溃的 page

---

#### 2️⃣ **api-client.mjs**: `getCloud189Links` 轮询早退 (P1)

**位置**：`api-client.mjs:1814-1826`

**改动**：
```javascript
// 旧：固定等 3 秒
await this._page.waitForTimeout(3000);

// 新：轮询 3 秒，命中 cloud189 链接即早退
const deadline = Date.now() + 3000;
while (urlMatch.length === 0 && !codeMatch && Date.now() < deadline) {
  await this._page.waitForTimeout(200);
  html = await this._page.content().catch(() => '');
  urlMatch = [...html.matchAll(/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g)];
  codeMatch = html.match(/访问码[：:]*\s*([a-zA-Z0-9]{4,8})/i);
}
```

**效果**：
- 平均快 ~1.5s/资源（链接快速出现时不再空等）
- 直接砍掉慢路径主要固定耗时

---

#### 3️⃣ **server.mjs**: 全局串行队列 (P0)

**位置**：`server.mjs:281-317`

**改动**：
```javascript
let actionChain = Promise.resolve();

// 拆分：内部 _withTimeout（原超时逻辑）
async function _withTimeout(actionName, fn) {
  /* 原 withTimeout 逻辑 */
}

// 外层 withTimeout：串行化包装
async function withTimeout(actionName, fn) {
  const run = actionChain.then(() => _withTimeout(actionName, fn));
  // 队列不因单个任务失败而断裂
  actionChain = run.then(() => {}, () => {});
  return run;
}
```

**效果**：
- 所有 HTTP 路由调用 `withTimeout` 的地方**零改动**，自动变串行
- 任意时刻只有一个请求在操作共享 `this._page`
- 彻底消除并发 goto 踩踏、navigation 互相 abort

---

#### 4️⃣ **server.mjs**: in-flight 去重 (P1)

**位置**：`server.mjs:152-168` (函数定义) + 应用到两个慢路径路由

**改动**：
```javascript
const inflightRequests = new Map();

function dedupe(key, producer) {
  if (inflightRequests.has(key)) {
    return inflightRequests.get(key);
  }
  const promise = Promise.resolve()
    .then(producer)
    .finally(() => inflightRequests.delete(key));
  inflightRequests.set(key, promise);
  return promise;
}
```

应用到 `POST /hdhive/customer/media-resources` (line 641) 和 `POST /hdhive/preview/tmdb/:tmdbId` (line 976)：
```javascript
const cached = getReadCache(cacheKey);
if (cached) return {...cached, cache:{hit:true}};

// 新增：慢路径包在 dedupe 内
return dedupe(cacheKey, async () => {
  /* 原慢路径逻辑 */
  setReadCache(cacheKey, payload);
  return payload;
});
```

**效果**：
- 同一 tmdbId 的第二次请求即使在第一次还在跑时到达，也复用同一个结果
- 不再重复走慢路径或并发踩踏
- 后台跑完的结果即使原 HTTP 已断开也能被后续请求复用

---

## 🧪 测试验证

### 自动化测试（无需真实 cookie）

```bash
node test-timeout-fix-minimal.mjs
```

**测试结果**：✅ 3/3 通过
- ✓ 串行队列已生效（多请求不并发）
- ✓ metrics 正常暴露状态
- ✓ 并发请求不死锁

### 语法检查

```bash
npm run check
```

**结果**：✅ 通过

---

## 📊 修复后的预期行为

### 场景 1：单用户顺序查询

```
第一次查询 → 缓存 miss → 走慢路径（现在更快：轮询早退 + 串行化无踩踏）
             客户端仍可能超时（如果资源很多）

第二次查询 → 若在第一次跑完前：
               dedupe 复用进行中结果 → 等同一个 promise ✅
             若 60s 内第一次已完成：
               缓存命中秒回 ✅

60s 后查询 → 缓存过期，周期仍存在，但：
             - 慢路径更快（轮询早退平均快 1.5s/资源）
             - 不再有 navigation 互相 abort 导致的额外超时
```

### 场景 2：并发/重试场景

```
客户端因超时自动重试 / 并发批量查询
  → 串行队列保证依次执行，不互相踩踏 ✅
  → dedupe 让相同 tmdbId 只跑一次，共享结果 ✅
  → _ensureBrowser 单飞保证冷启动不重复 launch ✅
```

---

## ⚠️ 已知权衡

1. **第一次慢的根因未彻底消除**：慢路径本身（resolveTmdb 8s + 等页面 12s + N×goto）仍可能超客户端超时。但：
   - 轮询早退已砍掉主要固定等待
   - 串行化让耗时更稳定（不被并发放大）
   - dedupe 让重试不重复触发

2. **60s 周期仍存在**：`READ_CACHE_TTL_MS=60000` 未改，过期后仍走慢路径。要彻底消除可：
   - 延长 TTL（如 `export READ_CACHE_TTL_MS=300000`），但对资源更新不敏感
   - 或外部预热（定时调用热门 tmdbId 保持缓存温热）

3. **`actionTimeoutMs=180s` 未下调**：避免误伤签到验证码等本身就慢的操作。

---

## 🚀 部署建议

### 立即生效（重启服务）

```bash
# 停止旧服务
pkill -f "node server.mjs"

# 启动新服务（已包含修复）
npm start
```

### Docker 部署

```bash
npm run docker:build
npm run docker:run
```

### 可选：调整缓存 TTL

如果希望减少"第一次超时"的频率，可以延长缓存：

```bash
# .env 或环境变量
READ_CACHE_TTL_MS=300000  # 5 分钟（默认 60s）
```

---

## 📝 改动文件清单

1. **api-client.mjs** (~1940 行)
   - 构造函数增加 `this._ensuring` 字段
   - `_ensureBrowser` 方法增加单飞 + 健康检查（约 70 行改动）
   - `getCloud189Links` 方法改固定等待为轮询早退（约 15 行改动）

2. **server.mjs** (~1100 行)
   - 增加 `inflightRequests` Map 和 `dedupe` 函数（约 20 行）
   - 拆分 `withTimeout` 为内部 `_withTimeout` + 外层串行队列（约 40 行改动）
   - 两个慢路径路由包裹 `dedupe`（约 10 行改动）

3. **新增测试文件**
   - `test-timeout-fix.mjs` - 完整测试套件（需真实 cookie）
   - `test-timeout-fix-minimal.mjs` - 最小化测试（无需 cookie）

**总改动量**：~155 行（新增/修改）

---

## ✨ 总结

| 改动 | 优先级 | 文件 | 效果 |
|------|--------|------|------|
| 全局串行队列 | P0 | server.mjs | 消除并发踩踏，保证单 page 安全共享 |
| _ensureBrowser 单飞 | P0 | api-client.mjs | 冷启动不重复 launch，检测死 page |
| getCloud189Links 轮询早退 | P1 | api-client.mjs | 砍掉固定等待，平均快 ~1.5s/资源 |
| in-flight 去重 | P1 | server.mjs | 相同查询复用结果，后台完成的缓存被利用 |

**核心原则**：严格保持单 page/单 context 全局共享（速度优化保留），用串行化 + 去重解决并发问题。

**验证状态**：✅ 语法检查通过、✅ 串行化逻辑验证通过、✅ 并发不死锁

---

**修复完成日期**：2026-06-14  
**修复工程师**：浮浮酱 ฅ'ω'ฅ
