#!/usr/bin/env node
// 直接在 Node.js 中加载 WASM 并调用签名函数
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

const wasmBytes = fs.readFileSync('/tmp/hdh_security_bg.wasm');

// 注入 crypto polyfill（wasm-pack 默认期望 web 环境）
const subtle = webcrypto.subtle;
const getRandomValues = (arr) => webcrypto.getRandomValues(arr);

const wasmModule = await WebAssembly.compile(wasmBytes);
const importObj = {
  './hdh_security_bg.js': {
    __wbindgen_placeholder__: () => 0
  }
};

// 实际上 wasm-pack 生成的 WASM 通常需要一些 JS 桥接函数。让我用不同的方法。
// 让我们用浏览器抓到的 JS 模块 9110 加载它。

console.log('imports:', JSON.stringify(WebAssembly.Module.imports(wasmModule), null, 2));
console.log('exports:', JSON.stringify(WebAssembly.Module.exports(wasmModule).filter(e => /init|sign|verify|finalize/.test(e.name)), null, 2));