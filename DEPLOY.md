# HDHive API 服务部署指南

## 📦 镜像说明

`hdhive-api` 是一个 Docker 镜像，把 `api-client.mjs` 包装成 HTTP REST API 服务，**接口与原 hdhive-browser-bridge 完全兼容**，并新增了 TMDB 一键解锁接口。

镜像特点：
- 基于 `mcr.microsoft.com/playwright:v1.49.1-noble`（已包含 Chromium）
- 安装中文字体（避免影巢页面乱码）
- 体积约 1.5GB（包含 Chromium）

---

## 🚀 快速开始

### 方式 1：docker run（最简单）

```bash
# 1. 构建镜像
docker build -t hdhive-api:latest .

# 2. 准备 cookie
node dump-cookies.mjs "your@email.com" "your-password"
# 输出到 /tmp/hdhive-cookies.txt

# 3. 启动容器
docker run -d \
  --name hdhive-api \
  -p 10000:10000 \
  -e BRIDGE_TOKEN=your-secret-token \
  -e HDHIVE_COOKIE="$(cat /tmp/hdhive-cookies.txt)" \
  -v hdhive-data:/tmp/hdhive-cache \
  --restart unless-stopped \
  hdhive-api:latest
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

1. 把代码 push 到 GitHub
2. 在 Render 创建 Web Service
3. 选择 Docker 环境
4. 设置环境变量：
   - `BRIDGE_TOKEN`
   - `HDHIVE_COOKIE`
5. Deploy

---

## 🔑 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `BRIDGE_TOKEN` | ❌ | 空 | API 保护 token。空 = 不校验（**生产环境务必设置**）|
| `HDHIVE_COOKIE` | ❌ | 空 | 默认 cookie。如果不设，每个请求需单独传 |
| `HDHIVE_BASE_URL` | ❌ | `https://hdhive.com` | 影巢基础 URL |
| `BROWSER_HEADLESS` | ❌ | `true` | 是否无头模式（调试可设 `false`）|
| `ACTION_TIMEOUT_MS` | ❌ | `180000` | 单个接口超时（毫秒）|
| `AUTO_WARMUP` | ❌ | `true` | 启动时自动预热浏览器 |
| `PORT` | ❌ | `10000` | HTTP 端口 |

### Cookie 传递优先级

每个请求的 cookie 按以下优先级获取：

1. **请求 body**：`POST /hdhive/login` body 中传 `{"cookie": "..."}`
2. **请求头**：`x-hdhive-cookie: ...`
3. **环境变量**：`HDHIVE_COOKIE`

---

## 📡 API 接口

所有接口（除 `/health`）需要 `x-bridge-token` 请求头。

### 基础接口

#### `GET /health`
健康检查（不需要 token）。

```bash
curl http://localhost:10000/health
# {"success":true,"status":"healthy","uptime":12345,...}
```

#### `GET /metrics`
查看指标。

```bash
curl -H "x-bridge-token: xxx" http://localhost:10000/metrics
```

#### `POST /warmup`
预热浏览器（手动触发）。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:10000/warmup
```

### Customer API（兼容原 bridge）

#### `GET /hdhive/customer/current`
当前用户信息。

```bash
curl -H "x-bridge-token: xxx" http://localhost:10000/hdhive/customer/current
```

#### `GET /hdhive/customer/points-logs?page=1&page_size=10`
积分日志。

#### `POST /hdhive/customer/checkin`
签到。

```bash
curl -X POST -H "x-bridge-token: xxx" http://localhost:10000/hdhive/customer/checkin
```

#### `GET /hdhive/customer/messages/unread-count`
未读消息数。

#### `GET /hdhive/customer/playlists/my?page=1&page_size=20`
我的播放列表。

#### `POST /hdhive/customer/subscriptions/check`
订阅检查。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"target_type":"media_resource","target_key":"movie:550"}' \
  http://localhost:10000/hdhive/customer/subscriptions/check
```

#### `GET /hdhive/customer/resources/:resourceId`
资源详情。

```bash
curl -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/customer/resources/3fb1cb6823c64ae4a7a0f8f23bd4bed3
```

#### `POST /hdhive/customer/resources/:resourceId/unlock`
解锁资源。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/customer/resources/3fb1cb6823c64ae4a7a0f8f23bd4bed3/unlock
```

#### `POST /hdhive/customer/check/resource`
检查分享链接。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hdhive.com/resource/189/abc123..."}' \
  http://localhost:10000/hdhive/customer/check/resource
```

### 公共 API

#### `GET /hdhive/public/bulletins/latest`
最新公告。

### ⭐ TMDB 一键解锁（核心接口）

#### `POST /hdhive/unlock/tmdb/:tmdbId`
从 TMDB ID 一键解锁并拿网盘（**最常用**）。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"type":"movie"}' \
  http://localhost:10000/hdhive/unlock/tmdb/372058
```

**返回**：
```json
{
  "success": true,
  "data": {
    "success": true,
    "tmdbId": 372058,
    "type": "movie",
    "movieSlug": "0816e198eae211ed8d4e0242ac190003",
    "resourceSlug": "3fb1cb6823c64ae4a7a0f8f23bd4bed3",
    "unlock": {
      "access_code": "f8bq",
      "full_url": "https://cloud.189.cn/t/YnqE3aJJv2qy（访问码：f8bq）",
      "url": "https://cloud.189.cn/t/YnqE3aJJv2qy"
    },
    "cloud189": {
      "url": "https://cloud.189.cn/t/YnqE3aJJv2qy",
      "accessCode": "f8bq",
      "shareSize": null,
      "remark": "...",
      "fullText": "https://cloud.189.cn/t/YnqE3aJJv2qy（访问码：f8bq）"
    }
  }
}
```

#### `POST /hdhive/unlock/resource/:slug`
通过 resource slug 解锁。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/unlock/resource/3fb1cb6823c64ae4a7a0f8f23bd4bed3
```

#### `POST /hdhive/unlock/share`
通过分享 URL 解锁。

```bash
curl -X POST -H "x-bridge-token: xxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hdhive.com/movie/0816e198eae211ed8d4e0242ac190003","movieId":372058}' \
  http://localhost:10000/hdhive/unlock/share
```

#### `GET /hdhive/resource/:slug/cloud189`
单独提取 189 网盘链接。

```bash
curl -H "x-bridge-token: xxx" \
  http://localhost:10000/hdhive/resource/3fb1cb6823c64ae4a7a0f8f23bd4bed3/cloud189
```

---

## 🐳 Docker 部署示例

### docker-compose.yml 完整示例

```yaml
version: '3.8'

services:
  hdhive-api:
    build: .
    image: hdhive-api:latest
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

2. **持久化浏览器数据**：用 `volumes` 挂载 `/tmp/hdhive-cache`

3. **资源限制**：
   ```yaml
   deploy:
     resources:
       limits:
         memory: 4G  # Chromium 浏览器较耗内存
   ```

4. **日志收集**：配置 `logging.driver` 收集日志到 ELK/Loki

5. **健康检查**：用 `/health` 端点做健康检查

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
        image: hdhive-api:latest
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

---

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

- 首次启动需要 20-40s（浏览器冷启动 + 加载 webpack）
- 后续 API 调用：8-15s/次
- 共享浏览器后，并发能力受限（建议单例部署）

### 内存问题

Chromium 默认占用 200-500MB 内存，建议容器至少 2GB。

---

## 📊 性能基准

测试环境：Linux + Docker + 4GB 内存容器

| 接口 | 平均耗时 |
|------|---------|
| `/health` | < 10ms |
| `/hdhive/customer/current` | 0.5-2s |
| `/hdhive/unlock/tmdb/372058` (首次) | 25-40s |
| `/hdhive/unlock/tmdb/X` (后续) | 8-15s |

---

## 🔄 更新镜像

```bash
# 拉取最新代码
git pull

# 重新构建
docker-compose build --no-cache

# 重启
docker-compose up -d
```