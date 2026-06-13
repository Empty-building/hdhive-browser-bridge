#!/usr/bin/env node
// 直接调试 wasm 加载
import fs from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const wasmBytes = fs.readFileSync('/workspaces/hdhive-browser-bridge/node_modules/hdh-security.wasm');

const imports = {
  './hdh_security_bg.js': {
    __wbg_Error_ef53bc310eb298a0: (e, n) => new Error(`err-${e}-${n}`),
    __wbg___wbindgen_is_function_754e9f305ff6029e: (e) => typeof e === 'function',
    __wbg___wbindgen_is_object_56732c2bc353f41d: (e) => typeof e === 'object' && e !== null,
    __wbg___wbindgen_is_string_c236cabd84a4d769: (e) => typeof e === 'string',
    __wbg___wbindgen_is_undefined_67b456be8673d3d7: (e) => e === undefined,
    __wbg___wbindgen_throw_1506f2235d1bdba0: (e, n) => { throw new Error(`throw-${e}-${n}`); },
    __wbg_call_9c758de292015997: () => 0,
    __wbg_crypto_38df2bab126b63dc: (e) => e?.crypto,
    __wbg_getRandomValues_c44a50d8cfdaebeb: (arr) => crypto.getRandomValues(arr),
    __wbg_length_4a591ecaa01354d9: (e) => e?.length || 0,
    __wbg_msCrypto_bd5a034af96bcba6: (e) => e?.msCrypto,
    __wbg_new_with_length_36a4998e27b014c5: (n) => new Uint8Array(n),
    __wbg_node_84ea875411254db1: (e) => e?.node,
    __wbg_process_44c7a14e11e9f69e: (e) => e?.process,
    __wbg_prototypesetcall_3249fc62a0fafa30: (dst, src, val) => { Uint8Array.prototype.set.call(dst, val); },
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
const exps = instance.exports;
console.log('=== Exports ===');
const keys = Object.keys(exps);
console.log('Total:', keys.length);
console.log('All exports:', keys.sort());

// init() 需要的内存栈管理
console.log('\n=== Memory ===');
console.log('memory:', exps.memory);
const mem = new Uint8Array(exps.memory.buffer);
console.log('initial size:', mem.length);

// wasm-pack 的 init 模式：分配栈空间，调用 init，读取返回值（指针+长度），处理错误标志
// 直接调用 init 看错误
const init = exps.init;
const stackAlloc = exps.__wbindgen_add_to_stack_pointer;
console.log('\ninit:', typeof init);
console.log('__wbindgen_add_to_stack_pointer:', typeof stackAlloc);

try {
  const ptr = stackAlloc(-16);
  console.log('stack ptr:', ptr);
  init(ptr);
  const view = new DataView(exps.memory.buffer);
  const resultPtr = view.getInt32(ptr, true);
  const resultLen = view.getInt32(ptr + 4, true);
  const errFlag = view.getInt32(ptr + 12, true);
  console.log('result ptr:', resultPtr, 'len:', resultLen, 'err:', errFlag);

  if (errFlag) {
    // 读取错误字符串
    const errPtr = view.getInt32(ptr + 8, true);
    // 错误字符串以 length+ptr 形式存储
    // 查看附近的内存
    console.log('err ptr:', errPtr);
    // 直接读取附近内存
    const errLen = view.getInt32(errPtr, true);
    const errStrPtr = view.getInt32(errPtr + 4, true);
    console.log('err string len:', errLen, 'ptr:', errStrPtr);
    const bytes = new Uint8Array(exps.memory.buffer, errStrPtr, errLen);
    console.log('err string:', new TextDecoder().decode(bytes));
  } else {
    // 读取返回的公钥
    const bytes = new Uint8Array(exps.memory.buffer, resultPtr, resultLen);
    console.log('client pub (hex):', Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  }
  stackAlloc(16);
} catch (e) {
  console.error('init error:', e.message);
}