/**
 * tools/probe-item-sku.js — 从闲鱼真实接口读某个商品的【规格 / 价格 / 库存 / 承诺】（只读）
 *
 * 为什么需要它：
 *   2026-10-07 之前，"这条链接的规格/库存到底是什么"在平台侧一直读不回来 ——
 *   买家页不内联渲染规格选择器，`mtop.taobao.idle.pc.detail` 直接挂死（超时），
 *   `mtop.idle.pc.idleitem.detail` 回 ABORT。于是"发出去的规格对不对"只能靠信任发布返回值。
 *
 *   正确的接口是 **`mtop.idle.pc.idleitem.editdetail`** —— 由「发闲置」编辑页自己调用：
 *     node tools/probe-mtop-apis.js --store="<店>" --url="https://www.goofish.com/publish?itemId=<id>"
 *   抓出来这一条（2026-10-07 实测）。编辑页必须加载商品现有规格才能编辑，所以它必然最全。
 *
 * ⚠️ 这个接口要在【编辑页】上调。首页虽然也有 window.lib.mtop，但同名的 pc.detail 在首页挂死；
 *   稳妥做法就是先导航到编辑页再调。
 *
 * 用法:
 *   node tools/probe-item-sku.js --store="<你的店铺名>" --ids=<itemId>
 *   node tools/probe-item-sku.js --store="<你的店铺名>" --ids=<id1>,<id2>raw
 */
const { post } = require('../lib/http');
const args = require('../lib/args');

const A = args.parse();
const STORE = A.store || '';
const IDS = String(A.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
const RAW = A.on('raw');

if (!STORE || !IDS.length) {
  console.log('用法: node tools/probe-item-sku.js --store="<店铺名>" --ids=<itemId>[,<itemId>...] [--raw]');
  process.exit(2);
}

const EDIT_PAGE = 'https://www.goofish.com/publish?itemId=';

// 用商品编辑页自己的接口读详情。type=GET，与抓包里看到的一致。
const CODE = `
(async function(){
  var ids = ${JSON.stringify(IDS)};
  var out = [];
  function timeout(p, ms, label){
    return Promise.race([p, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('超时 ' + ms + 'ms: ' + label)); }, ms); })]);
  }
  if (!(window.lib && window.lib.mtop && window.lib.mtop.request)) {
    return JSON.stringify([{ err: '这个页面没有 window.lib.mtop（当前 ' + location.href + '）' }]);
  }
  for (var i = 0; i < ids.length; i++) {
    var rec = { itemId: ids[i] };
    try {
      var r = await timeout(window.lib.mtop.request({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0',
        data: { itemId: String(ids[i]) }, type: 'GET' }), 30000, 'editdetail ' + ids[i]);
      rec.ret = r && r.ret;
      rec.data = (r && r.data) || null;
    } catch (e) { rec.err = (e && (e.ret || e.message)) || String(e); }
    out.push(rec);
  }
  return JSON.stringify(out);
})()`;

/** 递归收集"规格/库存/价格/承诺/类目"相关字段 */
const KEYS = /sku|propert|quantity|stock|inventory|price|spec|catId|catName|postFee|rights|protocol|freebies|simpleItem/i;
function harvest(o, prefix, hits, depth) {
  if (depth > 8 || o == null) return;
  if (Array.isArray(o)) { o.forEach((v, i) => harvest(v, prefix + '[' + i + ']', hits, depth + 1)); return; }
  if (typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    const p = prefix ? prefix + '.' + k : k;
    const v = o[k];
    if (KEYS.test(k)) {
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      hits.push(p + ' = ' + (s && s.length > 500 ? s.slice(0, 500) + '…' : s));
    }
    harvest(v, p, hits, depth + 1);
  }
}

(async () => {
  // 先导航到编辑页（用第一个 id 的编辑页；这个接口在编辑页上被验证过能通）
  const page = EDIT_PAGE + IDS[0];
  console.log('导航到编辑页 ' + page + ' ...');
  const nav = await post('/api/agent/eval-on-store',
    { store: STORE, code: 'if(location.href!==' + JSON.stringify(page) + '){location.href=' + JSON.stringify(page) + ';} "nav"' },
    { timeout: 90000 });
  if (!nav || nav.ok !== true) {
    console.log('❌ 店铺页没就绪：' + String((nav && nav.error) || '').slice(0, 120));
    console.log('   → node tools/store-ready.js "' + STORE + '"');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 12000));

  const r = await post('/api/agent/eval-on-store', { store: STORE, code: CODE }, { timeout: 240000 });
  if (!r || r.ok !== true) { console.log('❌ eval 失败：' + String((r && r.error) || '').slice(0, 200)); process.exit(1); }
  const list = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;

  for (const rec of list) {
    console.log('\n══════ ' + rec.itemId + ' ══════');
    console.log('  ret: ' + JSON.stringify(rec.ret));
    if (rec.err) { console.log('  ❌ ' + rec.err); continue; }
    if (RAW) { console.log(JSON.stringify(rec.data, null, 2).slice(0, 8000)); continue; }
    const hits = [];
    harvest(rec.data, '', hits, 0);
    if (!hits.length) console.log('  ⚠️ 响应里没找到规格/库存/价格字段（用 --raw 看整包）');
    else { console.log('  ── 规格/库存/价格/承诺/类目 ──'); for (const h of hits) console.log('    ' + h); }
  }
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
