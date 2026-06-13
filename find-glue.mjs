#!/usr/bin/env node
// 通过浏览器拦截实际加载 wasm 胶水的 chunk URL
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-glue2-${Date.now()}`);
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

const chunkUrls = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/_next/static/chunks/') || url.includes('hdh_security_bg')) {
    chunkUrls.push(url);
  }
});

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(5000);

// 找出包含 wasm 胶水的 chunk
for (const url of chunkUrls) {
  if (url.includes('.js')) {
    const text = await page.evaluate(async (u) => {
      const r = await fetch(u);
      const t = await r.text();
      return { len: t.length, hasInit: t.includes('hdh_security_bg'), hasFinalize: t.includes('finalizeHandshake') };
    }, url).catch(() => null);
    if (text) console.log(url.replace(BASE, ''), text);
  }
}

await context.close();