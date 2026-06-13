#!/usr/bin/env node
// 找真实有效资源：访问首页 + 搜索"你的名字"
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-real-${Date.now()}`);
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

// 搜索"你的名字"
await page.goto(`${BASE}/search?q=${encodeURIComponent('你的名字')}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(8000);

// 提取所有 /resource/189/ 链接
const links = await page.evaluate(() => {
  return [...document.querySelectorAll('a[href*="/resource/189/"]')].map(a => ({
    href: a.href,
    text: a.innerText?.slice(0, 50)
  }));
});

console.log('找到的 resource 链接:');
for (const l of links.slice(0, 10)) console.log('  ', l.href, '→', l.text);

// 提取"你的名字"电影页链接
const movieLinks = await page.evaluate(() => {
  return [...document.querySelectorAll('a[href*="/movie/"]')].map(a => ({
    href: a.href,
    text: a.innerText?.slice(0, 50)
  })).filter(l => /你的名字|天气之子/.test(l.text));
});

console.log('\n你的名字/天气之子 链接:');
for (const l of movieLinks.slice(0, 5)) console.log('  ', l.href, '→', l.text);

await context.close();