// server.mjs
// hdhive-api HTTP 服务：把 api-client.mjs 包装成 REST API
// 与 hdhive-browser-bridge 兼容，提供相同的 /hdhive/* 接口 + 新增 TMDB 一键解锁

import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { HdhiveClient, STEALTH_SCRIPT, RSC_INTERCEPTOR_SCRIPT } from './api-client.mjs';

const config = {
  port: Number(process.env.PORT || 10000),
  bridgeToken: String(process.env.BRIDGE_TOKEN || ''),
  defaultCookie: String(process.env.HDHIVE_COOKIE || ''),
  defaultUsername: String(process.env.HDHIVE_USERNAME || ''),
  defaultPassword: String(process.env.HDHIVE_PASSWORD || ''),
  baseUrl: String(process.env.HDHIVE_BASE_URL || 'https://hdhive.com'),
  headless: process.env.BROWSER_HEADLESS !== 'false',
  // 接口超时（单个请求最长执行时间）
  actionTimeoutMs: Number(process.env.ACTION_TIMEOUT_MS || 180_000),
  // 是否启用自动 warmup
  autoWarmup: process.env.AUTO_WARMUP !== 'false',
  // 只读查询短缓存 TTL，默认 60 秒；设为 0 可关闭
  readCacheTtlMs: Number(process.env.READ_CACHE_TTL_MS || process.env.MEDIA_RESOURCES_CACHE_TTL_MS || 60_000),
  // 数据库配置
  databaseUrl: String(process.env.DATABASE_URL || process.env.BRIDGE_STATE_DATABASE_URL || ''),
  // 加密密钥（用于加密 cookie 存储）
  encryptSecret: String(process.env.BRIDGE_STATE_SECRET || process.env.BRIDGE_TOKEN || ''),
  // cookie key 前缀（区分不同 Bridge 实例）
  cookieKey: String(process.env.COOKIE_KEY || process.env.BRIDGE_STATE_KEY || 'default')
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
  browserLaunching: false,
  readCache: new Map()
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

// 工具函数：获取请求 cookie（优先级：body.cookie > header > env > database）
async function getRequestCookieAsync(req) {
  const fromBody = req.body?.cookie;
  const fromHeader = req.get('x-hdhive-cookie');
  if (fromBody) return fromBody;
  if (fromHeader) return fromHeader;
  if (config.defaultCookie) return config.defaultCookie;
  // 从数据库 fallback
  if (dbState.initialized) {
    return await loadCookieFromDb(config.cookieKey);
  }
  return '';
}

function getCookieFingerprint(cookie) {
  if (!cookie) return 'none';
  return createHash('sha256').update(String(cookie)).digest('hex').slice(0, 16);
}

function makeReadCacheKey(parts, cookie) {
  return [
    ...parts.map(part => String(part ?? '').trim().toLowerCase()),
    `cookie:${getCookieFingerprint(cookie)}`
  ].join('|');
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getReadCache(key) {
  if (!config.readCacheTtlMs) return null;
  const item = state.readCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    state.readCache.delete(key);
    return null;
  }
  return cloneJson(item.value);
}

function setReadCache(key, value) {
  if (!config.readCacheTtlMs) return;
  state.readCache.set(key, {
    value: cloneJson(value),
    expiresAt: Date.now() + config.readCacheTtlMs
  });
}

function clearReadCache() {
  state.readCache.clear();
}

// ─────────────────── 数据库持久化 cookie ───────────────────

const dbState = {
  pool: null,
  initialized: false,
  schema: `
    CREATE TABLE IF NOT EXISTS hdhive_cookies (
      key TEXT PRIMARY KEY,
      cookie_encrypted TEXT NOT NULL,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `
};

function getEncryptionKey(secret) {
  if (!secret) return null;
  return createHash('sha256').update(String(secret)).digest();
}

function encryptCookie(plaintext, secret) {
  const key = getEncryptionKey(secret);
  if (!key) throw new Error('BRIDGE_STATE_SECRET or BRIDGE_TOKEN must be set for encrypted cookie storage');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptCookie(ciphertext, secret) {
  const key = getEncryptionKey(secret);
  if (!key) throw new Error('BRIDGE_STATE_SECRET or BRIDGE_TOKEN must be set for encrypted cookie storage');
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function initDatabase() {
  if (!config.databaseUrl) return false;
  if (dbState.initialized) return true;

  try {
    dbState.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000
    });
    await dbState.pool.query(dbState.schema);
    dbState.initialized = true;
    console.log('[hdhive-api] database connected');
    return true;
  } catch (e) {
    console.error('[hdhive-api] database connection failed:', e.message);
    dbState.pool = null;
    return false;
  }
}

async function saveCookieToDb(key, cookie, meta = {}) {
  if (!dbState.initialized || !config.encryptSecret) {
    return { saved: false, reason: 'database or encryption not configured' };
  }
  try {
    const encrypted = encryptCookie(cookie, config.encryptSecret);
    await dbState.pool.query(
      `INSERT INTO hdhive_cookies (key, cookie_encrypted, meta, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET
         cookie_encrypted = EXCLUDED.cookie_encrypted,
         meta = EXCLUDED.meta,
         updated_at = NOW()`,
      [key, encrypted, meta]
    );
    return { saved: true };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

async function loadCookieFromDb(key) {
  if (!dbState.initialized) return null;
  try {
    const r = await dbState.pool.query(
      'SELECT cookie_encrypted FROM hdhive_cookies WHERE key = $1',
      [key]
    );
    if (r.rows.length === 0) return null;
    return decryptCookie(r.rows[0].cookie_encrypted, config.encryptSecret);
  } catch (e) {
    console.error('[hdhive-api] load cookie failed:', e.message);
    return null;
  }
}

async function deleteCookieFromDb(key) {
  if (!dbState.initialized) return false;
  try {
    const r = await dbState.pool.query('DELETE FROM hdhive_cookies WHERE key = $1', [key]);
    return r.rowCount > 0;
  } catch {
    return false;
  }
}

async function listCookiesFromDb() {
  if (!dbState.initialized) return [];
  try {
    const r = await dbState.pool.query(
      'SELECT key, meta, created_at, updated_at FROM hdhive_cookies ORDER BY updated_at DESC'
    );
    return r.rows.map(row => ({
      key: row.key,
      meta: row.meta,
      created_at: row.created_at,
      updated_at: row.updated_at,
      hasCookie: true
    }));
  } catch {
    return [];
  }
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
      readCache: {
        enabled: Boolean(config.readCacheTtlMs),
        ttlMs: config.readCacheTtlMs,
        size: state.readCache.size
      },
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
    const client = getClient(await getRequestCookieAsync(req));
    const result = await client.getCurrentUser();
    return { ...result, payload: result.data };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 积分日志
app.get('/hdhive/customer/points-logs', async (req, res) => {
  const r = await withTimeout('customer/points-logs', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    const result = await client.getPointsLogs(req.query);
    return { ...result, payload: result.data };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 签到
app.post('/hdhive/customer/checkin', async (req, res) => {
  const r = await withTimeout('customer/checkin', async () => {
    clearReadCache();
    const client = getClient(await getRequestCookieAsync(req));
    const result = await client.checkin();
    return { ...result, payload: result.data };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 未读消息数
app.get('/hdhive/customer/messages/unread-count', async (req, res) => {
  const r = await withTimeout('customer/messages/unread-count', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    return await client.getUnreadCount();
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 我的播放列表
app.get('/hdhive/customer/playlists/my', async (req, res) => {
  const r = await withTimeout('customer/playlists/my', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    return await client.call('GET', '/api/customer/playlists/my', { query: req.query });
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 订阅检查
app.post('/hdhive/customer/subscriptions/check', async (req, res) => {
  const r = await withTimeout('customer/subscriptions/check', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    return await client.call('GET', '/api/customer/subscriptions/check', {
      query: req.body?.query || req.body
    });
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 资源详情
// ⭐ 资源详情（兼容 cloud189-auto-save 期望的格式，含 link/code）
app.get('/hdhive/customer/resources/:resourceId', async (req, res) => {
  const r = await withTimeout('customer/resources', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    const slug = req.params.resourceId;

    // 1. API 查询
    let apiData = null;
    try {
      const r = await client.getResource(slug);
      apiData = r.data?.data;
    } catch {}

    // 2. 爬 189 链接（已解锁的话能拿到）
    let cloud189 = null;
    try {
      cloud189 = await client.getCloud189Links(slug);
    } catch {}

    const link = cloud189?.url || apiData?.url || '';
    const code = cloud189?.accessCode || apiData?.access_code || '';
    const isUnlocked = Boolean(cloud189?.url) || apiData?.is_unlocked || false;
    const unlockPoints = apiData?.unlock_points ?? apiData?.default_unlock_points ?? (apiData?.is_free ? 0 : null);

    return {
      // cloud189-auto-save 期望
      link,
      code,
      accessCode: code,
      fullUrl: link && code ? `${link}（访问码：${code}）` : link,
      // 嵌套 resources
      resources: [{
        id: slug,
        slug,
        title: apiData?.title || '未命名资源',
        cloudType: 'cloud189',
        link,
        code,
        accessCode: code,
        size: apiData?.share_size || 0,
        sizeFormatted: formatSize(apiData?.share_size || 0),
        points: unlockPoints,
        isFree: unlockPoints === 0,
        isUnlocked,
        movieId: apiData?.movie_id,
        tvId: apiData?.tv_id,
        uploader: apiData?.user || {},
        createdAt: apiData?.created_at
      }],
      detail: {
        link,
        code,
        accessCode: code
      },
      payload: apiData,
      raw: apiData
    };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 解锁资源（兼容 cloud189-auto-save 期望的格式）
app.post('/hdhive/customer/resources/:resourceId/unlock', async (req, res) => {
  const r = await withTimeout('customer/resources/unlock', async () => {
    clearReadCache();
    const client = getClient(await getRequestCookieAsync(req));
    const slug = req.params.resourceId;

    // 1. 调用影巢 unlock API
    const unlock = await client.unlockResource(slug);

    // 2. 立即获取 189 网盘链接（解锁后才能拿）
    let cloud189 = null;
    try {
      cloud189 = await client.getCloud189Links(slug);
    } catch (e) {
      console.warn('[unlock] getCloud189Links failed:', e.message);
    }

    // 3. 解析 access_code（解锁返回的 url 字段包含）
    const apiData = unlock.data?.data || {};
    const accessCode = apiData.access_code || cloud189?.accessCode || '';
    const shareUrl = apiData.url || cloud189?.url || '';
    const fullUrl = apiData.full_url || (shareUrl && accessCode
      ? `${shareUrl}（访问码：${accessCode}）`
      : shareUrl);

    return {
      // cloud189-auto-save 期望的字段
      link: shareUrl,
      code: accessCode,
      fullUrl,
      accessCode,
      // 嵌套 resources 字段（cloud189-auto-save 会从这读）
      resources: cloud189?.url ? [{
        id: slug,
        slug,
        title: '已解锁资源',
        cloudType: 'cloud189',
        link: shareUrl,
        code: accessCode,
        accessCode,
        isUnlocked: true,
        size: 0,
        points: 0,
        isFree: true
      }] : [],
      detail: cloud189?.url ? [{
        id: slug,
        slug,
        title: '已解锁资源',
        cloudType: 'cloud189',
        link: shareUrl,
        code: accessCode,
        accessCode,
        isUnlocked: true
      }] : [],
      payload: {
        link: shareUrl,
        code: accessCode,
        fullUrl
      },
      // 原始信息
      raw: unlock.data,
      message: unlock.data?.message || 'unlock done'
    };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 检查资源
app.post('/hdhive/customer/check/resource', async (req, res) => {
  const r = await withTimeout('customer/check/resource', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    return await client.checkResource(req.body?.url);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ⭐ cloud189-auto-save 兼容接口：通过 type+tmdbId 查询资源列表（不消耗积分）
// 调用方式：POST /hdhive/customer/media-resources
//   body: { type: 'movie' | 'tv', tmdbId: '...' }
// 期望返回：{ resources: [{ id, slug, title, size, sizeFormatted, points, isFree, link, code, isUnlocked, ... }] }
app.post('/hdhive/customer/media-resources', async (req, res) => {
  const r = await withTimeout('customer/media-resources', async () => {
    const cookie = await getRequestCookieAsync(req);
    const type = String(req.body?.type || 'movie').trim();
    const tmdbId = String(req.body?.tmdbId || '').trim();
    if (!tmdbId) throw new Error('tmdbId is required');
    const cacheKey = makeReadCacheKey(['media-resources', type, tmdbId], cookie);
    const cached = getReadCache(cacheKey);
    if (cached) return { ...cached, cache: { hit: true, ttlMs: config.readCacheTtlMs } };

    const client = getClient(cookie);

    // 1. 解析 TMDB → 内部 URL（无需登录）
    const resolved = await client.resolveTmdbToInternal(tmdbId, type);

    // 2. 找资源列表
    const resources = await client.findResourcesFromMoviePage(resolved.url);

    // 3. 对每个资源查积分 + 尝试拿 189 链接（不消耗积分，但 getCloud189Links 需要已解锁）
    const enriched = [];
    for (const r of resources) {
      let info = {};
      let infoError = null;
      try {
        info = await client.getResourceUnlockInfo(r);
      } catch (e) {
        infoError = e.message.slice(0, 100);
      }

      const points = info.default_unlock_points ?? info.unlock_points ?? r.unlock_points ?? null;
      const size = info.share_size ?? r.share_size ?? 0;
      let link = r.media_url || r.link || '';
      let code = r.access_code || r.code || '';
      let isUnlocked = Boolean(r.is_unlocked || r.isUnlocked || link);

      // 只有免费/已解锁资源才需要打开详情页拿链接；付费锁定资源跳过，避免无效等待。
      if (!link && (isUnlocked || points === 0)) {
        try {
          const cloud189 = await client.getCloud189Links(r.slug);
          if (cloud189.url) {
            link = cloud189.url;
            code = cloud189.accessCode || '';
            isUnlocked = true;
          }
        } catch {}
      }

      const item = {
        id: r.slug,
        slug: r.slug,
        title: (r.title || r.text?.split('\n')[0] || '未命名资源').slice(0, 100),
        size,
        sizeFormatted: formatSize(size),
        points,
        isFree: points === 0,
        link,
        code,
        isUnlocked,
        cloudType: 'cloud189',
        // 额外字段
        source: info.source || r.source || 'bridge',
        movieId: tmdbId,
        movieType: type
      };
      if (infoError && points === null) item.error = infoError;
      enriched.push(item);
    }

    const payload = {
      resources: enriched,
      movieSlug: resolved.slug,
      movieUrl: resolved.url,
      tmdbId,
      type,
      cache: { hit: false, ttlMs: config.readCacheTtlMs }
    };
    setReadCache(cacheKey, payload);
    return payload;
  });
  res.status(r.success ? 200 : 500).json(r);
});

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${units[i]}`;
}

// 通用 customer API 代理
app.post('/hdhive/customer/:action*', async (req, res) => {
  const r = await withTimeout(`customer/${req.params.action}`, async () => {
    const client = getClient(await getRequestCookieAsync(req));
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
    const client = getClient(await getRequestCookieAsync(req));
    const path = `/api/customer/${req.params.action}${req.params[0] || ''}`;
    return await client.call('GET', path, { query: req.query });
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── 公共 API ───────────────────

app.get('/hdhive/public/bulletins/latest', async (req, res) => {
  const r = await withTimeout('public/bulletins/latest', async () => {
    const client = getClient(await getRequestCookieAsync(req));
    return await client.getBulletins();
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── 账号密码登录 ───────────────────

// 登录后获取 cookie 字符串（**会消耗一次登录请求**）
// ⚠️ 此接口会实际登录影巢账号，建议只在 cookie 过期时调用
app.post('/hdhive/login', async (req, res) => {
  const r = await withTimeout('login', async () => {
    const username = req.body?.username || config.defaultUsername;
    const password = req.body?.password || config.defaultPassword;
    if (!username || !password) {
      throw new Error('username and password are required');
    }

    // 启动一个临时浏览器（独立 context，不影响主 client）
    const { chromium } = await import('playwright');
    const profileDir = path.join(os.tmpdir(), `hdhive-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      // 注入 stealth + RSC interceptor
      await ctx.addInitScript(STEALTH_SCRIPT);

      // 访问登录页
      const page = await ctx.pages()[0] || await ctx.newPage();
      await page.goto(`${config.baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

      // 等表单出现
      let formFound = false;
      for (let i = 0; i < 30; i++) {
        if (await page.locator('input[type="password"]').count().catch(() => 0) > 0) {
          formFound = true;
          break;
        }
        await page.waitForTimeout(1000);
      }
      if (!formFound) throw new Error('login form not found');

      // 填写表单
      await page.locator('input[name="username"], input[type="email"], input[type="text"]').first().fill(username);
      await page.locator('input[type="password"]').first().fill(password);
      const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
      if (await submit.count() > 0) await submit.click();
      else await page.locator('input[type="password"]').first().press('Enter');

      // 等登录完成（URL 跳转走）
      await page.waitForTimeout(15000);

      // 提取 cookie
      const cookies = await ctx.cookies();
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      const loginCookieNames = ['token', 'csrf_access_token', 'hdh_uid', 'hdh_sa_token'];
      const hasLoginCookie = cookies.some(c => loginCookieNames.includes(c.name));

      if (!hasLoginCookie) {
        throw new Error('login failed: no login cookies found (可能需要验证码/二次验证)');
      }

      // 同时尝试获取用户信息验证
      let userInfo = null;
      try {
        // 简化：尝试访问当前用户 API
        const u = await page.evaluate(() => {
          const m = document.cookie.match(/(?:^|;\s*)hdh_uid=([^;]+)/);
          return m ? m[1] : null;
        });
        userInfo = { hdh_uid: u };
      } catch {}

      // 自动持久化到数据库（如果配置了）
      let dbSaved = null;
      const saveKey = req.body?.key || config.cookieKey;
      if (dbState.initialized) {
        dbSaved = await saveCookieToDb(saveKey, cookieHeader, {
          hdh_uid: userInfo?.hdh_uid,
          source: 'login',
          ua: req.get('user-agent')?.slice(0, 200)
        });
      }

      return {
        cookie: cookieHeader,
        cookieHeader,
        cookieNames: cookies.map(c => c.name),
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure
        })),
        user: userInfo,
        currentUser: userInfo,
        persisted: dbSaved,
        key: saveKey,
        note: dbSaved?.saved
          ? '✓ Cookie 已加密保存到数据库，下次启动自动恢复'
          : '保存 cookie 到 HDHIVE_COOKIE 环境变量或请求头，下次请求使用'
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  res.status(r.success ? 200 : 500).json(r);
});

// 直接读取当前 client 的 cookies（需要已登录）
app.get('/hdhive/cookies', async (req, res) => {
  const r = await withTimeout('cookies', async () => {
    if (!state.client) throw new Error('client not initialized');
    const page = state.client._page;
    if (!page) throw new Error('page not available');
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return {
      cookie: cookieHeader,
      cookieHeader,
      cookieNames: cookies.map(c => c.name),
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure
      }))
    };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 重启浏览器（清空登录态）
app.post('/browser/restart', async (req, res) => {
  const r = await withTimeout('browser/restart', async () => {
    if (state.client) {
      await state.client.close().catch(() => {});
      state.client = null;
      state.warmupOk = false;
    }
    clearReadCache();
    // 下次调用会重建
    return { restarted: true };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── Cookie 管理（数据库）───────────────────

// 列出所有保存的 cookie keys（不含明文）
app.get('/admin/cookies', async (req, res) => {
  const r = await withTimeout('admin/cookies/list', async () => {
    if (!dbState.initialized) {
      return { enabled: false, cookies: [], message: 'database not configured' };
    }
    const cookies = await listCookiesFromDb();
    return { enabled: true, cookies, count: cookies.length };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 删除指定 key 的 cookie
app.delete('/admin/cookies/:key', async (req, res) => {
  const r = await withTimeout('admin/cookies/delete', async () => {
    if (!dbState.initialized) throw new Error('database not configured');
    const deleted = await deleteCookieFromDb(req.params.key);
    return { deleted };
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 手动设置 cookie（不需要登录，直接写入数据库）
app.post('/admin/cookies/:key', async (req, res) => {
  const r = await withTimeout('admin/cookies/set', async () => {
    if (!dbState.initialized) throw new Error('database not configured');
    if (!config.encryptSecret) throw new Error('BRIDGE_STATE_SECRET or BRIDGE_TOKEN must be set');
    const { cookie } = req.body || {};
    if (!cookie) throw new Error('cookie is required in body');
    const result = await saveCookieToDb(req.params.key, cookie, {
      source: 'manual',
      ua: req.get('user-agent')?.slice(0, 200)
    });
    return result;
  });
  res.status(r.success ? 200 : 500).json(r);
});

// ─────────────────── ★ 一键解锁（核心接口）───────────────────

// TMDB ID 一键解锁：解析 → 找资源 → 解锁 → 拿网盘
// ⚠️ 此接口会消耗积分！未解锁的资源需要积分
app.post('/hdhive/unlock/tmdb/:tmdbId', async (req, res) => {
  const r = await withTimeout('unlock/tmdb', async () => {
    clearReadCache();
    const client = getClient(await getRequestCookieAsync(req));
    const type = req.body?.type || req.query.type || 'movie';
    return await client.unlockByTmdbId(Number(req.params.tmdbId), type);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// TMDB ID 只查询不解锁：列出资源 + 积分，但不扣积分
// ✅ 推荐先调用这个，确认后再决定是否解锁
app.post('/hdhive/preview/tmdb/:tmdbId', async (req, res) => {
  const r = await withTimeout('preview/tmdb', async () => {
    const cookie = await getRequestCookieAsync(req);
    const type = req.body?.type || req.query.type || 'movie';
    const tmdbId = Number(req.params.tmdbId);
    const cacheKey = makeReadCacheKey(['preview-tmdb', type, tmdbId], cookie);
    const cached = getReadCache(cacheKey);
    if (cached) return { ...cached, cache: { hit: true, ttlMs: config.readCacheTtlMs } };

    const client = getClient(cookie);

    // 解析 TMDB → 影巢内部 URL
    const resolved = await client.resolveTmdbToInternal(tmdbId, type);

    // 找资源列表
    const resources = await client.findResourcesFromMoviePage(resolved.url);

    // 对每个资源查需要的积分（优先 DOM，checkResource 兜底；不消耗）
    const enriched = [];
    for (const r of resources) {
      try {
        const info = await client.getResourceUnlockInfo(r);
        enriched.push({
          slug: r.slug,
          url: r.url,
          title: (r.title || r.text?.split('\n')[0] || '未命名资源').slice(0, 60),
          unlock_points: info.default_unlock_points ?? info.unlock_points ?? null,
          website: info.website,
          share_size: info.share_size ?? r.share_size ?? 0,
          is_free: info.is_free ?? r.is_free ?? false,
          source: info.source
        });
      } catch (e) {
        enriched.push({
          slug: r.slug,
          url: r.url,
          title: (r.title || r.text?.split('\n')[0] || '未命名资源').slice(0, 60),
          unlock_points: null,
          error: e.message.slice(0, 100)
        });
      }
    }

    // 当前用户积分
    let currentPoints = null;
    try {
      const user = await client.getCurrentUser();
      currentPoints = user.data?.data?.user_meta?.points;
    } catch {}

    const payload = {
      tmdbId,
      type,
      movieSlug: resolved.slug,
      movieUrl: resolved.url,
      currentPoints,
      resources: enriched,
      totalCost: enriched.reduce((sum, r) => sum + (r.unlock_points || 0), 0),
      cache: { hit: false, ttlMs: config.readCacheTtlMs }
    };
    setReadCache(cacheKey, payload);
    return payload;
  });
  res.status(r.success ? 200 : 500).json(r);
});

// Resource slug 一键解锁 + 拿网盘
app.post('/hdhive/unlock/resource/:slug', async (req, res) => {
  const r = await withTimeout('unlock/resource', async () => {
    clearReadCache();
    const client = getClient(await getRequestCookieAsync(req));
    return await client.unlockByResourceSlug(req.params.slug);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// Movie URL 一键解锁
app.post('/hdhive/unlock/share', async (req, res) => {
  const r = await withTimeout('unlock/share', async () => {
    clearReadCache();
    const client = getClient(await getRequestCookieAsync(req));
    const { url, movieId } = req.body || {};
    if (!url) throw new Error('url is required');
    return await client.unlockByShareUrl(url, movieId);
  });
  res.status(r.success ? 200 : 500).json(r);
});

// 单独提取 189 网盘链接（resource slug）
app.get('/hdhive/resource/:slug/cloud189', async (req, res) => {
  const r = await withTimeout('resource/cloud189', async () => {
    const client = getClient(await getRequestCookieAsync(req));
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

  // 初始化数据库（可选）
  if (config.databaseUrl) {
    const dbOk = await initDatabase();
    console.log(`[hdhive-api] DATABASE_URL=${dbOk ? 'connected' : 'FAILED'}`);
    if (dbOk && config.cookieKey) {
      // 启动时：如果 DB 没有 cookie 但 env 有，自动保存到 DB
      const existingDbCookie = await loadCookieFromDb(config.cookieKey);
      if (!existingDbCookie && config.defaultCookie) {
        const saved = await saveCookieToDb(config.cookieKey, config.defaultCookie, { source: 'env-on-startup' });
        console.log(`[hdhive-api] ✓ Cookie auto-saved to DB from env: ${saved.saved}`);
      } else if (existingDbCookie && !config.defaultCookie) {
        // 从数据库加载
        config.defaultCookie = existingDbCookie;
        console.log(`[hdhive-api] ✓ Loaded cookie from database (key=${config.cookieKey}, ${existingDbCookie.length} chars)`);
      } else {
        console.log(`[hdhive-api] cookie already in DB for key=${config.cookieKey}`);
      }
    }
  } else {
    console.log(`[hdhive-api] DATABASE_URL=EMPTY (cookie not persisted)`);
  }

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
