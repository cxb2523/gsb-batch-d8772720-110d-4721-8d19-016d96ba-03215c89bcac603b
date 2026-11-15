/**
 * tools/store-init.js — 把店铺档案（stores/<店名>.json）应用下去，并【自验收】
 *
 * 为什么需要它：
 *   一个店铺的"个性"散在 8 个地方（代码常量 / lib/config.json / ~/.xianyu-templates.json /
 *   8093 版式库 / goofish 页的 kun_store_cfg_<店> / 本地 kun_tpl_<店> / browser-profiles / publish-assets）。
 *   这个工具负责：读【唯一真相源】（stores/<店名>.json）→ 推到那些落点 → 回头逐项核对是否真的生效。
 *
 *   为什么"核对"是必须的而不是可选的：一次性脚本 = 没人验证的脚本。
 *   不核对的话档案就是一份"看起来很美的配置文件"，改错了不会有任何提示。
 *
 * 用法:
 *   node tools/store-init.js "好易美票务Hope"                  # 只体检 + 打印对照表（不写任何文件）
 *   node tools/store-init.js "好易美票务Hope" --apply          # 把档案推下去（幂等，可反复跑；写前自动备份）
 *   node tools/store-init.js "好易美票务Hope" --apply --verify # 推下去 + 再体检一次
 *   node tools/store-init.js --all --verify                    # 所有档案一起体检
 *
 * --apply 的保护：页面上【已存在且与档案不同】的配置键默认【不覆盖】（列在"⛔ 没动"里）。
 *   要显式覆盖加 --force。理由见下面 FORCE 的注释。
 *
 * 退出码：有 ❌ 就是 1（可挂进计划任务 / CI）；只有 ⚠️ 是 0。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT } = require('../lib/env');
const profile = require('../lib/store-profile');
const { post, get } = require('../lib/http');

const ARGV = process.argv.slice(2);
const APPLY = ARGV.indexOf('--apply') >= 0;
const ALL = ARGV.indexOf('--all') >= 0;
// --force：允许 --apply 覆盖页面上【已存在且与档案不同】的值。
// 为什么默认不覆盖：2026-10-07 实测 kun_store_cfg_好易美代拍.specs 里有老板手工设的三档
// （多人组团可优惠 ¥50 / 看台 ¥500 / 内场 ¥800），而档案是按 CLI 旧行为抄的单档「标准 ¥50」——
// 不拦的话一次 --apply 就把三档定价静默冲掉了。手工配置永远优先于档案，要覆盖必须显式点头。
const FORCE = ARGV.indexOf('--force') >= 0;
const NAMES = ARGV.filter((a) => !a.startsWith('--'));

if (!NAMES.length && !ALL) {
  console.log('用法: node tools/store-init.js "<店铺名>" [--apply] [--verify]');
  console.log('      node tools/store-init.js --all [--verify]');
  console.log('现有档案: ' + (profile.list().join(' / ') || '（stores/ 下还没有档案）'));
  process.exit(2);
}
const TARGETS = ALL ? profile.list() : NAMES;

// 【2026-11-13 加】点名的店没有档案时，直接说清楚「先跑向导」，别继续往下体检。
//   为什么：没有档案时 profile.load() 会回落到 DEFAULTS，然后体检第一项就报
//     ❌ 账号 accountId：没填
//   学员看到的是「账号没填」，会去想"去哪儿填账号"—— 而真正该做的是先跑五步向导。
//   实测（第 99 轮，在解压包里跑）：包里只有 stores/_template.json，
//   跑 store-init "任何店名" 都是这个 ❌，一句话都没提向导。
{
  const noProfile = TARGETS.filter((n) => !profile.exists(n));
  if (noProfile.length) {
    console.log('');
    console.log('❌ 这些店还没有自己的档案（stores/<店名>.json）：' + noProfile.join('，'));
    console.log('');
    console.log('   档案是这家店的唯一真相源（价格/规格/版式/文案/广告都在里面）。');
    console.log('   没有档案时所有检查都会拿通用默认值去比，报出来的问题没意义。');
    console.log('');
    console.log('   先跑向导把它建出来（五步，约 3 分钟）：');
    noProfile.forEach((n) => console.log('        node tools\\store-wizard.js "' + n + '"'));
    console.log('   或者打开网页，点「⑤ 配置一家新店」。');
    console.log('');
    console.log('   现有档案: ' + (profile.list().join(' / ') || '（一个都没有）'));
    console.log('');
    process.exit(2);
  }
}

const ROWS = [];
const chk = (level, name, detail) => ROWS.push({ level: level, name: name, detail: detail || '' });
const tag = (l) => (l === 'ok' ? '✅' : l === 'warn' ? '⚠️' : '❌');

function backup(file) {
  if (!fs.existsSync(file)) return '';
  const b = file + '.bak_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(file, b);
  return b;
}

function readJSON(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // 本仓大量文件带 BOM，JSON.parse 会炸
  return JSON.parse(s);
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');   // 不写 BOM
}

const TPL_FILE = path.join(os.homedir(), '.xianyu-templates.json');
const CFG_FILE = path.join(ROOT, 'lib', 'config.json');

// ── 8093 侧的两个快照（每个店铺体检时复用，不重复请求）──
let SNAP = null;
async function snapshots() {
  if (SNAP) return SNAP;
  SNAP = { posterTpls: null, accounts: null, serviceErr: '' };
  try { const t = await get('/api/poster/templates', { timeout: 15000 }); SNAP.posterTpls = (t.items || t || []).map((x) => x.id); }
  catch (e) { SNAP.serviceErr = e.message; }
  try { const a = await get('/api/agent/accounts', { timeout: 30000 }); SNAP.accounts = (a && a.data) || []; }
  catch (e) { SNAP.serviceErr = SNAP.serviceErr || e.message; }
  return SNAP;
}

/** 所有档案的 accountId → 店铺名，用来查重（两个店共用一个闲鱼账号会互相踢登录） */
function accountMap() {
  const m = {};
  for (const n of profile.list()) {
    try {
      const p = profile.load(n);
      if (p.accountId) (m[p.accountId] = m[p.accountId] || []).push(n);
    } catch (e) { /* 坏档案不参与查重，它自己那轮会报错 */ }
  }
  return m;
}

/** 体检一个店铺，返回 {profile, fails} */
async function inspect(name) {
  let P;
  try { P = profile.load(name); }
  catch (e) { chk('fail', '档案可解析', e.message); return { P: null, fails: 1 }; }

  const S = await snapshots();
  let fails = 0;
  const bad = (n, d) => { chk('fail', n, d); fails++; };

  // ① 账号
  if (!P.accountId) bad('账号 accountId', '没填 —— 见 8093 的 GET /api/agent/accounts');
  else {
    const dup = (accountMap()[P.accountId] || []).filter((x) => x !== name);
    if (dup.length) bad('账号唯一性', 'accountId ' + P.accountId + ' 同时被这些档案用着：' + dup.join('、') +
      ' —— 同一个闲鱼账号绝不能被两个店铺/两台机器操作（登录互踢 + 重复发布）');
    else chk('ok', '账号唯一性', P.accountId);

    if (!S.accounts) chk('warn', '账号在 8093 账号表里', '拿不到账号表（' + S.serviceErr + '）');
    else {
      const hit = S.accounts.find((a) => a.id === P.accountId);
      if (!hit) bad('账号在 8093 账号表里', 'accountId ' + P.accountId + ' 不在（远程账号表里没有这个店，登录/发布都会失败）');
      else if (hit.name !== name) bad('账号名一致', '8093 里 ' + P.accountId + ' 对应的店铺叫「' + hit.name + '」，档案叫「' + name + '」');
      else chk('ok', '账号在 8093 账号表里', hit.username.replace(/\s+/g, '') + (hit.notes ? '（' + hit.notes + '）' : ''));
    }
  }

  // ② 主图版式
  const tpls = P.主图.templates || [];
  if (!tpls.length) bad('主图版式池', '是空的');
  const unreg = tpls.filter((id) => !profile.TPL_REGISTRY[id]);
  if (unreg.length) chk('warn', '主图版式已登记', '未登记到 lib/store-profile.js 的 TPL_REGISTRY：' + unreg.join('、') +
    '（会按"JSON 版式+不叠默认色块"跑；登记了才稳）');
  else chk('ok', '主图版式已登记', tpls.join(', '));
  if (S.posterTpls) {
    const miss = tpls.filter((id) => {
      const k = (profile.TPL_REGISTRY[id] || {}).kind;
      if (k === 'layer') return false;                    // kind:'layer' 的版式不在服务端版式库里
      return S.posterTpls.indexOf(id) < 0;
    });
    if (miss.length) bad('主图版式在 8093 版式库里', '不存在：' + miss.join('、') +
      ' —— 这正是"指定了版式却静默出成别的版式"那个坑（2026-10-07 实际踩到）');
    else chk('ok', '主图版式在 8093 版式库里', tpls.length + ' 个都在（版式库共 ' + S.posterTpls.length + ' 个）');
  } else chk('warn', '主图版式在 8093 版式库里', '8093 不可达，跳过');

  // ③ 底图 / 贴纸
  const assetRows = [];
  if (P.主图.baseImg) assetRows.push(['主图.baseImg', P.主图.baseImg]);
  for (const s of (P.主图.stickers || [])) assetRows.push(['主图.stickers', s.file]);
  const missAsset = assetRows.filter((r) => !fs.existsSync(path.isAbsolute(r[1]) ? r[1] : path.join(ROOT, r[1])));
  if (missAsset.length) bad('底图/贴纸文件存在', missAsset.map((r) => r[0] + '=' + r[1]).join('、'));
  else chk('ok', '底图/贴纸文件存在', assetRows.length ? assetRows.length + ' 个文件都在' : '（无，走官方海报）');

  // ④ 副图
  const subDir = P.副图.dir || '';
  if (!subDir) chk('ok', '副图', '不配（该店不发副图）');
  else {
    const d = path.isAbsolute(subDir) ? subDir : path.join(ROOT, subDir);
    if (!fs.existsSync(d)) bad('副图目录存在', d);
    else {
      const n = fs.readdirSync(d).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
      const dup2 = fs.readdirSync(d).filter((f) => /主图/.test(f));
      if (P.副图.count && n !== P.副图.count) chk('warn', '副图张数', '档案写 ' + P.副图.count + ' 张，目录里实际 ' + n + ' 张');
      else chk('ok', '副图张数', n + ' 张');
      if (dup2.length) bad('副图目录没混进主图', '有：' + dup2.join('、') + '（会被当副图再发一遍，详情页出现两张一样的主图）');
    }
  }

  // ⑤ 文案池
  if (!fs.existsSync(TPL_FILE)) chk('warn', '文案模板库', TPL_FILE + ' 不存在');
  else {
    const T = readJSON(TPL_FILE);
    const ids = T.templates.map((x) => Number(x.id));
    const want = P.文案.templateIds;
    if (!want || !want.length) chk('warn', '文案池', '档案没指定 templateIds → 该店会用全部 ' + ids.length + ' 个模板（容易串到别店的话术）');
    else {
      const miss = want.filter((x) => ids.indexOf(Number(x)) < 0);
      if (miss.length) bad('文案池 id 存在', '模板库里没有：' + miss.join('、') + '（现有 id：' + ids.join(',') + '）');
      else chk('ok', '文案池', want.join(','));
      // 漂移：档案 vs storeTemplates（桌面引擎读后者）
      const st = (T.storeTemplates || {})[name];
      const same = Array.isArray(st) && st.length === want.length && st.every((x, i) => Number(x) === Number(want[i]));
      if (!same) chk('warn', '档案 ↔ storeTemplates 一致', '档案=' + JSON.stringify(want) + '，模板库 storeTemplates=' + JSON.stringify(st || null) +
        (APPLY ? '（本次 --apply 会同步）' : '（跑 --apply 同步）'));
      else chk('ok', '档案 ↔ storeTemplates 一致', JSON.stringify(want));
    }
  }

  // ⑥ 分类
  const cat = P.分类 || {};
  if (!cat.catName || !cat.channelCatId) bad('分类', 'catName/channelCatId 不全：' + JSON.stringify(cat));
  else if (!cat.catId) chk('warn', '分类', cat.catName + ' 没有 catId（channelCatId=' + cat.channelCatId + '）—— 有些类目确实没有 catId，但要实抓确认过');
  else chk('ok', '分类', cat.catName + '  catId=' + cat.catId + '  channelCatId=' + cat.channelCatId +
    (cat.tbCatId ? '  tbCatId=' + cat.tbCatId : '（未发 tbCatId）'));

  // ⑦ 规格 / 价格 / 库存
  const specs = (P.规格 || {}).specs || [];
  const badSpec = specs.filter((s) => {
    if (!s || !s.valueText) return true;
    const p = s.price != null ? s.price : P.价格.default;
    const q = s.quantity != null ? s.quantity : P.库存.default;
    return !isFinite(Number(p)) || Number(p) <= 0 || !isFinite(Number(q)) || Number(q) < 0;
  });
  if (badSpec.length) bad('规格', '有档位的 valueText 为空或价格/库存非法：' + JSON.stringify(badSpec));
  else chk('ok', '规格', (P.规格.propertyName || '代拍费') + ' × ' + specs.length + ' 档 → ' + specs.map((s) =>
    s.valueText + ' ¥' + (s.price != null ? s.price : P.价格.default) + ' ×' + (s.quantity != null ? s.quantity : P.库存.default)).join(' | '));
  chk('ok', '价格/库存默认', '¥' + P.价格.default + ' / ' + P.库存.default);

  // ⑧ 发货方式 / 承诺（load() 已校验取值合法，这里只回显）
  chk('ok', '发货方式', P.发货方式.shipMode);
  chk('ok', '服务承诺', [P.承诺.refundFull ? '退款' : '', P.承诺.refundPostage ? '退运费' : '', P.承诺.fastShip ? '极速发货' : ''].filter(Boolean).join(' + ') || '全不勾');

  // ⑧.5 推广计划 9 项（load() 已逐项校验取值合法，这里回显 + 提示开窗开关）
  //   为什么单独列出来：这 9 项以前只活在桌面引擎的界面里，换台机器就没了；
  //   现在它们是档案的一部分，"配好了没有"必须能一眼看出来。
  try {
    const ap = profile.resolveAdPlan(P);
    const tgt = profile.AD_PLAN.BID_TARGETS[ap.目标];
    chk('ok', '推广计划 9 项', ap.方式 + ' ｜ ' + profile.AD_PLAN.PROMOTION_MODES[ap.类型] + ' ｜ ' +
      profile.AD_PLAN.BID_TYPES[ap.出价方式] + ' ｜ 目标=' + tgt + ' ｜ 预期成本 ¥' + ap.预期成本 +
      ' ｜ 日上限 ¥' + ap.日上限 + ' ｜ 时段 ' + ap.时段.length + 'h(' + ap.时段[0] + '-' + (ap.时段[ap.时段.length - 1] + 1) + ')' +
      ' ｜ 创意优化' + (ap.创意优化 ? '开' : '关') + ' ｜ 宝贝=' + JSON.stringify(ap.宝贝) +
      ' ｜ 计划名例「' + profile.campaignTitle(P, { 城市: '广州', 明星: '周杰伦' }) + '」');
    if (!ap.enabled) chk('warn', '该店不投广告', '广告.enabled=false → 不参与 tools/ad-window.js 自动开窗，也不会被 ad-plan-create 建计划');
    else if (!ap.时段.length) bad('推广时段', '时段为空');
  } catch (e) { bad('推广计划 9 项', e.message); }

  // ⑨ 注册进 lib/config.json 的 store.all
  try {
    const C = readJSON(CFG_FILE);
    const all = (C.store && C.store.all) || [];
    if (all.indexOf(name) < 0) chk('warn', '注册在 lib/config.json store.all', '不在（' + all.join('、') + '）' + (APPLY ? '（本次 --apply 会加）' : '（跑 --apply 加）'));
    else chk('ok', '注册在 lib/config.json store.all', '第 ' + (all.indexOf(name) + 1) + ' 个');
    const act = (C.store && C.store.active) || [];
    if (act.indexOf(name) >= 0) chk('warn', '不是常驻 active', '该店在 store.active 里 —— 每多一个 active 就多一个常驻 Chromium context（内存）');
    else chk('ok', '不是常驻 active', '按需 tools/store-ready.js 拉起即可');
  } catch (e) { chk('warn', 'lib/config.json', '读不到：' + e.message); }

  // ⑩ goofish 页 localStorage（桌面引擎读这个）
  try {
    const r = await post('/api/agent/eval-on-store', {
      store: name,
      code: '(function(){var k="kun_store_cfg_";var c=null;try{c=JSON.parse(localStorage.getItem(k+' + JSON.stringify(name) + '));}catch(e){}return JSON.stringify({cfg:c||null,href:location.href});})()',
    }, { timeout: 45000 });
    if (!r || r.ok !== true) chk('warn', '桌面引擎配置(kun_store_cfg_)', '店铺页没就绪：' + String((r && r.error) || '').slice(0, 80) + ' → node tools/store-ready.js "' + name + '"');
    else {
      const d = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
      const c = d.cfg || {};
      const mismatch = [];
      if (c.price && String(c.price) !== String(P.价格.default)) mismatch.push('price ' + c.price + '≠' + P.价格.default);
      if (c.stock && String(c.stock) !== String(P.库存.default)) mismatch.push('stock ' + c.stock + '≠' + P.库存.default);
      if (c.category && c.category !== cat.catName) mismatch.push('category ' + c.category + '≠' + cat.catName);
      if (c.shipMode && c.shipMode !== P.发货方式.shipMode) mismatch.push('shipMode ' + c.shipMode + '≠' + P.发货方式.shipMode);
      // 【2026-10-07 加】规格比对 —— 这一项最容易出事（实测桌面引擎在这店里是老板手工设的三档，
      //   而 CLI 旧行为是单档；两边发出来的链接标价不一样，肉眼看不出来）。
      const curSpecs = (c.specs && c.specs.enabled && c.specs.values) ? c.specs : null;
      if (curSpecs) {
        const a = curSpecs.values.map((v) => v.value + '¥' + v.priceYuan).join('/');
        const b = ((P.规格 || {}).specs || []).map((s) => s.valueText + '¥' + (s.price != null ? s.price : P.价格.default)).join('/');
        if (a !== b) mismatch.push('specs 页面=' + a + ' 档案=' + b + (FORCE ? '' : '（要覆盖得加 --force）'));
        else chk('ok', '桌面引擎规格 ↔ 档案', a);
      }
      if (mismatch.length) chk('warn', '桌面引擎配置(kun_store_cfg_)', '与档案不一致：' + mismatch.join('，') + (APPLY ? (FORCE ? '（--force：本次会覆盖）' : '（本次 --apply 会【跳过】这些键，不覆盖）') : '（跑 --apply 同步）'));
      else chk('ok', '桌面引擎配置(kun_store_cfg_)', Object.keys(c).length ? '已同步' : '（页面里还没有，跑 --apply 会写）');
    }
  } catch (e) { chk('warn', '桌面引擎配置(kun_store_cfg_)', '店面探针失败：' + e.message.slice(0, 90)); }

  return { P: P, fails: fails };
}

/** --apply：把档案推到各落点（幂等） */
async function apply(name, P) {
  const did = [];

  // ① 文案池 → ~/.xianyu-templates.json 的 storeTemplates（桌面引擎和 CLI 都读它）
  if (Array.isArray(P.文案.templateIds) && P.文案.templateIds.length) {
    const T = readJSON(TPL_FILE);
    T.storeTemplates = T.storeTemplates || {};
    const before = JSON.stringify(T.storeTemplates[name] || null);
    T.storeTemplates[name] = P.文案.templateIds.slice();
    if (JSON.stringify(T.storeTemplates[name]) !== before) {
      const b = backup(TPL_FILE);
      writeJSON(TPL_FILE, T);
      did.push('storeTemplates[' + name + '] = ' + JSON.stringify(P.文案.templateIds) + (b ? '（备份 ' + path.basename(b) + '）' : ''));
    }
  }

  // ② 注册进 lib/config.json 的 store.all
  try {
    const C = readJSON(CFG_FILE);
    C.store = C.store || {};
    C.store.all = C.store.all || [];
    if (C.store.all.indexOf(name) < 0) {
      const b = backup(CFG_FILE);
      C.store.all.push(name);
      writeJSON(CFG_FILE, C);
      did.push('lib/config.json store.all += ' + name + (b ? '（备份 ' + path.basename(b) + '）' : ''));
    }
  } catch (e) { did.push('⚠️ lib/config.json 写失败：' + e.message); }

  // ③ 素材目录骨架
  const base = path.join(ROOT, 'publish-assets', name);
  for (const sub of ['主图', '副图']) {
    const d = path.join(base, sub);
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); did.push('建目录 publish-assets/' + name + '/' + sub); }
  }

  // ④ 推到 goofish 页的 localStorage（桌面引擎读 kun_store_cfg_<店>）
  //    字段名与桌面引擎 publish.js 的 getDefaultStoreConfig()/buildSkuPayload() 对齐。
  const specs = (P.规格 || {}).specs || [];
  const cfg = {
    price: String(P.价格.default),
    stock: String(P.库存.default),
    category: P.分类.catName,
    shipMode: P.发货方式.shipMode,
    locationMode: P.所在地.mode,
    fixedCity: P.所在地.fixedCity || '',
    fixedDistrict: P.所在地.fixedDistrict || '',
    commitment: { refundFull: !!P.承诺.refundFull, refundPostage: !!P.承诺.refundPostage, fastShip: !!P.承诺.fastShip },
    specs: specs.length ? {
      enabled: true,
      propertyName: P.规格.propertyName || '代拍费',
      values: specs.map((s) => ({
        value: s.valueText,
        priceYuan: Number(s.price != null ? s.price : P.价格.default),
        stock: Number(s.quantity != null ? s.quantity : P.库存.default),
      })),
    } : { enabled: false },
  };
  // ⚠️ subImg 只在【档案确实配了副图目录】时才写 true，绝不写 false。
  //   为什么：两个引擎的"副图"不是一个概念 —— CLI 的 副图.dir 是"发这组固定图"，桌面引擎的 subImg
  //   只是"开不开副图"（图从它自己的流程来）。档案 dir 为空只代表"CLI 这边不发"，
  //   不代表"要把桌面引擎的副图关掉"。写 false 会悄悄改变桌面引擎的行为。
  if ((P.副图 || {}).dir) cfg.subImg = true;
  const code = '(function(){var k="kun_store_cfg_"+' + JSON.stringify(name) + ';var o=null;try{o=JSON.parse(localStorage.getItem(k));}catch(e){}if(!o)o={};' +
    'var n=' + JSON.stringify(cfg) + ';var skipped=[],written=[];' +
    'for(var x in n){' +
    '  var has = (o[x]!==undefined && o[x]!==null && o[x]!=="");' +
    '  if(has && JSON.stringify(o[x])!==JSON.stringify(n[x]) && !' + (FORCE ? 'true' : 'false') + '){ skipped.push(x); continue; }' +
    '  o[x]=n[x]; written.push(x);}' +
    'localStorage.setItem(k,JSON.stringify(o));return JSON.stringify({written:written,skipped:skipped});})()';
  try {
    const r = await post('/api/agent/eval-on-store', { store: name, code: code }, { timeout: 45000 });
    if (r && r.ok === true) {
      const d = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
      if (d.written.length) did.push('kun_store_cfg_' + name + ' 写入 goofish 页 localStorage：' + d.written.join(', '));
      if (d.skipped.length) did.push('⛔ 这几个键【已存在且与档案不同】，为保护手工配置【没动】：' + d.skipped.join(', ') +
        ' → 想用档案覆盖就重跑并加 --force');
      if (!d.written.length && !d.skipped.length) did.push('kun_store_cfg_' + name + ' 已是最新，无需写入');
    } else {
      did.push('⚠️ 桌面引擎配置没写进去（店铺页没就绪）：' + String((r && r.error) || '').slice(0, 80) +
        ' → node tools/store-ready.js "' + name + '" 之后再 --apply');
    }
  } catch (e) { did.push('⚠️ 桌面引擎配置没写进去：' + e.message.slice(0, 90)); }

  return did;
}

(async () => {
  let totalFail = 0;
  for (const name of TARGETS) {
    ROWS.length = 0;
    console.log('\n══════ ' + name + ' ══════');
    const { P, fails } = await inspect(name);

    if (APPLY && P) {
      console.log('── --apply ──');
      const did = await apply(name, P);
      if (!did.length) console.log('  （没有需要改的，已是最新）');
      else did.forEach((d) => console.log('  · ' + d));
      if (did.length) {
        // 写完再看一眼，避免"写成功了但没生效"（今天踩过：localStorage 写了、页面是旧的）
        ROWS.length = 0;
        await inspect(name);
      }
    }

    // 草稿店（status:'draft'，还没接完）：❌ 降级成 ⚠️ 并标注原因。
    // 为什么：开 100 个店的过程中会同时躺着很多半成品，如果它们一直让整批体检返回非 0，
    //   最后就没人看这个检查了 —— 那才是真正危险的。
    const isDraft = !!(P && P.status === 'draft');
    const nf = ROWS.filter((r) => r.level === 'fail').length;
    const nw = ROWS.filter((r) => r.level === 'warn').length;
    if (!isDraft) totalFail += nf;

    console.log('── 体检 ──');
    for (const r of ROWS) {
      const lv = (isDraft && r.level === 'fail') ? 'warn' : r.level;
      const mark = (isDraft && r.level === 'fail') ? '（草稿店，不算失败）' : '';
      console.log('  ' + tag(lv) + ' ' + r.name + (r.detail ? '：' + r.detail : '') + mark);
    }
    if (isDraft) {
      console.log('  → 📝 「' + name + '」是草稿店（status=draft）：' + ROWS.filter((r) => r.level === 'ok').length +
        ' 项通过，' + nw + ' 项待办，' + nf + ' 项失败【已降级为待办】');
      console.log('     接完（账号进中台 + 登录 + 素材齐）把 stores/' + name + '.json 的 status 改成 "live"');
    } else {
      console.log('  → ' + ROWS.filter((r) => r.level === 'ok').length + ' 项通过，' + nw + ' 项待办，' + nf + ' 项失败');
    }
  }
  console.log('\n' + (totalFail ? '❌ 有 ' + totalFail + ' 项失败（退出码 1）' : '✅ 全部通过'));
  process.exit(totalFail ? 1 : 0);
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
