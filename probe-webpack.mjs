#!/usr/bin/env node
// 调试 webpack require 提取
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-debug-${Date.now()}`);
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
await page.waitForTimeout(8000);

const info = await page.evaluate(() => {
  const chunk = window.webpackChunk_N_E;
  const result = {
    hasChunk: !!chunk,
    isArray: Array.isArray(chunk),
    len: chunk?.length,
    sample: chunk?.slice(0, 3).map(c => ({
      isArray: Array.isArray(c),
      subTypes: Array.isArray(c) ? c.map(s => typeof s) : []
    }))
  };

  // 尝试 push 探测
  let webpackRequire = null;
  try {
    chunk.push([['__probe__'], {}, (req) => { webpackRequire = req; }]);
    result.pushWorked = !!webpackRequire;
    if (webpackRequire) {
      result.reqKeys = Object.keys(webpackRequire).slice(0, 10);
      result.hasM = !!webpackRequire.m;
      result.mKeys = webpackRequire.m ? Object.keys(webpackRequire.m).slice(-20) : null;
      // 找 wasm / handshake / signedFetch 相关的模块
      const sigMods = [];
      for (const [id, factory] of Object.entries(webpackRequire.m || {})) {
        const src = String(factory);
        if (src.includes('hdh_security_bg') || src.includes('signRequest') || src.includes('signedFetch') || src.includes('finalizeHandshake') || src.includes('session/handshake') || src.includes('client_pub')) {
          sigMods.push({ id, len: src.length, preview: src.slice(0, 100) });
        }
      }
      result.sigMods = sigMods;
    }
  } catch (e) {
    result.pushError = e.message;
  }

  return result;
});

console.log(JSON.stringify(info, null, 2));
await context.close();