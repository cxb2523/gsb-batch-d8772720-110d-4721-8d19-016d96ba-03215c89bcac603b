// 只读探针 2：把「好易美代拍」实际生效的标题模板与 SKU 规格完整读出来
// 为什么需要：window.kunPublish.CONCERT_TEMPLATES 是 4 条（不是 publish.js 里的 6 条），
// 且 localStorage 里有 kun_tpl_global / kun_tpl_好易美代拍 两组「店铺级模板覆盖」。
const http = require('http');
const { SVC } = require('../lib/env');   // 【密钥外置】由 tools/dedupe-api-key.js 插入
const KEY = SVC.apiKey;
const STORE = '好易美代拍';

const code = [
  '(function(){',
  'try{',
  '  var g=function(k){try{return localStorage.getItem(k)}catch(e){return null}};',
  '  var tpls=(window.kunPublish&&window.kunPublish.CONCERT_TEMPLATES)||[];',
  '  return JSON.stringify({',
  '    liveTplCount: tpls.length,',
  '    liveTpls: tpls.map(function(t){return{id:t.id,name:t.name,titleMode:t.titleMode||null,',
  '      titlePattern:t.titlePattern||"",descLen:(t.descPattern||"").length,desc:(t.descPattern||""),',
  '      price:t.price,origPrice:t.origPrice,stock:t.stock,categoryName:t.categoryName,',
  '      shipMode:t.shipMode,locationMode:t.locationMode,subImg:t.subImg,commitment:t.commitment};}),',
  '    tplGlobal: g("kun_tpl_global"),',
  '    tplStore: g("kun_tpl_' + STORE + '"),',
  '    stores: g("kun_stores"),',
  '    curStore: g("kun_cur_store"),',
  '    dailyTasksLen: (g("kun_daily_tasks_v2")||"").length',
  '  });',
  '}catch(e){return JSON.stringify({error:e.message});}',
  '})()',
].join('\n');

const payload = JSON.stringify({ store: STORE, code });
const req = http.request({
  host: '127.0.0.1', port: 8093, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY },
  timeout: 90000,
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    let j; try { j = JSON.parse(b); } catch (e) { console.log('RAW:', b.slice(0, 800)); return; }
    let d = j.result;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
    if (!d || typeof d !== 'object') { console.log(JSON.stringify(j).slice(0, 800)); return; }
    if (d.error) { console.log('页面报错:', d.error); return; }

    console.log('=== 页面里实际生效的标题模板：' + d.liveTplCount + ' 条 ===');
    (d.liveTpls || []).forEach((t) => {
      console.log('');
      console.log('  id=' + t.id + '  ' + t.name);
      console.log('    titleMode    : ' + t.titleMode);
      console.log('    titlePattern : ' + t.titlePattern);
      console.log('    price/stock  : ' + t.price + ' / ' + t.stock + '   分类: ' + t.categoryName);
      console.log('    shipMode     : ' + JSON.stringify(t.shipMode) + '    locationMode: ' + JSON.stringify(t.locationMode));
      console.log('    subImg       : ' + JSON.stringify(t.subImg) + '    commitment: ' + JSON.stringify(t.commitment));
      console.log('    desc 长度    : ' + t.descLen);
      console.log('    desc         : ' + JSON.stringify(t.desc));
    });
    console.log('');
    console.log('=== 店铺级模板覆盖（localStorage）===');
    console.log('kun_tpl_global    : ' + (d.tplGlobal ? d.tplGlobal.slice(0, 400) : '(无)'));
    console.log('kun_tpl_' + STORE + ' : ' + (d.tplStore ? d.tplStore.slice(0, 400) : '(无)'));
    console.log('');
    console.log('=== 店铺列表 ===');
    console.log('kun_stores   : ' + d.stores);
    console.log('kun_cur_store: ' + d.curStore);
    console.log('kun_daily_tasks_v2 长度: ' + d.dailyTasksLen);
  });
});
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => console.log('ERR', e.message));
req.write(payload);
req.end();
