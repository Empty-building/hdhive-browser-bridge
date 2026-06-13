// server.mjs
// hdhive-api HTTP 服务：把 api-client.mjs 包装成 REST API
// 与 hdhive-browser-bridge 兼容，提供相同的 /hdhive/* 接口 + 新增 TMDB 一键解锁

import express from 'express';
import { HdhiveClient } from './api-client.mjs';

const config = {
  port: Number(process.env.PORT || 10000),
  bridgeToken: String(process.env.BRIDGE_TOKEN || ''),
  defaultCookie: String(process.env.HDHIVE_COOKIE || ''),
  baseUrl: String(process.env.HDHIVE_BASE_URL || 'https://hdhive.com'),
  headless: process.env.BROWSER_HEADLESS !== 'false',
  // 接口超时（单个请求最长执行时间）
  actionTimeoutMs: Number(process.env.ACTION_TIMEOUT_MS || 180_000),
  // 是否启用自动 warmup
  autoWarmup: process.env.AUTO_WARMUP !== 'false'
};

// 全局状态
const state = {
  startedAt: Date.now(),
  client: null,
  lastSuccess: null,
  lastError: null,
  totalCalls: 0,
  failedCalls: 0,
  warmupAt: null,
  warmupOk: false,
  activeAction: null,
  browserLaunching: false
};

const app = express();
app.use(express.json({ limit: '1mb' }));

// Token 校验中间件
app.use((req, res, next) => {
  if (!config.bridgeToken || req.path === '/health') return next();
  const provided = req.get('x-bridge-token') || req.query.token;
  if (provided !== config.bridgeToken) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
});

// 获取或创建 client（带 cookie）
function getClient(cookieOverride) {
  const cookie = cookieOverride || config.defaultCookie;
  if (!cookie) {
    throw new Error('no cookie available: set HDHIVE_COOKIE env or pass cookie in body/header');
  }
  if (!state.client) {
    state.client = new HdhiveClient({
      baseUrl: config.baseUrl,
      cookie,
      headless: config.headless
    });
  } else if (state.client.cookie !== cookie) {
    // 如果 cookie 变了，重建 client
    state.client.close().catch(() => {});
    state.client = new HdhiveClient({
      baseUrl: config.baseUrl,
      cookie,
      headless: config.headless
    });
  }
  return state.client;
}

// 工具函数：获取请求 cookie（优先级：body.cookie > header > env）
function getRequestCookie(req) {
  return req.body?.cookie
      || req.get('x-hdhive-cookie')
      || config.defaultCookie;
}

// 通用 API 调用封装（带超时）
async function withTimeout(actionName, fn) {
  state.activeAction = { name: actionName, startedAt: Date.now() };
  let timeoutHandle;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`action ${actionName} timed out after ${config.actionTimeoutMs}ms`)),
          config.actionTimeoutMs
        );
      })
    ]);
    state.lastSuccess = Date.now();
    state.totalCalls++;
    return { success: true, data: result };
  } catch (e) {
    state.lastError = e.message;
    state.failedCalls++;
    return { success: false, error: e.message };
  } finally {
    clearTimeout(timeoutHandle);
    state.activeAction = null;
  }
}

// ─────────────────── 生命周期接口 ───────────────────

// 健康检查（无需 token）
app.get('/health', async (req, res) => {
  const ready = Boolean(state.client && state.warmupOk);
  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'healthy' : 'warming_up',
    uptime: Date.now() - state.startedAt,
    totalCalls: state.totalCalls,
    failedCalls: state.failedCalls,
    lastSuccess: state.lastSuccess,
    lastError: state.lastError,
    activeAction: state.activeAction?.name || null
  });
});

// 状态指标
app.get('/metrics', (req, res) => {
  res.json({
    success: true,
    data: {
      startedAt: state.startedAt,
      uptime: Date.now() - state.startedAt,
      totalCalls: state.totalCalls,
      failedCalls: state.failedCalls,
      successRate: state.totalCalls > 0 ? ((state.totalCalls - state.failedCalls) / state.totalCalls * 100).toFixed(2) + '%' : 'N/A',
      lastSuccess: state.lastSuccess,
      lastError: state.lastError,
      warmupAt: state.warmupAt,
      warmupOk: state.warmupOk,
      activeAction: state.activeAction,
      config: {
        port: config.port,
        baseUrl: config.baseUrl,
        hasToken: Boolean(config.bridgeToken),
        hasDefaultCookie: Boolean(config.defaultCookie),
        headless: config.headless
      }
    }
  });
});

// 预热：启动浏览器
app.post('/warmup', async (req, res) => {
  const r = await withTimeout('warmup', async () => {
    const cookie = getRequestCookie(req);
    if (!cookie) throw new Error('no cookie');
    const client = getClient(cookie);
    if (!state.client._ready) {
      await client._ensureBrowser();
    }
    state.warmupAt = Date.now();
    state.warmupOk = true;
    return { warmed: true, elapsedMs: Date.now() - state.warmupAt };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── Customer API（兼容原 bridge）───────────────────

// 当前用户
app.get('/hdhive/customer/current', async (req, res) => {
  const r = await withTimeout('customer/current', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.getCurrentUser();
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 积分日志
app.get('/hdhive/customer/points-logs', async (req, res) => {
  const r = await withTimeout('customer/points-logs', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.getPointsLogs(req.query);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 签到
app.post('/hdhive/customer/checkin', async (req, res) => {
  const r = await withTimeout('customer/checkin', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.checkin();
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 未读消息数
app.get('/hdhive/customer/messages/unread-count', async (req, res) => {
  const r = await withTimeout('customer/messages/unread-count', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.getUnreadCount();
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 我的播放列表
app.get('/hdhive/customer/playlists/my', async (req, res) => {
  const r = await withTimeout('customer/playlists/my', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.call('GET', '/api/customer/playlists/my', { query: req.query });
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 订阅检查
app.post('/hdhive/customer/subscriptions/check', async (req, res) => {
  const r = await withTimeout('customer/subscriptions/check', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.call('GET', '/api/customer/subscriptions/check', {
      query: req.body?.query || req.body
    });
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 资源详情
app.get('/hdhive/customer/resources/:resourceId', async (req, res) => {
  const r = await withTimeout('customer/resources', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.getResource(req.params.resourceId);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 解锁资源
app.post('/hdhive/customer/resources/:resourceId/unlock', async (req, res) => {
  const r = await withTimeout('customer/resources/unlock', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.unlockResource(req.params.resourceId);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 检查资源
app.post('/hdhive/customer/check/resource', async (req, res) => {
  const r = await withTimeout('customer/check/resource', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.checkResource(req.body?.url);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 通用 customer API 代理
app.post('/hdhive/customer/:action*', async (req, res) => {
  const r = await withTimeout(`customer/${req.params.action}`, async () => {
    const client = getClient(getRequestCookie(req));
    const path = `/api/customer/${req.params.action}${req.params[0] || ''}`;
    const method = req.method;
    return await client.call(method, path, {
      query: req.query,
      body: req.body?.body || (method !== 'GET' ? req.body : undefined)
    });
  });
  res.status(r.success ? 200 : 500).json(r);
});

app.get('/hdhive/customer/:action*', async (req, res) => {
  const r = await withTimeout(`customer/${req.params.action}`, async () => {
    const client = getClient(getRequestCookie(req));
    const path = `/api/customer/${req.params.action}${req.params[0] || ''}`;
    return await client.call('GET', path, { query: req.query });
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── 公共 API ───────────────────

app.get('/hdhive/public/bulletins/latest', async (req, res) => {
  const r = await withTimeout('public/bulletins/latest', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.getBulletins();
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── ★ 一键解锁（核心接口）───────────────────

// TMDB ID 一键解锁：解析 → 找资源 → 解锁 → 拿网盘
app.post('/hdhive/unlock/tmdb/:tmdbId', async (req, res) => {
  const r = await withTimeout('unlock/tmdb', async () => {
    const client = getClient(getRequestCookie(req));
    const type = req.body?.type || req.query.type || 'movie';
    return await client.unlockByTmdbId(Number(req.params.tmdbId), type);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// Resource slug 一键解锁 + 拿网盘
app.post('/hdhive/unlock/resource/:slug', async (req, res) => {
  const r = await withTimeout('unlock/resource', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.unlockByResourceSlug(req.params.slug);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// Movie URL 一键解锁
app.post('/hdhive/unlock/share', async (req, res) => {
  const r = await withTimeout('unlock/share', async () => {
    const client = getClient(getRequestCookie(req));
    const { url, movieId } = req.body || {};
    if (!url) throw new Error('url is required');
    return await client.unlockByShareUrl(url, movieId);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 单独提取 189 网盘链接（resource slug）
app.get('/hdhive/resource/:slug/cloud189', async (req, res) => {
  const r = await withTimeout('resource/cloud189', async () => {
    const client = getClient(getRequestCookie(req));
    return await client.getCloud189Links(req.params.slug);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── 启动 ───────────────────

app.listen(config.port, '0.0.0.0', async () => {
  console.log(`[hdhive-api] listening on ${config.port}`);
  console.log(`[hdhive-api] baseUrl=${config.baseUrl} headless=${config.headless}`);
  console.log(`[hdhive-api] BRIDGE_TOKEN=${config.bridgeToken ? 'set' : 'EMPTY (public)'}`);
  console.log(`[hdhive-api] HDHIVE_COOKIE=${config.defaultCookie ? 'set' : 'EMPTY (need to pass per-request)'}`);

  if (config.autoWarmup && config.defaultCookie) {
    console.log('[hdhive-api] auto warmup...');
    try {
      const client = getClient();
      await client._ensureBrowser();
      state.warmupAt = Date.now();
      state.warmupOk = true;
      console.log('[hdhive-api] warmup OK');
    } catch (e) {
      console.error('[hdhive-api] warmup failed:', e.message);
    }
  }
});

// 优雅退出
async function shutdown() {
  console.log('[hdhive-api] shutting down...');
  if (state.client) await state.client.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);