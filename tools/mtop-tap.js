/**
 * tools/mtop-tap.js — 在闲鱼页面里挂一个 mtop 请求记录器（只记录，不改请求）
 *
 * 用途：摸清某个接口的【真实 payload 结构】。
 *   目前目标是 mtop.taobao.idle.ad.campaign.edit —— 它在仓库里从没被调用过，
 *   只能照 startV2 的形状猜，猜错了（mtop 返回 {ret:null,data:null}）。
 *   所以让老板在界面上手工改一次时段，把真实 payload 抓下来。
 *
 * ⚠️ 钩子只做「记录 + 原样透传」，不改动任何请求参数，也不拦截响应。
 *
 * 用法:
 *   node tools/mtop-tap.js --install        # 导航到擦亮后台并注入钩子
 *   node tools/mtop-tap.js --status         # 看钩子在不在、已记录几条
 *   node tools/mtop-tap.js --read           # 打印记录的调用（默认只打「写类」接口）
 *   node tools/mtop-tap.js --read --all     # 打印全部调用
 *   node tools/mtop-tap.js --clear          # 清空记录
 */
const http = require('http');
const { STORE, SVC } = require('../lib/env');

const KEY = SVC.apiKey;
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';
const MODE = ['--install', '--status', '--read', '--clear'].find((f) => process.argv.includes(f)) || '--status';
const ALL = process.argv.includes('--all');

function ev(code, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ store: STORE, code });
    const req = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 300) }); } }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs || 180000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}
const unpack = (r) => { let d = r && r.result; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} } return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTALL = `(function(){
  try{
    if (window.__mtopTap) return 'already-hooked:' + window.__mtopTap.length;
    if (!(window.lib && window.lib.mtop && window.lib.mtop.request)) return 'no-mtop';
    window.__mtopTap = [];
    var m = window.lib.mtop;
    var orig = m.request.bind(m);
    m.request = function(opts){
      try{
        window.__mtopTap.push({
          t: new Date().toLocaleTimeString('zh-CN'),
          api: (opts && opts.api) || '',
          type: (opts && opts.type) || '',
          v: (opts && opts.v) || '',
          data: (opts && opts.data) || null
        });
        if (window.__mtopTap.length > 200) window.__mtopTap.shift();
      }catch(e){}
      return orig(opts);
    };
    return 'hooked';
  }catch(e){ return 'err:' + e.message; }
})()`;

const STATUS = `(function(){
  return JSON.stringify({
    href: location.href,
    hasMtop: !!(window.lib && window.lib.mtop),
    tapExists: !!window.__mtopTap,
    count: window.__mtopTap ? window.__mtopTap.length : -1,
    apis: window.__mtopTap ? Array.from(new Set(window.__mtopTap.map(function(x){return x.api;}))) : []
  });
})()`;

// 默认只看「写类」接口，避免被 search 淹没
const WRITE_RE = /(edit|startV2|start|pause|delete|update|save|modify|create)/i;

(async () => {
  if (MODE === '--install') {
    console.log('① 导航到擦亮后台: ' + AD);
    const n = unpack(await ev(`(function(){ location.href=${JSON.stringify(AD)}; return 'nav'; })()`));
    console.log('   ' + JSON.stringify(n).slice(0, 100));
    await sleep(14000);
    console.log('② 注入钩子');
    const inst = unpack(await ev(INSTALL));
    console.log('   → ' + inst);
    if (String(inst).indexOf('hooked') < 0) { console.log('❌ 注入失败，先跑 node tools/ensure-agent.js'); process.exit(1); }
    const st = unpack(await ev(STATUS));
    console.log('③ 状态: ' + JSON.stringify(st));
    console.log('\n✅ 钩子已挂。现在请老板在界面上手工改一次某个计划的投放时段。');
    return;
  }

  if (MODE === '--clear') {
    const r = unpack(await ev(`(function(){ window.__mtopTap = []; return 'cleared'; })()`));
    console.log('已清空: ' + JSON.stringify(r));
    return;
  }

  if (MODE === '--status') {
    const st = unpack(await ev(STATUS));
    if (!st) { console.log('❌ 读不到状态（店铺可能未就绪）'); process.exit(1); }
    console.log('页面     : ' + st.href);
    console.log('mtop 可用: ' + st.hasMtop);
    console.log('钩子在   : ' + st.tapExists);
    console.log('已记录   : ' + st.count + ' 条');
    console.log('调过的接口: ' + JSON.stringify(st.apis));
    return;
  }

  // --read
  const tap = unpack(await ev(`(function(){ return JSON.stringify(window.__mtopTap || null); })()`));
  if (!tap) { console.log('❌ 钩子不在（页面可能刷新过）。重跑 --install。'); process.exit(1); }
  const rows = ALL ? tap : tap.filter((x) => WRITE_RE.test(x.api || ''));
  console.log('记录总数 ' + tap.length + '   本次打印 ' + rows.length + ' 条' + (ALL ? '（全部）' : '（只含写类接口）'));
  console.log('');
  rows.forEach((x, i) => {
    console.log('── [' + (i + 1) + '] ' + x.t + '  ' + x.api + '  ' + x.type);
    try {
      const d = x.data && x.data.requestJson ? JSON.parse(x.data.requestJson) : x.data;
      console.log(JSON.stringify(d, null, 1).split('\n').map((l) => '    ' + l).join('\n'));
    } catch (e) {
      console.log('    ' + JSON.stringify(x.data).slice(0, 600));
    }
    console.log('');
  });
})().catch((e) => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
