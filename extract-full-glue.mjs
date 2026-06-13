#!/usr/bin/env node
// 提取完整的 wasm 胶水代码
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-glue5-${Date.now()}`);
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
await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

const page = context.pages()[0] || await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(10000);

const src = await page.evaluate(async () => {
  let webpackRequire = null;
  const chunk = window.webpackChunk_N_E || [];
  for (const item of chunk) {
    const arr = Array.isArray(item) ? item : [];
    for (const sub of arr) {
      if (Array.isArray(sub) && sub.length >= 3 && typeof sub[2] === 'function') {
        try { sub[2]({ d: () => {} }, {}, (req) => { if (!webpackRequire) webpackRequire = req; }); } catch {}
      }
    }
  }
  if (!webpackRequire) {
    chunk.push([['__probe__'], {}, (req) => { webpackRequire = req; }]);
  }
  if (!webpackRequire || !webpackRequire.m) return { error: 'no webpack', hasChunk: chunk.length };

  // 确保模块 1918 已加载
  if (!webpackRequire.m['1918']) {
    try {
      await webpackRequire.e(1918);
    } catch (e) {
      return { error: 'load 1918 failed: ' + e.message, mods: Object.keys(webpackRequire.m).slice(-10) };
    }
  }
  if (!webpackRequire.m['1918']) return { error: 'module 1918 not loaded', modCount: Object.keys(webpackRequire.m).length };
  return webpackRequire.m['1918'].toString();
});

if (!src || typeof src !== 'string') {
  console.error('failed to get factory:', JSON.stringify(src));
  process.exit(1);
}

fs.writeFileSync('/tmp/hdh-wasm-glue-full.js', src);
console.log(`[saved] /tmp/hdh-wasm-glue-full.js (${src.length} chars)`);
await context.close();