/**
 * tools/build-city-areas.js — 从 address_db.js 生成 lib/city-areas.json（城市 → 区池）
 *
 * 修订（2026-10-07）：上一版只有 3 个城市有省份（写死 PROV={广州,杭州,泉州}），
 *   其余 343 个城市的 prov 全是空字符串 —— 发北京时 `所在地` 变成 `/北京/朝阳区/110105`（省份空）。
 *   现在改成用【国标 GB/T 2260 行政区划代码前 2 位】推省份，不需要人工维护省份表。
 *
 * 用法: node tools/build-city-areas.js            # 预演（只统计）
 *       node tools/build-city-areas.js --apply    # 写 lib/city-areas.json
 */
const fs = require('fs');
const path = require('path');
const { ROOT, PATHS } = require('../lib/env');

// address_db.js 属于 xianyu-monitor 那个仓库（本仓只依赖）。路径走 PATHS，别再写死本机绝对路径。
const ADB = path.join(PATHS.xianyuMonitor || '', 'address_db.js');
if (!PATHS.xianyuMonitor || !fs.existsSync(ADB)) {
  console.log('❌ 找不到 address_db.js：' + ADB +
    '\n   请在 config.local.json 的 paths.xianyuMonitor 里填 xianyu-monitor 仓库的位置。');
  process.exit(2);
}
const OUT = path.join(ROOT, 'lib', 'city-areas.json');
const APPLY = process.argv.includes('--apply');

// GB/T 2260 省级代码（前 2 位）→ 省/直辖市名。标准稳定，不需要人工维护。
const PROV_BY_CODE = {
  11: '北京', 12: '天津', 13: '河北', 14: '山西', 15: '内蒙古',
  21: '辽宁', 22: '吉林', 23: '黑龙江',
  31: '上海', 32: '江苏', 33: '浙江', 34: '安徽', 35: '福建', 36: '江西', 37: '山东',
  41: '河南', 42: '湖北', 43: '湖南', 44: '广东', 45: '广西', 46: '海南',
  50: '重庆', 51: '四川', 52: '贵州', 53: '云南', 54: '西藏',
  61: '陕西', 62: '甘肃', 63: '青海', 64: '宁夏', 65: '新疆',
  71: '台湾', 81: '香港', 82: '澳门',
};

function provOf(divisionId) {
  const c = String(divisionId || '').slice(0, 2);
  return PROV_BY_CODE[c] || '';
}

// 取 address_db.js 里的数组字面量
const src = fs.readFileSync(ADB, 'utf8');
const i0 = src.indexOf('[');
let j = src.indexOf('[', i0), d = 0, k = j;
for (; k < src.length; k++) { const ch = src[k]; if (ch === '[') d++; else if (ch === ']') { d--; if (d === 0) break; } }
const arr = eval(src.slice(j, k + 1));

const out = {};
let skippedCityEqualArea = 0, noProv = 0;
for (const row of arr) {
  const p = String(row).split('|');
  const city = p[0], area = p[1], div = p[2], gps = p[3];
  if (!city || !area || !div) continue;
  if (area === city) { skippedCityEqualArea++; continue; }   // 脏数据：区名等于城市名
  const prov = provOf(div);
  if (!prov) noProv++;
  if (!out[city]) out[city] = [];
  if (out[city].some((a) => a.area === area)) continue;
  out[city].push({ prov, city, area, divisionId: div, gps });
}

// 补一个已实测可用的：泉州丰泽区（address_db 里没有，但 2026-09-28 与 10-06 都发成功过）
if (out['泉州'] && !out['泉州'].some((a) => a.area === '丰泽区')) {
  out['泉州'].unshift({ prov: '福建', city: '泉州', area: '丰泽区', divisionId: '350503', gps: '' });
}

// 【2026-10-08 加】三亚：源库里只有「天涯区」1 个，而同城 3 条链接需要 3 个不同的区，
//   池子只有 1 个时 assign-areas.js 会复用并告警（必然有重复）。
//   三亚实际有 4 个市辖区，国标码完整 —— 460202/460203/460205 在 GB/T 2260 里都是【已分配】的，
//   不像踩过坑的成都高新区 510109（功能区，国标空号，闲鱼直接拒）。
//   ⚠️ 这两个新码是【首次使用】：若闲鱼返回 FAIL_BIZ_ITEM_EDIT_INVALID_MAP_LOCATION，
//      就把它们写进 lib/area-blocklist.json，assign-areas.js 会自动跳过并回落到天涯区。
//   顺序刻意把源库里的天涯区留在最前（已实测可用），新码排在后面。
const SANYA_EXTRA = [
  { area: '海棠区', divisionId: '460202', gps: '18.400900,109.760900' },
  { area: '吉阳区', divisionId: '460203', gps: '18.281500,109.575400' },
  { area: '崖州区', divisionId: '460205', gps: '18.357200,109.172000' },
];
if (out['三亚']) {
  for (const a of SANYA_EXTRA) {
    if (!out['三亚'].some((x) => x.area === a.area)) {
      out['三亚'].push({ prov: '海南', city: '三亚', area: a.area, divisionId: a.divisionId, gps: a.gps });
    }
  }
}

// 【2026-10-08 加·已实测定论】澳门：闲鱼的地址库里【没有澳门】。老板拍板走「邻近广东城市顶替」。
//   两个方案都实测过：
//     · divisionId 820000（真澳门国标码）+ prov 澳门 → 闲鱼【直接拒】：
//       FAIL_BIZ_ITEM_EDIT_INVALID_MAP_LOCATION::系统无法定位您所在的行政区
//     · divisionId 440400（广东码）+ prov 广东 → 闲鱼【接受】，所在地落成【珠海】
//       （商品页实测显示"珠海"，不是澳门 —— 这是平台行为，不是我们写错）
//   老板 2026-10-08 深夜选定：用 440400，标题和正文里写明「澳门」。
//   于是这里恢复 440400：city 传「澳门」→ 标题/正文出「澳门」；divisionId 440400 → 所在地落珠海。
//   ⚠️ 副作用必须记住：台账里记的 定位 是【我们发出去的值】(广东/澳门/澳门半岛)，
//      而平台实际存的是【珠海】。将来对账别被台账误导 —— 以商品页为准。
//   ⚠️ 下次要发澳门：直接照这个配置发即可（已验证可用）。
//      (a) 若哪天闲鱼支持澳门了，老板在后台手动发一条，我用 editdetail 抓它实际用的码。
//   注：澳门没有国标的区级代码，所以只保留一个「澳门半岛」；同城多条会共用它，
//      assign-areas 会复用并告警，这是预期行为。
//   ⚠️ 香港在源库里是 440300（同样是广东码，实测同理会落珠海），暂未改动 ——
//      等下次真要发香港时按同样办法确认。
if (out['澳门']) {
  const i = out['澳门'].findIndex((a) => a.area === '澳门半岛');
  if (i >= 0) {
    out['澳门'][i] = { prov: '广东', city: '澳门', area: '澳门半岛', divisionId: '440400', gps: '22.198700,113.543900' };
  }
}

// 【2026-10-09 加】曼谷（以及一切境外城市）：闲鱼地址库里没有境外城市，连错的码都没有
//   （澳门至少还有个 440400 能试；全仓+全桌面搜「曼谷/Bangkok/泰国」零命中）。
//   老板 2026-10-09 拍板：「随便找个城市顶替」。
//   做法与澳门完全一致：city 传「曼谷」→ 标题/正文写曼谷；divisionId 用【广州】的区码
//   → 闲鱼把所在地落成广州。代拍是按关键词搜的，所在地主要影响同城流量，
//   所以顶替对这类链接是可接受的（老板已知情并选择）。
//   给【两个区】是为了 2 条链接能落在不同区（澳门只有 1 个区，2 条只能共用）。
//   ⚠️ 副作用：台账的「定位」记的是我们发出去的值(广东/曼谷/天河区)，
//      平台实存是广州 —— 对账以商品页为准。
//   ⚠️ 下次要发别的境外城市，照这个写法加一段即可，先确认要顶替到哪个国内城市。
if (out['曼谷']) {
  // 源库若有（当前没有）就先清空，避免和下面的顶替条目撞 divisionId
  out['曼谷'] = [];
}
out['曼谷'] = [
  // gps 必须与 divisionId 对得上 —— 留空会回落到账号默认坐标，
  // 造成"行政区划写广州、经纬度是别处"的自相矛盾（库里注释专门警告过这个坑）。
  // 这里用广州天河/越秀的实测坐标。
  { prov: '广东', city: '曼谷', area: '天河区', divisionId: '440106', gps: '23.124681,113.361912' },
  { prov: '广东', city: '曼谷', area: '越秀区', divisionId: '440104', gps: '23.128645,113.266835' },
];

// 【2026-10-07 加】脏数据护栏：同一个城市里两个区用了同一个 divisionId → 至少一个错，
// 分不清哪个对，【两个都丢掉】。踩过的实例：address_db 里北京「东城区」和「西城区」都是 110102
// （国标是 110101=东城 / 110102=西城），照用会静默把东城区挂成西城区。
// publish-one.js 的注释早就警告过这种情况：「填错会静默挂到错误的城市」。
const droppedDup = [];
for (const city of Object.keys(out)) {
  const byCode = {};
  for (const a of out[city]) (byCode[a.divisionId] = byCode[a.divisionId] || []).push(a.area);
  const dups = Object.keys(byCode).filter((c) => byCode[c].length > 1);
  if (dups.length) {
    dups.forEach((c) => droppedDup.push(city + ' 代码 ' + c + ' 被 ' + byCode[c].join('/') + ' 共用'));
    out[city] = out[city].filter((a) => byCode[a.divisionId].length === 1);
  }
  if (!out[city].length) delete out[city];
}

console.log('源: ' + ADB + '  (' + arr.length + ' 条)');
console.log('生成城市数: ' + Object.keys(out).length);
console.log('跳过的脏数据（区名=城市名）: ' + skippedCityEqualArea);
console.log('推不出省份的条目: ' + noProv + (noProv ? '  ⚠️ 检查 divisionId 前两位' : '  ✅'));
console.log('重复代码被丢弃的区: ' + droppedDup.length);
droppedDup.forEach((s) => console.log('    ⚠️ ' + s));
console.log('');
for (const c of ['北京', '上海', '广州', '杭州', '泉州', '三亚']) {
  const list = out[c] || [];
  console.log(c + '  区池 ' + list.length + ' 个  prov=' + (list[0] ? list[0].prov : '(无)'));
  list.slice(0, 8).forEach((a) => console.log('    ' + a.area.padEnd(8) + ' ' + a.divisionId + '  gps=' + (a.gps || '(无)')));
}

if (!APPLY) { console.log('\n[预演] 没写文件。加 --apply 真写。'); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('\n✅ 已写 ' + OUT);
