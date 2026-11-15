/**
 * tools/verify-published.js —— 发布后延迟复核：确认平台【最终放行】了没有
 *
 * 为什么需要它（2026-10-18 真实事故）：
 *   publish-one.js 的回读校验（editdetail）只能证明「字段落对了」，
 *   证明不了「平台审核通过、真的在售」。
 *   实例：1094067356501 —— 发布 SUCCESS、回读 6 项全绿、台账记了 ok，
 *        但几分钟后平台把它的 itemStatus 打成 -9（已删除/审核未过），
 *        在售池里查不到它，而当时没有任何机制会告诉我们。
 *
 * 判据（与 tools/list-onsale.js 完全一致，踩过的坑都在这）：
 *   itemStatus  0 = 在售          ✅
 *   itemStatus  1 = 已下架        ⚪ 不算审核失败，但要说出来
 *   itemStatus -9 = 已删除/审核未过 ❌  ← 这是要抓的
 *   其它           = 未知          ⚠️
 *   ⚠️ 别再写 `st===0 ? 在售 : 已下架` —— -9 会被误标成"已下架"。
 *
 * 用法:
 *   node tools/verify-published.js <itemId...>
 *   node tools/verify-published.js <itemId...> --wait=600      # 发布后等 10 分钟再查
 *   node tools/verify-published.js --ledger-today               # 查台账里今天发布的
 *   node tools/verify-published.js --ledger-today --wait=600
 *
 * 退出码: 0 全部在售 / 1 有问题要处理 / 2 用法或拉取失败
 */
const agent = require('../lib/agent');
const { ROOT, readJSON } = require('../lib/env');
const path = require('path');

const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
const argv = process.argv.slice(2);
const argOf = (k) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : ''; };
const WAIT = Number(argOf('wait') || 0);
const LEDGER_TODAY = argv.includes('--ledger-today');

let IDS = argv.filter((a) => /^\d{8,}$/.test(a));

if (LEDGER_TODAY) {
  const led = readJSON(path.join(ROOT, '上架台账.json'), []) || [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = led.filter((r) => String(r.时间 || '').startsWith(today) && r.itemId && !r.状态);
  const seen = new Set();
  IDS = [];
  rows.forEach((r) => { const id = String(r.itemId); if (!seen.has(id)) { seen.add(id); IDS.push(id); } });
  console.log('台账里今天发布且在册的链接: ' + IDS.length + ' 条');
}

if (!IDS.length) {
  console.log('用法: node tools/verify-published.js <itemId...> [--wait=600] [--ledger-today]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function verdict(st) {
  if (st === 0) return { ok: true, tag: '🟢 在售', note: '' };
  if (st === 1) return { ok: true, tag: '⚪ 已下架', note: '不是审核问题（主动下架？）' };
  if (st === -9) return { ok: false, tag: '❌ -9 已删除/审核未过', note: '要人工看驳回理由' };
  if (st === null) return { ok: false, tag: '❔ 无 itemStatus', note: '接口没给状态' };
  return { ok: false, tag: '❔ 状态 ' + st, note: '未知状态码' };
}

// ⚠️ agent.mtop 已经套好 `(async()=>{const mtop=window.lib.mtop; <这里> })()`，
//    下面【只写函数体】、结尾 return；别再套 IIFE，也别再声明 mtop（会重复声明语法错）。
const CODE = `
  const API = 'mtop.idle.web.xyh.item.list';
  const BASE = { needGroupInfo: false, userId: ${JSON.stringify(USER_ID)}, pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true };
  const out = [];
  let pages = 0;
  for (let p = 1; p <= 12; p++) {
    let r;
    try { r = await mtop.request({ api: API, v: '1.0', type: 'POST', data: Object.assign({}, BASE, { pageNumber: p }) }); }
    catch (e) { return JSON.stringify({ err: String((e && (e.ret || e.message)) || e), got: out.length }); }
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) {
      return JSON.stringify({ ret: (r && r.ret) || null, got: out.length });
    }
    const cards = ((r.data || {}).cardList) || [];
    if (!cards.length) break;
    pages++;
    cards.forEach(function(c){
      const cd = c.cardData || {};
      if (!cd.id) return;
      out.push({ id: String(cd.id), title: String(cd.title || '').slice(0, 44), status: cd.itemStatus });
    });
    if (cards.length < 20) break;
  }
  return JSON.stringify({ total: out.length, pages: pages, items: out });
`;

(async () => {
  if (WAIT > 0) {
    console.log('等待 ' + WAIT + ' 秒后复核（给平台审核留时间）...');
    await sleep(WAIT * 1000);
  }

  const r = await agent.mtop(CODE, { store: process.env.XY_STORE || '好易美代拍', timeout: 180000 });
  const d = typeof r === 'string' ? JSON.parse(r) : r;

  if (!d || d.err || d.ret) {
    console.log('❌ 拉商品列表失败: ' + JSON.stringify(d || r).slice(0, 300));
    console.log('   （页面可能不在 goofish 域。可先 node tools/ensure-agent.js）');
    process.exit(2);
  }

  const found = {};
  (d.items || []).forEach((x) => { found[x.id] = x; });

  console.log('');
  console.log('── 发布后复核（' + new Date().toLocaleString('zh-CN') + '，全店 ' + d.total + ' 条）──');
  let bad = 0;
  for (const id of IDS) {
    const x = found[id];
    if (!x) {
      console.log('   ❔ ' + id + '  列表里找不到（可能已彻底删除，或不在「综合」分组）');
      bad++;
      continue;
    }
    const v = verdict(x.status);
    if (!v.ok) bad++;
    console.log('   ' + v.tag + '  ' + id + '  ' + x.title + (v.note ? '   （' + v.note + '）' : ''));
  }

  console.log('');
  console.log('   在售 ' + (IDS.length - bad) + ' / 共 ' + IDS.length + (bad ? '   ❌ 有 ' + bad + ' 条要处理' : '   ✅ 全部在售'));

  if (bad) {
    console.log('');
    console.log('   下一步：');
    console.log('     · status=-9 多是平台审核未过 —— 去闲鱼「我卖出的 → 发布中」看驳回理由');
    console.log('     · 常见原因是标题/内容重复（同场次连发两条，标题只差前缀）');
    console.log('     · 处理：换文案模板（模4/模5）重发，别再发同样结构');
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => require('../lib/crash').crash(e, 2));
