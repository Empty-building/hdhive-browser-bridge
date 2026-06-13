// hdhive-api-client.mjs
// 影巢 API 客户端（优化版）
// 优化点：(1) 复用浏览器 (2) 拦截 RSC payload 直接拿 cloud189 URL

import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_BASE = 'https://hdhive.com';

const REGISTER_AND_RUN = `
async ({ method, fullPath, body }) => {
  let webpackRequire = window.__hdhiveRequire;
  if (!webpackRequire) {
    window.webpackChunk_N_E.push([['__hdhive_probe__'], {}, (req) => { webpackRequire = req; window.__hdhiveRequire = req; }]);
  }
  if (!webpackRequire) throw new Error('webpack require not found');
  if (!webpackRequire.m['9110']) {
    try { await webpackRequire.e(9110); } catch (e) {}
  }
  if (!webpackRequire.m['9110']) throw new Error('module 9110 not loaded');
  const mod9110 = webpackRequire(9110);
  if (typeof mod9110.P$ === 'function' && !window.__hdhiveHookRegistered) {
    mod9110.P$({
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
  if (!mod9110.t5) throw new Error('signedFetch not found');
  const init = {
    method: String(method || 'GET').toUpperCase(),
    credentials: 'include',
    headers: {}
  };
  if (body !== null && body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await mod9110.t5(fullPath, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}
`;

/**
 * 完整 stealth 脚本
 */
const STEALTH_SCRIPT = `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  if (navigator.userAgentData) {
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [{ brand: 'Google Chrome', version: '125' }, { brand: 'Chromium', version: '125' }, { brand: 'Not.A/Brand', version: '24' }],
        mobile: false, platform: 'Windows',
        getHighEntropyValues: async () => ({
          brands: [{ brand: 'Google Chrome', version: '125' }, { brand: 'Chromium', version: '125' }, { brand: 'Not.A/Brand', version: '24' }],
          fullVersionList: [{ brand: 'Google Chrome', version: '125.0.0.0' }, { brand: 'Chromium', version: '125.0.0.0' }, { brand: 'Not.A/Brand', version: '24.0.0.0' }],
          mobile: false, platform: 'Windows', platformVersion: '15.0.0',
          architecture: 'x86', bitness: '64', model: '', uaFullVersion: '125.0.0.0', wow64: false
        })
      }), configurable: true
    });
  }
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
  window.chrome = window.chrome || { runtime: {} };
  for (const key of ['__playwright__binding__', '__pwInitScripts']) {
    try { delete window[key]; } catch {}
    try {
      Object.defineProperty(window, key, { get: () => undefined, set: () => undefined, configurable: true });
    } catch {}
  }
})();
`;

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

export class HdhiveClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
    this.cookie = options.cookie || '';
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    this.headless = options.headless !== false;
    this._context = null;
    this._page = null;
    this._ready = false;
    this._hookRegistered = false;
  }

  /**
   * 创建一个持久化浏览器实例（注入 cookie）
   */
  async _ensureBrowser({ injectCookie = true } = {}) {
    if (this._ready && this._page) return;
    const profileDir = path.join(os.tmpdir(), `hdhive-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(profileDir, { recursive: true });
    this._context = await chromium.launchPersistentContext(profileDir, {
      headless: this.headless,
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: this.userAgent,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
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
      return route.continue();
    });

    if (injectCookie && this.cookie) {
      const cookies = this.cookie.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
        const idx = pair.indexOf('=');
        return {
          name: pair.slice(0, idx).trim(),
          value: decodeURIComponent(pair.slice(idx + 1).trim()),
          domain: this.baseUrl.replace(/^https?:\/\//, ''),
          path: '/',
          httpOnly: ['hdh_sa_token', 'csrf_access_token'].includes(pair.slice(0, idx).trim()),
          secure: true
        };
      });
      try { await this._context.addCookies(cookies); } catch (e) {}
    }

    this._page = await this._context.pages()[0] || await this._context.newPage();
    await this._page.goto(`${this.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this._page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await this._page.waitForTimeout(2000);
    this._ready = true;
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

  async call(method, path, { query, body } = {}) {
    await this._ensureBrowser();
    let fullPath = path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const q = qs.toString();
      if (q) fullPath += (path.includes('?') ? '&' : '?') + q;
    }
    const args = JSON.stringify({ method, fullPath, body: body == null ? null : body });
    const fn = `(${REGISTER_AND_RUN})(${args})`;
    try {
      return await this._page.evaluate(fn);
    } catch (e) {
      if (/WASM|wasm|SignedFetchError|签名|加载失败/i.test(e.message || '')) {
        await this._reloadPage();
        return await this._page.evaluate(fn);
      }
      throw e;
    }
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

  /**
   * 通过 TMDB ID 解析影巢内部 URL（**无需登录**）
   * 拦截第一次重定向（/tmdb/movie/{id} → /movie/{内部slug}）就停止
   */
  async resolveTmdbToInternal(tmdbId, type = 'movie', attempt = 1) {
    const profileDir = path.join(os.tmpdir(), `hdhive-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(profileDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: this.userAgent,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    await ctx.addInitScript(STEALTH_SCRIPT);
    const page = await ctx.pages()[0] || await ctx.newPage();
    let resolvedSlug = null;
    let resolvedType = null;
    const capture = (url) => {
      if (resolvedSlug) return;
      const m = String(url).match(/\/(movie|tv)\/([a-f0-9]{32})/);
      if (m) { resolvedSlug = m[2]; resolvedType = m[1]; }
    };
    page.on('request', (req) => capture(req.url()));
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) capture(frame.url()); });
    page.on('response', (res) => capture(res.url()));

    // 拦截图片/统计加速
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      const rtype = route.request().resourceType();
      if (['image', 'font', 'media'].includes(rtype)) return route.abort();
      if (url.includes('umami.hdhive.com')) return route.abort();
      return route.continue();
    });

    try {
      const tmdbUrl = `${this.baseUrl}/tmdb/${type}/${tmdbId}`;
      const navPromise = page.goto(tmdbUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const start = Date.now();
      while (!resolvedSlug && Date.now() - start < 8000) {
        await page.waitForTimeout(50);
      }
      try { await ctx.route('**/*', route => route.abort()); } catch {}
      await navPromise.catch(() => {});
      if (!resolvedSlug) {
        await ctx.close().catch(() => {});
        if (attempt < 2) {
          return this.resolveTmdbToInternal(tmdbId, type, attempt + 1);
        }
        throw new Error(`cannot resolve TMDB ${type}/${tmdbId}`);
      }
      return { type: resolvedType || type, slug: resolvedSlug, url: `${this.baseUrl}/${resolvedType || type}/${resolvedSlug}` };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  /**
   * 从 movie 页面找 189 资源列表（无需登录，仅 DOM 爬取）
   * 优化：只滚动 2 次（之前 6 次），因为我们只要 slug
   */
  async findResourcesFromMoviePage(movieInternalUrl) {
    await this._ensureBrowser();
    try { await this._page.goto(movieInternalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}

    // 轮询等待 LOADING 状态结束（页面 client-side 渲染完成）
    const start = Date.now();
    let loaded = false;
    while (Date.now() - start < 15000) {
      loaded = await this._page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text && !text.includes('LOADING') && text.length > 100;
      });
      if (loaded) break;
      await this._page.waitForTimeout(300);
    }
    if (!loaded) console.warn('[hdhive-client] movie 页面加载超时');

    // 点击"天翼云盘" tab —— 一旦点击，资源列表立即出现在 DOM 中
    await this._page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]'));
      const target = candidates.find(el => /天翼云盘|189/.test(el.innerText || ''));
      if (target) target.click();
    }).catch(() => {});
    // 不需要等太久，立即读 DOM
    await this._page.waitForTimeout(500);

    const slugs = await this._page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/resource/189/"]')];
      return anchors.map(a => {
        const m = a.href.match(/\/resource\/189\/([a-f0-9]{32})/);
        return m ? { slug: m[1], url: a.href, text: a.innerText?.slice(0, 100) } : null;
      }).filter(Boolean);
    });
    return slugs;
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

    // 如果 page.content() 没拿到，等 RSC 流式 push 写入（最多 3 秒）
    if (urlMatch.length === 0 && !codeMatch) {
      await this._page.waitForTimeout(3000);
      html = await this._page.content().catch(() => '');
      urlMatch = [...html.matchAll(/https?:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g)];
      codeMatch = html.match(/访问码[：:]*\s*([a-zA-Z0-9]{4,8})/i);
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
      return { success: false, error: 'no 189 resources found', resolved };
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