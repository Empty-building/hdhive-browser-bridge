#!/usr/bin/env node
// 看 movie 页面的 RSC payload 是否包含 resource 列表
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-movie-rsc-${Date.now()}`);
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

await page.addInitScript(() => {
  window.__rscCaptured = [];
  let rsc = window.__next_f;
  Object.defineProperty(window, '__next_f', {
    configurable: true,
    get() { return rsc; },
    set(v) {
      rsc = v;
      const origPush = Array.prototype.push;
      rsc.push = function(...args) {
        for (const arg of args) {
          if (typeof arg === 'object' && Array.isArray(arg) && arg[1] && typeof arg[1] === 'string') {
            window.__rscCaptured.push(arg[1]);
          }
        }
        return origPush.apply(rsc, args);
      };
    }
  });
});

console.log('[step] 访问 movie 页面 /movie/0816e198...');
try { await page.goto(`${BASE}/movie/0816e198eae211ed8d4e0242ac190003`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page.waitForTimeout(8000);

const result = await page.evaluate(() => {
  const all = (window.__rscCaptured || []).join('');
  // 查找 slug 列表
  const slugMatches = [...all.matchAll(/"slug"\s*:\s*"([a-f0-9]{32})"/g)].map(m => m[1]);
  const uniqueSlugs = [...new Set(slugMatches)];
  // 查找 cloud189 相关
  const cloud189Context = all.match(/.{30}"website":"189".{300}/g) || [];
  const cloud189Direct = [...new Set([...all.matchAll(/https?:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9]+/g)].map(m => m[0]))];

  // 查找所有 "/resource/189/" 模式
  const resourceMatches = [...all.matchAll(/\\?"\/resource\/189\\?\/([a-f0-9]{32})/g)].map(m => m[1]);
  const resourceMatches2 = [...all.matchAll(/\/resource\/189\/([a-f0-9]{32})/g)].map(m => m[1]);

  // 查找 id 字段和 url 字段
  const idUrlPairs = [...all.matchAll(/"id"\s*:\s*(\d+)\s*,\s*"url"\s*:\s*"(https?:[^"]+)"/g)].map(m => ({id: m[1], url: m[2]}));

  return {
    totalLength: all.length,
    uniqueSlugs,
    cloud189Count: cloud189Direct.length,
    cloud189Direct,
    cloud189ContextSample: cloud189Context.slice(0, 3),
    resourceMatches: [...new Set(resourceMatches)],
    resourceMatches2: [...new Set(resourceMatches2)],
    idUrlPairs: idUrlPairs.slice(0, 10)
  };
});

console.log('payload 总长:', result.totalLength);
console.log('唯一 slug 列表:', result.uniqueSlugs);
console.log('cloud189 直接链接:', result.cloud189Direct);
console.log('cloud189 上下文样本:', result.cloud189ContextSample);
console.log('resource 匹配 (转义):', result.resourceMatches);
console.log('resource 匹配 (不转义):', result.resourceMatches2);
console.log('id+url 对:', result.idUrlPairs);

const fullPayload = await page.evaluate(() => (window.__rscCaptured || []).join('\n'));
fs.writeFileSync('/tmp/hdh-movie-rsc.txt', fullPayload);
console.log('\n完整 payload 保存到 /tmp/hdh-movie-rsc.txt');

await ctx.close();