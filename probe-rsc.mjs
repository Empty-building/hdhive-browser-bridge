#!/usr/bin/env node
// 探针：拦截 self.__next_f.push 抓 RSC payload
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-probe-rsc-${Date.now()}`);
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

// 拦截网络：抓 _next/data 和 RSC 响应
const apiResponses = [];
const rscResponses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/customer/')) {
    apiResponses.push({ url, status: res.status() });
  }
  if (url.includes('_next/data') || url.includes('/_next/data/')) {
    try {
      const body = await res.text();
      rscResponses.push({ url, status: res.status(), body: body.slice(0, 500) });
    } catch {}
  }
});

// 注入拦截：捕获 self.__next_f.push
await page.addInitScript(() => {
  window.__rscCaptured = [];
  const origPush = Array.prototype.push;
  // 拦截 self.__next_f.push
  let rsc = window.__next_f;
  if (!rsc) {
    Object.defineProperty(window, '__next_f', {
      configurable: true,
      get() { return rsc; },
      set(v) {
        rsc = v;
        rsc.push = function(...args) {
          for (const arg of args) {
            if (typeof arg === 'object' && arg[1] && typeof arg[1] === 'string') {
              window.__rscCaptured.push(arg[1]);
            }
          }
          return origPush.apply(rsc, args);
        };
      }
    });
  }
});

console.log('[step] 访问 resource 详情页 /resource/189/3fb1cb68...');
try { await page.goto(`${BASE}/resource/189/3fb1cb6823c64ae4a7a0f8f23bd4bed3`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { console.log('  warn:', e.message.slice(0, 80)); }
await page.waitForTimeout(8000);

console.log('\n=== API 响应 ===');
for (const r of apiResponses) console.log(`  ${r.status} ${r.url}`);

console.log('\n=== _next/data 响应 ===');
for (const r of rscResponses) console.log(`  ${r.status} ${r.url.slice(0, 100)}`);
if (rscResponses[0]) console.log('  body sample:', rscResponses[0].body);

// 从 window.__rscCaptured 提取 cloud189 / access_code
const rscData = await page.evaluate(() => {
  const all = (window.__rscCaptured || []).join('');
  const cloud189Matches = [...all.matchAll(/https?:\\?\/\\?\/cloud\\?\.189\\?\.cn\\?\/t\\?\/[a-zA-Z0-9]+/g)].map(m => m[0].replace(/\\\?/g, ''));
  const accessCodeMatch = all.match(/"access_code"\s*:\s*"([^"]+)"/);
  const slugMatch = all.match(/"slug"\s*:\s*"([a-f0-9]{32})"/);
  const fullUrlMatch = all.match(/"full_url"\s*:\s*"([^"]+)"/);
  const urlMatch = all.match(/"url"\s*:\s*"(https?:[^"]+hdhive[^"]+)"/);

  // 直接搜索未转义版本
  const direct189 = [...all.matchAll(/https?:\/\/cloud\.189\.cn\/[a-zA-Z0-9]+/g)].map(m => m[0]);
  const directAccessCode = all.match(/"access_code":"([^"]+)"/);

  return {
    capturedCount: (window.__rscCaptured || []).length,
    totalLength: all.length,
    cloud189Matches: cloud189Matches.slice(0, 5),
    accessCodeMatch: accessCodeMatch?.[1],
    direct189: direct189.slice(0, 5),
    directAccessCode: directAccessCode?.[1],
    slug: slugMatch?.[1],
    fullUrl: fullUrlMatch?.[1],
    sample: all.includes('cloud189') ? all.slice(Math.max(0, all.indexOf('cloud189') - 100), all.indexOf('cloud189') + 500) : 'no cloud189 in payload'
  };
});

console.log('\n=== RSC payload 分析 ===');
console.log('捕获的 push 次数:', rscData.capturedCount);
console.log('总长度:', rscData.totalLength);
console.log('cloud189 链接:', rscData.direct189);
console.log('access_code:', rscData.directAccessCode);
console.log('slug:', rscData.slug);
console.log('full_url:', rscData.fullUrl);
console.log('cloud189 上下文:', rscData.sample);

await ctx.close();