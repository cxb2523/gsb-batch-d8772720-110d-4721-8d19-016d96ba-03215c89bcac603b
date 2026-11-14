import { checkedAction, clock, dayOf, natural, positive, read, table, waiting, windowOpen } from './activity-actions.mjs';
import {
  beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation,
  confirmOrderMaterialSpends, refreshOrderMaterialSpends
} from './order-reservations.mjs';
import { merchantActionSeconds, merchantTiming } from './merchant-planner.mjs';
import { buyMerchantPointers } from './merchant-strategy.mjs';

const pointer = '海商王加速';
const param = (config, key) => table(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
const fullSettingsOf = ctx => (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) ?? {};
const settingsOf = ctx => fullSettingsOf(ctx).merchant ?? {};
const stampSettings = ctx => {
  const full = fullSettingsOf(ctx), settings = full.merchant ?? {};
  return JSON.stringify([
    settings.autoSpeedUp, settings.speedUpMinProfit, settings.keepPointers, settings.estimateDiscountPercent,
    settings.quoteMaxAgeSeconds, settings.speedUpMode, settings.speedUpMaxPerLeg, full.loop?.everySeconds, ctx.everyMs
    , settings.dailyPointerLimit, settings.refreshWindowMinutes, settings.autoBuyPointers, settings.pointerDailyDiamondLimit, settings.profitLimit, full.resources
  ]);
};
const fingerprint = state => ({ coins: state.player?.coins, profit: state.player?.profit,
  goods: state.player?.goods, cargo: state.cargo });

function tradeDeadline(config, event, time) {
  const hours = String(param(config, '海商王贸易时间')).split('-').map(Number);
  if (hours.length !== 2 || !hours.every(natural) || hours[0] >= hours[1] || hours[1] > 24) return null;
  const start = dayOf(time) * 86400 - 28800;
  if (time < start + hours[0] * 3600 || time >= start + hours[1] * 3600) return null;
  return Math.min(event.endTime, start + hours[1] * 3600);
}

function turnoverMetrics(options, event, time, maxAge) {
  const value = options.metrics ?? options.turnoverSample ?? options;
  const observedAt = Object.hasOwn(value ?? {}, 'turnoverObservedAt') ? value.turnoverObservedAt : value?.observedAt;
  if (!value || value.period !== event.period || value.startTime !== event.startTime
    || !natural(observedAt) || observedAt > time || time - observedAt > maxAge
    || value.turnoverSampleCount != null && (!natural(value.turnoverSampleCount) || value.turnoverSampleCount < 2)
    || value.turnoverSampleSeconds != null && (!natural(value.turnoverSampleSeconds) || value.turnoverSampleSeconds < 60)
    || !Number.isFinite(value.turnoverProfitPerSecond) || value.turnoverProfitPerSecond <= 0
    || value.turnoverProfitPerSecond > Number.MAX_SAFE_INTEGER) return null;
  return { ...value, turnoverObservedAt: observedAt };
}

function targetMarket(config, event, cityId, time, maxAge, options) {
  const epoch = merchantTiming(config, event, time).marketEpoch;
  return [...(Array.isArray(options.markets) ? options.markets : []), options.targetMarket, options.market].filter(market =>
    market?.cityId === cityId && market.period === event.period && market.startTime === event.startTime
    && natural(market.observedAt) && market.observedAt <= time && time - market.observedAt <= maxAge
    && merchantTiming(config, event, market.observedAt).marketEpoch === epoch && Array.isArray(market.goods)
    && market.goods.every(good => positive(good?.goodsId) && positive(good.price))
    && new Set(market.goods.map(good => good.goodsId)).size === market.goods.length
  ).sort((a, b) => b.observedAt - a.observedAt)[0];
}

// 周转收益只来自同一期近期确认成交；未知未来库存、刷新后报价不能产生额外收益。
export function planMerchantSpeed(config, event, state, radar, stock, settings, time, options = {}) {
  const none = reason => ({ kind: 'none', reason });
  const wait = reason => ({ kind: 'wait', reason });
  if (settings?.autoSpeedUp !== true) return none('未开启商会指针加速');
  if (!windowOpen(event, time) || state?.period !== event.period) return none('海商王本期未开放');
  if (settings.profitLimit > 0 && state.player?.profit >= settings.profitLimit) return none('已达本期累计利润上限，不使用或购买指针');
  const cargo = state.cargo;
  if (!cargo || !positive(cargo.cityId) || !positive(cargo.moveToCityId) || cargo.cityId === cargo.moveToCityId
    || !positive(cargo.moveStartTime) || !positive(cargo.moveEndTime) || cargo.moveStartTime > time
    || cargo.moveEndTime <= time) return none('商船当前不在可确认的航程中');
  const deadline = tradeDeadline(config, event, time);
  if (deadline === null) return none('不在开放交易时段');
  const actionSeconds = Math.max(60, Number.isFinite(options.actionSeconds) ? Math.ceil(options.actionSeconds) : 60);
  const mode = settings.speedUpMode ?? 'profit';
  const refreshMode = ['refresh', 'arrival'].includes(mode);
  const timing = merchantTiming(config, event, time);
  const inRefreshWindow = refreshMode && positive(timing.previousRefreshAt) &&
    time < timing.previousRefreshAt + (settings.refreshWindowMinutes ?? 8) * 60;
  const discount = settings.estimateDiscountPercent ?? 10;
  const threshold = settings.speedUpMinProfit ?? 1000;
  const keep = settings.keepPointers ?? 0;
  const maxAge = settings.quoteMaxAgeSeconds ?? 300;
  const maxPerLeg = settings.speedUpMaxPerLeg ?? 4;
  const usedPointers = options.usedPointers ?? 0;
  if (!['deadline', 'profit', 'refresh', 'arrival'].includes(mode) || !natural(discount) || discount >= 100 || !positive(threshold)
    || !natural(keep) || !positive(maxAge) || !positive(maxPerLeg) || !natural(usedPointers))
    return wait('商会指针策略参数无效');
  const fullVoyage = Number(param(config, '海商王行驶时间')) * 60;
  // 成交速率与港口报价的时效不同：样本最多使用两段完整航程（或更长的报价配置），新快照不续期。
  const turnoverMaxAge = positive(fullVoyage) ? Math.max(maxAge, fullVoyage * 2) : maxAge;
  const metrics = mode === 'profit' ? turnoverMetrics(options, event, time, turnoverMaxAge) : null;
  const knownMarket = targetMarket(config, event, cargo.moveToCityId, time, maxAge, options);
  const nextRefreshAt = merchantTiming(config, event, time).nextRefreshAt;
  const totalBatches = Array.isArray(state.player?.goods) ? Math.max(1, state.player.goods.length) : null;
  const refreshPossible = mode === 'profit' && knownMarket && positive(nextRefreshAt)
    && cargo.moveEndTime + (totalBatches ?? 1) * actionSeconds >= nextRefreshAt;
  if (totalBatches !== null && cargo.moveEndTime <= deadline - totalBatches * actionSeconds && !metrics && !refreshPossible && !inRefreshWindow)
    return none('正常到港后仍有逐批成交时间，无需加速');
  if (deadline - time < actionSeconds) return wait('剩余时间不足以预留一轮 ' + actionSeconds + ' 秒成交，不使用指针');
  const perPointer = Number(param(config, '海商王加速时长')) * 60;
  if (!positive(perPointer) || !positive(fullVoyage)) return wait('指针时长或航程配置未确认');
  const dailyLimit = settings.dailyPointerLimit ?? 28;
  if (!natural(dailyLimit) || !natural(options.dailyUsed ?? 0)) return wait('每日指针用量未确认');
  const limit = Math.max(0, Math.min(dailyLimit - (options.dailyUsed ?? 0), Math.floor(fullVoyage / perPointer) - usedPointers, maxPerLeg - usedPointers,
    Math.ceil((cargo.moveEndTime - time) / perPointer)));
  if (!Array.isArray(radar?.radar)) return wait('目的港列表未同步，不使用指针');
  const ports = radar.radar.filter(row => row?.cityId === cargo.moveToCityId);
  if (ports.length !== 1 || !positive(ports[0].cityId)) return wait('目的港资格未确认，不使用指针');
  const ship = table(config, 'TradeShipCfg').find(row => row.lv === cargo.cargoLv);
  const definitions = new Map(table(config, 'TradeGoodsCfg').map(row => [row.goodsId, row]));
  const goods = state.player?.goods;
  if (!ship || !positive(ship.capacity) || !natural(ship.profitMargin) || !Array.isArray(goods)
    || !goods.length || goods.some(row => !row || typeof row !== 'object')
    || new Set(goods.map(row => row.pid)).size !== goods.length)
    return wait('船舶或持货批次未确认，不使用指针');
  const knownQuotes = new Map(knownMarket?.goods.map(good => [good.goodsId, good.price]) ?? []);
  let usedCapacity = 0, estimatedProfit = 0, saleCount = 0, quotedProfit = 0, quotedSaleCount = 0;
  for (const good of goods) {
    const cfg = definitions.get(good.goodsId);
    if (!natural(good.pid) || !positive(good.num) || !positive(good.buyPrice) || !positive(good.cityId)
      || !positive(cfg?.capacity) || !positive(cfg.unitPrice)) return wait('持货成本或舱位未确认，不使用指针');
    usedCapacity += cfg.capacity * good.num;
    // 本港特产不能按基准价假设盈利，来源港批次也不可出售。
    if (good.cityId === cargo.moveToCityId) continue;
    const knownPrice = knownQuotes.get(good.goodsId);
    if (good.goodsId === ports[0].specGoodsId && !positive(knownPrice)) continue;
    // 亲自观察到的低价作为保守上限；即使到港已跨报价有效期，也不恢复为较高基准价。
    // 历史高价不抬高估值，所有目的港价格都仍是带风险折扣的估算。
    const basis = Math.min(cfg.unitPrice, knownQuotes.get(good.goodsId) ?? cfg.unitPrice);
    const price = Math.floor(basis * (100 - discount) / 100);
    const gain = Math.floor(Math.max(0, price - good.buyPrice) * good.num * (1 + ship.profitMargin / 10000));
    estimatedProfit += gain;
    if (gain > 0) saleCount++;
    const quotedGain = positive(knownPrice)
      ? Math.floor(Math.max(0, Math.floor(knownPrice * (100 - discount) / 100) - good.buyPrice) * good.num * (1 + ship.profitMargin / 10000))
      : gain;
    quotedProfit += quotedGain;
    if (quotedGain > 0) quotedSaleCount++;
  }
  if (!natural(usedCapacity) || usedCapacity > ship.capacity || !natural(estimatedProfit) || !natural(quotedProfit))
    return wait('持货舱位或利润计算异常，不使用指针');
  if (!positive(saleCount) && !(refreshPossible && quotedProfit > estimatedProfit))
    return wait('风险折扣后的目的港估值没有可盈利出售的批次');
  const saleSeconds = saleCount * actionSeconds;
  const normalCanSell = positive(saleCount) && cargo.moveEndTime <= deadline - saleSeconds;
  if (normalCanSell && !metrics && !refreshPossible && !inRefreshWindow)
    return none('正常到港后足够完成可盈利批次出售，无需加速');
  if (deadline - time < Math.max(1, saleCount) * actionSeconds)
    return wait('剩余时间不足以逐批完成估算收益中的出售，不使用指针');
  const have = stock instanceof Map ? stock.get(pointer) ?? 0 : null;
  if (!natural(have)) return wait('商会指针库存未同步');
  const available = Math.min(limit, Math.max(0, have - keep));
  if (!available) return wait('留足保留量或本航程用量上限后的商会指针不足');
  if (inRefreshWindow) {
    const useNum = Math.ceil((cargo.moveEndTime - time) / perPointer);
    if (useNum > available) return wait('当前窗口的指针或日用量不足以到港，等待自然航行');
    if (estimatedProfit < threshold * useNum) return wait('刷新加速的保守收益未达到每根指针门槛');
    return { kind: 'speed', useNum, afterEndTime: time, savedSeconds: cargo.moveEndTime - time,
      estimatedIncrementalProfit: estimatedProfit, accelerationReason: 'refreshWindow', saleCount, saleSeconds,
      estimatedProfit, have, deadline, evidenceExpiresAt: Math.min(deadline - saleSeconds,
        timing.previousRefreshAt + (settings.refreshWindowMinutes ?? 8) * 60 - 1),
      expected: { request: 'TradeSpeedRequest', period: event.period, city: cargo.cityId, destination: cargo.moveToCityId,
        moveStartTime: cargo.moveStartTime, beforeEndTime: cargo.moveEndTime, afterEndTime: time, useNum,
        accelerationReason: 'refreshWindow', estimatedIncrementalProfit: estimatedProfit, savedSeconds: cargo.moveEndTime - time },
      label: '海商王 · 刷新窗口使用指针 ×' + useNum + '，到港后重读实价；折扣估算利润 ' + estimatedProfit };
  }
  const candidates = [];
  for (let useNum = 1; useNum <= available; useNum++) {
    const afterEndTime = Math.max(time, cargo.moveEndTime - useNum * perPointer);
    const savedSeconds = cargo.moveEndTime - afterEndTime;
    const refreshSaleSeconds = quotedSaleCount * actionSeconds;
    const captureRefresh = refreshPossible && quotedProfit > estimatedProfit
      && afterEndTime + refreshSaleSeconds < nextRefreshAt
      && afterEndTime + refreshSaleSeconds <= knownMarket.observedAt + maxAge
      && afterEndTime + refreshSaleSeconds <= deadline;
    const candidateSaleCount = captureRefresh ? quotedSaleCount : saleCount;
    const candidateSaleSeconds = candidateSaleCount * actionSeconds;
    const finishAt = afterEndTime + candidateSaleSeconds;
    if (!positive(candidateSaleCount) || finishAt > deadline) continue;
    const deadlineProfit = !normalCanSell && estimatedProfit > 0 ? estimatedProfit : 0;
    // 只有剩余窗口容得下一次采购、完整航行、出售，历史周转速率才形成额外机会。
    const canRepeat = metrics && deadline - finishAt >= fullVoyage + actionSeconds * 3;
    const turnoverProfit = canRepeat ? Math.floor(metrics.turnoverProfitPerSecond * Math.min(savedSeconds, deadline - finishAt)) : 0;
    const refreshProfit = captureRefresh ? quotedProfit - estimatedProfit : 0;
    const incrementalProfit = deadlineProfit + turnoverProfit + refreshProfit;
    if (!natural(incrementalProfit) || !positive(incrementalProfit) || incrementalProfit / useNum < threshold) continue;
    const accelerationReason = refreshProfit > 0 ? 'refresh' : turnoverProfit > 0 ? 'turnover' : 'deadline';
    candidates.push({ useNum, afterEndTime, savedSeconds, estimatedIncrementalProfit: incrementalProfit,
      accelerationReason, saleCount: candidateSaleCount, saleSeconds: candidateSaleSeconds,
      estimatedProfit: captureRefresh ? quotedProfit : estimatedProfit,
      evidenceExpiresAt: Math.min(deadline,
        turnoverProfit > 0 ? metrics.turnoverObservedAt + turnoverMaxAge : deadline,
        refreshProfit > 0 ? Math.min(knownMarket.observedAt + maxAge, nextRefreshAt) : deadline) });
    // 没有周转或刷新证据时，抢救截止只用能完成成交的最少数量。
    if (!metrics && !refreshPossible || mode === 'deadline') break;
  }
  if (!candidates.length) return wait('指针不足、成交窗口或收益阈值不满足，不盲目部分加速');
  candidates.sort((a, b) => b.estimatedIncrementalProfit - a.estimatedIncrementalProfit || a.useNum - b.useNum);
  const best = candidates[0], { useNum, savedSeconds, estimatedIncrementalProfit, accelerationReason } = best;
  const reasonLabel = { deadline: '抢救截止成交', turnover: '近期确认成交速率评估周转', refresh: '抢在刷新前兑现已观察报价' }[accelerationReason];
  return { kind: 'speed', ...best, have, deadline,
    expected: { request: 'TradeSpeedRequest', period: event.period, city: cargo.cityId,
      destination: cargo.moveToCityId, moveStartTime: cargo.moveStartTime,
      beforeEndTime: cargo.moveEndTime, afterEndTime: best.afterEndTime, useNum,
      accelerationReason, estimatedIncrementalProfit, savedSeconds },
    label: '海商王 · 使用商会指针 ×' + useNum + '，预留 ' + best.saleSeconds + ' 秒完成 ' + best.saleCount + ' 批成交；'
      + reasonLabel + '，提前 ' + savedSeconds + ' 秒，估算增益 ' + estimatedIncrementalProfit + '；'
      + (knownMarket ? '结合到访低价的' : '基准价') + '折扣估算利润 '
      + best.estimatedProfit + '（非目的港实时报价）' };
}

// 自然到港不能作为未知加速请求的成功证据，必须确认同一航程被提前。
export function merchantSpeedMatches(expected, snapshot, time) {
  const cargo = snapshot?.cargo;
  if (expected?.request !== 'TradeSpeedRequest' || !cargo || !positive(expected.beforeEndTime)
    || !natural(expected.afterEndTime) || expected.afterEndTime >= expected.beforeEndTime
    || !positive(expected.moveStartTime) || cargo.moveStartTime !== expected.moveStartTime) return false;
  if (cargo.cityId === expected.destination && time < expected.beforeEndTime
    && (!cargo.moveToCityId || cargo.moveToCityId === expected.destination)) return true;
  return cargo.cityId === expected.city && cargo.moveToCityId === expected.destination
    && positive(cargo.moveEndTime) && cargo.moveEndTime < expected.beforeEndTime
    && cargo.moveEndTime <= expected.afterEndTime;
}

async function readStock(client) {
  const response = await read(client, 'AllItem'), stock = new Map();
  if (!Array.isArray(response?.items)) throw Error('商会指针完整库存未同步');
  for (const row of response.items) {
    if (typeof row?.itemId !== 'string' || !row.itemId || stock.has(row.itemId) || !natural(row.num))
      throw Error('商会指针完整库存记录无效');
    stock.set(row.itemId, row.num);
  }
  return stock;
}

export async function runMerchantSpeed(client, config, ctx, event, state) {
  const settings = settingsOf(ctx);
  if (settings.autoSpeedUp !== true || !(state?.cargo?.moveEndTime > clock(client))) return false;
  const initialSettings = stampSettings(ctx);
  const actor = JSON.stringify([ctx.player?.playerId, ctx.player?.worldId, ctx.player?.guildId]);
  const allowed = () => ctx.enabled() && client.connected !== false && settingsOf(ctx).autoSpeedUp === true
    && stampSettings(ctx) === initialSettings
    && JSON.stringify([ctx.player?.playerId, ctx.player?.worldId, ctx.player?.guildId]) === actor
    && client.tradeWindow?.period === event.period && client.tradeWindow?.startTime === event.startTime
    && client.tradeWindow?.endTime === event.endTime
    && windowOpen(event, clock(client)) && tradeDeadline(config, event, clock(client)) !== null;
  if (!allowed()) return false;
  const exploratoryLeg = Object.values(ctx.ledger?.keyRecords() ?? {}).some(record => {
    const expected = record.details?.expected, cargo = state.cargo;
    return record.confirmed && record.details?.scope === 'merchant:' + event.startTime + ':' + event.period
      && expected?.request === 'TradeMoveRequest' && expected.exploration === true
      && expected.city === cargo.cityId && expected.destination === cargo.moveToCityId
      && Math.abs(expected.start - cargo.moveStartTime) <= 2;
  });
  if (exploratoryLeg) return false;
  // 不需要加速时不查询库存；其余缺失输入会在获取新快照后校验。
  const actionSeconds = () => merchantActionSeconds(fullSettingsOf(ctx), (ctx.everyMs ?? 0) / 1000);
  const metricsOf = () => typeof ctx.getMerchantMetrics === 'function' ? ctx.getMerchantMetrics()
    : typeof ctx.merchantMetrics === 'function' ? ctx.merchantMetrics() : ctx.merchantMetrics;
  const options = () => {
    const records = Object.values(ctx.ledger?.keyRecords() ?? {}).filter(record => record.confirmed);
    const usedPointers = records.reduce((sum, record) => {
      const e = record.details?.expected, cargo = state.cargo;
      return record.details?.scope === 'merchant:' + event.startTime + ':' + event.period && e?.request === 'TradeSpeedRequest'
        && e.period === event.period && e.city === cargo.cityId && e.destination === cargo.moveToCityId
        && e.moveStartTime === cargo.moveStartTime && positive(e.useNum) ? sum + e.useNum : sum;
    }, 0);
    return { actionSeconds: actionSeconds(), metrics: metricsOf(), usedPointers,
      dailyUsed: Math.max(ctx.ledger?.snapshot().counters?.merchantPointers ?? 0,
        Object.values(ctx.ledger?.keyRecords() ?? {}).reduce((sum, record) => {
          const e = record.details?.expected, at = record.details?.attemptedAt;
          return e?.request === 'TradeSpeedRequest' && positive(at) && dayOf(at) === dayOf(clock(client)) && positive(e.useNum) ? sum + e.useNum : sum;
        }, 0)),
      markets: records.map(record => record.details?.merchantMarket).filter(Boolean) };
  };
  const early = planMerchantSpeed(config, event, state, null, null, settings, clock(client), options());
  if (early.kind === 'none') return false;
  const skip = reason => { waiting(ctx, reason); return true; };
  if (!ctx.ledger) return skip('账号执行记录不可用，不使用指针');
  try {
    await refreshOrderMaterialSpends(client, ctx.player, { enabled: allowed });
    const radar = await read(client, 'TradeGuildRadar');
    const stock = await readStock(client);
    if (!allowed()) return skip('加速开关或活动状态已变化');
    const plan = planMerchantSpeed(config, event, state, radar, stock, settings, clock(client), options());
    if (plan.kind === 'wait' && settings.autoBuyPointers === true) {
      const desired = planMerchantSpeed(config, event, state, radar, new Map([[pointer, (settings.keepPointers ?? 0) + (settings.speedUpMaxPerLeg ?? 4)]]), settings, clock(client), options());
      if (desired.kind === 'speed' && (stock.get(pointer) ?? 0) < desired.useNum + (settings.keepPointers ?? 0) &&
        await buyMerchantPointers(client, config, ctx, event, state, desired.useNum + (settings.keepPointers ?? 0),
          () => allowed() && clock(client) <= desired.evidenceExpiresAt)) return true;
    }
    if (plan.kind !== 'speed') return plan.kind === 'none' ? false : skip(plan.reason);
    const fresh = await read(client, 'TradeInfo');
    const freshRadar = await read(client, 'TradeGuildRadar');
    const freshStock = await readStock(client);
    if (!allowed()) return skip('加速开关或活动状态已变化');
    const verified = planMerchantSpeed(config, event, fresh, freshRadar, freshStock, settings, clock(client), options());
    const sameVoyage = verified.kind === 'speed' &&
      ['period', 'city', 'destination', 'moveStartTime', 'beforeEndTime', 'useNum']
        .every(key => plan.expected[key] === verified.expected[key]);
    // 立即到港时 afterEndTime 会随读取期间流逝的秒数变化，执行新快照即可。
    if (!sameVoyage
      || JSON.stringify(fingerprint(state)) !== JSON.stringify(fingerprint(fresh))
      || verified.estimatedProfit !== plan.estimatedProfit || verified.saleCount !== plan.saleCount
      || verified.saleSeconds !== plan.saleSeconds || verified.accelerationReason !== plan.accelerationReason
      || verified.estimatedIncrementalProfit !== plan.estimatedIncrementalProfit)
      return skip('航程、库存或加速收益已变化，下一轮重算');
    const expected = verified.expected;
    const metricStamp = JSON.stringify(metricsOf());
    const evidenceValid = () => clock(client) <= verified.evidenceExpiresAt && JSON.stringify(metricsOf()) === metricStamp;
    let material;
    await checkedAction(ctx, {
      scope: 'merchant:' + event.startTime + ':' + event.period,
      before: fingerprint(fresh), expected, label: verified.label,
      retainEvidence: true, attemptedAt: clock(client), onOutcome: ctx.onMerchantOutcome,
      counters: { merchantPointers: verified.useNum }, limits: { merchantPointers: settings.dailyPointerLimit ?? 28 },
      allowed: () => allowed() && clock(client) <= verified.deadline - verified.saleSeconds
        && evidenceValid(),
      matches: (e, value) => merchantSpeedMatches(e, value, clock(client)),
      send: async () => {
        try {
          if (!allowed() || clock(client) > verified.deadline - verified.saleSeconds
            || !evidenceValid()) throw Error('加速开关、收益证据或成交窗口已变化');
          confirmOrderMaterialSpends(ctx.player, freshStock, [pointer]);
          material = beginOrderMaterialSpend(ctx.player,
            [{ id: pointer, have: verified.have, need: verified.useNum }], '海商王指针加速', {
              operation: { verify: async next => {
                const current = await read(next, 'TradeInfo');
                return next.tradeWindow?.startTime === event.startTime && current.period === event.period
                  && merchantSpeedMatches(expected, current, clock(next));
              } }
            });
          if (!allowed() || clock(client) > verified.deadline - verified.saleSeconds
            || !evidenceValid()) throw Error('加速开关、收益证据或成交窗口已变化');
        } catch (error) {
          cancelOrderMaterialSpend(material);
          throw Object.assign(error, { released: true });
        }
        try {
          return await client.request('TradeSpeedRequest', { useNum: verified.useNum }, 'TradeSpeedResponse');
        } catch (error) {
          if (error.notSent === true || error.prompt && error.request === 'TradeSpeedRequest') {
            cancelOrderMaterialSpend(material);
            if (error.notSent === true) error.released = true;
          }
          throw error;
        }
      },
      accept: reply => natural(reply?.moveEndTime) && reply.moveEndTime <= expected.afterEndTime
        && reply.moveEndTime < expected.beforeEndTime,
      inspect: async () => {
        const current = await read(client, 'TradeInfo');
        if (current.period !== event.period) return null;
        if (merchantSpeedMatches(expected, current, clock(client))) confirmOrderMaterialOperation(material);
        return fingerprint(current);
      }
    });
    // 业务证据在前，完整库存回读在后；库存下降本身不代表加速成功。
    await refreshOrderMaterialSpends(client, ctx.player, { enabled: () => client.connected !== false });
    return true;
  } catch (error) {
    return skip(error.message);
  }
}
