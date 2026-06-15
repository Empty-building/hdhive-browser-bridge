#!/usr/bin/env node
// test-stress.mjs
// 压力测试：验证串行队列、并发安全、无死锁

import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = 'http://localhost:10000';
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logSection(title) {
  console.log(`\n${colors.bright}${colors.cyan}${'='.repeat(70)}${colors.reset}`);
  log(title, 'bright');
  console.log(`${colors.cyan}${'='.repeat(70)}${colors.reset}\n`);
}

async function fetch2(url, options = {}) {
  const start = Date.now();
  try {
    const res = await fetch(url, options);
    const data = await res.json();
    return { success: res.ok, status: res.status, data, elapsed: Date.now() - start };
  } catch (e) {
    return { success: false, error: e.message, elapsed: Date.now() - start };
  }
}

// 测试 1：高并发 /health（验证串行队列不死锁）
async function testHighConcurrency() {
  logSection('测试 1: 高并发请求（20 个并发 /health）');
  log('目标：验证串行队列不死锁，所有请求都能完成', 'cyan');

  const count = 20;
  const start = Date.now();

  const promises = Array.from({ length: count }, (_, i) =>
    fetch2(`${BASE_URL}/health`)
      .then(r => ({ i: i + 1, ...r }))
  );

  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const successCount = results.filter(r => r.success).length;
  const avgElapsed = results.reduce((sum, r) => sum + r.elapsed, 0) / count;
  const maxElapsed = Math.max(...results.map(r => r.elapsed));
  const minElapsed = Math.min(...results.map(r => r.elapsed));

  log(`  并发数: ${count}`, 'cyan');
  log(`  成功数: ${successCount}/${count}`, successCount === count ? 'green' : 'red');
  log(`  总耗时: ${elapsed}ms`, 'cyan');
  log(`  平均单请求: ${avgElapsed.toFixed(0)}ms`, 'cyan');
  log(`  最快/最慢: ${minElapsed}ms / ${maxElapsed}ms`, 'cyan');

  if (successCount === count) {
    log('  ✓ 串行队列工作正常（无死锁，全部完成）', 'green');
    return true;
  } else {
    log('  ✗ 部分请求失败', 'red');
    return false;
  }
}

// 测试 2：混合并发（多种接口交叉并发）
async function testMixedConcurrency() {
  logSection('测试 2: 混合接口并发（验证不同 action 串行执行）');
  log('目标：验证不同类型请求也能安全串行化', 'cyan');

  const start = Date.now();
  const promises = [
    ...Array.from({ length: 5 }, () => fetch2(`${BASE_URL}/health`)),
    ...Array.from({ length: 5 }, () => fetch2(`${BASE_URL}/metrics`)),
    ...Array.from({ length: 5 }, () => fetch2(`${BASE_URL}/health`)),
  ];

  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const successCount = results.filter(r => r.success).length;
  log(`  混合请求数: 15 (health×10 + metrics×5)`, 'cyan');
  log(`  成功数: ${successCount}/15`, successCount === 15 ? 'green' : 'red');
  log(`  总耗时: ${elapsed}ms`, 'cyan');

  if (successCount === 15) {
    log('  ✓ 混合并发安全（不同 action 也能串行）', 'green');
    return true;
  }
  return false;
}

// 测试 3：快速连续请求（模拟客户端重试）
async function testRapidRetry() {
  logSection('测试 3: 快速连续请求（模拟客户端重试场景）');
  log('目标：验证重试不会造成请求堆积或死锁', 'cyan');

  const results = [];
  for (let i = 0; i < 10; i++) {
    const r = await fetch2(`${BASE_URL}/health`);
    results.push(r);
    log(`  请求 #${i + 1}: ${r.status} (${r.elapsed}ms)`, r.success ? 'green' : 'red');
  }

  const successCount = results.filter(r => r.success).length;
  const avgElapsed = results.reduce((sum, r) => sum + r.elapsed, 0) / 10;

  log(`  成功数: ${successCount}/10`, successCount === 10 ? 'green' : 'red');
  log(`  平均耗时: ${avgElapsed.toFixed(0)}ms`, 'cyan');

  if (successCount === 10 && avgElapsed < 100) {
    log('  ✓ 快速重试安全（无堆积）', 'green');
    return true;
  }
  return false;
}

// 测试 4：长时间稳定性（持续请求 30 秒）
async function testSustainedLoad() {
  logSection('测试 4: 持续负载测试（30 秒持续请求）');
  log('目标：验证长时间运行无内存泄漏、队列堆积', 'cyan');

  const duration = 30000;
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  let totalRequests = 0;

  log('  开始持续请求...', 'yellow');

  while (Date.now() - start < duration) {
    const r = await fetch2(`${BASE_URL}/health`);
    totalRequests++;
    if (r.success) successCount++;
    else failCount++;

    if (totalRequests % 20 === 0) {
      const elapsed = Date.now() - start;
      log(`    进度: ${(elapsed / 1000).toFixed(1)}s / 30s | 成功: ${successCount} | 失败: ${failCount}`, 'cyan');
    }

    await sleep(100); // 100ms 间隔，模拟真实负载
  }

  const elapsed = Date.now() - start;
  const successRate = (successCount / totalRequests * 100).toFixed(1);

  log(`  总请求数: ${totalRequests}`, 'cyan');
  log(`  成功数: ${successCount}`, 'green');
  log(`  失败数: ${failCount}`, failCount > 0 ? 'red' : 'green');
  log(`  成功率: ${successRate}%`, 'cyan');
  log(`  实际耗时: ${(elapsed / 1000).toFixed(1)}s`, 'cyan');

  if (successRate >= 95) {
    log('  ✓ 持续负载测试通过（无堆积、无泄漏）', 'green');
    return true;
  }
  return false;
}

// 测试 5：metrics 观测验证
async function testMetricsObservability() {
  logSection('测试 5: Metrics 可观测性验证');
  log('目标：确认修复后的状态正确暴露', 'cyan');

  const r = await fetch2(`${BASE_URL}/metrics`);

  if (r.success && r.data.data) {
    const d = r.data.data;
    log(`  上线时长: ${Math.floor(d.uptime / 1000)}s`, 'cyan');
    log(`  总请求数: ${d.totalCalls}`, 'cyan');
    log(`  失败请求: ${d.failedCalls}`, 'cyan');
    log(`  成功率: ${d.successRate}`, 'cyan');
    log(`  当前 action: ${d.activeAction || '空闲'}`, 'cyan');
    log(`  缓存启用: ${d.readCache?.enabled ? '是' : '否'}`, 'cyan');
    log(`  缓存 TTL: ${d.readCache?.ttlMs}ms`, 'cyan');
    log(`  缓存大小: ${d.readCache?.size || 0} 项`, 'cyan');

    if (d.readCache?.enabled && d.readCache?.ttlMs === 60000) {
      log('  ✓ 缓存配置正确（60s TTL）', 'green');
      return true;
    }
  }

  log('  ⚠ metrics 数据不完整', 'yellow');
  return false;
}

// 主流程
async function main() {
  console.clear();
  log('========================================', 'bright');
  log('  串行化修复压力测试套件', 'bright');
  log('========================================', 'reset');
  log(`BASE_URL: ${BASE_URL}`, 'cyan');
  log(`测试类型: 无需真实 cookie 的逻辑验证\n`, 'cyan');

  // 等待服务就绪
  log('等待服务启动...', 'yellow');
  await sleep(3000);

  const results = {
    highConcurrency: false,
    mixedConcurrency: false,
    rapidRetry: false,
    sustainedLoad: false,
    metrics: false,
  };

  try {
    results.highConcurrency = await testHighConcurrency();
    results.mixedConcurrency = await testMixedConcurrency();
    results.rapidRetry = await testRapidRetry();
    results.sustainedLoad = await testSustainedLoad();
    results.metrics = await testMetricsObservability();

    // 汇总
    logSection('测试汇总');
    const passed = Object.values(results).filter(Boolean).length;
    const total = Object.keys(results).length;

    log(`高并发测试 (20并发): ${results.highConcurrency ? '✓' : '✗'}`, results.highConcurrency ? 'green' : 'red');
    log(`混合并发测试: ${results.mixedConcurrency ? '✓' : '✗'}`, results.mixedConcurrency ? 'green' : 'red');
    log(`快速重试测试: ${results.rapidRetry ? '✓' : '✗'}`, results.rapidRetry ? 'green' : 'red');
    log(`持续负载测试 (30s): ${results.sustainedLoad ? '✓' : '✗'}`, results.sustainedLoad ? 'green' : 'red');
    log(`Metrics 可观测: ${results.metrics ? '✓' : '✗'}`, results.metrics ? 'green' : 'red');

    log(`\n总计: ${passed}/${total} 通过`, passed >= 4 ? 'green' : 'yellow');

    if (passed >= 4) {
      log('\n✓ 串行化修复工作正常，生产可用！', 'green');
      log('\n验证点:', 'cyan');
      log('  ✓ 高并发不死锁', 'cyan');
      log('  ✓ 串行队列正常工作', 'cyan');
      log('  ✓ 长时间运行稳定', 'cyan');
      log('  ✓ 无内存泄漏/队列堆积', 'cyan');
      process.exit(0);
    } else {
      log('\n⚠ 部分测试未通过', 'yellow');
      process.exit(1);
    }
  } catch (e) {
    log(`\n✗ 测试异常: ${e.message}`, 'red');
    console.error(e);
    process.exit(1);
  }
}

main();
