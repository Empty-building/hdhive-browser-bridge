#!/usr/bin/env node
// 访问"我的解锁"页面找真实资源
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-unlock-${Date.now()}`);
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
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  window.chrome = window.chrome || { runtime: {} };
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

const captured = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/customer/')) captured.push({ method: req.method(), url, postData: req.postData() });
});

// 尝试几个可能的解锁历史 URL
const urls = [
  `${BASE}/me/unlocks`,
  `${BASE}/me`,
  `${BASE}/account/unlocks`,
  `${BASE}/profile/unlocks`,
  `${BASE}/my-resources`,
  `${BASE}/unlocks`,
  `${BASE}/`,
];

for (const u of urls) {
  console.log(`\n[访问] ${u}`);
  try {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { console.log('  warn:', e.message.slice(0, 60)); }
  await page.waitForTimeout(5000);
  // 提取 resource 链接
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/resource/189/"]')].map(a => ({ href: a.href, text: a.innerText?.slice(0, 60) })));
  if (links.length > 0) {
    console.log('  找到资源:');
    for (const l of links.slice(0, 5)) console.log(`    ${l.href} → ${l.text}`);
  } else {
    console.log('  URL:', page.url());
    console.log('  bodyText:', (await page.evaluate(() => document.body?.innerText?.slice(0, 200))) || '');
  }
}

console.log('\n=== 抓到的 API 请求 ===');
for (const req of captured) {
  if (!req.url.includes('umami')) {
    console.log(`${req.method} ${req.url.replace(BASE, '')}`);
    if (req.postData) console.log(`  body: ${req.postData.slice(0, 200)}`);
  }
}

await context.close();