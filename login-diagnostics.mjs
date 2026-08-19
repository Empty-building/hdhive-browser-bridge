const AUTH_ERROR_TERMS = /验证码|人机|安全验证|二次验证|两步验证|captcha|turnstile|challenge/i;
const BLOCKED_TERMS = /cloudflare|access denied|forbidden|blocked|rate limit|请求被限制|访问被拒绝|频繁/i;
const CREDENTIAL_ERROR_TERMS = /账号或密码|用户名或密码|密码错误|登录失败|invalid credential|incorrect password|wrong password/i;

export function classifyLoginPage({ url = '', bodyText = '', hasAuthCookies = false } = {}) {
  if (hasAuthCookies) return null;
  const text = `${url}\n${bodyText}`;
  if (AUTH_ERROR_TERMS.test(text)) return 'verification_required';
  if (BLOCKED_TERMS.test(text)) return 'access_blocked';
  if (CREDENTIAL_ERROR_TERMS.test(text)) return 'login_failed';
  return 'login_failed';
}

export function classifyClientError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (/captcha|验证码|challenge|二次验证|两步验证/.test(text)) return 'verification_required';
  if (/http\s*401|unauthorized|session_user_mismatch|invalid_session|请重新登录/.test(text)) {
    return 'credentials_expired';
  }
  if (/http\s*(403|429)|cloudflare|access denied|forbidden|blocked|rate limit/.test(text)) {
    return 'access_blocked';
  }
  if (/timeout|timed out|network|fetch|socket|econn|proxy|dns/.test(text)) {
    return 'network_error';
  }
  if (/handshake|wasm|signedfetch|signature|签名|工作量证明|proof of work/.test(text)) {
    return 'protocol_error';
  }
  return 'login_failed';
}

export function classifyValidationResponse(response) {
  const status = Number(response?.status || 0);
  if (status === 401) return 'credentials_expired';
  if (status === 403 || status === 429) return 'access_blocked';
  if (status >= 500) return 'service_error';
  if (status >= 400 || response?.ok === false) return 'login_failed';
  if (status < 200 || status >= 300) return 'protocol_error';

  const data = response?.data;
  if (data && typeof data === 'object' && data.success === false) return 'login_failed';
  return null;
}
