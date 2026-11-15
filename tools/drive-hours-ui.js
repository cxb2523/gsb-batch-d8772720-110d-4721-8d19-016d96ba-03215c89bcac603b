/**
 * tools/drive-hours-ui.js — 按【文本】驱动擦亮后台的投放时段 UI（不看标签类型）
 *
 * 上一版失败原因：抽屉里的「确定/取消」不是 <button> 或 [role=button]，
 *   而是普通 div/span 挂 onClick —— 按标签选必然 0 个。
 *
 * 本版做法：
 *   ① 按文本找元素，取【包围盒面积最小】的那个（最紧的那层包裹，避开匹配到祖先）
 *   ② 点击时同时派发 pointerdown/mousedown/mouseup/click，并且对 closest 可点祖先也派发一次
 *   ③ 分步执行、每步都 dump 诊断；--step 控制走到哪一步，避免一次跑到底出错难查
 *
 * 用法:
 *   node tools/drive-hours-ui.js --step=probe     # 只看抽屉里跟时段相关的元素（不改）
 *   node tools/drive-hours-ui.js --step=open      # 点开「已选择时段」出格子
 *   node tools/drive-hours-ui.js --step=cells     # 出格子后 dump 24 个格子的标签/位置
 */
const http = require('http');
const { STORE, SVC } = require('../lib/env');
const KEY = SVC.apiKey;
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';
const STEP = (process.argv.find((x) => x.startsWith('--step=')) || '--step=probe').split('=')[1];

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

// 页面侧工具：按文本找最紧的包裹元素 + 真点击
const HELPERS = `
window.__k = {
  deepest: function(txt, root){
    root = root || document;
    var all = [].slice.call(root.querySelectorAll('*'));
    var hits = all.filter(function(e){
      var t = (e.innerText || '').trim();
      if (!t || t.length > 60 || t.indexOf(txt) < 0) return false;
      var r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      // 排除包含大量子节点的容器
      return e.querySelectorAll('*').length <= 8;
    });
    hits.sort(function(a,b){
      var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (ra.width*ra.height) - (rb.width*rb.height);
    });
    return hits;
  },
  fire: function(el){
    var t = ['pointerdown','mousedown','pointerup','mouseup','click'];
    for (var i=0;i<t.length;i++){
      try { el.dispatchEvent(new MouseEvent(t[i], {bubbles:true, cancelable:true, view:window, button:0})); } catch(e){}
    }
  },
  clickText: function(txt, root){
    var hs = window.__k.deepest(txt, root);
    if (!hs.length) return {err:'找不到文本: ' + txt};
    var el = hs[0];
    window.__k.fire(el);
    var r = el.getBoundingClientRect();
    return { ok:true, tag:el.tagName, cls:String(el.className).slice(0,70), text:(el.innerText||'').trim().slice(0,60),
             x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height), 候选数:hs.length };
  },
  drawer: function(){
    var ms = [].slice.call(document.querySelectorAll('.ant-drawer-content,.ant-modal-content,.ant-drawer-body'));
    var vis = ms.filter(function(m){var r=m.getBoundingClientRect();return r.width>100&&r.height>80;});
    return vis.length ? vis[0] : null;
  },
  info: function(el){
    if(!el) return null;
    var r = el.getBoundingClientRect();
    return { tag:el.tagName, cls:String(el.className).slice(0,70), text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80),
             x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) };
  }
};
`;

const OPEN_EDIT = `(function(){
  ${HELPERS}
  var hs = window.__k.deepest('编辑');
  if (hs.length < 2) return JSON.stringify({err:'「编辑」元素太少: ' + hs.length});
  // 列表里每行一个「编辑」，选 y 坐标最大的几个之一不可靠；直接按出现顺序选第 4 个对应第 4 行
  // 更稳：找「更多」同级的兄弟。这里简单点：取 y 最小但不为 0 的那个（第一行）
  var sorted = hs.slice().sort(function(a,b){ return a.getBoundingClientRect().y - b.getBoundingClientRect().y; });
  var el = sorted[0];
  window.__k.fire(el);
  return JSON.stringify({ ok:true, 候选数:hs.length, 点了:window.__k.info(el) });
})()`;

const PROBE = `(function(){
  ${HELPERS}
  var d = window.__k.drawer();
  if (!d) return JSON.stringify({err:'抽屉没开'});
  var out = { drawerTextLen: (d.innerText||'').length };
  ['定向设置','已选择时段','部分时段','全部时段','创意优化','高级设置','确定','取消'].forEach(function(t){
    var hs = window.__k.deepest(t, d);
    out[t] = hs.slice(0,3).map(function(e){ return window.__k.info(e); });
  });
  return JSON.stringify(out);
})()`;

const OPEN_PICKER = `(function(){
  ${HELPERS}
  var d = window.__k.drawer();
  if (!d) return JSON.stringify({err:'抽屉没开'});
  // 优先用 class 找：settingsBtn 这个 class 名在 ad-driver.js:319 里也用了（前人验证过的入口）
  var sb = d.querySelector('[class*=settingsBtn]');
  if (!sb) {
    // 退路：按文本「在部分时段投放」找最紧包裹
    var hs = window.__k.deepest('在部分时段投放', d);
    sb = hs.length ? hs[0] : null;
  }
  if (!sb) return JSON.stringify({err:'找不到 settingsBtn，也找不到「在部分时段投放」'});
  try { sb.scrollIntoView({block:'center'}); } catch(e){}
  window.__k.fire(sb);
  window.__k.fire(sb.parentElement);
  return JSON.stringify(Object.assign({ ok:true, via:'settingsBtn' }, window.__k.info(sb)));
})()`;

const DUMP_CELLS = `(function(){
  ${HELPERS}
  var d = window.__k.drawer();
  if (!d) return JSON.stringify({err:'抽屉没开'});
  var out = {};
  // 找「投放时段」所在的弹层（可能是 popover）
  var pops = [].slice.call(document.querySelectorAll('.ant-popover,.ant-dropdown,[class*=popover],[class*=Popover]'))
    .filter(function(p){ var r=p.getBoundingClientRect(); return r.width>50&&r.height>30; });
  out.popoverCount = pops.length;
  var scope = pops.length ? pops[pops.length-1] : d;
  out.scopeText = (scope.innerText||'').replace(/\\s+/g,' ').slice(0,400);
  // 找数字格子：文本是 0..23 的纯数字元素
  var nums = [].slice.call(scope.querySelectorAll('*')).filter(function(e){
    var t=(e.innerText||'').trim();
    if(!/^\\d{1,2}$/.test(t)) return false;
    var r=e.getBoundingClientRect();
    return r.width>4 && r.height>4 && r.width<120 && r.height<80 && e.querySelectorAll('*').length<=2;
  });
  out.numCount = nums.length;
  out.nums = nums.map(function(e){ return Object.assign(window.__k.info(e), { v:(e.innerText||'').trim() }); }).slice(0,30);
  return JSON.stringify(out);
})()`;

(async () => {
  await ev(`(function(){location.href=${JSON.stringify(AD)};return 'n'})()`);
  await sleep(13000);

  if (STEP === 'probe') {
    console.log('① 点开第 1 行「编辑」');
    console.log('   ' + JSON.stringify(unpack(await ev(OPEN_EDIT))));
    await sleep(4000);
    console.log('\n② 抽屉里跟时段相关的元素（按文本找，取最紧包裹）');
    const p = unpack(await ev(PROBE));
    if (!p || p.err) { console.log('   ❌ ' + JSON.stringify(p)); return; }
    console.log('   抽屉文本长度 ' + p.drawerTextLen);
    Object.keys(p).forEach((k) => {
      if (k === 'drawerTextLen') return;
      console.log('   [' + k + ']');
      (p[k] || []).forEach((x) => console.log('      ' + JSON.stringify(x)));
      if (!(p[k] || []).length) console.log('      (无)');
    });
    return;
  }

  if (STEP === 'open') {
    console.log('① 先点开第 1 行「编辑」');
    console.log('   ' + JSON.stringify(unpack(await ev(OPEN_EDIT))));
    await sleep(4500);
    console.log('\n② 点 settingsBtn 开时段格子');
    console.log('   ' + JSON.stringify(unpack(await ev(OPEN_PICKER))));
    await sleep(2500);
    console.log('\n③ dump 格子');
    const c = unpack(await ev(DUMP_CELLS));
    console.log(JSON.stringify(c, null, 1));
    return;
  }

  if (STEP === 'cells') {
    const c = unpack(await ev(DUMP_CELLS));
    console.log(JSON.stringify(c, null, 1));
    return;
  }
})().catch((e) => console.log('❌ ' + (e && e.message || e)));
