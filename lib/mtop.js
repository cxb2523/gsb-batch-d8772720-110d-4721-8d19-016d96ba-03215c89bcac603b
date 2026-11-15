/**
 * lib/mtop.js — 闲鱼 MTOP 业务接口封裝（广告计划 / 商品搜索 / 发布）
 *
 * 为什么存在：以前每个脚本自己拼 window.lib.mtop.request 的字符串，
 * 参数名写错、日期格式写错、状态判定写错，都在各自文件里。
 * 状态判定（statusGroup + statusDescTitle）曾经连续判错两次，现在只有这一处。
 *
 * 用法：
 *   const mtop = require('./lib/mtop');
 *   const plans = await mtop.adPlans();            // 全部擦亮计划（规范化后）
 *   await mtop.adPause(['96129660']);              // 暂停
 *   const items = await mtop.itemSearch('宋雨琦');  // 商品搜索
 */
const agent = require('./agent');
const { RULES, ymd } = require('./env');

const API = {
  adSearch: 'mtop.taobao.idle.ad.campaign.search',
  adPause: 'mtop.taobao.idle.ad.campaign.pause',
  itemSearch: 'mtop.taobao.idle.ad.item.searchV2',
};

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const yuan = (v) => num(v) / 100;

/**
 * 页面侧代码片段：拉一页原始计划列表（**不做**规范化，返回页面里的 JSON 字符串）。
 *
 * 为什么单独导出：诊断类工具（如 `tools/mtop-session-check.js`）要把「一次广告调用」
 * 和自己的探针（refreshAutoLogin / 登录 cookie 旁证）**拼成同一次 eval** 发出去 ——
 * 少发一次就少一分被风控限流的风险（详见 `lib/req-gate.js` 头部那次事故）。
 * 但接口名属于公共层，不该让每个工具各抄一遍（lint 规则 4：49 个文件已经踩了）。
 *
 * 用法（在 inject 的代码里 `await eval` 它）：
 *   const js = mtop.rawAdSearchCode({ pageNum: 1, pageSize: 3 });
 *   const raw = await mtop('const r = await ' + js + '; return JSON.stringify(r.ret);');
 */
function rawAdSearchCode(params) {
  const req = Object.assign({ pageNum: 1, pageSize: 100, campaignStatus: [], statusGroup: [] }, params || {});
  return "mtop.request({ api:'" + API.adSearch + "', v:'1.0', type:'GET'," +
    " data:{ requestJson: JSON.stringify(" + JSON.stringify(req) + ") } })";
}

/** 出价目标代码 → 中文 */
const TARGET_CN = {
  exposure: '曝光量', click: '浏览量', follow_collect: '关注收藏量',
  chat: '咨询量', order: '订单量',
};

/**
 * 计划真实状态判定（唯一权威实现）
 *
 * 教训：曾用 pauseStatus === '1' 当「已暂停」，但 13 个计划全是 '1'，判据无效。
 * 也曾在 search 里传 campaignStatus 过滤，但 search 本来就返回暂停中的计划。
 * 正确做法：看 statusGroup（online/paused/balance_paused）+ statusDescTitle 的中文描述。
 */
function planVerdict(c) {
  const group = String((c && c.statusGroup) || '');
  const desc = String((c && (c.statusDescTitle || c.statusDesc)) || '');
  // 【2026-10-08 修】pauseStatus 是平台层面的硬开关，'0' = 在跑。
  //   为什么必须放在最前：平台在某些条件下（实测「部分商品因状态异常无法擦亮」）
  //   会用那条文案【顶掉】常规状态标签，此时 statusGroup 也不是 'online'，
  //   于是整条计划被误判成「暂停」—— 而它其实在跑（pauseStatus='0'）。
  //   实测：三亚周杰伦-咨询120 真在跑却被报成暂停，差点据此向老板报错状态。
  //   而真正停掉的计划（手动暂停 / 超日预算 / 余额不足）pauseStatus 都是 '1'，
  //   所以这条前置判断不会把"停"误判成"跑"。
  if (String((c && c.pauseStatus) || '') === '0') return 'online';
  if (/余额不足/.test(desc)) return 'balance_paused';
  if (/日预算|预算上限/.test(desc)) return 'budget_paused';
  if (/手动暂停/.test(desc)) return 'manual_paused';
  if (group === 'online') return 'online';
  if (group) return group;
  return 'unknown';
}

const VERDICT_CN = {
  online: '投放中',
  manual_paused: '手动暂停',
  budget_paused: '超日预算暂停',
  balance_paused: '余额不足暂停',
  paused: '暂停',
  unknown: '未知',
};

/** 是否属于「主/副集合」——永久护栏：集合计划绝不自动暂停 */
function isCollection(name) {
  return new RegExp('^' + RULES.collectionPrefix).test(String(name || ''));
}

/** 把 search 返回的一条原始计划压成我们真正要用的叶子字段（不要整体序列化页面对象） */
function normalizePlan(c) {
  const d = c.adDataDetailVO || {};
  const it = c.infoTab || {};
  const td = c.todayAdDataDetail || {};
  const verdict = planVerdict(c);
  const cumCost = yuan(d.cost), cumChat = num(d.chatPv);
  const dayCost = yuan(it.todayCost), dayChat = num(td.chatPv);
  return {
    id: String(c.campaignId),
    name: c.title || c.campaignName || '',
    target: TARGET_CN[c.bidTarget] || String(c.bidTarget || ''),
    bidYuan: yuan(c.cpm),
    budgetYuan: yuan(c.maxDayBudget),
    verdict,
    verdictCn: VERDICT_CN[verdict] || verdict,
    desc: String(c.statusDescTitle || ''),
    isCollection: isCollection(c.title),
    cumCost, cumChat, cumOrder: num(d.payPv),
    dayCost, dayChat,
    // 【2026-10-08 加】今日曝光。判断「加了出价有没有换来量」只看这个数：
    //   曝光涨了 = 是出价问题；曝光还是趴着 = 是链接/需求问题，再加价就是白花钱。
    //   ⚠️ 字段名踩过坑：原始对象里没有 `shows`（写成 c.shows 会静默得到 0，
    //      看着像"一条曝光都没有"，很有说服力但完全是假的）。
    //      真正的字段是 todayShowPv（实时），退路是 todayAdDataDetail.showPv（整点快照，会滞后）。
    dayShows: c.todayShowPv != null ? num(c.todayShowPv) : num(td.showPv),
    itemCount: (c.entityList || []).length,
    items: (c.entityList || []).map((e) => String(e.entityId)).join(','),
    costPerChat: cumChat > 0 ? cumCost / cumChat : (cumCost > 0 ? Infinity : 0),
  };
}

/**
 * 拉擦亮计划列表。
 * opts.days 给了就拉「近 N 日累计」（startDate/endDate），否则拉当日快照。
 * 返回规范化数组；分页自动翻到底。
 */
async function adPlans(opts) {
  opts = opts || {};
  const days = opts.days;
  const params = { pageNum: 1, pageSize: 100, campaignStatus: [], statusGroup: [] };
  if (days) { params.startDate = ymd(new Date(Date.now() - (days - 1) * 86400000)); params.endDate = ymd(new Date()); params.includeEndDate = true; }

  const code = `
    const out = [];
    for (let p = 1; p <= 10; p++) {
      const req = Object.assign({}, ${JSON.stringify(params)}, { pageNum: p });
      const r = await mtop.request({ api:'${API.adSearch}', v:'1.0', type:'GET',
        data:{ requestJson: JSON.stringify(req) } });
      if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err: (r && r.ret) || null });
      const list = ((r.data || {}).result) || [];
      out.push(...list);
      if (list.length < 100 || String((r.data || {}).nextPage) === 'false') break;
    }
    return JSON.stringify({ ok: true, list: out });`;

  const r = await agent.mtop(code + '', { store: opts.store, timeout: opts.timeout || 120000 });
  const data = typeof r === 'string' ? JSON.parse(r) : r;
  if (!data || data.err) throw new Error('拉取计划失败：' + JSON.stringify(data && data.err));
  return (data.list || []).map(normalizePlan);
}

/** 暂停/恢复计划。pauseStatus: 1=暂停, 0=恢复 */
async function adPause(ids, opts) {
  opts = opts || {};
  const list = [].concat(ids).map(String);
  const code = `
    const r = await mtop.request({ api:'${API.adPause}', v:'1.0', type:'POST',
      data:{ requestJson: JSON.stringify({ campaignIds: ${JSON.stringify(list)}, pauseStatus: ${opts.pauseStatus === 0 ? 0 : 1} }) } });
    return JSON.stringify({ ret: r && r.ret });`;
  const r = await agent.mtop(code, { store: opts.store });
  const ret = (r && r.ret) || [];
  return { ok: String(ret[0] || '').indexOf('SUCCESS') === 0, ret };
}

/** 广告用商品搜索 */
async function itemSearch(searchKey, opts) {
  opts = opts || {};
  const tab = opts.tab || 'platReco';
  const code = `
    const r = await mtop.request({ api:'${API.itemSearch}', v:'1.0', type:'POST',
      data:{ requestJson: JSON.stringify({ pageNum: ${opts.pageNum || 1}, pageSize: ${opts.pageSize || 20}, tab: ${JSON.stringify(tab)}, needTabs: false, searchKey: ${JSON.stringify(String(searchKey || ''))} }) } });
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err: (r && r.ret) || null });
    const d = r.data || {};
    return JSON.stringify({ items: (d.itemList || []).map(i => ({
      itemId: String(i.itemId), title: i.title, price: i.price, saleCnt: i.saleCnt,
      tags: (i.tags || []).join(','), publishTime: i.publishTime, firstModified: i.firstModified,
      supportAd: i.supportAd
    })) });`;
  const r = await agent.mtop(code, { store: opts.store });
  if (!r || r.err) throw new Error('商品搜索失败：' + JSON.stringify(r && r.err));
  return r.items || [];
}

/** 计划的一行摘要（给 out.table 用） */
function planRow(p) {
  const money = (x) => (x === Infinity ? '∞' : '¥' + Number(x || 0).toFixed(1));
  return [
    p.id, p.name.slice(0, 22), p.target, p.verdictCn,
    '¥' + p.dayCost.toFixed(0) + '/' + p.dayChat,
    '¥' + p.cumCost.toFixed(0) + '/' + p.cumChat,
    money(p.costPerChat),
    '¥' + p.budgetYuan.toFixed(0),
    p.isCollection ? '集合' : '单链',
  ];
}
const PLAN_HEADERS = ['id', '名称', '目标', '状态', '今日¥/咨', '累计¥/咨', '单次', '预算', '类型'];

module.exports = {
  API, TARGET_CN, VERDICT_CN, PLAN_HEADERS,
  num, yuan, planVerdict, isCollection, normalizePlan, planRow,
  adPlans, adPause, itemSearch, rawAdSearchCode,
};
