/**
 * tools/jg-promote-diff.js —— 只读 diff：把两次 promote 快照的差异变成"决策变更事件流"
 *
 * 为什么存在：`/api/promote/rows` 只有**当前态**（J 推/停）和**最近更新时间**（C），
 * 没有操作人、没有历史。所以**历史只能由我们的快照造出来**——这正是 fixture 体系存在的理由。
 *
 * 用法：
 *   node tools/jg-promote-diff.js                          # 自动取 data/ 下最近两份 promote 快照
 *   node tools/jg-promote-diff.js --a <前>.json --b <后>.json
 *   node tools/jg-promote-diff.js --a <前>.json --b <后>.json --dry   # 只打印，不写
 *
 * 输出：`data/jg-snapshot/promote-diff.ndjson`，一行一个事件。事件类型：
 *   changed  —— 同一场次，J（推/停）或 F/H/I 发生变化
 *   added    —— 只出现在后一份（新推 / 新录）
 *   removed  —— 只出现在前一份（撤下 / 不再出现）
 *   no-compare —— 只有一份快照，**如实说"无对照"，不假装没有变更**
 *
 * 关键：每个事件同时带 **两个时间**——
 *   `platform_updated_at`（C 更新时间，平台自己记的）与
 *   `observed_fetched_at`（两份快照各自的 fetched_at，我们观测的）。
 *   **真正能当审计时刻的只有 observed_fetched_at**（我们自己的取数时刻）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'jg-snapshot');
const OUT = path.join(DIR, 'promote-diff.ndjson');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => {
  const eq = argv.find((x) => x.startsWith('--' + k + '='));
  if (eq) return eq.slice(k.length + 3);
  const i = argv.indexOf('--' + k);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return null;
};
const DRY = has('--dry');

function supersededSet() {
  const idx = path.join(DIR, 'index.ndjson');
  const out = new Set();
  if (!fs.existsSync(idx)) return out;
  fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean).forEach((l) => {
    try { const j = JSON.parse(l); if (j.superseded_by) out.add(j.path); } catch (e) {}
  });
  return out;
}

function listPromoteSnapshots() {
  const out = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/__promote(\.r\d+)?\.json$/.test(e.name)) out.push(p);
    });
  })(DIR);
  // 按文件内 meta.fetched_at 排序（没有就退回 mtime）
  const sup = supersededSet();
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  return out.filter((p) => !sup.has(rel(p))).map((p) => {
    let fetched = null;
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); fetched = (j.meta && j.meta.fetched_at) || null; } catch (e) {}
    return { path: p, fetched, mtime: fs.statSync(p).mtimeMs };
  }).sort((x, y) => String(x.fetched || x.mtime).localeCompare(String(y.fetched || y.mtime)));
}

function load(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rows = (j.rows || []).filter((r) => r.level === 'promote');
  return { meta: j.meta || {}, rows };
}

const keyOf = (r) => [r['A_日期'], r['D_场次'], r['F_开次'], r['H_票种'], r.row].join('|');

function main() {
  let aPath = val('a'), bPath = val('b');
  if (!aPath || !bPath) {
    const all = listPromoteSnapshots();
    if (all.length === 0) {
      emit([{ type: 'no-compare', reason: 'data/jg-snapshot 下没有任何 promote 快照', at: new Date().toISOString() }]);
      return;
    }
    if (all.length === 1) {
      emit([{
        type: 'no-compare',
        reason: '只有 1 份 promote 快照，没有对照基准',
        only_snapshot: path.relative(ROOT, all[0].path).replace(/\\/g, '/'),
        observed_fetched_at: all[0].fetched,
        at: new Date().toISOString(),
      }]);
      return;
    }
    aPath = all[all.length - 2].path; bPath = all[all.length - 1].path;
  }

  const A = load(aPath), B = load(bPath);
  const ma = new Map(A.rows.map((r) => [keyOf(r), r]));
  const mb = new Map(B.rows.map((r) => [keyOf(r), r]));
  const events = [];
  const base = {
    prev_snapshot: path.relative(ROOT, aPath).replace(/\\/g, '/'),
    next_snapshot: path.relative(ROOT, bPath).replace(/\\/g, '/'),
    prev_observed_fetched_at: A.meta.fetched_at || null,
    next_observed_fetched_at: B.meta.fetched_at || null,
  };

  mb.forEach((r, k) => {
    const before = ma.get(k);
    if (!before) {
      events.push({ ...base, type: 'added', event_key: k, 场次: r['D_场次'], 开次: r['F_开次'], 票种: r['H_票种'],
        before_state: null, after_state: r['J_推停'], 数量_after: r['I_数量'],
        slot_end: r.slot_end || r['C_更新时间'] || null, slot_start: r.slot_start || r['B_时间'] || null });
      return;
    }
    const changed = before['J_推停'] !== r['J_推停'] || before['I_数量'] !== r['I_数量']
      || before['F_开次'] !== r['F_开次'] || before['H_票种'] !== r['H_票种'];
    if (changed) {
      events.push({ ...base, type: 'changed', event_key: k, 场次: r['D_场次'], 开次: r['F_开次'], 票种: r['H_票种'],
        before_state: before['J_推停'], after_state: r['J_推停'],
        数量_before: before['I_数量'], 数量_after: r['I_数量'],
        slot_end: r.slot_end || r['C_更新时间'] || null, slot_start: r.slot_start || r['B_时间'] || null,
        slot_end_before: before.slot_end || before['C_更新时间'] || null,
        slot_end_moved: String(before.slot_end || before['C_更新时间']) !== String(r.slot_end || r['C_更新时间']) });
    }
  });
  ma.forEach((r, k) => {
    if (!mb.has(k)) {
      events.push({ ...base, type: 'removed', event_key: k, 场次: r['D_场次'], 开次: r['F_开次'], 票种: r['H_票种'],
        before_state: r['J_推停'], after_state: null, 数量_before: r['I_数量'],
        slot_end: r.slot_end || r['C_更新时间'] || null, slot_start: r.slot_start || r['B_时间'] || null });
    }
  });

  if (events.length === 0) {
    events.push({ ...base, type: 'changed', event_key: null, note: '两份快照完全一致（无变更）',
      场次: null, before_state: null, after_state: null });
  }
  emit(events);
}

function emit(events) {
  console.log('── promote diff ────────────────────────');
  console.log('事件数:', events.length);
  events.slice(0, 12).forEach((e) => console.log('  ', JSON.stringify(e)));
  console.log('时间列: slot_start/slot_end = 平台排程窗口（B→C，不是操作时刻）；observed_fetched_at = 我们两份快照的取数时刻（唯一可当审计时刻的）');
  if (DRY) { console.log('（--dry：未写 promote-diff.ndjson）'); return; }
  fs.mkdirSync(DIR, { recursive: true });
  events.forEach((e) => fs.appendFileSync(OUT, JSON.stringify(e) + '\n', 'utf8'));
  console.log('✅ 已追加:', path.relative(ROOT, OUT).replace(/\\/g, '/'));
}

main();
