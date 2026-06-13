#!/usr/bin/env node
// 访问电影页面，抓取 /api/customer/resources 的真实请求格式
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-dump-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1366, height: 768 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
});

const cookieHeader = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const cookies = cookieHeader.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
  const idx = pair.indexOf('=');
  return {
    name: pair.slice(0, idx).trim(),
    value: decodeURIComponent(pair.slice(idx + 1).trim()),
    domain: 'hdhive.com',
    path: '/',
    httpOnly: ['hdh_sa_token', 'csrf_access_token'].includes(pair.slice(0, idx).trim()),
    secure: true
  };
});
await context.addCookies(cookies);

const page = context.pages()[0] || await context.newPage();

const capturedRequests = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/customer/')) {
    capturedRequests.push({
      method: req.method(),
      url,
      postData: req.postData(),
      headers: req.headers()
    });
  }
});

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(8000);

console.log('[step] 当前 URL:', page.url());
console.log('[step] cookie:', (await context.cookies()).map(c => c.name).join(', '));

console.log('[step] 打开电影详情页 /tmdb/movie/550');
try {
  await page.goto(`${BASE}/tmdb/movie/550`, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) { console.log('  warn:', e.message); }
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(10000);

console.log('[step] 当前 URL:', page.url());
const probe = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body?.innerText?.slice(0, 200)
}));
console.log('[probe]', probe);

console.log('\n=== 抓到的 /api/customer/* 请求 ===');
console.log('Total:', capturedRequests.length);
for (const req of capturedRequests) {
  console.log(`\n>>> ${req.method} ${req.url.replace(BASE, '')}`);
  if (req.postData) console.log(`  BODY: ${req.postData.slice(0, 600)}`);
}

await context.close();