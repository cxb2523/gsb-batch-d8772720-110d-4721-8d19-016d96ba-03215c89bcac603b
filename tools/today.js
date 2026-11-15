/**
 * tools/today.js — 【共享作业视图】今天到底发生了什么（任何 session 都能读）
 *
 * 为什么需要它（老板 2026-10-08 原话）：
 *   「你们两个信息不共享的吗？」—— 桌面那个会话和我这个会话【不共享对话上下文】，
 *   只共享这个工作目录。所以只要有人做了事而没写进文件，另一头就完全不知道。
 *
 *   实测那次：桌面会话 18:47 发完 3 条 KPL、19:10 建完计划，
 *   我这边 19:36 接手时是【靠翻文件】才拼出全过程的：
 *     上架台账.json（谁发了什么）+ ad-guangzhou-kpl-cfgs.json（计划参数）
 *     + run-cfgs-log-kpl.ndjson（计划提交结果）。
 *   信息其实都在，只是散在 4 种格式的文件里，没人愿意每次去拼。
 *   这个脚本就是把它们合并成一张按时间排的表。
 *
 * 它【只读文件、不碰浏览器】，所以任何一台机器、任何时候都能秒出结果。
 * 要看计划的【实时】投放状态用 tools/ad-status.js（那个要连 8093）。
 *
 * 用法:
 *   node tools/today.js            # 今天（本地时区）
 *   node tools/today.js --days=3   # 近 3 天
 *   node tools/today.js --all      # 全部
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');

const ARGV = process.argv.slice(2);
const argOf = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const ALL = ARGV.indexOf('--all') >= 0;
const DAYS = ALL ? 3650 : Number(argOf('days', '1'));
const SINCE = Date.now() - DAYS * 86400000;

const rows = [];
const add = (t, kind, what, extra) => {
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  if (!isFinite(ms) || ms < SINCE) return;
  rows.push({ ms, kind, what: String(what || ''), extra: String(extra || '') });
};
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return d; } };
const readLines = (f) => {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean); }
  catch (e) { return []; }
};
const listFiles = (re) => { try { return fs.readdirSync(ROOT).filter((n) => re.test(n)); } catch (e) { return []; } };

// ── ① 上架（上架台账.json）──
readJSON('上架台账.json', []).forEach((r) => {
  const okk = r.ok !== false;
  add(r.时间, okk ? '上架' : '上架✗',
    (okk ? '✅ ' : '❌ ') + (r.store || '?') + '  ' + String(r.city || '') + String(r.star || '') +
    (r.session ? '·' + r.session : '') + '  ' + (r.itemId || ''),
    String(r.标题 || '').slice(0, 34) + '  ¥' + (r.price || '?') + '  主图=' + (r.主图模板 || '?'));
});

// ── ② 建推广计划（run-cfgs-log-*.ndjson + ad-plan-create 结果）──
listFiles(/^run-cfgs-log.*\.ndjson$/).forEach((f) => {
  readLines(f).forEach((line) => {
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    const state = j.confirmed ? '✅ 已确认' : (j.submitted ? '⚠️ 已提交未确认' : '⛔ 未提交');
    add(j.ts, '建计划', state + '  ' + (j.name || '?'),
      '目标=' + (j.target || '?') + ' 出价=' + (j.bid || '?') + ' 提升=' + (j.imp || '?') +
      '  ' + (j.aborted ? '中止: ' + j.aborted : '') + '  [' + f + ']');
  });
});
{
  const r = readJSON('ad-plan-create-result.json', null);
  if (r && r.found) add(new Date(), '建计划', '✅ ad-plan-create 建了 ' + r.count + ' 个「' + r.title + '」',
    '回读命中 ' + r.found.length + ' 个');
}

// ── ③ 运维动作（各种 .log，格式统一是 [时间] 正文）──
const LOG_KINDS = {
  'update.log': '更新代码',
  'set-ad-hours.log': '改时段',
  'ad-plan-alert.log': '计划巡检',
  'ad-plan-create.log': '建计划',
  'ad-daily-report.log': '广告日报',
};
Object.keys(LOG_KINDS).forEach((f) => {
  readLines(f).forEach((line) => {
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!m) return;
    add(m[1], LOG_KINDS[f], m[2].slice(0, 88), '[' + f + ']');
  });
});

// ── 输出 ──
rows.sort((a, b) => a.ms - b.ms);
const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

console.log('');
console.log('════ 共享作业视图 · ' + (ALL ? '全部' : '近 ' + DAYS + ' 天') + ' · 共 ' + rows.length + ' 条 ════');
console.log('');
if (!rows.length) {
  console.log('  （这段时间没有任何记录）');
} else {
  const byKind = {};
  rows.forEach((r) => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
  console.log('  分类: ' + Object.keys(byKind).map((k) => k + '×' + byKind[k]).join('   '));
  console.log('');
  console.log('  时间             类型        内容');
  console.log('  ' + '-'.repeat(104));
  rows.forEach((r) => {
    console.log('  ' + fmt(r.ms).padEnd(16) + r.kind.padEnd(11) + r.what);
    if (r.extra) console.log('  ' + ' '.repeat(27) + r.extra);
  });
}

// ── 未完成 / 需要人看一眼的 ──
// ⚠️ 只按【计划的最后一条记录】判，不逐条判。
//   为什么：每次建计划都是「先 dry run → 再真提交」，逐条判会把所有 dry run 都报成
//   「没提交」。第一版就是这样，7 条里 6 条是假警报 —— 假警报多了这一节就没人看了。
const pending = [];
listFiles(/^run-cfgs-log.*\.ndjson$/).forEach((f) => {
  const latest = {};
  readLines(f).forEach((line) => {
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    const ms = Date.parse(j.ts);
    if (!isFinite(ms) || ms < SINCE) return;
    if (j.checks && Object.keys(j.checks).some((k) => !j.checks[k])) {
      const bad = Object.keys(j.checks).filter((k) => !j.checks[k]);
      pending.push('计划「' + j.name + '」校验没过: ' + bad.join(', ') + '  [' + f + ']');
    }
    if (!latest[j.name] || ms > latest[j.name].ms) latest[j.name] = { ms, j, f };
  });
  Object.keys(latest).forEach((name) => {
    const { j, f: ff } = latest[name];
    if (!j.confirmed) {
      pending.push('计划「' + name + '」最后一条记录仍是未确认（' +
        (j.submitted ? '已提交未确认' : '未提交') + (j.aborted ? '：' + j.aborted : '') + '）  [' + ff + ']');
    }
  });
});
if (pending.length) {
  console.log('');
  console.log('════ ⚠️ 未完成 / 要人看一眼 ════');
  pending.forEach((p) => console.log('  · ' + p));
}
console.log('');
console.log('  ⚠️ 这张表只反映【写进文件的动作】。计划的实时投放状态（在投/暂停/花费）要看：');
console.log('     node tools/ad-status.js --days=1');
console.log('');
