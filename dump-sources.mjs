#!/usr/bin/env node
// 提取 webpack 模块源码，定位签名算法实现
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-extract-${Date.now()}`);
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

const page = context.pages()[0] || await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(5000);

// 提取所有 webpack 模块的源码
const sources = await page.evaluate(() => {
  const chunk = window.webpackChunk_N_E || [];
  const result = { moduleCount: 0, sources: [] };
  // 触发 webpack 加载所有模块
  let webpackRequire = null;
  for (const item of chunk) {
    const arr = Array.isArray(item) ? item : [];
    for (const sub of arr) {
      if (Array.isArray(sub) && sub.length >= 3 && typeof sub[2] === 'function') {
        try { sub[2]({ d: () => {} }, {}, (req) => { webpackRequire = req; }); } catch {}
      }
    }
  }
  if (!webpackRequire) {
    // 尝试 push 获取
    chunk.push([['hdhive-extract-probe'], {}, (req) => { webpackRequire = req; }]);
  }
  if (!webpackRequire) {
    return { error: 'webpack_require not found', chunkItems: chunk.length };
  }
  const factories = webpackRequire.m || {};
  const cache = webpackRequire.c || {};
  const ids = Object.keys(factories);
  result.moduleCount = ids.length;
  result.cacheCount = Object.keys(cache).length;

  // 找出与签名相关的模块
  const sigRelated = [];
  for (const [id, factory] of Object.entries(factories)) {
    const src = String(factory);
    if (src.includes('session/handshake') || src.includes('x-hdh-sig') || src.includes('x-hdh-nonce') ||
        src.includes('client_pub') || src.includes('server_pub') || src.includes('ECDH') ||
        src.includes('deriveKey') || src.includes('hkdf') || src.includes('hmac')) {
      sigRelated.push({ id, length: src.length, preview: src.slice(0, 200) });
    }
  }
  result.sigRelated = sigRelated.slice(0, 20);

  // 提取找到的工厂源码
  const out = {};
  for (const id of sigRelated.map(s => s.id).slice(0, 10)) {
    try {
      out[id] = factories[id].toString();
    } catch (e) {
      out[id] = `<<error: ${e.message}>>`;
    }
  }
  result.sources = out;

  return result;
});

console.log(JSON.stringify(sources, null, 2));

// 把找到的源码保存到文件供后续分析
if (sources.sources) {
  for (const [id, src] of Object.entries(sources.sources)) {
    fs.writeFileSync(path.join('/tmp', `hdh-module-${id}.js`), src);
    console.log(`[saved] /tmp/hdh-module-${id}.js (${src.length} chars)`);
  }
}

await context.close();