/**
 * tools/arm-capture.js — 给「抓 campaign.edit payload」做准备：挂钩子 + 在页面上画指引
 *
 * 为什么这么做（前两次失败的教训）：
 *   ① 老板手动改时钩子 0 条记录 → 可能他看的页面 ≠ 我挂钩子的页面
 *      → 解决：在页面上画一条【只有挂到钩子的页面才有】的红横幅。老板看到横幅 = 同一个页面。
 *   ② 老板说「没看到时段选择器在哪」→ 不知道点哪
 *      → 解决：把该点的元素实时框红（settingsBtn / 底部确定），并显示操作步骤。
 *   ③ 抓不抓得到看不见 → 横幅里【实时显示已记录条数】，数字一跳就说明抓到了。
 *
 * ⚠️ 只加视觉标记 + 记录请求，不改任何请求内容、不自动点任何按钮。
 *
 * 用法:
 *   node tools/arm-capture.js --arm      # 挂好（钩子 + 红横幅 + 高亮）
 *   node tools/arm-capture.js --status   # 看钩子还在不在、记录几条
 *   node tools/arm-capture.js --read     # 打印记到的写类请求 payload
 */
const http = require('http');
const { STORE, SVC } = require('../lib/env');
const KEY = SVC.apiKey;
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';
const MODE = process.argv.includes('--arm') ? 'arm' : (process.argv.includes('--read') ? 'read' : 'status');

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

const ARM = `(function(){
  try{
    // ── 1. 挂 mtop 记录器 ──
    if (!window.__mtopTap) {
      if (!(window.lib && window.lib.mtop && window.lib.mtop.request)) return 'no-mtop';
      window.__mtopTap = [];
      var m = window.lib.mtop, orig = m.request.bind(m);
      m.request = function(opts){
        try{ window.__mtopTap.push({ t:new Date().toLocaleTimeString('zh-CN'), api:(opts&&opts.api)||'',
          type:(opts&&opts.type)||'', data:(opts&&opts.data)||null });
          if(window.__mtopTap.length>300) window.__mtopTap.shift(); }catch(e){}
        return orig(opts);
      };
    }

    // ── 2. 页面视觉标记（只有挂到钩子的页面才有）──
    if (!document.getElementById('__dshBar')) {
      var bar = document.createElement('div');
      bar.id = '__dshBar';
      bar.style.cssText = 'position:fixed;left:0;top:0;width:100%;z-index:2147483647;' +
        'background:#d0021b;color:#fff;font:bold 13px/1.5 "Microsoft YaHei",sans-serif;' +
        'padding:6px 10px;box-shadow:0 2px 8px rgba(0,0,0,.4);white-space:pre-line;';
      document.body.appendChild(bar);
      document.title = '★HOOKED★ ' + document.title.replace(/^★HOOKED★ /,'');
    }
    if (!document.getElementById('__dshStyle')) {
      var st = document.createElement('style');
      st.id = '__dshStyle';
      st.textContent = '@keyframes __dshPulse{0%,100%{outline-color:#d0021b}50%{outline-color:#ffdd00}}' +
        '.__dshHit{outline:4px solid #d0021b !important;outline-offset:2px !important;' +
        'animation:__dshPulse 1s infinite !important;background:rgba(255,221,0,.18) !important;position:relative;z-index:99999;}';
      document.head.appendChild(st);
    }

    // ── 3. 实时高亮 + 横幅文案（每 400ms 刷一次，抽屉开合自动跟随）──
    if (window.__dshTimer) clearInterval(window.__dshTimer);
    window.__dshTimer = setInterval(function(){
      try{
        var bar = document.getElementById('__dshBar');
        var n = window.__mtopTap ? window.__mtopTap.length : -1;
        // 找抽屉
        var ms=[].slice.call(document.querySelectorAll('.ant-drawer-content,.ant-modal-content'))
          .filter(function(x){var r=x.getBoundingClientRect();return r.width>100&&r.height>80;});
        var d=ms.length?ms[0]:null;

        // 清掉旧高亮
        [].slice.call(document.querySelectorAll('.__dshHit')).forEach(function(e){ e.classList.remove('__dshHit'); });

        var step='① 在列表某一行最右边点【编辑】';
        var hint='（红横幅只有挂到钩子的页面才有。看不到横幅 = 你在另一个页面/标签）';
        if(d){
          var sb=d.querySelector('[class*=settingsBtn]');
          if(sb){ sb.classList.add('__dshHit'); step='② 点红框的【在部分时段投放】'; }
          var foot=[].slice.call(d.querySelectorAll('[class*=footerBtn]'))
            .filter(function(b){return (b.innerText||'').trim()==='确定';})[0];
          if(foot){ foot.classList.add('__dshHit'); step='④ 点红框底部【确定】保存'; }
          hint='抽屉已开：先在【定向设置】里把时段改成 9:00-17:00，再点红框确定。';
        }
        if(bar){
          bar.textContent='★ DSH 钩子已挂 ★  已记录 ' + n + ' 条请求\\n' + step + '\\n' + hint;
        }
      }catch(e){}
    }, 400);
    return 'armed';
  }catch(e){ return 'err:' + e.message; }
})()`;

const STATUS = `(function(){
  return JSON.stringify({
    href: location.href,
    hooked: !!window.__mtopTap,
    count: window.__mtopTap ? window.__mtopTap.length : -1,
    barVisible: !!document.getElementById('__dshBar'),
    title: document.title,
    apis: window.__mtopTap ? Array.from(new Set(window.__mtopTap.map(function(x){return x.api;}))) : []
  });
})()`;

(async () => {
  if (MODE === 'arm') {
    console.log('① 导航到擦亮后台');
    await ev(`(function(){location.href=${JSON.stringify(AD)};return 'n'})()`);
    await sleep(13000);
    console.log('② 挂钩子 + 画指引');
    console.log('   ' + JSON.stringify(unpack(await ev(ARM))));
    await sleep(800);
    const st = unpack(await ev(STATUS));
    console.log('③ 状态: ' + JSON.stringify(st, null, 1));
    console.log('\n✅ 已就绪。请老板看那个页面 —— 顶部应该有一条红色横幅，标签页标题带 ★HOOKED★。');
    return;
  }
  if (MODE === 'status') {
    const st = unpack(await ev(STATUS));
    console.log(JSON.stringify(st, null, 1));
    return;
  }
  // read
  const tap = unpack(await ev(`(function(){ return JSON.stringify(window.__mtopTap || null); })()`));
  if (!tap) { console.log('❌ 钩子不在（页面刷新过）。重跑 --arm。'); return; }
  const edits = tap.filter((x) => /(edit|update|modify|save|pause|startV2|create)/i.test(x.api || ''));
  console.log('记录总数 ' + tap.length + '   写类 ' + edits.length + ' 条');
  console.log('调过的接口: ' + JSON.stringify(Array.from(new Set(tap.map((x) => x.api)))));
  edits.forEach((x, i) => {
    console.log('\n════ [' + (i + 1) + '] ' + x.api + '  ' + x.type + '  ' + x.t);
    try {
      const d = x.data && x.data.requestJson ? JSON.parse(x.data.requestJson) : x.data;
      console.log(JSON.stringify(d, null, 1));
    } catch (e) { console.log(JSON.stringify(x.data).slice(0, 2000)); }
  });
})().catch((e) => console.log('❌ ' + (e && e.message || e)));
