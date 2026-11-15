/**
 * tools/unhook.js — 撤掉 arm-capture.js 在页面上留下的东西
 *   （红横幅 / 高亮样式 / 高亮 class / mtop 记录器 / 标题里的 ★HOOKED★）
 *
 * arm-capture 抓完 payload 后用它收尾，别让老板一直看着一条红条。
 * 用法: node tools/unhook.js
 */
const http = require('http');
const { STORE, SVC } = require('../lib/env');

const code = `(function(){
  try{
    var r = { steps: [] };
    if (window.__dshTimer) { clearInterval(window.__dshTimer); window.__dshTimer = null; r.steps.push('timer'); }
    var b = document.getElementById('__dshBar');
    if (b) { b.remove(); r.steps.push('bar'); }
    var s = document.getElementById('__dshStyle');
    if (s) { s.remove(); r.steps.push('style'); }
    var old = document.title, nt = old.replace(new RegExp('^\\\\u2605HOOKED\\\\u2605 '), '');
    if (nt !== old) { document.title = nt; r.steps.push('title'); }
    var hits = [].slice.call(document.querySelectorAll('.__dshHit'));
    hits.forEach(function(e){ e.classList.remove('__dshHit'); });
    if (hits.length) r.steps.push('highlight x' + hits.length);
    if (window.__mtopTap) { window.__mtopTap = null; r.steps.push('tap'); }
    r.barGone = !document.getElementById('__dshBar');
    r.hookGone = !window.__mtopTap;
    r.title = document.title;
    return JSON.stringify(r);
  }catch(e){ return JSON.stringify({ error: e.message }); }
})()`;

const p = JSON.stringify({ store: STORE, code });
const q = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p), 'x-api-key': SVC.apiKey } },
  (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => {
      let o; try { o = JSON.parse(b); } catch (e) { console.log('RAW: ' + b.slice(0, 300)); return; }
      let d = o.result; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
      if (!d) { console.log('❌ 没拿到结果（店铺可能未就绪，先跑 ensure-agent）: ' + JSON.stringify(o).slice(0, 200)); return; }
      console.log('清理结果: ' + JSON.stringify(d, null, 1));
    });
  });
q.on('error', (e) => console.log('ERR ' + e.message));
q.write(p); q.end();
