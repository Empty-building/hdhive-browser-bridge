#!/usr/bin/env node
// 探针：看 movie 页面和 resource 页面的 __NEXT_DATA__ / RSC payload 结构
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-probe-nextdata-${Date.now()}`);
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
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = window.chrome || { runtime: {} };
});

const cookie = fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8').trim();
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
await ctx.addCookies(cookies);

const page = await ctx.pages()[0] || await ctx.newPage();

const captured = [];
page.on('response', async (res) => {
  const url = res.url();
  // Next.js __NEXT_DATA__ (script tag) 和 RSC payload
  if (url.includes('/_next/data/') || url.includes('_next/data')) {
    captured.push({ kind: 'next-data', url, status: res.status() });
  }
});

// 访问 movie 页面
console.log('[step] 访问 movie 页面');
try { await page.goto(`${BASE}/movie/0816e198eae211ed8d4e0242ac190003`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page.waitForTimeout(8000);

const nextData = await page.evaluate(() => {
  // 1. window.__NEXT_DATA__
  const nd = window.__NEXT_DATA__;
  // 2. RSC payload (在 script 标签里)
  const rscScripts = [...document.querySelectorAll('script')].filter(s => s.textContent && s.textContent.includes('"resources"'));
  // 3. 任何包含 cloud189 的 JSON
  const cloud189Scripts = [...document.querySelectorAll('script')].map(s => s.textContent).filter(t => t && /cloud\.189/.test(t));
  return {
    nextData: nd ? JSON.stringify(nd).slice(0, 3000) : null,
    nextDataKeys: nd ? Object.keys(nd) : null,
    rscScriptsCount: rscScripts.length,
    rscSample: rscScripts[0]?.textContent?.slice(0, 2000) || null,
    cloud189ScriptsCount: cloud189Scripts.length,
    cloud189Sample: cloud189Scripts[0]?.slice(0, 2000) || null,
    allScriptsCount: document.querySelectorAll('script').length
  };
});

console.log('\n=== Movie 页面 __NEXT_DATA__ ===');
console.log('keys:', nextData.nextDataKeys);
console.log('内容:', nextData.nextData);

console.log('\n=== RSC payload scripts ===');
console.log('数量:', nextData.rscScriptsCount);
console.log('样本:', nextData.rscSample?.slice(0, 800));

console.log('\n=== 含 cloud189 的 script ===');
console.log('数量:', nextData.cloud189ScriptsCount);
console.log('样本:', nextData.cloud189Sample?.slice(0, 800));

console.log('\n=== Next data 抓取 ===');
console.log('抓到的 _next/data 响应:', captured.length);
for (const c of captured) console.log(' ', c.url);

await ctx.close();

// 再访问 resource 详情页
console.log('\n\n[step] 访问 resource 详情页');
const profileDir2 = path.join(os.tmpdir(), `hdhive-probe-res-${Date.now()}`);
fs.mkdirSync(profileDir2, { recursive: true });
const ctx2 = await chromium.launchPersistentContext(profileDir2, {
  headless: true,
  viewport: { width: 1366, height: 768 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
await ctx2.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = window.chrome || { runtime: {} };
});
await ctx2.addCookies(cookies);

const page2 = await ctx2.pages()[0] || await ctx2.newPage();

const captured2 = [];
page2.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/customer/') || url.includes('/_next/data/') || url.includes('_next/data')) {
    captured2.push({ url, status: res.status(), contentType: res.headers()['content-type'] });
  }
});

try { await page2.goto(`${BASE}/resource/189/3fb1cb6823c64ae4a7a0f8f23bd4bed3`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page2.waitForTimeout(8000);

const resourcePage = await page2.evaluate(() => {
  const nd = window.__NEXT_DATA__;
  const rscScripts = [...document.querySelectorAll('script')].filter(s => s.textContent && (s.textContent.includes('cloud189') || s.textContent.includes('access_code')));
  const cloud189InScripts = [...document.querySelectorAll('script')].map(s => s.textContent).filter(t => t && /cloud\.189/.test(t));
  return {
    nextData: nd ? JSON.stringify(nd).slice(0, 3000) : null,
    nextDataKeys: nd ? Object.keys(nd) : null,
    rscScriptsCount: rscScripts.length,
    rscSample: rscScripts[0]?.textContent?.slice(0, 3000) || null,
    cloud189ScriptsCount: cloud189InScripts.length,
    cloud189Sample: cloud189InScripts[0]?.slice(0, 2000) || null
  };
});

console.log('\n=== Resource 详情页 __NEXT_DATA__ ===');
console.log('keys:', resourcePage.nextDataKeys);
console.log('内容:', resourcePage.nextData);

console.log('\n=== 含 cloud189 的 script ===');
console.log('数量:', resourcePage.cloud189ScriptsCount);
console.log('样本:', resourcePage.cloud189Sample?.slice(0, 1500));

console.log('\n=== 抓到的 API/_next/data 响应 ===');
for (const c of captured2) console.log(' ', c.status, c.url);

await ctx2.close();