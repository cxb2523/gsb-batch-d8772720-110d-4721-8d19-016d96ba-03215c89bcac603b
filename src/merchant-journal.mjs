// 海商王观察与成交日志。只存玩法字段；复用调用方账号账本，不读取账号凭据。
import { createHash } from 'node:crypto';
import { merchantActionSeconds, merchantSettings, merchantTiming, planMerchant } from './merchant-planner.mjs';

const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => natural(value) && value > 0;
const signed = Number.isSafeInteger;
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const MAX_SNAPSHOTS = 512, MAX_TRADES = 2048, MAX_RECEIPTS = 20000, MAX_BATCHES = 4096;
const fields = (value, names) => Object.fromEntries(names.flatMap(name => value?.[name] === undefined ? [] : [[name, value[name]]]));
const totals = () => ({ confirmedTrades: 0, confirmedActions: 0, buys: 0, sells: 0, moves: 0, accelerations: 0, upgrades: 0,
  buyCost: 0, sellProceeds: 0, realizedProfit: 0, pointerUsed: 0, diamondSpent: 0, unverifiedConfirmations: 0 });
const addTotals = (a, b) => { for (const name of Object.keys(totals())) a[name] += b?.[name] ?? 0; return a; };

function cleanEvent(event) {
  if (!positive(event?.period) || !positive(event.startTime) || !positive(event.endTime) || event.endTime <= event.startTime)
    throw Error('海商王日志期次或起止时间无效');
  return fields(event, ['period', 'startTime', 'endTime']);
}
const eventId = event => event.startTime + ':' + event.period;
const keyOf = event => 'merchant-journal:' + eventId(event);
const stateKey = state => state ? hash({ player: state.player, cargo: state.cargo }) : null;
function cleanState(state) {
  if (!state) return null;
  const player = state.player ?? state;
  if (!natural(player.coins) || !natural(player.profit) || !Array.isArray(player.goods) || !state.cargo) return null;
  if (player.goods.some(g => !natural(g?.pid) || !positive(g.goodsId) || !positive(g.cityId) || !positive(g.buyPrice) || !positive(g.num)) ||
    new Set(player.goods.map(g => g.pid)).size !== player.goods.length) return null;
  const goods = player.goods.map(g => fields(g, ['pid', 'goodsId', 'cityId', 'buyPrice', 'num'])).sort((a, b) => a.pid - b.pid);
  return { ...(positive(state.period) ? { period: state.period } : {}), player: { coins: player.coins, profit: player.profit, goods },
    cargo: fields(state.cargo, ['cityId', 'cargoLv', 'moveStartTime', 'moveEndTime', 'moveToCityId']) };
}
function cleanExpected(expected) {
  if (!expected || typeof expected.request !== 'string' || !/^Trade[A-Za-z]+Request$/.test(expected.request)) return null;
  return fields(expected, ['request', 'city', 'goodsId', 'price', 'owned', 'coins', 'pid', 'profit', 'gain', 'proceeds', 'destination',
    'start', 'marketEpoch', 'cargoSignature', 'exploration', 'period', 'moveStartTime', 'beforeEndTime', 'afterEndTime', 'useNum',
    'diamondCost', 'cost', 'beforeLevel', 'afterLevel', 'level', 'cargoLv', 'beforeDiamonds', 'afterDiamonds',
    'startTime', 'fromLevel', 'toLevel', 'diamonds', 'accelerationReason', 'incrementalProfit',
    'estimatedIncrementalProfit', 'savedSeconds', 'estimatedProfit', 'saleCount', 'saleSeconds', 'evidenceExpiresAt']);
}
function emptyJournal(event) {
  return { version: 1, event, snapshots: [], trades: [], archivedTotals: totals(), archivedIds: [], batches: [],
    droppedSnapshots: 0, archivedTrades: 0, droppedBatches: 0, limitReached: false };
}
function validateJournal(journal, event) {
  if (!journal || journal.version !== 1 || !Array.isArray(journal.snapshots) || !Array.isArray(journal.trades) ||
    !Array.isArray(journal.archivedIds) || !Array.isArray(journal.batches) || !journal.archivedTotals ||
    eventId(cleanEvent(journal.event)) !== eventId(event) || journal.snapshots.some(e => e?.type !== 'snapshot' || !positive(e.time) || !e.id) ||
    journal.trades.some(e => e?.type !== 'trade' || !positive(e.time) || !e.id) ||
    Object.keys(totals()).some(name => !signed(journal.archivedTotals[name]))) throw Error('海商王日志损坏，未覆盖原记录');
  return journal;
}
function loadJournal(ledger, event) {
  if (!ledger?.keyRecords || !ledger.reserve || !ledger.confirm || !ledger.resolveKey) throw Error('海商王日志账号账本不可用');
  const record = ledger.keyRecords()[keyOf(event)];
  return record ? copy(validateJournal(record.details?.merchantJournal, event)) : emptyJournal(event);
}
function saveJournal(ledger, journal) {
  const key = keyOf(journal.event), details = { merchantJournal: journal };
  if (ledger.hasKey(key)) ledger.resolveKey(key, true, details);
  else ledger.confirm(ledger.reserve({}, {}, {}, { uniqueKey: key, details }));
}

function batchHistory(journal, state, time, purchase) {
  for (const good of state?.player.goods ?? []) {
    // 同期 pid 理应稳定；来源与成本一并参与身份，防止服务端重用编号误合并。
    const identity = hash(fields(good, ['pid', 'goodsId', 'cityId', 'buyPrice']));
    let batch = journal.batches.find(row => row.id === identity);
    if (!batch) {
      batch = { id: identity, ...good, firstObservedAt: time, lastObservedAt: time, purchasedAt: null,
        purchaseTimeSource: 'unknown', initialQuantity: good.num };
      journal.batches.push(batch);
    }
    batch.num = good.num;
    batch.lastObservedAt = Math.max(batch.lastObservedAt, time);
    if (purchase && purchase.ids.includes(good.pid)) {
      batch.purchasedAt ??= purchase.time;
      batch.purchaseTimeSource = purchase.source;
      batch.initialQuantity = Math.max(batch.initialQuantity, good.num);
    }
  }
  if (state) for (const batch of journal.batches) {
    if (!state.player.goods.some(g => g.pid === batch.pid && g.goodsId === batch.goodsId && g.cityId === batch.cityId && g.buyPrice === batch.buyPrice)) {
      batch.num = 0;
      batch.closedObservedAt ??= time;
    }
  }
  if (journal.batches.length > MAX_BATCHES) {
    const expired = journal.batches.filter(batch => batch.num === 0).sort((a, b) => a.lastObservedAt - b.lastObservedAt);
    const removed = new Set(expired.slice(0, journal.batches.length - MAX_BATCHES).map(batch => batch.id));
    journal.batches = journal.batches.filter(batch => !removed.has(batch.id));
    journal.droppedBatches += removed.size;
  }
}

export function recordMerchantSnapshot(ledger, { event, state, market, radar, time, settings = {}, config, actionSeconds } = {}) {
  event = cleanEvent(event);
  if (!positive(time)) throw Error('海商王日志采集时间无效');
  const observed = cleanState(state);
  if (!observed || (observed.period != null && observed.period !== event.period)) return { recorded: false, reason: '商船快照无效' };
  if (!positive(observed.cargo.cityId) || !Array.isArray(market?.goods) || market.goods.some(g => !positive(g?.goodsId) || !positive(g.price) || !natural(g.stock)) ||
    new Set(market.goods.map(g => g.goodsId)).size !== market.goods.length) return { recorded: false, reason: '港口报价快照无效' };
  const policy = merchantSettings(settings?.merchant ?? settings);
  const interval = merchantActionSeconds(settings, actionSeconds);
  const marketData = { cityId: observed.cargo.cityId, goods: market.goods.map(g => fields(g, ['goodsId', 'price', 'stock'])).sort((a, b) => a.goodsId - b.goodsId),
    ...fields(market, ['specGoodsId', 'rareGoodsId', 'isReport']) };
  const radarData = { radar: (Array.isArray(radar?.radar) ? radar.radar : []).filter(r => positive(r?.cityId))
    .map(r => fields(r, ['cityId', 'specGoodsId', 'rareGoodsId'])).sort((a, b) => a.cityId - b.cityId) };
  const epoch = config ? merchantTiming(config, event, time).marketEpoch : market.marketEpoch ?? 'sample:' + Math.floor(time / 300);
  const id = hash([eventId(event), epoch, observed, marketData, radarData, policy, interval]);
  const journal = loadJournal(ledger, event);
  if (journal.snapshots.some(entry => entry.id === id)) return { recorded: false, reason: '本采样周期已有相同观察', id };
  const entry = { type: 'snapshot', id, event, time, marketEpoch: epoch, state: observed, settings: policy, actionSeconds: interval,
    market: { ...marketData, observedAt: time, period: event.period, startTime: event.startTime, source: 'visited-port', confidence: 'observed' },
    radar: { ...radarData, observedAt: time, source: 'guild-radar', reportedAt: null, confidence: 'signal-only' } };
  journal.snapshots.push(entry);
  journal.snapshots.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  if (journal.snapshots.length > MAX_SNAPSHOTS) journal.droppedSnapshots += journal.snapshots.splice(0, journal.snapshots.length - MAX_SNAPSHOTS).length;
  batchHistory(journal, observed, time);
  saveJournal(ledger, journal);
  return { recorded: true, id };
}

function confirmedMetrics(entry) {
  const result = totals();
  if (entry.status !== 'confirmed') return result;
  result.confirmedActions = 1;
  const expected = entry.expected, before = entry.before, after = entry.after;
  if (!before || !after) { result.unverifiedConfirmations = 1; return result; }
  const b = before.player, a = after.player, request = expected.request;
  if (request === 'TradeBuyRequest') {
    const added = a.goods.filter(g => g.goodsId === expected.goodsId && g.cityId === expected.city && (expected.price == null || g.buyPrice === expected.price))
      .reduce((sum, g) => sum + g.num - (b.goods.find(old => old.pid === g.pid)?.num ?? 0), 0);
    const cost = b.coins - a.coins;
    if (!positive(added) || !positive(cost) || !signed(cost)) result.unverifiedConfirmations = 1;
    else { result.confirmedTrades = result.buys = 1; result.buyCost = cost; }
  } else if (request === 'TradeSellRequest') {
    const batch = b.goods.find(g => g.pid === expected.pid), retained = a.goods.find(g => g.pid === expected.pid);
    const count = batch ? batch.num - (retained?.num ?? 0) : 0;
    const proceeds = a.coins - b.coins, cost = batch ? count * batch.buyPrice : NaN;
    if (!positive(count) || !natural(proceeds) || !natural(cost) || !signed(proceeds - cost)) result.unverifiedConfirmations = 1;
    else { result.confirmedTrades = result.sells = 1; result.sellProceeds = proceeds; result.realizedProfit = proceeds - cost; }
  } else if (request === 'TradeMoveRequest') result.moves = 1;
  else if (request === 'TradeSpeedRequest') {
    if (!positive(expected.useNum)) result.unverifiedConfirmations = 1;
    else { result.accelerations = 1; result.pointerUsed = expected.useNum; }
  } else if (request === 'TradeCargoUpgradeRequest') {
    const diamondCost = entry.actualDiamondSpent;
    if (expected.period !== entry.event.period || expected.startTime !== entry.event.startTime
      || !positive(expected.fromLevel) || expected.toLevel !== expected.fromLevel + 1
      || before.cargo.cargoLv !== expected.fromLevel || after.cargo.cargoLv !== expected.toLevel
      || !positive(expected.diamonds) || diamondCost !== expected.diamonds) result.unverifiedConfirmations = 1;
    else { result.upgrades = 1; result.diamondSpent = diamondCost; }
  } else result.unverifiedConfirmations = 1;
  return result;
}

export function recordMerchantTrade(ledger, { event, expected, before, after, time, status, reason = '', actionKey,
  attemptedAt, actualDiamondSpent, beforeDiamonds, afterDiamonds } = {}) {
  event = cleanEvent(event);
  expected = cleanExpected(expected);
  if (status === 'cancelled') status = 'notSent';
  if (!expected || !positive(time) || !['confirmed', 'unknown', 'rejected', 'notSent'].includes(status)) throw Error('海商王成交日志参数无效');
  const journal = loadJournal(ledger, event), cleanBefore = cleanState(before), cleanAfter = cleanState(after);
  const id = hash([eventId(event), actionKey || [expected, cleanBefore]]);
  if (journal.archivedIds.includes(id)) return { recorded: false, reason: '已归档的确认动作', id };
  const prior = journal.trades.find(entry => entry.id === id);
  if (prior?.status === 'confirmed') return { recorded: false, reason: '已确认动作不重复计入', id };
  if (!prior && journal.trades.length >= MAX_TRADES && (journal.archivedIds.length >= MAX_RECEIPTS ||
    !journal.trades.some(entry => entry.status !== 'unknown'))) {
    if (!journal.limitReached) { journal.limitReached = true; saveJournal(ledger, journal); }
    return { recorded: false, reason: '本期日志达到保留上限，已保留原账本及未知记录', limited: true };
  }
  const entry = { type: 'trade', id, event, time, firstObservedAt: prior?.firstObservedAt ?? time,
    attemptedAt: prior?.attemptedAt ?? (positive(attemptedAt) && attemptedAt <= time ? attemptedAt : time),
    status, expected, before: prior?.before ?? cleanBefore, after: cleanAfter, reason: String(reason).slice(0, 300),
    ...(natural(actualDiamondSpent) ? { actualDiamondSpent } : {}),
    ...(natural(prior?.beforeDiamonds ?? beforeDiamonds) ? { beforeDiamonds: prior?.beforeDiamonds ?? beforeDiamonds } : {}),
    ...(natural(afterDiamonds) ? { afterDiamonds } : {}) };
  entry.metrics = confirmedMetrics(entry);
  if (prior) journal.trades[journal.trades.indexOf(prior)] = entry;
  else journal.trades.push(entry);
  if (status === 'confirmed' && cleanAfter) {
    const ids = expected.request === 'TradeBuyRequest' && entry.metrics.buys ? cleanAfter.player.goods.filter(g =>
      g.goodsId === expected.goodsId && g.cityId === expected.city &&
      g.num > (entry.before?.player.goods.find(old => old.pid === g.pid)?.num ?? 0)).map(g => g.pid) : [];
    batchHistory(journal, cleanAfter, time, ids.length ? { ids, time: entry.attemptedAt, source: positive(attemptedAt) || prior ? 'request-observed' : 'confirmation-observed' } : null);
  }
  while (journal.trades.length > MAX_TRADES) {
    const index = journal.trades.findIndex(row => row.status !== 'unknown' && row.id !== id);
    if (index < 0 || journal.archivedIds.length >= MAX_RECEIPTS) { journal.limitReached = true; break; }
    const old = journal.trades.splice(index, 1)[0];
    journal.archivedIds.push(old.id);
    addTotals(journal.archivedTotals, old.metrics);
    journal.archivedTrades++;
  }
  saveJournal(ledger, journal);
  return { recorded: true, id, verified: entry.metrics.unverifiedConfirmations === 0, metrics: entry.metrics };
}

export function readMerchantJournal(ledger, event) {
  const selected = event ? cleanEvent(event) : null, entries = [];
  for (const [key, record] of Object.entries(ledger?.keyRecords?.() ?? {})) {
    if (!key.startsWith('merchant-journal:')) continue;
    const journal = validateJournal(record.details?.merchantJournal, record.details?.merchantJournal?.event);
    if (selected && eventId(journal.event) !== eventId(selected)) continue;
    entries.push(...copy(journal.snapshots), ...copy(journal.trades));
  }
  return entries.sort((a, b) => a.time - b.time || (a.type === b.type ? a.id.localeCompare(b.id) : a.type === 'snapshot' ? -1 : 1));
}

export function merchantJournalSummary(ledger, event, { time = Math.floor(Date.now() / 1000) } = {}) {
  if (!event) {
    return Object.entries(ledger?.keyRecords?.() ?? {}).filter(([key]) => key.startsWith('merchant-journal:'))
      .map(([, record]) => merchantJournalSummary(ledger, validateJournal(record.details?.merchantJournal, record.details?.merchantJournal?.event).event, { time }))
      .sort((a, b) => a.event.startTime - b.event.startTime);
  }
  event = cleanEvent(event);
  const record = ledger?.keyRecords?.()[keyOf(event)];
  const journal = record ? validateJournal(record.details?.merchantJournal, event) : emptyJournal(event);
  const result = copy(journal.archivedTotals);
  for (const entry of journal.trades) addTotals(result, entry.metrics);
  const observationTimes = [...journal.snapshots.map(entry => entry.time), ...journal.trades.map(entry => entry.time)];
  const observedAt = observationTimes.length ? Math.max(...observationTimes) : null;
  const firstObservedAt = observationTimes.length ? Math.min(...observationTimes) : null;
  const sampleSeconds = observedAt === null ? 0 : observedAt - firstObservedAt;
  const confirmedSales = journal.trades.filter(entry => entry.status === 'confirmed' && entry.metrics.sells);
  // 周转窗口截止于最近一次已核验出售；之后的行情快照不能刷新成交样本或改写历史速率。
  const turnoverObservedAt = confirmedSales.length ? Math.max(...confirmedSales.map(entry => entry.time)) : null;
  const turnoverSampleCount = confirmedSales.length;
  const turnoverSampleSeconds = turnoverObservedAt === null ? 0 : turnoverObservedAt - firstObservedAt;
  const sampleProfit = confirmedSales.reduce((sum, entry) => sum + entry.metrics.realizedProfit, 0);
  return { event, period: event.period, startTime: event.startTime, observedAt, firstObservedAt, sampleSeconds,
    turnoverObservedAt, turnoverSampleCount, turnoverSampleSeconds,
    turnoverProfitPerSecond: turnoverSampleCount >= 2 && turnoverSampleSeconds >= 60 ? Math.max(0, sampleProfit) / turnoverSampleSeconds : null,
    turnoverSource: '当前保留观察窗口中至少两笔已核验出售净利润除以截至最近出售的观测耗时；新快照不续期，包括等待时间，不含未知或预期收益',
    status: time >= event.endTime ? 'ended' : time < event.startTime ? 'not-started' : 'active', ...result,
    unknownActions: journal.trades.filter(entry => entry.status === 'unknown').length,
    rejectedActions: journal.trades.filter(entry => ['rejected', 'notSent'].includes(entry.status)).length,
    snapshots: journal.snapshots.length, archivedTrades: journal.archivedTrades, droppedSnapshots: journal.droppedSnapshots,
    droppedBatches: journal.droppedBatches, limited: journal.limitReached, batches: copy(journal.batches),
    profitBasis: '已确认出售的实际商会币回款减售出批次成本；未卖持货和未知结果不计利润',
    purchaseTimeBasis: '本工具观察到的请求或确认时间；工具外已有批次无法确定采购时间' };
}

function matchesPlan(plan, expected) {
  if (plan.kind === 'buy') return expected.request === 'TradeBuyRequest' && plan.city === expected.city && plan.goodsId === expected.goodsId && plan.price === expected.price;
  if (plan.kind === 'sell') return expected.request === 'TradeSellRequest' && plan.pid === expected.pid;
  return plan.kind === 'move' && expected.request === 'TradeMoveRequest' && plan.city === expected.city && plan.destination === expected.destination;
}

// 观察回放而非虚构价格的收益模拟。计划只能看到该时点及之前观察到的数据。
// 变体改走未实际访问港口时，没有反事实成交证据，收益必须留空。
export function replayMerchantJournal(config, entries, { variants = [{ name: '记录参数', settings: null }], actionSeconds } = {}) {
  if (!Array.isArray(entries) || !Array.isArray(variants)) throw Error('海商王回放输入必须是日志及参数列表');
  const ordered = entries.filter(e => e && positive(e.time) && e.event).map(copy)
    .sort((a, b) => a.time - b.time || (a.type === b.type ? String(a.id).localeCompare(String(b.id)) : a.type === 'snapshot' ? -1 : 1));
  const snapshots = ordered.filter(e => e.type === 'snapshot'), trades = ordered.filter(e => e.type === 'trade');
  return { mode: 'observed-snapshot-replay', observations: snapshots.length,
    warning: '仅回放历史已观察状态，不模拟未访问港报价；预期收益不是实际收益。匹配成交收益仅说明该历史动作可核验，不能外推变体全程收益。',
    variants: variants.map((variant, variantIndex) => {
      const history = new Map(), usedTrades = new Set(), decisions = [];
      let expectedProfit = 0, verifiedProfit = 0, verifiedDecisions = 0, unverifiedDecisions = 0;
      for (const snapshot of snapshots) {
        const event = cleanEvent(snapshot.event), identity = eventId(event);
        const settings = variant.settings == null ? snapshot.settings : { ...snapshot.settings, ...(variant.settings?.merchant ?? variant.settings) };
        const markets = [...history.values()].filter(m => m.period === event.period && m.startTime === event.startTime && m.observedAt <= snapshot.time);
        const pastTrades = trades.filter(trade => trade.status === 'confirmed' && eventId(trade.event) === identity && trade.time < snapshot.time);
        const signature = hash([snapshot.state.player.coins, snapshot.state.player.goods]);
        const visited = pastTrades.filter(trade => trade.expected?.request === 'TradeMoveRequest' && trade.before &&
          hash([trade.before.player.coins, trade.before.player.goods]) === signature).map(trade => trade.expected.city);
        const plan = planMerchant(config, event, snapshot.state, snapshot.market, snapshot.radar, snapshot.time, visited,
          { settings, markets, actionSeconds: actionSeconds ?? snapshot.actionSeconds });
        history.set(identity + ':' + snapshot.market.cityId, snapshot.market);
        const nextObservation = snapshots.find(next => next.time > snapshot.time && eventId(next.event) === identity);
        const matching = trades.find(trade => !usedTrades.has(trade.id) && trade.status === 'confirmed' && trade.metrics?.unverifiedConfirmations === 0 &&
          eventId(trade.event) === identity && trade.time >= snapshot.time && (!nextObservation || trade.time <= nextObservation.time) &&
          trade.before && stateKey(trade.before) === stateKey(snapshot.state) && matchesPlan(plan, trade.expected) &&
          (plan.kind !== 'buy' || plan.count === trade.after.player.goods.filter(g => g.goodsId === plan.goodsId && g.cityId === plan.city)
            .reduce((sum, g) => sum + g.num - (trade.before.player.goods.find(old => old.pid === g.pid)?.num ?? 0), 0)) &&
          (plan.kind !== 'sell' || plan.count === (trade.before.player.goods.find(g => g.pid === plan.pid)?.num ?? 0) -
            (trade.after.player.goods.find(g => g.pid === plan.pid)?.num ?? 0)));
        if (matching) { usedTrades.add(matching.id); verifiedDecisions++; verifiedProfit += matching.metrics.realizedProfit; }
        else if (plan.kind !== 'wait') unverifiedDecisions++;
        expectedProfit += plan.expectedProfit ?? 0;
        decisions.push({ time: snapshot.time, event, kind: plan.kind, goodsId: plan.goodsId, destination: plan.destination,
          count: plan.count, estimatedProfit: plan.expectedProfit ?? null, verifiedRealizedProfit: matching ? matching.metrics.realizedProfit : null,
          verification: matching ? 'matched-confirmed-receipt' : plan.kind === 'wait' ? 'no-trade' : 'unobserved-counterfactual',
          reason: plan.label ?? plan.reason });
      }
      return { name: String(variant.name ?? '参数组' + (variantIndex + 1)), decisions, verifiedDecisions, unverifiedDecisions,
        verifiedRealizedProfit: verifiedProfit, estimatedDecisionProfit: expectedProfit,
        fullStrategyRealizedProfit: null, fullStrategyProfitReason: '没有变体在全部反事实港口的真实成交记录，无法声称全程实际收益' };
    }) };
}
