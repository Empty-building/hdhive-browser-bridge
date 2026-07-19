// server.mjs
// hdhive-api HTTP 服务：把 api-client.mjs 包装成 REST API
// 与 hdhive-browser-bridge 兼容，提供相同的 /hdhive/* 接口 + 新增 TMDB 一键解锁

import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { HdhiveClient, STEALTH_SCRIPT, RSC_INTERCEPTOR_SCRIPT, DISABLE_ANIMATION_SCRIPT } from './api-client.mjs';

const config = {
  port: Number(process.env.PORT || 10000),
  bridgeToken: String(process.env.BRIDGE_TOKEN || ''),
  defaultCookie: String(process.env.HDHIVE_COOKIE || ''),
  defaultUsername: String(process.env.HDHIVE_USERNAME || ''),
  defaultPassword: String(process.env.HDHIVE_PASSWORD || ''),
  baseUrl: String(process.env.HDHIVE_BASE_URL || 'https://hdhive.com'),
  userAgent: String(process.env.BROWSER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
  headless: process.env.BROWSER_HEADLESS !== 'false',
  // Playwright 代理（直连被 Cloudflare 拦时必需），例如 socks5://127.0.0.1:1080
  browserProxy: String(process.env.HDHIVE_PROXY || process.env.BROWSER_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || ''),
  // 接口超时（单个请求最长执行时间）
  actionTimeoutMs: Number(process.env.ACTION_TIMEOUT_MS || 180_000),
  // 是否启用自动 warmup
  autoWarmup: process.env.AUTO_WARMUP !== 'false',
  // cookie 不完整时，是否允许用 HDHIVE_USERNAME/HDHIVE_PASSWORD 自动登录
  autoLogin: process.env.AUTO_LOGIN !== 'false',
  // 只读查询短缓存 TTL，默认 60 秒；设为 0 可关闭
  readCacheTtlMs: Number(process.env.READ_CACHE_TTL_MS || process.env.MEDIA_RESOURCES_CACHE_TTL_MS || 60_000),
  captchaAiBaseUrl: String(process.env.CAPTCHA_AI_BASE_URL || ''),
  captchaAiApiKey: String(process.env.CAPTCHA_AI_API_KEY || ''),
  captchaAiModel: String(process.env.CAPTCHA_AI_MODEL || 'web2api/gemini-auto'),
  captchaSolver: String(process.env.CAPTCHA_SOLVER || '').toLowerCase(),
  // 数据库配置
  databaseUrl: String(process.env.DATABASE_URL || process.env.BRIDGE_STATE_DATABASE_URL || ''),
  databaseSsl: String(process.env.BRIDGE_STATE_DATABASE_SSL || ''),
  // 加密密钥（用于加密 cookie 存储）
  encryptSecret: String(process.env.BRIDGE_STATE_SECRET || process.env.BRIDGE_TOKEN || ''),
  // cookie key 前缀（区分不同 Bridge 实例）
  cookieKey: String(process.env.COOKIE_KEY || process.env.BRIDGE_STATE_KEY || 'default'),
  // 兼容旧 browser-bridge 的状态表 key
  legacyStateKey: String(process.env.BRIDGE_STATE_KEY || 'hdhive-default')
};

// 全局状态
const state = {
  startedAt: Date.now(),
  client: null,
  bindSecret: String(process.env.HDHIVE_BIND_SECRET || ''),
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
  const missingLoginCookies = getMissingLoginCookieNames(cookie);
  if (missingLoginCookies.length > 0) {
    throw new Error(`cookie is incomplete: missing ${missingLoginCookies.join(', ')}; re-login or set a full HDHIVE_COOKIE`);
  }
  const clientOptions = {
    baseUrl: config.baseUrl,
    cookie,
    headless: config.headless,
    userAgent: config.userAgent,
    proxy: config.browserProxy,
    bindSecret: process.env.HDHIVE_BIND_SECRET || state.bindSecret || '',
    captchaAiBaseUrl: config.captchaAiBaseUrl,
    captchaAiApiKey: config.captchaAiApiKey,
    captchaAiModel: config.captchaAiModel,
    captchaSolver: config.captchaSolver
  };
  if (!state.client) {
    state.client = new HdhiveClient(clientOptions);
  } else if (state.client.cookie !== cookie) {
    // 如果 cookie 变了，重建 client
    state.client.close().catch(() => {});
    state.client = new HdhiveClient(clientOptions);
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

// ─────────────────── in-flight 去重（同 key 并发只跑一次）───────────────────

const inflightRequests = new Map();

/**
 * 对同一 key 的并发请求去重：第一次 miss 时把慢路径 promise 存入 map，
 * 后续相同 key 的请求复用该 promise，避免重复走慢路径或并发踩踏。
 */
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

function resolveDatabaseSsl(databaseUrl, sslMode) {
  const mode = String(sslMode || '').trim().toLowerCase();
  if (['false', '0', 'off', 'disable'].includes(mode)) return false;
  if (mode === 'verify-full') return true;
  if (['true', '1', 'on', 'require', 'prefer', 'verify-ca'].includes(mode)) {
    return { rejectUnauthorized: false };
  }

  try {
    const url = new URL(databaseUrl);
    const urlSslMode = String(url.searchParams.get('sslmode') || '').trim().toLowerCase();
    if (['disable', 'false', '0', 'off'].includes(urlSslMode)) return false;
    if (urlSslMode === 'verify-full') return true;
    if (['require', 'prefer', 'verify-ca'].includes(urlSslMode)) {
      return { rejectUnauthorized: false };
    }
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return false;
  } catch {}

  return { rejectUnauthorized: false };
}

function normalizeDatabaseUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

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

function decodeLegacyStateValue(value) {
  const parsed = JSON.parse(String(value || '{}'));
  if (parsed.encoding === 'plain-json') {
    return JSON.parse(parsed.data || '{}');
  }
  if (parsed.encoding !== 'aes-256-gcm') {
    return parsed;
  }
  const key = getEncryptionKey(config.encryptSecret);
  if (!key) throw new Error('BRIDGE_STATE_SECRET or BRIDGE_TOKEN must be set for legacy state storage');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function getCookieNames(cookie) {
  return new Set(
    String(cookie || '')
      .split(';')
      .map(part => part.trim().split('=')[0])
      .filter(Boolean)
  );
}

const REQUIRED_LOGIN_COOKIE_NAMES = ['token', 'csrf_access_token', 'hdh_uid', 'hdh_sa_token'];

function getMissingLoginCookieNames(cookie) {
  const names = getCookieNames(cookie);
  return REQUIRED_LOGIN_COOKIE_NAMES.filter(name => !names.has(name));
}

function hasCompleteLoginCookie(cookie) {
  return Boolean(cookie) && getMissingLoginCookieNames(cookie).length === 0;
}

function summarizeCookie(cookie) {
  const names = [...getCookieNames(cookie)].sort();
  const missingLoginCookies = REQUIRED_LOGIN_COOKIE_NAMES.filter(name => !names.includes(name));
  return {
    decryptOk: true,
    cookieNames: names,
    cookieCount: names.length,
    score: scoreCookie(cookie),
    hasCompleteLoginCookie: missingLoginCookies.length === 0,
    missingLoginCookies
  };
}

function scoreCookie(cookie) {
  const names = getCookieNames(cookie);
  let score = 0;
  if (names.has('token')) score += 100;
  if (names.has('csrf_access_token')) score += 40;
  if (names.has('hdh_uid')) score += 40;
  if (names.has('refresh_token')) score += 20;
  if (names.has('hdh_sa_token')) score += 10;
  score += Math.min(10, names.size);
  return score;
}

function storageStateToCookieHeader(snapshot) {
  const cookies = Array.isArray(snapshot?.cookies) ? snapshot.cookies : [];
  if (cookies.length === 0) return '';

  let baseHost = '';
  try {
    baseHost = new URL(config.baseUrl).hostname;
  } catch {}

  return cookies
    .filter(cookie => {
      if (!cookie?.name || cookie.value === undefined || cookie.value === null) return false;
      if (!baseHost || !cookie.domain) return true;
      const domain = String(cookie.domain).replace(/^\./, '');
      return baseHost === domain || baseHost.endsWith(`.${domain}`);
    })
    .map(cookie => `${cookie.name}=${encodeURIComponent(String(cookie.value))}`)
    .join('; ');
}

function getLegacyStateKeyCandidates(key) {
  return [...new Set([
    config.legacyStateKey,
    process.env.BRIDGE_STATE_KEY,
    key,
    `hdhive-${key}`,
    'hdhive-default'
  ].filter(Boolean).map(String))];
}

async function initDatabase() {
  if (!config.databaseUrl) return false;
  if (dbState.initialized) return true;

  try {
    dbState.pool = new pg.Pool({
      connectionString: normalizeDatabaseUrl(config.databaseUrl),
      ssl: resolveDatabaseSsl(config.databaseUrl, config.databaseSsl),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
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

  const candidates = [];
  const cookieKeys = [...new Set([key, config.cookieKey, 'default'].filter(Boolean).map(String))];

  for (const cookieKey of cookieKeys) {
    try {
      const r = await dbState.pool.query(
        'SELECT cookie_encrypted, updated_at FROM hdhive_cookies WHERE key = $1',
        [cookieKey]
      );
      if (r.rows.length > 0) {
        const cookie = decryptCookie(r.rows[0].cookie_encrypted, config.encryptSecret);
        if (cookie) {
          candidates.push({
            source: 'hdhive_cookies',
            key: cookieKey,
            cookie,
            updatedAt: r.rows[0].updated_at
          });
        }
      }
    } catch (e) {
      console.error(`[hdhive-api] load cookie failed from hdhive_cookies key=${cookieKey}:`, e.message);
    }
  }

  for (const stateKey of getLegacyStateKeyCandidates(key)) {
    try {
      const r = await dbState.pool.query(
        'SELECT value, updated_at FROM browser_bridge_state WHERE key = $1',
        [stateKey]
      );
      if (r.rows.length > 0) {
        const snapshot = decodeLegacyStateValue(r.rows[0].value);
        const cookie = storageStateToCookieHeader(snapshot);
        if (cookie) {
          candidates.push({
            source: 'browser_bridge_state',
            key: stateKey,
            cookie,
            updatedAt: r.rows[0].updated_at
          });
        }
      }
    } catch (e) {
      if (e.code === '42P01') break;
      console.error(`[hdhive-api] load cookie failed from browser_bridge_state key=${stateKey}:`, e.message);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const scoreDelta = scoreCookie(b.cookie) - scoreCookie(a.cookie);
    if (scoreDelta !== 0) return scoreDelta;
    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  });

  const selected = candidates[0];
  const missingLoginCookies = getMissingLoginCookieNames(selected.cookie);
  console.log(`[hdhive-api] loaded cookie from ${selected.source} key=${selected.key} score=${scoreCookie(selected.cookie)}`);
  if (missingLoginCookies.length > 0) {
    console.warn(`[hdhive-api] stored cookie is incomplete; missing ${missingLoginCookies.join(', ')}`);
  }
  return selected.cookie;
}

async function getStoredCookieStatus() {
  if (!dbState.initialized) return { enabled: false };
  try {
    const rows = [];
    const current = await dbState.pool.query(
      'SELECT key, cookie_encrypted, meta, created_at, updated_at, length(cookie_encrypted) AS encrypted_len FROM hdhive_cookies ORDER BY updated_at DESC'
    );
    for (const row of current.rows) {
      let cookieStatus = { decryptOk: false };
      try {
        cookieStatus = summarizeCookie(decryptCookie(row.cookie_encrypted, config.encryptSecret));
      } catch (e) {
        cookieStatus = { decryptOk: false, error: e.message };
      }
      rows.push({
        source: 'hdhive_cookies',
        key: row.key,
        meta: row.meta,
        created_at: row.created_at,
        updated_at: row.updated_at,
        encrypted_len: Number(row.encrypted_len),
        hasCookie: true,
        ...cookieStatus
      });
    }

    try {
      const legacy = await dbState.pool.query(
        'SELECT key, value, updated_at, length(value) AS value_len FROM browser_bridge_state ORDER BY updated_at DESC'
      );
      for (const row of legacy.rows) {
        let cookieStatus = { decryptOk: false };
        try {
          cookieStatus = summarizeCookie(storageStateToCookieHeader(decodeLegacyStateValue(row.value)));
        } catch (e) {
          cookieStatus = { decryptOk: false, error: e.message };
        }
        rows.push({
          source: 'browser_bridge_state',
          key: row.key,
          updated_at: row.updated_at,
          encrypted_len: Number(row.value_len),
          hasCookie: true,
          ...cookieStatus
        });
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }

    return { enabled: true, cookies: rows, count: rows.length };
  } catch (e) {
    return { enabled: true, cookies: [], count: 0, error: e.message };
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
  const status = await getStoredCookieStatus();
  return status.cookies || [];
}

// ─────────────────── 全局串行队列（消除并发踩踏）───────────────────

let actionChain = Promise.resolve();

// 内部：原 withTimeout 逻辑（超时控制）
async function _withTimeout(actionName, fn) {
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

// 外层：串行化包装（保证单 page 操作串行执行）
async function withTimeout(actionName, fn) {
  const run = actionChain.then(() => _withTimeout(actionName, fn));
  // 队列不因单个任务失败而断裂
  actionChain = run.then(() => {}, () => {});
  return run;
}

// ─────────────────── 生命周期接口 ───────────────────

// 健康检查（无需 token）
app.get('/health', async (req, res) => {
  const ready = Boolean(state.client && state.warmupOk);
  res.status(200).json({
    success: true,
    ready,
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
        hasCompleteDefaultCookie: hasCompleteLoginCookie(config.defaultCookie),
        hasDefaultUsername: Boolean(config.defaultUsername),
        autoLogin: config.autoLogin,
        headless: config.headless,
        database: {
          enabled: Boolean(config.databaseUrl),
          initialized: dbState.initialized,
          cookieKey: config.cookieKey,
          legacyStateKey: config.legacyStateKey,
          hasEncryptionSecret: Boolean(config.encryptSecret)
        }
      }
    }
  });
});

// 预热：启动浏览器
app.post('/warmup', async (req, res) => {
  const r = await withTimeout('warmup', async () => {
    const startedAt = Date.now();
    const cookie = await getRequestCookieAsync(req);
    if (!cookie) throw new Error('no cookie');
    const client = getClient(cookie);
    if (!state.client._ready) {
      await client._ensureBrowser();
    }
    state.warmupAt = Date.now();
    state.warmupOk = true;
    return { warmed: true, elapsedMs: Date.now() - startedAt };
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
    const includeUserValue = req.body?.includeUser ?? req.query?.includeUser;
    const includeUser = !['false', '0', 'no'].includes(String(includeUserValue ?? '').toLowerCase());
    const autoVerifyValue = req.body?.autoVerify ?? req.query?.autoVerify;
    const autoVerify = ['true', '1', 'yes'].includes(String(autoVerifyValue ?? '').toLowerCase());
    const verificationAttemptsValue = req.body?.verificationAttempts ?? req.query?.verificationAttempts;
    const parsedVerificationAttempts = Number(verificationAttemptsValue);
    const verificationAttempts = Number.isFinite(parsedVerificationAttempts) && parsedVerificationAttempts > 0
      ? Math.min(5, Math.floor(parsedVerificationAttempts))
      : undefined;
    const verificationSolverValue = req.body?.verificationSolver ?? req.query?.verificationSolver;
    const verificationSolver = ['ai', 'auto', 'heuristic'].includes(String(verificationSolverValue || '').toLowerCase())
      ? String(verificationSolverValue).toLowerCase()
      : undefined;
    const result = await client.checkin({ includeUser, autoVerify, verificationAttempts, verificationSolver });
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
    const shareUrl = apiData.url || cloud189?.url || '';
    // 优先用 unlock API 的 access_code，页面抓取经常丢码
    const accessCode = apiData.access_code || apiData.accessCode || cloud189?.accessCode || '';
    const fullUrl = apiData.full_url
      || (shareUrl && accessCode ? `${shareUrl}（访问码：${accessCode}）` : shareUrl);

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

    // in-flight 去重：同一 cacheKey 并发只跑一次，共享结果
    return dedupe(cacheKey, async () => {
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
        // 搜索阶段只返回列表，不打开详情页抓 189 链接（否则会把单浏览器拖死）
        let link = r.media_url || r.link || '';
        let code = r.access_code || r.code || '';
        let isUnlocked = Boolean(r.is_unlocked || r.isUnlocked || link);

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

async function activateDefaultCookie(cookie) {
  if (!cookie || config.defaultCookie === cookie) return;
  config.defaultCookie = cookie;
  if (state.client && state.client.cookie !== cookie) {
    await state.client.close().catch(() => {});
    state.client = null;
    state.warmupOk = false;
    clearReadCache();
  }
}

async function performHdhiveLogin({
  username = config.defaultUsername,
  password = config.defaultPassword,
  saveKey = config.cookieKey,
  source = 'login',
  requestUserAgent = '',
  activate = true
} = {}) {
  if (!username || !password) {
    throw new Error('username and password are required');
  }

  const { chromium } = await import('playwright');
  const profileDir = path.join(os.tmpdir(), `hdhive-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const launchOptions = {
    headless: config.headless,
    viewport: { width: 1366, height: 768 },
    screen: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: config.userAgent,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--lang=zh-CN'
    ]
  };
  const proxyRaw = String(config.browserProxy || '').trim();
  if (proxyRaw) {
    launchOptions.proxy = { server: proxyRaw.replace(/^socks5h:/i, 'socks5:') };
  }

  const ctx = await chromium.launchPersistentContext(profileDir, launchOptions);

  try {
    await ctx.addInitScript(STEALTH_SCRIPT);
    await ctx.addInitScript(RSC_INTERCEPTOR_SCRIPT);
    await ctx.addInitScript(DISABLE_ANIMATION_SCRIPT);

    const page = await ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${config.baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);

    const usernameInput = page.locator('input[name="username"], input[type="email"], input[type="text"]').first();
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 30000 }).catch(() => undefined);
    if (await passwordInput.count().catch(() => 0) === 0) {
      throw new Error('login form not found');
    }

    await usernameInput.fill(username, { timeout: 15000 });
    await passwordInput.fill(password, { timeout: 15000 });
    const submit = page.locator('button[type="submit"], button:has-text("登录"), [role="button"]:has-text("登录")').first();
    if (await submit.count() > 0) await submit.click({ timeout: 15000 });
    else await passwordInput.press('Enter', { timeout: 15000 });

    const deadline = Date.now() + 45_000;
    let cookies = [];
    let missingLoginCookies = [...REQUIRED_LOGIN_COOKIE_NAMES];
    let lastPageText = '';
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      cookies = await ctx.cookies(config.baseUrl);
      const presentCookieNames = new Set(cookies.map(c => c.name));
      missingLoginCookies = REQUIRED_LOGIN_COOKIE_NAMES.filter(name => !presentCookieNames.has(name));
      if (missingLoginCookies.length === 0) break;
      lastPageText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      if (/验证码|二次验证|两步验证/.test(lastPageText)) break;
    }

    if (missingLoginCookies.length > 0) {
      const suffix = /验证码|二次验证|两步验证/.test(lastPageText)
        ? '，页面要求验证码/二次验证'
        : '，可能需要验证码/二次验证';
      throw new Error(`login failed: missing login cookies (${missingLoginCookies.join(', ')})${suffix}`);
    }

    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // 读取登录后写入的 bindSecret（握手 bind_token），跨浏览器会话必须带着
    let bindSecret = null;
    try {
      bindSecret = await page.evaluate(async () => {
        const readIdb = () => new Promise((resolve) => {
          try {
            const req = indexedDB.open('hdh-secure-bind', 1);
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
              try {
                const db = req.result;
                if (!db.objectStoreNames.contains('bind')) return resolve(null);
                const tx = db.transaction('bind', 'readonly');
                const getReq = tx.objectStore('bind').get('bindSecret');
                getReq.onsuccess = () => resolve(typeof getReq.result === 'string' ? getReq.result : null);
                getReq.onerror = () => resolve(null);
              } catch {
                resolve(null);
              }
            };
          } catch {
            resolve(null);
          }
        });
        const fromIdb = await readIdb();
        if (fromIdb) return fromIdb;
        try {
          return sessionStorage.getItem('hdh:secure-client:bind-secret');
        } catch {
          return null;
        }
      });
    } catch {}
    if (bindSecret) {
      state.bindSecret = bindSecret;
      try { fs.writeFileSync('/tmp/hdhive-bind-secret.txt', bindSecret); } catch {}
    }

    if (activate) {
      await activateDefaultCookie(cookieHeader);
      if (state.client && bindSecret) {
        try { await state.client.setBindSecret(bindSecret); } catch {}
      }
    }

    let userInfo = null;
    try {
      const hdhUid = await page.evaluate(() => {
        const m = document.cookie.match(/(?:^|;\s*)hdh_uid=([^;]+)/);
        return m ? m[1] : null;
      });
      userInfo = { hdh_uid: hdhUid };
    } catch {}

    let dbSaved = null;
    if (dbState.initialized) {
      dbSaved = await saveCookieToDb(saveKey, cookieHeader, {
        hdh_uid: userInfo?.hdh_uid,
        source,
        ua: String(requestUserAgent || '').slice(0, 200),
        bind_secret: bindSecret || undefined
      });
    }

    return {
      cookie: cookieHeader,
      cookieHeader,
      bindSecret,
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
      key: saveKey
    };
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function autoLoginFromEnv(reason) {
  if (!config.autoLogin || !config.defaultUsername || !config.defaultPassword) {
    return null;
  }
  console.log(`[hdhive-api] auto login from HDHIVE_USERNAME/HDHIVE_PASSWORD (${reason})...`);
  const result = await performHdhiveLogin({
    source: `auto-${reason}`,
    requestUserAgent: 'startup',
    activate: true
  });
  console.log(`[hdhive-api] auto login OK; cookies=${result.cookieNames.join(', ')} persisted=${Boolean(result.persisted?.saved)}`);
  return result;
}

// ─────────────────── 账号密码登录 ───────────────────

// 登录后获取 cookie 字符串（**会消耗一次登录请求**）
// ⚠️ 此接口会实际登录影巢账号，建议只在 cookie 过期时调用
app.post('/hdhive/login', async (req, res) => {
  const r = await withTimeout('login', async () => {
    const result = await performHdhiveLogin({
      username: req.body?.username || config.defaultUsername,
      password: req.body?.password || config.defaultPassword,
      saveKey: req.body?.key || config.cookieKey,
      source: 'login',
      requestUserAgent: req.get('user-agent') || '',
      activate: true
    });
    return {
      ...result,
      note: result.persisted?.saved
        ? '✓ Cookie 已加密保存到数据库，下次启动自动恢复'
        : '保存 cookie 到 HDHIVE_COOKIE 环境变量或请求头，下次请求使用'
    };
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
    // 立刻重建并预热，避免 health 一直 warming_up
    const cookie = await getRequestCookieAsync(req).catch(() => config.defaultCookie);
    if (cookie) {
      const client = getClient(cookie);
      await client._ensureBrowser();
      state.warmupAt = Date.now();
      state.warmupOk = true;
    }
    return { restarted: true, warmupOk: state.warmupOk };
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
    return await getStoredCookieStatus();
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

    // in-flight 去重：同一 cacheKey 并发只跑一次，共享结果
    return dedupe(cacheKey, async () => {
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
  console.log(`[hdhive-api] HDHIVE_USERNAME=${config.defaultUsername ? 'set' : 'EMPTY'} AUTO_LOGIN=${config.autoLogin ? 'true' : 'false'}`);

  // 初始化数据库（可选）
  let existingDbCookie = null;
  if (config.databaseUrl) {
    const dbOk = await initDatabase();
    console.log(`[hdhive-api] DATABASE_URL=${dbOk ? 'connected' : 'FAILED'}`);
    if (dbOk && config.cookieKey) {
      existingDbCookie = await loadCookieFromDb(config.cookieKey);

      if (hasCompleteLoginCookie(config.defaultCookie)) {
        if (!existingDbCookie || !hasCompleteLoginCookie(existingDbCookie)) {
          const saved = await saveCookieToDb(config.cookieKey, config.defaultCookie, { source: 'env-on-startup' });
          console.log(`[hdhive-api] ✓ Cookie auto-saved to DB from env: ${saved.saved}`);
        } else {
          console.log(`[hdhive-api] complete cookie already in DB for key=${config.cookieKey}`);
        }
      } else if (config.defaultCookie) {
        console.warn(`[hdhive-api] HDHIVE_COOKIE is incomplete; missing ${getMissingLoginCookieNames(config.defaultCookie).join(', ')}`);
      }

      if (!hasCompleteLoginCookie(config.defaultCookie) && hasCompleteLoginCookie(existingDbCookie)) {
        await activateDefaultCookie(existingDbCookie);
        console.log(`[hdhive-api] ✓ Loaded cookie from database (key=${config.cookieKey}, ${existingDbCookie.length} chars)`);
      } else if (!config.defaultCookie && !existingDbCookie) {
        console.log(`[hdhive-api] no cookie in DB for key=${config.cookieKey}`);
      }
    }
  } else {
    console.log(`[hdhive-api] DATABASE_URL=EMPTY (cookie not persisted)`);
  }

  if (!hasCompleteLoginCookie(config.defaultCookie) && config.defaultUsername && config.defaultPassword) {
    try {
      await autoLoginFromEnv('startup');
    } catch (e) {
      console.error('[hdhive-api] auto login failed:', e.message);
    }
  }

  if (config.autoWarmup && hasCompleteLoginCookie(config.defaultCookie)) {
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
  if (dbState.pool) await dbState.pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
