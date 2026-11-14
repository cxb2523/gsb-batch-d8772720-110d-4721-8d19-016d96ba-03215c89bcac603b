import { clock, dayOf, natural, positive, read, table, windowOpen } from './activity-actions.mjs';
import { merchantTiming } from './merchant-planner.mjs';

export function merchantStrategyPlan(plan, config, event, state, policy, time, ledger) {
  if (policy.profitLimit > 0 && state.player?.profit >= policy.profitLimit)
    return { kind: 'wait', reason: '已达本期累计利润上限，领奖仍按独立开关执行' };
  if (!['buy', 'move'].includes(plan.kind)) return plan;
  const timing = merchantTiming(config, event, time);
  const moves = Object.values(ledger?.keyRecords() ?? {}).filter(record => record.confirmed &&
    record.details?.scope === 'merchant:' + event.startTime + ':' + event.period &&
    record.details.expected?.request === 'TradeMoveRequest');
  const today = moves.filter(record => dayOf(record.details.expected.start ?? 0) === dayOf(time));
  if (!today.length) {
    if (policy.firstDepartureMode === 'time') {
      const [hour, minute] = policy.firstDepartureTime.split(':').map(Number);
      const at = dayOf(time) * 86400 - 28800 + hour * 3600 + minute * 60;
      if (time < at) return { kind: 'wait', reason: '等待首趟指定出发时间 ' + policy.firstDepartureTime, nextCheckAt: at };
    } else if (plan.exploration) {
      const at = Math.max(event.startTime, timing.tradeStartTime) + policy.firstDepartureWaitMinutes * 60;
      if (time < at) return { kind: 'wait', reason: '首趟等待盈利商品或共享商情，尚未到有限寻价时间', nextCheckAt: at };
    }
  }
  if (plan.kind === 'move' && policy.speedUpMode === 'arrival' && today.some(record =>
    merchantTiming(config, event, record.details.expected.start).marketEpoch === timing.marketEpoch))
    return { kind: 'wait', reason: '本次刷新周期已经出航，等待下一次刷新', nextCheckAt: timing.nextRefreshAt };
  return plan;
}

const pointer = '海商王加速';
const settings = ctx => (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) ?? {};
const scope = 'merchant-pointer-purchase';
async function inventory(client) {
  const items = await read(client, 'AllItem'), resources = await read(client, 'AllResource');
  if (!Array.isArray(items.items) || !Array.isArray(resources.list)) throw Error('指针或钻石库存未完整同步');
  const count = items.items.find(row => row.itemId === pointer)?.num ?? 0;
  const diamonds = resources.list.find(row => row.res === 4)?.amount;
  if (!natural(count) || !natural(diamonds)) throw Error('指针或钻石余额无效');
  return { count, diamonds };
}
export async function buyMerchantPointers(client, config, ctx, event, state, desiredStock, validPlan) {
  const complete = settings(ctx), policy = complete.merchant ?? {}, ledger = ctx.ledger;
  if (!ledger || !policy.autoBuyPointers || !policy.autoSpeedUp) return false;
  const report = entry => ctx.report({ label: '海商王 · 补足商会指针', ...entry });
  const skip = reason => { report({ skipped: true, reason }); return true; };
  const stamp = JSON.stringify(complete), actor = JSON.stringify(ctx.player), today = dayOf(clock(client));
  const allowed = () => ctx.enabled() && client.connected !== false && JSON.stringify(settings(ctx)) === stamp &&
    JSON.stringify(ctx.player) === actor && dayOf(clock(client)) === today && windowOpen(event, clock(client)) &&
    client.tradeWindow?.period === event.period && client.tradeWindow?.startTime === event.startTime &&
    merchantTiming(config, event, clock(client)).tradingOpen && validPlan();
  try {
    const pending = Object.entries(ledger.keyRecords()).find(([, record]) => !record.confirmed && record.details?.scope === scope);
    if (pending) {
      const [key, record] = pending, e = record.details;
      const stock = await inventory(client);
      if (e.day === today && e.period === event.period && e.startTime === event.startTime &&
        state.player?.buySpeedTimes >= e.buyTimes + e.count && stock.count >= e.beforeCount + e.count) {
        ledger.resolveKey(key, true); report({ ok: true, status: 'confirmed', reason: '已核对上次购买次数和指针库存' });
      } else report({ skipped: true, reason: '前次指针购买结果待确认，保留钻石预算，不重复购买' });
      return true;
    }
    if (complete.resources?.allowDiamonds !== true) return skip('未开启全局钻石消费');
    const max = Number(table(config, 'ActivityTradeCfg').find(row => row.key === '海商王加速日购买上限')?.value);
    const price = table(config, 'ItemPriceCfg').find(row => row.itemId === pointer)?.rubyPrice;
    if (!positive(price) || !natural(max) || !positive(desiredStock)) return skip('指针价格或游戏购买上限未确认');
    const fresh = await read(client, 'TradeInfo'), stock = await inventory(client);
    const count = desiredStock - stock.count, bought = fresh.player?.buySpeedTimes;
    if (count <= 0) return false;
    if (fresh.period !== event.period || !natural(bought) || !allowed() ||
      JSON.stringify(fresh.cargo) !== JSON.stringify(state.cargo) || JSON.stringify(fresh.player.goods) !== JSON.stringify(state.player.goods)) return skip('购买前航程、库存或设置已变化');
    if (bought + count > max) return skip('游戏每日指针购买额度不足，不做无效的部分购买');
    const cost = count * price, resources = complete.resources;
    if (stock.diamonds - cost < resources.diamondThreshold) return skip('购买后钻石不足保留量');
    const key = scope + ':' + event.startTime + ':' + event.period + ':' + today + ':' + bought;
    const details = { scope, day: today, period: event.period, startTime: event.startTime, buyTimes: bought, count, beforeCount: stock.count };
    const ticket = ledger.reserve({ diamonds: cost, merchantPointerDiamonds: cost },
      { diamonds: resources.diamondDailyLimit, merchantPointerDiamonds: policy.pointerDailyDiamondLimit ?? 0 }, {}, { uniqueKey: key, details });
    if (!allowed()) { ledger.cancel(ticket); return skip('购买前加速方案或开关变化'); }
    let reply;
    try { reply = await client.request('TradeBuySpeedItemRequest', { buyNum: count }, 'TradeBuySpeedItemResponse'); }
    catch (error) {
      if (error.notSent || error.prompt && error.request === 'TradeBuySpeedItemRequest') ledger.cancel(ticket);
      report({ ok: false, status: error.notSent ? 'cancelled' : error.prompt && error.request === 'TradeBuySpeedItemRequest' ? 'rejected' : 'unknown', error: error.message }); return true;
    }
    try {
      const after = await read(client, 'TradeInfo'), finalStock = await inventory(client);
      if (!natural(reply?.buySpeedTimes) || reply.buySpeedTimes < bought + count || after.period !== event.period ||
        after.player?.buySpeedTimes < bought + count || finalStock.count < stock.count + count || dayOf(clock(client)) !== today) throw Error('指针购买后的次数与库存待确认');
      ledger.confirm(ticket); report({ ok: true, status: 'confirmed', note: '购买 ' + count + ' 根，消耗 ' + cost + ' 钻石；下一次检查重新评估加速' });
    } catch (error) { report({ ok: false, status: 'unknown', error: error.message }); }
    return true;
  } catch (error) { return skip(error.message); }
}
