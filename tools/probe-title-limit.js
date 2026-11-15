// 只读：去商品详情页读【真实标题】，判断「闲鱼标题上限 30 字」是真是假
const http = require('http');
const { STORE, SVC } = require('../lib/env');
const ITEMS = [
  ['1089695917683', 36, '10-06 模板4 回流捡漏'],
  ['1090015449842', 38, '10-08 成都 模板4（回读说存了30字）'],
  ['1088031855313', 30, '10-08 成都 模板1（对照组）'],
];
function ev(code, t) {
  return new Promise((resolve) => {
    const p = JSON.stringify({ store: STORE, code });
    const q = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p), 'x-api-key': SVC.apiKey } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 200) }); } }); });
    q.on('error', (e) => resolve({ ok: false, error: e.message }));
    q.setTimeout(t || 120000, () => q.destroy(new Error('超时'))); q.write(p); q.end();
  });
}
const unpack = (r) => { let d = r && r.result; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} } return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('用【编辑接口 mtop.idle.pc.idleitem.editdetail】直接把闲鱼侧真实存的标题读回来\n');
  for (const [id, sent, label] of ITEMS) {
    const r = await ev(`(async function(){
      try{
        var r = await window.lib.mtop.request({ api:'mtop.idle.pc.idleitem.editdetail', v:'1.0',
          data:{ itemId: ${JSON.stringify(String(id))} }, type:'GET' });
        var d = (r && r.data) || {};
        var t = ((d.itemTextDTO||{}).title) || '';
        return JSON.stringify({ ret: r && r.ret, title: t, len: t.length });
      }catch(e){ return JSON.stringify({ err: (e && (e.ret || e.message)) || String(e) }); }
    })()`);
    const d = unpack(r);
    console.log('── ' + label + '  itemId=' + id);
    if (!d || d.err || d.ret && String(d.ret[0]).indexOf('SUCCESS') !== 0) {
      console.log('   ❌ 读不到: ' + JSON.stringify(d).slice(0, 200));
    } else {
      console.log('   我们发出 : ' + sent + ' 字');
      console.log('   闲鱼实存 : ' + d.len + ' 字');
      console.log('   内容     : ' + JSON.stringify(d.title));
      console.log('   ' + (d.len === sent ? '✅ 完整（说明回读校验的截断是接口层的假警报）' : (d.len < sent ? '⚠️ 确实被截断到 ' + d.len + ' 字' : '?')));
    }
    console.log('');
    await sleep(1000);
  }
})();
