import { createHash } from 'node:crypto';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { rewardData } from './missing-rewards.mjs';

export const natural = (value) => Number.isSafeInteger(value) && value >= 0;
export const positive = (value) => natural(value) && value > 0;
export const clock = (client) => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
export const dayOf = (time) => Math.floor((time + 28800) / 86400);
export const table = (config, name) => config?.tables?.[name]?.data ?? [];
export const read = async (client, name, body = {}) =>
  rewardData(await client.request(name + 'Request', body, name + 'Response'));
export const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
export const waiting = (ctx, reason) => ctx.report({ label: ctx.label, skipped: true, reason });
export const hasReward = (reply) =>
  reply?.reward?.asset?.some((asset) => positive(Number(rewardData(asset.num)))) ||
  ['hero', 'antique', 'equipIds', 'badge', 'tickets', 'supply'].some((key) => !!reply?.[key]?.length);

export function moduleOpen(config, player, name) {
  const level = table(config, 'ModuleOpenCfg').find((row) => row.moduleId === name)?.playerLevel;
  return positive(level) && positive(player?.level) && player.level >= level;
}

export function windowOpen(entry, time) {
  return (
    positive(entry?.startTime) && positive(entry?.endTime) && entry.startTime <= time && time < entry.endTime
  );
}

export function liveSeries(client, type) {
  const now = clock(client);
  const candidates = [];
  for (const row of client.festivals ?? []) {
    if (
      row.type !== '捞尸人联动活动' &&
      !row.subActivity?.some((s) => [27, 28, 29, 30].includes(s.subActivityType))
    )
      continue;
    if (!windowOpen(row, now)) continue;
    const id = exactAutomationId(row.activityId);
    if (!id) continue;
    for (const sub of row.subActivity ?? []) {
      if (
        sub.subActivityType !== type ||
        !windowOpen({ startTime: sub.openTime || row.startTime, endTime: sub.closeTime || row.endTime }, now)
      )
        continue;
      candidates.push({ id, row, sub, body: { activityId: automationWireId(id) } });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export async function itemBalance(client, id) {
  const bag = await read(client, 'AllItem');
  if (!Array.isArray(bag.items)) throw Error('库存未同步');
  const rows = bag.items.filter((item) => item.itemId === id);
  if (rows.some((item) => !natural(item.num))) throw Error('道具数量未确认');
  const total = rows.reduce((n, item) => n + item.num, 0);
  if (!natural(total)) throw Error('道具数量超出范围');
  return total;
}

// 对会消耗道具、商会币或投票券的操作，先写入已有账号账本，再发请求。
// 同一期同玩法的未知结果必须通过游戏状态核实，重新连接也不能换个目标绕过。
export async function checkedAction(
  ctx,
  { scope, before, expected, label, allowed, send, inspect, matches, accept, retainEvidence = false, attemptedAt, onOutcome,
    now = () => Math.floor(Date.now() / 1000), counters = {}, limits = {} }
) {
  const outcome = async data => {
    if (!onOutcome) return;
    try {
      await onOutcome(data);
      if (retainEvidence && data.status === 'confirmed') {
        const record = ctx.ledger.keyRecords()[data.actionKey];
        if (record?.confirmed) ctx.ledger.resolveKey(data.actionKey, true, { ...record.details, journalRecorded: true });
      }
    }
    catch (error) { ctx.report({ label, skipped: true, reason: '动作结果已保留，统计记录待修复：' + error.message }); }
  };
  if (!ctx.enabled() || !allowed()) return waiting(ctx, '开关或活动时间已变化');
  if (!ctx.ledger) return waiting(ctx, '账号执行记录不可用');
  const records = Object.entries(ctx.ledger.keyRecords());
  for (const [key, record] of records) {
    if (record.confirmed || record.details?.scope !== scope) continue;
    if (!matches(record.details.expected, before))
      return waiting(ctx, '前次操作结果待确认，等待游戏状态更新');
    ctx.ledger.resolveKey(key, true, retainEvidence ? { ...record.details, after: before, confirmedAt: now() } : undefined);
    await outcome({ actionKey: key, expected: record.details.expected, before: record.details.before, after: before,
      attemptedAt: record.details.attemptedAt, status: 'confirmed' });
    ctx.report({ label, ok: true, status: 'confirmed', reason: '已回读确认前次操作' });
    return;
  }
  const identity = { ...expected };
  // 同一程调港按起点和终点防重，兼容早期未记录目标商品的账本。
  if (identity.request === 'TradeMoveRequest') delete identity.goodsId;
  delete identity.start; // 发送时刻用于回读核对，不改变动作的防重标识。
  const key = 'event-action:' + digest([scope, identity, before]);
  if (ctx.ledger.hasKey(key)) return waiting(ctx, '本次状态已处理，等待下一次更新');
  const ticket = ctx.ledger.reserve(counters, limits, {}, { uniqueKey: key, details: {
    scope, expected, ...(retainEvidence ? { before, attemptedAt } : {})
  } });
  if (!ctx.enabled() || !allowed()) {
    ctx.ledger.cancel(ticket);
    return;
  }
  try {
    const reply = await send();
    const after = await inspect();
    if (!accept(reply) || !matches(expected, after)) throw Error('服务端结果待确认');
    if (retainEvidence) ctx.ledger.resolveKey(key, true, { scope, expected, before, after, attemptedAt, confirmedAt: now() });
    else ctx.ledger.confirm(ticket);
    await outcome({ actionKey: key, expected, before, after, attemptedAt, status: 'confirmed' });
    ctx.report({ label, ok: true, status: 'confirmed' });
  } catch (error) {
    if (error.released) {
      ctx.ledger.cancel(ticket);
      return waiting(ctx, error.message);
    }
    if (error.prompt && error.request === expected.request) ctx.ledger.cancel(ticket);
    await outcome({ actionKey: key, expected, before, attemptedAt,
      status: error.prompt && error.request === expected.request ? 'rejected' : 'unknown', reason: error.message });
    ctx.report({
      label,
      ok: false,
      status: error.prompt && error.request === expected.request ? 'rejected' : 'unknown',
      error: error.message
    });
  }
}
