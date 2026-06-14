#!/usr/bin/env node
// 简化的探针：只读 HTML 找 unlock_points
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-html-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1366, height: 768 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

// 完整 stealth
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  window.chrome = window.chrome || { runtime: {} };
});

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
const cookies = cookie.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
  const idx = pair.indexOf('=');
  return {
    name: pair.slice(0, idx).trim(),
    value: decodeURIComponent(pair.slice(idx + 1).trim()),
    domain: 'hdhive.com', path: '/',
    httpOnly: ['hdh_sa_token', 'csrf_access_token'].includes(pair.slice(0, idx).trim()),
    secure: true
  };
});
await ctx.addCookies(cookies);

const page = await ctx.pages()[0] || await ctx.newPage();

const URL = 'https://hdhive.com/movie/3a427573e1e111ed8d4e0242ac190003';
console.log('[step] 访问:', URL);
try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page.waitForTimeout(8000);

// 直接读完整 HTML
const html = await page.content();
console.log('HTML 长度:', html.length);
const bodyTextRaw = await page.evaluate(() => document.body?.innerText || '');
console.log('bodyText 长度:', bodyTextRaw.length);
console.log('bodyText 前 500:', bodyTextRaw.slice(0, 500));

// 找所有 "积分" 出现的上下文
const pointsInText = [...html.matchAll(/.{100}积分.{100}/g)].map(m => m[0]);
console.log('\n=== "积分" 上下文 ===');
for (const t of pointsInText.slice(0, 10)) console.log('  ', t.replace(/\s+/g, ' ').slice(0, 200));

// 找所有 slug
const slugs = [...new Set([...html.matchAll(/"slug"\s*:\s*"([a-f0-9]{32})"/g)].map(m => m[1]))];
console.log('\n=== 找到的 slug ===');
console.log('  ', slugs);

// 找 资源标题（带积分标记）
const titles = [...html.matchAll(/(.{20,40})/g)].filter(m => /积分/.test(m[0]));
console.log('\n=== 资源片段样本 ===');
for (const t of titles.slice(0, 5)) console.log('  ', t[0].slice(0, 200));

// 直接看 body 文本（去掉 HTML 标签）
const bodyText = await page.evaluate(() => document.body?.innerText || '');
console.log('\n=== bodyText（积分相关）===');
const lines = bodyText.split('\n').filter(l => /积分|\d+/.test(l)).slice(0, 20);
for (const l of lines) console.log('  ', l);

await ctx.close();