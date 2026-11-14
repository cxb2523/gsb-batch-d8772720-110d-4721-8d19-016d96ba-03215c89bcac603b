// 超凡英雄的活动状态仅由 SCAllActivity / SCHeroRaidOpen 推送提供。
// 没有 HeroRaidInfoRequest，也没有免费抽取次数；禁止把抽卡券当免费次数。
import { exactAutomationId, resourceReserve } from './automation-policy.mjs';
import { displayMaterial } from './config.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const watches = new WeakMap(), busy = new WeakSet();
const valid = n => Number.isSafeInteger(n) && n >= 0;
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const identity = player => [exactAutomationId(player?.worldId), exactAutomationId(player?.playerId)].join(':');
const period = raid => raid.raidId + ':' + raid.startTime + ':' + raid.finishTime;
const open = (raid, now) => valid(raid?.raidId) && raid.raidId > 0 && valid(raid.startTime) && raid.startTime > 0 && raid.startTime <= now && valid(raid.finishTime) && raid.finishTime > now;
const orderValid = order => order && ['orderId', 'gotOrderId', 'gotTimes'].every(key => valid(order[key])) && order.orderId > 0;
const drawValid = info => info && valid(info.times) && valid(info.gotIndex);
const orderStamp = raid => JSON.stringify([period(raid), raid.order]);
const receiptHasReward = reply => reply?.reward?.asset?.some(item => typeof item.id === 'string' && item.id &&
  (typeof item.num === 'number' && item.num > 0 || item.num?.low > 0 || item.num?.high > 0)) || reply?.heroIds?.some(id => typeof id === 'string' && id);
const recordKinds = new Set(['heroRaidOrder', 'heroRaidOrderReward', 'heroRaidDrawReward']);

function copyRaid(raw) {
  if (!valid(raw?.raidId) || raw.raidId < 1 || !valid(raw.startTime) || !valid(raw.finishTime) || raw.finishTime <= raw.startTime) throw Error('超凡英雄活动时间或编号未完整同步');
  return { raidId: raw.raidId, startTime: raw.startTime, finishTime: raw.finishTime, passedStage: raw.passedStage ?? 0,
    order: raw.order ? { orderId: raw.order.orderId, gotOrderId: raw.order.gotOrderId, gotTimes: raw.order.gotTimes } : null,
    drawTimesInfo: raw.drawTimesInfo ? { times: raw.drawTimesInfo.times ?? 0, gotIndex: raw.drawTimesInfo.gotIndex ?? 0 } : null };
}

export function watchHeroRaidPushes(client) {
  if (watches.has(client)) return watches.get(client);
  const state = { observed: false, invalid: false, raids: new Map(), revision: 0 };
  const reset = () => { state.observed = false; state.invalid = false; state.raids.clear(); state.revision++; };
  client.on?.('login', reset); client.on?.('close', reset);
  client.on?.('message', ({ name, body }) => {
    if (!['SCAllActivity', 'SCHeroRaidOpen'].includes(name)) return;
    try {
      const incoming = name === 'SCAllActivity' ? body?.raid : body?.raid ? [body.raid] : null;
      if (!Array.isArray(incoming)) throw Error('活动推送没有完整英雄活动清单');
      const copied = incoming.map(copyRaid);
      if (new Set(copied.map(row => row.raidId)).size !== copied.length) throw Error('超凡英雄活动编号重复');
      if (name === 'SCAllActivity') state.raids.clear();
      for (const raid of copied) state.raids.set(raid.raidId, raid);
      state.observed = true; state.invalid = false; state.revision++;
    } catch { state.invalid = true; state.revision++; }
  });
  watches.set(client, state);
  return state;
}

function requirements(raid, config, now) {
  if (!orderValid(raid?.order) || !open(raid, now)) return null;
  const list = rows(config, 'HeroRaidOrderCfg').filter(row => row.raidId === raid.raidId).sort((a, b) => a.orderId - b.orderId);
  if (!list.length || list.at(-1).orderId <= raid.order.gotOrderId) return null;
  const matching = list.filter(row => row.orderId === raid.order.orderId);
  if (matching.length !== 1) throw Error('超凡英雄当前订单配置不唯一');
  const order = matching[0], day = Math.floor((now + 28800) / 86400) - Math.floor((raid.startTime + 28800) / 86400) + 1;
  if (!valid(order.unlockDay) || order.unlockDay < 1 || day < order.unlockDay) return null;
  if (!Array.isArray(order.orderList) || !order.orderList.length) throw Error('超凡英雄订单材料未配置');
  const summed = new Map();
  for (const asset of order.orderList) {
    if (!Array.isArray(asset) || typeof asset[0] !== 'string' || !asset[0] || !valid(asset[1]) || asset[1] < 1) throw Error('超凡英雄订单材料数量无效');
    const total = (summed.get(asset[0]) ?? 0) + asset[1];
    if (!valid(total)) throw Error('超凡英雄重复材料总量无效');
    summed.set(asset[0], total);
  }
  return [...summed].map(([id, num]) => ({ id, num }));
}

function unresolved(ledger, player, raid) {
  return Object.values(ledger?.keyRecords() ?? {}).some(record => !record.confirmed && recordKinds.has(record.details?.kind) &&
    record.details.identity === identity(player) && record.details.period === period(raid));
}

export function heroRaidDemands(client, config, player, settings, { ledger } = {}) {
  if (!settings?.heroRaid?.enabled || !settings.heroRaid.orders) return [];
  const state = watchHeroRaidPushes(client);
  if (!state.observed || state.invalid) return [];
  const demands = [];
  for (const raid of state.raids.values()) {
    if (unresolved(ledger, player, raid)) continue;
    try { const cost = requirements(raid, config, nowOf(client)); if (cost) demands.push({ source: 'heroRaid', requirements: cost }); }
    catch { /* incomplete data never creates an automatic factory demand */ }
  }
  return demands;
}

function reconcile(state, player, ledger) {
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    const d = record.details;
    if (record.confirmed || !recordKinds.has(d?.kind) || d.identity !== identity(player)) continue;
    const raid = state.raids.get(d.raidId);
    if (!raid || period(raid) !== d.period) continue;
    const confirmed = d.kind === 'heroRaidOrder' ? orderValid(raid.order) && raid.order.gotOrderId >= d.orderId :
      d.kind === 'heroRaidOrderReward' ? orderValid(raid.order) && raid.order.gotTimes > d.beforeGot :
      drawValid(raid.drawTimesInfo) && raid.drawTimesInfo.gotIndex > d.beforeGot;
    if (confirmed) ledger.resolveKey(key, true);
  }
}

function applyOrder(state, original, order) {
  if (!orderValid(order)) throw Error('超凡英雄订单回执不完整');
  const current = state.raids.get(original.raidId);
  if (!current || period(current) !== period(original)) return;
  if (orderValid(current.order) && (current.order.gotOrderId > order.gotOrderId || current.order.gotTimes > order.gotTimes)) return;
  state.raids.set(original.raidId, { ...current, order: { orderId: order.orderId, gotOrderId: order.gotOrderId, gotTimes: order.gotTimes } }); state.revision++;
}

async function finishOrder(client, protocol, config, player, context, initial) {
  const { state, getSettings, ledger, active, report } = context;
  const actorIdentity = identity(player);
  const cost = requirements(initial, config, nowOf(client));
  if (!cost) return report({ key: 'heroRaid', label: '超凡英雄订单', skipped: true, reason: '当前订单未解锁或活动订单已全部完成' });
  const stock = await readOrderReservedStock(client, protocol, config, { player, enabled: active, itemIds: cost.map(row => row.id) });
  const latest = state.raids.get(initial.raidId);
  if (!active() || !getSettings().heroRaid.orders || !latest || orderStamp(latest) !== orderStamp(initial) || !open(latest, nowOf(client))) return;
  const missing = cost.filter(row => (stock.available.get(row.id) ?? 0) - resourceReserve(getSettings(), row.id) < row.num);
  if (missing.length) return report({ key: 'heroRaid', label: '超凡英雄订单', skipped: true, reason: '保留其他订单材料后缺少：' + missing.map(row => displayMaterial(config, row.id)).join('、') });
  const key = 'heroRaidOrder:' + identity(player) + ':' + period(initial) + ':' + initial.order.orderId;
  if (ledger.hasKey(key)) return report({ key: 'heroRaid', label: '超凡英雄订单', skipped: true, reason: '该活动订单已有提交记录，等待真实进度' });
  const token = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'heroRaidOrder', identity: identity(player), period: period(initial), raidId: initial.raidId, orderId: initial.order.orderId } });
  let debit, acknowledged = false;
  try {
    debit = beginOrderMaterialSpend(player, cost.map(row => ({ id: row.id, need: row.num, have: stock.stock.get(row.id) ?? 0 })), '超凡英雄订单', { operation: {
      verify(next, { player: actor, enabled }) {
        const observed = watchHeroRaidPushes(next), raid = observed.raids.get(initial.raidId);
        return enabled() && identity(actor) === actorIdentity && observed.observed && !observed.invalid && raid && period(raid) === period(initial) && orderValid(raid.order) && raid.order.gotOrderId >= initial.order.orderId;
      },
    } });
    if (!active() || !getSettings().heroRaid.orders) { ledger.cancel(token); cancelOrderMaterialSpend(debit); return; }
    const reply = await client.request('HeroRaidFinishOrderRequest', { raidId: initial.raidId }, 'HeroRaidOrderResponse'); acknowledged = true;
    if (!orderValid(reply?.order) || reply.order.gotOrderId !== initial.order.orderId || reply.order.gotOrderId <= initial.order.gotOrderId || !receiptHasReward(reply)) throw Error('超凡英雄订单结果未完整确认');
    applyOrder(state, initial, reply.order);
    ledger.confirm(token); confirmOrderMaterialOperation(debit);
    await refreshOrderMaterialSpends(client, player, { enabled: active });
    report({ key: 'heroRaid', label: '超凡英雄 · 已完成第 ' + initial.order.orderId + ' 单', ok: true });
  } catch (error) {
    const refused = !debit || !acknowledged && error.notSent === true || error.prompt && error.request === 'HeroRaidFinishOrderRequest';
    if (refused) { ledger.cancel(token); cancelOrderMaterialSpend(debit); }
    report({ key: 'heroRaid', label: '超凡英雄订单', error: error.message, pending: !refused });
  }
}

async function claimOrderRewards(client, config, player, context, initial) {
  const { state, getSettings, ledger, active, report } = context;
  if (!orderValid(initial.order)) return;
  const tiers = rows(config, 'HeroRaidOrderRewardCfg').filter(row => row.raidId === initial.raidId && row.orderCount > initial.order.gotTimes && row.orderCount <= initial.order.gotOrderId).sort((a, b) => a.orderCount - b.orderCount);
  if (!tiers.length || tiers.some(row => !valid(row.orderCount) || row.orderCount < 1)) return;
  const latest = state.raids.get(initial.raidId);
  if (!active() || !getSettings().heroRaid.rewards || !latest || orderStamp(latest) !== orderStamp(initial) || !open(latest, nowOf(client))) return;
  const key = 'heroRaidOrderReward:' + identity(player) + ':' + period(initial) + ':' + initial.order.gotTimes;
  if (ledger.hasKey(key)) return;
  const token = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'heroRaidOrderReward', identity: identity(player), period: period(initial), raidId: initial.raidId, beforeGot: initial.order.gotTimes } });
  let acknowledged = false;
  try {
    if (!active() || !getSettings().heroRaid.rewards) { ledger.cancel(token); return; }
    const reply = await client.request('HeroRaidGotOrderRewardRequest', { raidId: initial.raidId }, 'HeroRaidOrderResponse'); acknowledged = true;
    if (!orderValid(reply?.order) || reply.order.gotOrderId !== initial.order.gotOrderId || !tiers.some(row => row.orderCount === reply.order.gotTimes) || !receiptHasReward(reply)) throw Error('超凡英雄累计订单领奖结果未确认');
    applyOrder(state, initial, reply.order); ledger.confirm(token);
    report({ key: 'heroRaid', label: '超凡英雄 · 已领取累计订单奖励', ok: true });
  } catch (error) {
    const refused = !acknowledged && error.notSent === true || error.prompt && error.request === 'HeroRaidGotOrderRewardRequest';
    if (refused) ledger.cancel(token);
    report({ key: 'heroRaid', label: '超凡英雄订单奖励', error: error.message, pending: !refused });
  }
}

async function claimDrawRewards(client, config, player, context, initial) {
  const { state, getSettings, ledger, active, report } = context;
  const before = initial.drawTimesInfo;
  if (!drawValid(before)) return;
  const tiers = rows(config, 'HeroRaidLotteryTimesCfg').filter(row => row.raidId === initial.raidId && row.index > before.gotIndex && row.reqTimes <= before.times).sort((a, b) => a.index - b.index);
  if (!tiers.length || tiers[0].index !== before.gotIndex + 1 || tiers.some(row => !valid(row.index) || !valid(row.reqTimes))) return;
  const latest = state.raids.get(initial.raidId);
  if (!active() || !getSettings().heroRaid.rewards || !latest || period(latest) !== period(initial) || JSON.stringify(latest.drawTimesInfo) !== JSON.stringify(before) || !open(latest, nowOf(client))) return;
  const key = 'heroRaidDrawReward:' + identity(player) + ':' + period(initial) + ':' + before.gotIndex;
  if (ledger.hasKey(key)) return;
  const token = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'heroRaidDrawReward', identity: identity(player), period: period(initial), raidId: initial.raidId, beforeGot: before.gotIndex } });
  let acknowledged = false;
  try {
    if (!active() || !getSettings().heroRaid.rewards) { ledger.cancel(token); return; }
    const reply = await client.request('HeroRaidGotRewardRequest', { raidId: initial.raidId }, 'HeroRaidGotRewardResponse'); acknowledged = true;
    if (!drawValid(reply?.gotInfo) || !tiers.some(row => row.index === reply.gotInfo.gotIndex) || reply.gotInfo.times < before.times || !receiptHasReward(reply)) throw Error('超凡英雄累计抽取领奖结果未确认');
    const current = state.raids.get(initial.raidId);
    if (current && period(current) === period(initial) && (!drawValid(current.drawTimesInfo) || current.drawTimesInfo.gotIndex <= reply.gotInfo.gotIndex)) {
      state.raids.set(initial.raidId, { ...current, drawTimesInfo: { times: reply.gotInfo.times, gotIndex: reply.gotInfo.gotIndex } }); state.revision++;
    }
    ledger.confirm(token); report({ key: 'heroRaid', label: '超凡英雄 · 已领取累计抽取奖励', ok: true });
  } catch (error) {
    const refused = !acknowledged && error.notSent === true || error.prompt && error.request === 'HeroRaidGotRewardRequest';
    if (refused) ledger.cancel(token);
    report({ key: 'heroRaid', label: '超凡英雄累计抽取奖励', error: error.message, pending: !refused });
  }
}

export async function runHeroRaidAutomation(client, protocol, config, player, { getSettings, ledger, enabled = () => true, report = () => {} } = {}) {
  if (!getSettings?.()?.heroRaid?.enabled || !enabled() || busy.has(client)) return [];
  if (!ledger) throw Error('超凡英雄自动化需要持久账本');
  const state = watchHeroRaidPushes(client), actor = identity(player), policy = JSON.stringify(getSettings().heroRaid), results = [];
  const emit = entry => { results.push(entry); report(entry); };
  const active = () => enabled() && client.connected !== false && actor === identity(player) && state.observed && !state.invalid && getSettings().heroRaid.enabled && JSON.stringify(getSettings().heroRaid) === policy;
  if (!state.observed || state.invalid) { emit({ key: 'heroRaid', label: '超凡英雄活动', skipped: true, reason: '等待本次连接的完整活动推送' }); return results; }
  if (!exactAutomationId(player?.worldId) || !exactAutomationId(player?.playerId)) return results;
  for (const name of ['HeroRaidFinishOrderRequest', 'HeroRaidGotOrderRewardRequest', 'HeroRaidOrderResponse', 'HeroRaidGotRewardRequest', 'HeroRaidGotRewardResponse']) if (!protocol?.[name]) throw Error('本地协议缺少 ' + name);
  busy.add(client);
  try {
    reconcile(state, player, ledger);
    const context = { state, getSettings, ledger, active, report: emit };
    const ids = [...state.raids.keys()].sort((a, b) => a - b);
    if (!ids.some(id => open(state.raids.get(id), nowOf(client)))) emit({ key: 'heroRaid', label: '超凡英雄活动', skipped: true, reason: '当前没有服务器确认开放的超凡英雄活动' });
    for (const raidId of ids) {
      let raid = state.raids.get(raidId);
      if (!active() || !open(raid, nowOf(client))) continue;
      if (unresolved(ledger, player, raid)) { emit({ key: 'heroRaid', label: '超凡英雄活动', skipped: true, reason: '前次活动操作结果待确认，等待真实活动推送' }); continue; }
      try {
        if (getSettings().heroRaid.orders) await finishOrder(client, protocol, config, player, context, raid);
        raid = state.raids.get(raidId);
        if (!active() || !raid || unresolved(ledger, player, raid) || !getSettings().heroRaid.rewards) continue;
        await claimOrderRewards(client, config, player, context, raid);
        raid = state.raids.get(raidId);
        if (active() && raid && !unresolved(ledger, player, raid)) await claimDrawRewards(client, config, player, context, raid);
      } catch (error) { emit({ key: 'heroRaid', label: '超凡英雄活动', error: error.message, skipped: error.code === 'ORDER_MATERIAL_SPEND_PENDING' }); }
    }
    return results;
  } finally { busy.delete(client); }
}
