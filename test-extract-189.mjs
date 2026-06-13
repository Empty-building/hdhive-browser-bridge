#!/usr/bin/env node
// 完整端到端：API 创建/解锁 + 浏览器页面爬取 189 链接
import { HdhiveClient } from './api-client.mjs';
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const SLUG = 'f9873cbb15df4a8f828c050532165b40';
const SHARE_URL = 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';

// 步骤 1-4 用 API
const client = new HdhiveClient({ baseUrl: 'https://hdhive.com', cookie });
try {
  console.log('[API 步骤] 查询 + 解锁资源');
  const detail = await client.get(`/api/customer/resources/${SLUG}`);
  const unlock = await client.post(`/api/customer/resources/${SLUG}/unlock`);
  console.log('  查询:', detail.data?.success, '解锁:', unlock.data?.message);
} catch (e) {
  console.error('[API error]', e.message);
} finally {
  await client.close();
}

// 步骤 5: 用浏览器访问 /resource/189/{slug} 页面爬取 189 链接
console.log('\n[浏览器步骤] 访问资源详情页爬取 189 链接');
const profileDir = path.join(os.tmpdir(), `hdhive-189-${Date.now()}`);
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

// 注入 cookie 和完整 stealth
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
});

const cookies = cookie.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
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

const detailUrl = `https://hdhive.com/resource/189/${SLUG}`;
console.log('  URL:', detailUrl);
try {
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) { console.log('  warn:', e.message.slice(0, 80)); }
await page.waitForTimeout(8000);

const url = page.url();
console.log('  最终 URL:', url);
const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300));
console.log('  bodyText:', bodyText);

// 提取 189 链接
const links = await page.evaluate(() => {
  const html = document.documentElement.outerHTML;
  const result = {
    cloud189Direct: [...html.matchAll(/https?:\/\/cloud\.189\.cn\/[^\s"'<>\\)]+/g)].map(m => m[0]),
    cloud189InHref: [...document.querySelectorAll('a')].map(a => a.href).filter(h => /cloud\.189|189\.cn/.test(h)),
    shareLinks: [...document.querySelectorAll('a')].map(a => ({ href: a.href, text: a.innerText })).filter(l => /分享|网盘|提取|网盘地址|分享链接/.test(l.text)).slice(0, 20),
    bodyText: document.body?.innerText?.slice(0, 800)
  };
  return result;
});

console.log('\n━━━ 提取结果 ━━━');
console.log('cloud189 链接:', links.cloud189Direct);
console.log('a 标签中的 189:', links.cloud189InHref);
console.log('bodyText:', links.bodyText);

await context.close();