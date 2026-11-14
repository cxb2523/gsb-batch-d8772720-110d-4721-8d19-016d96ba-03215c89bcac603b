import { exactAutomationId } from './automation-policy.mjs';
import { clock, natural, positive, read, table, windowOpen } from './activity-actions.mjs';
import { merchantActionSeconds, merchantSettings, merchantTiming, planMerchant } from './merchant-planner.mjs';

const defaults = Object.freeze({ autoUpgrade: false, upgradeCoinValuePerDiamond: 100,
  upgradeMinReturnPercent: 150, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300 });
const fullSettings = ctx => (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) ?? {};
const policyOf = settings => ({ ...defaults, ...(settings?.merchant ?? settings ?? {}) });
const scopeOf = event => 'merchant-upgrade:' + event.startTime + ':' + event.period;
const signature = state => JSON.stringify([state.period,
  ['cargoLv', 'cityId', 'moveStartTime', 'moveEndTime', 'moveToCityId'].map(key => state.cargo?.[key] ?? 0),
  state.player?.coins, state.player?.profit,
  state.player?.goods?.map(good => [good.pid, good.goodsId, good.num, good.buyPrice, good.cityId])]);
const fingerprint = state => ({ coins: state.player?.coins, profit: state.player?.profit,
  goods: state.player?.goods, cargo: state.cargo });
async function recordOutcome(ctx, outcome) {
  try { return await ctx.onMerchantOutcome?.(outcome); }
  catch { return null; /* 统计记录失败不能改变已经确认的消费结果。 */ }
}
async function markJournal(ctx, key, result) {
  if (result?.recorded === false || !ctx.ledger?.keyRecords?.()[key]?.confirmed) return;
  const record = ctx.ledger.keyRecords()[key];
  ctx.ledger.resolveKey(key, true, { ...record.details, journalRecorded: true });
}
const settingsStamp = ctx => {
  const settings = fullSettings(ctx);
  return JSON.stringify([settings.merchant, settings.resources, settings.loop?.everySeconds, ctx.everyMs]);
};

function quoteReady(config, event, state, market, time, settings) {
  const timing = merchantTiming(config, event, time);
  return market?.cityId === state.cargo?.cityId && natural(market.observedAt) && market.observedAt <= time
    && time - market.observedAt <= settings.quoteMaxAgeSeconds
    && merchantTiming(config, event, market.observedAt).marketEpoch === timing.marketEpoch
    && Array.isArray(market.goods) && market.goods.length > 0
    && market.goods.every(good => positive(good?.goodsId) && positive(good.price) && natural(good.stock))
    && new Set(market.goods.map(good => good.goodsId)).size === market.goods.length;
}

function currentProfitCeiling(config, ship, market, cash, settings, markets) {
  const definitions = new Map(table(config, 'TradeGoodsCfg').map(good => [good.goodsId, good]));
  let capacityYield = 0, cashYield = 0;
  for (const quote of market.goods) {
    const cfg = definitions.get(quote.goodsId);
    if (!positive(cfg?.capacity) || !positive(cfg.unitPrice)) return null;
    // 目的港限制、整数余量和库存均放宽，因此这是旧船收益的上界。
    const history = (Array.isArray(markets) ? markets : []).flatMap(snapshot =>
      Array.isArray(snapshot?.goods) ? snapshot.goods.filter(good => good?.goodsId === quote.goodsId && positive(good.price)) : []);
    const basis = Math.max(cfg.unitPrice, ...history.map(good => good.price));
    const sellPrice = Math.floor(basis * (1 - settings.estimateDiscountPercent / 100));
    const unitProfit = Math.max(0, sellPrice - quote.price) * (1 + ship.profitMargin / 10000);
    capacityYield = Math.max(capacityYield, unitProfit / cfg.capacity);
    cashYield = Math.max(cashYield, unitProfit / quote.price);
  }
  // 每种商品成交向上取整最多再增加一枚币。
  return Math.ceil(Math.min(ship.capacity * capacityYield, cash * cashYield)) + market.goods.length;
}

// 钻石与商会币没有服务端兑换率：配置值仅为用户指定的投资机会成本假设。
// 只计算今日剩余完整往返，不假设明日涨价、库存补满或利润复投。
export function evaluateMerchantUpgrade(config, event, state, market, radar, time, options = {}) {
  const policy = policyOf(options.settings), settings = merchantSettings(policy);
  const skip = reason => ({ kind: 'skip', reason });
  if (!windowOpen(event, time) || state?.period !== event.period) return skip('海商王本期未开放');
  const cargo = state.cargo, player = state.player;
  if (!positive(cargo?.cargoLv) || !positive(cargo.cityId) || !natural(cargo.moveEndTime)
    || cargo.moveEndTime > time || cargo.moveToCityId && cargo.moveToCityId !== cargo.cityId)
    return skip('商船尚未在港，暂不评估升级');
  if (!natural(player?.coins) || !natural(player.profit) || !Array.isArray(player.goods)) return skip('商船资金与利润未确认');
  if (policy.profitLimit > 0 && player.profit >= policy.profitLimit) return skip('已达本期累计利润上限，不升级商船');
  if (player.goods.length) return skip('先完成已有批次交易，再评估新船采购收益');
  if (!positive(policy.upgradeCoinValuePerDiamond) || !positive(policy.upgradeMinReturnPercent) || policy.upgradeMinReturnPercent < 100
    || !positive(policy.upgradeMaxLevel) || !natural(policy.upgradeDailyDiamondLimit)) return skip('商船升级策略参数无效');
  if (cargo.cargoLv >= policy.upgradeMaxLevel) return skip('已达到自动升级等级上限');
  const current = table(config, 'TradeShipCfg').find(ship => ship.lv === cargo.cargoLv);
  const next = table(config, 'TradeShipCfg').find(ship => ship.lv === cargo.cargoLv + 1);
  if (!current || !next || !positive(next.capacity) || !natural(next.profitMargin) || !natural(next.upMoney))
    return skip('下一等级商船配置未确认');
  if (player.profit < next.upMoney) return skip('累计利润尚未达到下一船级解锁门槛');
  if (!Array.isArray(next.upCost) || next.upCost.length !== 2 || next.upCost[0] !== 'RUBY' || !positive(next.upCost[1]))
    return skip('下一船级钻石成本未确认');
  if (!quoteReady(config, event, state, market, time, settings)) return skip('缺少当前刷新周期内亲自读取的可靠本港报价');
  const timing = merchantTiming(config, event, time), actionSeconds = merchantActionSeconds({}, options.actionSeconds);
  if (!timing.tradingOpen || !positive(timing.travelSeconds)) return skip('不在可确认的贸易时段');
  const plannerOptions = { settings, markets: options.markets, actionSeconds };
  const before = planMerchant(config, event, state, market, radar, time, [], plannerOptions);
  const upgraded = { ...state, cargo: { ...cargo, cargoLv: next.lv } };
  const after = planMerchant(config, event, upgraded, market, radar, time, [], plannerOptions);
  if (before.kind !== 'buy' || after.kind !== 'buy' || !Array.isArray(after.purchases) || !after.purchases.length
    || !natural(before.expectedProfit) || !natural(after.expectedProfit))
    return skip('当前报价下缺少可可靠比较的新旧商船采购方案');
  const baselineProfit = before.approximate
    ? currentProfitCeiling(config, current, market, player.coins, settings, options.markets) : before.expectedProfit;
  if (!natural(baselineProfit)) return skip('无法确认当前商船的收益上界');
  // 新船的有界搜索结果是可执行下界；旧船搜索被剪枝时采用上界，避免夸大升级差额。
  const incrementalProfit = after.expectedProfit - baselineProfit;
  if (!positive(incrementalProfit)) return skip('同资金库存下，升级未增加可执行交易的估算利润');
  const definitions = new Map(table(config, 'TradeGoodsCfg').map(good => [good.goodsId, good]));
  const quotes = new Map(market.goods.map(good => [good.goodsId, good]));
  let inventoryRounds = Infinity;
  for (const purchase of after.purchases) {
    const cfg = definitions.get(purchase.goodsId), quote = quotes.get(purchase.goodsId);
    if (!positive(purchase.count) || !natural(cfg?.maxCount) || !natural(quote?.stock) || quote.stock > cfg.maxCount)
      return skip('采购方案对应的共享库存未确认');
    inventoryRounds = Math.min(inventoryRounds, Math.floor((cfg.maxCount - quote.stock) / purchase.count));
  }
  // 每轮包括逐笔买、出航、逐批卖、返港；另留一轮执行升级本身。
  const cycleSeconds = timing.travelSeconds * 2 + (after.purchases.length * 2 + 2) * actionSeconds;
  const investmentDeadline = Math.min(timing.tradeEndTime, event.endTime - settings.liquidationMinutes * 60);
  const timeRounds = Math.max(0, Math.floor((investmentDeadline - time - actionSeconds - 1) / cycleSeconds));
  const remainingRounds = Math.min(timeRounds, inventoryRounds);
  if (!positive(remainingRounds)) return skip('本期剩余窗口不足以完成一轮升级后的采购、出售和返港');
  const diamonds = next.upCost[1], opportunityCost = diamonds * policy.upgradeCoinValuePerDiamond;
  const projectedIncrement = incrementalProfit * remainingRounds;
  const requiredReturn = Math.ceil(opportunityCost * policy.upgradeMinReturnPercent / 100);
  if (![opportunityCost, projectedIncrement, requiredReturn].every(natural)) return skip('升级回本计算超出安全范围');
  const evaluation = { fromLevel: current.lv, toLevel: next.lv, diamonds, incrementalProfit, remainingRounds,
    cycleSeconds, actionSeconds, opportunityCost, projectedIncrement, netEstimatedReturn: projectedIncrement - opportunityCost,
    requiredReturn, coinValuePerDiamond: policy.upgradeCoinValuePerDiamond, minReturnPercent: policy.upgradeMinReturnPercent,
    currentProfit: baselineProfit, upgradedProfit: after.expectedProfit, approximate: !!(before.approximate || after.approximate),
    destination: after.destination, purchases: after.purchases,
    latestActionAt: investmentDeadline - remainingRounds * cycleSeconds - actionSeconds - 1 };
  if (projectedIncrement < requiredReturn) return { ...skip('估算增量收益未达到升级回本门槛'), ...evaluation };
  return { kind: 'upgrade', ...evaluation,
    label: '海商王 · 商船升级 ' + current.lv + '→' + next.lv + '，消耗 ' + diamonds + ' 钻石；'
      + '假设1钻石=' + policy.upgradeCoinValuePerDiamond + '商会币，今日最多' + remainingRounds
      + '轮估算增益 ' + projectedIncrement + '，机会成本 ' + opportunityCost + '，要求回报'
      + policy.upgradeMinReturnPercent + '%（估算假设，非兑换汇率）' };
}

async function readResources(client) {
  const resources = await read(client, 'AllResource');
  if (!Array.isArray(resources?.list) || !resources.list.length
    || resources.list.some(row => !natural(row?.res) || !natural(row.amount))
    || new Set(resources.list.map(row => row.res)).size !== resources.list.length)
    throw Error('升级后的完整资源库存未确认');
  const diamonds = resources.list.find(row => row.res === 4)?.amount;
  if (!natural(diamonds)) throw Error('钻石余额未确认');
  return diamonds;
}

export const merchantUpgradeMatched = (expected, state) => expected?.request === 'TradeCargoUpgradeRequest'
  && state?.period === expected.period && positive(state.cargo?.cargoLv) && state.cargo.cargoLv >= expected.toLevel;

// 独立 scope 使升级预算不足/待确认不阻塞普通跑商。预算与业务确认一起持久化。
export async function runMerchantUpgrade(client, config, ctx, event, state, options = {}) {
  if (!positive(event?.startTime) || !positive(event.period)) return false;
  const scope = scopeOf(event), ledger = ctx.ledger;
  const report = entry => ctx.report({ label: '海商王商船升级', ...entry });
  const skip = reason => { report({ skipped: true, reason }); return false; };
  if (!ledger) return fullSettings(ctx).merchant?.autoUpgrade === true ? skip('账号执行记录不可用，跳过升级') : false;
  const pending = Object.entries(ledger.keyRecords()).find(([, record]) => !record.confirmed && record.details?.scope === scope);
  if (pending) {
    const [key, record] = pending;
    if (!merchantUpgradeMatched(record.details.expected, state)) {
      report({ skipped: true, reason: '前次升级结果待确认，保留钻石预算' }); return true;
    }
    try {
      const afterDiamonds = await readResources(client);
      ledger.resolveKey(key, true);
      const result = await recordOutcome(ctx, { actionKey: key, expected: record.details.expected,
        before: record.details.before, beforeDiamonds: record.details.beforeDiamonds,
        after: fingerprint(state), afterDiamonds, attemptedAt: record.details.attemptedAt,
        status: 'confirmed', time: clock(client), actualDiamondSpent: record.details.expected.diamonds });
      await markJournal(ctx, key, result);
      report({ ok: true, status: 'confirmed', reason: '已按本期船级与完整资源库存确认前次升级' });
      return true;
    } catch (error) { report({ skipped: true, reason: error.message + '，保留升级记录' }); return true; }
  }
  const complete = fullSettings(ctx), policy = policyOf(complete);
  if (policy.autoUpgrade !== true) return false;
  const stamp = settingsStamp(ctx), actor = exactAutomationId(ctx.player?.playerId), world = exactAutomationId(ctx.player?.worldId);
  const active = () => ctx.enabled() && client.connected !== false && settingsStamp(ctx) === stamp
    && exactAutomationId(ctx.player?.playerId) === actor && exactAutomationId(ctx.player?.worldId) === world
    && client.tradeWindow?.period === event.period && client.tradeWindow?.startTime === event.startTime
    && client.tradeWindow?.endTime === event.endTime && windowOpen(event, clock(client));
  if (!actor || !world || !active()) return skip('升级开关、账号或活动状态已变化');
  if (complete.resources?.allowDiamonds !== true) return skip('钻石消费总开关未开启，继续普通贸易');
  const globalLimit = complete.resources.diamondDailyLimit, keep = complete.resources.diamondThreshold;
  if (!natural(globalLimit) || !natural(keep) || !natural(policy.upgradeDailyDiamondLimit)) return skip('钻石预算或保留量未确认');
  const actionSeconds = merchantActionSeconds(complete, Math.max(options.actionSeconds ?? 0, (ctx.everyMs ?? 0) / 1000));
  const evaluationOptions = { settings: policy, markets: options.markets, actionSeconds };
  const initial = evaluateMerchantUpgrade(config, event, state, options.market, options.radar, clock(client), evaluationOptions);
  if (initial.kind !== 'upgrade') return skip(initial.reason);
  const usage = ledger.snapshot().counters;
  if ((usage.diamonds ?? 0) + initial.diamonds > globalLimit
    || (usage.merchantUpgradeDiamonds ?? 0) + initial.diamonds > policy.upgradeDailyDiamondLimit)
    return skip('已达全局或商船升级的每日钻石预算，继续普通贸易');
  let fresh, market, radar, diamonds;
  try {
    fresh = await read(client, 'TradeInfo');
    market = { ...await read(client, 'TradeCity', { cityId: fresh.cargo?.cityId }),
      cityId: fresh.cargo?.cityId, observedAt: clock(client) };
    radar = await read(client, 'TradeGuildRadar');
    diamonds = await readResources(client);
  } catch (error) { return skip('升级复查失败：' + error.message); }
  if (!active()) return skip('升级开关、账号或预算设置已变化');
  const verified = evaluateMerchantUpgrade(config, event, fresh, market, radar, clock(client), evaluationOptions);
  if (verified.kind !== 'upgrade' || signature(state) !== signature(fresh)
    || ['fromLevel', 'toLevel', 'diamonds', 'incrementalProfit', 'remainingRounds', 'projectedIncrement', 'destination']
      .some(key => initial[key] !== verified[key])) return skip('船舶、报价、库存或回本方案已变化，下一轮重算');
  if (diamonds - verified.diamonds < keep) return skip('升级后钻石会低于保留数量，继续普通贸易');
  const expected = { request: 'TradeCargoUpgradeRequest', period: event.period, startTime: event.startTime,
    fromLevel: verified.fromLevel, toLevel: verified.toLevel, diamonds: verified.diamonds };
  const key = scope + ':' + verified.toLevel;
  if (ledger.hasKey(key)) return skip('本期目标船级已有升级记录，继续普通贸易');
  let ticket;
  const before = fingerprint(fresh), attemptedAt = clock(client);
  const notify = outcome => recordOutcome(ctx, { actionKey: key, expected, before, beforeDiamonds: diamonds,
    attemptedAt, time: clock(client), ...outcome });
  try {
    ticket = ledger.reserve({ diamonds: verified.diamonds, merchantUpgradeDiamonds: verified.diamonds },
      { diamonds: globalLimit, merchantUpgradeDiamonds: policy.upgradeDailyDiamondLimit }, {},
      { uniqueKey: key, details: { scope, expected, evaluation: verified, before, beforeDiamonds: diamonds, attemptedAt } });
  } catch (error) { return skip(error.message + '，继续普通贸易'); }
  if (!active() || clock(client) > verified.latestActionAt
    || !quoteReady(config, event, fresh, market, clock(client), merchantSettings(policy))) {
    ledger.cancel(ticket); return skip('升级设置、报价时效或回本窗口已变化');
  }
  let reply;
  try {
    reply = await client.request('TradeCargoUpgradeRequest', {}, 'TradeCargoUpgradeResponse');
  } catch (error) {
    if (error.notSent === true || error.prompt && error.request === 'TradeCargoUpgradeRequest') ledger.cancel(ticket);
    const status = error.notSent === true ? 'cancelled' : error.prompt && error.request === 'TradeCargoUpgradeRequest' ? 'rejected' : 'unknown';
    await notify({ status });
    report({ label: verified.label, ok: false,
      status,
      error: error.message });
    return true;
  }
  let after;
  try {
    if (!positive(reply?.cargo?.cargoLv) || reply.cargo.cargoLv < verified.toLevel) throw Error('升级回执船级未确认');
    after = await read(client, 'TradeInfo');
    if (!merchantUpgradeMatched(expected, after)) throw Error('升级后的本期商船状态未确认');
    const afterDiamonds = await readResources(client);
    ledger.confirm(ticket);
    ledger.resolveKey(key, true, { scope, expected, evaluation: verified, before, beforeDiamonds: diamonds,
      after: fingerprint(after), afterDiamonds, attemptedAt, confirmedAt: clock(client),
      actualDiamondSpent: verified.diamonds });
    const result = await notify({ after: fingerprint(after), afterDiamonds, status: 'confirmed', actualDiamondSpent: verified.diamonds });
    await markJournal(ctx, key, result);
    report({ label: verified.label, ok: true, status: 'confirmed' });
  } catch (error) {
    await notify({ after: after ? fingerprint(after) : undefined, status: 'unknown' });
    report({ label: verified.label, ok: false, status: 'unknown', error: error.message });
  }
  return true;
}
