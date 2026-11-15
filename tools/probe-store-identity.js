/**
 * tools/probe-store-identity.js — 只读：查某个店铺上下文【到底是哪个闲鱼账号】
 *
 * 为什么需要它（2026-10-07）：
 *   新店「好易美票务Hope」从没登录过，但 `mtop.taobao.idle.ad.campaign.search` 直接回了
 *   `SUCCESS::调用成功` —— 光看 ret 判不出登录态。真正的判据是**返回的数据是谁的**：
 *   如果这个"新店"上下文里躺着好易美代拍的 14 个计划 / 38 个在售商品，那就是假登录
 *   （或者上下文没隔离），不是它自己的。
 *
 * 用法:
 *   node tools/probe-store-identity.js "好易美票务Hope"
 *   node tools/probe-store-identity.js                 # 默认查所有已启动的店铺
 *
 * ⚠️ 直连 HTTP，不用 lib/agent 的 evalOnStore —— 后者会触发 ready() 把店铺切走。
 */
const { post } = require('../lib/http');
const agent = require('../lib/agent');

const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';

const CODE = `(async function(){ try{
  var out = { href: location.href };
  try { out.ua_nav = (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,100); } catch(e){}
  try {
    var r = await window.lib.mtop.request({api:'mtop.taobao.idle.ad.campaign.search',v:'1.0',type:'GET',
      data:{requestJson:JSON.stringify({pageNum:1,pageSize:100,campaignStatus:[],statusGroup:[]})}});
    var list = ((r.data||{}).result)||[];
    out.计划ret = String((r.ret||[])[0]||'');
    out.计划数 = list.length;
    out.计划前3 = list.slice(0,3).map(function(c){ return String(c.campaignId)+' '+String(c.title||'').slice(0,24); });
  } catch(e) { out.计划错误 = String((e&&e.message)||e); }
  try {
    var r2 = await window.lib.mtop.request({api:'mtop.taobao.idle.ad.item.searchV2',v:'1.0',type:'POST',
      data:{requestJson:JSON.stringify({pageNum:1,pageSize:200,tab:'all',needTabs:true})}});
    var d = (r2.data||{}).result || r2.data || {};
    var items = d.itemList || [];
    out.商品ret = String((r2.ret||[])[0]||'');
    out.在售数 = items.length;
    out.商品前3 = items.slice(0,3).map(function(i){ return String(i.itemId)+' '+String(i.title||'').slice(0,22); });
    out.全部商品 = items.map(function(i){ return String(i.itemId)+'  '+String(i.title||''); });
  } catch(e) { out.商品错误 = String((e&&e.message)||e); }
  return JSON.stringify(out);
}catch(e){ return JSON.stringify({fatal:String((e&&e.message)||e)}); } })()`;

(async () => {
  const argv = process.argv.slice(2);
  const grepArg = (argv.find((a) => a.startsWith('--grep=')) || '').split('=')[1] || '';
  const want = argv.filter((a) => a && !a.startsWith('--'));
  const names = want.length ? want : (await agent.accounts()).map((a) => a.name);

  for (const name of names) {
    console.log('\n════════ ' + name + ' ════════');
    try {
      // 切过去（switch 命中不到会 refreshAccounts，所以新店也能切）
      const sw = await post('/api/agent/switch', { storeName: name }, { timeout: 180000 });
      if (!sw || sw.ok !== true) { console.log('  ❌ 切不过去：' + JSON.stringify(sw).slice(0, 150)); continue; }
      await post('/api/agent/eval-on-store', { store: name, code: 'location.href=' + JSON.stringify(AD) + ';"n"' }, { timeout: 60000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 16000));
      const r = await post('/api/agent/eval-on-store', { store: name, code: CODE }, { timeout: 120000 });
      const d = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
      console.log('  计划: ret=' + (d.计划ret || d.计划错误) + '  数量=' + d.计划数);
      (d.计划前3 || []).forEach((x) => console.log('     ' + x));
      console.log('  在售: ret=' + (d.商品ret || d.商品错误) + '  数量=' + d.在售数);
      (d.商品前3 || []).forEach((x) => console.log('     ' + x));
      if (grepArg) {
        // 全量标题过滤：用来查「这个店有没有已经上过同一场次」，避免重复上架被判重
        const all = (d.全部商品 || []).filter((t) => String(t).indexOf(grepArg) >= 0);
        console.log('  🔎 在售里含「' + grepArg + '」的: ' + all.length + ' 条');
        all.forEach((t) => console.log('     ' + t));
      }
      console.log('  页面: ' + d.href);
    } catch (e) { console.log('  ❌ ' + e.message); }
  }
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
