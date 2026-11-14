import { createHash } from 'node:crypto';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';
import { dispatchReservationReason, fleetRecordReason, reserveDispatch } from './fleet-availability.mjs';
import { registerFleetReservations } from './fleet-reservations.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';

// 硅矿奖励由服务器自动发放；ChipMineRewardRequest 只是读取共享周期次数。
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const day = time => Math.floor((time + 28800) / 86400);
const fleetNumber = id => /^([1-3])远征船$/.exec(id ?? '')?.[1];
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24);
const nameKey = value => String(value ?? '').trim().toLocaleLowerCase();
const identity = player => [exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), exactAutomationId(player?.guildId)].join(':');
const active = new WeakSet(), watchers = new WeakMap();
const stateKey = world => 'silicon-state:' + world;
const slotKey = (world, id) => 'silicon:' + world + ':' + fleetNumber(id);
const ownSlot = (snapshot, id) => snapshot.mines.flatMap(mine => mine.positions.map(position => ({ mine, position }))).find(row => row.position.player?.fleetId === id);
const idle = fleet => fleet?.state === 1 && !fleet.curGridIdx && !fleet.targetGridIdx && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs && !fleet.autoFight?.isOn;

function quantity(value) {
  if (integer(value)) return value;
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) n = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
const get = async (client, protocol, name, body = {}) => {
  if (!protocol?.[name + 'Request'] || !protocol?.[name + 'Response']) throw Error('当前协议缺少 ' + name);
  return client.request(name + 'Request', body, name + 'Response', 8000);
};
function openingReason(config, player, time) {
  const level = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界')?.playerLevel;
  if (!integer(level, 1) || !integer(player?.level, 1)) return '世界开放等级未确认';
  if (player.level < level) return `世界玩法在 ${level} 级开放`;
  const opened = gameplayOpenDay(config, player, '芯片'), age = worldOpenDays(player, time);
  if (!(opened > 0)) return '当前赛季尚未开放硅矿';
  if (!integer(age, 1) || age < opened) return '未达到当前赛季硅矿开放天数';
  if (!exactAutomationId(player?.worldId) || !exactAutomationId(player?.playerId)) return '角色或区服身份未确认';
  return '';
}
export function siliconInWindow(windows, time) {
  if (!windows?.length) return true;
  const minute = Math.floor(((time + 28800) % 86400) / 60);
  return windows.some(window => {
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
    if (!m) return false;
    const start = Number(m[1]) * 60 + Number(m[2]), end = Number(m[3]) * 60 + Number(m[4]);
    if (Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59) return false;
    return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
  });
}
export const siliconInterval = settings => settings?.silicon?.fleets?.some(fleet => fleet.enabled && fleet.pursuit && !fleet.emptyOnly && fleet.tier !== 'BLUE') ? 120000 : 600000;
export function watchSiliconMining(client) {
  if (watchers.has(client)) return watchers.get(client);
  const listeners = new Set(), minutes = new Map();
  const watcher = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    wake() { for (const fn of listeners) { try { fn(); } catch {} } },
    repairMinutes() { const value = minutes.get(4); return value?.day === day(now(client)) ? value.minutes : null; } };
  client.on?.('message', ({ name, body }) => {
    if (name === 'SCSpeedUp') for (const row of body?.data ?? []) if (integer(row.type) && Number.isFinite(row.minutes) && row.minutes >= 0) minutes.set(row.type, { minutes: row.minutes, day: day(now(client)) });
    if (['SCChipMine', 'SCChipMineRewardInfo', 'SCMyFleetUpdate', 'SCMyFleetPower', 'SCNewCampaignReport', 'SCUpdateItem'].includes(name)) watcher.wake();
  });
  watchers.set(client, watcher); return watcher;
}

function rewardDay(snapshot, ledger) {
  const prior = ledger?.keyRecords?.()[stateKey(snapshot.worldId)]?.details ?? {};
  const today = day(snapshot.checkedAt), count = snapshot.reward.myRewardTimes;
  const sameCycle = prior.rewardResetTime === snapshot.reward.rewardResetTime;
  // 首次读到的是三日累计，没有可靠证据可减掉昨日次数。宁可少派，不虚构今日为零。
  const delta = sameCycle && integer(prior.rewardCount) && count >= prior.rewardCount ? count - prior.rewardCount : count;
  return { ...prior, day: today, dailyRewards: (prior.day === today ? prior.dailyRewards ?? 0 : 0) + delta,
    rewardCount: count, rewardResetTime: snapshot.reward.rewardResetTime, observedAt: snapshot.checkedAt,
    failures: prior.day === today ? prior.failures ?? {} : {}, defeated: prior.defeated ?? {}, reports: prior.reports ?? [] };
}
function persistState(ledger, world, state) {
  const key = stateKey(world);
  if (ledger.hasKey(key)) ledger.updateKeyDetails(key, state);
  else { const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: state }); ledger.confirm(ticket); }
}

export async function readSiliconMining(client, protocol, config, player, { settings, ledger } = {}) {
  const snapshot = { checkedAt: now(client), worldId: exactAutomationId(player?.worldId), playerId: exactAutomationId(player?.playerId), nickname: player?.nickname,
    guildIdx: Number(BigInt(exactAutomationId(player?.guildId) ?? '0') % 1000n), reason: '', notes: [], reward: null, dailyRewards: null,
    mines: [], fleets: [], buildings: [], fuel: null, petrolCost: null, pendingFuel: ledger ? pendingPetrol(ledger) : 0, repairs: {}, blacklist: [], fightTimes: 0, maxFightTimes: null };
  snapshot.reason = openingReason(config, player, snapshot.checkedAt);
  if (snapshot.reason) return snapshot;
  const p = settings?.silicon;
  if (!p) { snapshot.reason = '硅矿配置未同步'; return snapshot; }
  const who = identity(player);
  let list, reward, own, water, bag, merge;
  try {
    [list, reward, own, water, bag, merge] = await Promise.all(['ChipMineList', 'ChipMineReward', 'MyFleets', 'OnWater', 'AllItem', 'UniteWorldsPlan'].map(name => get(client, protocol, name)));
  } catch (error) { snapshot.reason = '硅矿状态读取失败：' + error.message; return snapshot; }
  if (who !== identity(player)) { snapshot.reason = '读取期间账号或联盟已变化'; return snapshot; }
  if (![list.chipMines, own.fleets, water.building, bag.items, merge.worldIds].every(Array.isArray)) { snapshot.reason = '矿区、舰队、库存或合服信息不完整'; return snapshot; }
  const r = reward.rewardInfo;
  if (!r || ![r.myRewardTimes, r.rewardResetTime, r.maxRewardTimes].every(n => integer(n)) || r.rewardResetTime <= snapshot.checkedAt) { snapshot.reason = '硅矿奖励周期或剩余次数未同步'; return snapshot; }
  snapshot.reward = { myRewardTimes: r.myRewardTimes, rewardResetTime: r.rewardResetTime, maxRewardTimes: r.maxRewardTimes };
  snapshot.dailyRewards = rewardDay(snapshot, ledger).dailyRewards;
  const fuels = bag.items.filter(item => item.itemId === '汽油');
  snapshot.fuel = fuels.length > 1 ? null : fuels.length ? quantity(fuels[0].num) : 0;
  snapshot.petrolCost = rows(config, 'WorldParamCfg').find(row => row.paramName === '采集硅矿消耗汽油')?.paramValue;
  if (!integer(snapshot.fuel) || !integer(snapshot.petrolCost, 1)) { snapshot.reason = '硅矿汽油余额或派遣消耗未确认'; return snapshot; }
  if (merge.matchMaking || (merge.worldIds.length && merge.executeTs > 0 && (snapshot.checkedAt >= merge.executeTs - 3600 || day(snapshot.checkedAt) === day(merge.executeTs)))) snapshot.reason = '合服匹配或执行期间暂停硅矿派遣';
  snapshot.buildings = water.building;
  snapshot.fleets = own.fleets.map(fleet => ({ ...fleet, state: fleet.state, durability: fleet.durability, maxDura: fleet.maxDura,
    curGridIdx: fleet.curGridIdx ?? 0, targetGridIdx: fleet.targetGridIdx ?? 0, treasureLootUid: fleet.treasureLootUid ?? 0,
    power: quantity(fleet.power), ownerPlayerId: fleet.owner ? exactAutomationId(fleet.owner.playerId) : null }));
  if (new Set(snapshot.fleets.map(fleet => fleet.buildingId)).size !== snapshot.fleets.length) { snapshot.reason = '舰队编号重复'; return snapshot; }
  const colors = new Map(['BLUE', 'PURPLE', 'ORANGE'].flatMap(tier => rows(config, 'ChipMineCfg').filter(row => row.quality === tier && row.qualityIndex === protocol.Color?.[tier]).map(row => [row.qualityIndex, row])));
  if (new Set(list.chipMines.map(mine => mine.gridId)).size !== list.chipMines.length) { snapshot.reason = '矿区编号重复'; return snapshot; }
  // 同名响应没有 gridId，必须逐矿查询，不能并发造成目标错配。
  for (const mine of list.chipMines) {
    const type = colors.get(mine.color);
    if (!type || !integer(mine.gridId, 1)) continue;
    const item = { gridId: mine.gridId, tier: type.quality, color: mine.color, name: type.name, positions: [], reason: '' }; snapshot.mines.push(item);
    try {
      const detail = await get(client, protocol, 'ChipMine', { gridId: mine.gridId });
      if (!Array.isArray(detail.occupiedPositions) || !integer(detail.positionNum) || !integer(detail.occupiedNum) || !integer(detail.fightTimes) || !integer(detail.maxFightTimes)) throw Error('矿区位置和抢占次数未同步');
      if (!detail.rewardInfo || ![detail.rewardInfo.myRewardTimes, detail.rewardInfo.rewardResetTime, detail.rewardInfo.maxRewardTimes].every(n => integer(n)) || detail.rewardInfo.rewardResetTime !== snapshot.reward.rewardResetTime) throw Error('读取期间硅矿奖励周期发生变化');
      snapshot.reward.myRewardTimes = Math.max(snapshot.reward.myRewardTimes, detail.rewardInfo.myRewardTimes);
      snapshot.reward.maxRewardTimes = Math.min(snapshot.reward.maxRewardTimes, detail.rewardInfo.maxRewardTimes);
      item.positionNum = detail.positionNum; item.occupiedNum = detail.occupiedNum;
      item.positions = detail.occupiedPositions.map(position => ({ index: position.index, player: position.player ? {
        nickname: position.player.nickname, guildIdx: position.player.guildIdx, power: quantity(position.player.power),
        rewardTimes: position.player.rewardTimes, fleetId: position.player.fleetId ?? '' } : null }));
      if (item.positions.some(position => !integer(position.index) || (type.quality !== 'BLUE' && position.index >= item.positionNum) || position.player && (typeof position.player.nickname !== 'string' || !integer(position.player.guildIdx) || !integer(position.player.power) || !integer(position.player.rewardTimes))) || new Set(item.positions.map(position => position.index)).size !== item.positions.length) throw Error('矿位身份或索引不完整');
      snapshot.fightTimes = Math.max(snapshot.fightTimes, detail.fightTimes);
      snapshot.maxFightTimes = Math.min(snapshot.maxFightTimes ?? detail.maxFightTimes, detail.maxFightTimes);
    } catch (error) { item.reason = error.message; }
  }
  snapshot.dailyRewards = rewardDay(snapshot, ledger).dailyRewards;
  if (!snapshot.mines.length) snapshot.reason ||= '当前没有已确认的硅矿';
  for (const policy of p.fleets.filter(fleet => fleet.enabled && fleet.autoRepair)) {
    const fleet = snapshot.fleets.find(row => row.buildingId === policy.id);
    if (!idle(fleet) || !(fleet.durability < fleet.maxDura)) continue;
    try { snapshot.repairs[policy.id] = await get(client, protocol, 'FleetRepairParam', { buildingId: policy.id }); }
    catch { snapshot.notes.push(policy.id + '维修报价未同步'); }
  }
  if (p.fleets.some(fleet => fleet.enabled && fleet.pursuit && !fleet.emptyOnly && fleet.tier !== 'BLUE')) {
    try { const black = await get(client, protocol, 'BlackList'); if (!Array.isArray(black.list)) throw Error(); snapshot.blacklist = black.list.filter(row => exactAutomationId(row.playerId) && row.nickname).map(row => ({ id: exactAutomationId(row.playerId), name: nameKey(row.nickname) })); }
    catch { snapshot.notes.push('游戏黑名单未同步，本轮不追击'); }
  }
  return snapshot;
}

const opponentKey = player => hash([nameKey(player.nickname), player.guildIdx]);
export function siliconPursuitActive(snapshot, policy, settings) {
  // rewardResetTime 是服务端三日周期，不把每15分钟产奖误当作三日重置。
  const start = snapshot.reward?.rewardResetTime - 3 * 86400;
  return policy.pursuit && !policy.emptyOnly && policy.tier !== 'BLUE' && integer(settings.silicon.pursuitMinutes, 1)
    && snapshot.checkedAt >= start && snapshot.checkedAt < start + settings.silicon.pursuitMinutes * 60;
}
function capReason(snapshot, p) {
  if (snapshot.reward.myRewardTimes >= snapshot.reward.maxRewardTimes) return '已达服务器本周期硅矿奖励上限';
  if (p.dailyRewardLimit > 0 && snapshot.dailyRewards >= p.dailyRewardLimit) return '已达今日硅矿奖励上限';
  return '';
}
function fleetReason(snapshot, policy, settings, ledger, client) {
  const fleet = snapshot.fleets.find(row => row.buildingId === policy.id);
  if (!fleet) return '舰队不存在';
  if (fleet.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId) return '舰队归属不符';
  const held = fleetRecordReason(ledger.keyRecords(), policy.id, snapshot.worldId) || dispatchReservationReason(client, settings, 'silicon', policy.id);
  if (held) return held;
  if (!idle(fleet)) return '舰队在行军、维修、驻守或战斗';
  if (!integer(fleet.durability, 1) || !integer(fleet.maxDura, 1) || fleet.durability * 100 < fleet.maxDura * (policy.minDurabilityPercent ?? 1)) return '舰队耐久不足';
  if (!snapshot.buildings.some(building => building.buildingId === policy.id && building.level > 0 && building.fleet?.formation?.heroPositions?.some(hero => hero.heroId))) return '缺少已保存的舰队编队';
  return '';
}
export function planSiliconMining(snapshot, settings, ledger, client) {
  const p = settings.silicon, result = { checkedAt: snapshot.checkedAt, dailyRewards: snapshot.dailyRewards, reward: snapshot.reward, actions: [], rows: [], notes: [...snapshot.notes], reason: snapshot.reason };
  if (!p.enabled) { result.reason = '硅矿总开关已关闭'; return result; }
  if (snapshot.reason || !snapshot.reward) return result;
  const state = rewardDay(snapshot, ledger), cap = capReason(snapshot, p), inWindow = siliconInWindow(p.windows, snapshot.checkedAt);
  const keys = ledger.keyRecords(), used = ledger.snapshot().counters;
  let availableFuel = snapshot.fuel - snapshot.pendingFuel, plannedAttacks = [1, 2, 3].reduce((count, n) => count + (ledger.pendingCounters()['siliconAttacks' + n] ?? 0), 0);
  const targetHeld = (gridId, index) => result.actions.some(action => action.gridId === gridId && action.index === index)
    || Object.values(keys).some(record => record.details?.kind === 'siliconDispatch' && record.details.worldId === snapshot.worldId && record.details.active !== false && record.details.gridId === gridId && record.details.index === index);
  if (cap) result.notes.push(cap);
  for (const policy of p.fleets) {
    const own = ownSlot(snapshot, policy.id), fleet = snapshot.fleets.find(row => row.buildingId === policy.id), row = { id: policy.id, enabled: policy.enabled, reason: '', target: null }; result.rows.push(row);
    if (!policy.enabled) { row.reason = '舰队未启用'; continue; }
    if (cap || !inWindow) {
      row.reason = cap || '不在硅矿占领时段';
      if (own && own.position.player.rewardTimes > 0 && !keys['silicon-retreat:' + snapshot.worldId + ':' + fleetNumber(policy.id)]) result.actions.push({ kind: 'siliconRetreat', request: 'ChipMineRetreatRequest', body: { fleetId: policy.id }, buildingId: policy.id, gridId: own.mine.gridId, beforeRewardTs: fleet?.chipWar?.rewardTs ?? 0, label: policy.id + '硅矿撤回', costs: [] });
      else if (own) row.reason += '；尚未完成首次15分钟采集，等待服务器允许撤回';
      continue;
    }
    if (own) { row.reason = '已在' + own.mine.name + '采集'; continue; }
    row.reason = fleetReason(snapshot, policy, settings, ledger, client);
    if (row.reason) continue;
    if (availableFuel - snapshot.petrolCost < p.petrolReserve) { row.reason = '汽油不足或将低于保留量'; continue; }
    if (p.dailyPetrolLimit > 0 && (used.siliconPetrol ?? 0) + snapshot.petrolCost > p.dailyPetrolLimit) { row.reason = '今日硅矿汽油预算不足'; continue; }
    const pursuit = siliconPursuitActive(snapshot, policy, settings), candidates = [];
    for (const mine of snapshot.mines.filter(mine => mine.tier === policy.tier && !mine.reason)) {
      if (!pursuit) {
        const count = mine.tier === 'BLUE' ? 3 : mine.positionNum;
        for (let index = 0; index < count; index++) if (!mine.positions.some(position => position.index === index && position.player) && !targetHeld(mine.gridId, index)) candidates.push({ mine, index, opponent: null });
      }
      if (policy.emptyOnly || policy.tier === 'BLUE' || (policy.dailyAttackLimit > 0 && (used['siliconAttacks' + fleetNumber(policy.id)] ?? 0) >= policy.dailyAttackLimit) || snapshot.fightTimes + plannedAttacks >= snapshot.maxFightTimes) continue;
      for (const position of mine.positions) {
        const target = position.player;
        if (!target || target.fleetId || target.guildIdx === snapshot.guildIdx || target.nickname === '' || !integer(fleet.power, 1) || target.power > fleet.power * (policy.maxPowerRatio ?? 100) / 100) continue;
        if ((policy.safePlayers ?? []).some(name => nameKey(name) === nameKey(target.nickname)) || (policy.safeGuilds ?? []).map(String).includes(String(target.guildIdx))) continue;
        if (policy.failureLimit > 0 && (state.failures[policy.id + ':' + opponentKey(target)] ?? 0) >= policy.failureLimit) continue;
        if (pursuit && (!state.defeated[opponentKey(target)] || snapshot.blacklist.filter(member => member.name === nameKey(target.nickname)).length !== 1)) continue;
        if (targetHeld(mine.gridId, position.index)) continue;
        candidates.push({ mine, index: position.index, opponent: target });
      }
    }
    candidates.sort((a, b) => Number(Boolean(a.opponent)) - Number(Boolean(b.opponent)) || (a.opponent && b.opponent ? (policy.opponentOrder === 'powerAsc' ? 1 : -1) * (a.opponent.power - b.opponent.power) : 0) || a.mine.gridId - b.mine.gridId || a.index - b.index);
    const target = candidates[0];
    if (!target) { row.reason = pursuit ? '追击时段：没有已击败且在游戏黑名单中的合规目标，保持待命' : '当前没有符合矿级、安全名单、战力及次数限制的位置'; continue; }
    const action = { kind: 'siliconDispatch', request: 'ChipMineSendFleetRequest', body: { gridId: target.mine.gridId, index: target.index, fleetId: policy.id },
      buildingId: policy.id, gridId: target.mine.gridId, index: target.index, color: target.mine.color, opponent: target.opponent, pursuit,
      cost: snapshot.petrolCost, costs: [{ id: '汽油', num: snapshot.petrolCost }], label: policy.id + (target.opponent ? '抢占' : '采集') + target.mine.name };
    result.actions.push(action); row.target = { gridId: action.gridId, index: action.index, nickname: action.opponent?.nickname ?? null }; row.reason = action.label;
    availableFuel -= action.cost; used.siliconPetrol = (used.siliconPetrol ?? 0) + action.cost; if (target.opponent) plannedAttacks++;
  }
  return result;
}

function installReservations(client, ledger, world) {
  registerFleetReservations(client, 'silicon', id => Object.entries(ledger.keyRecords()).some(([key, record]) => key.startsWith('silicon:' + world + ':') && record.details?.buildingId === id && record.details.active !== false), () => Object.entries(ledger.keyRecords()).some(([key, record]) => key.startsWith('silicon:' + world + ':') && record.details?.active !== false));
}
async function reconcile(client, protocol, snapshot, ledger) {
  if (snapshot.reason || !snapshot.reward) return;
  const state = rewardDay(snapshot, ledger), keys = ledger.keyRecords();
  for (const [key, record] of Object.entries(keys)) {
    const details = record.details;
    if (!details || details.worldId !== snapshot.worldId || !key.startsWith('silicon')) continue;
    const fleet = snapshot.fleets.find(row => row.buildingId === details.buildingId), position = ownSlot(snapshot, details.buildingId);
    if (['siliconDispatch','siliconRetreat'].includes(details.kind) && !snapshot.mines.some(mine => mine.gridId === details.gridId && !mine.reason)) continue;
    if (details.kind === 'siliconDispatch') {
      const occupied = position?.mine.gridId === details.gridId && position.position.index === details.index;
      const traveling = fleet?.state === 2 && fleet.targetGridIdx === details.gridId;
      if (!record.confirmed && (occupied || traveling)) ledger.resolveKey(key, true, { ...details, occupied: occupied || details.occupied, active: true });
      else if (occupied && !details.occupied) ledger.updateKeyDetails(key, { ...details, occupied: true, active: true });
      if (record.confirmed && idle(fleet)) {
        if (details.opponent && !details.occupied) state.failures[details.buildingId + ':' + opponentKey(details.opponent)] = (state.failures[details.buildingId + ':' + opponentKey(details.opponent)] ?? 0) + 1;
        ledger.releaseCompletedKey(key);
      }
    } else if (details.kind === 'siliconRetreat' && !position && fleet && (idle(fleet) || fleet.state === 2 && fleet.targetGridIdx !== details.gridId)) {
      ledger.resolveKey(key, true); ledger.releaseCompletedKey(key);
    } else if (details.kind === 'siliconRepair' && fleet && (fleet.state === 4 && fleet.repairing?.startTs >= details.sentAt || fleet.durability > details.beforeDurability)) {
      ledger.resolveKey(key, true); if (idle(fleet)) ledger.releaseCompletedKey(key);
    } else if (details.kind === 'siliconSpeed' && fleet && (details.repair ? fleet.repairing?.endTs < details.beforeEnd || snapshot.checkedAt < details.beforeEnd && idle(fleet) && fleet.durability >= details.targetDurability : fleet.moveEndTs < details.beforeEnd && fleet.moveStartTs === details.moveStartTs)) {
      ledger.resolveKey(key, true); ledger.releaseCompletedKey(key);
    }
  }
  // 用真实个人战报确认“曾击败”，不把空位占领或总战力较高推断成胜利。
  const targets = Object.entries(keys).filter(([key, record]) => key.startsWith('silicon:' + snapshot.worldId + ':') && record.details?.opponent && !record.details.won);
  if (targets.length) {
    try {
      const response = await get(client, protocol, 'CampaignReports', { pageNo: 0 });
      for (const report of response.reports ?? []) {
        const uid = exactAutomationId(report.uid), at = quantity(report.createTime);
        if (!uid || report.type !== 11 || report.mySide !== 0 || report.win !== true || !integer(at) || state.reports.includes(uid)) continue;
        const matching = targets.filter(([, record]) => record.details.buildingId === report.chipWar?.fleetId && record.details.color === report.chipWar?.color && at >= record.details.sentAt);
        if (matching.length !== 1) continue;
        const [key, record] = matching[0], detail = await get(client, protocol, 'CampaignReportDetail', { campaignId: automationWireId(uid) });
        if (!detail.battles?.some(battle => battle.win === true && nameKey(battle.rightCamp?.player?.nickname) === nameKey(record.details.opponent.nickname))) continue;
        state.defeated[opponentKey(record.details.opponent)] = { nickname: record.details.opponent.nickname, guildIdx: record.details.opponent.guildIdx, at };
        state.reports.push(uid); if (ledger.hasKey(key)) ledger.updateKeyDetails(key, { ...ledger.keyRecords()[key].details, won: true });
      }
    } catch { /* 战报失败不会把目标加入追击名单。 */ }
  }
  state.reports = state.reports.slice(-500); persistState(ledger, snapshot.worldId, state);
}

async function sendAndCheck(client, protocol, player, options, snapshot, step, counters = {}, limits = {}) {
  const { getSettings, ledger, enabled = () => true, report = () => {} } = options, settings = getSettings(), who = identity(player), today = day(snapshot.checkedAt);
  const key = step.kind === 'siliconDispatch' ? slotKey(snapshot.worldId, step.buildingId) : step.kind === 'siliconRetreat' ? 'silicon-retreat:' + snapshot.worldId + ':' + fleetNumber(step.buildingId) : 'silicon-' + step.kind.slice(7).toLowerCase() + ':' + snapshot.worldId + ':' + fleetNumber(step.buildingId);
  if (ledger.hasKey(key)) return false;
  if (!protocol?.[step.request]) throw Error('当前协议缺少 ' + step.request);
  if (['siliconRepair','siliconSpeed'].includes(step.kind)) {
    const own = await get(client, protocol, 'MyFleets'), fleet = own.fleets?.find(row => row.buildingId === step.buildingId);
    if (!fleet || (step.kind === 'siliconRepair' ? !idle(fleet) || fleet.durability !== step.beforeDurability : step.repair ? fleet.state !== 4 || fleet.repairing?.endTs !== step.beforeEnd : fleet.state !== 2 || fleet.moveStartTs !== step.moveStartTs || fleet.moveEndTs !== step.beforeEnd)) return false;
  }
  const details = { kind: step.kind, worldId: snapshot.worldId, buildingId: step.buildingId, gridId: step.gridId ?? 0, index: step.index ?? 0,
    color: step.color ?? 0, opponent: step.opponent ?? null, sentAt: snapshot.checkedAt, active: true, occupied: false,
    beforeDurability: step.beforeDurability ?? 0, beforeEnd: step.beforeEnd ?? 0, moveStartTs: step.moveStartTs ?? 0, repair: !!step.repair, targetDurability: step.targetDurability ?? 0 };
  let ticket;
  try { ticket = ledger.reserve(counters, limits, {}, { uniqueKey: key, details }); }
  catch (error) { report({ label: step.label, skipped: true, reason: error.message }); return false; }
  const allowed = () => {
    const policy = getSettings()?.silicon?.fleets?.find(fleet => fleet.id === step.buildingId);
    return enabled() && client.connected !== false && identity(player) === who && getSettings() === settings && settings.silicon.enabled && day(now(client)) === today && policy?.enabled
      && (step.kind !== 'siliconRepair' || policy.autoRepair)
      && (step.kind !== 'siliconSpeed' || (step.repair ? policy.repairSpeedUp : policy.marchSpeedUp) && settings.resources.allowDiamonds);
  };
  if (!allowed()) { ledger.cancel(ticket); return false; }
  let sent = false;
  try {
    sent = true;
    await client.sendWatch(step.request, step.body, { window: 500 });
    const fresh = await readSiliconMining(client, protocol, options.config, player, { settings: getSettings(), ledger });
    if (who !== identity(player)) throw Error('写入后账号已切换，保留待确认记录');
    await reconcile(client, protocol, fresh, ledger);
    const record = ledger.keyRecords()[key], confirmed = !record || record.confirmed;
    report({ label: step.label, ok: confirmed, status: confirmed ? 'confirmed' : 'unknown', reason: confirmed ? '服务器业务状态已确认' : '请求已发送，结果未确认；保留预算及舰队锁，不重复发送' });
    return confirmed;
  } catch (error) {
    const rejected = error.prompt && error.request === step.request;
    if (!sent || rejected || error.notSent && error.request === step.request) ledger.cancel(ticket);
    report({ label: step.label, ok: false, status: rejected ? 'rejected' : 'unknown', error: error.message }); return false;
  }
}

// 缺少本连接 SCSpeedUp 累计分钟时用真实价格表最高档保守占用钻石预算。
export function siliconRepairDiamondCost(config, minutes, usedMinutes = null) {
  const prices = rows(config, 'SpeedUpRubyCfg').filter(row => Number.isFinite(row.minute) && row.minute >= 0 && Number.isFinite(row.fleet) && row.fleet > 0).sort((a, b) => a.minute - b.minute);
  if (!integer(minutes, 1) || !prices.length || prices[0].minute !== 0) return null;
  if (usedMinutes === null) return Math.ceil(minutes * Math.max(...prices.map(row => row.fleet)));
  let remaining = minutes, used = usedMinutes, cost = 0;
  while (remaining > 0) {
    const index = prices.findLastIndex(row => row.minute <= used), end = prices[index + 1]?.minute ?? Infinity, count = Math.min(remaining, end - used);
    cost += count * prices[index].fleet; used += count; remaining -= count;
  }
  return Math.ceil(cost);
}
async function maintenance(client, protocol, config, player, options, snapshot) {
  const settings = options.getSettings(), p = settings.silicon, ledger = options.ledger;
  if (snapshot.reason || capReason(snapshot, p) || !siliconInWindow(p.windows, snapshot.checkedAt)) return;
  for (const policy of p.fleets.filter(fleet => fleet.enabled)) {
    const fleet = snapshot.fleets.find(row => row.buildingId === policy.id), key = slotKey(snapshot.worldId, policy.id), prior = ledger.keyRecords()[key];
    if (!fleet || !integer(fleet.durability) || !integer(fleet.maxDura, 1)) continue;
    if (policy.autoRepair && idle(fleet) && fleet.durability < fleet.maxDura && !fleetRecordReason(ledger.keyRecords(), policy.id, snapshot.worldId) && !dispatchReservationReason(client, settings, 'silicon', policy.id)) {
      const quote = snapshot.repairs[policy.id];
      if (!(quote?.unitRepairCost > 0 && quote.unitRepairTime > 0)) continue;
      const cost = Math.ceil((fleet.maxDura - fleet.durability) * quote.unitRepairCost);
      if (!integer(cost, 1) || policy.maxRepairCost > 0 && cost > policy.maxRepairCost || snapshot.fuel - pendingPetrol(ledger) - cost < p.petrolReserve) continue;
      await sendAndCheck(client, protocol, player, { ...options, config }, snapshot, { kind: 'siliconRepair', request: 'RepairFleetRequest', body: { buildingId: policy.id }, buildingId: policy.id, beforeDurability: fleet.durability, label: policy.id + '硅矿普通维修' }, { siliconPetrol: cost }, p.dailyPetrolLimit > 0 ? { siliconPetrol: p.dailyPetrolLimit } : {});
      return;
    }
    const repair = policy.repairSpeedUp && fleet.state === 4 && fleet.repairing?.endTs > snapshot.checkedAt && ledger.keyRecords()['silicon-repair:' + snapshot.worldId + ':' + fleetNumber(policy.id)]?.confirmed;
    const march = policy.marchSpeedUp && fleet.state === 2 && prior?.confirmed && prior.details?.active && fleet.targetGridIdx === prior.details.gridId && fleet.moveEndTs - snapshot.checkedAt > (policy.marchTargetSeconds ?? 60);
    if (!repair && !march) continue;
    const cost = repair ? siliconRepairDiamondCost(config, Math.ceil((fleet.repairing.endTs - snapshot.checkedAt) / 60), watchSiliconMining(client).repairMinutes()) : rows(config, 'WorldParamCfg').find(row => row.paramName === '行军加速消耗')?.paramValue;
    if (!integer(cost, 1) || !settings.resources?.allowDiamonds || !(p.dailyDiamondLimit > 0)) continue;
    const resources = await get(client, protocol, 'AllResource'), ruby = resources.list?.filter(row => row.res === 4);
    if (ruby?.length !== 1 || !integer(quantity(ruby[0].amount)) || quantity(ruby[0].amount) - (ledger.pendingCounters().diamonds ?? 0) - cost < settings.resources.diamondThreshold || settings !== options.getSettings() || !options.enabled()) continue;
    const step = { kind: 'siliconSpeed', request: repair ? 'SpeedUpRepairRequest' : 'SpeedUpFleetRequest', body: { buildingId: policy.id, ...(repair ? { speedUp: { type: protocol.SpeedUpCost.SPEED_UP_RUBY, useNum: 0 } } : {}) }, buildingId: policy.id, repair, beforeEnd: repair ? fleet.repairing.endTs : fleet.moveEndTs, moveStartTs: fleet.moveStartTs, targetDurability: fleet.repairing?.endDura ?? fleet.maxDura, label: policy.id + (repair ? '硅矿维修加速' : '硅矿行军加速') };
    await sendAndCheck(client, protocol, player, { ...options, config }, snapshot, step, { diamonds: cost, siliconDiamonds: cost }, { diamonds: settings.resources.diamondDailyLimit, siliconDiamonds: p.dailyDiamondLimit }); return;
  }
}

export async function runSiliconMining(client, protocol, config, player, options = {}) {
  const { getSettings, ledger, enabled = () => true, report = () => {} } = options;
  if (!enabled() || !getSettings?.()?.silicon?.enabled || active.has(client)) return null;
  if (!ledger) throw Error('硅矿自动化缺少持久化账本');
  const who = identity(player); active.add(client); watchSiliconMining(client); installReservations(client, ledger, exactAutomationId(player.worldId));
  try {
    let settings = getSettings(), snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
    if (who !== identity(player) || !enabled()) return null;
    await reconcile(client, protocol, snapshot, ledger);
    if (snapshot.reason) { report({ label: '硅矿自动采集', skipped: true, reason: snapshot.reason }); return snapshot; }
    const plan = planSiliconMining(snapshot, settings, ledger, client);
    for (const proposed of plan.actions) {
      if (!enabled() || who !== identity(player) || client.connected === false) break;
      settings = getSettings(); reserveDispatch(client, 'silicon', [proposed.buildingId]);
      try {
        const fresh = await readSiliconMining(client, protocol, config, player, { settings, ledger });
        if (!enabled() || settings !== getSettings() || who !== identity(player) || day(fresh.checkedAt) !== day(now(client))) continue;
        await reconcile(client, protocol, fresh, ledger);
        const reviewed = planSiliconMining(fresh, settings, ledger, client).actions.find(action => action.kind === proposed.kind && action.buildingId === proposed.buildingId && action.gridId === proposed.gridId && action.index === proposed.index && hash(action.opponent) === hash(proposed.opponent));
        if (!reviewed) continue;
        const counters = reviewed.kind === 'siliconDispatch' ? { siliconPetrol: reviewed.cost, siliconDispatches: 1, ...(reviewed.opponent ? { ['siliconAttacks' + fleetNumber(reviewed.buildingId)]: 1 } : {}) } : {};
        const policy = settings.silicon.fleets.find(fleet => fleet.id === reviewed.buildingId), limits = { ...(settings.silicon.dailyPetrolLimit > 0 ? { siliconPetrol: settings.silicon.dailyPetrolLimit } : {}), ...(reviewed.opponent && policy.dailyAttackLimit > 0 ? { ['siliconAttacks' + fleetNumber(reviewed.buildingId)]: policy.dailyAttackLimit } : {}) };
        await sendAndCheck(client, protocol, player, { ...options, config, enabled, report }, fresh, reviewed, counters, limits);
      } finally { reserveDispatch(client, 'silicon', []); }
    }
    if (enabled() && who === identity(player)) {
      settings = getSettings(); snapshot = await readSiliconMining(client, protocol, config, player, { settings, ledger });
      if (enabled() && settings === getSettings() && who === identity(player)) { await reconcile(client, protocol, snapshot, ledger); await maintenance(client, protocol, config, player, { ...options, enabled, report }, snapshot); }
    }
    if (!plan.actions.length) report({ label: '硅矿自动采集', skipped: true, reason: plan.reason || plan.notes.join('；') || plan.rows.filter(row => row.enabled).map(row => row.id + '：' + row.reason).join('；') || '未启用舰队' });
    return plan;
  } finally { reserveDispatch(client, 'silicon', []); active.delete(client); }
}
