/**
 * tools/list-offshelf.js —— 只读：列出已下架商品，并交叉 xianyu-商品索引.csv 的曝光/成交
 * 用途：挑一条"已死但有权重"的老链接做重锚
 * 用法: node tools/list-offshelf.js
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');

const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
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
      if (!cd.id) return;
      out.push({ id: String(cd.id), title: String(cd.title || ''), status: String(cd.itemStatus),
                 price: String(((cd.priceInfo || {}).price) || '') });
    });
    if (cards.length < 20) break;
  }
  return JSON.stringify({ items: out });
`;

// 读 CSV：序号,itemId,状态,标题,价格,想要,曝光,成交,支付额,广告元
function loadIndex() {
  const f = path.join(__dirname, '..', 'xianyu-商品索引.csv');
  if (!fs.existsSync(f)) return {};
  const txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  const map = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
    if (!m) continue;
    map[m[2]] = { want: m[6], show: m[7], deal: m[8], pay: m[9] };
  }
  return map;
}

(async () => {
  const o = await agent.mtop(LIST, { timeout: 180000 });
  const v = typeof o === 'string' ? JSON.parse(o) : (o.result || o);
  const items = (v.items || []).filter(x => x.status === '1');
  const idx = loadIndex();

  console.log('已下架: ' + items.length + ' 条\n');
  const rows = items.map(x => {
    const d = idx[x.id] || {};
    return {
      id: x.id, price: x.price, title: x.title,
      show: d.show || '', deal: d.deal || '', pay: d.pay || ''
    };
  });
  // 有成交的排前面（那才是"以前好的老链接"），其次按曝光
  rows.sort((a, b) => (Number(b.pay) || 0) - (Number(a.pay) || 0) || (Number(b.show) || 0) - (Number(a.show) || 0));

  console.log('id'.padEnd(15) + '价格'.padEnd(7) + '曝光'.padEnd(8) + '成交'.padEnd(6) + '成交额'.padEnd(10) + '标题');
  rows.forEach(r => {
    console.log(String(r.id).padEnd(15) + String(r.price).padEnd(7) + String(r.show).padEnd(8)
      + String(r.deal).padEnd(6) + String(r.pay).padEnd(10) + r.title.slice(0, 40));
  });

  fs.writeFileSync(path.join(__dirname, '..', 'offshelf-now.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log('\n已存 offshelf-now.json');
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
