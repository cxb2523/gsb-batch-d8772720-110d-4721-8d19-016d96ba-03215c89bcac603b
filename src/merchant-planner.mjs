// 海商王的纯决策层。不查询异地港口；远端价格永远是带风险折扣的估算。
const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => natural(value) && value > 0;
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const param = (config, key) => rows(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
const dayOf = time => Math.floor((time + 28800) / 86400);
const safe = value => Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

export const MERCHANT_DEFAULTS = Object.freeze({
  quoteMaxAgeSeconds: 300,
  estimateDiscountPercent: 10,
  refreshWaitSeconds: 120,
  liquidationMinutes: 120,
  maxLossPercent: 0,
  minExpectedProfit: 1,
  autoSpeedUp: false,
  speedUpMinProfit: 1000,
  keepPointers: 0,
  speedUpMode: 'profit', speedUpMaxPerLeg: 4, monitorSeconds: 60,
  refreshWindowMinutes: 8, dailyPointerLimit: 28, autoBuyPointers: false, pointerDailyDiamondLimit: 0,
  profitLimit: 0, firstDepartureMode: 'smart', firstDepartureTime: '10:00', firstDepartureWaitMinutes: 29,
  autoUpgrade: false, upgradeCoinValuePerDiamond: 100, upgradeMinReturnPercent: 150,
  upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300
});

export function merchantSettings(input = {}) {
  const output = { ...MERCHANT_DEFAULTS };
  for (const [key, fallback] of Object.entries(output)) {
    const value = input?.[key];
    if (typeof fallback === 'boolean') output[key] = typeof value === 'boolean' ? value : fallback;
    else if (key === 'speedUpMode') output[key] = ['deadline', 'profit', 'refresh', 'arrival'].includes(value) ? value : fallback;
    else if (key === 'firstDepartureMode') output[key] = ['smart', 'time'].includes(value) ? value : fallback;
    else if (key === 'firstDepartureTime') output[key] = typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    else if (natural(value)) output[key] = value;
  }
  output.estimateDiscountPercent = Math.min(100, output.estimateDiscountPercent);
  output.maxLossPercent = Math.min(100, output.maxLossPercent);
  output.monitorSeconds = Math.max(10, Math.min(300, output.monitorSeconds));
  return output;
}

// 周期动作每轮只执行一笔，使用配置与实际轮询间隔中较慢者，并保留最低一分钟余量。
export function merchantActionSeconds(settings = {}, intervalSeconds = 0) {
  const configured = settings?.loop?.everySeconds;
  return Math.max(60, positive(configured) ? configured : 0, positive(intervalSeconds) ? intervalSeconds : 0);
}

export function merchantTiming(config, event, time) {
  const hours = String(param(config, '海商王贸易时间')).split('-').map(Number);
  const travelMinutes = Number(param(config, '海商王行驶时间'));
  const refresh = [...new Set(String(param(config, '海商王刷新时间')).split(',').map(Number))]
    .filter(hour => natural(hour) && hour < 24).sort((a, b) => a - b);
  const day = dayOf(time), midnight = day * 86400 - 28800;
  const validHours = hours.length === 2 && hours.every(natural) && hours[0] < hours[1] && hours[1] <= 24;
  const tradeStartTime = validHours ? midnight + hours[0] * 3600 : null;
  const tradeEndTime = validHours ? Math.min(midnight + hours[1] * 3600, event?.endTime ?? Infinity) : null;
  const candidates = [-1, 0, 1].flatMap(offset => refresh.map(hour => midnight + offset * 86400 + hour * 3600));
  const previousRefreshAt = candidates.filter(at => at <= time).at(-1) ?? null;
  const nextRefreshAt = candidates.find(at => at > time) ?? null;
  return {
    travelSeconds: positive(travelMinutes) ? travelMinutes * 60 : null,
    tradeStartTime,
    tradeEndTime,
    tradingOpen: validHours && time >= tradeStartTime && time < tradeEndTime,
    nextRefreshAt,
    previousRefreshAt,
    marketEpoch: previousRefreshAt === null ? day + ':unknown' : dayOf(previousRefreshAt) + ':' + ((previousRefreshAt + 28800) % 86400) / 3600
  };
}

// 二元分组有界背包；两项资源同时做 Pareto 剪枝。小状态空间精确求解，
// 大状态空间以剩余资源的收益上界保留有限候选，并明确返回 approximate。
export function optimizePurchasePlan(offers, capacity, cash, { maxStates = 2048 } = {}) {
  if (!natural(capacity) || !natural(cash)) return { purchases: [], profit: 0, cost: 0, capacity: 0, approximate: false };
  const items = offers.filter(o => o && positive(o.goodsId) && positive(o.price) && positive(o.capacity) &&
    positive(o.count) && Number.isFinite(o.unitProfit) && o.unitProfit > 0)
    .map(o => ({ ...o, count: Math.min(o.count, Math.floor(capacity / o.capacity), Math.floor(cash / o.price)) }))
    .filter(o => o.count > 0).sort((a, b) => a.goodsId - b.goodsId);
  const bundles = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    for (let count = 1, left = item.count; left > 0; count *= 2) {
      const num = Math.min(count, left);
      bundles.push({ index, count: num, space: num * item.capacity, cost: num * item.price, gain: num * item.unitProfit });
      left -= num;
    }
  }
  const density = new Array(bundles.length + 1).fill(0), roi = [...density];
  for (let i = bundles.length - 1; i >= 0; i--) {
    density[i] = Math.max(density[i + 1], bundles[i].gain / bundles[i].space);
    roi[i] = Math.max(roi[i + 1], bundles[i].gain / bundles[i].cost);
  }
  let states = [{ space: 0, cost: 0, gain: 0, path: null }], approximate = false;
  const limit = Math.max(32, Math.min(16384, natural(maxStates) ? maxStates : 2048));
  for (let step = 0; step < bundles.length; step++) {
    const bundle = bundles[step], candidates = [...states];
    for (const old of states) {
      const space = old.space + bundle.space, cost = old.cost + bundle.cost;
      if (space > capacity || cost > cash) continue;
      candidates.push({ space, cost, gain: old.gain + bundle.gain,
        path: { previous: old.path, index: bundle.index, count: bundle.count } });
    }
    candidates.sort((a, b) => a.space - b.space || a.cost - b.cost || b.gain - a.gain);
    const costs = [...new Set(candidates.map(s => s.cost))].sort((a, b) => a - b);
    const indices = new Map(costs.map((cost, i) => [cost, i + 1]));
    const best = new Float64Array(costs.length + 1).fill(-Infinity), frontier = [];
    for (const candidate of candidates) {
      const index = indices.get(candidate.cost);
      let previous = -Infinity;
      for (let i = index; i > 0; i -= i & -i) previous = Math.max(previous, best[i]);
      if (previous >= candidate.gain) continue;
      frontier.push(candidate);
      for (let i = index; i < best.length; i += i & -i) best[i] = Math.max(best[i], candidate.gain);
    }
    if (frontier.length > limit) {
      approximate = true;
      const bound = state => state.gain + Math.min((capacity - state.space) * density[step + 1], (cash - state.cost) * roi[step + 1]);
      frontier.sort((a, b) => bound(b) - bound(a) || b.gain - a.gain || a.cost - b.cost || a.space - b.space);
      frontier.length = limit;
    }
    states = frontier;
  }
  states.sort((a, b) => b.gain - a.gain || a.cost - b.cost || a.space - b.space);
  const best = states[0], counts = new Array(items.length).fill(0);
  for (let path = best.path; path; path = path.previous) counts[path.index] += path.count;
  const purchases = items.flatMap((item, i) => counts[i] ? [{ ...item, count: counts[i], gain: Math.ceil(item.unitProfit * counts[i]) }] : []);
  return { purchases, profit: purchases.reduce((sum, item) => sum + item.gain, 0), cost: best.cost, capacity: best.space, approximate };
}

function validHistory(config, event, snapshot, time, settings, currentEpoch) {
  return snapshot && snapshot.period === event.period && snapshot.startTime === event.startTime &&
    positive(snapshot.cityId) && natural(snapshot.observedAt) && snapshot.observedAt <= time &&
    time - snapshot.observedAt <= settings.quoteMaxAgeSeconds && Array.isArray(snapshot.goods) &&
    snapshot.goods.every(g => g && positive(g.goodsId) && positive(g.price)) &&
    merchantTiming(config, event, snapshot.observedAt).marketEpoch === currentEpoch &&
    new Set(snapshot.goods.map(g => g.goodsId)).size === snapshot.goods.length;
}

function portsAndHistory(config, event, radar, snapshots, time, settings, epoch) {
  const ports = new Map(), conflicting = new Set(), history = new Map();
  for (const port of Array.isArray(radar?.radar) ? radar.radar : []) {
    if (!positive(port?.cityId)) continue;
    const old = ports.get(port.cityId);
    if (old && (old.specGoodsId !== port.specGoodsId || old.rareGoodsId !== port.rareGoodsId)) conflicting.add(port.cityId);
    else ports.set(port.cityId, port);
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (snapshot?.period !== event.period || snapshot.startTime !== event.startTime || !positive(snapshot.cityId) ||
      !natural(snapshot.observedAt) || snapshot.observedAt > time) continue;
    // 当前港口列表是航行权限的依据；历史记录不能自行增加目的港。
    if (!ports.has(snapshot.cityId)) continue;
    if (!validHistory(config, event, snapshot, time, settings, epoch)) continue;
    if (!history.has(snapshot.cityId) || history.get(snapshot.cityId).observedAt < snapshot.observedAt) history.set(snapshot.cityId, snapshot);
  }
  for (const city of conflicting) { ports.delete(city); history.delete(city); }
  return { ports: [...ports.values()].sort((a, b) => a.cityId - b.cityId), history };
}

function expectedPrice(config, event, definition, port, history, time, arrival, settings, epoch) {
  if (!positive(definition?.unitPrice)) return null;
  const snapshot = history.get(port.cityId), quote = snapshot?.goods.find(g => g.goodsId === definition.goodsId);
  const known = positive(quote?.price);
  // 特产港不凭正常价推断该特产有利可图；有亲自观察的报价时仍可计算。
  if (!known && port.specGoodsId === definition.goodsId) return null;
  const stillFresh = known && arrival - snapshot.observedAt <= settings.quoteMaxAgeSeconds &&
    merchantTiming(config, event, arrival).marketEpoch === epoch;
  const basis = known ? stillFresh ? quote.price : Math.min(quote.price, definition.unitPrice) : definition.unitPrice;
  const price = Math.floor(basis * (1 - settings.estimateDiscountPercent / 100));
  return positive(price) ? { price, estimated: true, source: known ? '到访报价估算' : '正常价折扣估算', observedAt: known ? snapshot.observedAt : null } : null;
}

const profit = (price, batch, ship) => {
  const difference = (price - batch.buyPrice) * batch.num;
  return difference > 0 ? Math.ceil(difference * (1 + ship.profitMargin / 10000)) : difference;
};

export function planMerchant(config, event, state, market, radar, time, visited = [], options = {}) {
  const settings = merchantSettings(options.settings), timing = merchantTiming(config, event, time);
  const actionSeconds = merchantActionSeconds({}, options.actionSeconds);
  const liquidation = positive(event?.endTime) && event.endTime - time <= settings.liquidationMinutes * 60;
  const mode = liquidation ? 'FINAL_LIQUIDATION' : 'TRADE';
  const wait = (reason, extra = {}) => ({ kind: 'wait', mode, reason, ...extra });
  if (!positive(event?.startTime) || !positive(event.endTime) || event.startTime > time || event.endTime <= time ||
    state?.period !== event.period || !timing.tradingOpen) return wait('等待本期开放交易时段');
  const cargo = state.cargo, player = state.player;
  if (!positive(cargo?.cityId) || !positive(cargo.cargoLv) || !natural(cargo.moveEndTime)) return wait('商船位置未同步');
  if (cargo.moveEndTime > time || (cargo.moveToCityId && cargo.moveToCityId !== cargo.cityId)) return wait('商船航行中，等待到港确认');
  const ship = rows(config, 'TradeShipCfg').find(row => row.lv === cargo.cargoLv);
  if (!positive(ship?.capacity) || !natural(ship.profitMargin) || !natural(player?.coins) || !natural(player.profit) ||
    !Array.isArray(player.goods) || !Array.isArray(market?.goods)) return wait('商船、货舱或本港报价未同步');
  if (market.observedAt !== undefined && (!natural(market.observedAt) || market.observedAt > time ||
    time - market.observedAt > settings.quoteMaxAgeSeconds || merchantTiming(config, event, market.observedAt).marketEpoch !== timing.marketEpoch))
    return wait('本港报价已过期，等待重新读取');
  const definitions = new Map(rows(config, 'TradeGoodsCfg').map(row => [row.goodsId, row]));
  if (market.goods.some(g => !g || !positive(g.goodsId)) || player.goods.some(g => !g) ||
    new Set(market.goods.map(g => g.goodsId)).size !== market.goods.length ||
    new Set(player.goods.map(g => g.pid)).size !== player.goods.length || player.goods.some(g =>
      !natural(g.pid) || !positive(g.num) || !positive(g.buyPrice) || !positive(g.cityId) || !positive(definitions.get(g.goodsId)?.capacity) ||
      !safe(g.num * g.buyPrice) || !safe(g.num * definitions.get(g.goodsId).capacity))) return wait('货物批次、港口报价或舱位未确认');
  const occupied = player.goods.reduce((sum, g) => sum + g.num * definitions.get(g.goodsId).capacity, 0);
  if (!natural(occupied) || occupied > ship.capacity) return wait('船舱容量与持货批次不一致');
  const free = ship.capacity - occupied, quotes = new Map(market.goods.map(row => [row.goodsId, row]));
  const { ports, history } = portsAndHistory(config, event, radar, options.markets, time, settings, timing.marketEpoch);
  const arrival = time + (timing.travelSeconds ?? Infinity);
  const canArrive = count => positive(timing.travelSeconds) && arrival + Math.max(1, count) * actionSeconds < timing.tradeEndTime;
  const destinations = ports.filter(port => port.cityId !== cargo.cityId);
  const estimates = new Map();
  const estimate = (definition, port) => {
    const key = port.cityId + ':' + definition.goodsId;
    if (!estimates.has(key)) estimates.set(key, expectedPrice(config, event, definition, port, history, time, arrival, settings, timing.marketEpoch));
    return estimates.get(key);
  };
  const batchAt = (batch, port) => {
    if (batch.cityId === port.cityId) return null;
    const estimated = estimate(definitions.get(batch.goodsId), port);
    if (!estimated) return null;
    const gain = profit(estimated.price, batch, ship);
    if (!safe(gain)) return null;
    return { batch, ...estimated, gain, space: batch.num * definitions.get(batch.goodsId).capacity };
  };
  const offersAt = (port, reset = false) => market.goods.flatMap(quote => {
    const definition = definitions.get(quote.goodsId), target = definition && estimate(definition, port);
    if (!definition || !positive(quote.price) || !natural(quote.stock) || !positive(definition.capacity) || !natural(definition.maxCount) ||
      quote.stock > definition.maxCount || !target || target.price <= quote.price) return [];
    const count = reset ? definition.maxCount : definition.maxCount - quote.stock;
    if (!positive(count)) return [];
    return [{ goodsId: quote.goodsId, price: quote.price, capacity: definition.capacity, count,
      expectedPrice: target.price, unitProfit: (target.price - quote.price) * (1 + ship.profitMargin / 10000), estimated: true }];
  });
  const cache = new Map();
  const optimize = (port, capacity, cash, reset = false) => {
    const offers = offersAt(port, reset), key = JSON.stringify([offers, capacity, cash]);
    if (!cache.has(key)) cache.set(key, optimizePurchasePlan(offers, capacity, cash));
    return cache.get(key);
  };
  const lossAllowed = (batch, gain) => liquidation && settings.maxLossPercent > 0 && gain < 0 &&
    -gain <= batch.buyPrice * batch.num * settings.maxLossPercent / 100;
  const saleAllowed = (batch, gain) => gain > 0 || (liquidation && gain === 0) || lossAllowed(batch, gain);
  const eligible = route => {
    if (!visited.includes(route.port.cityId)) return true;
    const snapshot = history.get(route.port.cityId);
    if (!snapshot || arrival - snapshot.observedAt > settings.quoteMaxAgeSeconds ||
      merchantTiming(config, event, arrival).marketEpoch !== timing.marketEpoch) return false;
    return route.batches.some(row => {
      const local = quotes.get(row.batch.goodsId)?.price;
      return row.gain > 0 && positive(local) && row.price > local;
    });
  };
  // 指针不足时仍可自然航行并出售高价值子集，不能因其余批次来不及出售而放弃整条路线。
  // 规划从不依赖尚未确认能够使用的指针；来源与止损不满足的批次继续保留。
  const saleSlots = Math.max(0, Math.floor((timing.tradeEndTime - arrival - 1) / actionSeconds));
  const bestBatches = (batches, slots) => [...batches].sort((a, b) => b.gain - a.gain || b.space - a.space || a.batch.pid - b.batch.pid)
    .slice(0, Math.max(0, slots));
  const cargoRoutes = destinations.map(port => {
    const allBatches = player.goods.map(batch => batchAt(batch, port)).filter(row => row && saleAllowed(row.batch, row.gain));
    const batches = bestBatches(allBatches, saleSlots);
    return { port, allBatches, batches, cargoProfit: batches.reduce((sum, row) => sum + row.gain, 0),
      released: batches.reduce((sum, row) => sum + row.space, 0),
      matched: batches.filter(row => port.rareGoodsId === row.batch.goodsId).length };
  }).filter(route => canArrive(route.batches.length) && eligible(route));

  // 逐批处理来源港与买入成本；比较出售前后的整船方案，不能拿另一个港口的单批最优价
  // 阻止当前出售，再让其余整船货物选择完全不同的目的港。
  const holdRoutes = cargoRoutes.map(route => {
    const purchase = liquidation ? { purchases: [], profit: 0 } : optimize(route.port, free, player.coins);
    const gain = canArrive(route.batches.length + purchase.purchases.length * 2 + 1) ? purchase.profit : 0;
    return { route, total: route.cargoProfit + gain, actionable: route.batches.length > 0 || gain > 0 };
  }).filter(route => route.actionable);
  const bestHold = Math.max(...holdRoutes.map(route => route.total));
  const sales = [];
  for (const batch of player.goods) {
    const quote = quotes.get(batch.goodsId);
    if (batch.cityId === cargo.cityId || !positive(quote?.price)) continue;
    const gain = profit(quote.price, batch, ship);
    if (!safe(gain) || !saleAllowed(batch, gain)) continue;
    let bestAfterSale = 0, opportunity = 0;
    const releasedCash = player.coins + batch.buyPrice * batch.num + gain;
    for (const route of cargoRoutes) {
      const remaining = route.allBatches.filter(row => row.batch.pid !== batch.pid);
      const noPurchase = bestBatches(remaining, saleSlots - 1);
      if (noPurchase.length && canArrive(noPurchase.length + 1))
        bestAfterSale = Math.max(bestAfterSale, noPurchase.reduce((sum, row) => sum + row.gain, 0));
      if (liquidation || !natural(releasedCash) || !canArrive(3)) continue;
      const replacement = optimize(route.port, free + batch.num * definitions.get(batch.goodsId).capacity, releasedCash);
      const baseline = optimize(route.port, free, player.coins);
      const remainingBatches = bestBatches(remaining, saleSlots - replacement.purchases.length * 2 - 2);
      // 机会收益只计出售本批带来的增量，且包含本次卖出、后续采购和其余批次出售的时间。
      if (canArrive(remainingBatches.length + replacement.purchases.length * 2 + 2)) {
        bestAfterSale = Math.max(bestAfterSale, remainingBatches.reduce((sum, row) => sum + row.gain, 0) + replacement.profit);
        opportunity = Math.max(opportunity, replacement.profit - baseline.profit);
      }
    }
    const timeCost = Math.max(0, gain) * (timing.travelSeconds ?? 0) / Math.max(1, timing.tradeEndTime - time);
    if (bestHold > gain + bestAfterSale + timeCost + settings.minExpectedProfit) continue;
    sales.push({ batch, price: quote.price, gain, opportunity, future: bestHold, afterSale: bestAfterSale });
  }
  sales.sort((a, b) => b.gain - a.gain || a.batch.pid - b.batch.pid);
  if (sales.length) {
    const sale = sales[0], batch = sale.batch;
    return { kind: 'sell', mode, city: cargo.cityId, pid: batch.pid, goodsId: batch.goodsId, count: batch.num,
      price: sale.price, gain: sale.gain, expectedProfit: sale.gain, estimated: false,
      label: (sale.gain < 0 ? '清仓出售' : '出售') + definitions.get(batch.goodsId).itemName + ' ×' + batch.num +
        '，本港报价收益 ' + sale.gain + '；释放舱位 ' + batch.num * definitions.get(batch.goodsId).capacity +
        (sale.opportunity > 0 ? '，再采购预计收益 ' + sale.opportunity : '') };
  }
  // 一程未必出售全部持货；具体路线已按可出售批次数检查，不能用无关滞销批次阻塞它。
  if (!canArrive(1)) return wait('本时段剩余时间不足以航行并完成出售', { mode: 'FINAL_LIQUIDATION' });
  const buildRoutes = (reset = false) => cargoRoutes.map(route => {
    const purchase = liquidation ? { purchases: [], profit: 0, approximate: false } : optimize(route.port, free, player.coins, reset);
    const purchases = canArrive(route.batches.length + purchase.purchases.length * 2 + 1) ? purchase : { purchases: [], profit: 0, approximate: false };
    return { ...route, ...purchases, totalProfit: route.cargoProfit + purchases.profit };
  }).sort((a, b) => b.totalProfit - a.totalProfit || b.released - a.released || b.matched - a.matched || a.port.cityId - b.port.cityId);
  const routes = buildRoutes(), best = routes[0];

  // 刷新会改变价格，不能把补货当成确定收益：仅以本港已见折价做再折扣估算。
  const refreshIn = timing.nextRefreshAt === null ? Infinity : timing.nextRefreshAt - time;
  if (!liquidation && free > 0 && refreshIn > 0 && refreshIn <= settings.refreshWaitSeconds &&
    market.goods.some(quote => positive(quote.stock))) {
    const afterRefresh = buildRoutes(true)[0], currentProfit = Math.max(0, best?.totalProfit ?? 0);
    if (afterRefresh && afterRefresh.profit > (best?.profit ?? 0) &&
      timing.nextRefreshAt + timing.travelSeconds + (afterRefresh.batches.length + afterRefresh.purchases.length * 2 + 1) * actionSeconds < timing.tradeEndTime) {
      const discounted = afterRefresh.totalProfit * (1 - settings.estimateDiscountPercent / 100);
      const waitingCost = currentProfit * refreshIn / timing.travelSeconds;
      if (discounted > currentProfit + waitingCost + settings.minExpectedProfit) return wait(
        '本港折价库存不足，等待约 ' + Math.ceil(refreshIn / 60) + ' 分钟刷新后重读报价库存；补货估算收益 ' + Math.floor(discounted) +
        '，当前方案 ' + currentProfit, { mode: 'WAIT_REFRESH', nextCheckAt: timing.nextRefreshAt });
    }
  }
  if (best?.totalProfit >= settings.minExpectedProfit && best.purchases.length) {
    const purchase = [...best.purchases].sort((a, b) => b.gain - a.gain || a.goodsId - b.goodsId)[0];
    return { kind: 'buy', mode, city: cargo.cityId, destination: best.port.cityId, goodsId: purchase.goodsId,
      count: purchase.count, price: purchase.price, expectedProfit: best.totalProfit, estimated: true, purchases: best.purchases,
      approximate: best.approximate, arrival,
      latestActionAt: timing.tradeEndTime - timing.travelSeconds - (best.batches.length + best.purchases.length * 2 + 1) * actionSeconds,
      label: '买入' + definitions.get(purchase.goodsId).itemName + ' ×' + purchase.count + '，单价 ' + purchase.price +
        '；目标港 ' + best.port.cityId + '，整船风险折扣估算收益 ' + best.totalProfit +
        (best.purchases.length > 1 ? '（组合 ' + best.purchases.length + ' 种，逐笔复查）' : '') + (best.approximate ? '（有界组合搜索）' : '') };
  }
  const moveRoute = routes.find(route => route.batches.length && (route.cargoProfit >= settings.minExpectedProfit ||
    (liquidation && route.cargoProfit <= 0 && (route.cargoProfit === 0 || settings.maxLossPercent > 0))));
  if (moveRoute) return { kind: 'move', mode, city: cargo.cityId, destination: moveRoute.port.cityId,
    goodsId: [...moveRoute.batches].sort((a, b) => b.gain - a.gain || a.batch.pid - b.batch.pid)[0].batch.goodsId,
    arrival, expectedProfit: moveRoute.cargoProfit, estimated: true,
    latestActionAt: timing.tradeEndTime - timing.travelSeconds - Math.max(1, moveRoute.batches.length) * actionSeconds,
    salePids: moveRoute.batches.map(row => row.batch.pid), accelerationRequired: 0,
    label: '商船从港口 ' + cargo.cityId + ' 前往 ' + moveRoute.port.cityId + '，整船风险折扣估算收益 ' + moveRoute.cargoProfit +
      '，预计释放舱位 ' + moveRoute.released + '；到港重读实价' };

  // 在没有已知盈利路线时，有限寻价仍可帮助没有联盟共享的账号取得本港报价。
  // 不回访执行层标记的已访问港口；空船须留出到港采购后再航行出售的时间。
  if (!liquidation) {
    const explore = destinations.filter(port => !visited.includes(port.cityId) && !history.has(port.cityId) &&
      (player.goods.length ? player.goods.some(batch => batch.cityId !== port.cityId && port.specGoodsId !== batch.goodsId) :
        positive(definitions.get(port.specGoodsId)?.unitPrice)))
      .sort((a, b) => Number(player.goods.some(g => g.goodsId === b.rareGoodsId)) - Number(player.goods.some(g => g.goodsId === a.rareGoodsId)) || a.cityId - b.cityId)[0];
    const possibleBatches = explore && player.goods.filter(batch => batch.cityId !== explore.cityId && explore.specGoodsId !== batch.goodsId).length;
    const explorationBuffer = player.goods.length ? timing.travelSeconds + Math.max(1, possibleBatches) * actionSeconds : timing.travelSeconds * 2 + actionSeconds * 4;
    if (explore && time + explorationBuffer < timing.tradeEndTime) return {
      kind: 'move', mode, city: cargo.cityId, destination: explore.cityId, goodsId: player.goods[0]?.goodsId ?? explore.specGoodsId,
      expectedProfit: 0, estimated: true, exploration: true, arrival,
      latestActionAt: timing.tradeEndTime - explorationBuffer,
      label: '商船从港口 ' + cargo.cityId + ' 前往 ' + explore.cityId + ' 寻价，暂无可确认的盈利路线；到港读取实价，不使用指针'
    };
  }
  return wait(liquidation ? '清仓阶段，停止新采购，等待符合止损上限的可执行卖价' :
    !destinations.length ? '本港暂无适合出售的批次，等待可用港口列表' : '当前没有值得执行的交易，等待本港报价或库存刷新',
    { nextCheckAt: timing.nextRefreshAt });
}
