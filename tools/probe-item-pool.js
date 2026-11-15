// 只读探测：item.searchV 的真实返回结构 + 统计 supportAreaTarget
const http = require('http');
const { SVC, STORE } = require('../lib/env');
const KEY = SVC.apiKey;
const code = `
(async function(){
  try{
    var mtop = window.lib.mtop;
    var r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV', v:'1.0', type:'POST',
      data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });
    var out = { ret: r && r.ret, dataKeys: r && r.data ? Object.keys(r.data) : null };
    var d = (r.data||{}).result || r.data || {};
    out.resultKeys = Object.keys(d);
    var items = d.itemList || d.list || d.items || [];
    out.itemCount = items.length;
    if (items.length) {
      out.firstItemKeys = Object.keys(items[0]);
      out.firstItem = JSON.parse(JSON.stringify(items[0]));
      var sup = 0, tot = items.length, supTrue = [];
      items.forEach(function(i){
        var v = String(i.supportAreaTarget);
        if (v === 'true') { sup++; if (supTrue.length < 5) supTrue.push({ id:String(i.itemId), t:String(i.title||'').slice(0,30) }); }
      });
      out.supportAreaTarget_true = sup;
      out.supportAreaTarget_true_samples = supTrue;
      out.supportAd_true = items.filter(function(i){ return String(i.supportAd)==='true'; }).length;
    }
    // 顺便看看 item.searchV 之外还有没有别的商品池接口线索：tabs
    out.tabs = d.tabs || null;
    return JSON.stringify(out);
  }catch(e){ return JSON.stringify({ error: e.message }); }
})()
`;
const payload = JSON.stringify({ store: STORE, code });
const req = http.request({ host: '127.0.0.1', port: 8093, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY }, timeout: 180000 },
  (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
    let j; try { j = JSON.parse(b); } catch (e) { console.log('RAW', b.slice(0, 600)); return; }
    let d = j.result; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
    console.log(JSON.stringify(d, null, 2).slice(0, 2500));
  }); });
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => console.log('ERR', e.message));
req.write(payload); req.end();
