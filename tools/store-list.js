/**
 * tools/store-list.js — 全店对照表（一眼看出谁配错了）
 *
 * 为什么需要它：
 *   3 个店的时候 `store-init --all` 够了；30 个、100 个店的时候没人会去逐个读输出。
 *   这个工具把每份档案的关键维度压成一行，并把**离线就能判定的问题**单独列出来。
 *   "开 100 个店"真正会出错的地方不是单店配置写不对，而是【某几个店跟其他店不一样】还没人发现。
 *
 * 特点：**只读档案，不连网** —— 100 个店也是毫秒级。
 *   需要连网核对的（账号表 / 版式库 / 店铺页）用 tools/store-init.js --all。
 *
 * 用法:
 *   node tools/store-list.js                 # 对照表 + 问题清单 + 分组统计
 *   node tools/store-list.js --json          # 机读（接别的脚本/表格）
 *   node tools/store-list.js --only=live     # 只看 live（或 --only=draft）
 *   node tools/store-list.js --issues        # 只打问题清单
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');
const profile = require('../lib/store-profile');

const ARGV = process.argv.slice(2);
const flag = (k) => ARGV.indexOf('--' + k) >= 0;
const opt = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const JSON_OUT = flag('json');
const ONLY = opt('only', '');
const ISSUES_ONLY = flag('issues');

// ── 中英混排的显示宽度（一个汉字/emoji 占 2 列，否则表格对不齐）──
function dw(s) {
  let n = 0;
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x1100 && (
      c <= 0x115F || c === 0x2329 || c === 0x232A ||
      (c >= 0x2E80 && c <= 0xA4CF && c !== 0x303F) ||
      (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) ||
      (c >= 0xFFE0 && c <= 0xFFE6) ||
      (c >= 0x1F300 && c <= 0x1F9FF) || (c >= 0x20000 && c <= 0x3FFFD))) n += 2;
    else n += 1;
  }
  return n;
}
function pad(s, n) { s = String(s == null ? '' : s); return s + ' '.repeat(Math.max(0, n - dw(s))); }
function cut(s, n) {
  s = String(s == null ? '' : s);
  if (dw(s) <= n) return s;
  let out = '', w = 0;
  for (const ch of s) { const c = dw(ch); if (w + c > n - 1) break; out += ch; w += c; }
  return out + '…';
}

/** 取点号路径（支持中文键），取不到返回 undefined */
function at(o, p) {
  let cur = o;
  for (const k of String(p).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 离线问题检查：只依赖档案 + 本地文件系统 */
function issuesOf(P) {
  const out = [];
  const add = (lv, msg) => out.push({ level: lv, msg: msg });

  if (!P.accountId) add('fail', 'accountId 空 —— 见 8093 的 GET /api/agent/accounts');
  if (P.status === 'draft') add('warn', '草稿店（status=draft）：还没接完，不参与自动开窗');
  if (!P.enabled) add('warn', 'enabled=false：全店维度的自动化会跳过它');

  const tpls = (P.主图 || {}).templates || [];
  if (!tpls.length) add('fail', '主图版式池是空的');
  const unreg = tpls.filter((id) => !profile.TPL_REGISTRY[id]);
  if (unreg.length) add('warn', '主图版式没登记到 TPL_REGISTRY：' + unreg.join('、') + '（可能静默出成别的版式）');

  for (const [label, rel] of [['主图.baseImg', (P.主图 || {}).baseImg]]
    .concat(((P.主图 || {}).stickers || []).map((s) => ['主图.stickers', s.file]))) {
    if (!rel) continue;
    const f = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!fs.existsSync(f)) add('fail', label + ' 文件不存在：' + rel);
  }

  const subDir = (P.副图 || {}).dir || '';
  if (subDir) {
    const d = path.isAbsolute(subDir) ? subDir : path.join(ROOT, subDir);
    if (!fs.existsSync(d)) add('fail', '副图目录不存在：' + subDir);
    else {
      const n = fs.readdirSync(d).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
      if ((P.副图 || {}).count && n !== P.副图.count) add('warn', '副图张数不符：档案 ' + P.副图.count + ' 实际 ' + n);
      if (!n) add('warn', '副图目录是空的（档案配了目录但没图）');
      const dup = fs.readdirSync(d).filter((f) => /主图/.test(f));
      if (dup.length) add('fail', '副图目录混进主图：' + dup.join('、') + '（会被再发一遍）');
    }
  }

  const ids = (P.文案 || {}).templateIds;
  if (!ids || !ids.length) add('warn', '文案池没指定 → 会用【全部】模板，容易串到别店的话术');
  if (!Number((P.文案 || {}).titleMin)) add('warn', '文案.titleMin 没设');
  if (!(P.分类 || {}).catName) add('fail', '分类.catName 空');
  if (!(P.分类 || {}).channelCatId) add('fail', '分类.channelCatId 空（发布必填）');
  if (!(P.分类 || {}).catId) add('warn', '分类.catId 空 —— 有些类目确实没有，但要实抓确认过');
  const specs = (P.规格 || {}).specs || [];
  if (!specs.length) add('fail', '规格.specs 是空的（价格/库存都靠它）');
  for (const s of specs) if (!s || !s.valueText) add('fail', '规格有一档没写 valueText');
  if (!((P.价格 || {}).default > 0)) add('fail', '价格.default 非法：' + (P.价格 || {}).default);
  if (!((P.库存 || {}).default >= 0)) add('fail', '库存.default 非法：' + (P.库存 || {}).default);

  return out;
}

// ── 收集 ──
const names = profile.list();
const rows = [];
for (const n of names) {
  let P, err = '';
  try { P = profile.load(n); } catch (e) { err = e.message; }
  if (ONLY && P && P.status !== ONLY) continue;
  if (ONLY && !P) continue;
  rows.push({ name: n, P: P, err: err, issues: P ? issuesOf(P) : [{ level: 'fail', msg: '档案读不了：' + err }] });
}

// accountId 查重（跨店，只能在收集完之后判）
const seen = {};
for (const r of rows) {
  const id = r.P && r.P.accountId;
  if (!id) continue;
  if (seen[id]) {
    const msg = 'accountId 与「' + seen[id] + '」重复 —— 同一个闲鱼账号绝不能被两个店操作（登录互踢 + 重复发布）';
    r.issues.push({ level: 'fail', msg: msg });
    const other = rows.find((x) => x.name === seen[id]);
    if (other) other.issues.push({ level: 'fail', msg: 'accountId 与「' + r.name + '」重复' });
  } else seen[id] = r.name;
}

if (JSON_OUT) {
  console.log(JSON.stringify(rows.map((r) => ({
    name: r.name, status: r.P ? r.P.status : null, enabled: r.P ? r.P.enabled : null,
    accountId: r.P ? r.P.accountId : null,
    主图池: r.P ? at(r.P, '主图.templates') : null,
    副图: r.P ? at(r.P, '副图') : null,
    文案池: r.P ? at(r.P, '文案.templateIds') : null,
    分类: r.P ? at(r.P, '分类') : null,
    规格: r.P ? at(r.P, '规格') : null,
    价格: r.P ? at(r.P, '价格.default') : null,
    库存: r.P ? at(r.P, '库存.default') : null,
    所在地: r.P ? at(r.P, '所在地') : null,
    发货方式: r.P ? at(r.P, '发货方式.shipMode') : null,
    承诺: r.P ? at(r.P, '承诺') : null,
    广告: r.P ? at(r.P, '广告') : null,
    问题: r.issues,
  })), null, 2));
  process.exit(0);
}

const live = rows.filter((r) => r.P && r.P.status === 'live').length;
const draft = rows.filter((r) => r.P && r.P.status === 'draft').length;
console.log('── 总览 ──');
console.log('  档案 ' + rows.length + ' 份（live ' + live + ' / draft ' + draft + (rows.length - live - draft ? ' / 坏 ' + (rows.length - live - draft) : '') + '）');

function group(label, fn) {
  const m = {};
  for (const r of rows) {
    if (!r.P) continue;
    const k = fn(r.P);
    m[k] = (m[k] || 0) + 1;
  }
  const parts = Object.keys(m).sort((a, b) => m[b] - m[a]).map((k) => k + '×' + m[k]);
  console.log('  ' + pad(label, 10) + ' ' + parts.join('   '));
}
group('分类', (P) => at(P, '分类.catName') || '(空)');
group('价格', (P) => '¥' + at(P, '价格.default'));
group('所在地', (P) => at(P, '所在地.mode') || '(空)');
group('发货方式', (P) => at(P, '发货方式.shipMode') || '(空)');
group('广告', (P) => (at(P, '广告.enabled') === false ? '关' : '开'));
group('主图池', (P) => '[' + ((at(P, '主图.templates') || []).join('+') || '空') + ']');

if (!ISSUES_ONLY) {
  // ── 对照表 ──
  const COLS = [
    ['店铺', 18, (r) => r.name],
    ['状态', 6, (r) => (r.P ? r.P.status : '?')],
    ['主图', 5, (r) => ((at(r.P, '主图.templates') || []).length) + '个'],
    ['副图', 5, (r) => (at(r.P, '副图.dir') ? ((at(r.P, '副图.count') || 0) + '张') : '—')],
    ['文案', 8, (r) => JSON.stringify(at(r.P, '文案.templateIds') || '全')],
    ['分类', 6, (r) => at(r.P, '分类.catName')],
    ['价', 5, (r) => '¥' + at(r.P, '价格.default')],
    ['库存', 9, (r) => String(at(r.P, '库存.default'))],
    ['所在地', 13, (r) => { const m = at(r.P, '所在地.mode'); return m === 'fixed' ? 'fixed:' + at(r.P, '所在地.fixedCity') : m; }],
    ['发货', 9, (r) => at(r.P, '发货方式.shipMode')],
    ['承诺', 14, (r) => {
      const sc = at(r.P, '承诺.serviceCodes') || [];
      if (sc.length) return sc.length + '个code';
      const on = [];
      if (at(r.P, '承诺.refundFull')) on.push('退款');
      if (at(r.P, '承诺.refundPostage')) on.push('退运费');
      if (at(r.P, '承诺.fastShip')) on.push('极速发货');
      return on.length ? on.join('+') : '无';
    }],
    ['广告', 5, (r) => (at(r.P, '广告.enabled') === false ? '关' : '开')],
    ['问题', 40, (r) => {
      const f = r.issues.filter((x) => x.level === 'fail').length;
      const w = r.issues.filter((x) => x.level === 'warn').length;
      return (f ? '❌' + f + ' ' : '') + (w ? '⚠️' + w : '') || '—';
    }],
  ];
  console.log('\n── 对照表 ──');
  console.log('  ' + COLS.map((c) => pad(c[0], c[1])).join(' '));
  console.log('  ' + COLS.map((c) => '─'.repeat(c[1])).join(' '));
  for (const r of rows) console.log('  ' + COLS.map((c) => pad(cut(c[2](r), c[1]), c[1])).join(' '));
}

// ── 问题清单 ──
const bad = rows.filter((r) => r.issues.length);
console.log('\n── 问题清单（' + bad.length + ' 个店）──');
if (!bad.length) console.log('  ✅ 没有离线可判定的问题');
for (const r of bad) {
  const f = r.issues.filter((x) => x.level === 'fail').length;
  console.log('  ' + (f ? '❌' : '⚠️') + ' ' + r.name);
  for (const it of r.issues) console.log('      ' + (it.level === 'fail' ? '❌' : '⚠️') + ' ' + it.msg);
}
console.log('\n（这里只做【离线】检查。连网核对的完整体检： node tools/store-init.js --all）');
