/**
 * tools/store-bulk.js — 跨店批量改档案（100 个店不可能手工点）
 *
 * 为什么需要它：
 *   开 100 个店之后，"把代购类目所有店的标价从 ¥50 调到 ¥60"这种操作如果去逐个开文件改，
 *   一天就只能干这一件事，而且一定会有几个漏掉 —— 漏掉的那个店就是"跟别人不一样还没人发现"。
 *
 * 安全设计（默认只预览，不写盘）：
 *   1. **默认 dry-run**。真写必须显式 --apply。
 *   2. 不给 --where/--all 就拒绝执行（不让你不小心改全部）。
 *   3. `name` / `$schema` 拒绝批量改（改名 = 改文件名，是另一个操作，不该混进来）。
 *   4. 改 `accountId` 会警告并做查重（一个闲鱼账号只能属于一个店）。
 *   5. 路径第一段必须是有档案里已存在的顶层字段 —— 防止 `单价.default=60` 这种笔误
 *      静默新建一个字段（那才是最难发现的错）。
 *   6. 写盘前自动备份，写盘后回读验证。
 *
 * 用法:
 *   # 预览：代购类目的店，价格改成 60
 *   node tools/store-bulk.js --set 价格.default=60 --where "分类.catName=代购"
 *   # 确认无误再加 --apply
 *   node tools/store-bulk.js --set 价格.default=60 --where "分类.catName=代购" --apply
 *
 *   node tools/store-bulk.js --set 广告.enabled=false --where "status=live" --apply
 *   node tools/store-bulk.js --set 承诺.serviceCodes=NONCONFORMITY_FREE_REFUND,VIRTUAL_NONCONFORMITY_FREE_REFUND_SERVICE --all --apply
 *   node tools/store-bulk.js --set 文案.titleMin=30 --where "分类.catName=代购" --apply --then-verify
 *
 * 条件操作符: =  !=  ~=(包含)  !~=  以及只写路径（判真值，如 --where "广告.enabled"）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const profile = require('../lib/store-profile');
const args = require('../lib/args');

// 【2026-10-07】原来这里自己用 `--set=` 前缀过滤，结果用户按文档写
// `--set 价格.default=60`（空格写法）时一个都匹配不到 —— 直接掉进"用法"分支。
// 现在统一走 lib/args.js（两种写法都认），重复键用 allOf 收全。
const A = args.parse();
const SETS = A.allOf('set');
const WHERES = A.allOf('where');
const APPLY = A.on('apply');
const ALL = A.on('all');
const THEN_VERIFY = A.on('then-verify');

function die(msg) { console.log('❌ ' + msg); process.exit(2); }
function readJSON(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return JSON.parse(s);
}

/**
 * 数一下档案里有多少 `_` 开头的注释/决策键。
 * 写盘前后各数一次 —— 批量改档案最怕的不是值改错（值有 diff 可看），
 * 而是把 `_决策` / `_证据` 这类【决策记录】悄悄删掉，那种损失当场看不见。
 */
function rawNoteCount(file) {
  const count = (o) => {
    if (Array.isArray(o)) return o.reduce((a, x) => a + count(x), 0);
    if (o && typeof o === 'object') {
      let n = 0;
      for (const k of Object.keys(o)) n += (k.charAt(0) === '_' ? 1 : 0) + count(o[k]);
      return n;
    }
    return 0;
  };
  try { return count(readJSON(file)); } catch (e) { return -1; }
}

if (!SETS.length) {
  console.log('用法: node tools/store-bulk.js --set <路径>=<值> [--set ...] (--where "<条件>" | --all) [--apply] [--then-verify]');
  console.log('');
  console.log('例:');
  console.log('  node tools/store-bulk.js --set 价格.default=60 --where "分类.catName=代购"');
  console.log('  node tools/store-bulk.js --set 广告.enabled=false --where "status=live" --apply');
  console.log('');
  console.log('可改的顶层字段（来自档案 schema）: ' + Object.keys(profile.DEFAULTS).filter((k) => k !== '$schema').join(' / '));
  process.exit(2);
}
if (!WHERES.length && !ALL) {
  die('必须给 --where "<条件>"（如 --where "分类.catName=代购"），或明确的 --all。\n' +
    '   故意不给默认值 —— 批量改全部档案是个该被明确要求的动作。');
}

/** 解析一条 --set，返回 {path, raw} */
function parseSet(s) {
  const i = s.indexOf('=');
  if (i <= 0) die('--set 格式要写成 <路径>=<值>，收到：' + s);
  return { path: s.slice(0, i).trim(), raw: s.slice(i + 1) };
}
const CHANGES = SETS.map(parseSet);

// 路径合法性：第一段必须在 schema 里；name / $schema 禁止批量改
const TOP = Object.keys(profile.DEFAULTS);
for (const c of CHANGES) {
  const head = c.path.split('.')[0];
  if (head === 'name') die('不允许批量改 name —— 改名等于改文件名，请用 tools/store-new.js 或手工改名。');
  if (head === '$schema') die('不允许批量改 $schema。');
  if (TOP.indexOf(head) < 0) {
    die('路径「' + c.path + '」的第一段「' + head + '」不是档案的顶层字段（多半是笔误）。\n' +
      '   可用的: ' + TOP.filter((k) => k !== '$schema').join(' / '));
  }
  if (head === 'accountId') console.log('⚠️ 你要批量改 accountId —— 一个闲鱼账号只能属于一个店，改完会自动查重。');
}

/** 取点号路径（支持中文键） */
function at(o, p) {
  let cur = o;
  for (const k of String(p).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
/** 写点号路径；中间层不存在就建对象（只允许在已存在的顶层字段内部新建） */
function setAt(o, p, v) {
  const ks = String(p).split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = v;
}

/** 值解析：先按字面量，再按目标字段原有类型 */
function parseVal(raw, cur) {
  const t = String(raw).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.charAt(0) === '[' || t.charAt(0) === '{') { try { return JSON.parse(t); } catch (e) { /* 落到下面 */ } }
  if (Array.isArray(cur)) {
    const arr = t === '' ? [] : t.split(',').map((s) => s.trim()).filter((s) => s !== '');
    // 原来是数字数组（如 文案.templateIds）就转回数字
    const wasNum = cur.length && cur.every((x) => typeof x === 'number');
    return wasNum ? arr.map((x) => (isFinite(Number(x)) ? Number(x) : x)) : arr;
  }
  if (typeof cur === 'number' && isFinite(Number(t))) return Number(t);
  return t;
}

/** 条件：支持 = != ~= !~= 与裸路径（判真值） */
function matchWhere(P, w) {
  let m = w.match(/^(.+?)(!~=|~=|!=|=)(.*)$/);
  if (!m) {
    const v = at(P, w.trim());
    return !!(v && (!Array.isArray(v) || v.length));
  }
  const [, p, op, rawV] = m;
  const cur = at(P, p.trim());
  const want = String(rawV).trim();
  const curS = Array.isArray(cur) ? cur.join(',') : String(cur);
  if (op === '=') return curS === want;
  if (op === '!=') return curS !== want;
  if (op === '~=') return curS.indexOf(want) >= 0;
  if (op === '!~=') return curS.indexOf(want) < 0;
  return false;
}

// ── 选店 ──
// ⚠️ 必须同时留 raw（文件原文）和 P（合并默认值后的）。
//   写盘要用 raw：load() 会把 `_` 开头的注释/决策键剥掉，
//   直接写 P 会把档案里的 `_说明`/`_决策`/`_证据` 全删掉 —— 那等于把决策记录毁了。
const all = profile.list();
let picked = [];
for (const n of all) {
  let P, raw;
  try { raw = readJSON(profile.fileOf(n)); P = profile.load(n); }
  catch (e) { console.log('⚠️ 「' + n + '」档案读不了，跳过：' + e.message); continue; }
  const ok = ALL ? true : WHERES.every((w) => matchWhere(P, w));
  if (ok) picked.push({ name: n, P: P, raw: raw });
}
if (!picked.length) {
  console.log('没有店铺匹配 ' + JSON.stringify(WHERES) + '（共 ' + all.length + ' 份档案）');
  process.exit(0);
}

// ── 算变更（同时把变更【真的写进 raw】—— 第一版只算了 diff 没写回，于是 --apply 报成功但值没落盘）──
const plan = [];
for (const it of picked) {
  const diffs = [];
  for (const c of CHANGES) {
    const curRaw = at(it.raw, c.path);
    // 文件里没写 = 用默认值。显示和幂等判断都要用"生效值"。
    const curEff = (curRaw === undefined) ? at(profile.DEFAULTS, c.path) : curRaw;
    const next = parseVal(c.raw, curEff);
    if (JSON.stringify(curEff) === JSON.stringify(next)) continue;   // 幂等：已经是要的值就不写
    diffs.push({ path: c.path, from: curRaw, isDefault: curRaw === undefined, to: next });
    setAt(it.raw, c.path, next);
  }
  if (diffs.length) plan.push({ name: it.name, raw: it.raw, diffs: diffs });
}

console.log('\n── 选中 ' + picked.length + ' 个店（条件 ' + (ALL ? '--all' : JSON.stringify(WHERES)) + '）──');
for (const it of picked) console.log('   ' + it.name + (it.P.status === 'draft' ? '   ⚠️ 草稿店' : ''));
const drafts = picked.filter((x) => x.P.status === 'draft');
if (drafts.length && !WHERES.some((w) => /status/.test(w))) {
  console.log('   注：其中 ' + drafts.length + ' 个是草稿店。不想改它们就加 --where "status=live"');
}

if (!plan.length) {
  console.log('\n✅ 没有需要改的（所有选中店铺的值已经等于目标值）—— 这个操作是幂等的');
  process.exit(0);
}

console.log('\n── 将要变更 ──');
for (const it of plan) {
  console.log('   ' + it.name);
  for (const d of it.diffs) {
    const f = d.isDefault ? '(未写=默认 ' + JSON.stringify(d.from === undefined ? at(profile.DEFAULTS, d.path) : d.from) + ')'
      : JSON.stringify(d.from);
    const t = JSON.stringify(d.to);
    console.log('      ' + d.path + ': ' + (f.length > 60 ? f.slice(0, 57) + '…' : f) + ' → ' + t);
  }
}

if (!APPLY) {
  console.log('\n📋 上面是【预览】，没有写任何文件。确认无误就重跑并加 --apply');
  process.exit(0);
}

// ── 写盘 + 回读验证 ──
// 回读是必须的：第一版只算 diff 没写回对象，--apply 照样报"已写 N 份"，
// 但值根本没落盘 —— 没有回读就永远发现不了。
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let wrote = 0;
for (const it of plan) {
  const f = profile.fileOf(it.name);
  const bak = f + '.bak_' + stamp;
  fs.copyFileSync(f, bak);
  fs.writeFileSync(f, JSON.stringify(it.raw, null, 2) + '\n', 'utf8');
  let bad = '';
  try {
    const back = profile.load(it.name);          // 重新走一遍真正的读取路径
    for (const d of it.diffs) {
      if (JSON.stringify(at(back, d.path)) !== JSON.stringify(d.to)) {
        bad = d.path + ' 期望 ' + JSON.stringify(d.to) + ' 实际 ' + JSON.stringify(at(back, d.path));
        break;
      }
    }
    if (!bad && rawNoteCount(f) !== rawNoteCount(bak)) bad = '注释键（_开头）数量变了：改后 ' + rawNoteCount(f) + ' 改前 ' + rawNoteCount(bak);
  } catch (e) { bad = '回读失败：' + e.message; }

  if (bad) {
    fs.copyFileSync(bak, f);                     // 立刻还原
    console.log('   ❌ ' + it.name + ' 写入校验失败，已还原：' + bad);
    continue;
  }
  wrote++;
}
console.log('\n✅ 已写 ' + wrote + ' / ' + plan.length + ' 份档案（备份后缀 .bak_' + stamp + '）');
if (wrote !== plan.length) process.exit(1);

// accountId 查重（改完才有意义）
if (CHANGES.some((c) => c.path.split('.')[0] === 'accountId')) {
  const seen = {};
  let dup = 0;
  for (const n of profile.list()) {
    let P; try { P = profile.load(n); } catch (e) { continue; }
    if (!P.accountId) continue;
    if (seen[P.accountId]) { console.log('❌ accountId ' + P.accountId + ' 同时属于「' + seen[P.accountId] + '」和「' + n + '」'); dup++; }
    else seen[P.accountId] = n;
  }
  if (!dup) console.log('✅ accountId 查重通过');
}

if (THEN_VERIFY) {
  console.log('\n──── 重跑全店体检 ────');
  try { execFileSync(process.execPath, [path.join(__dirname, 'store-init.js'), '--all'], { stdio: 'inherit' }); }
  catch (e) { console.log('（体检有未通过项，见上）'); }
}
