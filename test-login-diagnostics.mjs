#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  classifyClientError,
  classifyLoginPage,
  classifyValidationResponse,
} from './login-diagnostics.mjs';

assert.equal(
  classifyLoginPage({ bodyText: '请完成验证码验证' }),
  'verification_required',
);
assert.equal(
  classifyLoginPage({ bodyText: '账号或密码错误' }),
  'login_failed',
);
assert.equal(
  classifyLoginPage({ bodyText: '登录成功', hasAuthCookies: true }),
  null,
);
assert.equal(
  classifyValidationResponse({ status: 401, ok: false }),
  'credentials_expired',
);
assert.equal(
  classifyValidationResponse({ status: 200, ok: true, data: { success: true } }),
  null,
);
assert.equal(
  classifyValidationResponse({ status: 200, ok: true, data: { success: false } }),
  'login_failed',
);
assert.equal(
  classifyClientError(new Error('handshake failed HTTP 400')),
  'protocol_error',
);

console.log('HDHive login diagnostics tests passed');
