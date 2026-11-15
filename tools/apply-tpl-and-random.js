/**
 * tools/apply-tpl-and-random.js — 把「好易美代拍」的 4 条店铺模板做两件事
 *
 *   ① titlePattern 里写死的「演唱会」→ {活动类型}
 *      （{活动类型} 有兜底：publish.js:224 `var ev = eventType || '演唱会'`，取不到就回落，安全）
 *   ② 文案 A/B 改成 1:1，配合 titleMode='random' 做随机
 *      现状：模板1/2/4 用 A 版(249字)、模板3 用 B 版(190字) → random 时 A:B=3:1
 *      改成：模板1/2 用 A、模板3/4 用 B → 1:1
 *   ③ 打开随机：kun_store_cfg_好易美代拍.titleMode = 'random'
 *
 * 写法要点：只改 titlePattern / descPattern 两个字段，其余字段原样保留，
 *          不重建对象 —— 避免丢掉 id 之外的任何配置（shipMode/commitment/specs...）。
 *          A/B 文案直接取现有模板里的值，不手抄，避免抄错。
 *
 * 用法: node tools/apply-tpl-and-random.js          # 预演，只打印 before/after
 *       node tools/apply-tpl-and-random.js --apply  # 真写
 */
const http = require('http');
const { SVC, STORE } = require('../lib/env');

const KEY = SVC.apiKey;
const APPLY = process.argv.includes('--apply');
const TPL_KEY = 'kun_tpl_' + STORE;

const code = `
(function(){
try{
  window.kunPublish.setStore(${JSON.stringify(STORE)});
  var KEY = ${JSON.stringify(TPL_KEY)};
  var raw = localStorage.getItem(KEY);
  var tpls = JSON.parse(raw || '[]');
  if (!tpls.length) return JSON.stringify({error:'店铺模板为空，未动任何东西'});
  var byId = {}; tpls.forEach(function(t){ byId[t.id] = t; });

  var A = (byId[1]||{}).descPattern || '';
  var B = (byId[3]||{}).descPattern || '';
  if (!A || !B) return JSON.stringify({error:'取不到 A/B 文案基准（需要 id=1 和 id=3 存在）'});

  var before = tpls.map(function(t){
    return { id:t.id, title:t.titlePattern, descLen:(t.descPattern||''),
             descKind:(t.descPattern===A?'A':(t.descPattern===B?'B':'?')) };
  });
  before.forEach(function(x){ x.descLen = (byId[x.id].descPattern||'').length; });

  // ① 演唱会 -> {活动类型}
  var hits = 0;
  tpls.forEach(function(t){
    var s = String(t.titlePattern||'');
    var n = (s.match(/演唱会/g)||[]).length;
    hits += n;
    t.titlePattern = s.replace(/演唱会/g, '{活动类型}');
  });

  // ② A/B 1:1（1/2=A，3/4=B）
  tpls.forEach(function(t){
    if (t.id === 1 || t.id === 2) t.descPattern = A;
    if (t.id === 3 || t.id === 4) t.descPattern = B;
  });

  var after = tpls.map(function(t){
    return { id:t.id, title:t.titlePattern, descKind:(t.descPattern===A?'A':'B'),
             descLen:(t.descPattern||'').length };
  });

  var cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('kun_store_cfg_${STORE}') || '{}'); } catch(e){}
  var prevMode = cfg.titleMode || null;

  var wrote = false;
  if (${APPLY}) {
    window.kunPublish.saveCustomTemplates(tpls);   // 写 localStorage + Native Host 写盘
    window.kunPublish.reloadStoreTemplates();
    cfg.titleMode = 'random';
    window.kunPublish.saveStoreConfig(cfg);
    wrote = true;
  }

  // 回读验证
  var back = JSON.parse(localStorage.getItem(KEY) || '[]');
  var cfgBack = {}; try { cfgBack = JSON.parse(localStorage.getItem('kun_store_cfg_${STORE}')||'{}'); } catch(e){}
  return JSON.stringify({
    wrote: wrote,
    replacedHits: hits,
    before: before,
    after: after,
    verifiedTitles: back.map(function(t){ return t.id + ': ' + t.titlePattern; }),
    verifiedDescKinds: back.map(function(t){ return t.id + ':' + (t.descPattern===A?'A':'B') + '(' + (t.descPattern||'').length + ')'; }),
    liveCount: (window.kunPublish.CONCERT_TEMPLATES||[]).length,
    liveTitles: (window.kunPublish.CONCERT_TEMPLATES||[]).map(function(t){ return t.id + ': ' + t.titlePattern; }),
    prevTitleMode: prevMode,
    nowTitleMode: cfgBack.titleMode || null
  });
}catch(e){ return JSON.stringify({error:e.message}); }
})()
`;

const payload = JSON.stringify({ store: STORE, code });
const req = http.request({
  host: '127.0.0.1', port: 8093, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY },
  timeout: 120000,
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    let j; try { j = JSON.parse(b); } catch (e) { console.log('RAW:', b.slice(0, 800)); return; }
    let d = j.result;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
    if (!d || typeof d !== 'object') { console.log(JSON.stringify(j).slice(0, 900)); return; }
    if (d.error) { console.log('❌ ' + d.error); process.exitCode = 1; return; }

    console.log(d.wrote ? '模式：真写 (--apply)' : '模式：预演（没写任何东西）');
    console.log('「演唱会」命中并替换次数：' + d.replacedHits);
    console.log('');
    console.log('── 标题 before → after ──');
    (d.before || []).forEach((b, i) => {
      const a = (d.after || [])[i] || {};
      console.log('  id=' + b.id);
      console.log('    before: ' + b.title);
      console.log('    after : ' + a.title);
      console.log('    文案  : ' + b.descKind + '(' + b.descLen + ') → ' + a.descKind + '(' + a.descLen + ')');
    });
    console.log('');
    console.log('── 回读 localStorage ──');
    (d.verifiedTitles || []).forEach((s) => console.log('  ' + s));
    console.log('  文案: ' + (d.verifiedDescKinds || []).join('  '));
    console.log('');
    console.log('── 回读 window.kunPublish.CONCERT_TEMPLATES ──');
    console.log('  条数: ' + d.liveCount);
    (d.liveTitles || []).forEach((s) => console.log('  ' + s));
    console.log('');
    console.log('── 标题模式 ──');
    console.log('  before: ' + JSON.stringify(d.prevTitleMode) + '   after: ' + JSON.stringify(d.nowTitleMode));
  });
});
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => console.log('ERR', e.message));
req.write(payload);
req.end();
