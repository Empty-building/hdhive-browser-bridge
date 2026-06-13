#!/usr/bin/env node
// 检查登录页状态
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
});

const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
});

const page = await context.newPage();
await page.goto('https://hdhive.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const bodyText = document.body?.innerText || '';
  const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
    type: i.type, name: i.name, placeholder: i.placeholder, autocomplete: i.autocomplete
  }));
  return {
    title: document.title,
    url: location.href,
    bodyText: bodyText.slice(0, 800),
    inputCount: inputs.length,
    inputs
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();