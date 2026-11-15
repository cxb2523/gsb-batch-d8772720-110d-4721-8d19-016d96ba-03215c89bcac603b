/**
 * tools/run-4groups.js — 4 组城市明星上架调度（组内 45 秒、组间 1 小时）
 *
 * 老板需求（2026-10-06）：
 *   好易美代拍，4 组城市明星，每组 2 条链接，用【2 个不同主图模板 + 2 个不同标题模板】，
 *   组内两条相隔 30~60 秒，组间间隔 1 小时。
 *
 * 为什么不直接用 publish-batch.js：
 *   ① publish-batch.js 一次只处理【一个】城市明星，没有「组间间隔」的概念；
 *   ② 它的模板分配是每次运行现 shuffle 的 —— 同一份方案跑两次分配就变了，
 *      「老板确认的方案」和「实际发出去的」对不上。这里把分配【写死】，方案即执行。
 *   ③ 它是把 SESSION 写死成 '首开' 的（L54），二开/三开/回流捡漏发不出去。
 *
 * 用法:
 *   node tools/run-4groups.js --plan     # 只打印分配和标题，不发布
 *   node tools/run-4groups.js            # 真发，4 组跑完约 3 小时
 *   node tools/run-4groups.js --from=2   # 从第 2 组开始（断点续跑）
 *   node tools/run-4groups.js --item-gap=45 --group-gap=3600
 *
 * ⚠️ 不碰 PAUSE-PUBLISH：publish-one.js 走 mtop API，不读那个标记；
 *    那个标记只 gate queue.js（发布链队列）。队列停着，正好不会跟我们抢写文件。
 */
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SVC, ROOT, STORE, NODE: ENV_NODE } = require('../lib/env');

const NODE = ENV_NODE.path;
const PUB = path.join(__dirname, '..', 'publish-one.js');
const LEDGER = path.join(ROOT, '上架台账.json');
const LOGF = path.join(ROOT, 'publish-4groups.log');
const RESF = path.join(ROOT, 'publish-4groups-result.json');
const KEY = SVC.apiKey;

const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? Number(a.split('=')[1]) : d; };
const ITEM_GAP_MS = argOf('item-gap', 45) * 1000;      // 组内两条之间
const GROUP_GAP_MS = argOf('group-gap', 3600) * 1000;  // 组与组之间（1 小时）
const FROM = argOf('from', 1);
const PLAN_ONLY = process.argv.includes('--plan');

// ── 固定分配（方案即执行）──
// 主图候选 3 个：xuliang-v1 三黄块+一紫块 / __shoukai 首开紫块(干净版) / tpl_redtext 白底红字
// 标题模板 4 个（见 ~/.xianyu-templates.json）
const GROUPS = [
  { no: 1, city: '广州', star: '徐良',   session: '首开',
    items: [{ tplId: 1, main: 'xuliang-v1',  area: '天河区' }, { tplId: 2, main: '__shoukai',  area: '海珠区' }] },
  { no: 2, city: '泉州', star: '徐良',   session: '二开',
    items: [{ tplId: 3, main: 'tpl_redtext', area: '丰泽区' }, { tplId: 4, main: 'xuliang-v1', area: '鲤城区' }] },
  // 第 3、4 组都是「杭州孙燕姿」→ 同城 4 条，分配 4 个【不同】的区（杭州区池 5 个，够）
  { no: 3, city: '杭州', star: '孙燕姿', session: '三开',
    items: [{ tplId: 1, main: '__shoukai',  area: '上城区' }, { tplId: 3, main: 'tpl_redtext', area: '西湖区' }] },
  { no: 4, city: '杭州', star: '孙燕姿', session: '回流捡漏',
    items: [{ tplId: 2, main: 'xuliang-v1', area: '滨江区' }, { tplId: 4, main: '__shoukai',  area: '拱墅区' }] },
];

// 【2026-10-06 加】「同城不同区」固化规则 —— area 由 lib/assign-areas.js 自动算，
// 覆盖上面 GROUPS 里的硬编码值（硬编码只作为算不出来时的兜底）。
// 规则：① 同城 N 条 → 挑 N 个不同的区  ② 优先挑台账里用得少的（轮转）  ③ 池子不够就明确告警，不静默复用。
{
  const { assignAreas } = require('../lib/assign-areas');
  const need = {};
  GROUPS.forEach((g) => { need[g.city] = (need[g.city] || 0) + g.items.length; });
  const pools = {}; const idx = {};
  Object.keys(need).forEach((c) => { pools[c] = assignAreas(c, need[c]); });
  GROUPS.forEach((g) => g.items.forEach((it) => {
    if (idx[g.city] === undefined) idx[g.city] = 0;
    it.area = pools[g.city].picked[idx[g.city]++].area;
  }));
  Object.keys(pools).forEach((c) => {
    if (pools[c].shortage) console.log('⚠️ 区池不足：' + pools[c].warn);
    else console.log('[区分配] ' + c + ' 要 ' + need[c] + ' 个 → ' + pools[c].picked.map((a) => a.area + '/' + a.divisionId).join('  '));
  });
}

// ── 标题预演用的 fitTitle（从 publish-one.js 真实文件抠，不手打）──
const P1 = fs.readFileSync(PUB, 'utf8');
const TITLE_PAD = eval(P1.match(/const TITLE_PAD = (\[[^\]]*\]);/)[1]);
function fitTitle(t) {
  t = String(t == null ? '' : t);
  if (t.length > 40) return t.slice(0, 40);
  if (t.length < 30) { const gap = 30 - t.length; let best = ''; for (const f of TITLE_PAD) if (f.length <= gap && f.length > best.length) best = f; t += best; while (t.length < 30) t += '！'; }
  return t;
}
const TP = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xianyu-templates.json'), 'utf8')).templates;
function titleOf(tplId, g) {
  const t = TP.find((x) => Number(x.id) === Number(tplId)) || TP[0];
  return fitTitle(String(t.titlePattern).replace(/\{明星\}/g, g.star).replace(/\{城市\}/g, g.city)
    .replace(/\{活动类型\}/g, '演唱会').replace(/\{场次类型\}/g, g.session));
}

function log(m) {
  const line = '[' + new Date().toLocaleString('zh-CN') + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: 8093, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b.slice(0, 300) }); } }); });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 300000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}
const ledger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return []; } };

// ── --plan：打印分配 + 标题 + 时间表，不发布 ──
if (PLAN_ONLY) {
  const t0 = new Date();
  console.log('方案预览（不发布）  店铺=' + STORE);
  console.log('  组内间隔 ' + ITEM_GAP_MS / 1000 + 's    组间间隔 ' + GROUP_GAP_MS / 1000 + 's\n');
  const seen = {};
  let t = t0.getTime();
  for (const g of GROUPS) {
    console.log('━━ 第 ' + g.no + ' 组  ' + g.city + g.star + ' · ' + g.session + '   开跑 ' +
      new Date(t).toLocaleTimeString('zh-CN') + ' ━━');
    for (let i = 0; i < g.items.length; i++) {
      const it = g.items[i];
      const ti = titleOf(it.tplId, g);
      seen[ti] = (seen[ti] || 0) + 1;
      console.log('   #' + g.no + '-' + (i + 1) + '  ' + new Date(t).toLocaleTimeString('zh-CN') +
        '   标题模板' + it.tplId + '  主图=' + it.main);
      console.log('         ' + ti + '   (' + ti.length + '字)');
      t += ITEM_GAP_MS;
    }
    t = t - ITEM_GAP_MS + GROUP_GAP_MS;
    console.log('');
  }
  const dup = Object.keys(seen).filter((k) => seen[k] > 1);
  console.log('8 条标题总数 ' + Object.keys(seen).length + ' 个唯一值');
  console.log(dup.length ? '❌ 有重复: ' + dup.join(' | ') : '✅ 8 条标题互不相同');
  const tplUse = {}; GROUPS.forEach((g) => g.items.forEach((i) => { tplUse[i.tplId] = (tplUse[i.tplId] || 0) + 1; }));
  console.log('标题模板使用次数: ' + JSON.stringify(tplUse));
  process.exit(dup.length ? 1 : 0);
}

(async () => {
  log('=== 4 组上架开始  组内 ' + ITEM_GAP_MS / 1000 + 's  组间 ' + GROUP_GAP_MS / 1000 + 's  从第 ' + FROM + ' 组起 ===');
  try { log('预热: ' + JSON.stringify(await post('/api/agent/start-one', { name: STORE }, 300000)).slice(0, 120)); }
  catch (e) { log('⚠️ 预热失败: ' + e.message); }

  const results = [];
  for (const g of GROUPS) {
    if (g.no < FROM) { log('跳过第 ' + g.no + ' 组（--from=' + FROM + '）'); continue; }
    const gStart = Date.now();
    log('');
    log('━━━━━━ 第 ' + g.no + '/4 组  ' + g.city + g.star + ' · ' + g.session + ' ━━━━━━');

    for (let i = 0; i < g.items.length; i++) {
      const it = g.items[i];
      log('──── 第 ' + g.no + '-' + (i + 1) + ' 条  标题模板' + it.tplId + '  主图=' + it.main + '  区=' + (it.area || '(自动)') + '  价格=¥' + (it.price || '50(默认)') + ' ────');

      // 每条都先确保店铺就绪（8093 会回收页面）
      try { await post('/api/agent/start-one', { name: STORE }, 120000); } catch (e) {}

      const before = ledger().length;
      const env = Object.assign({}, process.env, { KUN_TITLE_TPL_ID: String(it.tplId), KUN_MAIN_TPL: it.main });
      if (it.price) env.KUN_PRICE = String(it.price);   // 【2026-10-06 加】按条指定价格，用于价格 A/B（¥50 vs ¥80）
      let out = '';
      try { out = execFileSync(NODE, [PUB, g.city, g.star, g.session, it.area || ''], { encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024, env }); }
      catch (e) { out = String(e.stdout || '') + '\n' + String(e.stderr || '') + '\n[exit] ' + e.message; }
      out.split('\n').forEach((l) => { if (/主图模板|出图:|文字层|标题\(|正文 |卡片标题|所在地|图床:|itemId|✅|❌|已记账|返回/.test(l)) log('  ' + l.trim()); });

      const led = ledger();
      const rec = led.length > before ? led[led.length - 1] : null;
      results.push({ 组: g.no, 序: i + 1, city: g.city, star: g.star, session: g.session,
        tplId: it.tplId, main: it.main, ok: rec ? !!rec.ok : false, itemId: rec ? rec.itemId : null,
        title: rec ? rec.标题 : (out.match(/标题\(\d+\): (.*)/) || [])[1] || null,
        定位: rec ? rec.定位 : null, 主图模板: rec ? rec.主图模板 : it.main });
      log(rec ? ('✓ 第 ' + g.no + '-' + (i + 1) + ': ' + (rec.itemId ? 'https://www.goofish.com/item?id=' + rec.itemId : '无 itemId') + '  定位=' + rec.定位)
              : ('✗ 第 ' + g.no + '-' + (i + 1) + ': 台账没新增'));

      if (i < g.items.length - 1) { log('组内等待 ' + ITEM_GAP_MS / 1000 + 's ...'); await sleep(ITEM_GAP_MS); }
    }

    if (g.no < GROUPS.length) {
      const wait = GROUP_GAP_MS - (Date.now() - gStart);
      if (wait > 0) { log('组间等待 ' + Math.round(wait / 1000) + 's（下一组 ' + new Date(Date.now() + wait).toLocaleTimeString('zh-CN') + '）...'); await sleep(wait); }
    }
  }

  const dup = {}; results.forEach((r) => { if (r.title) dup[r.title] = (dup[r.title] || 0) + 1; });
  const dupList = Object.keys(dup).filter((k) => dup[k] > 1);
  log('');
  log('=== 4 组完成 ===');
  results.forEach((r) => log('  #' + r.组 + '-' + r.序 + (r.ok ? ' ✅ ' : ' ❌ ') + (r.itemId || '-') + '  ' + (r.title || '') + '  主图=' + r.主图模板));
  log(dupList.length ? '⚠️ 标题重复: ' + dupList.join(' | ') : '✅ 标题无重复');
  fs.writeFileSync(RESF, JSON.stringify({ groups: GROUPS, results, 标题重复: dupList }, null, 2), 'utf8');
  log('结果已写 ' + RESF);
})().catch((e) => { log('❌ 未捕获: ' + (e && e.stack || e)); process.exit(1); });
