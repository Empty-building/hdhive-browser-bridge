#!/usr/bin/env node
// 触发 webpack chunk 完整加载，然后拦截 wasm 胶水
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-glue4-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1366, height: 768 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.__capturedChunk = null;
  // 拦截 webpackChunk 推送
  const origPush = Array.prototype.push;
  const captureChunks = [];
  Object.defineProperty(window, '__capturedChunks', { value: captureChunks, writable: false });
});

const page = context.pages()[0] || await context.newPage();

const wasmRequests = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('hdh_security_bg') || url.includes('wasm') && url.endsWith('.wasm')) {
    wasmRequests.push(url);
  }
});

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(8000);

// 捕获已加载的 chunk
const chunkInfo = await page.evaluate(() => {
  const chunk = window.webpackChunk_N_E || [];
  const items = [];
  for (const item of chunk) {
    if (Array.isArray(item)) {
      const sub = item[1] || item;
      if (Array.isArray(sub)) {
        items.push({
          ids: sub[0],
          modules: sub[1] ? Object.keys(sub[1]) : null,
          hasFactory: typeof sub[2] === 'function'
        });
      }
    }
  }
  return { count: chunk.length, items: items.slice(-10) };
});
console.log('Chunk info:', JSON.stringify(chunkInfo, null, 2));

// 主动 require 模块 1918
const result = await page.evaluate(async () => {
  let webpackRequire = null;
  const chunk = window.webpackChunk_N_E || [];
  // 通过 push 触发回调获取 webpack require
  chunk.push([['__extract_probe__'], {}, (req) => { webpackRequire = req; }]);
  if (!webpackRequire) return { error: 'no webpack' };

  const mods = Object.keys(webpackRequire.m || {});
  const has1918 = mods.includes('1918');

  // 如果还没加载,异步加载
  let loadResult = { loaded: false };
  if (!has1918) {
    try {
      await webpackRequire.e(1918);
    } catch (e) {
      loadResult.error = e.message;
    }
  }

  if (!webpackRequire.m['1918']) {
    return { error: 'module 1918 still not loaded', mods: mods.slice(-20), loadResult };
  }

  const factory = webpackRequire.m['1918'];
  const factorySrc = factory.toString();
  return {
    ok: true,
    factoryLen: factorySrc.length,
    factoryPreview: factorySrc.slice(0, 600),
    factoryEnd: factorySrc.slice(-400)
  };
});

console.log('Result:', JSON.stringify(result, null, 2));

console.log('WASM requests:', wasmRequests);

if (result.ok) {
  fs.writeFileSync('/tmp/hdh-wasm-glue-1918.js',
    `// extracted factory source for module 1918\n${result.factoryPreview}\n// ... (truncated)\n${result.factoryEnd}`);
}

await context.close();