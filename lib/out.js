/**
 * lib/out.js — 统一输出纪律
 *
 * 目的：让每次运行默认只吐十几行摘要，全量数据落盘。以前一次巡检直接
 * console.log 出 5–15 KB 的 JSON，读一次就吃掉几千 token，而且信息还没少。
 *
 * 截断策略（v2，修正了 v1 的蠢设计）：
 *   v1 按行数从尾巴切，结果把最该看的表格切掉了 —— 而表格恰恰是这个脚本存在的理由。
 *   v2 给每行打「必需 / 散文」标记：
 *     必需 = 标题行、表格全部行列、✅⚠️❌ 结论行、全量文件路径
 *     散文 = kv 明细
 *   截断只丢散文，表格和结论永远保留。
 *
 * 用法：
 *   const out = require('./lib/out');
 *   out.head('擦亮计划巡检');
 *   out.kv('拉取条数', list.length);
 *   out.table(['id','名称','状态'], rows);
 *   out.ok('无异常');
 *   out.full(raw, 'ad-plans');     // 全量写 logs/ad-plans-<时间>.json
 *   out.done(0);                   // 打印并退出
 *
 * 命令行开关：--full 不截断  --quiet 不打印（只落盘）
 * 环境变量：XY_OUT_MAX 覆盖行数预算
 */
const fs = require('fs');
const path = require('path');
const { ROOT, OUT } = require('./env');

const FULL = process.argv.includes('--full');
const QUIET = process.argv.includes('--quiet');
const MAX = Number(process.env.XY_OUT_MAX || OUT.maxLines || 15);

const buf = [];          // { t: string, keep: boolean }
let exited = false;

function scriptName() {
  return path.basename(process.argv[1] || 'out').replace(/\.js$/i, '');
}

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}

// ── 写入缓冲 ──
function push(s, keep) { buf.push({ t: String(s), keep: !!keep }); }
const line = (s) => push(s, false);                       // 散文
const plain = (s) => push(s, true);                       // 结论性单行
const head = (t) => { push('', true); push('── ' + t + ' ' + '─'.repeat(Math.max(0, 44 - String(t).length)), true); };
const kv = (k, v) => push('  ' + k + ': ' + v, false);
const ok = (s) => push('✅ ' + s, true);
const warn = (s) => push('⚠️ ' + s, true);
const bad = (s) => push('❌ ' + s, true);

/** 表格：中文按 2 列宽对齐；整表标记为必需，永不被截断 */
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\uFFFD]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s, w) {
  const d = w - width(s);
  return String(s) + (d > 0 ? ' '.repeat(d) : '');
}
function table(headers, rows, opts) {
  opts = opts || {};
  const w = headers.map((h, i) => {
    let m = width(h);
    for (const r of rows) m = Math.max(m, width(r[i] === undefined ? '' : r[i]));
    return Math.min(m, (opts.maxCol && opts.maxCol[i]) || 42);
  });
  const cut = (s, i) => {
    s = String(s === undefined ? '' : s);
    if (width(s) <= w[i]) return s;
    let acc = '', n = 0;
    for (const ch of s) { const cw = /[\u1100-\uFFFD]/.test(ch) ? 2 : 1; if (n + cw > w[i] - 1) break; acc += ch; n += cw; }
    return acc + '…';
  };
  push('  ' + headers.map((h, i) => pad(cut(h, i), w[i])).join('  '), true);
  push('  ' + w.map((x) => '─'.repeat(x)).join('  '), true);
  for (const r of rows) push('  ' + headers.map((_, i) => pad(cut(r[i], i), w[i])).join('  '), true);
}

/** 全量数据落盘，返回文件路径；摘要里只留一行路径 */
function full(data, label) {
  const dir = path.join(ROOT, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  const f = path.join(dir, (label || scriptName()) + '-' + stamp() + '.json');
  try {
    fs.writeFileSync(f, JSON.stringify(data, null, 1), 'utf8');
    push('  📄 全量: logs/' + path.basename(f), true);
  } catch (e) {
    push('  ⚠️ 全量落盘失败: ' + e.message, true);
  }
  return f;
}

/**
 * 截断：必需行全留；散文行在剩余预算内从头保留，其余省略。
 * 表格很大时预算被必需行占满，就整表输出并明说省略了多少散文行。
 */
function trim() {
  if (FULL || buf.length <= MAX) return buf.map((e) => e.t);

  const keepIdx = [];
  for (let i = 0; i < buf.length; i++) if (buf[i].keep) keepIdx.push(i);
  const keepSet = new Set(keepIdx);

  const budget = MAX - keepIdx.length;
  if (budget <= 0) {
    const kept = buf.filter((e) => e.keep).map((e) => e.t);
    const dropped = buf.length - keepIdx.length;
    if (dropped > 0) kept.splice(2, 0, '  （省略 ' + dropped + ' 行明细，表格与结论已全部保留；--full 看全部）');
    return kept;
  }

  // 散文行：从前往后给预算
  let used = 0;
  const outLines = [];
  for (let i = 0; i < buf.length; i++) {
    if (keepSet.has(i)) { outLines.push(buf[i].t); continue; }
    if (used < budget) { outLines.push(buf[i].t); used++; }
    else if (used === budget) { outLines.push('  … 其余散文行已省略（表格与结论已全部保留；--full 看全部）'); used++; }
  }
  return outLines;
}

function done(code) {
  if (exited) return;
  exited = true;
  if (!QUIET) process.stdout.write(trim().join('\n') + '\n');
  process.exit(code || 0);
}

function fail(e, code) {
  bad((e && e.message) || String(e));
  if (e && e.stack && process.env.XY_DEBUG) line(e.stack);
  done(code === undefined ? 1 : code);
}

function raw() { return buf.map((e) => e.t).join('\n'); }

module.exports = {
  line, info: line, log: line, plain, head, kv, ok, warn, bad, table, full, done, fail, raw,
  scriptName, FULL, MAX,
};
