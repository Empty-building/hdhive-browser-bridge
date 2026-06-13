# HDHive API 服务 Docker 镜像
# 包装 api-client.mjs 为 REST API

FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PORT=10000
ENV BROWSER_HEADLESS=true

# 安装系统依赖（中文字体，避免部分页面乱码）
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# 安装依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# 复制源码
COPY api-client.mjs ./
COPY server.mjs ./
COPY example.mjs ./

# 创建临时目录（用于浏览器 profile 和 cookie 缓存）
RUN mkdir -p /tmp/hdhive-cache && chmod 777 /tmp/hdhive-cache
ENV TMPDIR=/tmp/hdhive-cache

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/health || exit 1

EXPOSE 10000

CMD ["node", "server.mjs"]