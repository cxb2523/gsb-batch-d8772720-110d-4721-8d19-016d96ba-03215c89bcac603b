// 只读探针：从运行中的 8093 服务，读「好易美代拍」的实际 localStorage 配置
// 用途：区分配置的「默认值」和「实际生效值」—— 店铺配置不在磁盘上，只能这样读
const http = require('http');
const { SVC } = require('../lib/env');   // 【密钥外置】由 tools/dedupe-api-key.js 插入
const KEY = SVC.apiKey;
const STORE = '好易美代拍';

const code = [
  '(function(){',
  'try{',
  '  var out={};',
  '  out.href = location.href;',
  '  out.storeCfg = localStorage.getItem("kun_store_cfg_' + STORE + '");',
  '  out.projCfgs = localStorage.getItem("kun_project_configs");',
  '  out.storeProj = localStorage.getItem("kun_store_projects");',
  '  out.hasKunPublish = !!window.kunPublish;',
  '  out.sessionTypes = (window.kunPublish && window.kunPublish.SESSION_TYPES) || null;',
  '  out.tplCount = (window.kunPublish && window.kunPublish.CONCERT_TEMPLATES || []).length;',
  '  out.keys = Object.keys(localStorage).filter(function(k){return k.indexOf("kun_")===0;});',
  '  return JSON.stringify(out);',
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
    console.log('HTTP', res.statusCode);
    let j; try { j = JSON.parse(b); } catch (e) { console.log('RAW:', b.slice(0, 600)); return; }
    let d = j.result;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
    if (d && typeof d === 'object') {
      console.log('页面:', d.href);
      console.log('kunPublish 已注入:', d.hasKunPublish);
      console.log('SESSION_TYPES:', JSON.stringify(d.sessionTypes));
      console.log('页面里的标题模板条数:', d.tplCount);
      console.log('kun_ 开头的 localStorage 键:', JSON.stringify(d.keys));
      console.log('');
      console.log('--- 店铺配置 kun_store_cfg_' + STORE + ' ---');
      if (!d.storeCfg) { console.log('(未设置 → 全部走 getDefaultStoreConfig() 默认值)'); }
      else { try { console.log(JSON.stringify(JSON.parse(d.storeCfg), null, 2)); } catch (e) { console.log(d.storeCfg); } }
      console.log('');
      console.log('--- 项目配置 kun_project_configs ---');
      console.log(d.projCfgs || '(未设置)');
      console.log('');
      console.log('--- 店铺→项目 kun_store_projects ---');
      console.log(d.storeProj || '(未设置)');
    } else {
      console.log(JSON.stringify(j, null, 2).slice(0, 1200));
    }
  });
});
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => console.log('ERR', e.message));
req.write(payload);
req.end();
