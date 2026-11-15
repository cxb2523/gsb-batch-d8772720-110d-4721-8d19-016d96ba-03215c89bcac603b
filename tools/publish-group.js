/**
 * tools/publish-group.js — 按方案文件发布「一组」商品链接
 *
 * 为什么需要它：run-4groups.js 把 4 组城市明星写死在代码里（2026-10-06 那批量）。
 * 之后场次会不断变（老板：「之后还会有这样的场景出现」），所以改成【方案文件驱动】：
 *   改 JSON 就是改方案，不用动代码。
 *
 * 方案文件（publish-groups/*.json）字段：
 *   city / star / event / session / itemGapSec
 *   baseImg    老板给的海报【当底图】，仍然叠版式 ← 想要「他的图 + 三黄块」用这个
 *   mainImg    整张成品图，原样直用、【一个字都不叠】
 *   subDir     副图目录（publish-one.js 取目录下所有图，按文件名排序上传）
 *   mainTpl    指定主图版式（xuliang-v1 / __shoukai / tpl_redtext…），不写则按店铺档案随机抽
 *   items: [{ seq, tplId, price, subDir?, mainTpl? }]  ← 每条可单独覆盖
 *
 * 行为：
 *   ① 区由 lib/assign-areas.js 自动分配（同城不重复 + 台账轮转）
 *   ② baseImg 有值 → 传 KUN_BASE_IMG（底图 + 叠版式）；mainImg 有值 → 传 KUN_MAIN_IMG（原图直用）
 *   ③ 每条传 KUN_TITLE_TPL_ID / KUN_PRICE / KUN_EVENT /（可选）KUN_SUB_DIR / KUN_MAIN_TPL
 *   ④ 先跑 ensure-agent，每条发布前再预热一次（8093 会回收页面）
 *
 * ⚠️ 2026-10-08 教训：成都 4 条链接主图用的是 mainImg → 4 张主图【全部没有版式】，
 *    同时店铺档案 副图.dir 为空 → 一张副图都没有。两个 bug 都是「参数选错」而非代码坏。
 *
 * 用法:
 *   node tools/publish-group.js publish-groups/北京IEM大师赛-首开.json --plan    # 只打印，不发布
 *   node tools/publish-group.js publish-groups/北京IEM大师赛-首开.json           # 真发
 */
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { STORE, SVC, NODE: ENV_NODE } = require('../lib/env');
const { assignAreas } = require('../lib/assign-areas');
const storeProfile = require('../lib/store-profile');

const NODE = ENV_NODE.path;
const PUB = path.join(ROOT, 'publish-one.js');
const LEDGER = path.join(ROOT, '上架台账.json');
const LOGF = path.join(ROOT, 'publish-group.log');
const KEY = SVC.apiKey;

const PLANF = process.argv[2];
if (!PLANF || PLANF.indexOf('--') === 0) { console.log('用法: node tools/publish-group.js <方案文件> [--plan]'); process.exit(2); }
const PLAN = JSON.parse(fs.readFileSync(path.resolve(ROOT, PLANF), 'utf8'));
const PLAN_ONLY = process.argv.includes('--plan');

const ITEM_GAP_MS = (PLAN.itemGapSec == null ? 45 : PLAN.itemGapSec) * 1000;

// 【2026-10-09 加·真实事故】活动类型 / 场次类型 的「显式空值」语义，必须与 publish-one.js 完全一致。
//   原来的 bug：方案里把 event/session 写成 "" 想得到干净标题，--plan 的预览按空串拼（干净），
//   但 publish-one.js 把空串当成"没给"→ 回落「演唱会」「首开」，
//   于是真发出去是「杭州中国舞蹈年度大赏演唱会首开代拍」—— 预览与执行不一致，
//   把 --plan「预览=执行」的意义破掉了（这比标题写错更危险，因为它让人相信了一个假的预览）。
//   现在的语义（两边一致）：字段【缺省】→ 用默认；字段【显式写了 ""】→ 就用空。
//   ⚠️ 以后改这里的语义，必须同步改 publish-one.js 的 EVENT / SESSION，否则又会分叉。
const EV_DEFAULT = '演唱会', SESS_DEFAULT = '首开';
const EV = PLAN.event === undefined ? EV_DEFAULT : String(PLAN.event);
const SESS = PLAN.session === undefined ? SESS_DEFAULT : String(PLAN.session);

// ── 与 publish-one.js 同源的 fitTitle ──
// 【2026-10-11 改】原来这里是手抄的一份（上限写死 40）—— 抄一份就是分叉的起点：
//   publish-one.js 改成 30 字上限后这里不改，--plan 的预览就会和真发出去的标题不一致，
//   而「预览=执行」正是这个脚本存在的意义（见文件开头 2026-10-09 那段教训）。
//   现在补足短语仍从 publish-one.js 抠（保持同源），但「上限多少 / 超长怎么收」
//   统一走 lib/title.js —— 一份实现，预览与执行不可能再漂。
const P1 = fs.readFileSync(PUB, 'utf8');
const TITLE_PAD = eval(P1.match(/const TITLE_PAD = (\[[^\]]*\]);/)[1]);
const fitTitle = require('../lib/title').makeFitTitle({ pad: TITLE_PAD, max: 30, min: 30 });
const TP = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xianyu-templates.json'), 'utf8')).templates;
function titleOf(tplId) {
  const t = TP.find((x) => Number(x.id) === Number(tplId)) || TP[0];
  return fitTitle(String(t.titlePattern).replace(/\{明星\}/g, PLAN.star).replace(/\{城市\}/g, PLAN.city)
    .replace(/\{活动类型\}/g, EV).replace(/\{场次类型\}/g, SESS));
}
function descLenOf(tplId) { const t = TP.find((x) => Number(x.id) === Number(tplId)) || TP[0]; return (t.descPattern || '').length; }

const log = (m) => { const l = '[' + new Date().toLocaleString('zh-CN') + '] ' + m; console.log(l); try { fs.appendFileSync(LOGF, l + '\n'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: SVC.port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b.slice(0, 300) }); } }); });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 300000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}
const ledger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return []; } };

// ── 区自动分配（同城 N 条 → N 个不同的区）──
// 【2026-10-07 修】原来 --plan 和真跑各自调一次 assignAreas，而同次数的区是随机打散的
// → 预览显示「通州/朝阳」，实际发成「丰台/大兴」——「你确认的方案」≠「实际执行的」。
// 这跟我之前在 ab-creative.js 上踩过并修过的坑是同一个。
// 现在：--plan 把解析结果写进 <方案名>.run.json（带方案文件的 hash）；
//       真跑时 hash 对得上就用它，对不上（方案改过/没预览过）才重新算并明确告警。
const PLANABS = path.resolve(ROOT, PLANF);
const RESOLVED = PLANABS.replace(/\.json$/, '') + '.run.json';
const planHash = crypto.createHash('sha256').update(fs.readFileSync(PLANABS)).digest('hex').slice(0, 12);

let areaRes, areaSource, rv = null;
try { rv = JSON.parse(fs.readFileSync(RESOLVED, 'utf8')); } catch (e) {}
const wantReroll = process.argv.includes('--reroll');
const canReuse = !wantReroll && rv && rv.planHash === planHash && Array.isArray(rv.picked) && rv.picked.length;

if (canReuse) {
  // 方案没改过 → 沿用上次解析结果。这样「预览」和「真跑」拿到的一定是同一套区。
  areaRes = { city: rv.city, pool: rv.pool, picked: rv.picked, shortage: !!rv.shortage, warn: rv.warn || '' };
  areaSource = '复用已写盘的解析结果 ✅（与上次预览/上次执行一致）';
} else {
  areaRes = assignAreas(PLAN.city, PLAN.items.length);
  areaSource = wantReroll ? '强制重算（--reroll）'
    : (rv ? '⚠️ 方案文件已改动 → 重新现算（与上次预览不一致）' : '首次现算');
  fs.writeFileSync(RESOLVED, JSON.stringify({
    planFile: PLANF, planHash, resolvedAt: new Date().toISOString(),
    city: PLAN.city, pool: areaRes.pool, shortage: areaRes.shortage, warn: areaRes.warn,
    picked: areaRes.picked,
  }, null, 2), 'utf8');
}

if (PLAN_ONLY) {
  console.log('方案: ' + PLANF);
  console.log('  ' + PLAN.city + PLAN.star + ' · ' + PLAN.event + ' · ' + PLAN.session + '   ' + PLAN.items.length + ' 条');
  console.log('  主图: ' + (PLAN.baseImg ? ('底图(叠版式) ' + PLAN.baseImg)
    : PLAN.mainImg ? ('成品直用(不叠版式) ' + PLAN.mainImg) : '(走生成流程：服务端找官方海报)'));
  console.log('  版式: ' + (PLAN.mainTpl || '(按店铺档案池随机抽)'));
  const SUB_PLAN = PLAN.subDir || PLAN.items.map((i) => i.subDir).filter(Boolean)[0] || '';
  // 【2026-10-08 修】副图告警原来只看方案字段，没看店铺档案 → 好易美代拍的档案早就配好
  //   8 张副图了，却还每次报「档案为空则一张副图都不发」。告警喊狼来了会让真告警被忽略，
  //   所以这里必须把【实际生效】的那一层算出来再判。
  let SUB_EFFECTIVE = SUB_PLAN;
  if (!SUB_EFFECTIVE) {
    try {
      const P = storeProfile.load(STORE);
      const d = (P && P.副图 && P.副图.dir) || '';
      if (d) SUB_EFFECTIVE = path.isAbsolute(d) ? d : path.join(ROOT, d);
    } catch (e) { /* 档案读不到就按没配处理，让告警照旧 */ }
  }
  console.log('  副图: ' + (SUB_EFFECTIVE
    ? (SUB_PLAN ? '方案指定 ' : '店铺档案 ') + path.relative(ROOT, SUB_EFFECTIVE)
    : '(无：一张都不会发)'));
  const _unset = [];
  if (!PLAN.baseImg && !PLAN.mainImg) _unset.push('没指定 baseImg → 主图底图将由服务端自动找官方海报');
  const _pool = PLAN.items.map((i) => i.mainTpl).filter(Boolean);
  if (!PLAN.mainTpl && !_pool.length) _unset.push('没指定 mainTpl → 每条随机抽版式（可能抽到不同款，也可能重复）');
  if (!SUB_EFFECTIVE) _unset.push('方案和店铺档案都没配副图目录 → 这次【一张副图都不发】');
  _unset.forEach((u) => console.log('  ⚠️ ' + u));
  console.log('  区池: ' + areaRes.city + ' 共 ' + areaRes.pool + ' 个 → 分配 ' + areaRes.picked.map((a) => a.area + '/' + a.divisionId).join('  '));
  console.log('  区来源: ' + areaSource);
  console.log('  解析结果已写: ' + path.relative(ROOT, RESOLVED) + '  （真跑会复用它，保证预览=执行）');
  if (areaRes.shortage) console.log('  ⚠️ ' + areaRes.warn);
  console.log('');
  console.log('序  标题模板  文案      价格   区        标题');
  console.log('-'.repeat(110));
  const seen = {};
  PLAN.items.forEach((it, i) => {
    const t = titleOf(it.tplId);
    seen[t] = (seen[t] || 0) + 1;
    const a = areaRes.picked[i] || areaRes.picked[areaRes.picked.length - 1];
    console.log(String(it.seq || i + 1).padEnd(4) + String('模板' + it.tplId).padEnd(10) +
      (descLenOf(it.tplId) + '字').padEnd(8) + ('¥' + it.price).padEnd(7) + (a.area + '/' + a.divisionId).padEnd(10) + t + '  (' + t.length + '字)');
  });
  const dup = Object.keys(seen).filter((k) => seen[k] > 1);
  console.log('');
  console.log(dup.length ? '⚠️ 标题重复: ' + dup.join(' | ') : '✅ 标题无重复');
  const prices = PLAN.items.map((i) => i.price);
  console.log('价格: ' + JSON.stringify(prices) + (new Set(prices).size === prices.length ? '  ✅ 互不相同（价格 A/B）' : '  ⚠️ 有重复'));
  const descs = Array.from(new Set(PLAN.items.map((i) => descLenOf(i.tplId))));
  console.log('文案组: ' + JSON.stringify(descs) + (descs.length === 1 ? '  ✅ 同一文案组 → 价格是唯一变量' : '  ⚠️ 混了文案组，变量不干净'));
  process.exit(0);
}

(async () => {
  log('=== 发布方案 ' + PLANF + ' ===');
  log('  ' + PLAN.city + PLAN.star + ' · ' + PLAN.event + ' · ' + PLAN.session + ' × ' + PLAN.items.length + '，组内间隔 ' + ITEM_GAP_MS / 1000 + 's');
  if (PLAN.baseImg) log('  底图（叠版式）: ' + PLAN.baseImg);
  else if (PLAN.mainImg) log('  主图（成品直用、不叠版式）: ' + PLAN.mainImg);
  log('  版式: ' + (PLAN.mainTpl || '(随机)') + '   副图: ' + (PLAN.subDir || '(按档案)'));
  log('  区分配: ' + areaRes.picked.map((a) => a.area).join(' / ') + (areaRes.shortage ? '  ⚠️ ' + areaRes.warn : ''));
  log('  区来源: ' + areaSource);
  try { log('预热: ' + JSON.stringify(await post('/api/agent/start-one', { name: STORE }, 300000)).slice(0, 120)); }
  catch (e) { log('⚠️ 预热失败: ' + e.message); }

  const results = [];
  for (let i = 0; i < PLAN.items.length; i++) {
    const it = PLAN.items[i];
    const area = (areaRes.picked[i] || areaRes.picked[areaRes.picked.length - 1]).area;
    log('');
    log('──── 第 ' + (it.seq || i + 1) + '/' + PLAN.items.length + ' 条  标题模板' + it.tplId + '  价格¥' + it.price + '  区=' + area + ' ────');
    try { await post('/api/agent/start-one', { name: STORE }, 120000); } catch (e) {}

    const before = ledger().length;
    const env = Object.assign({}, process.env, {
      KUN_TITLE_TPL_ID: String(it.tplId),
      KUN_PRICE: String(it.price),
      KUN_EVENT: EV,
    });
    // 【2026-10-08 修】主图：baseImg 优先（老板海报当底 + 叠版式），其次 mainImg（成品直用、不叠）。
    //   原来只有 mainImg→KUN_MAIN_IMG 一条路，成都 4 条链接就是这么发的 → 主图全无版式。
    //   清清干净再设，避免上一次循环/外层 shell 残留的变量串味。
    delete env.KUN_MAIN_IMG; delete env.KUN_BASE_IMG;
    delete env.KUN_SUB_DIR; delete env.KUN_SUB_IMGS; delete env.KUN_MAIN_TPL;
    if (PLAN.baseImg) env.KUN_BASE_IMG = PLAN.baseImg;
    else if (PLAN.mainImg) env.KUN_MAIN_IMG = PLAN.mainImg;
    // 副图：方案级 subDir，条目可覆盖
    const subDir = it.subDir || PLAN.subDir;
    if (subDir) env.KUN_SUB_DIR = subDir;
    // 版式：方案级 mainTpl，条目可覆盖；都不写 → publish-one.js 按店铺档案池随机抽
    const mainTpl = it.mainTpl || PLAN.mainTpl;
    if (mainTpl) env.KUN_MAIN_TPL = mainTpl;

    let out = '';
    try { out = execFileSync(NODE, [PUB, PLAN.city, PLAN.star, SESS, area], { encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024, env }); }
    catch (e) { out = String(e.stdout || '') + '\n' + String(e.stderr || '') + '\n[exit] ' + e.message; }
    out.split('\n').forEach((l) => { if (/主图|出图:|文字层|标题\(|正文 |卡片标题|所在地|图床:|itemId|✅|❌|已记账/.test(l)) log('  ' + l.trim()); });

    const led = ledger();
    const rec = led.length > before ? led[led.length - 1] : null;
    results.push({ seq: it.seq || i + 1, tplId: it.tplId, price: it.price, area,
      ok: rec ? !!rec.ok : false, itemId: rec ? rec.itemId : null,
      title: rec ? rec.标题 : null, 定位: rec ? rec.定位 : null });
    log(rec ? ('✓ 第 ' + (it.seq || i + 1) + ': ' + (rec.itemId ? 'https://www.goofish.com/item?id=' + rec.itemId : '无 itemId') + '  ¥' + it.price + '  定位=' + rec.定位)
            : ('✗ 第 ' + (it.seq || i + 1) + ': 台账没新增'));
    if (i < PLAN.items.length - 1) { log('组内等待 ' + ITEM_GAP_MS / 1000 + 's ...'); await sleep(ITEM_GAP_MS); }
  }

  log('');
  log('=== 完成 ===');
  results.forEach((r) => log('  #' + r.seq + (r.ok ? ' ✅ ' : ' ❌ ') + (r.itemId || '-') + '  ¥' + r.price + '  ' + r.area + '  ' + (r.title || '')));
  const outF = path.join(ROOT, 'publish-group-result-' + Date.now() + '.json');
  fs.writeFileSync(outF, JSON.stringify({ plan: PLANF, results }, null, 2), 'utf8');
  log('结果已写 ' + path.basename(outF));
})().catch((e) => { log('❌ 未捕获: ' + (e && e.stack || e)); process.exit(1); });
