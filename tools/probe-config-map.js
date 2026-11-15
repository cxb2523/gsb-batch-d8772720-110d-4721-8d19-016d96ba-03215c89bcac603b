/**
 * tools/probe-config-map.js — 只读：把「一个店铺的效果由哪些配置决定」全量列出来
 * 目的：为「100 店快速配置」方案提供事实依据，而不是凭印象设计。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { STORE, SVC, PATHS } = require('../lib/env');

const code = `(function(){
  try{
    var out = { href: location.href, kunKeys: [], storeCfg: {}, tplStore: {}, other: {} };
    for (var i=0;i<localStorage.length;i++){
      var k = localStorage.key(i);
      if (k && k.indexOf('kun_') === 0) out.kunKeys.push(k);
    }
    out.kunKeys.sort();
    function g(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
    function p(k){ try { return JSON.parse(g(k)); } catch(e){ return null; } }

    out.stores = p('kun_stores');
    out.curStore = g('kun_cur_store');
    out.storeProjects = p('kun_store_projects');
    out.projectConfigs = p('kun_project_configs');

    // 每个店铺的配置 + 模板覆盖（关键：看有几套、各有什么字段）
    out.perStore = {};
    (out.stores || []).forEach(function(s){
      var cfg = p('kun_store_cfg_' + s);
      var tpl = p('kun_tpl_' + s);
      out.perStore[s] = {
        有storeCfg: !!cfg,
        storeCfg字段: cfg ? Object.keys(cfg) : [],
        storeCfg: cfg,
        有店铺模板覆盖: !!tpl,
        模板条数: tpl ? tpl.length : 0,
      };
    });
    out.globalTpl = (p('kun_tpl_global') || []).length;
    out.replyRules = out.kunKeys.filter(function(k){return k.indexOf('kun_reply_rules')===0;});
    return JSON.stringify(out);
  }catch(e){ return JSON.stringify({error:e.message}); }
})()`;

function ev(c) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ store: STORE, code: c });
    const req = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': SVC.apiKey } },
      (res) => { let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 200) }); } }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message })); req.write(payload); req.end();
  });
}

(async () => {
  const r = await ev(code);
  let d = r.result; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
  if (!d || d.error) { console.log('❌ ' + JSON.stringify(d || r).slice(0, 300)); process.exit(1); }

  console.log('══ 浏览器 localStorage 里的 kun_* 键（' + d.kunKeys.length + ' 个）══');
  d.kunKeys.forEach((k) => console.log('   ' + k));

  console.log('\n══ 店铺列表 ══');
  console.log('   kun_stores      = ' + JSON.stringify(d.stores));
  console.log('   kun_cur_store   = ' + JSON.stringify(d.curStore));
  console.log('   kun_store_projects = ' + JSON.stringify(d.storeProjects));
  console.log('   kun_project_configs = ' + JSON.stringify(d.projectConfigs));
  console.log('   kun_tpl_global  = ' + d.globalTpl + ' 条');
  console.log('   自动回复规则键  = ' + JSON.stringify(d.replyRules));

  console.log('\n══ 每个店铺的配置（决定效果的核心）══');
  Object.keys(d.perStore || {}).forEach((s) => {
    const x = d.perStore[s];
    console.log('   ── ' + s);
    console.log('      kun_store_cfg_' + s + ' : ' + (x.有storeCfg ? '有，字段=' + JSON.stringify(x.storeCfg字段) : '【没有】→ 全走默认'));
    console.log('      kun_tpl_' + s + '        : ' + (x.有店铺模板覆盖 ? '有，' + x.模板条数 + ' 条' : '【没有】→ 用全局/默认'));
    if (x.storeCfg) console.log('        内容: ' + JSON.stringify(x.storeCfg));
  });

  console.log('\n══ 磁盘侧（System A 读的）══');
  const tpl = path.join(os.homedir(), '.xianyu-templates.json');
  console.log('   ~/.xianyu-templates.json : ' + (fs.existsSync(tpl) ? JSON.parse(fs.readFileSync(tpl, 'utf8')).templates.length + ' 条（全局唯一，不分店铺）' : '不存在'));
  const imgRoot = PATHS.images || '(未配置 paths.images)';
  console.log('   图片根: ' + imgRoot);
  if (fs.existsSync(imgRoot)) {
    fs.readdirSync(imgRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).forEach((e) => {
      const sub = path.join(imgRoot, e.name);
      let n = 0; try { n = fs.readdirSync(sub).length; } catch (err) {}
      console.log('      ' + e.name + '/  (' + n + ' 项)');
    });
  }
})();
