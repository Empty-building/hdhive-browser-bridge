// pure-api-client.mjs
// 纯 Node.js 影巢 API 客户端（不依赖 Playwright / 浏览器）
// 逆向实现：X25519 ECDH handshake + WASM signRequest + bind_token
// 现有 api-client.mjs / server.mjs 保持不动。
//
// 用法：
//   import { PureHdhiveClient } from './pure-api-client.mjs';
//   const client = new PureHdhiveClient({
//     cookie: fs.readFileSync('/tmp/hdhive-cookies.txt','utf8').trim(),
//     bindSecret: fs.readFileSync('/tmp/hdhive-bind-secret.txt','utf8').trim(),
//     proxy: 'socks5://127.0.0.1:1081',
//   });
//   await client.handshake();
//   console.log(await client.get('/api/customer/user/current'));

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { webcrypto as nodeCrypto, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = [path.join(__dirname, 'vendor', 'hdh-security.wasm'), path.join(__dirname, 'node_modules', 'hdh-security.wasm')].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || path.join(__dirname, 'vendor', 'hdh-security.wasm');
const DEFAULT_WASM_URL = 'https://hdhive.com/wasm/hdh_security_bg.wasm';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_LANGS = ['zh-CN', 'zh'];

// 需要校验响应签名的路径（与 webpack 39154 一致）
const RESPONSE_SIG_EXACT = new Set([
  '/api/customer/user/checkin',
  '/api/customer/user/change-email/send-current-code',
  '/api/customer/user/change-email/verify-current-code',
  '/api/customer/user/change-email',
  '/api/customer/user/change-password',
  '/api/customer/vip/redeem',
  '/api/customer/user/current',
  '/api/customer/points-logs'
]);
const RESPONSE_SIG_UNLOCK = [
  { prefix: '/api/customer/resources/', suffix: '/unlock' },
  { prefix: '/api/customer/music_resources/', suffix: '/unlock' },
  { prefix: '/api/customer/tv-follow/packs/', suffix: '/unlock' }
];
const SESSION_RETRY_CODES = new Set([
  'invalid_session',
  'missing_signature',
  'signature_invalid',
  'session_user_mismatch'
]);

function ensureCrypto() {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
      value: nodeCrypto,
      configurable: true
    });
  }
  return globalThis.crypto;
}

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  const raw = String(proxyUrl).trim();
  if (!raw) return null;
  // socks5://host:port 或 socks5h://host:port 或 host:port
  const withScheme = /:\/\//.test(raw) ? raw : `socks5://${raw}`;
  const u = new URL(withScheme);
  const protocol = u.protocol.replace(':', '').toLowerCase();
  return {
    protocol, // socks5 / socks5h / http / https
    host: u.hostname,
    port: Number(u.port || (/socks/.test(protocol) ? 1080 : 8080)),
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || '')
  };
}

/**
 * 原生 SOCKS5 CONNECT（无第三方依赖）
 */
function socks5Connect({ proxy, targetHost, targetPort, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error('socks5 proxy timeout')));
    socket.once('error', fail);

    const auth = Boolean(proxy.username);
    // greeting
    socket.write(Buffer.from(auth ? [0x05, 0x01, 0x02] : [0x05, 0x01, 0x00]));

    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) return fail(new Error(`socks5 bad version ${buf[0]}`));
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0x02) {
            stage = 'auth';
            const user = Buffer.from(proxy.username || '', 'utf8');
            const pass = Buffer.from(proxy.password || '', 'utf8');
            socket.write(Buffer.concat([
              Buffer.from([0x01, user.length]),
              user,
              Buffer.from([pass.length]),
              pass
            ]));
            return;
          }
          if (method !== 0x00) return fail(new Error(`socks5 unsupported auth method ${method}`));
          stage = 'connect';
          writeConnect();
          return;
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) return fail(new Error(`socks5 auth failed code=${buf[1]}`));
          buf = buf.subarray(2);
          stage = 'connect';
          writeConnect();
          return;
        }
        if (stage === 'connect') {
          if (buf.length < 5) return;
          if (buf[0] !== 0x05) return fail(new Error('socks5 connect bad version'));
          if (buf[1] !== 0x00) return fail(new Error(`socks5 connect failed code=${buf[1]}`));
          const atyp = buf[3];
          let need = 4;
          if (atyp === 0x01) need += 4 + 2;
          else if (atyp === 0x03) {
            if (buf.length < 5) return;
            need += 1 + buf[4] + 2;
          } else if (atyp === 0x04) need += 16 + 2;
          else return fail(new Error(`socks5 bad atyp ${atyp}`));
          if (buf.length < need) return;
          // 连接成功：把残留数据塞回 socket 可读流（通常没有）
          const rest = buf.subarray(need);
          socket.removeAllListeners('data');
          socket.setTimeout(0);
          if (rest.length) socket.unshift(rest);
          ok(socket);
        }
      } catch (e) {
        fail(e);
      }
    });

    function writeConnect() {
      const hostBuf = Buffer.from(targetHost, 'utf8');
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 0x05;
      req[1] = 0x01; // CONNECT
      req[2] = 0x00;
      req[3] = 0x03; // domain
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hostBuf.length);
      socket.write(req);
    }
  });
}

/**
 * HTTP CONNECT 代理
 */
function httpConnect({ proxy, targetHost, targetPort, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error('http proxy timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      let auth = '';
      if (proxy.username) {
        auth = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`;
      }
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.subarray(0, idx).toString('utf8');
      const rest = buf.subarray(idx + 4);
      const m = head.match(/^HTTP\/\d\.\d\s+(\d+)/);
      if (!m || Number(m[1]) !== 200) {
        return fail(new Error(`http proxy CONNECT failed: ${head.split('\r\n')[0]}`));
      }
      socket.removeAllListeners('data');
      socket.setTimeout(0);
      if (rest.length) socket.unshift(rest);
      if (!settled) {
        settled = true;
        resolve(socket);
      }
    });
  });
}

async function openProxySocket(proxy, targetHost, targetPort) {
  if (!proxy) {
    return net.connect({ host: targetHost, port: targetPort });
  }
  if (/^socks/.test(proxy.protocol)) {
    return socks5Connect({ proxy, targetHost, targetPort });
  }
  if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    return httpConnect({ proxy, targetHost, targetPort });
  }
  throw new Error(`unsupported proxy protocol: ${proxy.protocol}`);
}

/**
 * 基于 webpack 模块 1918 还原的 wasm-bindgen 胶水
 */
async function loadWasmApi(wasmPath = DEFAULT_WASM_PATH) {
  ensureCrypto();
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM not found: ${wasmPath} (download ${DEFAULT_WASM_URL})`);
  }
  const wasmBytes = fs.readFileSync(wasmPath);

  let wasm;
  let cachedDataView = null;
  let cachedUint8 = null;
  const heap = Array(1024).fill(undefined);
  heap.push(undefined, null, true, false);
  let heapNext = heap.length;
  let textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  textDecoder.decode();
  const textEncoder = new TextEncoder();
  let WASM_VECTOR_LEN = 0;

  function getDataView() {
    if (cachedDataView === null || cachedDataView.buffer !== wasm.memory.buffer) {
      cachedDataView = new DataView(wasm.memory.buffer);
    }
    return cachedDataView;
  }
  function getUint8() {
    if (cachedUint8 === null || cachedUint8.byteLength === 0) {
      cachedUint8 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8;
  }
  function addHeapObject(obj) {
    if (heapNext === heap.length) heap.push(heap.length + 1);
    const idx = heapNext;
    heapNext = heap[idx];
    heap[idx] = obj;
    return idx;
  }
  function getObject(idx) {
    return heap[idx];
  }
  function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heapNext;
    heapNext = idx;
  }
  function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
  }
  function getStringFromWasm(ptr, len) {
    ptr >>>= 0;
    return textDecoder.decode(getUint8().subarray(ptr, ptr + len));
  }
  function getArrayU8FromWasm(ptr, len) {
    ptr >>>= 0;
    return getUint8().subarray(ptr / 1, ptr / 1 + len);
  }
  function passStringToWasm(arg, malloc, realloc) {
    if (realloc === undefined) {
      const buf = textEncoder.encode(String(arg));
      const ptr = malloc(buf.length, 1) >>> 0;
      getUint8().subarray(ptr, ptr + buf.length).set(buf);
      WASM_VECTOR_LEN = buf.length;
      return ptr;
    }
    let len = String(arg).length;
    let ptr = malloc(len, 1) >>> 0;
    const mem = getUint8();
    let offset = 0;
    const str = String(arg);
    for (; offset < len; offset += 1) {
      const code = str.charCodeAt(offset);
      if (code > 0x7f) break;
      mem[ptr + offset] = code;
    }
    if (offset !== len) {
      let rest = offset !== 0 ? str.slice(offset) : str;
      ptr = realloc(ptr, len, (len = offset + rest.length * 3), 1) >>> 0;
      const view = getUint8().subarray(ptr + offset, ptr + len);
      const ret = textEncoder.encodeInto(rest, view);
      offset += ret.written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }
    WASM_VECTOR_LEN = offset;
    return ptr;
  }
  function passArray8ToWasm(arg, malloc) {
    const ptr = malloc(arg.length, 1) >>> 0;
    getUint8().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
  }
  function handleError(fn, args) {
    try {
      return fn.apply(this, args);
    } catch (e) {
      wasm.__wbindgen_export(addHeapObject(e));
    }
  }

  const cryptoObj = ensureCrypto();
  const imports = {
    './hdh_security_bg.js': {
      __wbg_Error_ef53bc310eb298a0: (ptr, len) => addHeapObject(new Error(getStringFromWasm(ptr, len))),
      __wbg___wbindgen_is_function_754e9f305ff6029e: (idx) => typeof getObject(idx) === 'function',
      __wbg___wbindgen_is_object_56732c2bc353f41d: (idx) => {
        const v = getObject(idx);
        return typeof v === 'object' && v !== null;
      },
      __wbg___wbindgen_is_string_c236cabd84a4d769: (idx) => typeof getObject(idx) === 'string',
      __wbg___wbindgen_is_undefined_67b456be8673d3d7: (idx) => getObject(idx) === undefined,
      __wbg___wbindgen_throw_1506f2235d1bdba0: (ptr, len) => {
        throw new Error(getStringFromWasm(ptr, len));
      },
      __wbg_call_9c758de292015997: function () {
        return handleError(function (arg0, arg1, arg2) {
          return addHeapObject(getObject(arg0).call(getObject(arg1), getObject(arg2)));
        }, arguments);
      },
      __wbg_crypto_38df2bab126b63dc: (idx) => addHeapObject(getObject(idx).crypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: function () {
        return handleError(function (arg0, arg1) {
          getObject(arg0).getRandomValues(getObject(arg1));
        }, arguments);
      },
      __wbg_length_4a591ecaa01354d9: (idx) => getObject(idx).length,
      __wbg_msCrypto_bd5a034af96bcba6: (idx) => addHeapObject(getObject(idx).msCrypto),
      __wbg_new_with_length_36a4998e27b014c5: (n) => addHeapObject(new Uint8Array(n >>> 0)),
      __wbg_node_84ea875411254db1: (idx) => addHeapObject(getObject(idx).node),
      __wbg_process_44c7a14e11e9f69e: (idx) => addHeapObject(getObject(idx).process),
      __wbg_prototypesetcall_3249fc62a0fafa30: (ptr, len, idx) => {
        Uint8Array.prototype.set.call(getArrayU8FromWasm(ptr, len), getObject(idx));
      },
      __wbg_randomFillSync_6c25eac9869eb53c: function () {
        return handleError(function (arg0, arg1) {
          getObject(arg0).randomFillSync(takeObject(arg1));
        }, arguments);
      },
      __wbg_require_b4edbdcf3e2a1ef0: function () {
        return handleError(function () {
          return addHeapObject({
            randomFillSync(buf) {
              const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
              cryptoObj.getRandomValues(u8);
              return buf;
            }
          });
        }, arguments);
      },
      __wbg_static_accessor_GLOBAL_9d53f2689e622ca1: () => 0,
      __wbg_static_accessor_GLOBAL_THIS_a1a35cec07001a8a: () => addHeapObject(globalThis),
      __wbg_static_accessor_SELF_4c59f6c7ea29a144: () => 0,
      __wbg_static_accessor_WINDOW_e70ae9f2eb052253: () => 0,
      __wbg_subarray_4aa221f6a4f5ab22: (idx, a, b) =>
        addHeapObject(getObject(idx).subarray(a >>> 0, b >>> 0)),
      __wbg_versions_276b2795b1c6a219: (idx) => addHeapObject(getObject(idx).versions || {}),
      __wbindgen_cast_0000000000000001: (ptr, len) =>
        addHeapObject(getArrayU8FromWasm(ptr, len).slice()),
      __wbindgen_cast_0000000000000002: (ptr, len) => addHeapObject(getStringFromWasm(ptr, len)),
      __wbindgen_object_clone_ref: (idx) => addHeapObject(getObject(idx)),
      __wbindgen_object_drop_ref: (idx) => dropObject(idx)
    }
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  wasm = instance.exports;
  cachedDataView = null;
  cachedUint8 = null;

  function init() {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      wasm.init(retptr);
      const r0 = getDataView().getInt32(retptr + 0, true);
      const r1 = getDataView().getInt32(retptr + 4, true);
      const r2 = getDataView().getInt32(retptr + 8, true);
      const r3 = getDataView().getInt32(retptr + 12, true);
      if (r3) throw takeObject(r2);
      const v = getArrayU8FromWasm(r0, r1).slice();
      wasm.__wbindgen_export4(r0, r1 * 1, 1);
      return v;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  function finalizeHandshake(cid, serverPub, kid = 1) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const ptr0 = passStringToWasm(cid, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const len0 = WASM_VECTOR_LEN;
      const ptr1 = passArray8ToWasm(serverPub, wasm.__wbindgen_export2);
      const len1 = WASM_VECTOR_LEN;
      wasm.finalizeHandshake(retptr, ptr0, len0, ptr1, len1, kid);
      const r0 = getDataView().getInt32(retptr + 0, true);
      const r1 = getDataView().getInt32(retptr + 4, true);
      if (r1) throw takeObject(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  function signRequest(method, pathName, ts, nonce, body, userId) {
    let deferredPtr = 0;
    let deferredLen = 0;
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const p0 = passStringToWasm(method, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l0 = WASM_VECTOR_LEN;
      const p1 = passStringToWasm(pathName, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l1 = WASM_VECTOR_LEN;
      const p2 = passStringToWasm(ts, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l2 = WASM_VECTOR_LEN;
      const p3 = passStringToWasm(nonce, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l3 = WASM_VECTOR_LEN;
      const p4 = passArray8ToWasm(body, wasm.__wbindgen_export2);
      const l4 = WASM_VECTOR_LEN;
      const p5 = passStringToWasm(userId, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l5 = WASM_VECTOR_LEN;
      wasm.signRequest(retptr, p0, l0, p1, l1, p2, l2, p3, l3, p4, l4, p5, l5);
      const r0 = getDataView().getInt32(retptr + 0, true);
      const r1 = getDataView().getInt32(retptr + 4, true);
      const r2 = getDataView().getInt32(retptr + 8, true);
      const r3 = getDataView().getInt32(retptr + 12, true);
      let ptr = r0;
      let len = r1;
      if (r3) {
        ptr = 0;
        len = 0;
        throw takeObject(r2);
      }
      deferredPtr = ptr;
      deferredLen = len;
      return getStringFromWasm(ptr, len);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbindgen_export4(deferredPtr, deferredLen, 1);
    }
  }

  function verifyResponse(pathName, status, rts, body, rsig) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const p0 = passStringToWasm(pathName, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l0 = WASM_VECTOR_LEN;
      const p1 = passStringToWasm(rts, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l1 = WASM_VECTOR_LEN;
      const p2 = passArray8ToWasm(body, wasm.__wbindgen_export2);
      const l2 = WASM_VECTOR_LEN;
      const p3 = passStringToWasm(rsig, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
      const l3 = WASM_VECTOR_LEN;
      wasm.verifyResponse(retptr, p0, l0, status, p1, l1, p2, l2, p3, l3);
      const r0 = getDataView().getInt32(retptr + 0, true);
      const r1 = getDataView().getInt32(retptr + 4, true);
      if (getDataView().getInt32(retptr + 8, true)) throw takeObject(r1);
      return r0 !== 0;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  return { init, finalizeHandshake, signRequest, verifyResponse };
}

function parseCookieMap(cookie) {
  const map = new Map();
  for (const part of String(cookie || '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('=');
    if (i < 0) continue;
    map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  return map;
}

function requiresResponseSig(pathname) {
  if (RESPONSE_SIG_EXACT.has(pathname)) return true;
  for (const exact of RESPONSE_SIG_EXACT) {
    if (pathname.length > exact.length && pathname.startsWith(`${exact}/`)) return true;
  }
  for (const { prefix, suffix } of RESPONSE_SIG_UNLOCK) {
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) continue;
    const mid = pathname.slice(prefix.length, pathname.length - suffix.length);
    if (!mid.includes('/')) return true;
  }
  return false;
}

function headerLinesToObject(rawHeaders) {
  const out = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const k = String(rawHeaders[i]).toLowerCase();
    const v = String(rawHeaders[i + 1]);
    if (out[k]) out[k] = `${out[k]}, ${v}`;
    else out[k] = v;
  }
  return out;
}

export class PureHdhiveClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || 'https://hdhive.com').replace(/\/$/, '');
    this.cookie = String(options.cookie || process.env.HDHIVE_COOKIE || '').trim();
    this.bindSecret = String(options.bindSecret || process.env.HDHIVE_BIND_SECRET || '').trim();
    this.userAgent = options.userAgent || process.env.BROWSER_USER_AGENT || DEFAULT_UA;
    this.languages = options.languages || DEFAULT_LANGS;
    this.proxy = options.proxy || process.env.HDHIVE_PROXY || process.env.HTTPS_PROXY || '';
    this.wasmPath = options.wasmPath || DEFAULT_WASM_PATH;
    this.verifyResponses = options.verifyResponses !== false;
    this.timeoutMs = Number(options.timeoutMs || 60000);
    this.proxyInfo = parseProxy(this.proxy);
    this.wasm = null;
    this.session = null; // { cid, expiresAt }
    this.clockSkewMs = 0;
    this._handshakePromise = null;
  }

  async _ensureWasm() {
    if (!this.wasm) this.wasm = await loadWasmApi(this.wasmPath);
    return this.wasm;
  }

  async _uaFingerprint() {
    const text = `${this.userAgent}|${(this.languages || []).join(',')}`;
    const digest = await nodeCrypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Buffer.from(digest).toString('hex');
  }

  _userId() {
    const map = parseCookieMap(this.cookie);
    const uid = map.get('hdh_uid');
    if (uid && /^[1-9]\d*$/.test(uid)) return uid;
    const token = map.get('token');
    if (token) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        if (payload?.user_id) return String(payload.user_id);
      } catch {}
    }
    return '0';
  }

  _csrf() {
    return parseCookieMap(this.cookie).get('csrf_access_token') || '';
  }

  _newNonce() {
    return randomBytes(16).toString('hex');
  }

  /**
   * 底层 HTTP/HTTPS（原生 socks5/http 代理，无第三方依赖）
   * 代理抖动 / TLS 半开连接自动重试
   */
  async _rawRequest(urlString, { method = 'GET', headers = {}, body } = {}, _attempt = 0) {
    const maxAttempts = 3;
    try {
      return await this._rawRequestOnce(urlString, { method, headers, body });
    } catch (e) {
      const msg = String(e?.message || e || '');
      const retriable = /timeout|ECONN|ENOTFOUND|EPIPE|ECONNRESET|socket disconnected|packet length too long|TLS|ssl|secure|proxy|504|502|503/i.test(msg);
      if (_attempt + 1 >= maxAttempts || !retriable) throw e;
      await new Promise((r) => setTimeout(r, 200 + _attempt * 350 + Math.floor(Math.random() * 200)));
      return this._rawRequest(urlString, { method, headers, body }, _attempt + 1);
    }
  }

  async _rawRequestOnce(urlString, { method = 'GET', headers = {}, body } = {}) {
    const url = new URL(urlString);
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port || (isHttps ? 443 : 80));
    const host = url.hostname;
    const pathWithQuery = url.pathname + url.search;

    const hdrs = {
      accept: 'application/json, text/plain, */*',
      'user-agent': this.userAgent,
      'accept-language': (this.languages || DEFAULT_LANGS).join(','),
      host: url.host,
      connection: 'close',
      ...headers
    };
    if (this.cookie) hdrs.cookie = this.cookie;
    const csrf = this._csrf();
    if (csrf && !hdrs['x-csrf-token'] && !hdrs['X-CSRF-TOKEN']) {
      hdrs['x-csrf-token'] = csrf;
    }

    const payload =
      body == null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (payload && !hdrs['content-type'] && !hdrs['Content-Type']) {
      hdrs['content-type'] = 'application/json';
    }
    if (payload) hdrs['content-length'] = String(payload.length);

    // 不声明 accept-encoding，避免 gzip 需要额外解压
    delete hdrs['accept-encoding'];
    delete hdrs['Accept-Encoding'];

    const rawSocket = await openProxySocket(this.proxyInfo, host, port);
    rawSocket.setTimeout(this.timeoutMs);

    let socket = rawSocket;
    try {
      if (isHttps) {
        socket = tls.connect({
          socket: rawSocket,
          servername: host,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2'
        });
        await new Promise((resolve, reject) => {
          socket.once('secureConnect', resolve);
          socket.once('error', reject);
        });
      }

      const headerText = Object.entries(hdrs)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const req = `${method.toUpperCase()} ${pathWithQuery} HTTP/1.1\r\n${headerText}\r\n\r\n`;
      socket.write(req);
      if (payload) socket.write(payload);

      // 增量解析：先读响应头，再按 content-length / chunked 读 body
      // （不能傻等 socket end，keep-alive 会挂死）
      const { status, resHeaders, bodyBuf } = await readHttpResponse(socket, this.timeoutMs);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: resHeaders,
        body: bodyBuf
      };
    } finally {
      try { socket.destroy(); } catch {}
      try { rawSocket.destroy(); } catch {}
    }
  }

  async handshake({ force = false } = {}) {
    if (!force && this.session && Date.now() < this.session.expiresAt - 60_000) {
      return this.session;
    }
    if (this._handshakePromise) return this._handshakePromise;
    this._handshakePromise = this._doHandshake().finally(() => {
      this._handshakePromise = null;
    });
    return this._handshakePromise;
  }

  async _doHandshake() {
    const wasm = await this._ensureWasm();
    const clientPub = wasm.init();
    if (!(clientPub instanceof Uint8Array) || clientPub.length !== 32) {
      throw new Error(`wasm init invalid pub length=${clientPub?.length}`);
    }
    const uaFingerprint = await this._uaFingerprint();
    const ts = Date.now() + this.clockSkewMs;
    const payload = {
      client_pub: Buffer.from(clientPub).toString('base64'),
      ua_fingerprint: uaFingerprint,
      ts,
      bind_token: this.bindSecret || ''
    };
    const res = await this._rawRequest(`${this.baseUrl}/api/public/security/session/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: payload
    });
    let json;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new Error(
        `handshake invalid json HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`
      );
    }
    if (!res.ok || !json?.success || !json?.data) {
      throw new Error(
        `handshake failed HTTP ${res.status}: ${
          json?.message || json?.error?.message || res.body.toString('utf8').slice(0, 200)
        }`
      );
    }
    const { cid, server_pub, expires_at } = json.data;
    const serverPub = Buffer.from(server_pub, 'base64');
    if (serverPub.length !== 32) throw new Error(`invalid server_pub length ${serverPub.length}`);
    wasm.finalizeHandshake(cid, new Uint8Array(serverPub), 1);
    this.session = {
      cid,
      expiresAt: Math.floor(Number(expires_at) * 1000)
    };
    return this.session;
  }

  async syncTime() {
    const res = await this._rawRequest(`${this.baseUrl}/api/public/security/time`, { method: 'GET' });
    const json = JSON.parse(res.body.toString('utf8'));
    const serverMs = json?.data?.server_time_ms;
    if (typeof serverMs !== 'number') throw new Error('invalid /security/time');
    this.clockSkewMs = Math.trunc(serverMs - Date.now());
    return this.clockSkewMs;
  }

  async setBindSecret(secret) {
    this.bindSecret = String(secret || '').trim();
    this.session = null;
    if (this.bindSecret) await this.handshake({ force: true });
    return Boolean(this.bindSecret);
  }

  async clearSession() {
    this.session = null;
  }

  async _signHeaders(method, pathname, bodyBytes) {
    const wasm = await this._ensureWasm();
    const session = await this.handshake();
    const ts = String(Date.now() + this.clockSkewMs);
    const nonce = this._newNonce();
    const userId = this._userId();
    const sig = wasm.signRequest(
      method.toUpperCase(),
      pathname,
      ts,
      nonce,
      bodyBytes || new Uint8Array(0),
      userId
    );
    return {
      'X-HDH-Cid': session.cid,
      'X-HDH-TS': ts,
      'X-HDH-Nonce': nonce,
      'X-HDH-Sig': sig,
      'X-HDH-Kid': '1'
    };
  }

  async call(method, apiPath, { query, body, _retry = false } = {}) {
    const url = new URL(apiPath, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const methodUp = String(method || 'GET').toUpperCase();
    const bodyStr =
      body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const bodyBytes = bodyStr == null ? new Uint8Array(0) : new TextEncoder().encode(bodyStr);

    let sigHeaders;
    try {
      sigHeaders = await this._signHeaders(methodUp, url.pathname, bodyBytes);
    } catch {
      this.session = null;
      sigHeaders = await this._signHeaders(methodUp, url.pathname, bodyBytes);
    }

    const headers = {
      accept: 'application/json',
      ...sigHeaders
    };
    if (bodyStr != null) headers['content-type'] = 'application/json';

    const res = await this._rawRequest(url.toString(), {
      method: methodUp,
      headers,
      body: bodyStr
    });

    if (res.status === 401 && !_retry) {
      let code = '';
      try {
        code = JSON.parse(res.body.toString('utf8'))?.code || '';
      } catch {}
      if (SESSION_RETRY_CODES.has(code)) {
        this.session = null;
        await this.handshake({ force: true });
        return this.call(method, apiPath, { query, body, _retry: true });
      }
      if (code === 'stale_ts') {
        await this.syncTime().catch(() => {});
        return this.call(method, apiPath, { query, body, _retry: true });
      }
    }

    let responseSigOk = null;
    const rsig = res.headers['x-hdh-rsig'];
    const rts = res.headers['x-hdh-rts'] || '';
    if (this.verifyResponses && rsig) {
      try {
        const wasm = await this._ensureWasm();
        responseSigOk = wasm.verifyResponse(
          url.pathname,
          res.status,
          String(rts),
          new Uint8Array(res.body),
          String(rsig)
        );
      } catch {
        responseSigOk = false;
      }
    } else if (
      this.verifyResponses &&
      requiresResponseSig(url.pathname) &&
      res.status !== 401 &&
      !rsig
    ) {
      responseSigOk = false;
    }

    let data;
    const text = res.body.toString('utf8');
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data,
      responseSigOk
    };
  }

  get(apiPath, query) {
    return this.call('GET', apiPath, { query });
  }
  post(apiPath, body, query) {
    return this.call('POST', apiPath, { body, query });
  }
  put(apiPath, body) {
    return this.call('PUT', apiPath, { body });
  }
  delete(apiPath) {
    return this.call('DELETE', apiPath);
  }

  getCurrentUser() {
    return this.get('/api/customer/user/current');
  }
  getPointsLogs(query = { page: 1, page_size: 10 }) {
    return this.get('/api/customer/points-logs', query);
  }
  getUnreadCount() {
    return this.get('/api/customer/messages/unread-count');
  }
  getBulletins() {
    return this.get('/api/public/bulletins/latest');
  }
  getPlaylists(query = {}) {
    return this.get('/api/customer/playlists/my', query);
  }
  checkSubscription(target_type, target_key) {
    return this.get('/api/customer/subscriptions/check', { target_type, target_key });
  }
  getResource(slugOrId) {
    return this.get(`/api/customer/resources/${slugOrId}`);
  }
  unlockResource(slugOrId) {
    return this.post(`/api/customer/resources/${slugOrId}/unlock`);
  }
  checkResource(url) {
    return this.post('/api/customer/check/resource', { url });
  }
  checkin(body = {}) {
    return this.post('/api/customer/user/checkin', body);
  }

  async unlockByResourceSlug(slugOrUrl) {
    const slug =
      String(slugOrUrl).match(/\/resource\/(?:189|cloud189|8)\/([A-Za-z0-9._~-]+)/)?.[1] ||
      String(slugOrUrl).replace(/^.*\//, '');
    const unlock = await this.unlockResource(slug);
    const data = unlock.data?.data || unlock.data || {};
    const code = data.access_code || data.accessCode || '';
    const link = data.url || data.media_url || '';
    return {
      slug,
      status: unlock.status,
      ok: unlock.ok,
      link,
      code,
      accessCode: code,
      fullUrl:
        data.full_url || (link && code ? `${link}（访问码：${code}）` : link),
      raw: unlock.data
    };
  }

  /**
   * 拉 HTML 页面（不签名；cookie 可选）
   */
  async _fetchHtml(pathOrUrl) {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const res = await this._rawRequest(url, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'cache-control': 'no-cache'
      }
    });
    const html = res.body.toString('utf8');
    return { status: res.status, ok: res.ok, headers: res.headers, html };
  }

  /**
   * TMDB → 影巢内部 slug（无需登录）
   * 从 /tmdb/movie|tv/:id HTML 的 NEXT_REDIRECT 解析
   */
  async resolveTmdbToInternal(tmdbId, type = 'movie') {
    const mediaType = String(type || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
    const id = String(tmdbId || '').trim();
    if (!id) throw new Error('tmdbId is required');

    const path = `/tmdb/${mediaType}/${id}`;
    const { status, html } = await this._fetchHtml(path);
    if (status >= 400) {
      throw new Error(`resolve TMDB HTTP ${status} for ${path}`);
    }

    const redirect =
      html.match(/NEXT_REDIRECT;replace;(\/(?:movie|tv)\/[A-Za-z0-9._~-]+);(\d+)/)?.[1] ||
      html.match(/"digest":"NEXT_REDIRECT;replace;(\/(?:movie|tv)\/[A-Za-z0-9._~-]+);(\d+);?"/)?.[1] ||
      html.match(/(\/(?:movie|tv)\/[a-f0-9]{32})/)?.[1];

    if (!redirect) {
      // 未登录有时也会直接给 redirect；若只有 login 则失败
      const login = html.match(/\/login\?redirect=([^"\\]+)/)?.[1];
      throw new Error(
        `cannot resolve TMDB ${mediaType}/${id}` +
          (login ? ` (got login redirect ${decodeURIComponent(login)})` : ' (no NEXT_REDIRECT in HTML)')
      );
    }

    const m = redirect.match(/\/(movie|tv)\/([A-Za-z0-9._~-]+)/);
    if (!m) throw new Error(`invalid redirect path: ${redirect}`);
    const slug = m[2];
    return {
      type: m[1],
      slug,
      url: `${this.baseUrl}/${m[1]}/${slug}`,
      path: `/${m[1]}/${slug}`,
      tmdbId: id
    };
  }

  /**
   * 从 /movie|tv/:slug HTML 的 __next_f groupData 解析天翼资源列表（需登录 cookie）
   */
  async listCloud189FromMoviePage(movieInternalUrlOrSlug, type = 'movie') {
    let path;
    const raw = String(movieInternalUrlOrSlug || '');
    if (/^https?:\/\//i.test(raw)) {
      path = new URL(raw).pathname;
    } else if (raw.startsWith('/')) {
      path = raw;
    } else if (raw) {
      const mediaType = String(type || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
      path = `/${mediaType}/${raw}`;
    } else {
      throw new Error('movie slug/url is required');
    }

    const { status, html } = await this._fetchHtml(path);
    if (status >= 400) throw new Error(`movie page HTTP ${status} for ${path}`);

    // 未登录会被塞到 login
    if (/\/login\?redirect=/.test(html) && !/groupData/.test(html)) {
      throw new Error('movie page requires login cookie (redirected to login)');
    }

    const groupData = extractNextGroupData(html);
    if (!groupData) throw new Error('groupData not found in movie page HTML');

    const items = groupData.groupData?.['189'] || groupData.groupData?.['cloud189'] || [];
    const movieSlug = path.split('/').filter(Boolean)[1] || '';
    const resources = items.map((r) => normalizeGroupResource(r, this.baseUrl));
    return {
      movieSlug,
      movieUrl: `${this.baseUrl}${path}`,
      websites: groupData.websites || [],
      resources
    };
  }

  /**
   * 兼容 bridge: TMDB → 天翼资源列表（不消耗积分，不启动浏览器）
   * 返回结构贴近 POST /hdhive/customer/media-resources
   */
  async mediaResourcesByTmdb(tmdbId, type = 'movie') {
    const resolved = await this.resolveTmdbToInternal(tmdbId, type);
    const listed = await this.listCloud189FromMoviePage(resolved.path, resolved.type);
    const resources = listed.resources.map((r) => ({
      id: r.slug,
      slug: r.slug,
      title: r.title,
      size: r.size,
      sizeFormatted: r.sizeFormatted || formatBytes(r.size),
      points: r.points,
      isFree: r.points === 0,
      link: r.link || '',
      code: r.code || '',
      isUnlocked: Boolean(r.isUnlocked),
      cloudType: 'cloud189',
      uploader: r.uploader || '',
      source: 'html-groupData',
      movieId: String(tmdbId),
      movieType: resolved.type,
      remark: r.remark,
      raw: r.raw
    }));
    return {
      success: true,
      resources,
      movieSlug: resolved.slug,
      movieUrl: resolved.url,
      tmdbId: String(tmdbId),
      type: resolved.type
    };
  }

  /**
   * 预览：列表 + 当前积分（不解锁）
   */
  async previewTmdb(tmdbId, type = 'movie') {
    const list = await this.mediaResourcesByTmdb(tmdbId, type);
    let currentPoints = null;
    try {
      const user = await this.getCurrentUser();
      currentPoints =
        user.data?.data?.user_meta?.points ??
        user.data?.data?.points ??
        null;
    } catch {}
    const costs = list.resources.map((r) => Number(r.points) || 0);
    return {
      ...list,
      currentPoints,
      totalCost: costs.reduce((a, b) => a + b, 0),
      cheapestCost: costs.length ? Math.min(...costs) : 0
    };
  }
}

function decodeChunked(buf) {
  let offset = 0;
  const out = [];
  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const sizeLine = buf.subarray(offset, lineEnd).toString('utf8').split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    out.push(buf.subarray(offset, offset + size));
    offset += size + 2; // data + CRLF
  }
  return Buffer.concat(out);
}

/** 只处理 JS 字符串转义，避免 unicode_escape 弄坏中文 */
function unescapeJsString(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '\\' || i + 1 >= s.length) {
      out += ch;
      continue;
    }
    const n = s[i + 1];
    if (n === 'n') {
      out += '\n';
      i += 1;
    } else if (n === 'r') {
      out += '\r';
      i += 1;
    } else if (n === 't') {
      out += '\t';
      i += 1;
    } else if (n === '"' || n === "'" || n === '\\' || n === '/') {
      out += n;
      i += 1;
    } else if (n === 'u' && i + 5 < s.length) {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
      i += 5;
    } else {
      out += n;
      i += 1;
    }
  }
  return out;
}

function extractJsonObject(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/**
 * 从电影页 HTML 的 self.__next_f.push 中提取 groupData 对象
 */
function extractNextGroupData(html) {
  const re = /<script[^>]*>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1];
    if (!raw.includes('groupData')) continue;
    const unescaped = unescapeJsString(raw);
    const marker = unescaped.indexOf('{"websites"');
    const start = marker >= 0 ? marker : unescaped.indexOf('{');
    if (start < 0) continue;
    const objText = extractJsonObject(unescaped, start);
    if (!objText) continue;
    try {
      const data = JSON.parse(objText);
      if (data?.groupData) return data;
    } catch {
      // try next push
    }
  }
  return null;
}

function parseShareSizeToBytes(value) {
  const text = String(value || '');
  const matches = text.matchAll(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)\b/gi);
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  let best = 0;
  for (const m of matches) {
    const n = Number(m[1]) * (units[m[2].toUpperCase()] || 0);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return Math.round(best);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function normalizeGroupResource(r, baseUrl) {
  const slug = r?.slug || String(r?.id || '');
  const remark = String(r?.remark || '').trim();
  const title = (remark || r?.title || '影巢天翼资源')
    .replace(/\s*@\s*和谐点我[!！]?.*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sizeText = r?.share_size || r?.size || '';
  const size = parseShareSizeToBytes(sizeText);
  const points = Number(r?.unlock_points ?? r?.default_unlock_points ?? 0);
  const uploader = r?.user?.nickname || r?.user?.username || '';
  return {
    id: slug,
    slug,
    title,
    remark,
    size,
    sizeFormatted: size ? formatBytes(size) : String(sizeText || ''),
    points: Number.isFinite(points) ? points : null,
    isFree: points === 0,
    isUnlocked: Boolean(r?.is_unlocked || r?.unlocked || r?.already_owned),
    uploader,
    link: '',
    code: '',
    pageUrl: slug ? `${baseUrl}/resource/189/${slug}` : '',
    raw: r
  };
}

/**
 * 从 socket 读完整 HTTP 响应（支持 content-length / chunked，不依赖 connection close）
 */
function readHttpResponse(socket, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headerDone = false;
    let status = 0;
    let resHeaders = {};
    let bodyChunks = [];
    let expectedLen = null; // number | 'chunked' | null(until end)
    let settled = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('response timeout'));
    }, timeoutMs);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onErr);
      socket.off('timeout', onTimeout);
    };

    const finish = (bodyBuf) => {
      cleanup();
      resolve({ status, resHeaders, bodyBuf });
    };

    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error('socket timeout'));
    };
    const onEnd = () => {
      if (!headerDone) {
        cleanup();
        reject(new Error('connection closed before headers'));
        return;
      }
      if (expectedLen === 'chunked') {
        finish(decodeChunked(Buffer.concat(bodyChunks)));
      } else {
        finish(Buffer.concat(bodyChunks));
      }
    };

    const onData = (chunk) => {
      if (!headerDone) {
        buf = Buffer.concat([buf, chunk]);
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const head = buf.subarray(0, sep).toString('utf8');
        const rest = buf.subarray(sep + 4);
        const lines = head.split('\r\n');
        const m = (lines[0] || '').match(/^HTTP\/\d\.\d\s+(\d+)/);
        status = m ? Number(m[1]) : 0;
        const pairs = [];
        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i];
          const colon = line.indexOf(':');
          if (colon < 0) continue;
          pairs.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        resHeaders = headerLinesToObject(pairs);
        headerDone = true;
        if (String(resHeaders['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
          expectedLen = 'chunked';
        } else if (resHeaders['content-length'] != null) {
          expectedLen = Number(resHeaders['content-length']);
        } else {
          expectedLen = null; // read until end
        }
        bodyChunks = rest.length ? [rest] : [];
      } else {
        bodyChunks.push(chunk);
      }

      if (!headerDone) return;
      const bodyBuf = Buffer.concat(bodyChunks);
      if (typeof expectedLen === 'number') {
        if (bodyBuf.length >= expectedLen) finish(bodyBuf.subarray(0, expectedLen));
        return;
      }
      if (expectedLen === 'chunked') {
        // 粗略判断 chunked 结束：出现 0\r\n\r\n
        if (/\r\n0\r\n\r\n$/.test(bodyBuf.toString('binary')) || bodyBuf.includes(Buffer.from('0\r\n\r\n'))) {
          // 更稳：完整 decode 成功且末尾 0 chunk 已出现
          const text = bodyBuf.toString('latin1');
          if (/(?:^|\r\n)0(?:;.*)?\r\n\r\n/.test(text)) {
            finish(decodeChunked(bodyBuf));
          }
        }
      }
    };

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onErr);
    socket.once('timeout', onTimeout);
  });
}

export default PureHdhiveClient;

// CLI 自检：node pure-api-client.mjs [resourceSlug]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cookie = (
    process.env.HDHIVE_COOKIE ||
    (fs.existsSync('/tmp/hdhive-cookies.txt')
      ? fs.readFileSync('/tmp/hdhive-cookies.txt', 'utf8')
      : '')
  ).trim();
  const bindSecret = (
    process.env.HDHIVE_BIND_SECRET ||
    (fs.existsSync('/tmp/hdhive-bind-secret.txt')
      ? fs.readFileSync('/tmp/hdhive-bind-secret.txt', 'utf8')
      : '')
  ).trim();
  const proxy =
    process.env.HDHIVE_PROXY || process.env.BROWSER_PROXY || 'socks5://127.0.0.1:1081';
  const client = new PureHdhiveClient({ cookie, bindSecret, proxy });
  try {
    console.log('[pure] handshake...');
    const s = await client.handshake();
    console.log('[pure] session', s);
    console.log('[pure] current user...');
    const user = await client.getCurrentUser();
    console.log(
      JSON.stringify(
        {
          status: user.status,
          ok: user.ok,
          responseSigOk: user.responseSigOk,
          message: user.data?.message,
          code: user.data?.code,
          points: user.data?.data?.user_meta?.points ?? user.data?.data?.points,
          user_id: user.data?.data?.user?.id || user.data?.data?.id
        },
        null,
        2
      )
    );
    const arg = process.argv[2];
    if (arg && /^\d+$/.test(arg)) {
      // node pure-api-client.mjs 568160 [movie|tv]
      const type = process.argv[3] || 'movie';
      console.log('[pure] media-resources tmdb', arg, type);
      const list = await client.mediaResourcesByTmdb(arg, type);
      console.log(JSON.stringify({
        success: list.success,
        movieSlug: list.movieSlug,
        count: list.resources.length,
        resources: list.resources.map((r) => ({
          slug: r.slug,
          title: r.title,
          uploader: r.uploader,
          sizeFormatted: r.sizeFormatted,
          points: r.points,
          isUnlocked: r.isUnlocked
        }))
      }, null, 2));
    } else if (arg) {
      console.log('[pure] unlock', arg);
      const u = await client.unlockByResourceSlug(arg);
      console.log(JSON.stringify(u, null, 2).slice(0, 2000));
    } else {
      console.log('[pure] points-logs...');
      const logs = await client.getPointsLogs({ page: 1, page_size: 3 });
      console.log(JSON.stringify({ status: logs.status, ok: logs.ok, data: logs.data }, null, 2).slice(0, 1200));
      console.log('[pure] resolve tmdb 568160...');
      const resolved = await client.resolveTmdbToInternal('568160', 'movie');
      console.log(resolved);
    }
  } catch (e) {
    console.error('[pure] FAILED', e.stack || e);
    process.exitCode = 1;
  }
}
