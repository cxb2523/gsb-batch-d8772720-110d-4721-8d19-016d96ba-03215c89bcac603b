import { toNumber } from './client.mjs';
import { hasOtherFleetReservations, isFleetReserved, registerFleetReservations } from './fleet-reservations.mjs';
import { freeFleet, normalizeFleet, radarFuelReserve } from './radar.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';
import {fleetRecordReason,legacyFleetReservationReason} from './fleet-availability.mjs';
import { recordsInWorld, settleFleetSnapshot } from './fleet-settlement.mjs';
// 货轮：读取实际状态后规划，派遣前再次核对；保存设置和预览均不发送游戏动作。
import { exactAutomationId } from './automation-policy.mjs';
import { readGuildMembers } from './guild.mjs';
import { displayMaterial } from './config.mjs';
import {watchTreasureTravel,matchesFollowDeparture} from './treasure-follow.mjs';
import { matchesTreasureRewards } from './treasure-reward-filter.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const serverNow = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const dayNumber = seconds => Math.floor((seconds + 28800) / 86400);
const fleetNumber = id => /^([1-9]\d*)远征船$/.exec(id ?? '')?.[1];
const fleetName = id => '远征舰队 ' + (fleetNumber(id) ?? '?') + ' 队';
const requestName = 'TreasureLootSendFleetsRequest';
const inFlight = new WeakSet();

// 汽油与奖励数量在协议中是int64。仅接收可精确表示的非负数量；角色ID继续保留文本。
function exactQuantity(value) {
  if (integer(value)) return value;
  let amount;
  if (typeof value === 'bigint') amount = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) amount = BigInt(value);
  else if (value && integer(value.low, -2147483648, 4294967295) && integer(value.high, -2147483648, 4294967295)) {
    const bits = (BigInt(value.high >>> 0) << 32n) + BigInt(value.low >>> 0);
    amount = value.unsigned === true ? bits : BigInt.asIntN(64, bits);
  } else return null;
  return amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export const treasureAutomationEnabled = settings => !!settings?.treasure?.enabled && (settings.treasure.autoJoin || settings.treasure.follow);
export const treasureDispatchKey = (worldId, uid, buildingId) => `treasure:${worldId}:${uid}:${fleetNumber(buildingId)}`;
export const treasureRepairKey = (worldId, buildingId) => `treasureRepair:${worldId}:${fleetNumber(buildingId)}`;
const homeIdle = fleet => fleet?.state === 1 && fleet.treasureLootUid === 0 && fleet.curGridIdx === 0 && !(fleet.chipWar?.rewardTs > 0);
const needsRepair = (fleet, preferences) => fleet.durability === 0 || fleet.durability * 100 < fleet.maxDura * preferences.minDurabilityPercent;
const canRepeat = (record, fleet, preferences) => record?.confirmed === true && preferences.repeatAttack === true && homeIdle(fleet);

// 游戏没有数值吨位字段：TreasureLootCfg 将 BLUE/PURPLE/ORANGE 对应为小型/中型/万吨货轮。
// 只接收协议与配置共同确认的类型；缺失开关沿用只抢万吨，未知品质不作小船放行。
function treasureTypes(protocol, config) {
  const types = ['BLUE', 'PURPLE', 'ORANGE'].flatMap(quality => {
    const configured = rows(config, 'TreasureLootCfg').filter(row => row.quality === quality);
    const color = protocol?.Color?.[quality];
    return configured.length === 1 && integer(color, 1) ? [{ quality, color, name: configured[0].name }] : [];
  });
  return types.filter(type => types.filter(other => other.color === type.color).length === 1);
}
const allowedTreasureType = (target, types, preferences) => types.find(type => type.color === target.color &&
  (preferences?.onlyTenThousand === false || type.quality === 'ORANGE'));
const waitingForTreasure = preferences => preferences?.onlyTenThousand === false
  ? '当前没有可读取的货轮，保持等待' : '当前没有可读取的万吨货轮，保持等待，不抢小型或中型货轮';

function openingReason(config, player, now) {
  const required = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界宝藏')?.playerLevel;
  const worldId = exactQuantity(player?.worldId);
  const season = integer(worldId, 1) ? Math.floor(worldId / 1e6) % 1000 : 0;
  const days = rows(config, 'GameplayOpenCfg').find(row => row.gameplay === '世界宝藏')?.openDays;
  const openDays = Array.isArray(days) && season > 0 ? days[Math.min(season, days.length) - 1] : null;
  if (!integer(required, 1) || !integer(player?.level, 1)) return '无法确认巨轮的角色等级条件';
  if (player.level < required) return `万吨巨轮在角色 ${required} 级开放`;
  if (!integer(worldId, 1)) return '无法精确确认巨轮所在区服编号';
  if (!integer(season, 1)) return '无法从当前区服编号识别巨轮赛季';
  if (!integer(openDays, 1)) return `未取得第 ${season} 赛季的巨轮开放天数`;
  if (!integer(player?.worldOpenTime, 1)) return '登录信息缺少有效的区服开服时间';
  if (player.worldOpenTime > now) return '区服开服时间晚于服务器当前时间，暂不参与巨轮';
  if (dayNumber(now) - dayNumber(player.worldOpenTime) + 1 < openDays) return `当前赛季开服第 ${openDays} 天开放巨轮`;
  const guildId = exactAutomationId(player?.guildId);
  if (!guildId || BigInt(guildId) % 1000n === 0n) return '请先加入有货轮参与权限的联盟';
  if (!exactAutomationId(player?.playerId)) return '无法精确确认当前角色';
  return '';
}

export async function readTreasureLoot(client, protocol, config, player, { targetUid = null, preferences = null } = {}) {
  const now = serverNow(client);
  const snapshot = { now, worldId: exactQuantity(player?.worldId), playerId: exactAutomationId(player?.playerId), nickname: player?.nickname,
    guildId: exactAutomationId(player?.guildId), guildIdx: 0, followMembers: [], targets: [], fleets: [], buildings: [], allUids: [],
    fuel: null, fuelPerFleet: null, todayRewardTimes: null, rewardLimit: null, nextRefreshTime: null, repairs: {}, travelers:[], reason: '', notes: [] };
  snapshot.reason = openingReason(config, player, now);
  if (snapshot.reason) return snapshot;
  snapshot.guildIdx = Number(BigInt(snapshot.guildId) % 1000n);
  const get = async (name, body = {}) => {
    const response = name.replace(/Request$/, 'Response');
    if (!protocol?.[name] || !protocol?.[response]) throw new Error('当前协议缺少 ' + name);
    return client.request(name, body, response, 8000);
  };
  const travel=watchTreasureTravel(client);
  let stats, list, own, water, bag, guild, merge, world;
  try {
    [stats, list, own, water, bag, guild, merge, world] = await Promise.all([
      get('TreasureLootStatsRequest'), get('TreasureLootListRequest'), get('MyFleetsRequest'),
      get('OnWaterRequest'), get('AllItemRequest'), get('GuildInfoRequest'), get('UniteWorldsPlanRequest'),
      preferences?.follow?get('WorldInfoRequest',{screenCenter:{x:0,y:0}}).catch(()=>{snapshot.notes.push('出发行军状态未同步，仅核对当前守军');return null;}):null,
    ]);
  } catch (error) { snapshot.reason = '巨轮状态读取未完成：' + error.message; return snapshot; }
  if(world?.fleets)travel.ingest(world.fleets);snapshot.travelers=travel.current();
  if (![list?.treasure, own?.fleets, water?.building, bag?.items, merge?.worldIds].every(Array.isArray)) {
    snapshot.reason = '未取得完整的货轮、舰队、建筑、汽油或合服状态'; return snapshot;
  }
  if (exactAutomationId(guild?.guild?.guildId) !== snapshot.guildId || exactAutomationId(player.guildId) !== snapshot.guildId) {
    snapshot.reason = '联盟身份已变化，请稍后重新检查'; return snapshot;
  }
  if (rows(config, 'GuildTitleCfg').find(row => row.title === guild.myTitle)?.treasureLoot !== 1) {
    snapshot.reason = '当前联盟职务没有参与货轮的权限'; return snapshot;
  }
  if ((merge.matchMaking || (merge.worldIds.length && merge.executeTs > 0)) &&
      (now >= (merge.executeTs ?? 0) - 3600 || dayNumber(now) === dayNumber(merge.executeTs))) {
    snapshot.reason = '合服匹配或执行期间暂停巨轮出征'; return snapshot;
  }
  const fuelItem = bag.items.find(item => item.itemId === '汽油');
  snapshot.fuel = fuelItem ? exactQuantity(fuelItem.num) : 0;
  snapshot.fuelPerFleet = rows(config, 'WorldParamCfg').find(row => row.paramName === '进攻宝藏消耗汽油')?.paramValue;
  snapshot.rewardLimit = rows(config, 'TreasureLootParamCfg').find(row => row.paramName === '每日宝藏奖励次数')?.paramValue;
  snapshot.todayRewardTimes = stats?.todayRewardTimes;
  snapshot.nextRefreshTime = stats?.nextRefreshTime;
  if (!integer(snapshot.fuel) || !integer(snapshot.fuelPerFleet, 1) || !integer(snapshot.rewardLimit, 1) || !integer(snapshot.todayRewardTimes)) {
    snapshot.reason = '无法确认汽油余额、出征费用或今日领奖次数'; return snapshot;
  }
  if(preferences?.follow && preferences.followPlayerIds?.length) {
    try { const roster=await readGuildMembers(client,config,player);if(roster.state==='member')snapshot.followMembers=roster.members; }
    catch(error){snapshot.notes.push('跟随名单身份补充读取未完成：'+error.message);}
    if(exactAutomationId(player.guildId)!==snapshot.guildId){snapshot.reason='读取跟随名单时联盟已变化';return snapshot;}
  }
  snapshot.buildings = water.building;
  // protobuf默认值可能仅存在于原型上；展开复制后必须显式保留这些状态字段。
  snapshot.fleets = own.fleets.map(fleet => ({ ...fleet, state: fleet.state, durability: fleet.durability, maxDura: fleet.maxDura,
    treasureLootUid: fleet.treasureLootUid, curGridIdx: fleet.curGridIdx,
    ownerPlayerId: fleet.owner ? exactAutomationId(fleet.owner.playerId) : null }));
  snapshot.allUids = list.treasure.filter(target => integer(target.uid, 1, 2147483647)).map(target => target.uid);
  const types = treasureTypes(protocol, config);
  if (!types.some(type => preferences?.onlyTenThousand === false || type.quality === 'ORANGE')) {
    snapshot.reason = preferences?.onlyTenThousand === false ? '当前协议或配置无法确认货轮类型' : '当前协议或配置无法确认万吨货轮类型'; return snapshot;
  }
  const seen = new Set(), duplicates = new Set();
  for (const uid of snapshot.allUids) { if (seen.has(uid)) duplicates.add(uid); seen.add(uid); }
  // 同名响应不含请求uid，逐艘查询，避免并发串配参与者。
  for (const target of list.treasure) {
    const type = allowedTreasureType(target, types, preferences);
    if (!type || (targetUid !== null && target.uid !== targetUid)) continue;
    const item = { uid: target.uid, color: target.color, quality: type.quality, name: type.name, ownerGuildIdx: target.ownerGuildIdx, progress: target.progress,
      ownerFleetNum: target.ownerFleetNum,gridIdx:target.gridIdx,
      reward: Array.isArray(target.reward?.asset) ? target.reward.asset.map(asset => ({ id: asset?.id, num: exactQuantity(asset?.num) })) : null,
      defenders: [], rank: [], fighters: [], personalProgress: null, reason: '' };
    snapshot.targets.push(item);
    if (!integer(item.uid, 1, 2147483647) || duplicates.has(item.uid) || !integer(item.ownerGuildIdx, 0, 999) ||
        !integer(item.ownerFleetNum) || !integer(item.progress, 0, 100) || !Array.isArray(item.reward) || !item.reward.length ||
        item.reward.some(asset => typeof asset.id !== 'string' || !integer(asset.num, 1))) {
      item.reason = '货轮状态不完整或目标重复'; continue;
    }
    for (const fighter of [target.battlePoint?.leftFighter, target.battlePoint?.rightFighter]) {
      if (fighter && !fighter.isNpc && typeof fighter.name === 'string') item.fighters.push(fighter);
    }
    try {
      const [defence, ranking] = await Promise.all([
        get('TreasureLootDefenceRequest', { uid: item.uid }), get('TreasureLootRankRequest', { uid: item.uid }),
      ]);
      if (!Array.isArray(defence?.fleets) || !Array.isArray(ranking?.items)) throw new Error('缺少当前守军或排名');
      if (defence.fleets.some(member => !member.isNpc && (typeof member.name !== 'string' || !member.name || !integer(member.guildIdx, 1, 999)))) throw new Error('守军身份不完整');
      item.defenders = defence.fleets.map(member => ({ name: member.name, guildIdx: member.guildIdx, isNpc: member.isNpc === true }));
      item.rank = ranking.items.map(member => ({ playerId: exactAutomationId(member.playerId), name: member.nickname, guildIdx: member.guildIdx, progress: member.progress }));
      if (item.rank.some(member => !member.playerId)) throw new Error('排名中的角色身份无法确认，未确认本人实际进度');
      const personal = item.rank.filter(member => member.playerId === snapshot.playerId);
      if (personal.length > 1 || (personal.length === 1 && !integer(personal[0].progress, 0, 100))) throw new Error('本人实际占领进度无效或重复');
      // RankResponse为该货轮完整排名、无分页；未参与者没有排名。只用实际progress，不用estProgress或联盟进度。
      item.personalProgress = personal.length ? personal[0].progress : 0;
      if (item.ownerGuildIdx > 0 && item.ownerFleetNum > 0 && !item.defenders.some(member => !member.isNpc && member.guildIdx === item.ownerGuildIdx)) throw new Error('占领联盟与当前守军不一致');
    } catch (error) { item.reason = '参与者核对未完成：' + error.message; }
  }
  for (const buildingId of preferences?.fleetIds ?? []) {
    const fleet = snapshot.fleets.find(row => row.buildingId === buildingId);
    if (!preferences.autoRepair || !fleet || !homeIdle(fleet) || !integer(fleet.durability) || !integer(fleet.maxDura, 1) || !needsRepair(fleet, preferences)) continue;
    try { snapshot.repairs[buildingId] = await get('FleetRepairParamRequest', { buildingId }); }
    catch (error) { snapshot.repairs[buildingId] = { error: error.message }; }
  }
  return snapshot;
}

function following(target, preferences, ownId, ownName, snapshot) {
  if (!preferences.follow) return null;
  const found = [];
  for(const fleet of snapshot?.travelers??[]){
    if(!matchesFollowDeparture(fleet,preferences,ownId,snapshot.travelers)||fleet.arriveAt<=snapshot.now||snapshot.now-fleet.seenAt>45)continue;
    if(!integer(target.gridIdx,1)||fleet.targetGrid!==target.gridIdx||fleet.uid>0&&fleet.uid!==target.uid)continue;
    const idIndex=preferences.followPlayerIds.indexOf(fleet.playerId),nameIndex=preferences.followNames.indexOf(fleet.name);
    found.push({name:fleet.name,playerId:fleet.playerId,phase:'departing',departedAt:fleet.startedAt,seenAt:fleet.seenAt,priority:idIndex>=0?idIndex:preferences.followPlayerIds.length+nameIndex});
  }
  for (const member of target.defenders) {
    if (member.isNpc || member.guildIdx !== target.ownerGuildIdx) continue;
    const matches = target.rank.filter(row => row.name === member.name && row.guildIdx === member.guildIdx && row.playerId);
    const rosterIds = member.guildIdx===snapshot?.guildIdx ? (snapshot.followMembers??[]).filter(row=>row.name===member.name).map(row=>row.id) : [];
    const identities = [...new Set([...matches.map(row => row.playerId),...rosterIds])];
    if (identities.length > 1 || identities[0] === ownId || (!identities.length && member.name === ownName)) continue;
    const id = identities[0];
    const nameIndex = preferences.followNames.indexOf(member.name), idIndex = preferences.followPlayerIds.indexOf(id);
    if (idIndex >= 0 || nameIndex >= 0) found.push({ name: member.name, playerId: id ?? null,phase:'defending',
      priority: idIndex >= 0 ? idIndex : preferences.followPlayerIds.length + nameIndex });
  }
  return found.sort((a, b) => a.priority - b.priority)[0] ?? null;
}

function fleetReason(fleet, snapshot, preferences, allowRepair = false) {
  if (!fleetNumber(fleet.buildingId)) return '舰队建筑无法识别';
  const building = snapshot.buildings.find(row => row.buildingId === fleet.buildingId);
  if (!(building?.level > 0)) return '远征船尚未建成';
  if (!(building.fleet?.formation?.heroPositions ?? []).some(position => position.heroId)) return '请先为舰队保存英雄编队';
  if (fleet.ownerPlayerId && fleet.ownerPlayerId !== snapshot.playerId) return '舰队归属与当前角色不符';
  // SelectTroopPop._isTroopIdle检查实际Idle状态；autoFight.isOn是偏好开关，不代表正在作战。
  if (fleet.state !== 1) return ({ 2: '舰队行军中', 3: '舰队战斗中', 4: '舰队维修中', 5: '舰队排队中' })[fleet.state] || '无法识别当前舰队状态';
  if (fleet.treasureLootUid > 0) return '舰队正在参与货轮';
  if (fleet.curGridIdx > 0) return '舰队驻守在外，尚未返回主城';
  if (fleet.chipWar?.rewardTs > 0) return '舰队仍有芯片矿场任务';
  if (!integer(fleet.durability) || !integer(fleet.maxDura, 1) || fleet.durability > fleet.maxDura) return '无法确认舰队耐久或耐久上限';
  if (needsRepair(fleet, preferences) && !(allowRepair && preferences.autoRepair)) return preferences.autoRepair ? '耐久不足，需先维修' : '耐久低于阈值，自动维修已关闭';
  return '';
}

export function planTreasureLoot(snapshot, config, settings, { usage = { counters: {} }, keys = {}, pendingFuel = 0, reservedFleetIds = [] } = {}) {
  keys=recordsInWorld(keys,snapshot.worldId);
  const p = settings?.treasure;
  const plan = { actions: [], notes: [], counts: { treasures: snapshot.targets.length, fleets: snapshot.fleets.length },
    targets: [], fleets: (p?.fleetIds ?? []).map(buildingId => {
      const fleet = snapshot.fleets.find(row => row.buildingId === buildingId);
      return { name: fleetName(buildingId), state: fleet ? ({ 1: fleet.curGridIdx > 0 ? '驻守在外' : '空闲', 2: '行军中', 3: '战斗中', 4: '维修中', 5: '排队中' })[fleet.state] || '未知' : '未取得',
        autoFight: fleet ? fleet.autoFight?.isOn === true : null, durability: fleet?.durability, maxDura: fleet?.maxDura,
        reason: fleet ? fleetReason(fleet, snapshot, p) : '尚未取得这支舰队状态' };
    }), fuel: snapshot.fuel, fuelPerFleet: snapshot.fuelPerFleet };
  if (!treasureAutomationEnabled(settings)) plan.notes.push('巨轮自动化未开启，不安排派遣');
  if (snapshot.reason) plan.notes.push(snapshot.reason);
  if (!treasureAutomationEnabled(settings) || snapshot.reason) return plan;
  const rewardBlocked = snapshot.todayRewardTimes >= snapshot.rewardLimit && p.participationMode !== 'always';
  if (rewardBlocked) plan.notes.push('已达到游戏今日货轮领奖上限，按“打满就停”停止新派遣和维修');
  else if (snapshot.todayRewardTimes >= snapshot.rewardLimit) plan.notes.push('今日领奖已满，按“每次参与”继续；不会增加游戏奖励次数');
  const candidates = [];
  for (const target of snapshot.targets) {
    let reason = target.reason;
    if (!reason && !['BLUE', 'PURPLE', 'ORANGE'].includes(target.quality)) reason = '货轮类型未确认，等待重新核对';
    if (!reason && p.onlyTenThousand !== false && target.quality !== 'ORANGE') reason = '已开启只抢万吨货轮，跳过此货轮并等待';
    const follow = following(target, p, snapshot.playerId, snapshot.nickname, snapshot);
    if (!reason && !integer(p.personalProgressLimit, 0, 100)) reason = '个人进度上限未确认，暂不派遣或备战维修';
    if (!reason && p.personalProgressLimit === 0) reason = '个人进度上限为0，停止新派遣和备战维修';
    if (!reason && !integer(target.personalProgress, 0, 100)) reason = '本人实际占领进度未确认，等待重新核对';
    if (!reason && target.personalProgress >= p.personalProgressLimit) reason = `个人进度已达上限（${target.personalProgress}% / ${p.personalProgressLimit}%），被打回后也不再派遣或为该货轮维修`;
    if (!reason && target.progress >= p.maxProgress) reason = '占领进度已达到跳过阈值';
    if (!reason && !p.allowHostile && target.ownerGuildIdx !== 0 && target.ownerGuildIdx !== snapshot.guildIdx) reason = '其他联盟正在占领，未允许争夺';
    if (!reason && [...target.defenders, ...target.fighters].some(member => !member.isNpc && p.avoidNames.includes(member.name))) reason = '当前守军或战斗者命中避战名单';
    if (!reason && [...target.defenders, ...target.fighters].some(member => !member.isNpc && target.rank.some(row =>
      (p.avoidPlayerIds ?? []).includes(row.playerId) && row.name === member.name && (member.guildIdx == null || row.guildIdx === member.guildIdx)))) reason = '当前守军或战斗者命中所选避战玩家';
    if (!reason && !matchesTreasureRewards(config, p.rewardItems, target.reward)) reason = '奖励不在所选范围';
    if (!reason && !follow && (p.follow || !p.autoJoin)) reason = '未匹配指定跟随玩家的已出发舰队或当前守军，等待目标，不参加其他货轮';
    const reward = (target.reward ?? []).slice(0, 3).map(asset => displayMaterial(config, asset.id)).join('、');
    const label = `${target.name || '货轮'}（${reward || '奖励未确认'}，进度 ${target.progress ?? '?'}%）`;
    plan.targets.push({ label, reason, followName: follow?.name ?? null,followPhase:follow?.phase??null, personalProgress: target.personalProgress, personalProgressLimit: p.personalProgressLimit });
    if (reason) plan.notes.push(label + '：' + reason);
    else candidates.push({ target, follow, label });
  }
  candidates.sort((a, b) => (a.follow?.priority ?? Infinity) - (b.follow?.priority ?? Infinity) || a.target.progress - b.target.progress || a.target.uid - b.target.uid);
  if (!snapshot.targets.length) plan.notes.push(waitingForTreasure(p));
  if (rewardBlocked) return plan;
  let fuel = snapshot.fuel - pendingFuel;
  if (!integer(pendingFuel)) { plan.notes.push('未确认派遣的汽油记录异常，停止派遣'); return plan; }
  if (pendingFuel > 0) plan.notes.push(`有 ${pendingFuel} 汽油的出征或维修结果待确认，暂保留同额预算`);
  let count = usage.counters?.treasureDispatches ?? 0, repairPetrol = usage.counters?.treasureRepairPetrol ?? 0;
  if (!integer(count) || !integer(repairPetrol)) { plan.notes.push('今日出征或维修用量记录异常，停止派遣'); return plan; }
  for (const buildingId of p.fleetIds) {
    const fleet = snapshot.fleets.find(row => row.buildingId === buildingId);
    let reason = fleet ? fleetReason(fleet, snapshot, p, true) : '当前没有这支已出征编队，请先在游戏或舰队编队页完成编队';
    if (!reason && reservedFleetIds.includes(buildingId)) reason = '城战时段保留给城战接续';
    const warRecord = keys['cityWar:' + snapshot.worldId + ':' + fleetNumber(buildingId)];
    if (!reason && warRecord && !warRecord.confirmed) reason = '城战任务结果待确认，暂不派遣巨轮';
    if(!reason&&Object.values(keys).some(r=>r.details?.kind==='worldBoss'&&r.details.buildingId===buildingId&&r.details.active!==false))reason='世界Boss首战尚未结束或结果待确认';
    if (!reason && Object.entries(keys).some(([key,r])=>key.startsWith('radar-send:'+snapshot.worldId+':') && r.details?.buildingId===buildingId && r.details.active!==false)) reason='联盟情报尚在执行或结果待确认';
    if (!reason && Object.entries(keys).some(([key,r])=>key.startsWith('pirate-first:'+snapshot.worldId+':') && r.details?.buildingId===buildingId && !['won','lost'].includes(r.details?.outcome))) reason='海盗首杀结果待确认，暂不派遣或维修';
    const prefix = `treasure:${snapshot.worldId}:`, suffix = ':' + fleetNumber(buildingId);
    if (!reason && Object.entries(keys).some(([key, record]) => key.startsWith(prefix) && key.endsWith(suffix) && !record.confirmed && !record.expired)) reason = '前次巨轮派遣结果尚未确认，暂停这支舰队的新派遣';
    const repairRecord = keys[treasureRepairKey(snapshot.worldId, buildingId)];
    if (!reason && repairRecord && (!repairRecord.confirmed || !homeIdle(fleet))) reason = '前次巨轮维修仍在进行或结果待确认';
    if (!reason) reason = fleetRecordReason(keys,buildingId);
    if (!reason && p.dailyDispatchLimit > 0 && count >= p.dailyDispatchLimit) reason = '已达到每日出征上限';
    if (!reason && fuel - snapshot.fuelPerFleet < p.petrolReserve) reason = '出征后汽油会低于保留量';
    if (reason) { const view = plan.fleets.find(row => row.name === fleetName(buildingId)); if (view) view.reason = reason; plan.notes.push(fleetName(buildingId) + '：' + reason); continue; }
    const chosen = candidates.find(row => {
      const record = keys[treasureDispatchKey(snapshot.worldId, row.target.uid, buildingId)];
      return !record || canRepeat(record, fleet, p);
    });
    if (!chosen) { if (candidates.length) plan.notes.push(fleetName(buildingId) + '：已参与这些货轮，反复攻占未开启或前次结果仍待确认'); continue; }
    const { target, follow, label } = chosen;
    if (needsRepair(fleet, p)) {
      const quote = snapshot.repairs?.[buildingId];
      let repairReason = '';
      if (!(Number.isFinite(quote?.unitRepairCost) && quote.unitRepairCost > 0 && Number.isFinite(quote?.unitRepairTime) && quote.unitRepairTime > 0)) repairReason = '未取得有效普通维修报价';
      const cost = Math.ceil((fleet.maxDura - fleet.durability) * quote?.unitRepairCost);
      if (!repairReason && (!integer(cost, 1) || p.maxRepairCost > 0 && cost > p.maxRepairCost)) repairReason = '完整维修费用超过单次上限';
      if (!repairReason && p.dailyRepairPetrolLimit > 0 && repairPetrol + cost > p.dailyRepairPetrolLimit) repairReason = '会超过今日巨轮维修汽油上限';
      if (!repairReason && fuel - cost - snapshot.fuelPerFleet < p.petrolReserve) repairReason = '维修后不足以保留汽油并完成下一次出征';
      const view = plan.fleets.find(row => row.name === fleetName(buildingId));
      if (repairReason) { if (view) view.reason = repairReason; plan.notes.push(fleetName(buildingId) + '：' + repairReason); continue; }
      if (view) view.reason = '先普通维修，结束后重新检查货轮再派遣';
      plan.actions.push({ kind: 'treasureRepair', request: 'RepairFleetRequest', body: { buildingId }, buildingId, targetUid: target.uid,
        worldId: snapshot.worldId, beforeDurability: fleet.durability, mode: follow ? 'follow' : 'auto',
        followName: follow?.name ?? null, followPlayerId: follow?.playerId ?? null,followPhase:follow?.phase??null,followDepartedAt:follow?.departedAt??null,followSeenAt:follow?.seenAt??null,
        uniqueKey: treasureRepairKey(snapshot.worldId, buildingId), costs: [{ id: '汽油', num: cost }],
        label: `${fleetName(buildingId)}普通维修至满耐久，完成后重新检查货轮` });
      fuel -= cost + snapshot.fuelPerFleet; repairPetrol += cost; count++;
      continue;
    }
    plan.actions.push({ kind: 'treasureDispatch', request: requestName,
      body: { uid: target.uid, fleetBuildingIds: [buildingId] }, buildingId, targetUid: target.uid, worldId: snapshot.worldId, mode: follow ? 'follow' : 'auto',
      followName: follow?.name ?? null, followPlayerId: follow?.playerId ?? null,followPhase:follow?.phase??null,followDepartedAt:follow?.departedAt??null,followSeenAt:follow?.seenAt??null,
      uniqueKey: treasureDispatchKey(snapshot.worldId, target.uid, buildingId),
      costs: [{ id: '汽油', num: snapshot.fuelPerFleet }],
      label: `${fleetName(buildingId)}${follow ? '跟随 ' + follow.name + (follow.phase==='departing'?'（已出发）':'（当前守军）') + ' 参加' : '自动参加'}${label}` });
    fuel -= snapshot.fuelPerFleet; count++;
  }
  return plan;
}

function reconcileKeys(snapshot, ledger, preferences) {
  if (snapshot.reason || !ledger?.keyRecords || !ledger.resolveKey) return;
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    const match = /^treasure:(\d+):(\d+):(\d+)$/.exec(key);
    if (match && Number(match[1]) === snapshot.worldId) {
      const uid = Number(match[2]), fleet = snapshot.fleets.find(row => row.buildingId === match[3] + '远征船');
      if (canRepeat(record, fleet, preferences)) ledger.releaseCompletedKey(key);
      else if (!record.confirmed && !record.expired) {
        if (fleet?.treasureLootUid === uid) ledger.resolveKey(key, true);
        else if (homeIdle(fleet) && !snapshot.allUids.includes(uid)) ledger.resolveKey(key, false);
      }
    }
  }
  settleFleetSnapshot(ledger,{worldId:snapshot.worldId,fleets:snapshot.fleets,now:snapshot.now,kinds:['treasureRepair']});
}

export async function runTreasureLoot(client, protocol, config, player, { getSettings, ledger,
  enabled = () => true, onStep, onNotes, reservedFleetIds = [], petrolCeiling = null, canUseFleet = () => true } = {}) {
  if (!enabled() || !treasureAutomationEnabled(getSettings?.())) return { results: [], notes: [] };
  if (!ledger?.hasKey || !ledger?.reserve || !ledger?.keyRecords || !ledger?.releaseCompletedKey) throw new Error('缺少持久派遣记录，未执行巨轮出征');
  if (inFlight.has(client)) return { results: [], notes: ['巨轮检查正在进行，已合并本次检查'] };
  inFlight.add(client);
  const results = [];
  try {
    const snapshot = await readTreasureLoot(client, protocol, config, player, { preferences: getSettings().treasure });
    if (integer(petrolCeiling)) snapshot.fuel = Math.min(snapshot.fuel, petrolCeiling);
    reconcileKeys(snapshot, ledger, getSettings().treasure);
    const pendingFuel = () => { const counters = ledger.pendingCounters?.() ?? {}; return (counters.treasurePetrol ?? 0) + (counters.cityWarPetrol ?? 0) + (counters.piratePetrol ?? 0) + (counters.radarPetrol ?? 0) + (counters.worldBossPetrol ?? 0) + (counters.siliconPetrol ?? 0); };
    const plan = planTreasureLoot(snapshot, config, getSettings(), { usage: ledger.snapshot(), keys: ledger.keyRecords(), pendingFuel: pendingFuel(), reservedFleetIds });
    onNotes?.(plan.notes);
    let remainingFuel = snapshot.fuel;
    let mapChecked = false;
    for (const proposed of plan.actions) {
      if (!enabled() || !treasureAutomationEnabled(getSettings()) || !client.connected) break;
      if (!mapChecked) {
        if (!protocol?.WorldInfoRequest || !protocol?.WorldInfoResponse) throw new Error('当前协议无法确认世界地图状态');
        await client.request('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } }, 'WorldInfoResponse', 8000);
        mapChecked = true;
      }
      const fresh = await readTreasureLoot(client, protocol, config, player, { targetUid: proposed.targetUid, preferences: getSettings().treasure });
      reconcileKeys(fresh, ledger, getSettings().treasure);
      fresh.fuel = Math.min(fresh.fuel, remainingFuel);
      const current = getSettings();
      const reviewed = planTreasureLoot(fresh, config, current, { usage: ledger.snapshot(), keys: ledger.keyRecords(), pendingFuel: pendingFuel(), reservedFleetIds });
      const step = reviewed.actions.find(action => action.uniqueKey === proposed.uniqueKey && action.kind === proposed.kind && action.targetUid === proposed.targetUid && action.costs[0].num === proposed.costs[0].num &&
        (proposed.mode !== 'follow' || (action.mode === 'follow' && action.followName === proposed.followName && action.followPlayerId === proposed.followPlayerId)));
      if (!step) {
        const entry = { step: proposed, skipped: true, reason: '出征前目标、玩家或舰队条件已变化，本次不派遣' };
        results.push(entry); onStep?.(entry); continue;
      }
      if (!protocol?.[step.request]) throw new Error('当前协议不支持' + step.request);
      if (!enabled() || !canUseFleet(step.buildingId) || legacyFleetReservationReason(client,step.buildingId) || !client.connected || current !== getSettings() || exactAutomationId(player.guildId) !== fresh.guildId ||
          exactAutomationId(player.playerId) !== fresh.playerId || exactQuantity(player.worldId) !== fresh.worldId) break;
      const repair = step.kind === 'treasureRepair';
      const limits = repair ? { treasureRepairPetrol: current.treasure.dailyRepairPetrolLimit || undefined } : current.treasure.dailyDispatchLimit > 0 ? { treasureDispatches: current.treasure.dailyDispatchLimit } : {};
      const counters = repair ? { treasureRepairs: 1, treasureRepairPetrol: step.costs[0].num, treasurePetrol: step.costs[0].num } : { treasureDispatches: 1, treasurePetrol: step.costs[0].num };
      const ticket = ledger.reserve(counters, limits, {}, { uniqueKey: step.uniqueKey,
        details: { kind: step.kind, buildingId: step.buildingId, uid: step.targetUid, beforeDurability: step.beforeDurability ?? fresh.fleets.find(row => row.buildingId === step.buildingId)?.durability, sentAt: fresh.now,followPlayerId:step.followPlayerId,followPhase:step.followPhase,followDepartedAt:step.followDepartedAt,followSeenAt:step.followSeenAt } });
      if (!enabled() || !client.connected || current !== getSettings() || !treasureAutomationEnabled(getSettings()) || legacyFleetReservationReason(client,step.buildingId)) { ledger.cancel(ticket); break; }
      let entry;
      try {
        await client.sendWatch(step.request, step.body, { window: 600 });
        let confirmed = false;
        try {
          const after = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse', 8000);
          confirmed = after.fleets?.some(fleet => fleet.buildingId === step.buildingId && (repair
            ? (fleet.state === 4 && fleet.repairing?.endTs > serverNow(client)) || fleet.durability > step.beforeDurability
            : fleet.treasureLootUid === step.targetUid)) === true;
        } catch { /* 已发送，无法读取时保留记录，下一轮继续只读确认。 */ }
        if (confirmed) { ledger.confirm(ticket); entry = { step, ok: true, status: 'confirmed', note: repair ? '服务器已确认普通维修，完成后再检查巨轮' : '服务器已确认舰队前往该巨轮' }; }
        else entry = { step, ok: true, sent: true, status: 'unknown', note: '请求已发送，结果待确认；保留预算并锁定舰队' };
      } catch (error) {
        if (error.prompt && error.request === step.request) {
          ledger.cancel(ticket);
          entry = { step, ok: false, status: 'rejected', error: (repair ? '服务器拒绝巨轮维修：' : '服务器拒绝巨轮出征：') + error.message };
        } else entry = { step, ok: false, status: 'unknown', error: (repair ? '维修结果未知，保留预算和舰队锁：' : '派遣结果未知，保留次数和防重记录：') + error.message };
      }
      results.push(entry); onStep?.(entry);
      if (entry.status !== 'rejected') remainingFuel -= step.costs[0].num;
      if (entry.status !== 'confirmed') break;
    }
    return { results, notes: plan.notes };
  } finally { inFlight.delete(client); }
}



const key = 'treasureLoot';
const label = '世界宝藏';
const OWNER = 'treasureLoot';
const WAR_HOUR = 20;
const MIN_DURABILITY = 0.8;
const legacySessions = new WeakMap();

const legacyRows = (config, table) => config?.tables?.[table]?.data ?? [];
const legacyParam = (config, table, name) => legacyRows(config, table).find(row => row.paramName === name)?.paramValue;
const beijingHour = time => new Date((time + 8 * 3600) * 1000).getUTCHours();

function legacyStateFor(client) {
  if (!legacySessions.has(client)) {
    const session = { fleets: new Map(), refused: new Map() };
    legacySessions.set(client, session);
    registerFleetReservations(client, OWNER, id => session.fleets.has(id), () => session.fleets.size > 0,
      snapshot => legacySettle(session, snapshot.fleets.map(normalizeFleet)));
  }
  return legacySessions.get(client);
}

// 返航且确认出征过才释放，只看到空闲不算结果，防止回包丢失后重复派遣。
function legacySettle(session, fleets) {
  for (const [id, pending] of session.fleets) {
    const fleet = fleets.find(row => row.buildingId === id);
    if (!fleet) continue;
    if (fleet.treasureLootUid === pending.uid || !freeFleet(fleet)) pending.seen = true;
    if (pending.seen && freeFleet(fleet)) session.fleets.delete(id);
  }
}

// 只去无主或本盟的宝藏，不主动和其他联盟交战。
export function pickTreasure(treasures, guildIdx, refused = new Map(), now = 0) {
  return treasures.filter(row => row.progress < 100 && (row.ownerGuildIdx === 0 || row.ownerGuildIdx === guildIdx)
    && !(refused.get(row.uid) > now))
    .sort((a, b) => b.color - a.color || a.progress - b.progress)[0] ?? null;
}

export function pickTreasureFleet(fleets, client) {
  return fleets.filter(fleet => freeFleet(fleet) && !isFleetReserved(client, fleet.buildingId)
    && fleet.durability >= fleet.maxDura * MIN_DURABILITY)
    .sort((a, b) => toNumber(b.power ?? 0) - toNumber(a.power ?? 0))[0] ?? null;
}

async function legacyReadFleets(client) {
  const raw = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse'))?.fleets;
  const items = (await client.request('AllItemRequest', {}, 'AllItemResponse'))?.items;
  if (!Array.isArray(raw) || !Array.isArray(items)) throw new Error('未能读取舰队和库存');
  const fleets = raw.map(normalizeFleet);
  const fuel = items.filter(item => item.itemId === '汽油').reduce((sum, item) => sum + toNumber(item.num), 0);
  return { fleets, fuel };
}

export async function serviceTreasureLoot(client, config, { player, protocol, getSettings = () => null, enabled = () => false, report = () => {}, scheduler } = {}) {
  const finish = entry => { report({ key, label, ...entry }); };
  const skip = reason => finish({ skipped: true, reason });
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return;
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const required = legacyRows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界宝藏')?.playerLevel;
  if (!(player?.level >= required)) { later(3600); return skip('世界宝藏 ' + required + ' 级开放'); }
  const openDay = gameplayOpenDay(config, player, '世界宝藏');
  const days = worldOpenDays(player, now);
  if (!(openDay > 0) || days === null || days < openDay) { later(3600); return skip('本区服尚未开放世界宝藏'); }
  const guildId = toNumber(player?.guildId);
  if (!(guildId > 0)) { later(1800); return skip('当前账号未加入联盟'); }
  if (beijingHour(now) === WAR_HOUR) { later(600); return skip('20:00-21:00 城战期间不派遣'); }
  const session = legacyStateFor(client);
  try {
    const guild = await client.request('GuildInfoRequest', {}, 'GuildInfoResponse');
    const title = legacyRows(config, 'GuildTitleCfg').find(row => row.title === guild?.myTitle);
    if (title?.treasureLoot !== 1) { later(1800); return skip('当前联盟职级不能占领宝藏'); }
    const stats = await client.request('TreasureLootStatsRequest', {}, 'TreasureLootStatsResponse');
    const limit = legacyParam(config, 'TreasureLootParamCfg', '每日宝藏奖励次数');
    if (!(limit > 0) || !Number.isSafeInteger(stats?.todayRewardTimes)) throw new Error('无法确认今日宝藏奖励次数');
    if (stats.todayRewardTimes >= limit) { later(3600); return skip('今日 ' + limit + ' 次宝藏奖励已用完'); }
    const { fleets, fuel } = await legacyReadFleets(client);
    legacySettle(session, fleets);
    if (hasOtherFleetReservations(client, OWNER)) { later(120); return skip('其他玩法的舰队或汽油扣除尚未确认'); }
    if (session.fleets.size) { later(120); return skip('上次派遣的舰队尚未返回'); }
    const out = fleets.filter(fleet => fleet.treasureLootUid > 0).length;
    if (out + stats.todayRewardTimes >= limit) { later(600); return skip('已派出的舰队足够领完今日奖励次数'); }
    const cost = legacyParam(config, 'WorldParamCfg', '进攻宝藏消耗汽油');
    if (!(cost > 0)) throw new Error('缺少宝藏汽油消耗配置');
    if (fuel - cost < radarFuelReserve) { later(600); return skip('派遣后需保留 ' + radarFuelReserve + ' 汽油，当前 ' + fuel); }
    const treasures = (await client.request('TreasureLootListRequest', {}, 'TreasureLootListResponse'))?.treasure;
    if (!Array.isArray(treasures)) throw new Error('未能读取宝藏列表');
    const types = treasureTypes(protocol, config);
    const preferences = getSettings()?.treasure;
    const target = pickTreasure(treasures.filter(row => allowedTreasureType(row, types, preferences)), guildId % 1000, session.refused, now);
    if (!target) { later(300); return skip(waitingForTreasure(preferences) + '（仅考虑无主或本盟目标）'); }
    const fleet = pickTreasureFleet(fleets, client);
    if (!fleet) { later(300); return skip('没有空闲且耐久不低于 80% 的舰队'); }
    if (!enabled()) return;
    // 旧入口也复读原目标并检查最新开关；目标变化时等待，不降级换抢其他货轮。
    const freshTargets = (await client.request('TreasureLootListRequest', {}, 'TreasureLootListResponse'))?.treasure;
    if (!Array.isArray(freshTargets)) throw new Error('出征前未能确认货轮列表');
    const matches = freshTargets.filter(row => row.uid === target.uid);
    if (matches.length !== 1 || !allowedTreasureType(matches[0], types, getSettings()?.treasure) ||
        !pickTreasure(matches, guildId % 1000, session.refused, now)) {
      later(300); return skip('出征前货轮类型、归属或筛选条件已变化，保持等待');
    }
    if (!enabled()) return;
    const id = fleet.buildingId;
    session.fleets.set(id, { uid: target.uid, seen: false });
    try {
      await client.sendWatch('TreasureLootSendFleetsRequest', { uid: target.uid, fleetBuildingIds: [id] }, { window: 500 });
    } catch (error) {
      if (error.prompt) {
        session.fleets.delete(id);
        session.refused.set(target.uid, now + 1800);
      }
      later(300);
      return finish({ ok: false, error: id + ' 出征：' + error.message });
    }
    const after = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse'))?.fleets ?? [];
    legacySettle(session, after.map(normalizeFleet));
    if (!session.fleets.get(id)?.seen) {
      later(300);
      return finish({ ok: false, error: '服务端未确认 ' + id + ' 出征，已暂停重复派遣这支舰队' });
    }
    later(120);
    const rewards = (target.reward?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + toNumber(item.num)).join('、');
    finish({ ok: true, label: label + ' · ' + id + ' 已前往宝藏 #' + target.uid + '，汽油 ' + cost + (rewards ? '，奖励 ' + rewards : '') });
  } catch (error) {
    later(300);
    if (client.promptNames?.[error.prompt?.prompt] === 'NO_GUILD') return skip('当前账号未加入联盟');
    finish({ ok: false, error: error.message });
  }
}
