import { exactAutomationId } from './automation-policy.mjs';
import { claimOnce } from './extra-free-rewards.mjs';
import { checkedAction, clock, dayOf, digest, hasReward, moduleOpen, natural, positive, read, table, waiting, windowOpen } from './activity-actions.mjs';
import { claimPass } from './seasonal-activities.mjs';
import { merchantActionSeconds, merchantSettings, merchantTiming, planMerchant } from './merchant-planner.mjs';
import { merchantSpeedMatches, runMerchantSpeed } from './merchant-speed.mjs';
import { refreshOrderMaterialSpends } from './order-reservations.mjs';
import { rewardData } from './missing-rewards.mjs';
import { recordMerchantSnapshot, recordMerchantTrade, merchantJournalSummary, readMerchantJournal } from './merchant-journal.mjs';
import { evaluateMerchantUpgrade, runMerchantUpgrade } from './merchant-upgrade.mjs';
import { watchMerchant } from './merchant-monitor.mjs';
import { merchantStrategyPlan } from './merchant-strategy.mjs';

export { planMerchant } from './merchant-planner.mjs';
const param = (config, key) => table(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
function tradingHours(config, time) {
  return merchantTiming(config, null, time).tradingOpen;
}
const quantity = (state, id, city, price) => state.goods
  .filter(g => g.goodsId === id && g.cityId === city && (price == null || g.buyPrice === price))
  .reduce((sum, g) => sum + g.num, 0);
const fingerprint = state => ({ coins: state.player.coins, profit: state.player.profit, goods: state.player.goods, cargo: state.cargo });
const cargoSignature = state => digest([state.player.coins, state.player.goods?.map(g =>
  [g?.pid, g?.goodsId, g?.cityId, g?.buyPrice, g?.num]).sort((a, b) => a[0] - b[0])]);
function marketEpoch(config, time) {
  return merchantTiming(config, null, time).marketEpoch;
}
function visitedPorts(ledger, scope, epoch, state) {
  const signature = cargoSignature(state);
  return [...new Set(Object.values(ledger?.keyRecords() ?? {})
    .filter(r => r.confirmed && r.details?.scope === scope && r.details.expected?.request === 'TradeMoveRequest' &&
      (r.details.expected.cargoSignature ? r.details.expected.cargoSignature === signature : r.details.expected.marketEpoch === epoch))
    .map(r => r.details.expected.city))];
}
function knownMarkets(ledger, event) {
  return Object.values(ledger?.keyRecords() ?? {}).map(r => r.details?.merchantMarket)
    .filter(m => m?.period === event.period && m.startTime === event.startTime);
}
// 每期每港仅留一个亲自读取的快照。展示页只读，不能借展示更新采集时间。
function rememberMarket(ledger, snapshot) {
  if (!ledger || !positive(snapshot.cityId) || !Array.isArray(snapshot.goods) ||
    snapshot.goods.some(g => !g || !positive(g.goodsId) || !positive(g.price) || !natural(g.stock)) ||
    new Set(snapshot.goods.map(g => g.goodsId)).size !== snapshot.goods.length) return;
  const key = 'merchant-market:' + snapshot.startTime + ':' + snapshot.period + ':' + snapshot.cityId;
  const details = { merchantMarket: snapshot };
  if (ledger.hasKey(key)) ledger.resolveKey(key, true, details);
  else ledger.confirm(ledger.reserve({}, {}, {}, { uniqueKey: key, details }));
}
async function readMerchantPlan(config, event, state, time, ask, visited, options = {}) {
  let market;
  try { market = await ask('TradeCity', { cityId: state.cargo.cityId }); }
  catch { return { kind: 'wait', reason: '等待本港报价更新' }; }
  const observedAt = options.now?.() ?? time;
  const marketSnapshot = { ...market, cityId: state.cargo.cityId, observedAt, period: event.period, startTime: event.startTime };
  options.remember?.(marketSnapshot);
  let radar;
  try { radar = await ask('TradeGuildRadar'); }
  catch { radar = { radar: [] }; }
  const plan = planMerchant(config, event, state, marketSnapshot, radar, options.now?.() ?? time, visited, options);
  options.observed?.({ state, market: marketSnapshot, radar, plan });
  const strategy = merchantStrategyPlan(plan, config, event, state, merchantSettings(options.settings), options.now?.() ?? time, options.ledger);
  return { ...strategy, marketSnapshot, radarSnapshot: radar };
}

// 复用当前连接的只读诊断；航行中不探测异地报价。
export async function readMerchantStatus(client, config, { player, ledger, settings = {} } = {}) {
  const time = clock(client), event = client.tradeWindow && { ...client.tradeWindow };
  const history = merchantJournalSummary(ledger, undefined, { time });
  if (!event?.period || !windowOpen(event, time) || !moduleOpen(config, player, '海商王'))
    return { checkedAt: time, event, available: false, reason: '海商王当前未开放或未解锁', history };
  const state = await read(client, 'TradeInfo');
  if (state.period !== event.period || !state.cargo || !state.player)
    return { checkedAt: time, event, available: false, reason: '商船状态尚未同步', history };
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  const inTransit = state.cargo.moveEndTime > clock(client) || state.cargo.moveToCityId && state.cargo.moveToCityId !== state.cargo.cityId;
  const plan = inTransit ? { kind: 'wait', reason: '航行中，等待到港后读取本港报价' } :
    await readMerchantPlan(config, event, state, time, (name, body) => read(client, name, body),
      visitedPorts(ledger, scope, marketEpoch(config, time), state), { settings: settings.merchant, ledger,
        markets: knownMarkets(ledger, event), actionSeconds: merchantActionSeconds(settings), now: () => clock(client) });
  const upgrade = inTransit ? { eligible: false, reason: '航行中不升级' } : evaluateMerchantUpgrade(config, event, state,
    plan.marketSnapshot, plan.radarSnapshot, clock(client), { settings, markets: knownMarkets(ledger, event), actionSeconds: merchantActionSeconds(settings) });
  return { checkedAt: clock(client), available: true, event, state, plan, upgrade,
    journal: merchantJournalSummary(ledger, event, { time: clock(client) }), history,
    monitoring: watchMerchant(client).snapshot() };
}

export { readMerchantJournal, merchantJournalSummary };

export async function merchantProgress(config, event, state, player, time, ask, ledger, settings) {
  const cargo = state.cargo;
  const goodsName = id => table(config, 'TradeGoodsCfg').find(g => g.goodsId === id)?.itemName || '商品 ' + id;
  const cities = table(config, (player.scenarioId || 1) + '_CityCfg');
  const cityName = id => cities.find(c => c.id === id)?.name || '港口 ' + id;
  const goods = state.player.goods;
  const stock = !Array.isArray(goods) ? '未同步' : goods.length ?
    goods.map(g => goodsName(g.goodsId) + ' ×' + g.num).join('、') : '空载';
  const progress = ['当前商品：' + stock];
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  if (cargo.moveEndTime > time || (cargo.moveToCityId && cargo.moveToCityId !== cargo.cityId)) {
    const leg = Object.values(ledger?.keyRecords() ?? {}).find(r => {
      const e = r.details?.expected;
      return r.details?.scope === scope && e?.request === 'TradeMoveRequest' && e.city === cargo.cityId &&
        e.destination === cargo.moveToCityId && Math.abs(e.start - cargo.moveStartTime) <= 2;
    });
    if (leg?.details.expected.goodsId) progress.push('本程商品：' + goodsName(leg.details.expected.goodsId));
    progress.push('目标城池：' + (positive(cargo.moveToCityId) ? cityName(cargo.moveToCityId) : '未同步'));
    progress.push(cargo.moveEndTime > time ? '航行中' : '等待到港确认');
    return progress.join(' · ');
  }
  if (positive(cargo.cityId)) progress.push('所在城池：' + cityName(cargo.cityId));
  const wait = reason => [...progress, '目标城池：待定', reason].join(' · ');
  if (!tradingHours(config, time)) return wait('等待开放交易时段');
  if (!exactGuild(player.guildId)) return wait('需加入联盟后参与贸易');
  if (!positive(cargo.cityId)) return wait('等待商船位置同步');
  const pending = Object.values(ledger?.keyRecords() ?? {}).find(r => !r.confirmed && r.details?.scope === scope);
  if (pending) return wait('前次操作结果待确认');
  const plan = await readMerchantPlan(config, event, state, time, ask,
    visitedPorts(ledger, scope, marketEpoch(config, time), state), {
      settings: settings?.merchant ?? settings, ledger, markets: knownMarkets(ledger, event), actionSeconds: merchantActionSeconds(settings)
    });
  if (plan.kind === 'wait') return wait(plan.reason);
  if (plan.goodsId) progress.push('计划' + ({ buy: '买入', sell: '卖出', move: '走商' })[plan.kind] + '：' + goodsName(plan.goodsId));
  else progress.push('计划走商：换港寻价');
  progress.push('目标城池：' + cityName(plan.destination ?? plan.city));
  if (plan.label) progress.push(plan.label);
  return progress.join(' · ');
}
const samePlan = (a, b) => a.kind === b.kind &&
  ['city', 'destination', 'goodsId', 'pid', 'count', 'price', 'gain', 'mode', 'exploration'].every(k => a[k] === b[k]);
function validFingerprint(s) {
  return s?.cargo && natural(s.coins) && natural(s.profit) && Array.isArray(s.goods) &&
    s.goods.every(g => g && natural(g.pid) && positive(g.goodsId) && positive(g.cityId) && positive(g.buyPrice) && positive(g.num)) &&
    new Set(s.goods.map(g => g.pid)).size === s.goods.length;
}
function actionMatched(e, s, time) {
  if (!validFingerprint(s)) return false;
  if (e.request === 'TradeSpeedRequest') return merchantSpeedMatches(e, s, time);
  if (e.request === 'TradeBuyRequest')
    return s.coins === e.coins && quantity(s, e.goodsId, e.city, e.price) >= e.owned;
  if (e.request === 'TradeSellRequest') {
    if (s.goods.some(g => g.pid === e.pid)) return false;
    // 兼容历史账本；新记录还核对整批回款，亏损卖出不增加累计利润。
    if (e.gain == null) return s.coins > e.coins && s.profit > e.profit;
    return s.coins >= e.coins + e.proceeds && s.profit >= e.profit + Math.max(0, e.gain);
  }
  if (e.request !== 'TradeMoveRequest') return false;
  return s.cargo.cityId === e.destination ||
    (s.cargo.moveToCityId === e.destination && s.cargo.moveEndTime >= e.start);
}

export async function merchantActivity(client, config, ctx) {
  const event = client.tradeWindow && { ...client.tradeWindow };
  const actor = () => JSON.stringify([ctx.player?.playerId, ctx.player?.worldId, ctx.player?.guildId]);
  const identity = actor();
  const allowed = () => ctx.enabled() && client.connected !== false && actor() === identity && moduleOpen(config, ctx.player, '海商王') &&
    windowOpen(client.tradeWindow, clock(client)) && client.tradeWindow?.period === event?.period &&
    client.tradeWindow.startTime === event.startTime && client.tradeWindow.endTime === event.endTime;
  if (!event?.period || !allowed()) return waiting(ctx, '海商王本期尚未开放');
  if (ctx.key === 'merchantTrade' && !exactGuild(ctx.player.guildId)) return waiting(ctx, '需加入联盟后参与贸易');
  const getState = () => read(client, 'TradeInfo');
  const info = await getState();
  if (!allowed()) return waiting(ctx, '开关、账号或活动状态已变化');
  if (info.period !== event.period || !info.player || !info.cargo) return waiting(ctx, '海商王期数或商船状态未确认');
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  if (ctx.key === 'merchantRewards') {
    await merchantRewards(client, config, ctx, event, info, allowed, getState);
    return;
  }
  const onOutcome = data => recordMerchantTrade(ctx.ledger, { event, ...data, time: data.time ?? clock(client) });
  ctx = Object.assign(Object.create(ctx), { onMerchantOutcome: onOutcome,
    merchantMetrics: () => merchantJournalSummary(ctx.ledger, event, { time: clock(client) }) });
  watchMerchant(client).observe({ event, state: info, time: clock(client), config, settings: ctx.settings?.() });
  // 已确认业务证据先持久化；统计写入失败或崩溃后仅补录，不重发游戏请求。
  for (const [key, record] of Object.entries(ctx.ledger?.keyRecords() ?? {})) {
    if (!record.confirmed || ![scope, 'merchant-upgrade:' + event.startTime + ':' + event.period].includes(record.details?.scope) ||
      record.details.journalRecorded || !record.details.before || !record.details.after) continue;
    try {
      onOutcome({ actionKey: key, expected: record.details.expected, before: record.details.before, after: record.details.after,
        attemptedAt: record.details.attemptedAt, time: record.details.confirmedAt, actualDiamondSpent: record.details.actualDiamondSpent, status: 'confirmed' });
      ctx.ledger.resolveKey(key, true, { ...record.details, journalRecorded: true });
    } catch (error) { waiting(ctx, '已确认成交的统计暂未补录：' + error.message); }
  }
  // 先核对上次写入，再检查航行/盈亏，避免已售批次消失后永久停在未知状态。
  const pending = Object.entries(ctx.ledger?.keyRecords() ?? {}).find(([, r]) => !r.confirmed && r.details?.scope === scope);
  if (pending) {
    const [key, record] = pending;
    if (!actionMatched(record.details.expected, fingerprint(info), clock(client)))
      return waiting(ctx, '前次操作结果待确认，等待游戏状态更新');
    if (record.details.expected.request === 'TradeSpeedRequest') await refreshOrderMaterialSpends(client, ctx.player);
    const details = { ...record.details, after: fingerprint(info), confirmedAt: clock(client) };
    ctx.ledger.resolveKey(key, true, details);
    try {
      onOutcome({ actionKey: key, expected: details.expected, before: details.before, after: details.after,
        attemptedAt: details.attemptedAt, status: 'confirmed' });
      ctx.ledger.resolveKey(key, true, { ...details, journalRecorded: true });
    } catch (error) { waiting(ctx, '操作已确认，统计将在下次检查补录：' + error.message); }
    return ctx.report({ label: ctx.label, ok: true, status: 'confirmed', reason: '已回读确认前次操作' });
  }
  if (!tradingHours(config, clock(client))) return waiting(ctx, '等待游戏规定的贸易时段 ' + param(config, '海商王贸易时间'));
  const profitLimit = ctx.settings?.()?.merchant?.profitLimit ?? 0;
  if (profitLimit > 0 && info.player.profit >= profitLimit) return waiting(ctx, '已达本期累计利润上限，领奖仍按独立开关执行');
  if (info.cargo.moveEndTime > clock(client)) {
    if (await runMerchantSpeed(client, config, ctx, event, info)) return;
    return waiting(ctx, '航行中，预计 ' + new Date(info.cargo.moveEndTime * 1000)
      .toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 到港');
  }
  if (info.cargo.moveToCityId && info.cargo.moveToCityId !== info.cargo.cityId)
    return waiting(ctx, '等待服务端确认到港');
  const epoch = () => marketEpoch(config, clock(client));
  const currentEpoch = epoch();
  const policy = merchantSettings(ctx.settings?.()?.merchant);
  const policyStamp = JSON.stringify(policy);
  const actionSeconds = () => positive(ctx.merchantCadenceSeconds)
    ? Math.max(60, ctx.merchantCadenceSeconds)
    : merchantActionSeconds(ctx.settings?.(), Math.ceil((ctx.everyMs ?? 0) / 1000));
  const actionInterval = actionSeconds();
  const snapshot = state => readMerchantPlan(config, event, state, clock(client),
    (name, body) => read(client, name, body), visitedPorts(ctx.ledger, scope, currentEpoch, state), {
      settings: policy, ledger: ctx.ledger, markets: knownMarkets(ctx.ledger, event), now: () => clock(client), actionSeconds: actionInterval,
      remember: market => rememberMarket(ctx.ledger, market),
      observed: observed => {
        recordMerchantSnapshot(ctx.ledger, { ...observed, event, time: clock(client), config, settings: ctx.settings?.(), actionSeconds: actionInterval });
        watchMerchant(client).observe({ ...observed, event, time: clock(client), config, settings: ctx.settings?.() });
      }
    });
  const plan = await snapshot(info);
  if (plan.kind !== 'sell' && await runMerchantUpgrade(client, config, ctx, event, info,
    { market: plan.marketSnapshot, radar: plan.radarSnapshot, markets: knownMarkets(ctx.ledger, event), actionSeconds: actionInterval })) return;
  if (plan.kind === 'wait') return waiting(ctx, plan.reason);
  const fresh = await getState();
  if (fresh.period !== event.period || !allowed()) return waiting(ctx, '期数或活动状态已变化');
  const verified = await snapshot(fresh);
  if (!samePlan(plan, verified) || epoch() !== currentEpoch)
    return waiting(ctx, '港口价格、库存或目的港已变化，下一轮重算');
  const state = fingerprint(fresh);
  const send = async (name, body, response) => {
    try { return rewardData(await client.request(name, body, response)); }
    catch (error) {
      // 只采用原写请求的未发送证据，回读失败不能释放已发送的票据。
      if (error.notSent === true) error.released = true;
      throw error;
    }
  };
  const common = {
    scope, before: state, label: verified.label, retainEvidence: true, attemptedAt: clock(client), onOutcome, now: () => clock(client),
    allowed: () => allowed() && tradingHours(config, clock(client)) && epoch() === currentEpoch &&
      JSON.stringify(merchantSettings(ctx.settings?.()?.merchant)) === policyStamp &&
      actionSeconds() === actionInterval &&
      clock(client) - verified.marketSnapshot.observedAt <= policy.quoteMaxAgeSeconds &&
      (plan.kind === 'sell' || (positive(verified.latestActionAt) && clock(client) < verified.latestActionAt)) &&
      (plan.kind === 'sell' || clock(client) + merchantTiming(config, event, clock(client)).travelSeconds + actionInterval <
        Math.min(event.endTime, merchantTiming(config, event, clock(client)).tradeEndTime)),
    inspect: async () => { const r = await getState(); return r.period === event.period ? fingerprint(r) : null; },
    matches: (e, s) => actionMatched(e, s, clock(client))
  };
  if (plan.kind === 'buy') {
    const expected = {
      request: 'TradeBuyRequest', city: plan.city, goodsId: plan.goodsId, price: plan.price,
      owned: quantity(state, plan.goodsId, plan.city, plan.price) + plan.count,
      coins: state.coins - plan.price * plan.count
    };
    return checkedAction(ctx, { ...common, expected,
      send: () => send(expected.request, { cityId: plan.city, goodsId: plan.goodsId, buyNum: plan.count }, 'TradeBuyResponse'),
      accept: r => r.player && actionMatched(expected, fingerprint({ player: r.player, cargo: state.cargo }))
    });
  }
  if (plan.kind === 'sell') {
    const batch = state.goods.find(g => g.pid === plan.pid);
    const expected = { request: 'TradeSellRequest', pid: plan.pid, coins: state.coins, profit: state.profit,
      gain: plan.gain, proceeds: batch.buyPrice * plan.count + plan.gain };
    return checkedAction(ctx, { ...common, expected,
      send: () => send(expected.request, { cityId: plan.city, pid: plan.pid, sellNum: plan.count }, 'TradeSellResponse'),
      accept: r => r.player && actionMatched(expected, fingerprint({ player: r.player, cargo: state.cargo }))
    });
  }
  const expected = { request: 'TradeMoveRequest', city: plan.city, destination: plan.destination, goodsId: plan.goodsId,
    start: clock(client), marketEpoch: currentEpoch, cargoSignature: cargoSignature(fresh), exploration: !!plan.exploration };
  return checkedAction(ctx, { ...common, expected,
    send: () => send(expected.request, { cityId: plan.city, mvToCityId: plan.destination }, 'TradeMoveResponse'),
    accept: r => r.cargo?.moveToCityId === plan.destination || r.cargo?.cityId === plan.destination
  });
}

async function merchantRewards(client, config, ctx, event, info, allowed, getState) {
  const scope = event.startTime + ':' + event.period;
  await claimPass(
    client,
    { ...ctx, label: '海商王战令' },
    { type: 3, tiers: table(config, 'TradePassCfg').filter((t) => t.period === info.period), scope, allowed }
  );
  if (!allowed()) return;
  const stages = table(config, 'TradeAchieveRewardCfg').filter(
    (t) => t.id === info.period && t.rewardId > info.gotAchieveRwdId && t.target <= info.player.profit
  );
  if (stages.length)
    await claimOnce(client, {
      key: 'trade-profit:' + scope + ':' + info.gotAchieveRwdId,
      ledger: ctx.ledger,
      enabled: allowed,
      title: '海商王 · 累计利润奖励',
      report: ctx.report,
      request: 'GotTradeAchievementRequest',
      response: 'GotTradeAchievementResponse',
      verify: async (r) =>
        hasReward(r) &&
        r.gotAchieveRwdId > info.gotAchieveRwdId &&
        (await getState()).gotAchieveRwdId >= r.gotAchieveRwdId
    });
  const day = dayOf(clock(client)),
    dayNum = day - dayOf(event.startTime) + 1;
  if (!allowed() || !exactGuild(ctx.player.guildId)) return;
  const getTasks = async () => (await read(client, 'TradeTask')).guildTask;
  const task = await getTasks();
  if (!Array.isArray(task?.gotTaskId) || !natural(task.profit) || !natural(task.tradeTimes))
    return waiting(ctx, '联盟贸易任务进度未同步');
  const eligible = table(config, 'TradeGuildTaskCfg').filter(
    (t) =>
      t.day <= dayNum &&
      !task.gotTaskId.includes(t.id) &&
      (t.taskType === 0 ? task.profit : task.tradeTimes) >= t.tragetCount
  );
  for (const taskDay of new Set(eligible.map((t) => t.day))) {
    const ids = eligible.filter((t) => t.day === taskDay).map((t) => t.id);
    await claimOnce(client, {
      ledger: ctx.ledger,
      key: 'trade-task:' + scope + ':' + taskDay + ':' + ids.join('-'),
      enabled: allowed,
      report: ctx.report,
      title: '海商王 · 第' + taskDay + '天联盟任务',
      request: 'TradeGotTaskRequest',
      response: 'TradeGotTaskResponse',
      body: { day: taskDay },
      verify: async (r) => {
        if (!hasReward(r) || !ids.every((id) => r.gotTaskId.includes(id))) return false;
        const after = await getTasks();
        return ids.every((id) => after.gotTaskId.includes(id));
      }
    });
  }
  const reportTiers = table(config, 'TradeDayRewardCfg').filter(
    (t) => t.id > info.gotReportRwdId && t.roleNum <= info.guildReportNum
  );
  if (reportTiers.length)
    await claimOnce(client, {
      ledger: ctx.ledger,
      key: 'trade-report:' + scope + ':' + day + ':' + info.gotReportRwdId,
      enabled: () => allowed() && dayOf(clock(client)) === day,
      report: ctx.report,
      title: '海商王 · 联盟商情礼包',
      request: 'GotTradeReportRequest',
      response: 'GotTTradeReportResponse',
      verify: async (r) =>
        hasReward(r) &&
        r.gotReportRwdId > info.gotReportRwdId &&
        (await getState()).gotReportRwdId >= r.gotReportRwdId
    });
}
function exactGuild(id) {
  const value = exactAutomationId(id);
  return !!value && BigInt(value) % 1000n > 0n;
}
