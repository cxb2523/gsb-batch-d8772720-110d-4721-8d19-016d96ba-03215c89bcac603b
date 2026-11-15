/**
 * tools/whoami.js —— 只读：当前 8093 页面上登录的是哪个闲鱼账号（店铺名 + userId）
 * 用法: node tools/whoami.js
 */
const agent = require('../lib/agent');

(async () => {
  const w = await agent.whereAmI();
  console.log('页面: ' + JSON.stringify(w));

  const t = String(await agent.evalOnStore('document.body.innerText', { timeout: 60000 }) || '');
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  console.log('\n页面前 12 行：');
  lines.slice(0, 12).forEach((l, i) => console.log('  ' + i + ': ' + l));

  // 闲鱼页面里常见的登录用户 id / 昵称线索
  const code = `
    var out = {};
    try {
      var m = document.cookie.match(/(?:^|; )unb=([^;]+)/);
      out.unb = m ? decodeURIComponent(m[1]) : null;
    } catch (e) {}
    try {
      var keys = Object.keys(localStorage).filter(function(k){ return /user|nick|seller/i.test(k); });
      out.lsKeys = keys.slice(0, 8);
      out.lsVals = {};
      keys.slice(0, 4).forEach(function(k){ out.lsVals[k] = String(localStorage.getItem(k)).slice(0, 120); });
    } catch (e) {}
    return JSON.stringify(out);
  `;
  const d = await agent.evalOnStore(code, { timeout: 60000 });
  console.log('\n登录线索: ' + (typeof d === 'string' ? d : JSON.stringify(d)));
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
