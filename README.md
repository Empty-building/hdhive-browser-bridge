# HDHive Browser Bridge

常驻 Chromium 的独立测试容器，用来验证“浏览器保持热启动”是否能降低影巢签名桥接的冷启动成本。

## 本地运行

```bash
cd browser-bridge
npm install
npm start
```

## 接口

- `GET /health`：Render 健康检查，不需要 token。
- `GET /metrics`：浏览器状态、内存、预热耗时。
- `POST /warmup`：立即预热，可传 `{ "urls": ["/", "/search"] }`。
- `GET /hdhive/status`：打开影巢首页并返回页面状态。
- `GET /hdhive/open?path=/movie/550`：打开指定路径，验证热浏览器导航耗时。
- `POST /browser/restart`：重启浏览器上下文。

如果设置了 `BRIDGE_TOKEN`，除 `/health` 外都需要请求头 `x-bridge-token: <token>`。

## Render 环境变量

- `PORT`：Render 自动注入。
- `BRIDGE_TOKEN`：建议必填，保护公开接口。
- `HDHIVE_BASE_URL`：默认 `https://hdhive.com`。
- `HDHIVE_COOKIE`：可选，浏览器启动时注入影巢 Cookie。
- `BROWSER_PROFILE_DIR`：默认 `/data/hdhive-profile`，配 Render Disk 时可持久化登录态。
- `WARMUP_URLS`：默认 `/,/search`。
- `WARMUP_INTERVAL_MS`：默认 `300000`。
- `KEEPALIVE_INTERVAL_MS`：默认 `25000`。

## 说明

这个容器目前只做“热浏览器 + 页面预热 + 探活”，没有开放任意 JS 执行接口，避免公开部署后变成远程执行入口。后续要接 `/api/customer/*`，建议在这个容器里继续做白名单动作，而不是暴露通用 `eval`。
