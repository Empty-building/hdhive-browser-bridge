#!/usr/bin/env node
// 完整 dump RSC payload 看 cloud189 URL
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-dump-rsc-${Date.now()}`);
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

console.log('[step] 访问 resource 详情页');
try { await page.goto(`${BASE}/resource/189/3fb1cb6823c64ae4a7a0f8f23bd4bed3`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page.waitForTimeout(8000);

// dump 所有 payload
const result = await page.evaluate(() => {
  const all = (window.__rscCaptured || []).join('');
  // 找所有看起来像 cloud189 URL 的位置
  const matches = [];
  let idx = 0;
  while ((idx = all.indexOf('cloud.189', idx)) !== -1) {
    matches.push({
      pos: idx,
      context: all.slice(Math.max(0, idx - 100), idx + 200)
    });
    idx += 10;
  }
  // 也搜 189.cn 域名
  const cnMatches = [];
  idx = 0;
  while ((idx = all.indexOf('189.cn', idx)) !== -1) {
    cnMatches.push(all.slice(Math.max(0, idx - 80), idx + 100));
    idx += 7;
  }
  return {
    totalLength: all.length,
    matches: matches.slice(0, 10),
    cnMatches: cnMatches.slice(0, 10)
  };
});

console.log('payload 总长:', result.totalLength);
console.log('\n=== cloud.189 上下文 ===');
for (const m of result.matches) console.log(m.context, '\n---');

console.log('\n=== 189.cn 上下文 ===');
for (const m of result.cnMatches) console.log(m, '\n---');

// 也保存全部 payload
const fullPayload = await page.evaluate(() => (window.__rscCaptured || []).join('\n'));
fs.writeFileSync('/tmp/hdh-rsc-payload.txt', fullPayload);
console.log('\n完整 payload 已保存到 /tmp/hdh-rsc-payload.txt (', fullPayload.length, 'bytes)');

// 找 "share_url" 或 "189" 关键字附近
const all = await page.evaluate(() => (window.__rscCaptured || []).join(''));
const sampleMatch = all.match(/.{50}share_url.{300}/);
if (sampleMatch) console.log('\nshare_url 上下文:', sampleMatch[0]);

const codeMatch = all.match(/.{50}access_code.{200}/);
if (codeMatch) console.log('\naccess_code 上下文:', codeMatch[0]);

await ctx.close();