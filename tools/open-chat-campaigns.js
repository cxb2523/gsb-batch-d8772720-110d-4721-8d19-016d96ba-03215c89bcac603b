/**
 * tools/open-chat-campaigns.js — 按「同城同明星」分组开【咨询量】推广计划
 *
 * 老板的口径（2026-09-29）：
 *   出价 = 闲鱼系统预估出价 × 140%      ← 系统建议价来自 customize.bid.estimates
 *   预算 = ¥50
 *   同城同明星的链接为【一组】，一组开【一个】计划
 *   一个计划最多 10 条链接（接口自身限制，与「超级擦亮最多10个商品」一致）
 *
 * ⚠️ 永久规则：咨询量出价硬上限 ¥4.00（= cpm 400 分）。
 *    乘完 140% 若超 ¥4 —— **不建这个计划**，把组名和建议价列出来交老板单独定（方案 A）。
 *
 * 用法:
 *   node tools/open-chat-campaigns.js            # 只探测并列出建议价，不建计划
 *   node tools/open-chat-campaigns.js --apply    # 建出价合规的那些组
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const { ROOT, readJSON, TH } = require('../lib/env');

const ARGS = require('../lib/args').parse();
const APPLY = process.argv.includes('--apply');
// 出价 = 系统建议价 × RATE%。--rate=120 表示 120%（老板 2026-09-30 这批用 120%）
const RATE = (Number(ARGS.rate) > 0 ? Number(ARGS.rate) : 140) / 100;
const BUDGET_YUAN = Number(ARGS.budget) > 0 ? Number(ARGS.budget) : 50;
const CAP_CENT = Math.round(TH.adTargetCost * 100);   // ¥4 → 400 分（永久规则硬上限）
const CAT_DEFAULT = 201456914;           // 代购分类（publish.js 自己用的兜底值）

const SHOWS_FILE = path.join(ROOT, 'shows.json');
// --only=1,2,8 指定场次；不给则用 SHOW_NOS 默认那 6 个
const SHOW_NOS = ARGS.only
  ? String(ARGS.only).split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x))
  : [4, 5, 6, 7, 8, 9];

const yuan = (cent) => (Number(cent) / 100).toFixed(2);

/** 在售可投池（= 在售） */
async function fetchPool() {
  // 注意：agent.mtop() 的约定是「顶层 return」——它自己已经包了 async IIFE，
  // 这里再套一层 IIFE 会让返回值变成 undefined（踩过）。
  const code = [
    "const r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV2', v:'1.0', type:'POST',",
    "  data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });",
    "if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err:(r&&r.ret)||null });",
    'const d = (r.data || {}).result || r.data || {};',
    'return JSON.stringify({ ok:true, list:(d.itemList||[]).map(function(i){ return {',
    '  itemId:String(i.itemId), title:String(i.title||""), price:i.price, catId:i.catId,',
    '  publishTime:i.publishTime, supportAd:i.supportAd }; }) });',
  ].join('\n');
  const r = await agent.mtop(code);
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  if (!d || d.err) throw new Error('拉在售池失败：' + JSON.stringify(d && d.err));
  return d.list || [];
}

/** 问系统建议出价（分）。返回 {建议分, minBid, maxBid} */
async function suggestBid(entities) {
  const code = [
    "const r = await mtop.request({ api:'mtop.taobao.idle.ad.customize.bid.estimates', v:'1.0', type:'POST',",
    '  data:{ requestJson: JSON.stringify({ entityType:1, entityList:' + JSON.stringify(entities) + ',',
    "    bidTarget:'chat', bidPrice:100, noBid:false, pcFirstRequest:false }) } });",
    'if (!(r && r.ret && String(r.ret[0]).indexOf("SUCCESS") === 0)) return JSON.stringify({ err:(r&&r.ret)||null });',
    'const row = (((r.data||{}).customizeBidRecommendVOList)||[])[0] || {};',
    'return JSON.stringify({ bidPrice: row.bidPrice, minBid: row.minBid, maxBid: row.maxBid, improve: row.improve });',
  ].join('\n');
  const r = await agent.mtop(code);
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  if (!d || d.err) throw new Error('问建议价失败：' + JSON.stringify(d && d.err));
  return d;
}

/** 建计划（startV2），返回 ret */
async function startCampaign(entities, bidCent, title) {
  const payload = {
    entityType: 1, fromScene: 'pc_campaign-manage', oldMember: true,
    entityList: entities,
    customInfo: {
      bidPrice: bidCent,
      maxDayBudget: Math.round(BUDGET_YUAN * 100),
      budgetScheduleDurations: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    },
    baseInfo: {
      productId: 1, promotionMode: 'custom', bidType: 'smart_bid',
      bidTarget: 'chat', title: title,
    },
    targetInfo: { divisionList: [] },
    clueInfo: { chatButton: true, bookButton: false, bookText: '' },
    extraFunctions: { creativeOptSwitch: true },
  };
  const code = [
    "const r = await mtop.request({ api:'mtop.taobao.idle.ad.campaign.startV2', v:'1.0', type:'POST',",
    '  data:{ requestJson: ' + JSON.stringify(JSON.stringify(payload)) + ' } });',
    'return JSON.stringify({ ret: r && r.ret, data: r && r.data });',
  ].join('\n');
  const r = await agent.mtop(code, { timeout: 120000 });
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  const ret0 = String(((d && d.ret) || [])[0] || '');
  return { ok: ret0.indexOf('SUCCESS') === 0, ret: (d && d.ret) || [] };
}

(async () => {
  await agent.ready();
  await agent.enterAdConsole();

  const cfg = readJSON(SHOWS_FILE);
  const shows = (cfg.shows || []).filter((s) => SHOW_NOS.indexOf(s.no) >= 0);
  const pool = await fetchPool();

  out.head('分组 · 只看这次推的 ' + shows.length + ' 个场次');
  out.kv('在售可投池', pool.length + ' 条');
  out.kv('口径', '出价 = 系统建议价 × ' + RATE + '　预算 ¥' + BUDGET_YUAN + '　硬上限 ¥' + TH.adTargetCost);

  const groups = shows.map((s) => {
    const items = pool.filter((i) => i.title.indexOf(s.star) >= 0 && i.title.indexOf(s.city) >= 0);
    return { show: s, items };
  });

  const rows = [];
  const plan = [];

  for (const g of groups) {
    const s = g.show;
    if (!g.items.length) {
      rows.push([s.no, s.city + s.star, 0, '—', '—', '无在售链接']);
      continue;
    }
    // price 单位是分（ad-est-test.js 里 ¥50 商品用 5000）
    const entities = g.items.slice(0, 10).map((i) => ({
      entityId: Number(i.itemId),
      catId: Number(i.catId) || CAT_DEFAULT,
      price: Math.round(Number(i.price) || 5000),
      areaTarget: false,
      startTime: Number(i.publishTime) || Date.now(),
    }));

    let sug = null, err = '';
    try { sug = await suggestBid(entities); } catch (e) { err = e.message; }
    if (!sug || !sug.bidPrice) {
      rows.push([s.no, s.city + s.star, g.items.length, '—', '—', '取不到建议价 ' + (err || '').slice(0, 30)]);
      continue;
    }
    const suggested = Number(sug.bidPrice);
    const bid = Math.round(suggested * RATE);
    const over = bid > CAP_CENT;
    rows.push([
      s.no, s.city + s.star, g.items.length,
      '¥' + yuan(suggested), '¥' + yuan(bid) + (over ? ' ❌超上限' : ' ✅'),
      over ? '按方案 A：不建' : '可建',
    ]);
    if (!over) plan.push({ show: s, entities, bid, itemCount: g.items.length });
  }

  out.table(['序', '城市+明星', '链接数', '系统建议价', '×1.4 出价', '处置'], rows,
    { maxCol: [3, 18, 6, 11, 14, 16] });

  out.head('结论');
  out.kv('可建计划', plan.length + ' 组');
  out.plain('  每组：咨询量 · 出价见上 · 日预算 ¥' + BUDGET_YUAN + ' · 链接 = 该组全部在售');
  const over = rows.filter((r) => String(r[5]).indexOf('不建') >= 0);
  if (over.length) {
    out.warn('超 ¥' + TH.adTargetCost + ' 上限、按方案 A 不建的有 ' + over.length + ' 组：');
    over.forEach((r) => out.plain('    ' + r[1] + '  系统建议 ¥' + String(r[3]).replace('¥', '') + ' → ×1.4 会到 ' + r[4]));
    out.plain('    （这些请你单独定价，或者告诉我放宽到多少）');
  }
  const none = rows.filter((r) => r[5] === '无在售链接');
  if (none.length) out.kv('尚无在售链接', none.map((r) => r[1]).join('、'));

  if (!APPLY) {
    out.plain('');
    out.kv('DRY', '未建任何计划。加 --apply 建出价合规的那些组。');
    out.done(0);
  }

  out.head('建计划');
  let okN = 0;
  for (const p of plan) {
    const title = '¥' + yuan(p.bid) + '·咨询·' + p.show.city + p.show.star;
    try {
      const r = await startCampaign(p.entities, p.bid, title);
      out.plain('  ' + (r.ok ? '✅' : '❌') + ' ' + p.show.city + p.show.star +
        '  ' + p.itemCount + ' 条链接  出价 ¥' + yuan(p.bid) + (r.ok ? '' : '  ret=' + JSON.stringify(r.ret).slice(0, 80)));
      if (r.ok) okN++;
    } catch (e) {
      out.bad('  ' + p.show.city + p.show.star + ' 建计划异常：' + e.message);
    }
  }
  out.head('完成');
  out.ok('成功 ' + okN + ' / ' + plan.length + ' 组');
  out.done(okN === plan.length ? 0 : 1);
})().catch((e) => out.fail(e));
