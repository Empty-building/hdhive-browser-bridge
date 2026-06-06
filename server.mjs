import express from 'express';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const config = {
  port: Number(process.env.PORT || 10000),
  baseUrl: trimTrailingSlash(process.env.HDHIVE_BASE_URL || 'https://hdhive.com'),
  cookie: String(process.env.HDHIVE_COOKIE || ''),
  bridgeToken: String(process.env.BRIDGE_TOKEN || ''),
  profileDir: String(process.env.BROWSER_PROFILE_DIR || '/data/hdhive-profile'),
  headless: process.env.BROWSER_HEADLESS !== 'false',
  keepAliveIntervalMs: Number(process.env.KEEPALIVE_INTERVAL_MS || 25_000),
  warmupIntervalMs: Number(process.env.WARMUP_INTERVAL_MS || 300_000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS || 30_000),
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,BackForwardCache'
      ]
    });
    state.browserLaunchAt = startedAt;
    state.browserLaunchMs = Date.now() - startedAt;
    state.restartCount += 1;
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
    hostname: os.hostname(),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal
    }
  };
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
