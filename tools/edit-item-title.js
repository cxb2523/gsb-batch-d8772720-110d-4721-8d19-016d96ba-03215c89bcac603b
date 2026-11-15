/**
 * tools/edit-item-title.js —— 改【已上架】商品的标题（原地改，itemId 不变、计划不脱钩）
 *
 * 为什么不用「下架重发」：
 *   重发会产生新 itemId → 已经建好的擦亮计划里挂的还是旧 itemId，而**擦亮计划删不掉**
 *   （服务端 DELETE_GUARD），于是必然留下一条挂在已下架宝贝上的死计划。
 *   原地改标题不动 itemId，计划不用重建。
 *
 * 接口（与 tools/set-item-sku.js 同一套，2026-10-07 在编辑页抓的，非猜测）：
 *   mtop.idle.pc.idleitem.editdetail → 读：返回**可编辑的整包**
 *   mtop.idle.pc.idleitem.edit       → 写：整包写回（闲鱼编辑页自己就是这么干的）
 *
 * ⚠️ 改已上架商品会触发闲鱼重新审核（set-item-sku.js 头部同样记着这条）。
 *    对**推广可投性**有没有影响没有先例 —— 所以本工具写完后立刻复查
 *    `supportAd`，一旦翻成 false 立刻能看出来并改回去。
 *    默认只预览（--dry 行为），要真写必须 --apply。
 *
 * 用法:
 *   # 只看现状（标题 + 可投性），什么都不改
 *   node tools/edit-item-title.js --store="好易美代拍" --ids=1090330930251,1091414009357
 *   # 预览：每个 id 对应的新标题用 | 分隔，顺序对齐 --ids
 *   node tools/edit-item-title.js --store="好易美代拍" --ids=a,b --titles="新标题A|新标题B"
 *   # 确认后真写（自动回读校验 + 复查可投性）
 *   node tools/edit-item-title.js --store="好易美代拍" --ids=a,b --titles="新标题A|新标题B" --apply
 */
const { post } = require('../lib/http');
const args = require('../lib/args');
const { PLATFORM_TITLE_MAX } = require('../lib/title');

const A = args.parse();
const STORE = A.store || '';
const IDS = String(A.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
const APPLY = A.on('apply');

if (!STORE || !IDS.length) {
  console.log('用法: node tools/edit-item-title.js --store="<店铺名>" --ids=<itemId,itemId> [--titles="标题1|标题2" | --titlesFile=<UTF-8 文件,一行一条>] [--apply]');
  process.exit(2);
}

// 不给 --titles/--titlesFile = 只读侦察（打印现标题 + 可投性）
// 中文标题推荐走 --titlesFile（UTF-8，一行一条），理由见 lib/args.js 头部：
// 命令行传中文虽然有 args.js 兜着，但 UTF-8 文件是仓库既定的稳妥做法。
const fs = require('fs');
let TITLES = [];
if (A.titlesFile !== undefined) {
  const fp = String(A.titlesFile);
  if (!fs.existsSync(fp)) { console.log('❌ --titlesFile 不存在: ' + fp); process.exit(2); }
  TITLES = fs.readFileSync(fp, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '');
} else if (A.titles !== undefined) {
  if (A.titles === true) { console.log('❌ --titles 后面要跟值（用 | 分隔），或用 --titlesFile'); process.exit(2); }
  TITLES = String(A.titles).split('|').map((s) => s.trim());
}

if (TITLES.length) {
  if (TITLES.length !== IDS.length) {
    console.log('❌ --titles 有 ' + TITLES.length + ' 条，--ids 有 ' + IDS.length + ' 个 —— 必须一一对应');
    process.exit(2);
  }
  let bad = 0;
  TITLES.forEach((t, i) => {
    if (!t) { console.log('❌ 第 ' + (i + 1) + ' 条标题为空'); bad++; }
    if (t.length > PLATFORM_TITLE_MAX) {
      console.log('❌ ' + IDS[i] + ' 标题 ' + t.length + ' 字 > 平台上限 ' + PLATFORM_TITLE_MAX + '：' + t);
      bad++;
    }
  });
  if (bad) process.exit(2);
  console.log('目标标题:');
  TITLES.forEach((t, i) => console.log('  ' + IDS[i] + ' (' + t.length + ' 字) ' + t));
}

const EDIT_PAGE = 'https://www.goofish.com/publish?itemId=';

const CODE = `
(async function(){
  var jobs = ${JSON.stringify(IDS.map((id, i) => ({ id: id, title: TITLES[i] || '' })))};
  var doApply = ${APPLY ? 'true' : 'false'};
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function timeout(p, ms, label){
    return Promise.race([p, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('超时 ' + ms + 'ms: ' + label)); }, ms); })]);
  }
  var mtop = (window.lib && window.lib.mtop && window.lib.mtop.request) ? window.lib.mtop.request : null;
  if (!mtop) return JSON.stringify([{ err: '这个页面没有 window.lib.mtop（当前 ' + location.href + '）' }]);
  function req(api, data, type){
    return timeout(mtop({ api: api, v: '1.0', data: data, type: type || 'GET' }), 40000, api);
  }
  // 把整包里的标题替换成占位符后再序列化 —— 用来证明【只有标题变了】
  function norm(o, placeholder){
    try {
      var c = JSON.parse(JSON.stringify(o));
      c.itemTextDTO = c.itemTextDTO || {};
      c.itemTextDTO.title = placeholder;
      return JSON.stringify(c);
    } catch (e) { return 'ERR:' + String(e && e.message || e); }
  }
  function diffKeys(a, b){
    var ks = {}, out = [];
    Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function(k){ ks[k] = 1; });
    Object.keys(ks).forEach(function(k){
      var x, y;
      try { x = JSON.stringify(a ? a[k] : null); } catch (e) { x = 'x'; }
      try { y = JSON.stringify(b ? b[k] : null); } catch (e) { y = 'y'; }
      if (x !== y) out.push(k);
    });
    return out;
  }
  var out = [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var rec = { itemId: job.id, target: job.title || null };
    try {
      var r1 = await req('mtop.idle.pc.idleitem.editdetail', { itemId: String(job.id) });
      rec.readRet = r1 && r1.ret;
      var full = (r1 && r1.data) || {};
      if (!full || !full.itemId) { rec.err = '读不到可编辑整包'; out.push(rec); continue; }
      rec.beforeTitle = ((full.itemTextDTO || {}).title) || '';
      rec.beforeLen = rec.beforeTitle.length;
      var before = JSON.parse(JSON.stringify(full));

      if (doApply && job.title) {
        full.itemTextDTO = full.itemTextDTO || {};
        full.itemTextDTO.title = job.title;
        full.itemId = String(job.id);
        var r2 = await req('mtop.idle.pc.idleitem.edit', full, 'POST');
        rec.writeRet = r2 && r2.ret;
        rec.writeOk = !!(r2 && r2.ret && String(r2.ret[0]).indexOf('SUCCESS') === 0);
        if (!rec.writeOk) { rec.writeData = JSON.stringify((r2 && r2.data) || {}).slice(0, 300); out.push(rec); continue; }
        await sleep(4000);
        var r3 = await req('mtop.idle.pc.idleitem.editdetail', { itemId: String(job.id) });
        var f3 = (r3 && r3.data) || {};
        rec.afterTitle = ((f3.itemTextDTO || {}).title) || '';
        rec.afterLen = rec.afterTitle.length;
        rec.titleOk = rec.afterTitle === job.title;
        rec.onlyTitleChanged = norm(before, '<TITLE>') === norm(f3, '<TITLE>');
        if (!rec.onlyTitleChanged) {
          rec.changedTopKeys = diffKeys(before, f3);
          rec.changedTextKeys = diffKeys(before.itemTextDTO, f3.itemTextDTO);
        }
      }
    } catch (e) { rec.err = (e && (e.ret || e.message)) || String(e); }
    out.push(rec);
  }

  // 复查推广可投性（改完立刻查，翻 false 要马上知道）
  var elig = {};
  try {
    var re = await req('mtop.taobao.idle.ad.item.searchV2',
      { requestJson: JSON.stringify({ pageNum: 1, pageSize: 200, tab: 'all', needTabs: true }) }, 'POST');
    var list = (((re && re.data) || {}).result || {}).itemList || [];
    jobs.forEach(function(j){
      var hit = null;
      for (var k = 0; k < list.length; k++) if (String(list[k].itemId) === String(j.id)) { hit = list[k]; break; }
      elig[j.id] = hit ? { 在池: true, supportAd: hit.supportAd,
        原因: (hit.notSupportAdInfo || []).map(function(x){ return x.notSupportReason; }) }
        : { 在池: false };
    });
  } catch (e) { elig = { err: String(e && (e.ret || e.message) || e) }; }
  return JSON.stringify({ items: out, eligibility: elig });
})()`;

(async () => {
  // 先 ready，再导航到编辑页（写接口要编辑页的上下文）
  const page = EDIT_PAGE + IDS[0];
  console.log('导航到编辑页 ' + page + ' ...');
  const nav = await post('/api/agent/eval-on-store',
    { store: STORE, code: 'if(location.href!==' + JSON.stringify(page) + '){location.href=' + JSON.stringify(page) + ';} "nav"' },
    { timeout: 90000 });
  if (!nav || nav.ok !== true) {
    console.log('❌ 店铺页没就绪：' + String((nav && nav.error) || '').slice(0, 140));
    console.log('   → node tools/ensure-agent.js');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 12000));

  console.log(TITLES.length ? (APPLY ? '执行改标题...' : '【预览】只读，不写盘') : '【只读侦察】');
  const r = await post('/api/agent/eval-on-store', { store: STORE, code: CODE }, { timeout: 300000 });
  if (!r || r.ok !== true) { console.log('❌ eval 失败：' + String((r && r.error) || '').slice(0, 200)); process.exit(1); }
  const data = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
  const list = data.items || [];
  let bad = 0;
  for (const rec of list) {
    console.log('\n══════ ' + rec.itemId + ' ══════');
    if (rec.err) { console.log('  ❌ ' + rec.err); bad++; continue; }
    console.log('  读: ' + JSON.stringify(rec.readRet));
    console.log('  现标题 (' + rec.beforeLen + '): ' + rec.beforeTitle);
    if (rec.target) console.log('  目标   (' + rec.target.length + '): ' + rec.target);
    if (!APPLY) continue;
    console.log('  写: ' + JSON.stringify(rec.writeRet));
    if (!rec.writeOk) { console.log('  ❌ 写入失败 ' + (rec.writeData || '')); bad++; continue; }
    console.log('  回读 (' + rec.afterLen + '): ' + rec.afterTitle);
    console.log(rec.titleOk ? '  ✅ 标题已生效且与目标一致' : '  ❌ 回读标题与目标不一致');
    if (!rec.titleOk) bad++;
    if (rec.onlyTitleChanged) console.log('  ✅ 除标题外整包无变化');
    else { console.log('  ⚠️ 除标题外还有字段变化，顶层: ' + JSON.stringify(rec.changedTopKeys) + ' 文案层: ' + JSON.stringify(rec.changedTextKeys)); bad++; }
  }
  console.log('\n── 可投性复查（改动后）──');
  const e = data.eligibility || {};
  if (e.err) console.log('  ⚠️ 查不到：' + String(e.err).slice(0, 160));
  else IDS.forEach((id) => {
    const x = e[id] || {};
    console.log('  ' + id + ' 在池=' + x.在池 + ' supportAd=' + x.supportAd +
      (x.原因 && x.原因.length ? '  ' + JSON.stringify(x.原因) : ''));
    if (APPLY && x.supportAd === false) { console.log('    🔴 改标题后可投性翻成 false —— 立刻用本工具改回原标题！'); bad++; }
  });
  if (!TITLES.length) console.log('\n📋 只读侦察，没有写任何东西。');
  else if (!APPLY) console.log('\n📋 上面是【预览】，没有写任何东西。确认无误就重跑并加 --apply');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
