#!/usr/bin/env node
/**
 * tools/jg-reconcile.js —— 聚光对账（只读）：官方后台 vs 自建台
 *
 * 背景（2026-11-09）：
 *   老板授权官方后台（ad.xiaohongshu.com）只读；lead 用会话抓了一份 **DOM 提取** 的官方 JSON。
 *   实测 17:51 两边一致：日消耗 1483.90 vs 1483.79（0.007%）、余额/预算完全相同。
 *   → 自建台可信；对账的目的不是"证明它不可信"，而是**每天留一份可追溯的差异记录**。
 *
 * 纪律：**只读**。不碰官方后台、不碰自建台，只读两个 JSON + 写本地 data/。
 *
 * 用法：
 *   node tools/jg-reconcile.js --official _tmp\official-unit-list-2026-11-09.json [--slot=pm] [--dry]
 *   node tools/jg-reconcile.js --official <f> --self <快照.json>     # 指定自建台那份
 *   （--self 省略时，自动取 data/jg-snapshot 下最新一份 overview 快照）
 *
 * 退出码：0 = 绿（差异 ≤2% 或时间不同步但已标注）/ 1 = 红（差异 >2%）/ 2 = 输入不足
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAP_DIR = path.join(ROOT, 'data', 'jg-snapshot');
const OUT_DIR = path.join(ROOT, 'data', 'reconcile');
const INDEX = path.join(OUT_DIR, 'index.ndjson');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => {
  const eq = argv.find((x) => x.startsWith('--' + k + '='));
  if (eq) return eq.slice(k.length + 3);
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const DRY = has('--dry');
const THRESHOLD = Number(val('threshold') || 0.02);       // 2%
const MAX_GAP_MIN = Number(val('max-gap-min') || 15);     // 两边取数最多差 15 分钟

const num = (v) => { const x = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : null; };

// ── 官方 DOM JSON 解析（字段是 lead 按页面顺序拼的，标 source:'official-dom'）──
function parseOfficial(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h5 = j.h5_numbers || [];
  const sum = (j.unit_rows || []).find((r) => String(r[2] || '').includes('合计')) || [];
  // 页面顺序：余额 / 日预算 / 日消耗 / 进度% / 日消耗(重复) / 展现 / 点击 / CTR / CPC / CPM …
  const out = {
    source: 'official-dom',
    source_note: j.source || 'ad.xiaohongshu.com DOM extract',
    captured_at: j.captured_at || null,
    account: j.account || null,
    balance: num(h5[0]),
    budget_daily: num(h5[1]),
    spend: num(h5[2]),
    progress_pct: h5[3] || null,
    impressions: num(h5[5]),
    clicks: num(h5[6]),
    ctr: num(h5[7]),
    cpc: num(h5[8]),
    cpm: num(h5[9]),
    // 合计行兜底（与 h5 交叉校验）
    total_row_spend: num(sum[7]),
    total_row_impressions: num(sum[8]),
    total_row_clicks: num(sum[9]),
    unit_rows: (j.unit_rows || []).filter((r) => r && r.length > 5 && !String(r[2] || '').includes('合计')).map((r) => ({
      unit_name: String(r[2] || '').trim(),
      status: String(r[3] || '').trim(),
      audit_status: String(r[5] || '').trim(),   // ← 单元级「审核状态」列（审核通过/未通过/未开启）
      spend: num(r[7]), impressions: num(r[8]), clicks: num(r[9]),
    })),
  };
  // 交叉校验：h5 的日消耗 vs 合计行
  if (out.spend !== null && out.total_row_spend !== null && Math.abs(out.spend - out.total_row_spend) > 0.01) {
    out.cross_check_warning = 'h5 日消耗(' + out.spend + ') 与合计行(' + out.total_row_spend + ') 不一致';
  }
  return out;
}

// ── 自建台：取快照 meta + star 行合计 ───────────────────────────────────────
function parseSelf(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stars = (j.rows || []).filter((r) => r.level === 'star');
  const sumFee = stars.reduce((s, r) => s + (r.fee || 0), 0);
  return {
    source: 'jg-self',
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    fetched_at: (j.meta && j.meta.fetched_at) || null,
    budget_ts: (j.meta && j.meta.budget_ts) || null,
    spend_from_budget: (j.meta && j.meta.budget_daily_cost) != null ? j.meta.budget_daily_cost : null,
    spend_from_star_rows: stars.length ? Number(sumFee.toFixed(2)) : null,
    balance: (j.meta && j.meta.budget_balance) != null ? j.meta.budget_balance : null,
    budget_daily: (j.meta && j.meta.budget_daily) != null ? j.meta.budget_daily : null,
    star_count: stars.length,
  };
}

function latestOverviewSnapshot() {
  if (!fs.existsSync(SNAP_DIR)) return null;
  const all = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.json$/.test(e.name) && !/__promote|__trend|__audit/.test(e.name)) all.push(p);
    });
  })(SNAP_DIR);
  const withMeta = all.map((p) => {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return { p, t: (j.meta && j.meta.fetched_at) || '' }; }
    catch (e) { return { p, t: '' }; }
  }).sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return withMeta.length ? withMeta[withMeta.length - 1].p : null;
}

function minutesBetween(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / 60000;
}

function main() {
  const offFile = val('official');
  if (!offFile) { console.error('缺 --official <官方JSON>'); process.exit(2); }
  const selfFile = val('self') || latestOverviewSnapshot();
  if (!selfFile) { console.error('找不到自建台快照（data/jg-snapshot 下无 overview 快照），用 --self 指定'); process.exit(2); }

  const O = parseOfficial(path.resolve(ROOT, offFile));
  const S = parseSelf(path.resolve(ROOT, selfFile));

  // 自建台"花费"取哪个：优先 budget_daily_cost（自带平台时间），没有再用 star 行合计
  const selfSpend = S.spend_from_budget != null ? S.spend_from_budget : S.spend_from_star_rows;
  const diff = (O.spend != null && selfSpend != null) ? Number((O.spend - selfSpend).toFixed(2)) : null;
  const pct = (diff != null && O.spend) ? Number((Math.abs(diff) / O.spend).toFixed(6)) : null;
  const gap = minutesBetween(O.captured_at, S.fetched_at);

  let verdict = 'green', reason = '';
  if (diff == null) { verdict = 'no-data'; reason = '有一侧缺花费数字'; }
  else if (gap != null && gap > MAX_GAP_MIN) { verdict = 'time-mismatch'; reason = '两侧取数相差 ' + gap.toFixed(1) + ' 分钟 > ' + MAX_GAP_MIN + ' 分钟，不可直接比'; }
  else if (pct > THRESHOLD) { verdict = 'red'; reason = '差异 ' + (pct * 100).toFixed(3) + '% > ' + (THRESHOLD * 100) + '%'; }

  const rec = {
    ts: new Date().toISOString(),
    slot: val('slot') || ((new Date().getHours() < 12) ? 'am' : 'pm'),
    official: { spend: O.spend, balance: O.balance, budget_daily: O.budget_daily, captured_at: O.captured_at, source: O.source, account: O.account, cross_check_warning: O.cross_check_warning || null },
    self: { spend: selfSpend, spend_from_budget: S.spend_from_budget, spend_from_star_rows: S.spend_from_star_rows, balance: S.balance, budget_daily: S.budget_daily, fetched_at: S.fetched_at, file: S.file },
    diff, pct, gap_minutes: gap === null ? null : Number(gap.toFixed(1)),
    threshold: THRESHOLD, verdict, reason,
  };

  console.log('── 聚光对账 ' + new Date().toLocaleString('zh-CN') + ' ──────');
  console.log('官方(官方DOM)  日消耗:', O.spend, '| 余额:', O.balance, '| 日预算:', O.budget_daily, '| 取数:', O.captured_at);
  console.log('自建台(jg)     日消耗:', selfSpend, '| 余额:', S.balance, '| 日预算:', S.budget_daily, '| 取数:', S.fetched_at);
  console.log('差异:', diff, '元  =', pct === null ? 'n/a' : (pct * 100).toFixed(3) + '%', '| 两侧时差:', gap === null ? 'n/a' : gap.toFixed(1) + ' 分钟');
  console.log('判定:', verdict === 'green' ? '🟢 一致' : verdict === 'red' ? '🔴 超阈值' : verdict === 'time-mismatch' ? '🟡 时间不同步（不可比）' : '⚪ 数据不足', reason ? ('— ' + reason) : '');
  if (O.cross_check_warning) console.log('⚠ 官方内部不一致:', O.cross_check_warning);
  if (O.unit_rows && O.unit_rows.length) {
    const audit = O.unit_rows.reduce((a, r) => { const k = r.audit_status || '(空)'; a[k] = (a[k] || 0) + 1; return a; }, {});
    console.log('单元级审核状态分布:', JSON.stringify(audit));
  }

  if (DRY) { console.log('（--dry：未落盘）'); process.exit(verdict === 'red' ? 1 : 0); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const base = dateStr + '__' + rec.slot;
  let file = path.join(OUT_DIR, base + '.json'), n = 1;
  while (fs.existsSync(file)) { n++; file = path.join(OUT_DIR, base + '.r' + n + '.json'); }
  const text = JSON.stringify(rec, null, 1);
  fs.writeFileSync(file, text, 'utf8');
  fs.appendFileSync(INDEX, JSON.stringify({
    path: path.relative(ROOT, file).split(path.sep).join('/'), date: dateStr, slot: rec.slot,
    official_spend: O.spend, self_spend: selfSpend, diff, pct, gap_minutes: rec.gap_minutes, verdict,
  }) + '\n', 'utf8');
  console.log('✅ 已写:', path.relative(ROOT, file).split(path.sep).join('/'));
  process.exit(verdict === 'red' ? 1 : 0);
}

main();
