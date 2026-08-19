#!/usr/bin/env node
// 使用 api-client.mjs 的完整 stealth 脚本登录。
// 只有通过当前用户接口验证后，才输出 cookie + bindSecret 文件。
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { HdhiveClient, STEALTH_SCRIPT } from './api-client.mjs';
import {
  classifyClientError,
  classifyLoginPage,
  classifyValidationResponse,
} from './login-diagnostics.mjs';

const BASE = process.env.HDHIVE_BASE_URL || 'https://hdhive.com';
const PROXY = process.env.HDHIVE_PROXY || process.env.BROWSER_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
const USERNAME = process.argv[2] || process.env.HDHIVE_USERNAME || '';
const PASSWORD = process.argv[3] || process.env.HDHIVE_PASSWORD || '';
const COOKIE_FILE = process.env.HDHIVE_COOKIE_FILE || '/tmp/hdhive-cookies.txt';
const BIND_SECRET_FILE = process.env.HDHIVE_BIND_SECRET_FILE || '/tmp/hdhive-bind-secret.txt';
const REQUIRED_COOKIE_NAMES = ['token', 'csrf_access_token', 'hdh_uid', 'hdh_sa_token'];

function removeOutputFiles() {
  for (const file of [COOKIE_FILE, BIND_SECRET_FILE]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

async function readBindSecret(page) {
  return page.evaluate(async () => {
    const readIdb = () => new Promise((resolve) => {
      try {
        const req = indexedDB.open('hdh-secure-bind', 1);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          try {
            const db = req.result;
            if (!db.objectStoreNames.contains('bind')) return resolve(null);
            const tx = db.transaction('bind', 'readonly');
            const get = tx.objectStore('bind').get('bindSecret');
            get.onsuccess = () => resolve(typeof get.result === 'string' ? get.result : null);
            get.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        };
      } catch {
        resolve(null);
      }
    });

    const fromIdb = await readIdb();
    if (fromIdb) return fromIdb;
    try {
      return sessionStorage.getItem('hdh:secure-client:bind-secret');
    } catch {
      return null;
    }
  });
}

async function readPageText(page) {
  return page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
}

async function validateCredentials(cookieHeader, bindSecret) {
  const client = new HdhiveClient({
    baseUrl: BASE,
    cookie: cookieHeader,
    bindSecret,
    proxy: PROXY,
  });
  try {
    const response = await client.getCurrentUser();
    const errorCode = classifyValidationResponse(response);
    return errorCode ? { ok: false, errorCode } : { ok: true };
  } catch (error) {
    return { ok: false, errorCode: classifyClientError(error) };
  } finally {
    await client.close();
  }
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('HDHIVE_LOGIN_ERROR=configuration_error');
    return 1;
  }

  removeOutputFiles();
  const profileDir = path.join(os.tmpdir(), `hdhive-login-${Date.now()}`);
  let context;

  try {
    const launchOptions = {
      headless: true,
      viewport: { width: 1366, height: 768 },
      screen: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768',
        '--lang=zh-CN'
      ]
    };
    if (PROXY) {
      launchOptions.proxy = { server: PROXY.replace(/^socks5h:/i, 'socks5:') };
    }

    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    await context.addInitScript(STEALTH_SCRIPT);

    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);

    let found = false;
    for (let i = 0; i < 40; i += 1) {
      if (await page.locator('input[type="password"]').count().catch(() => 0) > 0) {
        found = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (!found) {
      const pageText = await readPageText(page);
      throw new Error(`login:${classifyLoginPage({ url: page.url(), bodyText: pageText })}`);
    }

    await page.locator('input[name="username"], input[type="email"], input[type="text"], #username').first().fill(USERNAME);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    const submit = page.locator('button[type="submit"], button:has-text("登录")').first();
    if (await submit.count() > 0) await submit.click();
    else await page.locator('input[type="password"]').first().press('Enter');

    let cookies = [];
    let bindSecret = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      cookies = await context.cookies(BASE);
      const names = new Set(cookies.map(cookie => cookie.name));
      bindSecret = await readBindSecret(page).catch(() => null);
      const hasAuthCookies = REQUIRED_COOKIE_NAMES.every(name => names.has(name));
      if (hasAuthCookies && bindSecret) break;

      const pageText = await readPageText(page);
      const pageError = classifyLoginPage({
        url: page.url(),
        bodyText: pageText,
        hasAuthCookies,
      });
      if (pageError !== 'login_failed' || /登录|login/i.test(page.url())) {
        if (pageError === 'verification_required' || pageError === 'access_blocked') {
          throw new Error(`login:${pageError}`);
        }
      }
    }

    const names = new Set(cookies.map(cookie => cookie.name));
    if (!REQUIRED_COOKIE_NAMES.every(name => names.has(name))) {
      const pageText = await readPageText(page);
      const errorCode = classifyLoginPage({
        url: page.url(),
        bodyText: pageText,
        hasAuthCookies: false,
      });
      throw new Error(`login:${errorCode}`);
    }
    if (!bindSecret) throw new Error('login:incomplete_login_result');

    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const validation = await validateCredentials(cookieHeader, bindSecret);
    if (!validation.ok) throw new Error(`validation:${validation.errorCode}`);

    fs.writeFileSync(COOKIE_FILE, cookieHeader, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(BIND_SECRET_FILE, bindSecret, { encoding: 'utf8', mode: 0o600 });
    console.log('HDHIVE_LOGIN_STATUS=authenticated');
    return 0;
  } catch (error) {
    removeOutputFiles();
    const detail = String(error?.message || error || '');
    const [, stage, code] = detail.match(/^(login|validation):([a-z_]+)$/) || [];
    const errorCode = code || classifyClientError(error);
    console.error(`HDHIVE_LOGIN_ERROR=${errorCode}`);
    if (stage === 'validation' && errorCode === 'credentials_expired') {
      console.error('HDHIVE_LOGIN_DETAIL=validated_user_endpoint_returned_401');
    }
    return 1;
  } finally {
    if (context) await context.close().catch(() => {});
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

process.exitCode = await main();
