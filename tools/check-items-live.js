/**
 * tools/check-items-live.js — 只读：按 itemId 查商品在「在售可投池 / 本店全部宝贝」里的真实状态
 *
 * 为什么需要它：广告后台把「部分商品因状态异常无法擦亮」(statusDescCode=16) 的计划
 * 一直按在「已暂停」不让恢复，真正的原因在【商品】侧，不在计划侧。
 * check-listings.js 是按「场次标题」匹配的，这里按 itemId 精确查。
 *
 * 数据源两路（与 check-listings.js 完全一致）：
 *   A) mtop.taobao.idle.ad.item.searchV2 {tab:'all'} → 可投放池 = 在售、且能投广告
 *   B) mtop.idle.web.xyh.item.list                   → 本店全部宝贝（含已下架/已售出），带 itemStatus
 *
 * 用法:
 *   node tools/check-items-live.js                 # 查 ab-creative-plan-full.json 里的 8 条
 *   node tools/check-items-live.js 1088603154238   # 查指定 itemId
 */
const path = require('path');
const agent = require('../lib/agent');
const { ROOT, readJSON } = require('../lib/env');

const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
let IDS = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!IDS.length) {
  const p = readJSON(path.join(ROOT, 'ab-creative-plan-full.json'));
  IDS = ((p && p.assign) || []).map((a) => String(a.itemId));
}
if (!IDS.length) { console.log('用法: node tools/check-items-live.js [itemId...]'); process.exit(2); }

const XYH_BASE = {
  needGroupInfo: false, userId: USER_ID,
  pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true,
};

const POOL = `
  const r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV2', v:'1.0', type:'POST',
    data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });
  if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err:(r && r.ret) || null });
  const d = (r.data || {}).result || r.data || {};
  return JSON.stringify((d.itemList || []).map(i => ({ itemId:String(i.itemId), title:String(i.title||''),
    supportAd:i.supportAd, price:i.price, saleCnt:i.saleCnt, tags:(i.tags||[]).join(',') })));`;

const ALL = `
  const BASE = ${JSON.stringify(XYH_BASE)};
  const seen = {}, list = [];
  for (let p = 1; p <= 15; p++) {
    let r;
    try { r = await mtop.request({ api:'mtop.idle.web.xyh.item.list', v:'1.0', type:'POST',
      data: Object.assign({}, BASE, { pageNumber: p }) }); } catch (e) { break; }
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) break;
    const cards = (r.data && r.data.cardList) || [];
    if (!cards.length) break;
    let added = 0;
    cards.forEach(c => { const cd = c.cardData || {}; const id = String(cd.id || '');
      if (!id || seen[id]) return; seen[id] = 1; added++;
      list.push({ itemId:id, title:String(cd.title||''), status:cd.itemStatus, price:cd.price, groupName:cd.groupName }); });
    if (!added) break;
  }
  return JSON.stringify(list);`;

(async () => {
  await agent.ready();

  // agent.mtop() 有时回字符串、有时回已解析的对象（见 check-listings.js 的同款处理），两种都得认
  const unpack = (r) => {
    if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { err: 'JSON 解析失败: ' + r.slice(0, 160) }; } }
    return r;
  };
  let pool, all;
  try { pool = unpack(await agent.mtop(POOL)); } catch (e) { pool = { err: e.message }; }
  try { all = unpack(await agent.mtop(ALL, { timeout: 180000 })); } catch (e) { all = { err: e.message }; }

  const poolArr = Array.isArray(pool) ? pool : [];
  const allArr = Array.isArray(all) ? all : [];
  console.log('在售可投池 ' + (Array.isArray(pool) ? poolArr.length + ' 条' : '❌ ' + JSON.stringify(pool).slice(0, 160)));
  console.log('本店全部宝贝 ' + (Array.isArray(all) ? allArr.length + ' 条' : '❌ ' + JSON.stringify(all).slice(0, 160)));
  console.log('');
  console.log('itemId          在售池  全部宝贝   itemStatus   supportAd  saleCnt  标题');
  console.log('-'.repeat(120));
  IDS.forEach((id) => {
    const p = poolArr.find((x) => x.itemId === id);
    const a = allArr.find((x) => x.itemId === id);
    console.log(id.padEnd(16) +
      (p ? '✅在售 ' : '❌不在 ').padEnd(8) +
      (a ? '✅有   ' : '❌没有 ').padEnd(10) +
      String(a ? a.status : '—').padEnd(13) +
      String(p ? p.supportAd : '—').padEnd(11) +
      String(p ? p.saleCnt : (a ? a.saleCnt : '—')).padEnd(9) +
      String((p || a || {}).title || '').slice(0, 40));
  });
  console.log('');
  const bad = IDS.filter((id) => !poolArr.some((x) => x.itemId === id));
  console.log(bad.length ? '⚠️ ' + bad.length + ' 条不在在售可投池：' + bad.join(', ') + '  ← 这就是「状态异常无法擦亮」的来源'
    : '✅ 全部在在售可投池里');
})().catch((e) => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
