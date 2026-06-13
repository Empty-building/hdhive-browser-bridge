#!/usr/bin/env node
// 测试 hdhive-client.mjs 是否能完成握手并调用 API
import { HdhiveClient } from './hdhive-client.mjs';

const client = new HdhiveClient({
  baseUrl: 'https://hdhive.com',
  cookie: process.env.HDHIVE_COOKIE || ''
});

console.log('[step] 加载 wasm + 握手...');
const session = await client.handshake();
console.log('[ok] 握手成功', session);

console.log('\n[step] 测试公开 API（不需要登录）...');
const bulletins = await client.get('/api/public/bulletins/latest');
console.log('[res]', JSON.stringify(bullets.data, null, 2).slice(0, 400));

console.log('\n[step] 测试需要登录的 API...');
const current = await client.get('/api/customer/user/current');
console.log('[res]', JSON.stringify(current, null, 2));

console.log('\n[step] 测试带 query 的 API（积分日志）...');
const logs = await client.get('/api/customer/points-logs', { page: 1, page_size: 5 });
console.log('[res]', JSON.stringify(logs.data, null, 2).slice(0, 600));

console.log('\n[step] 测试 POST API（查询资源）...');
const resources = await client.post('/api/customer/resources', {
  type: 'movie',
  tmdbId: '550'
});
console.log('[res]', JSON.stringify(resources.data, null, 2).slice(0, 800));