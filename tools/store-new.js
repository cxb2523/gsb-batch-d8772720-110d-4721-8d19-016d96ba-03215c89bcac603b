/**
 * tools/store-new.js — 开新店向导：一个命令把新店铺档案建起来
 *
 * 为什么需要它：
 *   "开 100 个店"真正剩下的工作量只有两件事 —— ① 机械地建一套档案 + 素材目录骨架
 *   ② 人做那两件机器做不了的（过滑块登录、定主图风格）。这个脚本把 ① 做成一条命令，
 *   并把 ② 打成一页清单，让第二个店和第一百个店一样快。
 *
 * 它做什么：
 *   1. 从 --preset（推荐）或 --from（老店/模板）拷出结构，改 name
 *   2. **递归剥掉所有 `_` 开头的键** —— 那些是【上一个店的】决策记录/分歧证据/抓包来源，
 *      拷给新店会变成误导（比如代拍店的"三档规格待定"跟新店毫无关系）。
 *      剥掉的是注释，不是配置：真正的值（规格/承诺/分类…）照常继承。
 *   3. 解析闲鱼账号：--account-id / --account-name / 或按店铺名自动匹配 8093 的账号表
 *   4. 建 publish-assets/<店名>/{主图,副图}；--copy-sub 时把源店的副图一起拷过来
 *   5. 写 stores/<店名>.json，然后自动跑一遍 tools/store-init.js 体检
 *   6. 打印"剩下要人工给的三样东西" + 精确到可复制的命令
 *
 * 两种继承源的区别（这是三层方案的第二层）：
 *   --preset=代拍-标准  从 presets/ 继承。样板是 tools/preset-export.js 从【老板在跑的店】
 *                       读回平台真值生成的，值有背书，还带"哪几项本来就不一致"的记账。**推荐**
 *   --from=<店名>       从 stores/ 里另一个店继承。老办法，会把那个店的业务判断一起带过来。
 *
 * 用法:
 *   node tools/store-new.js --name="XX票务" --preset=代拍-标准 --copy-sub
 *   node tools/store-new.js --name="XX票务" --from="<你自己的另一个店>"
 *   node tools/store-new.js --name="XX票务" --account-id=xxxx-... --account-name="XX票务"
 *   node tools/store-new.js --name="XX票务" --dry            # 只看会写什么，不落盘
 *   node tools/store-new.js --list-accounts                  # 看看有哪些闲鱼账号可用/已被占用
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, MACHINE } = require('../lib/env');
const profile = require('../lib/store-profile');
const { get } = require('../lib/http');

const ARGV = process.argv.slice(2);
const flag = (k) => ARGV.indexOf('--' + k) >= 0;
const opt = (k, d) => {
  const a = ARGV.find((x) => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : d;
};

const NAME = opt('name', '');
const FROM = opt('from', '_template');
const PRESET = opt('preset', '');
const DRY = flag('dry');
const COPY_SUB = flag('copy-sub');
const LIST_ACCOUNTS = flag('list-accounts');

function die(msg, code) { console.log('❌ ' + msg); process.exit(code || 2); }
function readJSON(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return JSON.parse(s);
}

/** 递归剥掉 `_` 开头的注释/决策/证据键。数组保持数组。 */
function stripNotes(o) {
  if (Array.isArray(o)) return o.map(stripNotes);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) if (k.charAt(0) !== '_') out[k] = stripNotes(o[k]);
    return out;
  }
  return o;
}

/**
 * 重写"来源"类溯源字段。
 * 为什么：`分类.来源` 不是注释、不会被 stripNotes 剥掉，但它是【上一个店的】溯源
 * （比如 hope 那份写的是"publish-one.js L465/L489 既有值"）。原样留给新店 = 假证据，
 * 比没有更糟 —— 以后有人照着它去核对会核错地方。
 */
function retagProvenance(o, note) {
  if (Array.isArray(o)) return o.map((x) => retagProvenance(x, note));
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) {
      if (k === '来源' || k.endsWith('来源')) out[k] = note;
      else out[k] = retagProvenance(o[k], note);
    }
    return out;
  }
  return o;
}

(async () => {
  // ── 账号表（--list-accounts 也用它）──
  let accounts = null, accErr = '';
  try { const a = await get('/api/agent/accounts', { timeout: 30000 }); accounts = (a && a.data) || []; }
  catch (e) { accErr = e.message; }

  const used = {};   // accountId -> 店铺名（已被档案占用）
  for (const n of profile.list()) {
    try { const p = profile.load(n); if (p.accountId) used[p.accountId] = n; } catch (e) { /* 坏档案跳过 */ }
  }

  if (LIST_ACCOUNTS) {
    console.log('── 8093 账号表' + (accounts ? '（' + accounts.length + ' 个）' : '（拿不到：' + accErr + '）') + ' ──');
    for (const a of (accounts || [])) {
      const owner = used[a.id];
      console.log('  ' + (owner ? '⛔ 已被「' + owner + '」占用' : '✅ 可用          ') + '  ' + a.name + '  ' + String(a.username).trim() + '  ' + a.id);
    }
    if (accounts) {
      const free = accounts.filter((a) => !used[a.id]);
      console.log('\n可用账号 ' + free.length + ' 个。开新店：');
      // 【2026-11-13 第 143 轮修】原来这里 --from 硬编码了 "好易美票务Hope"——
      //   学员跑 --list-accounts 会看到这条提示，照抄必然失败（他没有那个店）。
      //   改用包里自带的样板。
      for (const a of free) console.log('  node tools/store-new.js --name="' + a.name + '" --preset=代拍-标准 --copy-sub');
    }
    return;
  }

  if (!NAME) {
    die('必须给 --name="<店铺名>"。\n' +
      '   现有档案: ' + (profile.list().join(' / ') || '（无）') + '\n' +
      '   看有哪些闲鱼账号可用: node tools/store-new.js --list-accounts');
  }
  if (/[\\/:*?"<>|]/.test(NAME)) die('店铺名不能含路径字符：' + NAME);

  const target = profile.fileOf(NAME);
  if (fs.existsSync(target)) die('stores/' + NAME + '.json 已存在 —— 要改它请直接编辑，或先删掉再开新店');

  // ── 1. 读源：--preset 优先（从 presets/ 的样板继承），否则从 stores/ 的老店继承 ──
  //   为什么要有 --preset：学员不该从"另一个半成品店"继承，而该从
  //   【老板在跑的店读回来的样板】继承 —— 样板里的值有平台真值背书，还带着一致性记账。
  const srcFile = PRESET ? path.join(ROOT, 'presets', PRESET + '.json') : path.join(profile.DIR, FROM + '.json');
  const srcLabel = PRESET ? 'presets/' + PRESET + '.json' : 'stores/' + FROM + '.json';
  if (!fs.existsSync(srcFile)) {
    let presets = [];
    try { presets = fs.readdirSync(path.join(ROOT, 'presets')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (e) {}
    die('源不存在: ' + srcLabel + '\n' +
      '   可用样板: ' + (presets.join(' / ') || '（无 —— 先跑 node tools/preset-export.js --store=<店名> --name=<名字> --apply）') + '\n' +
      '   或从老店继承 --from=<店名>: ' + ['_template'].concat(profile.list()).join(' / '));
  }
  const srcRaw = readJSON(srcFile);
  const presetIssues = PRESET ? (srcRaw._一致性问题 || []) : [];
  const src = srcRaw;
  const P = retagProvenance(stripNotes(src), PRESET
    ? ('继承自样板 ' + srcLabel + '（由 tools/preset-export.js 从闲鱼读回生成；改值前先看 _一致性问题）')
    : ('继承自 stores/' + FROM + '.json —— 换店后必须重新实抓核对，别照抄'));
  P.$schema = 'store-profile/1';
  P.name = NAME;
  delete P.$preset;                       // 样板自己的标记，不该混进店铺档案
  // 新店直接认领给【建它的这台机器】—— 免得刚建好就被另一台机器抢去启动。
  // 空 machine id 时不写（写空等于没认领，行为和不写一样，但会让人以为认领过了）。
  if (MACHINE.id) P.ownerMachine = MACHINE.id;

  // ── 2. 解析闲鱼账号 ──
  const wantId = opt('account-id', '');
  const wantName = opt('account-name', '');
  let acc = null;
  if (wantId) {
    if (used[wantId]) die('accountId ' + wantId + ' 已经被「' + used[wantId] + '」占用 —— ' +
      '同一个闲鱼账号绝不能被两个店铺操作（登录互踢 + 重复发布）');
    acc = (accounts || []).find((a) => a.id === wantId) || { id: wantId, name: wantName || NAME, username: '' };
  } else if (accounts) {
    // ① 按店铺名精确匹配 ② 按 --account-name 匹配
    acc = accounts.find((a) => a.name === NAME)
      || (wantName ? accounts.find((a) => a.name === wantName) : null)
      || null;
  } else {
    console.log('⚠️ 拿不到 8093 账号表（' + accErr + '），账号留空 —— 稍后自己填或重跑带 --account-id=');
  }
  if (acc && used[acc.id]) die('账号「' + acc.name + '」已经被「' + used[acc.id] + '」占用（accountId ' + acc.id + '）');

  P.accountId = acc ? acc.id : '';
  // status：账号【确实在 8093 账号表里】才算接完。只是手填了个 accountId 不算 ——
  // 远程账号表里没有 = 登录/发布都会失败（好易美娱乐就是这种情况：本地兜底表里有 id，中台表里没有）。
  // 草稿店让 tools/store-init.js 只告警不报错，方便同时开很多半成品。
  const inTable = !!(acc && accounts && accounts.some((a) => a.id === acc.id));
  P.status = inTable ? 'live' : 'draft';
  // 草稿店 enabled 也置 false —— 半成品店不该被任何"全店维度"的自动化（广告窗口 / 批量上架）扫到。
  P.enabled = inTable;
  if (acc && !inTable && accounts) {
    console.log('⚠️ 账号「' + (acc.name || acc.id) + '」不在 8093 的账号表里（中台那边没有）→ 先记为草稿店 status=draft；' +
      '发布前得先让中台加上这个账号。');
  }

  // ── 3. 副图 ──
  const srcSub = ((P.副图 || {}).dir) || '';
  const subDirRel = 'publish-assets/' + NAME + '/副图';
  if (COPY_SUB && srcSub) {
    const s = path.isAbsolute(srcSub) ? srcSub : path.join(ROOT, srcSub);
    if (!fs.existsSync(s)) console.log('⚠️ 源副图目录不存在，跳过拷贝: ' + s);
    else {
      const files = fs.readdirSync(s).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!DRY) {
        const d = path.join(ROOT, subDirRel);
        fs.mkdirSync(d, { recursive: true });
        for (const f of files) fs.copyFileSync(path.join(s, f), path.join(d, f));
      }
      P.副图 = { dir: subDirRel, count: files.length };
      console.log('副图: 从「' + srcSub + '」拷了 ' + files.length + ' 张 → ' + subDirRel);
    }
  } else {
    // 不拷就指向新店自己的空目录，并把 count 归零（否则 verify 会拿源店的张数去比）
    P.副图 = { dir: subDirRel, count: 0 };
  }

  // 源店专属的本地底图/贴纸路径 —— 文件大概率不在新店目录里，清掉让 verify 不误报
  if (P.主图) {
    P.主图.baseImg = '';
    P.主图.stickers = [];
  }

  // ── 4. 落盘 ──
  console.log('\n══════ 开新店：' + NAME + ' ══════');
  console.log('  源档案   : ' + srcLabel);
  console.log('  账号     : ' + (P.accountId ? (acc.name + '  ' + String(acc.username).trim() + '  ' + P.accountId) : '⚠️ 空（草稿）'));
  console.log('  状态     : ' + P.status);
  console.log('  主图池   : ' + ((P.主图 || {}).templates || []).join(','));
  console.log('  副图     : ' + P.副图.dir + '（' + P.副图.count + ' 张）');
  console.log('  文案池   : ' + JSON.stringify((P.文案 || {}).templateIds));
  console.log('  分类/规格: ' + ((P.分类 || {}).catName) + ' / ' + ((P.规格 || {}).propertyName) + ' ' +
    JSON.stringify(((P.规格 || {}).specs || []).map((s) => s.valueText)));
  console.log('  价格/库存: ¥' + ((P.价格 || {}).default) + ' / ' + ((P.库存 || {}).default));
  console.log('  所在地/发货: ' + ((P.所在地 || {}).mode) + ' / ' + ((P.发货方式 || {}).shipMode));
  console.log('\n  ⚠️ 下面这些是【从源店继承的业务值】，开新店必须逐项确认（别默认照搬）：');
  console.log('     分类 / 规格 / 价格 / 库存 / 文案池 / 广告开关 —— 都在 stores/' + NAME + '.json 里改');
  console.log('     广告开关现在是: ' + (((P.广告 || {}).enabled === false) ? '关闭' : '开启'));

  // 样板自带的「一致性问题」必须当面念给操作者听 —— 那是"这个值是选的，不是事实"的唯一提示
  if (presetIssues.length) {
    console.log('\n  ⚠️ 这个样板有 ' + presetIssues.length + ' 项在源店里【本来就不一致】，现已取众数：');
    presetIssues.forEach((s) => console.log('     · ' + s));
    console.log('     → 这些是业务判断，不是事实。要改就改 stores/' + NAME + '.json，别改 presets/。');
  }

  if (DRY) { console.log('\n[--dry] 不写文件'); return; }

  fs.mkdirSync(profile.DIR, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(P, null, 2) + '\n', 'utf8');   // 不写 BOM
  console.log('\n✅ 写好 stores/' + NAME + '.json');

  for (const sub of ['主图', '副图']) {
    const d = path.join(ROOT, 'publish-assets', NAME, sub);
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); console.log('  建目录 publish-assets/' + NAME + '/' + sub); }
  }

  // ── 5. 自动体检 ──
  console.log('\n──── 自动体检 ────');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'store-init.js'), NAME], { stdio: 'inherit' });
  } catch (e) {
    // store-init 有 ❌ 时退出码是 1；这里不当成向导失败，只提示
    console.log('（体检有未通过项，见上）');
  }

  // ── 6. 剩下要人工给的东西 ──
  console.log('\n══════ 剩下要人工给的三样 ══════');
  console.log('  ① 闲鱼登录（机器做不了：滑块 / 短信验证码）');
  console.log('       node tools/store-ready.js "' + NAME + '"');
  console.log('       node tools/store-login.js "' + NAME + '" --wait=15');
  console.log('  ② 主图风格（不给就继承源店的版式池）');
  console.log('       node tools/make-cover.js                       # 出样图挑');
  console.log('       → 挑好后把版式 id 写进 stores/' + NAME + '.json 的 主图.templates');
  console.log('  ③ 副图（' + (COPY_SUB ? '已从源店拷 ' + P.副图.count + ' 张，不够就补' : '把图丢进 publish-assets/' + NAME + '/副图/') + '）');
  console.log('\n应用 + 自验收（幂等，可反复跑）：');
  console.log('       node tools/store-init.js "' + NAME + '" --apply --verify');
  console.log('\n然后就能发：');
  console.log('       $env:XY_STORE="' + NAME + '"; node publish-one.js <城市> <明星> <场次>');
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
