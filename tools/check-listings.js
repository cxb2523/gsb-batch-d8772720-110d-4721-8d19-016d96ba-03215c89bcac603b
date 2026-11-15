/**
 * tools/check-listings.js — 检查 shows.json 里的场次在店里有没有上架
 *
 * 数据源两路，互相印证：
 *   A) mtop.taobao.idle.ad.item.searchV2 {tab:'all'}  → 可投放池 = **在售**商品
 *   B) mtop.idle.web.xyh.item.list                     → 本店全部宝贝（含已下架/已售出）
 *
 * 判定：
 *   ✅在售    在可投放池里命中（说明没下架、还能投广告）
 *   ⚠️不在售  只在商品列表命中，且 itemStatus 不是在线态 → 上架过但被下架/已售出
 *   ❌未上架  两路都没命中
 *
 * 用法:
 *   node tools/check-listings.js           # 摘要表
 *   node tools/check-listings.js --full    # 附带每条命中的标题
 *   node tools/check-listings.js --json    # 只吐机器可读结果
 *   node tools/check-listings.js --file <其它清单.json>
 */
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const { ROOT, readJSON } = require('../lib/env');

const a = require('../lib/args').parse();
const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
const LIST_FILE = a.file ? path.resolve(ROOT, a.file) : path.join(ROOT, 'shows.json');
const ONLY_JSON = !!a.json;

const XYH_API = 'mtop.idle.web.xyh.item.list';
// 好易美代拍 卖家维度参数（来自 diag-4items.js 的实测值）
const XYH_BASE = {
  needGroupInfo: false, userId: USER_ID,
  pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true,
};

/** 拉「可投放池」= 在售且支持广告的商品 */
async function fetchAdPool() {
  const code = `
    const r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV2', v:'1.0', type:'POST',
      data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err: (r && r.ret) || null });
    const d = (r.data || {}).result || r.data || {};
    const list = d.itemList || [];
    return JSON.stringify({ ok:true, list: list.map(i => ({
      itemId: String(i.itemId), title: String(i.title || ''), price: i.price,
      saleCnt: i.saleCnt, supportAd: i.supportAd, tags: (i.tags || []).join(',')
    })) });`;
  const r = await agent.mtop(code);
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  if (!d || d.err) throw new Error('可投放池拉取失败：' + JSON.stringify(d && d.err));
  return d.list || [];
}

/** 拉本店全部宝贝（含已下架） */
async function fetchAllItems() {
  const code = `
    const BASE = ${JSON.stringify(XYH_BASE)};
    const seen = {}; const list = [];
    for (let p = 1; p <= 15; p++) {
      let r;
      try { r = await mtop.request({ api:'${XYH_API}', v:'1.0', type:'POST',
        data: Object.assign({}, BASE, { pageNumber: p }) }); } catch (e) { break; }
      if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) break;
      const cards = (r.data && r.data.cardList) || [];
      if (!cards.length) break;
      let added = 0;
      cards.forEach(c => {
        const cd = c.cardData || {};
        const id = String(cd.id || '');
        if (!id || seen[id]) return;
        seen[id] = 1; added++;
        list.push({ itemId: id, title: String(cd.title || ''), status: cd.itemStatus,
                    price: cd.price, groupName: cd.groupName });
      });
      if (!added) break;
    }
    return JSON.stringify({ ok:true, list });`;
  try {
    const r = await agent.mtop(code, { timeout: 180000 });
    const d = typeof r === 'string' ? JSON.parse(r) : r;
    return (d && d.list) || [];
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 一条商品匹配某场次：
 *   strong = 标题**同时**含 明星 和 城市  → 这才是这个场次的上架
 *   weak   = 只含明星、城市对不上        → 同明星**其它城市**，不能算这个场次已上架
 *
 * 为什么必须卡城市：本店标题格式是「【xx代拍】明星~城市~…」，
 * 只看明星会把「广州宋雨琦」当成「成都宋雨琦」已上架（真实踩过）。
 */
function match(show, item) {
  const t = String(item.title || '');
  if (t.indexOf(show.star) < 0) return null;
  return {
    kind: (show.city && t.indexOf(show.city) < 0) ? 'weak' : 'strong',
    title: t, itemId: item.itemId, status: item.status,
  };
}

/** 从标题里抠出「~城市~」里的城市，用于告诉用户同明星本店还有哪些城 */
function cityOf(title) {
  const m = String(title).match(/[~～]([^~～]{1,8})[~～]/);
  return m ? m[1] : '';
}

(async () => {
  const cfg = readJSON(LIST_FILE);
  if (!cfg || !Array.isArray(cfg.shows)) { out.bad('读不到场次清单：' + LIST_FILE); out.done(2); }

  await agent.ready();
  const pool = await fetchAdPool();               // 在售
  const allRaw = await fetchAllItems();           // 全部
  const all = Array.isArray(allRaw) ? allRaw : [];
  const allErr = Array.isArray(allRaw) ? null : allRaw.error;

  const results = cfg.shows.map((s) => {
    const poolM = pool.map((i) => match(s, i)).filter(Boolean);
    const allM = all.map((i) => match(s, i)).filter(Boolean);
    const strongPool = poolM.filter((m) => m.kind === 'strong');
    const strongAll = allM.filter((m) => m.kind === 'strong');
    const weak = allM.filter((m) => m.kind === 'weak');
    let state, hits;
    if (strongPool.length) { state = '在售'; hits = strongPool; }
    else if (strongAll.length) { state = '不在售'; hits = strongAll; }
    else { state = '未上架'; hits = []; }
    const otherCities = [...new Set(weak.map((m) => cityOf(m.title)).filter(Boolean))];
    return { show: s, state, hits, weak, otherCities };
  });

  const missing = results.filter((r) => r.state === '未上架');
  const offline = results.filter((r) => r.state === '不在售');
  const live = results.filter((r) => r.state === '在售');

  if (ONLY_JSON) {
    process.stdout.write(JSON.stringify({
      store: agent.STORE, at: new Date().toISOString(),
      poolCount: pool.length, allCount: all.length,
      results: results.map((r) => ({ no: r.show.no, label: r.show.label, state: r.state,
        items: r.hits.map((h) => ({ itemId: h.itemId, title: h.title })),
        otherCities: r.otherCities })),
    }, null, 1));
    process.exit(0);
  }

  out.head('上架检查 · ' + agent.STORE);
  out.kv('在售可投池', pool.length + ' 条');
  out.kv('全部宝贝', all.length + ' 条' + (allErr ? '（拉取失败：' + allErr + '）' : ''));
  out.kv('清单', path.basename(LIST_FILE) + ' · ' + cfg.shows.length + ' 个场次');

  out.table(
    ['序', '场次', '状态', '命中', '商品'],
    results.map((r) => [
      r.show.no,
      r.show.label + (r.show.priority ? '（' + r.show.priority + '）' : ''),
      r.state === '在售' ? '✅ 在售' : (r.state === '不在售' ? '⚠️ 不在售' : '❌ 未上架'),
      r.hits.length ? r.hits.length + ' 条' : '—',
      r.hits.length ? r.hits.map((h) => h.itemId).join(' ') : (r.otherCities.length ? '（只有' + r.otherCities.join('/') + '）' : '—'),
    ]),
    { maxCol: [3, 30, 10, 6, 36] }
  );

  if (out.FULL) {
    results.forEach((r) => {
      if (!r.hits.length && !r.weak.length) return;
      out.plain('');
      out.plain('  【' + r.show.no + ' ' + r.show.label + '】');
      r.hits.forEach((h) => out.plain('    ✅ ' + h.itemId + '  ' + h.title.slice(0, 44)));
      r.weak.forEach((h) => out.plain('    ⤷ 同明星它城 ' + h.itemId + '  ' + h.title.slice(0, 40)));
    });
  }

  out.head('结论');
  out.ok('已上架且在售 ' + live.length + ' 个：' + (live.map((r) => r.show.label).join('、') || '无'));
  if (offline.length) out.warn('上架过但已不在售 ' + offline.length + ' 个：' + offline.map((r) => r.show.label).join('、'));
  if (missing.length) {
    out.warn('**没有上架** ' + missing.length + ' 个：');
    missing.forEach((r) => out.plain('    ' + r.show.no + '. ' + r.show.label +
      (r.show.priority ? '  【' + r.show.priority + '】' : '') +
      (r.otherCities.length ? '   ← 同明星本店已有：' + r.otherCities.join('、') : '')));
  } else {
    out.ok('清单里的场次全部已上架');
  }

  out.full({ pool, all, results: results.map((r) => ({ label: r.show.label, state: r.state, hits: r.hits, weak: r.weak })) }, 'check-listings');
  out.done(missing.length || offline.length ? 1 : 0);
})().catch((e) => out.fail(e));
