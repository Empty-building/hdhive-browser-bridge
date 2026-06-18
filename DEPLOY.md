# HDHive API 服务部署指南
## 📦 镜像说明
hdhive-api 是一个 Docker 镜像，把 api-client.mjs 包装成 HTTP REST API 服务，**接口与原 hdhive-browser-bridge 完全兼容**，并新增了 TMDB 一键解锁接口。
镜像特点：
 * 开箱即用的预编译镜像：ghcr.io/wobuhui666/hdhive-bridge:latest
 * 基于 mcr.microsoft.com/playwright:v1.49.1-noble（已包含 Chromium）
 * 安装中文字体（避免影巢页面乱码）
 * 体积约 1.5GB（包含 Chromium）
## 🚀 快速开始
### 方式 1：docker run（最简单）
```bash
# 1. 准备 cookie (如果需要本地提权)
node dump-cookies.mjs "your@email.com" "your-password"
# 输出到 /tmp/hdhive-cookies.txt

# 2. 启动容器 (直接使用现成镜像)
docker run -d \
  --name hdhive-api \
  -p 10000:10000 \
  -e BRIDGE_TOKEN=your-secret-token \
  -e HDHIVE_COOKIE="$(cat /tmp/hdhive-cookies.txt)" \
  -v hdhive-data:/tmp/hdhive-cache \
  --restart unless-stopped \
  ghcr.io/wobuhui666/hdhive-bridge:latest

```
### 方式 2：docker-compose（推荐）
```bash
# 1. 准备 cookie
node dump-cookies.mjs "your@email.com" "your-password"

# 2. 写 .env 文件
cat > .env <<EOF
BRIDGE_TOKEN=your-secret-token
HDHIVE_COOKIE=$(cat /tmp/hdhive-cookies.txt)
EOF

# 3. 启动
docker-compose up -d

# 4. 查看日志
docker-compose logs -f hdhive-api

```
### 方式 3：Render.com 部署
 1. 在 Render 创建 Web Service
 2. 选择 Deploy an existing image from a registry
 3. 填入镜像地址：ghcr.io/wobuhui666/hdhive-bridge:latest
 4. 设置环境变量：
   * BRIDGE_TOKEN
   * HDHIVE_COOKIE
 5. Deploy
## 🔑 环境变量
| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| BRIDGE_TOKEN | ❌ | 空 | API 保护 token。空 = 不校验（**生产环境务必设置**） |
| HDHIVE_COOKIE | ❌ | 空 | 默认 cookie。如果不设，每个请求需单独传 |
| HDHIVE_BASE_URL | ❌ | https://hdhive.com | 影巢基础 URL |
| BROWSER_HEADLESS | ❌ | true | 是否无头模式（调试可设 false） |
| ACTION_TIMEOUT_MS | ❌ | 180000 | 单个接口超时（毫秒） |
| AUTO_WARMUP | ❌ | true | 启动时自动预热浏览器 |
| CAPTCHA_AI_BASE_URL | ❌ | 空 | 自动签到验证码 AI endpoint，例如 https://example.com/v1 |
| CAPTCHA_AI_API_KEY | ❌ | 空 | 自动签到验证码 AI key。只用于验证码图片识别，不会发送 Cookie |
| CAPTCHA_AI_MODEL | ❌ | web2api/gemini-auto | 自动签到验证码模型 |
| CAPTCHA_SOLVER | ❌ | 空 | 默认验证码求解器，可设 ai、auto 或 heuristic |
| PORT | ❌ | 10000 | HTTP 端口 |
| DATABASE_URL | ❌ | 空 | Postgres 连接串。**设置后启用 cookie 持久化** |
| BRIDGE_STATE_SECRET | ❌ | BRIDGE_TOKEN | 加密密钥（用于数据库存储 cookie） |
| COOKIE_KEY | ❌ | default | 数据库中 cookie 的 key（多实例时区分） |
### Cookie 传递优先级
每个请求的 cookie 按以下优先级获取：
 1. **请求 body**：POST /hdhive/login body 中传 {"cookie": "..."}
 2. **请求头**：x-hdhive-cookie: ...
 3. **环境变量**：HDHIVE_COOKIE
### Cookie 管理接口（容器化部署时推荐）
| 接口 | 说明 |
|---|---|
| POST /hdhive/login | 账号密码登录，**返回新 cookie 字符串** |
| GET /hdhive/cookies | 读取当前 client 的所有 cookies |
| POST /browser/restart | 重启浏览器（清空登录态） |
完整容器化部署流程：
```bash
# 1. 启动容器（不预置 cookie）
docker run -d --name hdhive-api -p 10000:10000 \
  -e BRIDGE_TOKEN=xxx ghcr.io/wobuhui666/hdhive-bridge:latest

# 2. 通过 API 登录获取 cookie
COOKIE=$(curl -s -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"username":"you@email.com","password":"xxx"}' \
  http://localhost:10000/hdhive/login | jq -r '.data.cookie')

# 3. 用 cookie 调用 API
curl -H "x-bridge-token: xxx" \
  -H "x-hdhive-cookie: $COOKIE" \
  http://localhost:10000/hdhive/customer/current

# 或保存到环境变量并重启容器
docker stop hdhive-api && docker rm hdhive-api
docker run -d --name hdhive-api -p 10000:10000 \
  -e BRIDGE_TOKEN=xxx \
  -e HDHIVE_COOKIE="$COOKIE" \
  ghcr.io/wobuhui666/hdhive-bridge:latest

```
## 🗄️ 数据库持久化（推荐生产部署）
设置 DATABASE_URL 后，cookie 会**加密保存**到 Postgres，容器重启后自动恢复。
### 快速启用（docker-compose 一键）
```bash
# 1. 准备 .env
cat > .env <<EOF
BRIDGE_TOKEN=your-strong-token
BRIDGE_STATE_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=hdhive_secret
EOF

# 2. 启动（自动包含 Postgres）
docker-compose up -d

# 3. 首次登录（会自动写入数据库）
COOKIE=$(curl -s -X POST -H "x-bridge-token: $(grep BRIDGE_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"username":"you@email.com","password":"your-pass"}' \
  http://localhost:10000/hdhive/login | jq -r '.data.cookie')

# 4. 验证数据库中有 cookie
curl -H "x-bridge-token: $(grep BRIDGE_TOKEN .env | cut -d= -f2)" \
  http://localhost:10000/admin/cookies

```
### 行为说明
| 启动场景 | 行为 |
|---|---|
| 启动时 DB 无 cookie + env 有 HDHIVE_COOKIE | **自动保存** env cookie 到 DB |
| 启动时 DB 有 cookie + env 无 HDHIVE_COOKIE | **自动加载** DB cookie 作为默认 |
| 启动时 DB 有 cookie + env 有 HDHIVE_COOKIE | 优先用 env，DB 保留 |
| 调用 POST /hdhive/login | 登录后**自动加密保存**到 DB |
| 调用 POST /admin/cookies/:key | 手动设置（无登录直接写） |
### 数据库表结构
```sql
CREATE TABLE hdhive_cookies (
  key TEXT PRIMARY KEY,                -- COOKIE_KEY 配置
  cookie_encrypted TEXT NOT NULL,      -- AES-256-GCM 加密
  meta JSONB DEFAULT '{}'::jsonb,      -- 元数据（hdh_uid, source, ua）
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

```
### 加密方案
 * **算法**：AES-256-GCM
 * **密钥**：从 BRIDGE_STATE_SECRET 派生（SHA-256）
 * **IV**：每次加密随机生成（12 bytes）
 * **认证**：authTag 防止篡改
 * **存储格式**：base64(iv + authTag + ciphertext)，约 150% 原文大小
### 多实例/多账号支持
用 COOKIE_KEY 区分不同 cookie：
```bash
# 实例 1：保存 user A 的 cookie
COOKIE_KEY=user-a docker run ... ghcr.io/wobuhui666/hdhive-bridge:latest

# 实例 2：保存 user B 的 cookie（不同容器端口）
COOKIE_KEY=user-b docker run -p 10001:10000 ... ghcr.io/wobuhui666/hdhive-bridge:latest

# 或同一实例多账号（手动调用）
curl -X POST -H "x-bridge-token: xxx" \
  -d '{"cookie":"...","key":"user-b"}' \
  http://localhost:10000/admin/cookies/user-b

```
### 数据迁移
```bash
# 从一个环境迁移 cookie 到另一个
docker exec hdhive-postgres pg_dump -t hdhive_cookies > cookies.sql
docker exec -i hdhive-postgres-new psql < cookies.sql

```
## 📡 API 接口
所有接口（除 /health）需要 x-bridge-token 请求头。
### 基础接口
#### GET /health
健康检查（不需要 token）。
```bash
curl http://localhost:10000/health
# {"success":true,"status":"healthy","uptime":12345,...}

```
#### GET /metrics
查看指标。
```bash
curl -H "x-bridge-token: xxx" http://localhost:10000/metrics

```
#### POST /warmup
预热浏览器（手动触发）。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:10000/warmup

```
#### POST /hdhive/login
账号密码登录，返回 cookie 字符串（**会消耗一次登录请求**）。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"username":"your@email.com","password":"your-password"}' \
  http://localhost:10000/hdhive/login

```
#### GET /hdhive/cookies
读取当前 client 的所有 cookies（需要已登录）。
```bash
curl -H "x-bridge-token: xxx" http://localhost:10000/hdhive/cookies

```
#### POST /browser/restart
重启浏览器（清空登录态）。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:10000/browser/restart

```
#### GET /admin/cookies
列出所有保存的 cookie keys（不含明文）。
```bash
curl -H "x-bridge-token: xxx" http://localhost:10000/admin/cookies

```
#### POST /admin/cookies/:key
手动设置 cookie 到数据库（无需登录）。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"cookie":"hdh_sa_token=xxx; token=eyJ...; csrf_access_token=xxx; hdh_uid=xxx"}' \
  http://localhost:10000/admin/cookies/default

```
#### DELETE /admin/cookies/:key
删除指定 key 的 cookie。
```bash
curl -X DELETE -H "x-bridge-token: xxx" \
  http://localhost:10000/admin/cookies/default

```
### Customer API（兼容原 bridge）
#### GET /hdhive/customer/current
当前用户信息。
```bash
curl -H "x-bridge-token: xxx" http://localhost:10000/hdhive/customer/current

```
#### GET /hdhive/customer/points-logs?page=1&page_size=10
积分日志。
#### POST /hdhive/customer/checkin
签到。默认返回归一化状态和签到前后积分；如需跳过额外用户信息查询，可追加 ?includeUser=false。如果当前环境要求验证码，可追加 ?autoVerify=true&verificationSolver=ai，并配置 CAPTCHA_AI_BASE_URL 与 CAPTCHA_AI_API_KEY。
```bash
curl -X POST -H "x-bridge-token: xxx" http://localhost:10000/hdhive/customer/checkin

curl -X POST -H "x-bridge-token: xxx" \
  "http://localhost:10000/hdhive/customer/checkin?autoVerify=true&verificationSolver=ai&verificationAttempts=3"

```
#### GET /hdhive/customer/messages/unread-count
未读消息数。
#### GET /hdhive/customer/playlists/my?page=1&page_size=20
我的播放列表。
#### POST /hdhive/customer/subscriptions/check
订阅检查。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"target_type":"media_resource","target_key":"movie:550"}' \
  http://localhost:10000/hdhive/customer/subscriptions/check

```
#### GET /hdhive/customer/resources/:resourceId
资源详情。
```bash
curl -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/customer/resources/3fb1cb6823c64ae4a7a0f8f23bd4bed3

```
#### POST /hdhive/customer/resources/:resourceId/unlock
解锁资源。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/customer/resources/3fb1cb6823c64ae4a7a0f8f23bd4bed3/unlock

```
#### POST /hdhive/customer/check/resource
检查分享链接。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hdhive.com/resource/189/abc123..."}' \
  http://localhost:10000/hdhive/customer/check/resource

```
### 公共 API
#### GET /hdhive/public/bulletins/latest
最新公告。
### ⭐ TMDB 一键解锁（核心接口）
#### POST /hdhive/preview/tmdb/:tmdbId ⭐ 推荐先调用
**只查询不解锁，列出所有资源 + 所需积分**（不消耗积分）。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:10000/hdhive/preview/tmdb/372058

```
#### POST /hdhive/unlock/tmdb/:tmdbId ⚠️ 会消耗积分
从 TMDB ID 一键解锁并拿网盘。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"type":"movie"}' \
  http://localhost:10000/hdhive/unlock/tmdb/372058

```
#### POST /hdhive/unlock/resource/:slug ⚠️ 会消耗积分
通过 resource slug 解锁。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/unlock/resource/3fb1cb6823c64ae4a7a0f8f23bd4bed3

```
#### POST /hdhive/unlock/share ⚠️ 会消耗积分
通过分享 URL 解锁。
```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hdhive.com/movie/0816e198eae211ed8d4e0242ac190003","movieId":372058}' \
  http://localhost:10000/hdhive/unlock/share

```
#### GET /hdhive/resource/:slug/cloud189
单独提取 189 网盘链接（仅已解锁资源可用）。
```bash
curl -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/resource/3fb1cb6823c64ae4a7a0f8f23bd4bed3/cloud189

```
## ⚠️ 积分保护：确认调用流程
**/hdhive/unlock/* 接口会消耗积分**。生产部署务必加预览+预算控制。
### 积分规则
| 资源状态 | 调用 unlock 接口后 |
|---|---|
| unlock_points = 0（免费） | ❌ 不扣 |
| unlock_points > 0 已解锁 | ❌ 不重复扣（返回 already_owned: true） |
| unlock_points > 0 未解锁 | ✅ **扣 unlock_points 积分** |
### 推荐流程：先 preview 再 unlock
```bash
# 第 1 步：预览（不消耗积分）
curl -X POST -H "x-bridge-token: xxx" -d '{}' \
  http://localhost:10000/hdhive/preview/tmdb/372058

# 检查返回的 totalCost 和 currentPoints，确认预算

# 第 2 步：确认后一键解锁（消耗积分）
curl -X POST -H "x-bridge-token: xxx" -d '{}' \
  http://localhost:10000/hdhive/unlock/tmdb/372058

```
### 客户端代码示例（带积分预算）
```js
const POINTS_BUDGET = 50;
let totalSpent = 0;

for (const tmdbId of [372058, 550, 129]) {
  // 1. 预览（不消耗积分）
  const preview = await fetch(`http://hdhive-api:10000/hdhive/preview/tmdb/${tmdbId}`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'xxx' }
  }).then(r => r.json());

  // 2. 预算检查
  if (totalSpent + preview.data.cheapestCost > POINTS_BUDGET) {
    console.log(`⊘ TMDB ${tmdbId}: 预算不足`);
    continue;
  }

  // 3. 解锁
  const result = await fetch(`http://hdhive-api:10000/hdhive/unlock/tmdb/${tmdbId}`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'xxx' }
  }).then(r => r.json());

  totalSpent += preview.data.cheapestCost;
  console.log(`✓ TMDB ${tmdbId}: ${result.data.cloud189.fullText}`);
}

```
### 不消耗积分的接口（可安全调用）
 * GET /health
 * GET /metrics
 * POST /warmup
 * GET /hdhive/customer/current
 * GET /hdhive/customer/points-logs
 * GET /hdhive/customer/messages/unread-count
 * **POST /hdhive/customer/checkin（增加积分；可用 autoVerify=true 自动处理验证码）**
 * GET /hdhive/customer/playlists/my
 * POST /hdhive/customer/subscriptions/check
 * POST /hdhive/customer/check/resource
 * **POST /hdhive/preview/tmdb/:id** ⭐
 * GET /hdhive/public/bulletins/latest
 * GET /hdhive/resource/:slug/cloud189（仅已解锁）
### 会消耗积分的接口（谨慎调用）
 * POST /hdhive/unlock/tmdb/:id
 * POST /hdhive/unlock/resource/:slug
 * POST /hdhive/unlock/share
## 🐳 Docker 部署示例
### docker-compose.yml 完整示例
```yaml
version: '3.8'

services:
  hdhive-api:
    image: ghcr.io/wobuhui666/hdhive-bridge:latest
    container_name: hdhive-api
    restart: unless-stopped
    ports:
      - "10000:10000"
    environment:
      - BRIDGE_TOKEN=your-strong-token-here
      - HDHIVE_COOKIE=${HDHIVE_COOKIE}
      - HDHIVE_BASE_URL=https://hdhive.com
      - BROWSER_HEADLESS=true
      - AUTO_WARMUP=true
    volumes:
      - hdhive-data:/tmp/hdhive-cache
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:10000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

volumes:
  hdhive-data:

```
### 生产部署建议
 1. **使用反向代理**（nginx / caddy）：
   ```nginx
   location /hdhive/ {
     proxy_pass http://127.0.0.1:10000;
     proxy_set_header X-Forwarded-For $remote_addr;
     proxy_read_timeout 300s;  # 关键：解锁可能耗时 30-60s
   }
   
   ```
 2. **持久化浏览器数据**：用 volumes 挂载 /tmp/hdhive-cache
 3. **资源限制**：
   ```yaml
   deploy:
     resources:
       limits:
         memory: 4G  # Chromium 浏览器较耗内存
   
   ```
 4. **日志收集**：配置 logging.driver 收集日志到 ELK/Loki
 5. **健康检查**：用 /health 端点做健康检查
### Kubernetes 部署
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hdhive-api
spec:
  replicas: 1  # 注意：单例，因为共享浏览器状态
  selector:
    matchLabels:
      app: hdhive-api
  template:
    metadata:
      labels:
        app: hdhive-api
    spec:
      containers:
      - name: hdhive-api
        image: ghcr.io/wobuhui666/hdhive-bridge:latest
        ports:
        - containerPort: 10000
        env:
        - name: BRIDGE_TOKEN
          valueFrom:
            secretKeyRef:
              name: hdhive-secrets
              key: bridge-token
        - name: HDHIVE_COOKIE
          valueFrom:
            secretKeyRef:
              name: hdhive-secrets
              key: cookie
        resources:
          limits:
            memory: 4Gi
            cpu: "2"
        livenessProbe:
          httpGet:
            path: /health
            port: 10000
          initialDelaySeconds: 60
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 10000
          initialDelaySeconds: 30
          periodSeconds: 10
        volumeMounts:
        - name: cache
          mountPath: /tmp/hdhive-cache
      volumes:
      - name: cache
        emptyDir: {}

```
## 🔧 故障排查
### 容器启动失败
```bash
# 查看日志
docker logs hdhive-api

# 常见原因：cookie 过期 / token 错误 / 端口冲突

```
### 健康检查失败
```bash
# 进入容器调试
docker exec -it hdhive-api /bin/bash
wget -qO- http://localhost:10000/health

```
### 性能问题
 * 首次启动需要 20-40s（浏览器冷启动 + 加载 webpack）
 * 后续 API 调用：8-15s/次
 * 共享浏览器后，并发能力受限（建议单例部署）
### 内存问题
Chromium 默认占用 200-500MB 内存，建议容器至少 2GB。
## 📊 性能基准
测试环境：Linux + Docker + 4GB 内存容器
| 接口 | 平均耗时 |
|---|---|
| /health | < 10ms |
| /hdhive/customer/current | 0.5-2s |
| /hdhive/unlock/tmdb/372058 (首次) | 25-40s |
| /hdhive/unlock/tmdb/X (后续) | 8-15s |
## 🔄 更新镜像
```bash
# 拉取最新镜像
docker pull ghcr.io/wobuhui666/hdhive-bridge:latest

# 重启容器以应用新镜像
docker-compose up -d

```
