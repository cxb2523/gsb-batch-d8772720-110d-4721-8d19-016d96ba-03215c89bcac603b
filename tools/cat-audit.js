/**
 * tools/cat-audit.js —— 只读：给在售清单逐条查真实分类，输出「代购 vs 演出票代拍」审计表
 * 用法: node tools/cat-audit.js
 */
const agent = require('../lib/agent');
const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LIST = `
  const API = 'mtop.idle.web.xyh.item.list';
  const BASE = { needGroupInfo: false, userId: ${JSON.stringify(USER_ID)}, pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true };
  const out = [];
  for (let p = 1; p <= 12; p++) {
    let r;
    try { r = await mtop.request({ api: API, v: '1.0', type: 'POST', data: Object.assign({}, BASE, { pageNumber: p }) }); }
    catch (e) { return JSON.stringify({ err: String((e && (e.ret || e.message)) || e) }); }
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ ret: r && r.ret });
    const cards = ((r.data || {}).cardList) || [];
    if (!cards.length) break;
    cards.forEach(function (c) {
      const cd = c.cardData || {};
      if (!cd.id || String(cd.itemStatus) !== '0') return;
      out.push({ id: String(cd.id), title: String(cd.title || '') });
    });
    if (cards.length < 20) break;
  }
  return JSON.stringify({ items: out });
`;

(async () => {
  const l = await agent.mtop(LIST, { timeout: 180000 });
  const list = (typeof l === 'string' ? JSON.parse(l) : l).items || [];
  console.log('在售: ' + list.length + ' 条\n');

  const rows = [];
  for (const it of list) {
    const CODE = `
      var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0', data: { itemId: ${JSON.stringify(it.id)} }, type: 'GET' });
      var d = (r && r.data) || {};
      var c = d.itemCatDTO || {};
      return JSON.stringify({ name: c.catName, ch: c.channelCatId });
    `;
    try {
      const d = await agent.mtop(CODE, { timeout: 120000 });
      const o = typeof d === 'string' ? JSON.parse(d) : (d.result || d);
      rows.push({ id: it.id, title: it.title, cat: (o.name || '?') + '/' + (o.ch || '?') });
    } catch (e) {
      rows.push({ id: it.id, title: it.title, cat: 'ERR ' + e.message });
    }
    await sleep(700);
  }

  const g = rows.filter(r => r.cat.indexOf('代购') >= 0);
  const y = rows.filter(r => r.cat.indexOf('演出票代拍') >= 0);
  const o = rows.filter(r => r.cat.indexOf('代购') < 0 && r.cat.indexOf('演出票代拍') < 0);

  console.log('=== 代购/' + '201456914  → 需要改成演出票代拍的（' + g.length + ' 条）===');
  g.forEach(r => console.log('  ' + r.id + '  ' + r.title.slice(0, 46)));
  console.log('\n=== 演出票代拍/202285710  → 已经对的（' + y.length + ' 条）===');
  y.forEach(r => console.log('  ' + r.id + '  ' + r.title.slice(0, 46)));
  if (o.length) {
    console.log('\n=== 其它（' + o.length + ' 条）===');
    o.forEach(r => console.log('  ' + r.id + '  ' + r.cat + '  ' + r.title.slice(0, 40)));
  }
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
