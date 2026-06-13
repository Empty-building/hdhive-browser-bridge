# 影巢 API 逆向文档

本项目完整逆向出影巢（HDHive）的 API 签名机制，并提供纯 Cookie 调用的 Node.js 客户端，无需账号密码。

## 逆向成果

### 1. 签名机制

影巢使用 **X25519 ECDH + 自研哈希链** 对每个 API 请求签名。

| 请求头 | 说明 |
|--------|------|
| `X-HDH-Cid` | 会话 ID（handshake 返回） |
| `X-HDH-TS` | 毫秒时间戳 |
| `X-HDH-Nonce` | 16 字节十六进制随机数 |
| `X-HDH-Sig` | 64 字符十六进制签名 |
| `X-HDH-Kid` | 固定为 `"1"` |
| `X-CSRF-TOKEN` | 从 cookie 的 `csrf_access_token` 读取 |

### 2. WASM 签名模块

- 路径：`https://hdhive.com/wasm/hdh_security_bg.wasm`（52613 字节）
- 导出函数：`init()`, `finalizeHandshake(cid, server_pub, kid)`, `signRequest(method, path, ts, nonce, body, getUserId)`, `verifyResponse(...)`
- 依赖：`curve25519-dalek`, `sha2`, `hkdf`, `hmac`, `wasm-bindgen`
- 胶水代码：webpack 模块 ID 1918（7158 字符 JS）

### 3. 完整流程

```
1. 客户端 → 浏览器加载 webpack module 1918 + WASM
2. 客户端 → init() 生成 X25519 密钥对，返回 client_pub（32 字节 base64）
3. 客户端 → POST /api/public/security/session/handshake
            {client_pub, ua_fingerprint, ts}
4. 服务器 → 返回 {cid, server_pub, expires_at}
5. 客户端 → finalizeHandshake(cid, server_pub, 1) 派生 ECDH 共享密钥
6. 每次请求 → signRequest(method, path, ts, nonce, body, getUserId) 计算签名
7. 发送请求并附带上述 5 个 X-HDH-* 头
```

## 使用 `api-client.mjs`

### 准备 cookie

一次性登录后导出 cookie（不再依赖账号密码）：

```bash
node dump-cookies.mjs "<email>" "<password>"   # 输出到 /tmp/hdhive-cookies.txt
```

### Node.js 调用 API

```js
import { HdhiveClient } from './api-client.mjs';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const client = new HdhiveClient({
  baseUrl: 'https://hdhive.com',
  cookie
});

// 当前用户
const user = await client.get('/api/customer/user/current');
console.log(user.data);

// 积分日志
const logs = await client.get('/api/customer/points-logs', { page: 1, page_size: 10 });

// 未读消息
const unread = await client.get('/api/customer/messages/unread-count');

// 签到
const checkin = await client.post('/api/customer/user/checkin');

// 订阅检查
const sub = await client.get('/api/customer/subscriptions/check', {
  target_type: 'media_resource',
  target_key: 'movie:1903'
});

// 资源详情（需要 resource ID）
const detail = await client.get('/api/customer/resources/<resource_id>');

// 解锁资源
const unlock = await client.post('/api/customer/resources/<resource_id>/unlock');

// 检查分享链接
const check = await client.post('/api/customer/check/resource', {
  url: 'https://hdhive.com/resource/189/...'
});

// 公告
const bulletins = await client.get('/api/public/bulletins/latest');

await client.close();
```

## 已验证接口

| 接口 | 方法 | 验证状态 |
|------|------|----------|
| `/api/customer/user/current` | GET | ✅ 成功 |
| `/api/customer/user/checkin` | POST | ✅ |
| `/api/customer/points-logs` | GET | ✅ 成功 |
| `/api/customer/messages/unread-count` | GET | ✅ 成功 |
| `/api/customer/subscriptions/check` | GET | ✅ 成功 |
| `/api/customer/resources/{id}` | GET | ✅ |
| `/api/customer/resources/{id}/unlock` | POST | ✅ |
| `/api/customer/check/resource` | POST | ✅ 成功 |
| `/api/customer/playlists/my` | GET | ✅ |
| `/api/public/bulletins/latest` | GET | ✅ 成功 |
| `/api/customer/resources`（完整查询） | POST | ⚠️ 需要内部 movie ID（1903、905baf2b...）而非 TMDB ID |

## 已知限制

1. **资源查询 body 格式**：`/api/customer/resources` 的 body 期待特定字段（如 `{movie: {id: ...}}` 或带 `share_url`），完整结构需要根据目标页面响应解析
2. **依赖 Playwright**：签名生成依赖浏览器环境（WASM + webpack 模块），可通过 Node.js WASM 直加载规避
3. **cookie 有效期**：登录态会过期，需要定期刷新或重新登录

## 文件清单

| 文件 | 用途 |
|------|------|
| `api-client.mjs` | 主客户端（推荐使用） |
| `test-api-client.mjs` | API 客户端测试 |
| `dump-cookies.mjs` | 一次性登录导出 cookie |
| `dump-requests.mjs` | 抓取真实页面请求格式 |
| `intercept.mjs` | 抓包分析（早期） |
| `dump-sources.mjs` | 提取 webpack 模块源码 |
| `extract-full-glue.mjs` | 提取 WASM 胶水代码 |
| `find-glue.mjs` / `trigger-glue.mjs` / `probe-*.mjs` | 调试探针 |
| `/tmp/hdh-security.wasm` | WASM 模块（已下载到 `node_modules/hdh-security.wasm`）|
| `/tmp/hdh-wasm-glue-full.js` | 完整 WASM JS 胶水代码 |