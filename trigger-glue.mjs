#!/usr/bin/env node
// 在浏览器中触发 init() 让它加载 wasm chunk 并暴露
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-glue3-${Date.now()}`);
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

const triggered = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('hdh_security_bg') || url.includes('wasm')) {
    triggered.push(url);
  }
});

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(5000);

// 主动触发 wasm 加载
console.log('[trigger] 主动调用握手');
const triggerResult = await page.evaluate(async () => {
  // 找函数 P$ = 注册 userId hook
  // 找函数 t5 = signedFetch
  let webpackRequire = null;
  const chunk = window.webpackChunk_N_E || [];
  for (const item of chunk) {
    const arr = Array.isArray(item) ? item : [];
    for (const sub of arr) {
      if (Array.isArray(sub) && sub.length >= 3 && typeof sub[2] === 'function') {
        try { sub[2]({ d: () => {} }, {}, (req) => { webpackRequire = req; }); } catch {}
      }
    }
  }
  if (!webpackRequire) return { error: 'no webpack' };
  // 强制 require 模块 1918（wasm 加载）
  try {
    const m = await webpackRequire.e(1918);
    const mod = await webpackRequire(1918);
    console.log('module 1918 loaded:', Object.keys(mod));
    // 触发 init
    if (mod.default) {
      await mod.default('/wasm/hdh_security_bg.wasm');
      const pub = mod.init();
      return { ok: true, pub: Array.from(pub || []), exports: Object.keys(mod) };
    }
    return { ok: false, mod };
  } catch (e) {
    return { error: e.message };
  }
});

console.log('Trigger result:', JSON.stringify(triggerResult, null, 2));
console.log('Triggered URLs:', triggered);

await context.close();