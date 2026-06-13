#!/usr/bin/env node
// 直接用 cloud189-auto-save 的真实 SDK 代码测试我们的 Bridge
// 引用真实文件: /tmp/cloud189-auto-save/src/sdk/hdhive/sdk.ts
// 引用真实工具: /tmp/cloud189-auto-save/src/utils/Cloud189Utils.js
import Cloud189Utils from '/tmp/cloud189-auto-save/src/utils/Cloud189Utils.js';

const BRIDGE_URL = process.argv[2] || '';
const BRIDGE_TOKEN = process.argv[3] || '';

console.log(`━━━ cloud189-auto-save SDK 兼容性测试 ━━━`);
console.log(`Bridge URL:   ${BRIDGE_URL}`);
console.log(`Bridge Token: ${BRIDGE_TOKEN}`);
console.log();

// 复制 cloud189-auto-save SDK 的核心方法（来自 src/sdk/hdhive/sdk.ts）
const CLOUD_TYPE_MAP = {
  cloud189: { name: '天翼云盘', icon: '☁️', color: '#3478f6' },
  unknown: { name: '未知', icon: '❓', color: '#999' }
};

function mapCloudType(t) {
  if (!t) return 'unknown';
  const s = String(t).toLowerCase();
  if (/189|cloud189|天翼/.test(s)) return 'cloud189';
  return 'unknown';
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${units[i]}`;
}

function collectResourceCandidates(payload) {
  if (!payload) return [];
  const candidates = [];
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    const isResource = (
      v.slug || v.id || v.title || v.url || v.cloudType ||
      v.pan_type || v.drive || v.website || v.unlock_points !== undefined
    );
    if (isResource) candidates.push(v);
    for (const k of Object.keys(v)) {
      if (k === 'user' || k === 'uploader' || k === 'meta') continue;
      if (typeof v[k] === 'object' && v[k] !== null) visit(v[k]);
    }
  };
  visit(payload);
  return candidates;
}

function normalizeResources(resources) {
  return resources.map(resource => {
    const cloudType = mapCloudType(resource.pan_type || resource.cloudType || resource.website);
    const cloudMeta = CLOUD_TYPE_MAP[cloudType] || CLOUD_TYPE_MAP.unknown;
    const shareText = resource.full_url || resource.fullUrl || resource.media_url || resource.shareLink || resource.link || resource.url || '';
    const parsed = Cloud189Utils.parseCloudShare(shareText);
    const resourceId = resource.slug || resource.id || '';
    const hasPointField = resource.unlock_points !== undefined || resource.points !== undefined;
    const points = hasPointField ? (resource.unlock_points ?? resource.points ?? 0) : null;
    const explicitFree = resource.is_free === true || resource.isFree === true;
    return {
      id: String(resourceId),
      slug: resource.slug || resource.id || '',
      title: resource.title || '未命名资源',
      cloudType,
      cloudTypeName: cloudMeta.name,
      size: resource.share_size || resource.size || 0,
      sizeFormatted: formatSize(resource.share_size || resource.size),
      points,
      isFree: explicitFree || (points !== null && Number(points) === 0),
      link: parsed.url || shareText,
      code: parsed.accessCode || resource.access_code || '',
      isUnlocked: !!(resource.is_unlocked || resource.isUnlocked || parsed.url)
    };
  });
}

function dedupeResources(resources) {
  const seen = new Set();
  return resources.filter(item => {
    const key = item.slug || item.id || item.link;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeBridgeResources(payload) {
  const candidates = collectResourceCandidates(payload);
  return dedupeResources(normalizeResources(candidates).filter(r => r.cloudType === 'cloud189'));
}

function findFirstCloud189Share(payload) {
  const text = JSON.stringify(payload || '');
  const linkMatch = text.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
  if (!linkMatch) return { link: '', code: '' };
  const parsed = Cloud189Utils.parseCloudShare(linkMatch[0]);
  return { link: parsed.url || linkMatch[0], code: parsed.accessCode || '' };
}

function formatBridgeUnlockData(payload) {
  const normalized = dedupeResources([
    ...normalizeBridgeResources(payload?.resources || []),
    ...normalizeBridgeResources(payload?.detail || []),
    ...normalizeBridgeResources(payload?.payload || payload)
  ]);
  const firstResource = normalized.find(item => item.link);
  if (firstResource?.link) {
    return {
      success: true,
      data: {
        link: firstResource.link,
        code: firstResource.code || '',
        fullUrl: firstResource.link,
        points: firstResource.points || 0
      }
    };
  }
  const share = findFirstCloud189Share(payload);
  if (share.link) {
    return { success: true, data: { link: share.link, code: share.code, fullUrl: share.link, points: 0 } };
  }
  return { success: false, error: 'Browser Bridge 未解析到天翼分享链接' };
}

// ===== 模拟 cloud189 SDK 的 fetch 逻辑 =====
async function bridgeRequest(pathname, options = {}) {
  const url = `${BRIDGE_URL}${pathname}`;
  const headers = {
    'x-bridge-token': BRIDGE_TOKEN,
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'cloud189-auto-save/2.2.99'
  };
  if (options.json) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.json ? JSON.stringify(options.json) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 130000)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { success: res.ok, status: res.status, data };
}

async function getResourcesByBridge(type, tmdbId) {
  console.log(`\n[1] getResourcesByBridge(${type}, ${tmdbId})`);
  const result = await bridgeRequest('/hdhive/customer/media-resources', {
    method: 'POST',
    json: { type, tmdbId },
    timeoutMs: 130000
  });
  if (!result.success) {
    console.log('  ✗ Failed:', result.data?.error || result.data);
    return { success: false, error: result.data?.error || JSON.stringify(result.data) };
  }
  const normalized = normalizeBridgeResources(result.data);
  console.log('  ✓ 原始资源数:', collectResourceCandidates(result.data).length);
  console.log('  ✓ 标准化后:', normalized.length, '个 cloud189 资源');
  for (const r of normalized) {
    console.log(`     - [${r.cloudType}] ${r.title?.slice(0, 40)} | points=${r.points} | link=${r.link ? r.link.slice(0, 50) + '...' : '(none)'} | code=${r.code || '(none)'} | isUnlocked=${r.isUnlocked}`);
  }
  return { success: true, data: normalized, raw: result.data };
}

async function getUnlockedResourceByBridge(slug) {
  console.log(`\n[2] getUnlockedResourceByBridge(${slug})`);
  const detailResult = await bridgeRequest(`/hdhive/customer/resources/${encodeURIComponent(slug)}`);
  if (!detailResult.success) {
    return { success: false, error: detailResult.data?.error };
  }
  const formatted = formatBridgeUnlockData(detailResult.data);
  if (formatted.success) {
    console.log('  ✓ 解锁数据:', formatted.data);
    return formatted;
  }
  console.log('  ✗ 未找到分享链接:', formatted.error);
  return { success: false, error: formatted.error };
}

async function unlockResourceByBridge(slug) {
  console.log(`\n[3] unlockResourceByBridge(${slug})`);
  const result = await bridgeRequest(`/hdhive/customer/resources/${encodeURIComponent(slug)}/unlock`, {
    method: 'POST',
    timeoutMs: 30000
  });
  if (!result.success) {
    return { success: false, error: result.data?.error };
  }
  const formatted = formatBridgeUnlockData(result.data);
  if (formatted.success) {
    console.log('  ✓ 解锁成功:', formatted.data);
    return formatted;
  }
  console.log('  ✗:', formatted.error);
  return { success: false, error: formatted.error };
}

// ===== 主测试流程 =====
async function main() {
  console.log('\n━━━ 测试 1: 你的名字 (TMDB 372058) ━━━');
  const resources = await getResourcesByBridge('movie', '372058');
  if (!resources.success) {
    console.log('❌ 资源查询失败:', resources.error);
    return;
  }
  if (resources.data.length === 0) {
    console.log('⚠ 该电影无 189 资源，测试 media-resources 接口是否能返回空');
    return;
  }

  const target = resources.data[0];
  console.log(`\n目标资源: ${target.title} | slug=${target.slug} | unlocked=${target.isUnlocked}`);

  // 检查详情
  const detail = await getUnlockedResourceByBridge(target.slug);

  // 尝试 unlock
  if (!detail.success) {
    const unlocked = await unlockResourceByBridge(target.slug);
    if (unlocked.success) {
      console.log('\n🎉 完整链路成功！');
    } else {
      console.log('\n❌ 解锁失败:', unlocked.error);
    }
  } else {
    console.log('\n✅ 已解锁，无需重复支付');
  }

  console.log('\n━━━ 测试 2: 资源详情（不消耗积分）━━━');
  // 模拟主项目调用 getResourceDetailByBridge
  console.log('  调 /hdhive/customer/resources/{slug}');
  const detailRes = await bridgeRequest(`/hdhive/customer/resources/${target.slug}`);
  const detailFormatted = formatBridgeUnlockData(detailRes.data);
  if (detailFormatted.success) {
    console.log('  ✓ 拿到 link:', detailFormatted.data.link);
    console.log('  ✓ 拿到 code:', detailFormatted.data.code);
  } else {
    console.log('  ✗ 失败:', detailFormatted.error);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});