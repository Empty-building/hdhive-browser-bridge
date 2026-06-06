import express from 'express';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const config = {
  port: Number(process.env.PORT || 10000),
  baseUrl: trimTrailingSlash(process.env.HDHIVE_BASE_URL || 'https://hdhive.com'),
  cookie: String(process.env.HDHIVE_COOKIE || ''),
  username: String(process.env.HDHIVE_USERNAME || ''),
  password: String(process.env.HDHIVE_PASSWORD || ''),
  bridgeToken: String(process.env.BRIDGE_TOKEN || ''),
  profileDir: String(process.env.BROWSER_PROFILE_DIR || '/data/hdhive-profile'),
  headless: process.env.BROWSER_HEADLESS !== 'false',
  keepAliveIntervalMs: Number(process.env.KEEPALIVE_INTERVAL_MS || 25_000),
  warmupIntervalMs: Number(process.env.WARMUP_INTERVAL_MS || 300_000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS || 30_000),
  loginTimeoutMs: Number(process.env.LOGIN_TIMEOUT_MS || 45_000),
  customerApiTimeoutMs: Number(process.env.CUSTOMER_API_TIMEOUT_MS || 30_000),
  idlePageUrl: process.env.IDLE_PAGE_URL || '/',
  warmupUrls: parseWarmupUrls(process.env.WARMUP_URLS || '/,/search'),
  maxHtmlChars: Number(process.env.MAX_HTML_CHARS || 0)
};

const state = {
  startedAt: Date.now(),
  context: null,
  page: null,
  browserLaunchAt: 0,
  browserLaunchMs: 0,
  lastWarmupAt: 0,
  lastWarmupMs: 0,
  lastWarmupOk: false,
  lastWarmupError: '',
  warmupCount: 0,
  restartCount: 0,
  activeAction: null,
  actionQueue: Promise.resolve()
};

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (!config.bridgeToken || req.path === '/health') {
    next();
    return;
  }

  const provided = req.get('x-bridge-token') || req.query.token;
  if (provided !== config.bridgeToken) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }
  next();
});

app.get('/health', async (req, res) => {
  const ready = Boolean(state.context && state.page);
  res.status(ready ? 200 : 503).json({
    success: ready,
    data: buildStatus()
  });
});

app.get('/metrics', async (req, res) => {
  res.json({ success: true, data: buildStatus() });
});

app.post('/warmup', async (req, res) => {
  const urls = Array.isArray(req.body?.urls) && req.body.urls.length > 0
    ? req.body.urls.map(String)
    : config.warmupUrls;
  const result = await enqueueAction('warmup', () => warmup(urls));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/warmup', async (req, res) => {
  const urls = typeof req.query.url === 'string' ? [req.query.url] : config.warmupUrls;
  const result = await enqueueAction('warmup', () => warmup(urls));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/status', async (req, res) => {
  const result = await enqueueAction('hdhive-status', async () => {
    const page = await ensurePage();
    const startedAt = Date.now();
    await page.goto(toAbsoluteUrl(config.idlePageUrl), {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs
    });
    const pageStatus = await page.evaluate(() => ({
      title: document.title,
      href: location.href,
      cookiesEnabled: navigator.cookieEnabled,
      localStorageKeys: Object.keys(localStorage || {}),
      sessionStorageKeys: Object.keys(sessionStorage || {})
    }));
    return {
      success: true,
      data: {
        ...pageStatus,
        elapsedMs: Date.now() - startedAt
      }
    };
  });
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/open', async (req, res) => {
  const url = String(req.body?.url || req.body?.path || config.idlePageUrl);
  const result = await enqueueAction('hdhive-open', () => openPage(url, Boolean(req.body?.includeHtml)));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/open', async (req, res) => {
  const url = String(req.query.url || req.query.path || config.idlePageUrl);
  const includeHtml = req.query.html === '1' || req.query.html === 'true';
  const result = await enqueueAction('hdhive-open', () => openPage(url, includeHtml));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/cookies', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-cookies', () => getCookieSnapshot());
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/login', requireSensitiveEndpoint, async (req, res) => {
  const username = String(req.body?.username || config.username || '').trim();
  const password = String(req.body?.password || config.password || '');
  const result = await enqueueAction('hdhive-login', () => loginWithPassword(username, password));
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/hdhive/customer/current', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-current', () => customerRequest('/api/customer/user/current'));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/checkin', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-checkin', () => customerRequest('/api/customer/user/checkin', { method: 'POST' }));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/customer/points-logs', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-points-logs', () => customerRequest('/api/customer/points-logs', {
    query: pickPrimitiveQuery(req.query)
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/resources', requireSensitiveEndpoint, async (req, res) => {
  const method = String(req.body?.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const result = await enqueueAction('hdhive-customer-resources', () => customerRequest('/api/customer/resources', {
    method,
    query: pickPrimitiveQuery(req.body?.query),
    body: req.body?.body
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/check-resource', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-check-resource', () => customerRequest('/api/customer/check/resource', {
    method: 'POST',
    body: req.body?.body || req.body
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/media-resources', requireSensitiveEndpoint, async (req, res) => {
  const type = String(req.body?.type || '').trim();
  const tmdbId = String(req.body?.tmdbId || '').trim();
  const result = await enqueueAction('hdhive-customer-media-resources', () => getMediaResources(type, tmdbId));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/customer/resources/:resourceId', requireSensitiveEndpoint, async (req, res) => {
  const resourceId = normalizeResourceId(req.params.resourceId);
  const result = await enqueueAction('hdhive-customer-resource', () => customerRequest(`/api/customer/resources/${resourceId}`));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/resources/:resourceId/unlock', requireSensitiveEndpoint, async (req, res) => {
  const resourceId = normalizeResourceId(req.params.resourceId);
  const result = await enqueueAction('hdhive-customer-resource-unlock', () => customerRequest(`/api/customer/resources/${resourceId}/unlock`, {
    method: 'POST',
    body: req.body?.body
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/browser/restart', async (req, res) => {
  const result = await enqueueAction('browser-restart', async () => {
    await closeBrowser();
    await ensurePage();
    return { success: true, data: buildStatus() };
  });
  res.status(result.success ? 200 : 500).json(result);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(config.port, '0.0.0.0', async () => {
  console.log(`[browser-bridge] listening on ${config.port}`);
  console.log(`[browser-bridge] baseUrl=${config.baseUrl} headless=${config.headless} profile=${config.profileDir}`);
  if (!config.bridgeToken) {
    console.warn('[browser-bridge] BRIDGE_TOKEN is empty; public endpoints are not protected.');
  }

  await enqueueAction('startup-warmup', () => warmup(config.warmupUrls));
  setInterval(() => {
    enqueueAction('interval-keepalive', () => keepAlive()).catch((error) => {
      console.error('[browser-bridge] keepalive failed', error);
    });
  }, config.keepAliveIntervalMs).unref();
  setInterval(() => {
    enqueueAction('interval-warmup', () => warmup(config.warmupUrls)).catch((error) => {
      console.error('[browser-bridge] warmup failed', error);
    });
  }, config.warmupIntervalMs).unref();
});

async function enqueueAction(name, action) {
  const id = randomUUID();
  const run = async () => {
    state.activeAction = { id, name, startedAt: Date.now() };
    try {
      return await action();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        data: buildStatus()
      };
    } finally {
      state.activeAction = null;
    }
  };

  const next = state.actionQueue.then(run, run);
  state.actionQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function ensurePage() {
  if (state.page && !state.page.isClosed()) {
    return state.page;
  }

  if (!state.context) {
    const startedAt = Date.now();
    state.context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,BackForwardCache'
      ]
    });
    state.browserLaunchAt = startedAt;
    state.browserLaunchMs = Date.now() - startedAt;
    state.restartCount += 1;
    await installStealthInitScript(state.context);
    await seedCookies(state.context);
  }

  state.page = state.context.pages()[0] || await state.context.newPage();
  state.page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  state.page.setDefaultTimeout(config.navigationTimeoutMs);
  state.page.on('close', () => {
    state.page = null;
  });
  return state.page;
}

async function seedCookies(context) {
  const cookies = parseCookieHeader(config.cookie, config.baseUrl);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }
}

async function installStealthInitScript(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    if (navigator.userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: [
            { brand: 'Google Chrome', version: '125' },
            { brand: 'Chromium', version: '125' },
            { brand: 'Not.A/Brand', version: '24' }
          ],
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async () => ({
            brands: [
              { brand: 'Google Chrome', version: '125' },
              { brand: 'Chromium', version: '125' },
              { brand: 'Not.A/Brand', version: '24' }
            ],
            fullVersionList: [
              { brand: 'Google Chrome', version: '125.0.0.0' },
              { brand: 'Chromium', version: '125.0.0.0' },
              { brand: 'Not.A/Brand', version: '24.0.0.0' }
            ],
            mobile: false,
            platform: 'Windows',
            platformVersion: '15.0.0',
            architecture: 'x86',
            bitness: '64',
            model: '',
            uaFullVersion: '125.0.0.0',
            wow64: false
          })
        }),
        configurable: true
      });
    }
    const patchWebGL = (prototype) => {
      if (!prototype?.getParameter) {
        return;
      }
      const originalGetParameter = prototype.getParameter;
      Object.defineProperty(prototype, 'getParameter', {
        value(parameter) {
          if (parameter === 37445) {
            return 'Google Inc. (Intel)';
          }
          if (parameter === 37446) {
            return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
          }
          return originalGetParameter.call(this, parameter);
        },
        configurable: true
      });
    };
    patchWebGL(window.WebGLRenderingContext?.prototype);
    patchWebGL(window.WebGL2RenderingContext?.prototype);
    window.chrome = window.chrome || { runtime: {} };
    for (const key of ['__playwright__binding__', '__pwInitScripts']) {
      try {
        delete window[key];
      } catch {
        // ignore
      }
      try {
        Object.defineProperty(window, key, {
          get: () => undefined,
          set: () => undefined,
          configurable: true
        });
      } catch {
        // ignore
      }
    }
  });
}

async function warmup(urls) {
  const startedAt = Date.now();
  const page = await ensurePage();
  const results = [];
  for (const value of urls) {
    const url = toAbsoluteUrl(value);
    const itemStartedAt = Date.now();
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs
      });
      results.push({
        url,
        status: response?.status() || 0,
        ok: response ? response.ok() : true,
        title: await page.title().catch(() => ''),
        elapsedMs: Date.now() - itemStartedAt
      });
    } catch (error) {
      results.push({
        url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - itemStartedAt
      });
    }
  }

  const failed = results.find((item) => item.ok === false);
  state.lastWarmupAt = Date.now();
  state.lastWarmupMs = Date.now() - startedAt;
  state.lastWarmupOk = !failed;
  state.lastWarmupError = failed?.error || '';
  state.warmupCount += 1;

  return {
    success: !failed,
    data: {
      results,
      status: buildStatus()
    },
    ...(failed ? { error: failed.error || 'warmup failed' } : {})
  };
}

async function keepAlive() {
  const page = await ensurePage();
  if (page.isClosed()) {
    state.page = null;
    await ensurePage();
  }
  await page.evaluate(() => Date.now()).catch(async () => {
    await closeBrowser();
    await ensurePage();
  });
  return { success: true, data: buildStatus() };
}

async function openPage(urlOrPath, includeHtml = false) {
  const page = await ensurePage();
  const startedAt = Date.now();
  const response = await page.goto(toAbsoluteUrl(urlOrPath), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs
  });
  const data = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    status: response?.status() || 0,
    ok: response ? response.ok() : true,
    elapsedMs: Date.now() - startedAt
  };
  if (includeHtml && config.maxHtmlChars > 0) {
    data.html = (await page.content()).slice(0, config.maxHtmlChars);
  }
  return { success: true, data };
}

async function getCookieSnapshot() {
  const page = await ensurePage();
  const cookies = await page.context().cookies(config.baseUrl);
  return {
    success: true,
    data: {
      cookieHeader: cookiesToHeader(cookies),
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite
      }))
    }
  };
}

async function loginWithPassword(username, password) {
  if (!username || !password) {
    return { success: false, error: 'HDHIVE_USERNAME/HDHIVE_PASSWORD 未配置，或请求体缺少 username/password' };
  }

  const page = await ensurePage();
  const startedAt = Date.now();
  await page.goto(toAbsoluteUrl('/login'), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

  const loginBlocked = await page.locator('text=出现了很奇怪的错误').count().catch(() => 0);
  if (loginBlocked > 0) {
    return {
      success: false,
      error: '影巢登录页拒绝当前浏览器环境，请尝试关闭 Headless 或调整浏览器指纹参数',
      data: await safePageSummary(page, startedAt)
    };
  }

  const usernameInput = page.locator('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"], input[type="text"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
  if (await usernameInput.count() === 0 || await passwordInput.count() === 0) {
    return {
      success: false,
      error: '未找到影巢登录表单，可能需要验证码、二次验证或页面结构已变化',
      data: await safePageSummary(page, startedAt)
    };
  }

  await usernameInput.fill(username, { timeout: config.navigationTimeoutMs });
  await passwordInput.fill(password, { timeout: config.navigationTimeoutMs });
  const submitButton = page.locator('button[type="submit"], button:has-text("登录"), [role="button"]:has-text("登录")').first();
  if (await submitButton.count() > 0) {
    await submitButton.click({ timeout: config.navigationTimeoutMs });
  } else {
    await passwordInput.press('Enter', { timeout: config.navigationTimeoutMs });
  }

  const loginResult = await waitForLoggedIn(page, startedAt);
  if (!loginResult.success) {
    return loginResult;
  }

  return {
    success: true,
    data: {
      ...loginResult.data,
      elapsedMs: Date.now() - startedAt
    }
  };
}

async function waitForLoggedIn(page, startedAt) {
  const deadline = Date.now() + config.loginTimeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const cookies = await page.context().cookies(config.baseUrl);
    const cookieHeader = cookiesToHeader(cookies);
    if (cookieHeader && cookies.some((cookie) => ['token', 'csrf_access_token', 'hdh_uid'].includes(cookie.name))) {
      const current = await customerRequest('/api/customer/user/current').catch((error) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }));
      if (current.success) {
        return {
          success: true,
          data: {
            cookieHeader,
            cookieNames: cookies.map((cookie) => cookie.name),
            currentUser: current.data?.payload || current.data
          }
        };
      }
      lastError = current.error || '';
    }
    const pageText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    if (/验证码|二次验证|两步验证|错误|失败|不存在|密码/.test(pageText)) {
      lastError = pageText.slice(0, 300);
    }
  }
  return {
    success: false,
    error: lastError || '登录超时，未获得有效网页登录态',
    data: await safePageSummary(page, startedAt)
  };
}

async function customerRequest(pathname, options = {}) {
  const page = await ensureRuntimePage();
  const startedAt = Date.now();
  const payload = {
    path: pathname,
    method: options.method || 'GET',
    query: options.query || null,
    body: options.body === undefined ? null : options.body
  };
  const result = await page.evaluate(async (request) => {
    const getWebpackRequire = () => {
      let webpackRequire = null;
      const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      chunk.push([[`hdhive-bridge-${Date.now()}`], {}, (require) => {
        webpackRequire = require;
      }]);
      return webpackRequire;
    };

    const findClient = () => {
      const webpackRequire = getWebpackRequire();
      if (!webpackRequire) {
        return null;
      }
      const readClient = (exports) => {
        const axiosClient = exports?.A;
        if (axiosClient?.get && axiosClient?.post && axiosClient?.interceptors?.request) {
          return axiosClient;
        }
        return null;
      };
      const tryRequire = (id) => {
        try {
          return readClient(webpackRequire(id));
        } catch {
          return null;
        }
      };
      const knownClient = tryRequire(41263);
      if (knownClient) {
        return knownClient;
      }
      const cache = webpackRequire.c || {};
      for (const module of Object.values(cache)) {
        const client = readClient(module?.exports);
        if (client) {
          return client;
        }
      }
      const factories = webpackRequire.m || {};
      for (const [id, factory] of Object.entries(factories)) {
        const source = String(factory || '');
        if (!source.includes('X-CSRF-TOKEN') || !source.includes('/api/public/auth/refresh')) {
          continue;
        }
        const client = tryRequire(id);
        if (client) {
          return client;
        }
      }
      return null;
    };

    const client = findClient();
    if (!client) {
      throw new Error('未找到影巢签名 API 客户端，请先打开影巢首页完成运行时加载');
    }

    const query = request.query && typeof request.query === 'object' ? request.query : undefined;
    const method = String(request.method || 'GET').toUpperCase();
    const config = query ? { params: query } : undefined;
    try {
      const response = method === 'GET'
        ? await client.get(request.path, config)
        : await client.post(request.path, request.body ?? undefined, config);
      if (response?.error) {
        return { ok: false, payload: response.error };
      }
      return { ok: true, payload: response?.response ?? response };
    } catch (error) {
      return {
        ok: false,
        payload: {
          name: error?.name || '',
          code: error?.code || '',
          httpStatus: error?.httpStatus || error?.status || 0,
          message: error?.message || error?.description || String(error)
        }
      };
    }
  }, payload);

  return {
    success: Boolean(result.ok),
    data: {
      path: pathname,
      method: payload.method,
      payload: result.payload,
      elapsedMs: Date.now() - startedAt
    },
    ...(result.ok ? {} : { error: result.payload?.message || result.payload?.description || '影巢 customer API 调用失败' })
  };
}

async function ensureRuntimePage() {
  const page = await ensurePage();
  if (!page.url().startsWith(config.baseUrl)) {
    await page.goto(toAbsoluteUrl(config.idlePageUrl), {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs
    });
  }
  await page.waitForFunction(() => {
    const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
    let found = false;
    chunk.push([[`hdhive-bridge-probe-${Date.now()}`], {}, (require) => {
      const hasClient = (exports) => {
        const axiosClient = exports?.A;
        return Boolean(axiosClient?.get && axiosClient?.post && axiosClient?.interceptors?.request);
      };
      const tryRequire = (id) => {
        try {
          return hasClient(require(id));
        } catch {
          return false;
        }
      };
      found = tryRequire(41263);
      if (found) {
        return;
      }
      const cache = require?.c || {};
      found = Object.values(cache).some((module) => hasClient(module?.exports));
      if (found) {
        return;
      }
      const factories = require?.m || {};
      for (const [id, factory] of Object.entries(factories)) {
        const source = String(factory || '');
        if (source.includes('X-CSRF-TOKEN') && source.includes('/api/public/auth/refresh') && tryRequire(id)) {
          found = true;
          return;
        }
      }
    }]);
    return found;
  }, { timeout: config.customerApiTimeoutMs });
  return page;
}

async function getMediaResources(type, tmdbId) {
  if (!['movie', 'tv'].includes(type) || !tmdbId) {
    return { success: false, error: 'type 必须是 movie/tv，tmdbId 不能为空' };
  }
  const page = await ensurePage();
  const mediaPath = `/tmdb/${type}/${encodeURIComponent(tmdbId)}`;
  await page.goto(toAbsoluteUrl(mediaPath), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const html = await page.content();
  const target = extractMediaResourceTarget(html, type, tmdbId);
  const attempts = [
    { method: 'POST', body: target },
    { method: 'GET', query: target },
    { method: 'POST', body: { type, tmdb_id: tmdbId, tmdbId, target_key: `${type}:${tmdbId}` } },
    { method: 'GET', query: { type, tmdb_id: tmdbId, tmdbId, target_key: `${type}:${tmdbId}` } }
  ].filter((item) => item.body || item.query);

  const errors = [];
  for (const attempt of attempts) {
    const result = await customerRequest('/api/customer/resources', attempt);
    if (result.success) {
      return {
        success: true,
        data: {
          mediaPath,
          target,
          request: attempt,
          payload: result.data.payload,
          elapsedMs: result.data.elapsedMs
        }
      };
    }
    errors.push(result.error);
  }

  return {
    success: false,
    error: errors.filter(Boolean).join('；') || '未能通过 customer resources 查询资源',
    data: { mediaPath, target }
  };
}

async function safePageSummary(page, startedAt) {
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 500),
    elapsedMs: Date.now() - startedAt
  };
}

async function closeBrowser() {
  if (state.context) {
    await state.context.close().catch(() => undefined);
  }
  state.context = null;
  state.page = null;
}

async function shutdown() {
  console.log('[browser-bridge] shutting down');
  await closeBrowser();
  process.exit(0);
}

function buildStatus() {
  const memory = process.memoryUsage();
  return {
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    browserReady: Boolean(state.context && state.page && !state.page.isClosed()),
    browserLaunchMs: state.browserLaunchMs,
    browserAgeSec: state.browserLaunchAt ? Math.round((Date.now() - state.browserLaunchAt) / 1000) : 0,
    lastWarmupAt: state.lastWarmupAt ? new Date(state.lastWarmupAt).toISOString() : null,
    lastWarmupMs: state.lastWarmupMs,
    lastWarmupOk: state.lastWarmupOk,
    lastWarmupError: state.lastWarmupError,
    warmupCount: state.warmupCount,
    restartCount: state.restartCount,
    activeAction: state.activeAction,
    baseUrl: config.baseUrl,
    hasCookie: Boolean(config.cookie),
    hasUsername: Boolean(config.username),
    protectedEndpoints: Boolean(config.bridgeToken),
    hostname: os.hostname(),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal
    }
  };
}

function requireSensitiveEndpoint(req, res, next) {
  if (!config.bridgeToken) {
    res.status(403).json({
      success: false,
      error: 'BRIDGE_TOKEN 未配置，敏感接口已拒绝执行'
    });
    return;
  }
  next();
}

function parseWarmupUrls(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toAbsoluteUrl(value) {
  const url = String(value || '/');
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${config.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parseCookieHeader(cookieHeader, baseUrl) {
  if (!cookieHeader) {
    return [];
  }
  const url = new URL(baseUrl);
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...valueParts] = part.split('=');
      if (!name || valueParts.length === 0) {
        return null;
      }
      return {
        name,
        value: valueParts.join('='),
        domain: url.hostname,
        path: '/',
        httpOnly: false,
        secure: url.protocol === 'https:',
        sameSite: 'Lax'
      };
    })
    .filter(Boolean);
}

function cookiesToHeader(cookies) {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function pickPrimitiveQuery(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const query = {};
  for (const [key, item] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof item)) {
      query[key] = String(item);
    }
  }
  return query;
}

function normalizeResourceId(value) {
  const resourceId = String(value || '').trim();
  if (!/^[A-Za-z0-9._~-]+$/.test(resourceId)) {
    throw new Error('resourceId 包含非法字符');
  }
  return resourceId;
}

function extractMediaResourceTarget(html, type, tmdbId) {
  const text = decodeFlightText(html);
  const escapedType = escapeRegExp(type);
  const escapedTmdbId = escapeRegExp(String(tmdbId));
  const targetKeyPattern = new RegExp(`"target_key"\\s*:\\s*"(${escapedType}:${escapedTmdbId})"[\\s\\S]{0,600}?"target_id"\\s*:\\s*(\\d+)`, 'i');
  const targetKeyMatch = text.match(targetKeyPattern);
  if (targetKeyMatch) {
    return {
      target_type: 'media_resource',
      target_id: Number(targetKeyMatch[2]),
      target_key: targetKeyMatch[1]
    };
  }
  const reversePattern = new RegExp(`"target_id"\\s*:\\s*(\\d+)[\\s\\S]{0,600}?"target_key"\\s*:\\s*"(${escapedType}:${escapedTmdbId})"`, 'i');
  const reverseMatch = text.match(reversePattern);
  if (reverseMatch) {
    return {
      target_type: 'media_resource',
      target_id: Number(reverseMatch[1]),
      target_key: reverseMatch[2]
    };
  }
  return {
    target_type: 'media_resource',
    target_key: `${type}:${tmdbId}`
  };
}

function decodeFlightText(html) {
  return String(html || '')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
