/**
 * tools/probe-item-pool-raw.js — 只读：在【广告后台】页面上统计在售商品的 supportAreaTarget
 *
 * 上一版失败原因：没先进广告后台。campaign.search 在 www.goofish.com 上能用，
 * 但 item.searchV 会回 ["ABORT::接口异常退出"]（open-chat-campaigns.js 是先 enterAdConsole 的）。
 *
 * 只调 item.searchV（查询），不调任何写接口。
 */
const http = require('http');
const { SVC, STORE } = require('../lib/env');
const KEY = SVC.apiKey;
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';

function ev(code, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ store: STORE, code });
    const req = http.request({ host: '127.0.0.1', port: 8093, path: '/api/agent/eval-on-store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 200) }); } }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs || 180000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COLLECT = `
(async function(){
  try{
    var mtop = window.lib.mtop;
    var out = { href: location.href };
    var r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV', v:'1.0', type:'POST',
      data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });
    out.ret = r && r.ret;
    out.success = !!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0);
    if (!out.success) return JSON.stringify(out);
    var d = (r.data || {}).result || r.data || {};
    out.resultKeys = Object.keys(d);
    var items = d.itemList || d.list || d.items || [];
    out.itemCount = items.length;
    if (items.length) {
      out.firstItemKeys = Object.keys(items[0]);
      var n = items.length, sup = 0, noArea = 0, samples = [];
      items.forEach(function(i){
        if (String(i.supportAreaTarget) === 'true') { sup++; if (samples.length < 6) samples.push({ id:String(i.itemId), t:String(i.title||'').slice(0,32) }); }
        if (i.supportAreaTarget === undefined || i.supportAreaTarget === null) noArea++;
      });
      out.supportAreaTarget_true = sup;
      out.supportAreaTarget_缺失字段 = noArea;
      out.true_samples = samples;
      out.supportAd_true = items.filter(function(i){ return String(i.supportAd) === 'true'; }).length;
    }
    return JSON.stringify(out);
  }catch(e){ return JSON.stringify({ error: e.message }); }
})()
`;

(async () => {
  console.log('① 导航到广告后台: ' + AD);
  const n = await ev(`(function(){ location.href=${JSON.stringify(AD)}; return 'nav'; })()`);
  console.log('   ' + JSON.stringify(n).slice(0, 120));
  await sleep(14000);

  console.log('② 在广告后台查在售池');
  const r = await ev(COLLECT);
  let d = r.result;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
  if (!d || d.error) { console.log('   ❌ ' + JSON.stringify(r).slice(0, 400)); return; }

  console.log('   页面: ' + d.href);
  console.log('   ret: ' + JSON.stringify(d.ret));
  if (!d.success) { console.log('   ❌ 查询未成功'); return; }
  console.log('   result 键: ' + JSON.stringify(d.resultKeys));
  console.log('   商品条数: ' + d.itemCount);
  console.log('   字段名  : ' + JSON.stringify(d.firstItemKeys));
  console.log('');
  console.log('   ┌─ supportAreaTarget 分布 ─────────────');
  console.log('   │ = true  : ' + d.supportAreaTarget_true);
  console.log('   │ = false : ' + (d.itemCount - d.supportAreaTarget_true - d.supportAreaTarget_缺失字段));
  console.log('   │ 无此字段: ' + d.supportAreaTarget_缺失字段);
  console.log('   └─────────────────────────────────────');
  console.log('   supportAd=true: ' + d.supportAd_true);
  if ((d.true_samples || []).length) {
    console.log('\n   ✅ 支持地域定向的商品:');
    d.true_samples.forEach((s) => console.log('      ' + s.id + '  ' + s.t));
  } else {
    console.log('\n   ❌ 在售池里没有 supportAreaTarget=true 的商品');
  }
})();
