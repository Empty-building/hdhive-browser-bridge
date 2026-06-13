#!/usr/bin/env node
// 使用 server.mjs 的完整 stealth 脚本登录
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const USERNAME = process.argv[2] || '';
const PASSWORD = process.argv[3] || '';
const profileDir = path.join(os.tmpdir(), `hdhive-login-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1366, height: 768 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,BackForwardCache'
  ]
});

// 完整 stealth（与 server.mjs 一致）
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

const page = context.pages()[0] || await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(3000);

console.log('[step] 打开 login 页面');
try { await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

// 等表单
let found = false;
for (let i = 0; i < 30; i++) {
  if (await page.locator('input[type="password"]').count().catch(() => 0) > 0) {
    found = true; break;
  }
  await page.waitForTimeout(1000);
}
console.log('[form found]', found);
if (!found) {
  console.log('[error] 登录表单未出现，body:', (await page.evaluate(() => document.body?.innerText?.slice(0, 300))) || '');
  await context.close();
  process.exit(1);
}

await page.locator('input[name="username"], input[type="email"], input[type="text"]').first().fill(USERNAME);
await page.locator('input[type="password"]').first().fill(PASSWORD);
const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
if (await submit.count() > 0) await submit.click();
else await page.locator('input[type="password"]').first().press('Enter');
console.log('[step] 等待登录完成');
await page.waitForTimeout(15000);

console.log('[after login] URL:', page.url());

const cookies = await context.cookies();
console.log('\n=== 全部 cookie ===');
for (const c of cookies) console.log(`${c.name}=${c.value}`);

const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
fs.writeFileSync('/tmp/hdhive-cookies.txt', cookieHeader);
console.log('\n[saved] /tmp/hdhive-cookies.txt');

await context.close();