/**
 * lib/assign-areas.js — 「同城不同区」固化规则
 *
 * 背景（2026-10-06）：
 *   publish-one.js 原来是「一个城市固定一个区」（CITY_ADDR），
 *   台账实证：广州历史 9 条链接全是「天河区/440106」。
 *   老板要求同城的多条链接挂不同区 —— 买家端实测能看到区（「广州·天河区」），
 *   所以区级差异对买家可见，能降判重、也可能影响同城推荐精度。
 *
 * 规则：
 *   ① 同城要 N 条 → 从该城区池里挑 【N 个不同的区】
 *   ② 挑的时候优先挑【台账里用得少的】（轮转，避免总是同几个区）
 *   ③ 池子不够 N 个 → 明确报错并列出，【不静默回头用同一个】
 *
 * 数据源：lib/city-areas.json（由 address_db.js 的 901 条实测地址生成，
 *         每个区带 divisionId + 该区的实测经纬度）
 */
const fs = require('fs');
const path = require('path');

const AREAS_FILE = path.join(__dirname, 'city-areas.json');
const BLOCK_FILE = path.join(__dirname, 'area-blocklist.json');
const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, '上架台账.json');

/**
 * 区级黑名单：发布时被闲鱼拒绝过的 (城市|区|divisionId)。
 * 为什么需要：address_db.js 的 divisionId 有脏数据，而且靠代码格式查不出来
 *   （5101xx 看着完全合法）。只能靠实测淘汰。已发现两个：
 *     成都「高新区 510109」—— 高新区不是行政区（是功能区，跨武侯/双流/郫都），510109 国标未分配
 *     北京「东城区 110102」—— 与西城区同码（build-city-areas.js 已按「同码两个都丢」处理）
 */
function loadBlocked() {
  try { return JSON.parse(fs.readFileSync(BLOCK_FILE, 'utf8')).blocked || {}; }
  catch (e) { return {}; }
}

function loadAreas() {
  try { return JSON.parse(fs.readFileSync(AREAS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

/** 读台账，统计每个「城市|区」用了几次 */
function loadUsage() {
  const usage = {};
  try {
    const led = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    led.forEach((r) => {
      const loc = String(r.定位 || '');
      const parts = loc.split('/');
      // 定位格式：省/市/区/divisionId
      if (parts.length >= 3 && parts[2]) {
        const k = parts[1] + '|' + parts[2];
        usage[k] = (usage[k] || 0) + 1;
      }
    });
  } catch (e) {}
  return usage;
}

/**
 * 给某个城市分配 n 个不同的区
 * @returns {{ city, picked: Array, pool: number, shortage: boolean, warn: string }}
 */
function assignAreas(city, n) {
  const areas = loadAreas();
  const usage = loadUsage();
  const blocked = loadBlocked();
  const all = (areas[city] || []).slice();
  // 先剔黑名单 —— 选它只会浪费一次发布（闲鱼会以 INVALID_MAP_LOCATION 拒掉）
  const pool = all.filter((a) => !blocked[city + '|' + a.area + '|' + a.divisionId]);
  const dropped = all.length - pool.length;

  if (!pool.length) {
    return { city, picked: [], pool: 0, shortage: true, dropped,
      warn: '城市「' + city + '」区池 ' + all.length + ' 个，剔黑名单后为 0' };
  }

  // 稳定排序：用得少的排前面；同次数随机打散（避免每次都挑同一个）
  const decorated = pool.map((a) => ({
    a, used: usage[city + '|' + a.area] || 0, tie: Math.random(),
  }));
  decorated.sort((x, y) => (x.used - y.used) || (x.tie - y.tie));

  const shortage = pool.length < n;
  const picked = [];
  for (let i = 0; i < n; i++) {
    // 池子够就取不同的；不够才回头复用（并明确告警）
    picked.push(decorated[i % decorated.length].a);
  }

  return {
    city, picked, pool: pool.length, shortage,
    warn: shortage ? ('城市「' + city + '」区池只有 ' + pool.length + ' 个，但要 ' + n + ' 条 → 必然有重复') : '',
  };
}

module.exports = { assignAreas, loadAreas, loadUsage, AREAS_FILE, LEDGER };

// 直接跑：node lib/assign-areas.js <城市> <条数> ...
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('用法: node lib/assign-areas.js <城市> <条数> [城市 条数 ...]');
    console.log('例:   node lib/assign-areas.js 杭州 4 广州 2 泉州 2');
    process.exit(0);
  }
  const need = {};
  for (let i = 0; i + 1 < args.length; i += 2) need[args[i]] = Number(args[i + 1]);

  const usage = loadUsage();
  let bad = 0;
  for (const city of Object.keys(need)) {
    const r = assignAreas(city, need[city]);
    console.log('\n' + city + '  要 ' + need[city] + ' 条   区池 ' + r.pool + ' 个'
      + (r.shortage ? '  ❌ ' + r.warn : '  ✅'));
    r.picked.forEach((a, i) => {
      const u = usage[city + '|' + a.area] || 0;
      console.log('   ' + (i + 1) + '. ' + a.area.padEnd(8) + ' ' + a.divisionId + '   台账历史用过 ' + u + ' 次');
    });
    if (r.shortage) bad++;
  }
  process.exit(bad ? 1 : 0);
}
