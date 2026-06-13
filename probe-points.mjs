#!/usr/bin/env node
// 探查 568160 的真实 movie URL 和 unlock_points
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-568160-${Date.now()}`);
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

// 拦截 customer API 响应
const capturedApi = [];
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/customer/')) {
    try {
      const body = await res.text();
      capturedApi.push({ url, status: res.status(), body: body.slice(0, 2000) });
    } catch {}
  }
});

// 1. 直接用 API 拿到的 movie URL（从 media-resources 接口得知）
const URL = 'https://hdhive.com/movie/3a427573e1e111ed8d4e0242ac190003';
console.log('[step] 直接访问 movie 页面:', URL);
let movieUrl = URL;
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) {
    const m = frame.url().match(/\/(movie|tv)\/([a-f0-9]{32})/);
    if (m && !movieUrl) movieUrl = frame.url();
  }
});
page.on('response', (res) => capture(res.url()));
let captured = [];
function capture(url) {
  const m = String(url).match(/\/(movie|tv)\/([a-f0-9]{32})/);
  if (m && !movieUrl) movieUrl = url;
  captured.push(url);
}

try { await page.goto(`${BASE}/tmdb/movie/568160`, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
await page.waitForTimeout(3000);

console.log('  解析到 movie URL:', movieUrl);

// 2. 提取 movie 页面 HTML 中的积分信息
if (movieUrl) {
  try { await page.goto(movieUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(5000);

  // 等待 LOADING 完成
  for (let i = 0; i < 30; i++) {
    const loaded = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      return t && !t.includes('LOADING') && t.length > 100;
    });
    if (loaded) break;
    await page.waitForTimeout(500);
  }

  // 点击天翼云盘 tab
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]'));
    const target = candidates.find(el => /天翼云盘|189/.test(el.innerText || ''));
    if (target) target.click();
  });
  await page.waitForTimeout(3000);
  // 滚动加载
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(800);
  }

  const probe = await page.evaluate(() => {
    try {
      const html = document.documentElement.outerHTML;
      const bodyText = document.body?.innerText?.slice(0, 300) || '';
      const unlockPoints = [...html.matchAll(/"unlock_points"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
      const defaultPoints = [...html.matchAll(/"default_unlock_points"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
      const slugAll = [...html.matchAll(/"slug"\s*:\s*"([a-f0-9]{32})"/g)].map(m => m[1]);
      // 找完整资源结构（slug + 周围 unlock_points）
      const slugInfo = slugAll.map(slug => {
        const idx = html.indexOf(`"slug":"${slug}"`);
        const snippet = html.slice(idx, idx + 3000);
        const unlock = snippet.match(/"unlock_points"\s*:\s*(\d+)/);
        const defaultUnlock = snippet.match(/"default_unlock_points"\s*:\s*(\d+)/);
        const website = snippet.match(/"website"\s*:\s*"([^"]+)"/);
        const url = snippet.match(/"url"\s*:\s*"(https?:\/\/cloud\.189\.cn[^"]+)"/);
        const accessCode = snippet.match(/"access_code"\s*:\s*"([^"]+)"/);
        const title = snippet.match(/"title"\s*:\s*"([^"]*)"/);
        return {
          slug,
          title: title?.[1] || '',
          unlock_points: unlock ? parseInt(unlock[1]) : null,
          default_unlock_points: defaultUnlock ? parseInt(defaultUnlock[1]) : null,
          website: website?.[1] || null,
          cloud189Url: url?.[1] || null,
          accessCode: accessCode?.[1] || null
        };
      });
      return {
        url: location.href,
        bodyText,
        unlockPoints,
        defaultPoints,
        slugInfo
      };
    } catch (e) {
      return { error: e.message };
    }
  });

  console.log('\n=== 提取结果 ===');
  console.log('URL:', probe.url);
  console.log('Body:', probe.bodyText?.slice(0, 200));
  console.log('所有 unlock_points:', probe.unlockPoints);
  console.log('所有 default_unlock_points:', probe.defaultPoints);
  console.log('\n资源详情:');
  for (const s of probe.slugInfo || []) {
    console.log(`  - slug=${s.slug.slice(0, 8)}... | title="${s.title}" | unlock=${s.unlock_points} | default=${s.default_unlock_points} | web=${s.website}`);
  }
}

console.log('\n=== 抓到的 customer API 调用 ===');
for (const r of capturedApi) {
  console.log(`\n[${r.status}] ${r.url.replace(BASE, '')}`);
  try {
    const j = JSON.parse(r.body);
    // 找含 unlock_points 的字段
    const text = JSON.stringify(j);
    const unlockMatches = [...text.matchAll(/"unlock_points"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
    const defaultMatches = [...text.matchAll(/"default_unlock_points"\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
    if (unlockMatches.length || defaultMatches.length) {
      console.log(`  unlock_points: [${unlockMatches.join(', ')}]`);
      console.log(`  default_unlock_points: [${defaultMatches.join(', ')}]`);
    }
  } catch (e) {}
}

await ctx.close();