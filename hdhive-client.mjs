// hdhive-client.mjs
// 纯 Node.js 影巢 API 客户端（不依赖账号密码，使用 cookie）
// 通过直接加载 wasm 模块 + 胶水代码实现 ECDH+HMAC 签名
//
// 用法：
//   import { HdhiveClient } from './hdhive-client.mjs';
//   const client = new HdhiveClient({ cookie: '...' });
//   await client.handshake();
//   const user = await client.get('/api/customer/user/current');

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WASM_PATH = path.join(__dirname, 'node_modules', 'hdh-security.wasm');
// 用户需自行下载 wasm 文件：curl -Lo node_modules/hdh-security.wasm https://hdhive.com/wasm/hdh_security_bg.wasm
const WASM_URL = 'https://hdhive.com/wasm/hdh_security_bg.wasm';

const GLUE_SRC = fs.readFileSync('/tmp/hdh-wasm-glue-full.js', 'utf8');

/**
 * 加载 wasm 并构造工厂函数
 */
async function loadWasmModule() {
  // 1. 加载 wasm 字节
  let wasmBytes;
  if (fs.existsSync(WASM_PATH)) {
    wasmBytes = fs.readFileSync(WASM_PATH);
  } else {
    console.error(`[hdhive-client] 未找到 ${WASM_PATH}`);
    console.error(`[hdhive-client] 请先执行: curl -Lo ${WASM_PATH} ${WASM_URL}`);
    throw new Error('WASM module not found');
  }

  // 2. 实例化 wasm（导入 ./hdh_security_bg.js 中的桥接函数）
  const imports = {
    './hdh_security_bg.js': {
      __wbg_Error_ef53bc310eb298a0: (e, n) => new Error(`wasm-error-${e}-${n}`),
      __wbg___wbindgen_is_function_754e9f305ff6029e: (e) => typeof e === 'function',
      __wbg___wbindgen_is_object_56732c2bc353f41d: (e) => typeof e === 'object' && e !== null,
      __wbg___wbindgen_is_string_c236cabd84a4d769: (e) => typeof e === 'string',
      __wbg___wbindgen_is_undefined_67b456be8673d3d7: (e) => e === undefined,
      __wbg___wbindgen_throw_1506f2235d1bdba0: (e, n) => { throw new Error(`wasm-throw-${e}-${n}`); },
      __wbg_call_9c758de292015997: () => 0,
      __wbg_crypto_38df2bab126b63dc: (e) => e?.crypto,
      __wbg_getRandomValues_c44a50d8cfdaebeb: (arr) => crypto.getRandomValues(arr),
      __wbg_length_4a591ecaa01354d9: (e) => e?.length || 0,
      __wbg_msCrypto_bd5a034af96bcba6: (e) => e?.msCrypto,
      __wbg_new_with_length_36a4998e27b014c5: (n) => new Uint8Array(n),
      __wbg_node_84ea875411254db1: (e) => e?.node,
      __wbg_process_44c7a14e11e9f69e: (e) => e?.process,
      __wbg_prototypesetcall_3249fc62a0fafa30: (dst, src, val) => {
        Uint8Array.prototype.set.call(dst, val);
      },
      __wbg_randomFillSync_6c25eac9869eb53c: (arr) => crypto.getRandomValues(arr),
      __wbg_require_b4edbdcf3e2a1ef0: () => null,
      __wbg_static_accessor_GLOBAL_9d53f2689e622ca1: () => globalThis,
      __wbg_static_accessor_GLOBAL_THIS_a1a35cec07001a8a: () => globalThis,
      __wbg_static_accessor_SELF_4c59f6c7ea29a144: () => globalThis,
      __wbg_static_accessor_WINDOW_e70ae9f2eb052253: () => undefined,
      __wbg_subarray_4aa221f6a4f5ab22: (e, n, t) => e.subarray(n, t),
      __wbg_versions_276b2795b1c6a219: (e) => e?.versions || {},
      __wbindgen_cast_0000000000000001: (e, n) => e,
      __wbindgen_cast_0000000000000002: (e, n) => e,
      __wbindgen_object_clone_ref: (e) => e,
      __wbindgen_object_drop_ref: (e) => e
    }
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const exports = instance.exports;
  // exports 包含：memory, init, finalizeHandshake, signRequest, verifyResponse, __wbindgen_* 辅助函数
  return exports;
}

/**
 * 影巢 API 客户端
 */
export class HdhiveClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://hdhive.com').replace(/\/$/, '');
    this.cookie = options.cookie || ''; // 注入已登录 cookie
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.wasm = null;
    this.session = null; // { cid, expiresAt }
    this.clockSkewMs = 0; // 服务器时间差
  }

  async _ensureWasm() {
    if (!this.wasm) this.wasm = await loadWasmModule();
    return this.wasm;
  }

  /**
   * 计算 ua_fingerprint = SHA-256(`${userAgent}|${languages}`)
   */
  async _uaFingerprint(userAgent, languages) {
    const text = `${userAgent || ''}|${(languages || []).join(',')}`;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 16 字节十六进制随机数
   */
  _newNonce() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 完成握手，建立 ECDH 会话
   */
  async handshake() {
    await this._ensureWasm();

    // 1. 调用 init() 生成客户端 X25519 密钥对
    const clientPub = this.wasm.init();
    // clientPub: Uint8Array(32)

    // 2. base64 编码
    const clientPubB64 = Buffer.from(clientPub).toString('base64');

    // 3. ua_fingerprint
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || 'Mozilla/5.0 (compatible; HdhiveClient/1.0)';
    const langs = (typeof navigator !== 'undefined' && navigator.languages) || ['zh-CN', 'zh'];
    const fingerprint = await this._uaFingerprint(ua, langs);

    // 4. ts
    const ts = Date.now();

    // 5. POST 握手请求
    const res = await this._rawFetch(`${this.baseUrl}/api/public/security/session/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_pub: clientPubB64, ua_fingerprint: fingerprint, ts })
    });
    if (!res.ok) {
      throw new Error(`handshake HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const json = await res.json();
    if (!json.success || !json.data) {
      throw new Error(`handshake failed: ${json.message || json.error?.message || 'unknown'}`);
    }

    const { cid, server_pub, expires_at } = json.data;
    const serverPubBytes = Buffer.from(server_pub, 'base64');
    if (serverPubBytes.length !== 32) {
      throw new Error(`invalid server_pub length: ${serverPubBytes.length}`);
    }

    // 6. finalizeHandshake(cid, server_pub_bytes, kid=1)
    this.wasm.finalizeHandshake(cid, serverPubBytes, 1);

    this.session = {
      cid,
      expiresAt: expires_at * 1000
    };
    return this.session;
  }

  /**
   * 调用校时接口（处理时钟漂移）
   */
  async syncTime() {
    const res = await this._rawFetch(`${this.baseUrl}/api/public/security/time`, { method: 'GET' });
    if (!res.ok) throw new Error(`sync time HTTP ${res.status}`);
    const json = await res.json();
    const serverMs = json.data?.server_time_ms;
    if (typeof serverMs !== 'number') throw new Error('invalid time response');
    this.clockSkewMs = serverMs - Date.now();
    return this.clockSkewMs;
  }

  /**
   * 计算请求签名（自动管理 handshake 过期与重试）
   */
  async _signRequest(method, path, body) {
    await this._ensureWasm();

    // 检查 session 过期
    if (!this.session || Date.now() > this.session.expiresAt - 60_000) {
      await this.handshake();
    }

    // body 编码为 Uint8Array
    const bodyBytes = body == null ? new Uint8Array(0)
      : typeof body === 'string' ? new TextEncoder().encode(body)
      : body instanceof Uint8Array ? body
      : new TextEncoder().encode(JSON.stringify(body));

    const ts = String(Date.now() + this.clockSkewMs);
    const nonce = this._newNonce();

    // getUserId：尝试从 cookie 中读 hdh_uid，否则 "0"
    let userId = '0';
    if (this.cookie) {
      const m = this.cookie.match(/(?:^|;\s*)hdh_uid=([^;]+)/);
      if (m && /^[1-9]\d*$/.test(m[1])) userId = m[1];
    }

    // signRequest(method, path, ts, nonce, body, userId)
    // 返回值是 hex 字符串（64 字符）
    const sig = this.wasm.signRequest(method, path, ts, nonce, bodyBytes, userId);

    return {
      'X-HDH-Cid': this.session.cid,
      'X-HDH-TS': ts,
      'X-HDH-Nonce': nonce,
      'X-HDH-Sig': sig,
      'X-HDH-Kid': '1'
    };
  }

  /**
   * 原始 fetch（不带签名，但带 cookie）
   */
  async _rawFetch(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (this.cookie) headers.set('cookie', this.cookie);
    // CSRF token（如果有）
    if (this.cookie) {
      const m = this.cookie.match(/(?:^|;\s*)csrf_access_token=([^;]+)/);
      if (m) headers.set('x-csrf-token', decodeURIComponent(m[1]));
    }
    return this.fetchImpl(url, { ...init, headers });
  }

  /**
   * 签名请求（带自动重试）
   */
  async _signedFetch(method, path, { query, body, _retry } = {}) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const bodyStr = body == null ? null
      : typeof body === 'string' ? body
      : JSON.stringify(body);
    const bodyBytes = bodyStr == null ? null : new TextEncoder().encode(bodyStr);

    const sigHeaders = await this._signRequest(method, url.pathname + url.search, bodyBytes || new Uint8Array(0));

    const headers = new Headers();
    headers.set('accept', 'application/json');
    if (bodyStr != null) headers.set('content-type', 'application/json');
    for (const [k, v] of Object.entries(sigHeaders)) headers.set(k, v);

    const res = await this._rawFetch(url.toString(), {
      method,
      headers,
      body: bodyStr || undefined,
      credentials: 'include'
    });

    // 401 会话失效 → 重握手重试
    if (res.status === 401 && !_retry) {
      let code = '';
      try {
        const j = await res.clone().json();
        code = j?.code;
      } catch {}
      if (['invalid_session', 'missing_signature', 'stale_ts', 'replay', 'signature_invalid'].includes(code)) {
        this.session = null;
        if (code === 'stale_ts') await this.syncTime().catch(() => {});
        return this._signedFetch(method, path, { query, body, _retry: true });
      }
    }
    return res;
  }

  /**
   * 通用调用方法
   */
  async call(method, path, { query, body } = {}) {
    const res = await this._signedFetch(method, path, { query, body });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), data: json };
  }

  // 便捷方法
  get(path, query) { return this.call('GET', path, { query }); }
  post(path, body, query) { return this.call('POST', path, { body, query }); }
  put(path, body) { return this.call('PUT', path, { body }); }
  delete(path) { return this.call('DELETE', path); }
}

// 便捷导出
export default HdhiveClient;