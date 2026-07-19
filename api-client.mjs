// hdhive-api-client.mjs
// 影巢 API 客户端（优化版）
// 优化点：(1) 复用浏览器 (2) 拦截 RSC payload 直接拿 cloud189 URL

import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEFAULT_BASE = 'https://hdhive.com';

// 影巢 2026-07 改版后 signedFetch 在模块 39154（旧 9110 已失效）
const SIGNED_FETCH_MODULE_IDS = [39154, 9110];

const REGISTER_AND_RUN = `
async ({ method, fullPath, body }) => {
  let webpackRequire = window.__hdhiveRequire;
  if (!webpackRequire) {
    const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
    chunk.push([['__hdhive_probe__'], {}, (req) => { webpackRequire = req; window.__hdhiveRequire = req; }]);
  }
  if (!webpackRequire) throw new Error('webpack require not found');

  const moduleIds = [39154, 9110];
  let mod = null;
  let loadedId = null;
  for (const id of moduleIds) {
    if (!webpackRequire.m[String(id)] && !webpackRequire.m[id]) {
      try { await webpackRequire.e(id); } catch (e) {}
    }
    try {
      const candidate = webpackRequire(id);
      if (candidate && typeof candidate.t5 === 'function') {
        mod = candidate;
        loadedId = id;
        break;
      }
    } catch (e) {}
  }
  if (!mod) throw new Error('signedFetch module not loaded (tried 39154/9110)');

  if (typeof mod.P$ === 'function' && !window.__hdhiveHookRegistered) {
    mod.P$({
      getUserId: () => {
        const m = document.cookie.match(/(?:^|;\\s*)hdh_uid=([^;]+)/);
        if (m && /^[1-9]\\d*$/.test(m[1])) return m[1];
        const tk = document.cookie.match(/(?:^|;\\s*)token=([^;]+)/);
        if (tk) {
          try {
            const payload = JSON.parse(atob(decodeURIComponent(tk[1]).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            if (typeof payload.user_id === 'number') return String(payload.user_id);
            if (typeof payload.sub === 'number') return String(payload.sub);
          } catch {}
        }
        return '0';
      }
    });
    window.__hdhiveHookRegistered = true;
  }
  if (!mod.t5) throw new Error('signedFetch not found');
  const init = {
    method: String(method || 'GET').toUpperCase(),
    credentials: 'include',
    headers: {}
  };
  if (body !== null && body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await mod.t5(fullPath, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data, moduleId: loadedId };
}
`;

/**
 * 完整 stealth 脚本（对抗影巢 layout 反无头评分，阈值 score>=80 会锁死页面）
 */
const STEALTH_SCRIPT = `
(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  } catch {}
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch {}

  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

  const pluginData = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
  ];
  const plugins = {
    length: pluginData.length,
    item: (i) => pluginData[i] || null,
    namedItem: (n) => pluginData.find((p) => p.name === n) || null,
    refresh() {},
    [Symbol.iterator]: function* () { for (const p of pluginData) yield p; }
  };
  pluginData.forEach((p, i) => { plugins[i] = p; });
  Object.defineProperty(navigator, 'plugins', { get: () => plugins, configurable: true });

  const mimeTypes = {
    length: 2,
    0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    1: { type: 'text/pdf', suffixes: 'pdf', description: '' },
    item: (i) => mimeTypes[i] || null,
    namedItem: () => null,
    [Symbol.iterator]: function* () { yield mimeTypes[0]; yield mimeTypes[1]; }
  };
  Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeTypes, configurable: true });
  Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });

  window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false }, csi: () => ({}), loadTimes: () => ({}) };

  const brands = [
    { brand: 'Google Chrome', version: '131' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Not_A Brand', version: '24' }
  ];
  const userAgentData = {
    brands,
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: async () => ({
      brands,
      fullVersionList: [
        { brand: 'Google Chrome', version: '131.0.6778.33' },
        { brand: 'Chromium', version: '131.0.6778.33' },
        { brand: 'Not_A Brand', version: '10.0.2.3' }
      ],
      mobile: false,
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      uaFullVersion: '131.0.6778.33',
      wow64: false
    }),
    toJSON: () => ({ brands, mobile: false, platform: 'Windows' })
  };
  try {
    Object.defineProperty(navigator, 'userAgentData', { get: () => userAgentData, configurable: true });
  } catch {}

  const patchWebGL = (prototype) => {
    if (!prototype?.getParameter) return;
    const orig = prototype.getParameter;
    Object.defineProperty(prototype, 'getParameter', {
      value(parameter) {
        if (parameter === 37445) return 'Google Inc. (Intel)';
        if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return orig.call(this, parameter);
      }, configurable: true
    });
  };
  patchWebGL(window.WebGLRenderingContext?.prototype);
  patchWebGL(window.WebGL2RenderingContext?.prototype);

  for (const key of ['__playwright__binding__', '__pwInitScripts', '__puppeteer_evaluation_script__']) {
    try { delete window[key]; } catch {}
    try {
      Object.defineProperty(window, key, { get: () => undefined, set: () => undefined, configurable: true });
    } catch {}
  }

  try {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth || 1366, configurable: true });
    Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 768) + 85, configurable: true });
  } catch {}

  try {
    if (navigator.permissions?.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params) => {
        if (params && (params.name === 'notifications' || params.name === 'push')) {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery(params).catch(() => ({ state: 'prompt', onchange: null }));
      };
    }
  } catch {}
  try {
    Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
  } catch {}
})();
`;

function resolveBrowserProxy(explicitProxy) {
  const raw = String(
    explicitProxy
    || process.env.HDHIVE_PROXY
    || process.env.BROWSER_PROXY
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.ALL_PROXY
    || ''
  ).trim();
  if (!raw) return undefined;
  // Playwright 要 socks5://host:port，允许传入 socks5h://
  const server = raw.replace(/^socks5h:/i, 'socks5:');
  return { server };
}

function buildLaunchOptions({ headless = true, userAgent, proxy } = {}) {
  const options = {
    headless,
    viewport: { width: 1366, height: 768 },
    screen: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--headless=old',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--use-gl=disabled',
      '--disable-software-rasterizer',
      '--disable-features=Vulkan,UseSkiaRenderer,DefaultANGLE,PaintHolding',
      '--window-size=1366,768',
      '--lang=zh-CN'
    ]
  };
  const resolvedProxy = resolveBrowserProxy(proxy);
  if (resolvedProxy) options.proxy = resolvedProxy;
  return options;
}

function parseCookieHeader(cookieHeader, baseUrl = DEFAULT_BASE) {
  const host = String(baseUrl || DEFAULT_BASE).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return String(cookieHeader || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      let value = pair.slice(idx + 1).trim();
      try { value = decodeURIComponent(value); } catch {}
      return {
        name,
        value,
        domain: host,
        path: '/',
        httpOnly: ['hdh_sa_token', 'token', 'refresh_token', 'csrf_access_token'].includes(name),
        secure: true,
        sameSite: 'Lax'
      };
    })
    .filter((c) => c.name);
}

/**
 * 拦截 RSC payload 的 init script（修复版：支持已有 __next_f）
 */
const RSC_INTERCEPTOR_SCRIPT = `
(() => {
  window.__rscCaptured = [];
  const wrap = (arr) => {
    if (!arr || arr.__wrapped) return;
    arr.__wrapped = true;
    const origPush = Array.prototype.push.bind(arr);
    arr.push = function(...args) {
      for (const arg of args) {
        if (typeof arg === 'object' && Array.isArray(arg) && arg[1] && typeof arg[1] === 'string') {
          window.__rscCaptured.push(arg[1]);
        }
      }
      return origPush(...args);
    };
  };
  // 1. wrap 当前已有的 __next_f
  let rsc = window.__next_f;
  if (rsc) wrap(rsc);
  // 2. 拦截后续 set
  try {
    Object.defineProperty(window, '__next_f', {
      configurable: true,
      get() { return rsc; },
      set(v) { rsc = v; wrap(v); }
    });
  } catch (e) {}
  // 3. 暴露工具函数用于 runtime install
  window.__installRscCapture = function() {
    if (window.__next_f && !window.__next_f.__wrapped) wrap(window.__next_f);
    window.__rscCaptured = window.__rscCaptured || [];
  };
})();
`;

// 导出 stealth 脚本供 server.mjs 复用
export { STEALTH_SCRIPT, RSC_INTERCEPTOR_SCRIPT };

function readNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function getResponseMessage(response) {
  const data = response?.data;
  if (typeof data === 'string') return data;
  const message = data?.message || data?.error || data?.msg || '';
  const description = data?.description || '';
  if (description && /签到失败|操作失败|失败|failed/i.test(String(message))) return description;
  return message || description;
}

function isAlreadyCheckedInMessage(message) {
  return /已签到|已经签到|今日已|重复签到|already\s*(checked\s*in|check.?in)|checked\s*in/i.test(String(message || ''));
}

function isVerificationRequiredMessage(message) {
  return /验证码|验证|captcha|verification/i.test(String(message || ''));
}

function isMissingResponseSignatureMessage(message) {
  return /X-HDH-RSig|RSig|响应携带.*签名头|未收到.*签名头|Missing X-HDH-RSig/i.test(String(message || ''));
}

function getCheckinChallenge(response) {
  const data = response?.data?.data;
  if (!data || typeof data !== 'object') return null;
  if (!data.challenge_ticket && !data.challenge_type && !data.captcha_mode) return null;
  return {
    ticket: data.challenge_ticket || null,
    type: data.challenge_type || null,
    captchaMode: data.captcha_mode || null,
    action: data.challenge_action || null,
    reason: data.challenge_reason || null,
    expiresInSeconds: readNumber(data.expires_in_seconds)
  };
}

function getCurrentUserPoints(response) {
  const data = response?.data?.data || response?.data || {};
  return readNumber(
    data?.user_meta?.points,
    data?.userMeta?.points,
    data?.points,
    data?.user?.user_meta?.points,
    data?.user?.points
  );
}

function parseSpaceCaptchaPrompt(prompt) {
  const text = String(prompt || '');
  const colorRules = [
    ['orange', /橙|橘|orange/i],
    ['yellow', /黄|yellow/i],
    ['green', /绿|green/i],
    ['blue', /蓝|青|blue|cyan/i],
    ['purple', /紫|purple/i],
    ['pink', /粉|pink/i],
    ['red', /红|red/i]
  ];
  const color = colorRules.find(([, pattern]) => pattern.test(text))?.[0] || null;
  const size = /小|较小|小体积|small/i.test(text)
    ? 'small'
    : (/大|较大|大体积|large/i.test(text) ? 'large' : null);
  return { text, color, size };
}

function getSpaceCaptchaPayload(response) {
  const data = response?.data?.data || response?.data || {};
  return {
    token: data?.token || null,
    mode: data?.mode || null,
    backgroundImage: data?.background_image || data?.backgroundImage || null,
    imageWidth: readNumber(data?.image_width, data?.imageWidth, data?.bg_image_width),
    imageHeight: readNumber(data?.image_height, data?.imageHeight, data?.bg_image_height),
    prompt: data?.click_prompt || data?.prompt || data?.tip || data?.message || ''
  };
}

function isCaptchaVerifySuccess(response) {
  const body = response?.data;
  const data = body?.data;
  if (data && typeof data === 'object' && 'success' in data) {
    return data.success === true;
  }
  return body?.success === true && !body?.error_code;
}

function getCaptchaVerifyMessage(response) {
  const body = response?.data;
  return body?.data?.message || body?.message || body?.description || body?.error || '';
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function parseJsonObjectFromText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {}

  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch {}
  }

  const objectText = value.match(/\{[\s\S]*\}/)?.[0];
  if (objectText) {
    try {
      return JSON.parse(objectText);
    } catch {}
  }
  return null;
}

function sanitizeCaptchaVerification(verification) {
  if (!verification || typeof verification !== 'object') return verification;
  return {
    ...verification,
    attempts: Array.isArray(verification.attempts)
      ? verification.attempts.map((attempt) => {
        const verifyData = attempt.verifyData && typeof attempt.verifyData === 'object'
          ? {
            ...attempt.verifyData,
            verifyTokenReceived: Boolean(attempt.verifyData.verify_token)
          }
          : attempt.verifyData;
        if (verifyData && typeof verifyData === 'object') {
          delete verifyData.verify_token;
        }
        const sanitized = { ...attempt, verifyData };
        delete sanitized.verifyToken;
        return sanitized;
      })
      : verification.attempts
  };
}

function normalizeCheckinResult(response) {
  const message = getResponseMessage(response);
  const description = response?.data?.description || response?.data?.data?.description || '';
  const alreadyCheckedIn = isAlreadyCheckedInMessage(`${message} ${description}`);
  const challenge = getCheckinChallenge(response);
  const requiresVerification = Boolean(challenge) || isVerificationRequiredMessage(message);
  const body = response?.data;
  const bodyFailed = Boolean(body && typeof body === 'object' && body.success === false);
  const checkedIn = Boolean(response?.ok) && !bodyFailed && !alreadyCheckedIn;

  return {
    success: checkedIn || alreadyCheckedIn,
    checkedIn,
    alreadyCheckedIn,
    requiresVerification,
    challenge,
    challengeTicket: challenge?.ticket || null,
    challengeType: challenge?.type || null,
    captchaMode: challenge?.captchaMode || null,
    message
  };
}

export class HdhiveClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
    this.cookie = options.cookie || '';
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.headless = options.headless !== false;
    this.proxy = options.proxy || process.env.HDHIVE_PROXY || process.env.BROWSER_PROXY || '';
    this.storageStatePath = options.storageStatePath || process.env.HDHIVE_STORAGE_STATE || '';
    this.bindSecret = options.bindSecret || process.env.HDHIVE_BIND_SECRET || '';
    this._context = null;
    this._page = null;
    this._ready = false;
    this._hookRegistered = false;
    this._pageNeedsMovieReload = false;
    this._ensuring = null; // 单飞：正在进行的 _ensureBrowser promise
    this.captchaAiBaseUrl = String(options.captchaAiBaseUrl || process.env.CAPTCHA_AI_BASE_URL || '').replace(/\/$/, '');
    this.captchaAiApiKey = String(options.captchaAiApiKey || process.env.CAPTCHA_AI_API_KEY || '');
    this.captchaAiModel = String(options.captchaAiModel || process.env.CAPTCHA_AI_MODEL || 'web2api/gemini-auto');
    this.captchaSolver = String(options.captchaSolver || process.env.CAPTCHA_SOLVER || '').toLowerCase();
  }

  /**
   * 写入 bindSecret 到浏览器 IndexedDB/sessionStorage。
   * 影巢 2026-07 起握手必须携带 bind_token，否则 customer API 会 session_user_mismatch。
   */
  async setBindSecret(bindSecret) {
    this.bindSecret = String(bindSecret || '').trim();
    if (!this.bindSecret) return false;
    await this._ensureBrowser();
    return await this._seedBindSecret(this.bindSecret);
  }

  async _seedBindSecret(bindSecret) {
    const secret = String(bindSecret || this.bindSecret || '').trim();
    if (!secret || !this._page) return false;
    return await this._page.evaluate(async (value) => {
      const BIND_DB = 'hdh-secure-bind';
      const BIND_STORE = 'bind';
      const BIND_KEY = 'bindSecret';
      const SS_KEY = 'hdh:secure-client:bind-secret';
      const openDb = () => new Promise((resolve, reject) => {
        const req = indexedDB.open(BIND_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(BIND_STORE)) db.createObjectStore(BIND_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('idb open failed'));
      });
      let wroteIdb = false;
      try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(BIND_STORE, 'readwrite');
          tx.objectStore(BIND_STORE).put(value, BIND_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('idb write failed'));
        });
        db.close();
        wroteIdb = true;
      } catch {}
      try { sessionStorage.setItem(SS_KEY, value); } catch {}
      // 清掉旧 session，强制下次 t5 用新 bind_token 重新握手
      try {
        const openClient = () => new Promise((resolve, reject) => {
          const req = indexedDB.open('hdh-secure-client', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('secureClient')) db.createObjectStore('secureClient');
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error('idb open failed'));
        });
        const db = await openClient();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('secureClient', 'readwrite');
          tx.objectStore('secureClient').delete('session');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('idb delete failed'));
        });
        db.close();
      } catch {}
      try { sessionStorage.removeItem('hdh:secure-client:session'); } catch {}
      // 若模块已加载，优先走官方 GT(bindSecret)
      try {
        let req;
        const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
        chunk.push([[`__hdhive_bind_${Date.now()}`], {}, (r) => { req = r; }]);
        if (req) {
          let mod = null;
          for (const id of [39154, 9110]) {
            try {
              const candidate = req(id);
              if (candidate?.GT || candidate?.t5) { mod = candidate; break; }
            } catch {}
          }
          if (mod?.GT) await mod.GT(value);
        }
      } catch {}
      return wroteIdb || true;
    }, secret);
  }

  /**
   * 创建一个持久化浏览器实例（注入 cookie）
   * 单飞保护：并发调用只 launch 一次，共享同一 promise
   */
  async _ensureBrowser({ injectCookie = true, initialUrl = this.baseUrl } = {}) {
    // 健康检查：如果 page 已崩溃，清空状态强制重建
    if (this._page && this._page.isClosed()) {
      this._ready = false;
      this._page = null;
    }
    // 已就绪且 page 健康，直接返回
    if (this._ready && this._page) return;

    // 单飞：如果正在启动，复用进行中的 promise
    if (this._ensuring) return this._ensuring;

    this._ensuring = (async () => {
      const profileDir = path.join(os.tmpdir(), `hdhive-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(profileDir, { recursive: true });
      const launchOptions = buildLaunchOptions({
        headless: this.headless,
        userAgent: this.userAgent,
        proxy: this.proxy
      });
      // storageState 只能给 browser.newContext，不能给 launchPersistentContext；
      // 持久化 profile 场景下用 addCookies + 页面内 bind 恢复。
      this._context = await chromium.launchPersistentContext(profileDir, launchOptions);
      await this._context.addInitScript(STEALTH_SCRIPT);
      await this._context.addInitScript(RSC_INTERCEPTOR_SCRIPT);

      // 拦截图片、广告等无关资源加速加载
      await this._context.route('**/*', (route) => {
        const url = route.request().url();
        const type = route.request().resourceType();
        if (['image', 'font', 'media'].includes(type)) {
          return route.abort();
        }
        // 拦截 umami 统计
        if (url.includes('umami.hdhive.com')) return route.abort();
        // 阻止页面无用 prefetch/rsc 请求（减少 CPU/网络空转）
        if (url.includes('_rsc=') || url.includes('next-router-prefetch') || url.includes('next-router-segment-prefetch')) {
          return route.abort();
        }
        return route.continue();
      });

      if (injectCookie && this.cookie) {
        const cookies = parseCookieHeader(this.cookie, this.baseUrl);
        try { await this._context.addCookies(cookies); } catch (e) {}
      }

      this._page = await this._context.pages()[0] || await this._context.newPage();
      const targetUrl = initialUrl || this.baseUrl;
      await this._page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._page.waitForFunction(
        () => document.readyState !== 'loading',
        { timeout: 5000 }
      ).catch(() => undefined);
      // 等 webpack runtime 就绪，并尽量触发安全模块初始化
      await this._page.waitForFunction(
        () => Boolean(window.webpackChunk_N_E && typeof window.webpackChunk_N_E.push === 'function'),
        { timeout: 15000 }
      ).catch(() => undefined);
      if (this.bindSecret) {
        await this._seedBindSecret(this.bindSecret).catch(() => false);
      }
      this._ready = true;
    })();

    try {
      await this._ensuring;
    } finally {
      this._ensuring = null;
    }
  }

  async _reloadPage() {
    if (!this._page) return;
    try {
      await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      await this._page.waitForTimeout(2000);
      this._hookRegistered = false;
    } catch (e) {}
  }

  async _ensureHdhiveRuntime() {
    await this._ensureBrowser({ initialUrl: this.baseUrl });
    if (!this._page.url().startsWith(this.baseUrl)) {
      await this._page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    const ready = await this._page.waitForFunction(
      () => Boolean(window.webpackChunk_N_E && typeof window.webpackChunk_N_E.push === 'function'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!ready) {
      await this._page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await this._page.waitForFunction(
        () => Boolean(window.webpackChunk_N_E && typeof window.webpackChunk_N_E.push === 'function'),
        { timeout: 10000 }
      ).catch(() => undefined);
    }
  }

  async _waitForMoviePageReady(timeoutMs = 12000) {
    const start = Date.now();
    let lastLength = 0;
    let stableCount = 0;
    while (Date.now() - start < timeoutMs) {
      const state = await this._page.evaluate(() => {
        const text = document.body?.innerText || '';
        const hasResource = Boolean(document.querySelector('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]'));
        return {
          length: text.length,
          loading: text.includes('LOADING'),
          hasResource
        };
      }).catch(() => ({ length: 0, loading: true, hasResource: false }));

      if (state.hasResource) return true;
      if (!state.loading && state.length > 100) {
        if (Math.abs(state.length - lastLength) < 20) stableCount += 1;
        else stableCount = 0;
        if (stableCount >= 2) return true;
      }
      lastLength = state.length;
      await this._page.waitForTimeout(250);
    }
    return false;
  }

  async call(method, path, { query, body } = {}) {
    await this._ensureHdhiveRuntime();
    let fullPath = path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const q = qs.toString();
      if (q) fullPath += (path.includes('?') ? '&' : '?') + q;
    }

    const request = {
      method,
      fullPath,
      body: body == null ? null : body,
      targetPathname: (() => {
        try {
          return new URL(fullPath, this.baseUrl).pathname;
        } catch {
          return path.split('?')[0];
        }
      })()
    };
    const allowUnsignedResponseFallback = String(path).startsWith('/api/customer/');
    if (this.bindSecret) {
      await this._seedBindSecret(this.bindSecret).catch(() => false);
    }
    let result = await this._runSignedCallWithCapture(request);

    if (result.ok) {
      return result.response;
    }

    let message = result.error?.message || String(result.error || 'signed fetch failed');
    if (allowUnsignedResponseFallback && isMissingResponseSignatureMessage(message)) {
      const fallback = this._getUnsignedResponseFallback(result);
      if (fallback) return fallback;
    }

    // 影巢 bind_token 会话漂移：重新写入 bindSecret 后重试一次
    if (this.bindSecret && /session_user_mismatch|session_recovery_failed|invalid_session|missing_signature|signature_invalid|请重新登录/i.test(message || '')) {
      await this._seedBindSecret(this.bindSecret).catch(() => false);
      await this._page?.evaluate(() => {
        window.__hdhiveHookRegistered = false;
        window.__hdhiveRequire = null;
      }).catch(() => undefined);
      result = await this._runSignedCallWithCapture(request);
      if (result.ok) return result.response;
      message = result.error?.message || String(result.error || 'signed fetch failed');
    }

    if (/WASM|wasm|SignedFetchError|加载失败/i.test(message || '')) {
      await this._reloadPage();
      if (this.bindSecret) {
        await this._seedBindSecret(this.bindSecret).catch(() => false);
      }
      result = await this._runSignedCallWithCapture(request);
      if (result.ok) return result.response;

      message = result.error?.message || String(result.error || 'signed fetch failed');
      if (allowUnsignedResponseFallback && isMissingResponseSignatureMessage(message)) {
        const fallback = this._getUnsignedResponseFallback(result);
        if (fallback) return fallback;
      }
    }

    const error = new Error(message);
    error.name = result.error?.name || 'SignedFetchError';
    error.details = result.error;
    throw error;
  }

  async _runSignedCallWithCapture(request) {
    return await this._page.evaluate(async ({ registerAndRunSource, request }) => {
      const capturedFetchResponses = [];
      const parseMaybeJson = (value) => {
        if (!value) return null;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
      const pickHeaders = (headers, names) => {
        const picked = {};
        for (const name of names) {
          const value = headers?.get?.(name);
          if (value) picked[name] = value;
        }
        return picked;
      };
      const matchesTargetUrl = (value) => {
        let url;
        try {
          url = new URL(value?.url || value || '', location.origin);
        } catch {
          return false;
        }
        const target = request.targetPathname || request.fullPath;
        return url.origin === location.origin && (
          url.pathname === target
          || url.pathname === `${target}/`
        );
      };

      const originalFetch = window.fetch?.bind(window);
      if (originalFetch) {
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (matchesTargetUrl(response.url || args[0])) {
            const text = await response.clone().text().catch(() => '');
            capturedFetchResponses.push({
              url: response.url || String(args[0] || ''),
              status: response.status,
              ok: response.ok,
              headers: pickHeaders(response.headers, ['content-type', 'x-hdh-rsig', 'x-hdh-rts']),
              body: parseMaybeJson(text)
            });
          }
          return response;
        };
      }

      try {
        const registerAndRun = eval(`(${registerAndRunSource})`);
        const response = await registerAndRun({
          method: request.method,
          fullPath: request.fullPath,
          body: request.body
        });
        return { ok: true, response, capturedFetchResponses };
      } catch (error) {
        return {
          ok: false,
          error: {
            name: error?.name || '',
            code: error?.code || '',
            httpStatus: error?.httpStatus || error?.status || 0,
            message: error?.message || error?.description || String(error),
            responseStatus: error?.response?.status || 0,
            responseData: error?.response?.data ?? null
          },
          capturedFetchResponses
        };
      } finally {
        if (originalFetch) {
          window.fetch = originalFetch;
        }
      }
    }, { registerAndRunSource: REGISTER_AND_RUN, request });
  }

  _getUnsignedResponseFallback(result) {
    const observed = [...(result?.capturedFetchResponses || [])]
      .reverse()
      .find(response => response?.ok && response.body !== undefined);
    const responseDataFallback = result?.error?.responseData !== undefined && result?.error?.responseData !== null
      ? {
          status: result.error.responseStatus || 0,
          ok: !result.error.responseStatus || Number(result.error.responseStatus) < 400,
          body: result.error.responseData
        }
      : null;
    const fallback = observed || responseDataFallback;
    if (!fallback?.ok || fallback.body === undefined) return null;
    return {
      status: fallback.status || 200,
      ok: true,
      data: fallback.body ?? { success: true, message: 'request completed but response body was empty' },
      warning: 'missing X-HDH-RSig; used captured same-origin response body'
    };
  }

  async _browserFetchJson(path, { method = 'GET', body, query } = {}) {
    await this._ensureBrowser();
    let url = /^https?:\/\//i.test(path)
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) qs.set(key, String(value));
      }
      const suffix = qs.toString();
      if (suffix) url += (url.includes('?') ? '&' : '?') + suffix;
    }

    return this._page.evaluate(async ({ url, method, body }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const init = {
        method: String(method || 'GET').toUpperCase(),
        credentials: 'include',
        headers: {},
        signal: controller.signal
      };
      if (body !== undefined && body !== null) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
      try {
        const res = await fetch(url, init);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, ok: res.ok, data };
      } finally {
        clearTimeout(timeout);
      }
    }, { url, method, body: body == null ? null : body });
  }

  async _locateSpaceCaptchaTarget(captcha) {
    const prompt = parseSpaceCaptchaPrompt(captcha.prompt);
    if (!captcha.backgroundImage) {
      throw new Error('captcha background image is missing');
    }

    const result = await this._page.evaluate(async ({ image, prompt }) => {
      const colorMatchers = [
        { name: 'purple', patterns: [/purple/i, /紫/] },
        { name: 'cyan', patterns: [/cyan/i, /青/] },
        { name: 'orange', patterns: [/orange/i, /橙|橘/] },
        { name: 'yellow', patterns: [/yellow/i, /黄/] },
        { name: 'green', patterns: [/green/i, /绿/] },
        { name: 'blue', patterns: [/blue/i, /蓝/] },
        { name: 'gray', patterns: [/gr[ae]y/i, /灰/] },
        { name: 'pink', patterns: [/pink/i, /粉/] },
        { name: 'red', patterns: [/red/i, /红/] },
        { name: 'black', patterns: [/black/i, /黑/] },
        { name: 'white', patterns: [/white/i, /白/] }
      ];
      const shapeMatchers = [
        { name: 'sphere', patterns: [/sphere/i, /球|球体|圆球/] },
        { name: 'cube', patterns: [/cube|box/i, /立方|方块|盒/] },
        { name: 'cylinder', patterns: [/cylinder/i, /圆柱/] },
        { name: 'cone', patterns: [/cone/i, /圆锥/] },
        { name: 'pyramid', patterns: [/pyramid/i, /金字塔|棱锥/] }
      ];

      const img = new Image();
      img.decoding = 'async';
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('captcha image decode failed'));
      });
      img.src = image;
      await loaded;

      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const total = width * height;

      function getPixel(index) {
        const offset = index * 4;
        return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
      }

      function luminance(r, g, b) {
        return 0.299 * r + 0.587 * g + 0.114 * b;
      }

      function rgbToHsv(r, g, b) {
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const delta = max - min;
        let h = 0;
        if (delta !== 0) {
          if (max === rn) h = ((gn - bn) / delta) % 6;
          else if (max === gn) h = (bn - rn) / delta + 2;
          else h = (rn - gn) / delta + 4;
          h *= 60;
          if (h < 0) h += 360;
        }
        return {
          h,
          s: max === 0 ? 0 : delta / max,
          v: max
        };
      }

      function hueBetween(h, min, max) {
        return min <= max ? h >= min && h <= max : h >= min || h <= max;
      }

      const borderSamples = [];
      for (let x = 0; x < width; x += 8) {
        borderSamples.push(getPixel(x));
        borderSamples.push(getPixel((height - 1) * width + x));
      }
      for (let y = 0; y < height; y += 8) {
        borderSamples.push(getPixel(y * width));
        borderSamples.push(getPixel(y * width + width - 1));
      }
      const background = borderSamples.reduce((acc, pixel) => {
        acc.r += pixel[0];
        acc.g += pixel[1];
        acc.b += pixel[2];
        return acc;
      }, { r: 0, g: 0, b: 0 });
      background.r /= borderSamples.length || 1;
      background.g /= borderSamples.length || 1;
      background.b /= borderSamples.length || 1;
      background.lum = luminance(background.r, background.g, background.b);

      function colorDistanceFromBackground(r, g, b) {
        return Math.hypot(r - background.r, g - background.g, b - background.b);
      }

      function matchesColor(color, r, g, b) {
        const { h, s, v } = rgbToHsv(r, g, b);
        const lum = luminance(r, g, b);
        const bgDistance = colorDistanceFromBackground(r, g, b);
        if (!color) return (s > 0.36 && v > 0.22) || bgDistance > 30;

        switch (color) {
          case 'red':
            return s > 0.20 && v > 0.16 && ((hueBetween(h, 342, 18) && r > g * 1.12 && r > b * 1.08)
              || (r > 130 && r > g * 1.35 && r > b * 1.25));
          case 'orange':
            return s > 0.22 && v > 0.18 && hueBetween(h, 16, 42) && r > 115 && g > 50 && r > b * 1.35;
          case 'yellow':
            return s > 0.18 && v > 0.25 && hueBetween(h, 38, 78) && r > 110 && g > 90 && b < 190;
          case 'green':
            return s > 0.20 && v > 0.16 && hueBetween(h, 78, 168) && g > 70 && g > b * 1.02;
          case 'blue':
            return s > 0.20 && v > 0.16 && hueBetween(h, 198, 252) && b > 65 && b > r * 1.05;
          case 'cyan':
            return s > 0.18 && v > 0.18 && hueBetween(h, 168, 202) && g > 80 && b > 80 && r < Math.max(g, b) * 0.88;
          case 'purple':
            return s > 0.18 && v > 0.16 && hueBetween(h, 254, 326) && b > 60 && r > 50;
          case 'gray':
            return s < 0.24 && bgDistance > 18 && lum > 45 && lum < 235 && Math.abs(r - g) < 36 && Math.abs(g - b) < 36;
          case 'pink':
            return s > 0.18 && v > 0.20 && (hueBetween(h, 318, 350) || hueBetween(h, 0, 10)) && r > 120 && b > 70;
          case 'black':
            return v < 0.24 && bgDistance > 30;
          case 'white':
            return s < 0.18 && v > 0.82 && bgDistance > 18;
          default:
            return (s > 0.36 && v > 0.22) || bgDistance > 30;
        }
      }

      function makeColorMask(color) {
        const mask = new Uint8Array(total);
        for (let index = 0; index < total; index += 1) {
          const offset = index * 4;
          if (pixels[offset + 3] < 64) continue;
          if (matchesColor(color, pixels[offset], pixels[offset + 1], pixels[offset + 2])) {
            mask[index] = 1;
          }
        }
        return mask;
      }

      function makeForegroundMask() {
        const mask = new Uint8Array(total);
        for (let index = 0; index < total; index += 1) {
          const offset = index * 4;
          const alpha = pixels[offset + 3];
          if (alpha < 64) continue;
          const r = pixels[offset];
          const g = pixels[offset + 1];
          const b = pixels[offset + 2];
          const { s, v } = rgbToHsv(r, g, b);
          const lum = luminance(r, g, b);
          const bgDistance = colorDistanceFromBackground(r, g, b);
          if ((s > 0.18 && v > 0.16) || bgDistance > 32 || (lum < background.lum - 26 && bgDistance > 18)) {
            mask[index] = 1;
          }
        }
        return mask;
      }

      function expandMask(mask, radius = 1) {
        if (radius <= 0) return mask;
        const expanded = new Uint8Array(total);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (!mask[index]) continue;
            for (let dy = -radius; dy <= radius; dy += 1) {
              const yy = y + dy;
              if (yy < 0 || yy >= height) continue;
              for (let dx = -radius; dx <= radius; dx += 1) {
                const xx = x + dx;
                if (xx < 0 || xx >= width) continue;
                expanded[yy * width + xx] = 1;
              }
            }
          }
        }
        return expanded;
      }

      function componentsFromMask(mask, { radius = 1, minArea = 16 } = {}) {
        const expanded = expandMask(mask, radius);
        const visited = new Uint8Array(total);
        const queue = new Int32Array(total);
        const components = [];
        const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];

        for (let start = 0; start < total; start += 1) {
          if (!expanded[start] || visited[start]) continue;

          let head = 0;
          let tail = 0;
          queue[tail++] = start;
          visited[start] = 1;

          let area = 0;
          let expandedArea = 0;
          let minX = width;
          let minY = height;
          let maxX = 0;
          let maxY = 0;
          let sumX = 0;
          let sumY = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          const colorHits = Object.fromEntries(colorMatchers.map(item => [item.name, 0]));

          while (head < tail) {
            const current = queue[head++];
            const x = current % width;
            const y = Math.floor(current / width);
            expandedArea += 1;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;

            if (mask[current]) {
              const offset = current * 4;
              const r = pixels[offset];
              const g = pixels[offset + 1];
              const b = pixels[offset + 2];
              area += 1;
              sumX += x;
              sumY += y;
              sumR += r;
              sumG += g;
              sumB += b;
              for (const color of colorMatchers) {
                if (matchesColor(color.name, r, g, b)) colorHits[color.name] += 1;
              }
            }

            for (const step of neighbors) {
              const next = current + step;
              if (next < 0 || next >= total || visited[next] || !expanded[next]) continue;
              const nx = next % width;
              if (Math.abs(nx - x) > 1) continue;
              visited[next] = 1;
              queue[tail++] = next;
            }
          }

          const boxWidth = maxX - minX + 1;
          const boxHeight = maxY - minY + 1;
          const boxArea = boxWidth * boxHeight;
          if (area < minArea || boxWidth < 4 || boxHeight < 4 || boxArea > total * 0.55) continue;

          const component = {
            area,
            expandedArea,
            boxArea,
            density: area / boxArea,
            x: Math.round(sumX / area),
            y: Math.round(sumY / area),
            minX,
            minY,
            maxX,
            maxY,
            width: boxWidth,
            height: boxHeight,
            ratio: boxWidth / Math.max(1, boxHeight),
            avgRgb: [
              Math.round(sumR / area),
              Math.round(sumG / area),
              Math.round(sumB / area)
            ],
            colorHits
          };
          component.dominantColor = Object.entries(colorHits).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
          components.push(component);
        }
        return components
          .filter(component => component.density >= 0.06)
          .sort((a, b) => b.area - a.area);
      }

      const colorComponentCache = new Map();
      function getColorComponents(color) {
        if (!colorComponentCache.has(color)) {
          colorComponentCache.set(color, componentsFromMask(makeColorMask(color), { radius: 1, minArea: color === 'gray' ? 20 : 16 }));
        }
        return colorComponentCache.get(color);
      }

      let allColorObjectsCache = null;
      function getAllColorObjects() {
        if (allColorObjectsCache) return allColorObjectsCache;
        const objects = [];
        for (const color of colorMatchers.map(item => item.name).filter(name => !['gray', 'black', 'white'].includes(name))) {
          for (const component of getColorComponents(color)) {
            const candidate = { ...component, source: `color:${color}` };
            const existingIndex = objects.findIndex(item => sameComponent(item, candidate));
            if (existingIndex >= 0) {
              if (candidate.area > objects[existingIndex].area) objects[existingIndex] = candidate;
            } else {
              objects.push(candidate);
            }
          }
        }
        allColorObjectsCache = objects.sort((a, b) => b.area - a.area);
        return allColorObjectsCache;
      }

      function findFirstMatch(text, matchers) {
        const hits = [];
        for (const item of matchers) {
          for (const pattern of item.patterns) {
            const match = text.match(pattern);
            if (match && match.index !== undefined) {
              hits.push({ name: item.name, index: match.index });
            }
          }
        }
        return hits.sort((a, b) => a.index - b.index)[0]?.name || null;
      }

      function parseDescriptor(value) {
        const text = String(value || '').replace(/^请点击/, '').replace(/[，。,.!！]/g, '').replace(/物体|物品/g, '');
        return {
          text,
          color: findFirstMatch(text, colorMatchers),
          shape: findFirstMatch(text, shapeMatchers),
          size: /小|小号|小型|小体积|小尺寸|small/i.test(text)
            ? 'small'
            : (/大|大号|大型|大体积|大尺寸|large/i.test(text) ? 'large' : null)
        };
      }

      function parseTask(text) {
        const cleaned = String(text || '').replace(/^请点击/, '').replace(/[，。,.!！]/g, '');
        let match = cleaned.match(/与(.+?)有相同大小的(.+?)物[体品]?/);
        if (match) {
          return { type: 'sameSize', reference: parseDescriptor(match[1]), target: parseDescriptor(match[2]) };
        }
        match = cleaned.match(/与(.+?)有相同形状的(.*?)物[体品]?/);
        if (match) {
          return { type: 'sameShape', reference: parseDescriptor(match[1]), target: parseDescriptor(match[2]) };
        }
        match = cleaned.match(/与(.+?)有相同颜色的(.+)$/);
        if (match) {
          return { type: 'sameColor', reference: parseDescriptor(match[1]), target: parseDescriptor(match[2]) };
        }
        match = cleaned.match(/在(.+?)(右前方|左前方|右后方|左后方|右侧|左侧|前方|后方|上方|下方)(.+?)(?:物体|物品)?$/);
        if (match) {
          return { type: 'relative', reference: parseDescriptor(match[1]), relation: match[2], target: parseDescriptor(match[3]) };
        }
        return { type: 'simple', target: parseDescriptor(cleaned) };
      }

      const allObjects = componentsFromMask(makeForegroundMask(), { radius: 0, minArea: 28 });
      function withObjectFallback(components, desc) {
        if (!desc.color) return components;
        if (components.length) return components;
        return allObjects.filter(component => component.colorHits?.[desc.color] >= Math.max(12, component.area * 0.04));
      }

      function shapeScore(component, shape) {
        if (!shape) return 0;
        const ratio = component.ratio;
        const density = component.density;
        if (shape === 'sphere') return Math.abs(ratio - 1) + Math.abs(density - 0.68);
        if (shape === 'cube') return Math.abs(ratio - 1) + Math.abs(density - 0.78);
        if (shape === 'cylinder') return Math.abs(ratio - 0.82) + Math.abs(density - 0.70);
        if (shape === 'cone' || shape === 'pyramid') return Math.abs(ratio - 0.78) + Math.abs(density - 0.52);
        return 0;
      }

      function shapeDistance(a, b) {
        return Math.abs(a.ratio - b.ratio)
          + Math.abs(a.density - b.density) * 1.8
          + Math.abs((a.width / Math.sqrt(a.area)) - (b.width / Math.sqrt(b.area))) * 0.35
          + Math.abs((a.height / Math.sqrt(a.area)) - (b.height / Math.sqrt(b.area))) * 0.35;
      }

      function selectCandidates(desc) {
        let candidates = desc.color
          ? getColorComponents(desc.color).map(component => ({ ...component, source: `color:${desc.color}` }))
          : getAllColorObjects();
        if (!desc.color && !candidates.length) {
          candidates = allObjects.map(component => ({ ...component, source: 'foreground' }));
        }
        candidates = withObjectFallback(candidates, desc);
        if (!candidates.length) return [];

        let filtered = candidates.filter(component =>
          component.area >= 16
          && component.boxArea <= total * 0.45
          && component.minX > 2
          && component.minY > 2
          && component.maxX < width - 3
          && component.maxY < height - 3
        );
        if (!filtered.length) filtered = candidates;

        const largestArea = filtered.reduce((max, item) => Math.max(max, item.area), 0);
        if (desc.size === 'small' && filtered.length > 1) {
          const minArea = Math.max(16, largestArea * 0.025);
          filtered = filtered.filter(component => component.area >= minArea).sort((a, b) => a.area - b.area);
        } else if (desc.size === 'large') {
          filtered = filtered.sort((a, b) => b.area - a.area);
        } else if (desc.shape) {
          filtered = filtered.sort((a, b) => shapeScore(a, desc.shape) - shapeScore(b, desc.shape));
        } else {
          filtered = filtered.sort((a, b) => b.area - a.area);
        }
        return filtered;
      }

      function selectOne(desc) {
        return selectCandidates(desc)[0] || null;
      }

      function sameComponent(a, b) {
        if (!a || !b) return false;
        const centersClose = Math.hypot(a.x - b.x, a.y - b.y) < Math.max(a.width, a.height, b.width, b.height) * 0.35;
        const boxesOverlap = !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
        return centersClose && boxesOverlap;
      }

      function relationPenalty(candidate, reference, relation) {
        const dx = candidate.x - reference.x;
        const dy = candidate.y - reference.y;
        let penalty = 0;
        if (/右/.test(relation) && dx <= 0) penalty += Math.abs(dx) + 1000;
        if (/左/.test(relation) && dx >= 0) penalty += Math.abs(dx) + 1000;
        if (/前/.test(relation) && dy <= 0) penalty += Math.abs(dy) + 1000;
        if (/后/.test(relation) && dy >= 0) penalty += Math.abs(dy) + 1000;
        if (/上/.test(relation) && dy >= 0) penalty += Math.abs(dy) + 1000;
        if (/下/.test(relation) && dy <= 0) penalty += Math.abs(dy) + 1000;
        return penalty + Math.hypot(dx, dy) * 0.01;
      }

      const task = parseTask(prompt.text);
      let chosen = null;
      if (task.type === 'sameSize') {
        const reference = selectOne(task.reference);
        const candidates = selectCandidates(task.target).filter(candidate => !sameComponent(candidate, reference));
        if (reference && candidates.length) {
          chosen = candidates
            .sort((a, b) => Math.abs(Math.log(a.area / reference.area)) - Math.abs(Math.log(b.area / reference.area)))[0];
        }
      } else if (task.type === 'sameShape') {
        const reference = selectOne(task.reference);
        const candidates = selectCandidates(task.target).filter(candidate => !sameComponent(candidate, reference));
        if (reference && candidates.length) {
          chosen = candidates
            .sort((a, b) => shapeDistance(a, reference) - shapeDistance(b, reference))[0];
        }
      } else if (task.type === 'sameColor') {
        const reference = selectOne(task.reference);
        const referenceColor = reference?.source?.startsWith('color:')
          ? reference.source.slice(6)
          : reference?.dominantColor;
        const target = {
          ...task.target,
          color: task.target.color || referenceColor || null
        };
        const candidates = selectCandidates(target).filter(candidate => !sameComponent(candidate, reference));
        if (reference && candidates.length) {
          chosen = candidates[0];
        }
      } else if (task.type === 'relative') {
        const reference = selectOne(task.reference);
        const candidates = selectCandidates(task.target).filter(candidate => !sameComponent(candidate, reference));
        if (reference && candidates.length) {
          chosen = candidates
            .sort((a, b) => relationPenalty(a, reference, task.relation) - relationPenalty(b, reference, task.relation))[0];
        }
      } else {
        chosen = selectOne(task.target);
      }

      if (!chosen) {
        const fallbackDesc = parseDescriptor(prompt.text);
        chosen = selectOne(fallbackDesc) || allObjects[0];
      }
      if (!chosen) {
        throw new Error(`captcha target not found for prompt: ${prompt.text || 'unknown'}`);
      }

      function summarizeCandidate(component, index) {
        return {
          id: index + 1,
          x: component.x,
          y: component.y,
          color: component.source?.startsWith('color:') ? component.source.slice(6) : component.dominantColor,
          source: component.source || null,
          area: component.area,
          width: component.width,
          height: component.height,
          ratio: Number(component.ratio.toFixed(2)),
          density: Number(component.density.toFixed(2))
        };
      }

      const candidates = getAllColorObjects()
        .filter(component =>
          component.area >= 16
          && component.boxArea <= total * 0.45
          && component.minX > 2
          && component.minY > 2
          && component.maxX < width - 3
          && component.maxY < height - 3
        )
        .slice(0, 16)
        .map(summarizeCandidate);

      return {
        x: chosen.x,
        y: chosen.y,
        imageWidth: width,
        imageHeight: height,
        prompt: { ...prompt, task },
        chosen,
        components: (chosen.source?.startsWith('color:') ? getColorComponents(chosen.source.slice(6)) : allObjects).slice(0, 8),
        objectCount: allObjects.length,
        candidates
      };
    }, { image: captcha.backgroundImage, prompt });

    return result;
  }

  async _locateSpaceCaptchaTargetWithAi(captcha) {
    if (!this.captchaAiBaseUrl || !this.captchaAiApiKey) {
      throw new Error('captcha AI solver is not configured');
    }
    if (!captcha.backgroundImage) {
      throw new Error('captcha background image is missing');
    }

    const imageWidth = captcha.imageWidth || 344;
    const imageHeight = captcha.imageHeight || 344;
    const localAnalysis = await this._locateSpaceCaptchaTarget(captcha).catch((e) => ({
      error: e.message,
      candidates: []
    }));
    const candidates = Array.isArray(localAnalysis?.candidates) ? localAnalysis.candidates : [];
    const gridImage = await this._page.evaluate(async ({ image, width, height }) => {
      const img = new Image();
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('captcha image decode failed'));
      });
      img.src = image;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      ctx.save();
      ctx.font = '12px sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += 50) {
        ctx.strokeStyle = x === 0 ? 'rgba(255,0,0,0.8)' : 'rgba(255,0,0,0.32)';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,0,0,0.9)';
        ctx.fillText(String(x), Math.min(x + 2, width - 24), 2);
      }
      for (let y = 0; y <= height; y += 50) {
        ctx.strokeStyle = y === 0 ? 'rgba(0,80,255,0.8)' : 'rgba(0,80,255,0.32)';
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,80,255,0.9)';
        ctx.fillText(String(y), 2, Math.min(y + 2, height - 14));
      }
      ctx.restore();
      return canvas.toDataURL('image/jpeg', 0.92);
    }, { image: captcha.backgroundImage, width: imageWidth, height: imageHeight });
    const response = await fetch(`${this.captchaAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.captchaAiApiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.captchaAiModel,
        temperature: 0,
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '你是验证码点击坐标识别器。',
                `图片尺寸为 ${imageWidth}x${imageHeight} 像素，坐标原点在左上角。`,
                `验证码提示：${captcha.prompt || '请点击目标物体。'}`,
                '空间词约定：左/右对应图片 x 轴；后方/上方对应更小的 y；前方/下方对应更大的 y。',
                '如果提示包含“相同颜色/形状/大小”，先定位参考物体，再点击满足条件的目标物体中心。',
                candidates.length
                  ? `本地图像分割得到的候选物体如下，优先从候选中选择目标：${JSON.stringify(candidates)}`
                  : '没有可用候选物体，请直接根据图片估计目标中心。',
                '第一张图是原图，第二张图带坐标网格；最终坐标仍按原图像素返回。',
                '只返回严格 JSON：{"x":整数,"y":整数,"id":候选id或null}。',
                '不要返回解释、Markdown 或额外字段。'
              ].join('\n')
            },
            {
              type: 'image_url',
              image_url: { url: captcha.backgroundImage }
            },
            {
              type: 'image_url',
              image_url: { url: gridImage }
            }
          ]
        }]
      })
    });
    const body = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
    const content = body?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonObjectFromText(content);
    const selectedCandidate = candidates.find(candidate => Number(candidate.id) === Number(parsed?.id));
    const x = clampNumber(selectedCandidate?.x ?? parsed?.x, 0, imageWidth - 1);
    const y = clampNumber(selectedCandidate?.y ?? parsed?.y, 0, imageHeight - 1);

    if (x === null || y === null) {
      throw new Error(`captcha AI solver returned invalid coordinates: ${String(content).slice(0, 120)}`);
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      imageWidth,
      imageHeight,
      prompt: {
        text: captcha.prompt || '',
        solver: 'ai'
      },
      chosen: {
        x: Math.round(x),
        y: Math.round(y),
        source: selectedCandidate ? `ai:candidate:${selectedCandidate.id}` : 'ai',
        candidate: selectedCandidate || null
      },
      ai: {
        model: body?.model || this.captchaAiModel,
        status: response.status,
        content: String(content).slice(0, 200),
        localAnalysis: {
          x: localAnalysis?.x,
          y: localAnalysis?.y,
          task: localAnalysis?.prompt?.task,
          candidates
        }
      }
    };
  }

  async _locateSpaceCaptchaTargetWithSolver(captcha, solver) {
    const selected = String(solver || this.captchaSolver || 'heuristic').toLowerCase();
    if (selected === 'ai') {
      return this._locateSpaceCaptchaTargetWithAi(captcha);
    }
    if (selected === 'auto' && this.captchaAiBaseUrl && this.captchaAiApiKey) {
      try {
        return await this._locateSpaceCaptchaTargetWithAi(captcha);
      } catch (e) {
        const fallback = await this._locateSpaceCaptchaTarget(captcha);
        return {
          ...fallback,
          aiError: e.message
        };
      }
    }
    return this._locateSpaceCaptchaTarget(captcha);
  }

  async _callCheckinServerAction({ verifyToken, isGambler = false } = {}) {
    await this._ensureHdhiveRuntime();
    const actionId = '60529bb51b8032da8000e7c2d73b01e276a18422ea';
    return this._page.evaluate(async ({ actionId, verifyToken, isGambler }) => {
      let webpackRequire = window.__hdhiveRequire;
      if (!webpackRequire) {
        const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
        chunk.push([['__hdhive_action_call__'], {}, (req) => {
          webpackRequire = req;
          window.__hdhiveRequire = req;
        }]);
      }
      if (!webpackRequire) throw new Error('webpack require not found');
      if (!webpackRequire.m['41607']) {
        try { await webpackRequire.e(5530); } catch {}
      }

      const mod = webpackRequire(41607);
      const action = mod.createServerReference(
        actionId,
        mod.callServer,
        undefined,
        mod.findSourceMapURL,
        'checkIn'
      );
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('checkIn server action timed out')), 45000);
      });

      try {
        const result = await Promise.race([action(Boolean(isGambler), verifyToken || undefined), timeout]);
        const payload = result?.response || result?.error || result;
        return {
          status: result?.error ? 400 : 200,
          ok: !result?.error,
          data: payload
        };
      } catch (e) {
        return {
          status: 0,
          ok: false,
          data: {
            success: false,
            message: e.message || 'checkIn server action failed'
          }
        };
      }
    }, { actionId, verifyToken: verifyToken || null, isGambler });
  }

  async _solveSpaceCaptcha(challenge, options = {}) {
    if (!challenge?.ticket) {
      return { success: false, error: 'captcha challenge ticket is missing' };
    }
    const captchaMode = String(challenge.captchaMode || challenge.type || '');
    if (captchaMode && !/space/i.test(captchaMode)) {
      return { success: false, error: `unsupported captcha mode: ${captchaMode}` };
    }

    const attempts = Math.max(1, Math.min(5, Number(options.attempts || 3) || 3));
    const results = [];

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const captchaResponse = await this._browserFetchJson('/captcha-api/slider', {
        query: {
          ticket: challenge.ticket,
          _ts: Date.now()
        }
      });
      const captcha = getSpaceCaptchaPayload(captchaResponse);
      if (!captcha.token || !captcha.backgroundImage) {
        results.push({
          attempt,
          success: false,
          error: getResponseMessage(captchaResponse) || 'captcha payload is incomplete',
          responseStatus: captchaResponse.status
        });
        await this._page.waitForTimeout(captchaResponse.status === 429 ? 2500 : 800);
        continue;
      }

      const solution = await this._locateSpaceCaptchaTargetWithSolver(captcha, options.solver);
      const verifyResponse = await this._browserFetchJson('/captcha-api/slider/verify', {
        method: 'POST',
        body: {
          token: captcha.token,
          x: solution.x,
          y: solution.y,
          bg_image_width: captcha.imageWidth || solution.imageWidth,
          bg_image_height: captcha.imageHeight || solution.imageHeight,
          challenge_ticket: challenge.ticket
        }
      });
      const success = isCaptchaVerifySuccess(verifyResponse);
      const verifyData = verifyResponse?.data?.data && typeof verifyResponse.data.data === 'object'
        ? verifyResponse.data.data
        : null;
      const item = {
        attempt,
        success,
        prompt: captcha.prompt,
        mode: captcha.mode,
        solution,
        responseStatus: verifyResponse.status,
        message: getCaptchaVerifyMessage(verifyResponse),
        verifyData,
        verifyToken: verifyData?.verify_token || null
      };
      results.push(item);
      if (success) {
        return {
          success: true,
          challengeTicket: challenge.ticket,
          attempts: results,
          prompt: captcha.prompt,
          solution
        };
      }
      await this._page.waitForTimeout(/频繁|too many|rate/i.test(item.message || '') ? 2500 : 1200);
    }

    const last = results[results.length - 1] || {};
    return {
      success: false,
      challengeTicket: challenge.ticket,
      attempts: results,
      error: last.message || last.error || 'captcha verification failed'
    };
  }

  async createResource(url, movie_id = 1) {
    return this.call('POST', '/api/customer/resources', { body: { url, movie_id } });
  }

  async getResource(slugOrId) {
    return this.call('GET', `/api/customer/resources/${slugOrId}`);
  }

  async unlockResource(slugOrId) {
    return this.call('POST', `/api/customer/resources/${slugOrId}/unlock`);
  }

  // ─── 便捷方法 ───

  async getCurrentUser() {
    return this.call('GET', '/api/customer/user/current');
  }

  async getPointsLogs(query = {}) {
    return this.call('GET', '/api/customer/points-logs', { query });
  }

  async _getCurrentPointsSnapshot() {
    try {
      const response = await this.getCurrentUser();
      return {
        points: getCurrentUserPoints(response),
        user: response?.data?.data || null
      };
    } catch (e) {
      return { points: null, user: null, error: e.message };
    }
  }

  async checkin(options = {}) {
    const includeUser = options?.includeUser !== false;
    const autoVerify = options?.autoVerify === true;
    const before = includeUser ? await this._getCurrentPointsSnapshot() : null;
    let response;
    try {
      response = await this.call('POST', '/api/customer/user/checkin');
    } catch (e) {
      if (!isMissingResponseSignatureMessage(e.message)) throw e;
      response = await this._callCheckinServerAction({
        isGambler: options?.isGambler === true
      });
    }
    let normalized = normalizeCheckinResult(response);
    let initialCheckin = null;
    let verification = null;

    if (autoVerify && normalized.requiresVerification && normalized.challenge) {
      initialCheckin = {
        status: response.status,
        ok: response.ok,
        data: response.data,
        ...normalized
      };
      verification = await this._solveSpaceCaptcha(normalized.challenge, {
        attempts: options?.verificationAttempts,
        solver: options?.verificationSolver
      });
      if (verification.success) {
        const verifyToken = verification.attempts?.find(attempt => attempt.success)?.verifyToken || null;
        response = await this._callCheckinServerAction({
          verifyToken,
          isGambler: options?.isGambler === true
        });
        normalized = normalizeCheckinResult(response);
      }
    }

    const after = includeUser && (normalized.success || verification?.success) ? await this._getCurrentPointsSnapshot() : null;
    const previousPoints = before?.points ?? null;
    const currentPoints = after?.points ?? previousPoints;
    const pointsDelta = Number.isFinite(previousPoints) && Number.isFinite(currentPoints)
      ? currentPoints - previousPoints
      : null;
    const verifiedByPoints = Boolean(verification?.success) && Number.isFinite(pointsDelta) && pointsDelta > 0;
    if (verifiedByPoints && !normalized.success) {
      normalized = {
        ...normalized,
        success: true,
        checkedIn: true,
        alreadyCheckedIn: false,
        requiresVerification: false,
        challenge: null,
        challengeTicket: null,
        challengeType: null,
        captchaMode: null,
        message: '签到成功'
      };
    }

    return {
      ...response,
      ...normalized,
      previousPoints,
      currentPoints,
      pointsDelta,
      user: after?.user ?? before?.user ?? null,
      autoVerify,
      verificationAttempted: Boolean(verification),
      verificationSucceeded: verification?.success ?? false,
      verification: sanitizeCaptchaVerification(verification),
      initialCheckin,
      pointSnapshotError: before?.error || after?.error || undefined
    };
  }

  async getUnreadCount() {
    return this.call('GET', '/api/customer/messages/unread-count');
  }

  async getBulletins() {
    return this.call('GET', '/api/public/bulletins/latest');
  }

  async checkResource(url) {
    return this.call('POST', '/api/customer/check/resource', { body: { url } });
  }

  async getResourceUnlockInfo(resourceOrSlug) {
    const resource = typeof resourceOrSlug === 'object' && resourceOrSlug
      ? resourceOrSlug
      : { slug: String(resourceOrSlug || '') };
    const pageUrl = resource.url || resource.pageUrl || resource.page_url || '';
    const slug = resource.slug
      || resource.id
      || String(pageUrl).match(/\/resource\/(?:189|cloud189|8)\/([A-Za-z0-9._~-]+)/)?.[1]
      || '';
    const fallbackUrl = pageUrl || (slug ? `${this.baseUrl}/resource/189/${slug}` : '');
    const pointValue = resource.unlock_points
      ?? resource.default_unlock_points
      ?? resource.points
      ?? ((resource.is_free || resource.isFree || resource.is_unlocked || resource.isUnlocked || resource.media_url || resource.link) ? 0 : null);

    if (pointValue !== null && pointValue !== undefined && Number.isFinite(Number(pointValue))) {
      const points = Number(pointValue);
      return {
        slug,
        website: resource.website || resource.pan_type || '189',
        default_unlock_points: points,
        unlock_points: points,
        share_size: resource.share_size || resource.size || 0,
        is_free: resource.is_free ?? resource.isFree ?? points === 0,
        source: resource.source || 'dom'
      };
    }

    if (!fallbackUrl) {
      throw new Error('resource url is required');
    }

    const check = await this.checkResource(fallbackUrl);
    const data = check.data?.data || {};
    const points = data.default_unlock_points ?? data.unlock_points ?? null;
    return {
      ...data,
      slug,
      website: data.website || resource.website || resource.pan_type || '189',
      default_unlock_points: points,
      unlock_points: points,
      share_size: data.share_size ?? resource.share_size ?? resource.size ?? 0,
      is_free: data.is_free ?? resource.is_free ?? resource.isFree ?? points === 0,
      source: 'check-resource'
    };
  }

  async getPlaylists(query = {}) {
    return this.call('GET', '/api/customer/playlists/my', { query });
  }

  async checkSubscription(target_type, target_key) {
    return this.call('GET', '/api/customer/subscriptions/check', {
      query: { target_type, target_key }
    });
  }

  /**
   * 预览 TMDB 资源的积分情况（**不消耗积分！**）
   * 推荐在 unlockByTmdbId 之前先调用，确认积分预算
   * @param {number} tmdbId
   * @param {string} type 'movie' | 'tv'
   * @returns {Promise<{success, currentPoints, resources, totalCost, ...}>}
   */
  async previewTmdb(tmdbId, type = 'movie') {
    // 1. 解析 TMDB → 内部 URL
    const resolved = await this.resolveTmdbToInternal(tmdbId, type);

    // 2. 找资源列表
    const resources = await this.findResourcesFromMoviePage(resolved.url);

    // 3. 对每个资源查询所需积分（优先 DOM，checkResource 兜底；不消耗积分）
    const enriched = [];
    for (const r of resources) {
      try {
        const info = await this.getResourceUnlockInfo(r);
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

    // 4. 当前用户积分
    let currentPoints = null;
    try {
      const user = await this.getCurrentUser();
      currentPoints = user.data?.data?.user_meta?.points;
    } catch {}

    return {
      success: true,
      tmdbId,
      type,
      movieSlug: resolved.slug,
      movieUrl: resolved.url,
      currentPoints,
      resources: enriched,
      totalCost: enriched.reduce((sum, r) => sum + (r.unlock_points || 0), 0),
      cheapestCost: enriched.length > 0 ? Math.min(...enriched.map(r => r.unlock_points || 0)) : 0
    };
  }

  /**
   * 通过 TMDB ID 解析影巢内部 URL（**无需登录**）
   * 拦截第一次重定向（/tmdb/movie/{id} → /movie/{内部slug}）就停止
   */
  async resolveTmdbToInternal(tmdbId, type = 'movie', attempt = 1) {
    if (this._ready && this._page) {
      try {
        return await this._resolveTmdbInPage(this._page, tmdbId, type);
      } catch (e) {
        if (attempt < 2) {
          await this._reloadPage();
          return this.resolveTmdbToInternal(tmdbId, type, attempt + 1);
        }
        throw e;
      }
    }

    const profileDir = path.join(os.tmpdir(), `hdhive-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(profileDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(profileDir, buildLaunchOptions({
      headless: true,
      userAgent: this.userAgent,
      proxy: this.proxy
    }));
    await ctx.addInitScript(STEALTH_SCRIPT);
    const page = await ctx.pages()[0] || await ctx.newPage();
    // 拦截图片/统计加速
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      const rtype = route.request().resourceType();
      if (['image', 'font', 'media'].includes(rtype)) return route.abort();
      if (url.includes('umami.hdhive.com')) return route.abort();
      if (url.includes('_rsc=') || url.includes('next-router-prefetch') || url.includes('next-router-segment-prefetch')) return route.abort();
      return route.continue();
    });

    try {
      return await this._resolveTmdbInPage(page, tmdbId, type);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async _resolveTmdbInPage(page, tmdbId, type = 'movie') {
    let resolvedSlug = null;
    let resolvedType = null;
    const capture = (url) => {
      if (resolvedSlug) return;
      const m = String(url).match(/\/(movie|tv)\/([a-f0-9]{32})/);
      if (m) { resolvedSlug = m[2]; resolvedType = m[1]; }
    };
    const onRequest = (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) capture(req.url());
    };
    const onResponse = (res) => {
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) capture(res.url());
    };
    const onFrameNavigated = (frame) => {
      if (frame === page.mainFrame()) capture(frame.url());
    };

    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('framenavigated', onFrameNavigated);
    try {
      const tmdbUrl = `${this.baseUrl}/tmdb/${type}/${tmdbId}`;
      if (/\/(movie|tv)\/[a-f0-9]{32}/.test(page.url())) {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => {});
      }
      const navPromise = page.goto(tmdbUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const start = Date.now();
      while (!resolvedSlug && Date.now() - start < 8000) {
        await page.waitForTimeout(50);
      }
      if (resolvedSlug) {
        await page.evaluate(() => window.stop()).catch(() => {});
        if (page === this._page) this._pageNeedsMovieReload = true;
        return { type: resolvedType || type, slug: resolvedSlug, url: `${this.baseUrl}/${resolvedType || type}/${resolvedSlug}` };
      }

      await navPromise.catch(() => {});
      capture(page.url());
      if (!resolvedSlug) {
        throw new Error(`cannot resolve TMDB ${type}/${tmdbId}`);
      }
      return { type: resolvedType || type, slug: resolvedSlug, url: `${this.baseUrl}/${resolvedType || type}/${resolvedSlug}` };
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('framenavigated', onFrameNavigated);
    }
  }

  /**
   * 从 movie 页面找 189 资源列表（无需登录，仅 DOM 爬取）
   * 优化：只滚动 2 次（之前 6 次），因为我们只要 slug
   */
  async findResourcesFromMoviePage(movieInternalUrl) {
    await this._ensureBrowser({ initialUrl: movieInternalUrl });
    if (this._pageNeedsMovieReload || this._page.url() !== movieInternalUrl) {
      this._pageNeedsMovieReload = false;
      try { await this._page.goto(movieInternalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
    }

    // 轮询等待 LOADING 状态结束（页面 client-side 渲染完成）
    const loaded = await this._waitForMoviePageReady();
    if (!loaded) console.warn('[hdhive-client] movie 页面加载超时');

    // 点击"天翼云盘" tab —— 一旦点击，资源列表立即出现在 DOM 中
    await this._page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]'));
      const target = candidates.find(el => /天翼云盘|189/.test(el.innerText || ''));
      if (target) target.click();
    }).catch(() => {});
    await this._page.waitForFunction(
      () => Boolean(document.querySelector('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]')),
      { timeout: 1200 }
    ).catch(() => undefined);
    await this._page.waitForFunction(
      () => {
        const anchors = document.querySelectorAll('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]');
        const text = document.body?.innerText || '';
        return anchors.length > 0 && /积分|免费/.test(text);
      },
      { timeout: 2500 }
    ).catch(() => undefined);

    const resources = await this._page.evaluate(() => {
      const parseSize = (value) => {
        const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)/i);
        if (!match) return 0;
        const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
        return Math.round(Number(match[1]) * units[match[2].toUpperCase()]);
      };
      const parseTitle = (lines) => {
        const cleanTitle = (line) => String(line || '').replace(/^免费\s*/, '').trim();
        const pointsIndex = lines.findIndex((line) => /免费|\d+\s*积分/.test(line));
        const startIndex = pointsIndex >= 0 ? pointsIndex + 1 : 0;
        const skipPattern = /^(发布于|免费|\d+\s*积分|疑似失效|加入片单|4K|1080P|720P|简中|简英双语|内封|外挂|WEB-DL\/WEBRip|蓝光原盘\/REMUX|\d+(?:\.\d+)?\s*(TB|GB|MB|KB|B))$/i;
        const title = lines.slice(startIndex).find((line) => line.length > 3 && !skipPattern.test(line))
          || lines.find((line) => line.length > 3 && !skipPattern.test(line));
        return cleanTitle(title) || '影巢天翼资源';
      };
      const resourceSlugFromAnchor = (anchor) => {
        try {
          const href = new URL(anchor.href, location.href);
          const parts = href.pathname.split('/').filter(Boolean);
          return decodeURIComponent(parts[2] || '');
        } catch {
          return '';
        }
      };
      const resourceSlugsIn = (node) => [...new Set(Array.from(node.querySelectorAll('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]'))
        .map(resourceSlugFromAnchor)
        .filter(Boolean))];
      const findResourceCard = (anchor, slug) => {
        let card = anchor;
        let best = anchor;
        for (let index = 0; index < 8 && card?.parentElement; index += 1) {
          const parent = card.parentElement;
          const slugs = resourceSlugsIn(parent);
          if (slugs.length > 1 || (slugs.length === 1 && slugs[0] !== slug)) break;
          const text = (parent.innerText || '').trim();
          if (/发布于|积分|免费|疑似失效|\d+(?:\.\d+)?\s*(TB|GB|MB|KB|B)/i.test(text)) {
            best = parent;
          }
          card = parent;
        }
        return best;
      };
      const parseResource = (anchor) => {
        const href = new URL(anchor.href, location.href);
        const parts = href.pathname.split('/').filter(Boolean);
        const slug = decodeURIComponent(parts[2] || '');
        if (!slug) return null;

        const card = findResourceCard(anchor, slug);
        const text = (card?.innerText || anchor.innerText || anchor.textContent || '').trim();
        const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const pointsMatch = text.match(/(\d+)\s*积分/);
        const isFree = /(^|\n|\s)免费($|\n|\s)/.test(text)
          || lines.some((line) => line === '免费')
          || (!pointsMatch && /^免费/.test(text));
        const unlockPoints = pointsMatch ? Number(pointsMatch[1]) : (isFree ? 0 : null);
        const cloudLink = text.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
        const accessCode = (text.match(/(?:访问码|提取码)[：:\s]*([A-Za-z0-9]{4})/) || [])[1] || '';

        return {
          id: slug,
          slug,
          url: href.href,
          pageUrl: href.href,
          text: text.slice(0, 1000),
          title: parseTitle(lines),
          pan_type: '189',
          website: '189',
          share_size: parseSize(text),
          unlock_points: unlockPoints,
          default_unlock_points: unlockPoints,
          is_free: isFree || unlockPoints === 0,
          expired: /疑似失效/.test(text),
          is_unlocked: /已解锁|查看链接|复制链接/.test(text) || Boolean(cloudLink),
          media_url: cloudLink?.[0] || '',
          access_code: accessCode,
          source: 'dom'
        };
      };

      const anchors = [...document.querySelectorAll('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]')];
      const seen = new Set();
      const result = [];
      for (const anchor of anchors) {
        const resource = parseResource(anchor);
        if (!resource || seen.has(resource.slug)) continue;
        seen.add(resource.slug);
        result.push(resource);
      }
      return result;
    });
    return resources;
  }

  /**
   * 通过拦截 Next.js RSC payload 直接拿 cloud189 URL（**优化版，比 DOM 爬取快 5 倍**）
   * @param {string} slugOrUrl
   */
  async getCloud189Links(slugOrUrl) {
    let slug = slugOrUrl;
    const m = String(slugOrUrl).match(/\/resource\/189\/([a-f0-9]{32})/);
    if (m) slug = m[1];
    if (!/^[a-f0-9]{32}$/.test(slug)) {
      throw new Error(`Invalid resource slug: ${slug}`);
    }

    await this._ensureBrowser();
    const detailUrl = `${this.baseUrl}/resource/189/${slug}`;

    // 复用页面：如果已经在该 URL 就跳过 navigate
    if (this._page.url() !== detailUrl) {
      try { await this._page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    }

    // 优先尝试：1) 直接读 page.content()（快）
    let html = await this._page.content().catch(() => '');
    let urlMatch = [...html.matchAll(/https?:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g)];
    let codeMatch = html.match(/访问码[：:]*\s*([a-zA-Z0-9]{4,8})/i);

    // 如果 page.content() 没拿到，轮询等待 RSC 流式 push 写入（最多 3 秒，命中即早退）
    if (urlMatch.length === 0 && !codeMatch) {
      const deadline = Date.now() + 3000;
      while (urlMatch.length === 0 && !codeMatch && Date.now() < deadline) {
        await this._page.waitForTimeout(200);
        html = await this._page.content().catch(() => '');
        urlMatch = [...html.matchAll(/https?:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g)];
        codeMatch = html.match(/访问码[：:]*\s*([a-zA-Z0-9]{4,8})/i);
      }
    }

    // 提取访问码（从各种可能位置）
    if (!codeMatch) {
      const codeMatch2 = html.match(/access[_-]?code["\s:]+([a-zA-Z0-9]{4,8})/i);
      if (codeMatch2) codeMatch = codeMatch2;
    }

    // 提取备注/大小
    const remarkMatch = html.match(/["']remark["']\s*:\s*["']([^"']{10,200})/);
    const sizeMatch = html.match(/["']share_size["']\s*:\s*["']([^"']+)/);

    if (urlMatch.length === 0 && !codeMatch) {
      return { url: null, accessCode: null, fullText: null, error: 'no cloud189 link found in page' };
    }

    const cloud189Url = urlMatch[0]?.[0] || null;
    const accessCode = codeMatch?.[1] || null;

    return {
      url: cloud189Url,
      accessCode,
      shareSize: sizeMatch?.[1] || null,
      remark: remarkMatch?.[1] || null,
      fullText: accessCode
        ? `${cloud189Url}（访问码：${accessCode}）`
        : cloud189Url,
      source: 'page-content'
    };
  }

  /**
   * 兜底方案：从 DOM 爬 cloud189 链接
   */
  async _getCloud189FromDOM(slug) {
    const html = await this._page.content().catch(() => '');
    const links = [...html.matchAll(/https?:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g)].map(m => m[0]);
    const codeMatch = html.match(/访问码[：:]*\s*([a-zA-Z0-9]{4,8})/i);
    return {
      url: links[0] || null,
      accessCode: codeMatch?.[1] || null,
      fullText: links[0] ? `${links[0]}${codeMatch ? `（访问码：${codeMatch[1]}）` : ''}` : null,
      source: 'dom-fallback'
    };
  }

  /**
   * 通过 TMDB ID 一键解锁（端到端最快路径）
   * 步骤：resolve → findRes → unlock → getCloud189
   */
  async unlockByTmdbId(tmdbId, type = 'movie') {
    console.log(`[1/4] 解析 TMDB ${type}/${tmdbId} (无需登录)`);
    const resolved = await this.resolveTmdbToInternal(tmdbId, type);
    console.log(`  → ${resolved.url}`);

    console.log(`[2/4] 找 189 资源列表`);
    const resources = await this.findResourcesFromMoviePage(resolved.url);
    console.log(`  → 找到 ${resources.length} 个资源`);
    if (resources.length === 0) {
      return {
        success: false,
        error: 'no 189 resources found for this movie',
        tmdbId,
        type,
        resolved
      };
    }

    const target = resources[0];
    console.log(`[3/4] 解锁资源 ${target.slug}`);
    const unlock = await this.unlockResource(target.slug);
    console.log(`  → ${unlock.data?.message}`);

    console.log(`[4/4] 通过 RSC payload 提取 189 链接`);
    const links = await this.getCloud189Links(target.slug);
    console.log(`  → ${links.fullText}`);

    return {
      success: true,
      tmdbId,
      type,
      movieSlug: resolved.slug,
      resourceSlug: target.slug,
      unlock: unlock.data,
      cloud189: links
    };
  }

  async unlockByResourceSlug(slugOrUrl) {
    let slug = slugOrUrl;
    const m = String(slugOrUrl).match(/\/resource\/189\/([a-f0-9]{32})/);
    if (m) slug = m[1];
    if (!/^[a-f0-9]{32}$/.test(slug)) throw new Error(`Invalid slug: ${slug}`);

    const detail = await this.getResource(slug);
    if (!detail.data?.success) return { success: false, error: detail.data?.description };

    const unlock = await this.unlockResource(slug);
    const links = await this.getCloud189Links(slug);

    return {
      success: true,
      slug,
      detail: detail.data,
      unlock: unlock.data,
      cloud189: links
    };
  }

  async unlockByShareUrl(shareUrl, movieId = 1) {
    const create = await this.createResource(shareUrl, movieId);
    const isSuccess = create.data?.success || (create.data?.description || '').includes('已存在');
    if (!isSuccess) return { success: false, error: 'create failed', detail: create };
    let slug = create.data?.data?.slug;
    if (!slug) {
      const m = shareUrl.match(/\/(movie|tv)\/([a-f0-9]{32})/);
      if (m) slug = m[2];
      else return { success: false, error: 'no slug found' };
    }
    const detail = await this.getResource(slug);
    const unlock = await this.unlockResource(slug);
    const links = await this.getCloud189Links(slug);
    return { success: true, slug, detail: detail.data, unlock: unlock.data, cloud189: links };
  }

  get(path, query) { return this.call('GET', path, { query }); }
  post(path, body, query) { return this.call('POST', path, { body, query }); }
  put(path, body) { return this.call('PUT', path, { body }); }
  delete(path) { return this.call('DELETE', path); }

  async close() {
    if (this._context) {
      await this._context.close().catch(() => {});
      this._context = null;
      this._page = null;
      this._ready = false;
    }
  }
}

export default HdhiveClient;
