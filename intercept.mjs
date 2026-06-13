#!/usr/bin/env node
// 完整抓包：使用 launchPersistentContext（与 server.mjs 一致）来通过反爬
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const USERNAME = process.argv[2] || '';
const PASSWORD = process.argv[3] || '';

const profileDir = path.join(os.tmpdir(), `hdhive-intercept-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
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
        mobile: false, platform: 'Windows',
        getHighEntropyValues: async () => ({
          brands: [{ brand: 'Google Chrome', version: '125' }, { brand: 'Chromium', version: '125' }, { brand: 'Not.A/Brand', version: '24' }],
          fullVersionList: [{ brand: 'Google Chrome', version: '125.0.0.0' }, { brand: 'Chromium', version: '125.0.0.0' }, { brand: 'Not.A/Brand', version: '24.0.0.0' }],
          mobile: false, platform: 'Windows', platformVersion: '15.0.0',
          architecture: 'x86', bitness: '64', model: '',
          uaFullVersion: '125.0.0.0', wow64: false
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
});

const page = context.pages()[0] || await context.newPage();

const requests = [];
const responses = [];

page.on('request', (req) => {
  const url = req.url();
  if (url.includes(BASE) && (url.includes('/api/') || url.includes('/auth/'))) {
    requests.push({
      method: req.method(), url,
      headers: req.headers(),
      postData: req.postData()
    });
  }
});

page.on('response', async (res) => {
  const url = res.url();
  if (url.includes(BASE) && (url.includes('/api/') || url.includes('/auth/'))) {
    let body = null;
    try {
      const ct = res.headers()['content-type'] || '';
      body = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    } catch {}
    responses.push({
      url, status: res.status(),
      requestHeaders: res.request().headers(),
      responseHeaders: res.headers(),
      body
    });
  }
});

console.log('[step] 打开影巢首页...');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(5000);

if (USERNAME && PASSWORD) {
  console.log('[step] 打开登录页...');
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('[warn] login 导航被中止:', e.message?.slice(0, 100));
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

  // 等表单渲染
  for (let i = 0; i < 30; i++) {
    const has = await page.locator('input[type="email"], input[name="email"], input[type="text"]').count().catch(() => 0);
    if (has > 0) break;
    await page.waitForTimeout(1000);
  }

  const info = await page.evaluate(() => ({
    url: location.href,
    bodyText: document.body?.innerText?.slice(0, 300),
    inputs: Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, placeholder: i.placeholder
    }))
  }));
  console.log('[probe login]', JSON.stringify(info, null, 2));

  if (info.inputs.length > 0) {
    console.log('[step] 填写登录表单...');
    const usernameInput = page.locator('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"], input[type="text"]').first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
    await usernameInput.fill(USERNAME);
    await passwordInput.fill(PASSWORD);
    const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
    if (await submit.count() > 0) await submit.click();
    else await passwordInput.press('Enter');

    console.log('[step] 等待登录完成...');
    await page.waitForTimeout(15000);
  }
}

// 触发 customer API
console.log('[step] 触发 customer API...');
try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
  console.log('[warn] 首页导航被中止:', e.message?.slice(0, 100));
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(8000);

console.log(`\n========== ${requests.length} 个 API 请求 ==========`);
for (const req of requests) {
  console.log(`\n>>> ${req.method} ${req.url.replace(BASE, '')}`);
  const sigH = Object.entries(req.headers).filter(([k]) => /rsig|rts|token|csrf|x-hdh/i.test(k));
  if (sigH.length) for (const [k, v] of sigH) console.log(`    ${k}: ${v}`);
  if (req.postData && req.method !== 'GET') console.log(`  POST: ${req.postData.slice(0, 300)}`);
}

console.log(`\n========== ${responses.length} 个 API 响应 ==========`);
for (const res of responses) {
  console.log(`\n<<< ${res.status} ${res.url.replace(BASE, '')}`);
  const sigH = Object.entries(res.responseHeaders).filter(([k]) => /rsig|rts|x-hdh/i.test(k));
  if (sigH.length) for (const [k, v] of sigH) console.log(`    ${k}: ${v}`);
  if (res.body) {
    const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    console.log(`  BODY: ${bodyStr.slice(0, 400)}`);
  }
}

const cookies = await context.cookies();
console.log('\n========== Cookies ==========');
for (const c of cookies) console.log(`  ${c.name}=${c.value.slice(0, 60)} (httpOnly=${c.httpOnly})`);

await context.close();