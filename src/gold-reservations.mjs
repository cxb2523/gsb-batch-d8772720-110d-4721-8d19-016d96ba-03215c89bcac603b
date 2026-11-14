import { toNumber } from './client.mjs';
import { uidText } from './hero-equipment.mjs';

// A queue update can arrive before the resource snapshot reflects its debit.
// Keep this barrier by role/world (not connection) until a later gold read has
// accounted for that write. Only an attributed server refusal cancels it.
const pending = new Map();

export function goldAccountKey(player) {
  const uid = uidText(player?.playerId);
  const world = toNumber(player?.worldId);
  if (!uid || !Number.isSafeInteger(world) || world <= 0) throw new Error('无法确认金币操作的账号和区服');
  return JSON.stringify([uid, world]);
}

function balanceNumber(value) {
  const balance = value == null ? NaN : toNumber(value);
  if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('无法确认金币余额');
  return balance;
}

export function reconcileGold(player, value) {
  const key = goldAccountKey(player);
  const balance = balanceNumber(value);
  const saved = pending.get(key);
  if (saved && !saved.operation && balance <= saved.expectedAfter) pending.delete(key);
  return !pending.has(key);
}

export function reserveGold(player, value, cost, request, { operation = null } = {}) {
  const key = goldAccountKey(player);
  const balance = balanceNumber(value);
  if (!Number.isSafeInteger(cost) || cost <= 0 || balance < cost || typeof request !== 'string' || !request) {
    throw new Error('无法确认本次金币消耗');
  }
  if (!reconcileGold(player, balance)) throw new Error('上次操作的金币扣款尚未同步，等待余额更新');
  if (operation !== null && (typeof operation !== 'object' || (operation.verify != null && typeof operation.verify !== 'function'))) {
    throw new Error('无法确认金币操作的核对方式');
  }
  const ticket = { key, request, expectedAfter: balance - cost, operation };
  pending.set(key, ticket);
  return ticket;
}

export function pendingGoldSpend(player) { return pending.get(goldAccountKey(player)) ?? null; }

// A receipt proves the operation, not the age of a previously read balance.
// Keep the ticket until a complete balance is requested AFTER that evidence.
export function confirmGoldOperation(ticket) {
  if (ticket?.operation && pending.get(ticket.key) === ticket) ticket.operation.confirmed = true;
}

export async function readGoldSpendState(client, player, { enabled = () => true } = {}) {
  const key = goldAccountKey(player), ticket = pending.get(key);
  if (!ticket?.operation || !enabled()) return null;
  try {
    const confirmed = ticket.operation.confirmed === true || await ticket.operation.verify?.(client, { player, enabled }) === true;
    if (!confirmed || !enabled() || goldAccountKey(player) !== key || client.connected === false) return null;
    ticket.operation.confirmed = true;
    ticket.operation.onConfirmed?.();
    return { key, ticket };
  } catch { return null; }
}

export function settleGoldSpendState(player, snapshot, value) {
  balanceNumber(value);
  if (!snapshot || goldAccountKey(player) !== snapshot.key || pending.get(snapshot.key) !== snapshot.ticket) return false;
  pending.delete(snapshot.key);
  return true;
}

export async function refreshGoldSpend(client, player, { enabled = () => true } = {}) {
  try {
    const snapshot = await readGoldSpendState(client, player, { enabled });
    if (!snapshot) return !pendingGoldSpend(player);
    const reply = await client.request('AllResourceRequest', {}, 'AllResourceResponse');
    if (!Array.isArray(reply?.list) || !enabled() || client.connected === false || goldAccountKey(player) !== snapshot.key) return false;
    const seen = new Set();
    for (const row of reply.list) {
      if (!Number.isSafeInteger(row?.res) || seen.has(row.res)) return false;
      seen.add(row.res); balanceNumber(row.amount);
    }
    const gold = reply.list.find(row => row.res === 3);
    return !!gold && settleGoldSpendState(player, snapshot, gold.amount);
  } catch { return false; }
}

export function rejectGold(ticket, error) {
  if (ticket && error?.prompt && error.request === ticket.request && pending.get(ticket.key) === ticket) {
    pending.delete(ticket.key);
  }
}

// Only the caller that still owns this reservation may cancel a write it has
// proved was never sent. A later reservation must survive stale cancellation.
export function cancelUnsentGold(ticket) {
  if (ticket && pending.get(ticket.key) === ticket) pending.delete(ticket.key);
}
