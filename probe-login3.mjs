#!/usr/bin/env node
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'https://hdhive.com';
const profileDir = path.join(os.tmpdir(), `hdhive-probe-${Date.now()}`);
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
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = window.chrome || { runtime: {} };
});

const page = context.pages()[0] || await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(5000);

console.log('[step] 打开 login 页面');
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(20000);

// 输出整个 body 文本和结构
const final = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body?.innerText?.slice(0, 600),
  inputCount: document.querySelectorAll('input').length,
  formCount: document.querySelectorAll('form').length,
  htmlSnippet: document.body?.innerHTML?.slice(0, 1500)
}));
console.log('URL:', final.url);
console.log('Body:', final.bodyText);
console.log('Inputs:', final.inputCount, 'Forms:', final.formCount);
console.log('HTML:', final.htmlSnippet);

await context.close();