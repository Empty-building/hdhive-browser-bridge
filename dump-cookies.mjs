#!/usr/bin/env node
// 使用 api-client.mjs 的完整 stealth 脚本登录
// 输出 cookie + bindSecret 到 /tmp/hdhive-cookies.txt 和 /tmp/hdhive-bind-secret.txt
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { STEALTH_SCRIPT } from './api-client.mjs';

const BASE = process.env.HDHIVE_BASE_URL || 'https://hdhive.com';
const PROXY = process.env.HDHIVE_PROXY || process.env.BROWSER_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
const USERNAME = process.argv[2] || process.env.HDHIVE_USERNAME || '';
const PASSWORD = process.argv[3] || process.env.HDHIVE_PASSWORD || '';

if (!USERNAME || !PASSWORD) {
  console.error('Usage: node dump-cookies.mjs <username> <password>');
  console.error('   or: HDHIVE_USERNAME=... HDHIVE_PASSWORD=... node dump-cookies.mjs');
  process.exit(1);
}

const profileDir = path.join(os.tmpdir(), `hdhive-login-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const launchOptions = {
  headless: true,
  viewport: { width: 1366, height: 768 },
  screen: { width: 1920, height: 1080 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
if (PROXY) {
  launchOptions.proxy = { server: PROXY.replace(/^socks5h:/i, 'socks5:') };
}

const context = await chromium.launchPersistentContext(profileDir, launchOptions);
await context.addInitScript(STEALTH_SCRIPT);

const page = context.pages()[0] || await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(3000);

console.log('[step] 打开 login 页面');
try { await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);

// 等表单
let found = false;
for (let i = 0; i < 40; i++) {
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

await page.locator('input[name="username"], input[type="email"], input[type="text"], #username').first().fill(USERNAME);
await page.locator('input[type="password"]').first().fill(PASSWORD);
const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
if (await submit.count() > 0) await submit.click();
else await page.locator('input[type="password"]').first().press('Enter');
console.log('[step] 等待登录完成');

// 等待登录完成（最多 45 秒）
const deadline = Date.now() + 45_000;
let cookies = [];
while (Date.now() < deadline) {
  await page.waitForTimeout(1000);
  cookies = await context.cookies();
  const names = new Set(cookies.map(c => c.name));
  if (names.has('token') && names.has('hdh_uid') && names.has('hdh_sa_token')) {
    console.log('[login ok]', [...names].join(','));
    break;
  }
}

console.log('[after login] URL:', page.url());

// 提取 bindSecret
const bindSecret = await page.evaluate(async () => {
  const readIdb = () => new Promise((resolve) => {
    try {
      const req = indexedDB.open('hdh-secure-bind', 1);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('bind')) return resolve(null);
          const tx = db.transaction('bind', 'readonly');
          const g = tx.objectStore('bind').get('bindSecret');
          g.onsuccess = () => resolve(typeof g.result === 'string' ? g.result : null);
          g.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
  return (await readIdb()) || sessionStorage.getItem('hdh:secure-client:bind-secret');
});

console.log('\n=== 全部 cookie ===');
for (const c of cookies) console.log(`${c.name}=${c.value}`);

if (bindSecret) {
  console.log('\n=== bindSecret ===');
  console.log(bindSecret);
  fs.writeFileSync('/tmp/hdhive-bind-secret.txt', bindSecret);
  console.log('[saved] /tmp/hdhive-bind-secret.txt');
} else {
  console.warn('[warn] bindSecret 未找到，customer API 可能 session_user_mismatch');
}

const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
fs.writeFileSync('/tmp/hdhive-cookies.txt', cookieHeader);
console.log('\n[saved] /tmp/hdhive-cookies.txt');

await context.close();
