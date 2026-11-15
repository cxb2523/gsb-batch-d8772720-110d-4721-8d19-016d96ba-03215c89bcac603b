/**
 * tools/test-city-fallback.js — 单测「地址库没有的城市」的落位规则
 *
 * 做法：把 publish.js 里 **真实的** resolveLocation 函数体、CITY_FALLBACK、TIER1_CITIES
 * 抽出来，在一个沙箱里跑（ADDRESS_DB 用假数据模拟真实情况：香港/澳门【存在】）。
 * 抽的是真源码，不是抄一份，所以改坏了它一定会红。
 *
 * 为什么不用真浏览器测：kunPublish 没导出 resolveLocation，只能靠发布真实商品来观察，
 * 那要等队列轮到香港（几小时）。抽函数体是立刻可得的等价验证。
 *
 * 老板规则（2026-09-29）：
 *   香港 → 广州 / 深圳        澳门 → 珠海 / 广州 / 深圳
 *   其它国外（新加坡、吉隆坡…）→ 随机一线城市（北京/上海/广州/深圳）
 *   在地址库里的国内城市 → 原样使用
 *
 * 用法: node tools/test-city-fallback.js
 * 退出码: 0 全部通过；1 有断言失败
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const { PATHS, ROOT } = require('../lib/env');

const SRC = path.join(PATHS.xianyuMonitor, 'publish.js');
const N = 40;   // 每个 case 跑多少次（用来看分布）

function extractFn(s, header) {
  const i = s.indexOf(header);
  if (i < 0) throw new Error('找不到 ' + header);
  let j = s.indexOf('{', i), depth = 0, k = j;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return s.slice(i, k + 1);
}

let src;
try { src = fs.readFileSync(SRC, 'utf8'); }
catch (e) { out.bad('读不到 ' + SRC + '：' + e.message); out.done(2); }

const FN = extractFn(src, 'function resolveLocation(storeCfg, taskCity)');
const mCF = src.match(/var CITY_FALLBACK = \{[\s\S]*?\n\s*\};/);
const mT1 = src.match(/var TIER1_CITIES = \[[^\]]*\];/);
if (!mCF) { out.bad('publish.js 里找不到 CITY_FALLBACK（规则没加上？）'); out.done(1); }
if (!mT1) { out.bad('找不到 TIER1_CITIES'); out.done(1); }

// 真实的 ADDRESS_DB 里香港/澳门是【存在】的（各 4 条），这里如实模拟
const FAKE_DB = ['常州', '佛山', '成都', '上海', '香港', '澳门', '广州', '深圳', '珠海', '北京']
  .map((c) => ({ city: c }));

const mod = { exports: {} };
new Function('module', 'exports', 'ADDRESS_DB',
  mT1[0] + '\n' + mCF[0] + '\n' + FN + '\n; module.exports = { resolveLocation: resolveLocation };'
)(mod, mod.exports, FAKE_DB);

const { resolveLocation } = mod.exports;
const storeCfg = { locationMode: 'city', fixedCity: '', fixedDistrict: '' };

function runs(city) {
  const hit = {};
  for (let i = 0; i < N; i++) {
    const r = resolveLocation(storeCfg, city) || {};
    hit[r.city || '?'] = (hit[r.city || '?'] || 0) + 1;
  }
  return hit;
}

out.head('落位规则单测（每个 ' + N + ' 次）');

const CASES = [
  { city: '香港', allow: ['广州', '深圳'] },
  { city: '澳门', allow: ['珠海', '广州', '深圳'] },
  { city: '新加坡', allow: ['北京', '上海', '广州', '深圳'] },
  { city: '吉隆坡', allow: ['北京', '上海', '广州', '深圳'] },
  { city: '常州', allow: ['常州'] },
  { city: '佛山', allow: ['佛山'] },
  { city: '成都', allow: ['成都'] },
];

let bad = 0;
const rows = [];
CASES.forEach((c) => {
  const hit = runs(c.city);
  const got = Object.keys(hit);
  const ok = got.every((g) => c.allow.indexOf(g) >= 0);
  if (!ok) bad++;
  rows.push([c.city, c.allow.join('/'), got.map((g) => g + '×' + hit[g]).join(' '), ok ? '✅' : '❌']);
});

out.table(['任务城市', '允许落到', '实测分布', ''], rows, { maxCol: [8, 20, 34, 3] });

// ── System A：D:\DSH\achun\publish-one.js 的 resolveAddr ──
// 两套系统必须同规则，否则「同一场次两个系统发出来所在地不一样」。
out.head('System A · publish-one.js 的 resolveAddr');
const SRC_A = path.join(ROOT, 'publish-one.js');
try {
  const srcA = fs.readFileSync(SRC_A, 'utf8');
  const mAddr = srcA.match(/const CITY_ADDR = \{[\s\S]*?\n\};/);
  const mFall = srcA.match(/const CITY_FALLBACK = \{[\s\S]*?\n\};/);
  const mT1 = srcA.match(/const TIER1_CITIES = \[[^\]]*\];/);
  const mPick = srcA.match(/const pickOne = [^;]+;/);
  const fnA = extractFn(srcA, 'function resolveAddr(city)');
  ['CITY_ADDR', 'CITY_FALLBACK', 'TIER1_CITIES', 'pickOne', 'resolveAddr'].forEach((k, i) => {
    const got = [mAddr, mFall, mT1, mPick, fnA][i];
    if (!got) throw new Error('publish-one.js 里找不到 ' + k);
  });

  const modA = { exports: {} };
  new Function('module', 'exports',
    mAddr[0] + '\n' + mFall[0] + '\n' + mT1[0] + '\n' + mPick[0] + '\n' + fnA +
    '\n; module.exports = { resolveAddr: resolveAddr };'
  )(modA, modA.exports);
  const resolveAddr = modA.exports.resolveAddr;

  const rowsA = [];
  CASES.forEach((c) => {
    const hit = {};
    for (let i = 0; i < N; i++) {
      const r = resolveAddr(c.city) || {};
      hit[r.city || '?'] = (hit[r.city || '?'] || 0) + 1;
    }
    const got = Object.keys(hit);
    const ok = got.every((g) => c.allow.indexOf(g) >= 0);
    if (!ok) bad++;
    rowsA.push([c.city, c.allow.join('/'), got.map((g) => g + '×' + hit[g]).join(' '), ok ? '✅' : '❌']);
  });
  out.table(['任务城市', '允许落到', '实测分布', ''], rowsA, { maxCol: [8, 20, 34, 3] });
} catch (e) {
  out.bad('System A 测试失败：' + e.message);
  bad++;
}

out.head('结果');
if (bad) {
  out.bad(bad + ' 个 case 没通过');
  out.plain('  最常见原因：CITY_FALLBACK 的判断被放在了 ADDRESS_DB 判断【之后】——');
  out.plain('  那样香港/澳门因为「地址库里本来就有」而直接返回香港/澳门，规则等于没生效。');
  out.plain('  改完记得两边都跑：桌面 publish.js 与 achun publish-one.js 必须是同一套规则。');
  out.done(1);
}
out.ok('两个系统都通过：香港→广州/深圳，澳门→珠海/广州/深圳，国外→一线随机，国内城市原样');
out.done(0);
