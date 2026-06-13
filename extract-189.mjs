#!/usr/bin/env node
// 从真实页面提取 189 网盘链接
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-extract189-${Date.now()}`);
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
  if (url.includes('/api/')) {
    captured.push({ method: req.method(), url, postData: req.postData() });
  }
});

const targetUrl = process.argv[2] || 'https://hdhive.com/movie/905baf2b010911ee89d70242ac130004';
console.log(`[step] 访问: ${targetUrl}`);
try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page.waitForTimeout(8000);

// 点击"天翼云盘"标签
console.log('[step] 尝试点击天翼云盘 tab');
const clicked = await page.evaluate(() => {
  const allBtns = Array.from(document.querySelectorAll('button, [role="tab"], div[class*="tab"], span[class*="tab"]'));
  const target = allBtns.find(el => /天翼云盘|189/.test(el.innerText || ''));
  if (target) { target.click(); return true; }
  return false;
});
console.log('  clicked:', clicked);
await page.waitForTimeout(5000);

// 滚动
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800);
}

// 提取所有 189 链接
const links = await page.evaluate(() => {
  const result = {
    cloud189Links: [],
    shareLinks: [],
    resourceAnchors: [],
    bodyText: document.body.innerText.slice(0, 500)
  };
  // 1. 链接中的 189 网盘
  document.querySelectorAll('a').forEach(a => {
    const href = a.href || '';
    const text = a.innerText || '';
    if (/cloud\.189\.cn|189\.cn|cloud189|天翼/i.test(href + text)) {
      result.cloud189Links.push({ href, text });
    }
  });
  // 2. resource/189/ 链接
  document.querySelectorAll('a[href*="/resource/189/"]').forEach(a => {
    result.resourceAnchors.push({ href: a.href, text: a.innerText });
  });
  // 3. data-* 属性
  document.querySelectorAll('[data-share-url], [data-url], [data-link], [data-cloud189]').forEach(el => {
    result.shareLinks.push({
      'data-share-url': el.dataset.shareUrl,
      'data-url': el.dataset.url,
      'data-link': el.dataset.link,
      'data-cloud189': el.dataset.cloud189,
      tag: el.tagName,
      text: el.innerText?.slice(0, 100)
    });
  });
  // 4. 整个 HTML 中的 189 链接
  const html = document.documentElement.outerHTML;
  const matches = [...html.matchAll(/https?:\/\/cloud\.189\.cn\/[^\s"'<>]+/g)];
  result.html189Matches = matches.map(m => m[0]);
  return result;
});

console.log('\n=== 提取结果 ===');
console.log('Body text:', links.bodyText.slice(0, 300));
console.log('\n189 链接 (a 标签):', links.cloud189Links);
console.log('\nresource 链接:', links.resourceAnchors);
console.log('\nHTML 中的 189:', links.html189Matches);
console.log('\ndata 属性:', links.shareLinks);

console.log('\n=== 抓到的 API 请求 ===');
for (const req of captured) {
  if (!req.url.includes('umami')) {
    console.log(`>>> ${req.method} ${req.url.replace(BASE, '')}`);
    if (req.postData) console.log(`  BODY: ${req.postData.slice(0, 400)}`);
  }
}

await context.close();