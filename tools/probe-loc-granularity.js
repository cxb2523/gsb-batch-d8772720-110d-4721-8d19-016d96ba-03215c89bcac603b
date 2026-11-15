/**
 * tools/probe-loc-granularity.js — 只读探针：闲鱼「宝贝所在地」显示到哪一级
 * 分两次 eval：① 先导航（会销毁执行上下文）② 稳定后再读文本
 */
const http = require('http');
const { SVC } = require('../lib/env');   // 【密钥外置】由 tools/dedupe-api-key.js 插入
const KEY = SVC.apiKey;
const STORE = '好易美代拍';
const ITEM = process.argv[2] || '1087691747956';

function ev(code, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ store: STORE, code });
    const req = http.request({ host: '127.0.0.1', port: 8093, path: '/api/agent/eval-on-store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 200) }); } }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs || 90000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('① 导航到 https://www.goofish.com/item?id=' + ITEM);
  const n = await ev(`(function(){ location.href='https://www.goofish.com/item?id=${ITEM}'; return 'nav'; })()`);
  console.log('   ' + JSON.stringify(n).slice(0, 150));
  await sleep(12000);

  console.log('② 读页面文本');
  const r = await ev(`
    (function(){
      try{
        var body = (document.body.innerText || '');
        var out = { url: location.href, len: body.length, title: document.title };
        var hits = [];
        body.split('\\n').forEach(function(l){
          var s = l.trim();
          if (!s) return;
          if (/所在地|发货地|广东|广州|天河|海珠|越秀|白云|黄埔|番禺|同城|附近|人想要|浏览/.test(s) && s.length < 130) hits.push(s);
        });
        out.hits = hits.slice(0, 40);
        out.hasDistrict = /天河区|海珠区|越秀区|白云区|黄埔区|番禺区/.test(body);
        out.hasCity = /广州/.test(body);
        out.hasProv = /广东/.test(body);
        return JSON.stringify(out);
      }catch(e){ return JSON.stringify({error:e.message}); }
    })()
  `);
  let d = r.result;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
  if (!d || d.error) { console.log('   ❌ ' + JSON.stringify(r).slice(0, 400)); return; }
  console.log('   URL: ' + d.url);
  console.log('   标题: ' + d.title + '   文本长度 ' + d.len);
  console.log('   出现「广东」: ' + d.hasProv + '   出现「广州」: ' + d.hasCity + '   出现具体「XX区」: ' + d.hasDistrict);
  console.log('\n   命中行:');
  (d.hits || []).forEach((h) => console.log('     ' + h));
  console.log('\n   ── 判读 ──');
  console.log('   ' + (d.hasDistrict ? '展示到【区】→ 换区有意义' : '只到【城市】→ 换区对曝光无帮助，仅对判重有用'));
})();
