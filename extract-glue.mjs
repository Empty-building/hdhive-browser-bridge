#!/usr/bin/env node
// 提取 WASM 模块的完整 JS 包装器代码（初始化函数）
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-glue-${Date.now()}`);
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
});

const page = context.pages()[0] || await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(5000);

// 获取模块 1918 的工厂代码
const factories = await page.evaluate(() => {
  let webpackRequire = null;
  const chunk = window.webpackChunk_N_E || [];
  for (const item of chunk) {
    const arr = Array.isArray(item) ? item : [];
    for (const sub of arr) {
      if (Array.isArray(sub) && sub.length >= 3 && typeof sub[2] === 'function') {
        try {
          sub[2]({ d: () => {} }, {}, (req) => { webpackRequire = req; });
        } catch {}
      }
    }
  }
  if (!webpackRequire) return { error: 'no webpack' };
  const m = webpackRequire.m || {};
  const out = {};
  // 找 wasm 加载的模块 1918
  for (const id of Object.keys(m)) {
    const src = m[id].toString();
    if (src.includes('hdh_security_bg') || src.includes('init_panic') || src.includes('wbg_') || src.length > 8000) {
      out[id] = { len: src.length, preview: src.slice(0, 300), hasWasm: src.includes('hdh_security_bg'), hasWbg: src.includes('__wbg_') };
    }
  }
  return out;
});

console.log(`[found] ${Object.keys(factories).length} 个 wasm 相关模块`);
for (const [id, src] of Object.entries(factories)) {
  const filename = `/tmp/hdh-wasm-glue-${id}.js`;
  fs.writeFileSync(filename, src);
  console.log(`[saved] ${filename} (${src.length} chars)`);
}

await context.close();