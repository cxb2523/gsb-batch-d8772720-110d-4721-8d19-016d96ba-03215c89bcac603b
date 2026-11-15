/**
 * tools/probe-area-target.js — 只读探针：地域定向（areaTargetInfo.divisionList）到底能不能用
 *
 * 两个问题一次答：
 *   ① divisionList 的真实格式是什么（找现网里非空的样本）
 *   ② 有多少商品 supportAreaTarget=true（决定「全国计划+定向计划」方案成不成立）
 *
 * ⚠️ 全程只调两个 GET/POST 查询接口（campaign.search / item.searchV），
 *    绝不调 startV2 / edit / delete / pause。不建计划、不改计划、不提交。
 */
const http = require('http');
const { SVC, STORE } = require('../lib/env');
const KEY = SVC.apiKey;

const code = `
(async function(){
  try{
    var mtop = window.lib.mtop;
    var ok = function(r){ return r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0; };

    // ── ① 全部计划 ──
    var plans = [];
    for (var p = 1; p <= 5; p++) {
      var r = await mtop.request({ api:'mtop.taobao.idle.ad.campaign.search', v:'1.0', type:'GET',
        data:{ requestJson: JSON.stringify({ pageNum:p, pageSize:100, campaignStatus:[], statusGroup:[] }) } });
      if (!ok(r)) return JSON.stringify({ err:'campaign.search', ret:r && r.ret });
      var list = ((r.data||{}).result)||[];
      plans = plans.concat(list);
      if (list.length < 100) break;
    }

    var planRows = plans.map(function(c){
      var at = c.areaTargetInfo || null;
      var ents = (c.entityList||[]).map(function(e){
        return { id:String(e.entityId), supportAreaTarget:String(e.supportAreaTarget), areaTarget:String(e.areaTarget) };
      });
      return { campaignId:String(c.campaignId), title:String(c.title||'').slice(0,28),
               bidTarget:c.bidTarget, pauseStatus:String(c.pauseStatus||''),
               areaTargetInfo: at,
               divisionList: at ? at.divisionList : null,
               areaEmpty: at ? String(at.empty) : null,
               ents: ents };
    });

    // 汇总
    var withArea = planRows.filter(function(x){ return x.divisionList && x.divisionList.length > 0; });
    var areaShapes = {};
    withArea.forEach(function(x){ var k = JSON.stringify(x.divisionList).slice(0,200); areaShapes[k] = (areaShapes[k]||0)+1; });
    var entTotal = 0, entSupport = 0, entAreaOn = 0;
    planRows.forEach(function(x){ x.ents.forEach(function(e){ entTotal++; if(e.supportAreaTarget==='true') entSupport++; if(e.areaTarget==='true') entAreaOn++; }); });

    // ── ② 在售可投池 ──
    var pool = null, poolErr = '';
    try {
      var pr = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV', v:'1.0', type:'POST',
        data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });
      if (ok(pr)) {
        var d = (pr.data||{}).result || pr.data || {};
        var items = d.itemList || [];
        pool = items.map(function(i){
          return { itemId:String(i.itemId), title:String(i.title||'').slice(0,30),
                   supportAd:String(i.supportAd), supportAreaTarget:String(i.supportAreaTarget), areaTarget:String(i.areaTarget),
                   catId:i.catId, price:i.price,
                   字段名: Object.keys(i) };
        });
      } else poolErr = JSON.stringify(pr && pr.ret);
    } catch(e){ poolErr = e.message; }

    var poolSupport = (pool||[]).filter(function(i){ return i.supportAreaTarget==='true'; });
    var poolFields = (pool && pool[0]) ? pool[0].字段名 : null;

    return JSON.stringify({
      计划数: planRows.length,
      有地域定向的计划数: withArea.length,
      area值样本: areaShapes,
      计划里的商品实体: { 总: entTotal, supportAreaTarget为true: entSupport, areaTarget已启用: entAreaOn },
      前5个计划: planRows.slice(0,5).map(function(x){ return { id:x.campaignId, t:x.title, 目标:x.bidTarget, areaTargetInfo:x.areaTargetInfo, 实体:x.ents.slice(0,2) }; }),
      在售池: pool ? { 条数: pool.length, supportAreaTarget为true: poolSupport.length, 商品字段名: poolFields,
                      前3条: pool.slice(0,3).map(function(i){ return { id:i.itemId, t:i.title, supportAd:i.supportAd, supportAreaTarget:i.supportAreaTarget, areaTarget:i.areaTarget }; }) }
                    : { err: poolErr }
    });
  }catch(e){ return JSON.stringify({ error: e.message }); }
})()
`;

const payload = JSON.stringify({ store: STORE, code });
const req = http.request({ host: '127.0.0.1', port: 8093, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY }, timeout: 180000 },
  (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => {
      let j; try { j = JSON.parse(b); } catch (e) { console.log('RAW', b.slice(0, 500)); return; }
      let d = j.result;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
      if (!d || d.error || d.err) { console.log('❌ ' + JSON.stringify(d || j).slice(0, 500)); return; }
      console.log('计划总数            : ' + d.计划数);
      console.log('有地域定向的计划数  : ' + d.有地域定向的计划数 + '   ' + (d.有地域定向的计划数 ? '← 找到样本！' : '← 现网 0 个，说明这个能力没被用过'));
      console.log('areaTargetInfo 样本 : ' + JSON.stringify(d.area值样本));
      console.log('计划内商品实体      : ' + JSON.stringify(d.计划里的商品实体));
      console.log('\n前 5 个计划的 areaTargetInfo + 实体:');
      (d.前5个计划 || []).forEach((x) => {
        console.log('  ' + x.id + '  [' + x.目标 + ']  ' + x.t);
        console.log('      areaTargetInfo = ' + JSON.stringify(x.areaTargetInfo));
        (x.实体 || []).forEach((e) => console.log('      entity ' + e.id + '  supportAreaTarget=' + e.supportAreaTarget + '  areaTarget=' + e.areaTarget));
      });
      console.log('\n在售可投池:');
      if (d.在售池 && d.在售池.err) console.log('  ❌ ' + d.在售池.err);
      else if (d.在售池) {
        console.log('  条数 ' + d.在售池.条数 + '   其中 supportAreaTarget=true: ' + d.在售池.supportAreaTarget为true);
        console.log('  商品字段名: ' + JSON.stringify(d.在售池.商品字段名));
        (d.在售池.前3条 || []).forEach((i) => console.log('    ' + i.id + '  supportAd=' + i.supportAd + '  supportAreaTarget=' + i.supportAreaTarget + '  areaTarget=' + i.areaTarget + '  ' + i.t));
      }
    });
  });
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => console.log('ERR', e.message));
req.write(payload); req.end();
