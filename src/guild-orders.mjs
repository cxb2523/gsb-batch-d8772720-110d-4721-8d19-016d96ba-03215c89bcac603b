import { displayMaterial } from './config.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';
import { toNumber } from './client.mjs';

const key = 'guildOrders';
const label = '联盟订单';
const counterType = 'DAILY_FINISH_GUILD_ORDER';
const busy = new WeakSet();
// Keep unresolved writes across connections in this process. The request has no
// order ID/idempotency key; retrying after a timeout can consume the NEXT order.
const pending = new Map();
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const dayOf = time => Math.floor((time + 8 * 3600) / 86400);

function idText(value) {
  if (value && Number.isInteger(value.low) && Number.isInteger(value.high)) {
    return ((BigInt(value.high) << 32n) + BigInt(value.low >>> 0)).toString();
  }
  if (typeof value === 'bigint' || Number.isSafeInteger(value) || (typeof value === 'string' && /^\d+$/.test(value))) return String(value);
  return null;
}

function amount(raw, name, positive = false) {
  const n = raw == null ? NaN : toNumber(raw);
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0)) throw new Error('无法确认' + name);
  return n;
}

function list(value, name) {
  if (!Array.isArray(value)) throw new Error('未能读取' + name);
  return value;
}

function identity(player) {
  return JSON.stringify([idText(player?.playerId), idText(player?.guildId), idText(player?.worldId), player?.level]);
}

function accountKey(player) {
  return JSON.stringify([idText(player?.playerId), idText(player?.worldId), idText(player?.guildId)]);
}

const roleKey = player => idText(player?.worldId) + ':' + idText(player?.playerId);

function assets(value, name) {
  const map = new Map();
  for (const item of list(value, name)) {
    if (item?.type !== 0 || typeof item.id !== 'string' || !item.id) throw new Error('无法确认' + name + '的道具类型');
    map.set(item.id, amount((map.get(item.id) ?? 0) + amount(item.num, name + '数量', true), name + '总量', true));
  }
  return map;
}

function orderLimit(config, season, level) {
  // Never borrow a more generous quota from another season.
  const available = rows(config, 'GuildOrderNumCfg').filter(row => row.season === season && row.playerLevel <= level);
  const best = available.sort((a, b) => b.playerLevel - a.playerLevel)[0];
  if (!best || !Number.isSafeInteger(best.playerLevel) || best.playerLevel < 1
    || !Number.isSafeInteger(best.maxNum) || best.maxNum < -1
    || available.filter(row => row.playerLevel === best.playerLevel).length !== 1) throw new Error('缺少当前赛季和等级的联盟订单次数配置');
  return best.maxNum;
}

function countOf(reply) {
  const counters = list(reply?.counters, '联盟订单每日次数');
  const found = counters.filter(row => row?.type === counterType);
  if (counters.some(row => typeof row?.type !== 'string' || !row.type) || found.length > 1) throw new Error('联盟订单次数记录异常');
  // Verified in the offline client: counterNum(type) returns zero when the
  // type is absent from a successfully received complete counters snapshot.
  return found.length ? amount(found[0].num, '今日联盟订单次数') : 0;
}

async function request(client, protocol, name, enabled) {
  if (!enabled()) throw new Error('账号已暂停或连接已更换');
  const response = name.replace(/Request$/, 'Response');
  if (!protocol?.[name] || !protocol?.[response]) throw new Error('本地协议缺少' + name);
  return client.request(name, {}, response);
}

export async function readGuildOrderView(client, protocol, config, { player, enabled = () => true } = {}) {
  const view = { state: 'blocked', reason: '', canFinish: false, requirements: [], cities: [], cityId: null,
    doneToday: null, maxNum: null, season: null, nextRefreshTime: null };
  if (!enabled()) return { ...view, reason: '已暂停' };
  const gate = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '联盟')?.playerLevel;
  if (!Number.isSafeInteger(gate) || !Number.isSafeInteger(player?.level)) return { ...view, reason: '无法确认联盟开放条件' };
  if (player.level < gate) return { ...view, reason: '联盟在角色 ' + gate + ' 级开放' };
  const guildId = idText(player.guildId);
  if (guildId === '0') return { ...view, reason: '当前账号未加入联盟' };
  if (!guildId || BigInt(guildId) <= 0n || !idText(player.playerId) || BigInt(idText(player.playerId)) <= 0n) return { ...view, reason: '无法确认账号或联盟身份' };
  const world = amount(player.worldId, '账号区服', true);
  const season = Math.floor(world / 1e6) % 1000;
  if (!season) throw new Error('无法确认当前赛季');
  const maxNum = orderLimit(config, season, player.level);
  const stamp = identity(player);
  const guild = (await request(client, protocol, 'GuildInfoRequest', enabled))?.guild;
  if (idText(guild?.guildId) !== guildId || stamp !== identity(player)) throw new Error('账号或联盟身份已变化');
  const [orderReply, cityReply, counterReply] = await Promise.all([
    request(client, protocol, 'GuildOrderRequest', enabled), request(client, protocol, 'GuildCityInfoRequest', enabled),
    request(client, protocol, 'CounterInfoRequest', enabled),
  ]);
  const order = orderReply?.order;
  const requirements = assets(order?.requirements, '联盟订单材料');
  const nextRefreshTime = amount(order?.nextRefreshTime, '联盟订单刷新时间', true);
  const known = new Set(rows(config, 'GuildOrderCfg').map(row => row.itemId));
  if ([...requirements.keys()].some(id => !known.has(id))) throw new Error('联盟订单包含未识别的材料配置');
  const cities = list(cityReply?.cities, '联盟城市').map(city => ({ cityId: amount(city?.cityId, '联盟城市编号', true), recommended: city.recommended === true }));
  if (new Set(cities.map(city => city.cityId)).size !== cities.length) throw new Error('联盟城市记录重复');
  const doneToday = countOf(counterReply);
  const city = cities.find(city => city.recommended) ?? cities[0];
  Object.assign(view, { season, maxNum, doneToday, cityId: city?.cityId ?? null, cities, nextRefreshTime,
    identity: stamp, accountKey: accountKey(player), day: dayOf(now(client)),
    orderKey: JSON.stringify([nextRefreshTime, [...requirements].sort(([a], [b]) => a.localeCompare(b))]) });
  if (stamp !== identity(player) || !enabled()) throw new Error('账号或联盟状态已变化');
  if (nextRefreshTime <= now(client)) return { ...view, reason: '联盟订单正在刷新，稍后重新检查' };
  if (maxNum !== -1 && doneToday >= maxNum) return { ...view, reason: '今日联盟订单已交 ' + doneToday + ' 单，达到本赛季上限 ' + maxNum };
  if (!requirements.size) return { ...view, reason: '当前没有联盟订单' };
  if (!city) return { ...view, reason: '联盟当前没有可提交订单的城市' };
  const { stock, reservations } = await readOrderReservedStock(client, protocol, config, { player, enabled, itemIds:[...requirements.keys()] });
  if (stamp !== identity(player) || !enabled()) throw new Error('账号或联盟状态已变化');
  view.requirements = [...requirements].map(([id, need]) => {
    const held = Object.fromEntries(Object.entries(reservations).map(([name, values]) => [name, values.get(id) ?? 0]));
    const have = stock.get(id) ?? 0;
    const reserved = held.weekly + held.cargo + held.resident;
    const available = Math.max(0, have - reserved);
    return { id, name: displayMaterial(config, id), need, have, reserved, ...held, available, missing: Math.max(0, need - available) };
  });
  const missing = view.requirements.filter(row => row.missing > 0);
  if (missing.length) return { ...view, reason: '留足周订单、贸易港和居民订单后，还缺' + missing.map(row =>
    row.name + ' ×' + row.missing + '（库存 ' + row.have + '，已预留 ' + row.reserved + '）').join('、') };
  return { ...view, state: 'ready', canFinish: true };
}

export async function serviceGuildOrders(client, protocol, config, { player, enabled = () => false, report = () => {}, scheduler, ledger, dailyLimit = 0 } = {}) {
  const finish = entry => { const result = { key, label, ...entry }; report(result); return result; };
  const skip = reason => finish({ skipped: true, reason });
  const delay = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return skip('已暂停');
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) return skip('联盟募兵每日上限无效');
  if (scheduler && !scheduler.due(key)) return skip('等待下次检查');
  if (busy.has(client)) return skip('正在核对联盟订单');
  busy.add(client);
  try {
    await refreshOrderMaterialSpends(client,player,{enabled});
    const initial = await readGuildOrderView(client, protocol, config, { player, enabled });
    if (ledger && initial.accountKey) {
      for (const [savedKey, record] of Object.entries(ledger.keyRecords())) {
        const data = record.details;
        if (data?.kind !== 'allianceRecruit' || data.accountKey !== initial.accountKey && data.roleKey !== roleKey(player)) continue;
        if (initial.day === data.day && initial.doneToday > data.doneToday || initial.day > data.day && record.confirmed) {
          if (!record.confirmed) ledger.resolveKey(savedKey, true);
          ledger.releaseCompletedKey(savedKey);
        } else if (!record.confirmed || initial.day === data.day && initial.doneToday <= data.doneToday) {
          delay(180); return skip('上次联盟募兵结果尚未确认，持久记录保留，不重复提交');
        }
      }
    }
    if (dailyLimit > 0 && Math.max(initial.doneToday ?? 0, ledger?.snapshot().counters.guildRecruit ?? 0) >= dailyLimit) { delay(300); return skip('已达到设置的今日募兵上限 ' + dailyLimit + ' 次'); }
    if (!initial.canFinish) { delay(180); return skip(initial.reason); }
    const saved = pending.get(initial.accountKey);
    if (saved) {
      if ((initial.day === saved.day && initial.doneToday > saved.doneToday) || (initial.day > saved.day && saved.confirmed)) {
        pending.delete(initial.accountKey);
        delay(60);
        return skip('已重新核对上次联盟订单，下一轮继续');
      }
      delay(180);
      return skip('上次联盟订单结果尚未确认，暂不重复提交；请在游戏中核对');
    }
    // Re-read all competing requirements and inventory, not only the order.
    const current = await readGuildOrderView(client, protocol, config, { player, enabled });
    if (!current.canFinish) { delay(180); return skip(current.reason); }
    if (initial.identity !== current.identity || initial.orderKey !== current.orderKey || initial.doneToday !== current.doneToday
      || initial.cityId !== current.cityId || initial.day !== current.day) return skip('订单、次数或联盟城市已变化，下一轮重新核对');
    // The last membership query narrows the read-to-write window after stock IO.
    const guild = (await request(client, protocol, 'GuildInfoRequest', enabled))?.guild;
    if (!enabled() || identity(player) !== current.identity || idText(guild?.guildId) !== idText(player.guildId)) return skip('账号或联盟状态已变化');
    if (now(client) >= current.nextRefreshTime || dayOf(now(client)) !== current.day) return skip('订单已到刷新时间，下一轮重新核对');
    if (!protocol.FinishGuildOrderRequest || !protocol.FinishGuildOrderResponse) throw new Error('本地协议缺少联盟订单提交');
    const pendingOrder={ day: current.day, doneToday: current.doneToday, confirmed:false };
    const uniqueKey = 'allianceRecruit:' + idText(player.worldId) + ':' + idText(player.playerId) + ':' + current.day + ':' + current.doneToday;
    const ticket = ledger?.reserve({ guildRecruit: 1 }, dailyLimit > 0 ? { guildRecruit: dailyLimit } : {}, { guildRecruit: current.doneToday },
      { uniqueKey, details: { kind: 'allianceRecruit', accountKey: current.accountKey, roleKey: roleKey(player), day: current.day, doneToday: current.doneToday, orderKey: current.orderKey } });
    if (!enabled()) { ledger?.cancel(ticket); return skip('已暂停，未发送募兵'); }
    let debit;
    try {
    debit = beginOrderMaterialSpend(player, current.requirements, '联盟订单',{operation:{onConfirmed:()=>{pendingOrder.confirmed=true;},verify:async(next,{player:actor,enabled:active})=>{
      if(accountKey(actor)!==current.accountKey||dayOf(now(next))!==current.day||!active())return false;
      const reply=await request(next,protocol,'CounterInfoRequest',active);
      return active()&&accountKey(actor)===current.accountKey&&dayOf(now(next))===current.day&&countOf(reply)>current.doneToday;
    }}});
    } catch (error) { ledger?.cancel(ticket); throw error; }
    pending.set(current.accountKey, pendingOrder);
    let reply;
    try {
      reply = await client.request('FinishGuildOrderRequest', { cityId: current.cityId }, 'FinishGuildOrderResponse');
    } catch (error) {
      // A concrete rejection or definitely unsent write can retry after fresh
      // reads. A timeout/disconnect with unknown delivery retains the guard.
      const refused = error.notSent === true || error.prompt && error.request === 'FinishGuildOrderRequest';
      if (refused) {
        pending.delete(current.accountKey);
        cancelOrderMaterialSpend(debit);
        ledger?.cancel(ticket);
      }
      delay(180);
      return finish({ ok: false, error: error.notSent === true ? '联盟订单未发送：' + error.message : refused ? '联盟订单被拒绝：' + error.message : '联盟订单结果未确认，已暂停重复提交：' + error.message });
    }
    const rewards = reply?.reward?.asset;
    const confirmed = Array.isArray(rewards) && rewards.length && rewards.every(item =>
      typeof item?.id === 'string' && item.id && [0, 1].includes(item.type) && Number.isSafeInteger(toNumber(item.num)) && toNumber(item.num) > 0);
    if (!confirmed) {
      delay(180);
      return finish({ ok: false, error: '服务端未返回明确的联盟订单奖励，已暂停重复提交，请核对游戏记录' });
    }
    pendingOrder.confirmed=true;
    ledger?.confirm(ticket);
    confirmOrderMaterialOperation(debit);
    await refreshOrderMaterialSpends(client,player,{enabled});
    delay(60);
    return finish({ ok: true, label: label + ' · 已提交 1 单，获得' + rewards.map(item => displayMaterial(config, item.id) + ' ×' + toNumber(item.num)).join('、') });
  } catch (error) {
    delay(180);
    if (!enabled()) return skip('账号已暂停或连接已更换');
    if (error.code === 'ORDER_MATERIAL_SPEND_PENDING') return skip(error.message);
    if (client.promptNames?.[error.prompt?.prompt] === 'NO_GUILD') return skip('当前账号未加入联盟');
    return finish({ ok: false, error: error.message });
  } finally {
    busy.delete(client);
  }
}
