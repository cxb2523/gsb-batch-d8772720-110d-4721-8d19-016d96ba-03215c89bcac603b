/**
 * tools/probe-systemb.js — 探 System B（桌面 xianyu-monitor）的所在地与图片目录
 *
 * System B = 唤醒发布链：XianyuWakePublish 每 30 分钟唤醒电脑 → window.kunPublish.runBatchPublish(1)
 *            → 发 1 条 → 回睡。任务队列在 ~/.xianyu-daily-tasks-<店铺>.json
 *
 * 它和 D:\DSH\achun 的 publish-one.js 是两套系统：
 *   所在地：System B 用 address_db.js 的 ADDRESS_DB + resolveLocation()，不是 achun 的 CITY_ADDR
 *   图片  ：System B 把 imageUrls 里的非 http 项当【文件名】，去店铺图片目录/根图片目录找
 *
 * 用法: node tools/probe-systemb.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const out = require('../lib/out');
const { PATHS } = require('../lib/env');

const DIR = PATHS.xianyuMonitor;
const PUB = path.join(DIR, 'publish.js');
const ADB = path.join(DIR, 'address_db.js');

out.head('System B 探测');

if (!fs.existsSync(PUB)) { out.bad('找不到 ' + PUB); out.done(2); }
const src = fs.readFileSync(PUB, 'utf8');

// ── 图片目录 ──
const grab = (re) => { const m = src.match(re); return m ? m[0].replace(/\s+/g, ' ').trim() : null; };
out.kv('IMAGES_FOLDER', grab(/var\s+IMAGES_FOLDER\s*=\s*[^;]+;/) || '（未找到）');
out.kv('店铺图片目录', grab(/function\s+getStoreImagesFolder\s*\([^)]*\)\s*\{[\s\S]{0,400}?\n\s*\}/) ? '见下' : '（未找到）');
const gsif = src.match(/function\s+getStoreImagesFolder\s*\([^)]*\)\s*\{[\s\S]{0,500}?\n\s{4}\}/);
if (gsif) gsif[0].split('\n').forEach((l) => out.plain('    ' + l.trim()));

// ── 所在地 ──
const rl = src.match(/function\s+resolveLocation\s*\([^)]*\)\s*\{[\s\S]{0,700}?\n\s{4}\}/);
if (rl) {
  out.head('resolveLocation');
  rl[0].split('\n').forEach((l) => out.plain('    ' + l.trim()));
} else {
  out.warn('没找到 resolveLocation');
}

// ── ADDRESS_DB 覆盖 ──
const cities = ['常州', '佛山', '香港', '成都', '上海', '广州', '泉州'];
if (fs.existsSync(ADB)) {
  const sandbox = { window: {}, console: { log() {} } };
  vm.createContext(sandbox);
  try {
    vm.runInContext(fs.readFileSync(ADB, 'utf8'), sandbox, { timeout: 5000 });
    const db = sandbox.ADDRESS_DB || (sandbox.window && sandbox.window.ADDRESS_DB);
    if (!Array.isArray(db)) throw new Error('ADDRESS_DB 不是数组');
    out.head('ADDRESS_DB 城市覆盖');
    out.kv('总条数', db.length);
    const rows = cities.map((c) => {
      const hit = db.filter((a) => a.city === c);
      const districts = [...new Set(hit.map((a) => a.district))].slice(0, 4);
      return [c, hit.length ? '✅ ' + hit.length + ' 条' : '❌ 没有', districts.join(' / ') || '—'];
    });
    out.table(['城市', '覆盖', '区（前4）'], rows, { maxCol: [6, 12, 60] });
  } catch (e) {
    out.bad('address_db.js 解析失败：' + e.message);
  }
} else {
  out.warn('找不到 ' + ADB);
}

out.done(0);
