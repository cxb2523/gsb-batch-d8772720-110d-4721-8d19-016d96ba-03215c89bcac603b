import {fleetRecordReason,legacyFleetReservationReason} from './fleet-availability.mjs';
import { recordsInWorld, settleFleetSnapshot } from './fleet-settlement.mjs';
// 原生委任额度用尽后的城战接续。只移动本人舰队和正常维修，不宣战、不修改原生委任。
import { exactAutomationId } from './automation-policy.mjs';
import { loadMapAsset } from './world.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const day = time => Math.floor((time + 28800) / 86400);
const fleetNo = id => /^([1-9]\d*)远征船$/.exec(id ?? '')?.[1];
const nameOf = id => '远征舰队 ' + (fleetNo(id) || '?') + ' 队';
const stateName = fleet => ({ 1: fleet.curGridIdx > 0 ? '驻守在外' : '空闲', 2: '行军中', 3: '战斗中', 4: '维修中', 5: '排队中' })[fleet.state] || '未知';
const active = new WeakSet();
const rejected = new WeakMap();
const nativeRejected = new WeakMap();
const keyOf = (world, id) => 'cityWar:' + world + ':' + fleetNo(id);
export const cityWarEnabled = settings => settings?.cityWar?.enabled === true;

function quantity(value) {
  if (integer(value)) return value;
  let n;
  if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) n = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

export function cityPetrolCost(map, sourceCityId, targetCityId, brackets) {
  if (![map?.width, map?.tileWidth, map?.tileHeight].every(n => typeof n === 'number' && n > 0 && Number.isFinite(n))) return null;
  const from = map.cityInfo?.[sourceCityId]?.gridIdx, to = map.cityInfo?.[targetCityId]?.gridIdx;
  if (!integer(from) || !integer(to) || !Array.isArray(brackets) || !brackets.length) return null;
  const position = idx => {
    const row = Math.floor(idx / map.width), col = idx % map.width;
    return [(col + 0.5 + (row % 2) * 0.5) * map.tileWidth, -row * map.tileHeight / 2];
  };
  const a = position(from), b = position(to), distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const tiers = [...brackets].sort((x, y) => x.dist - y.dist);
  if (tiers.some(row => !Number.isFinite(row.dist) || row.dist < 0 || !Number.isFinite(row.cost) || row.cost < 0)) return null;
  let unit = tiers[0].cost;
  for (const row of tiers) { if (distance < row.dist) break; unit = row.cost; }
  const cost = Math.ceil(distance * unit);
  return integer(cost) ? cost : null;
}

export async function readCityWar(client, protocol, config, player, preferences, { mapLoader = loadMapAsset } = {}) {
  const now = nowOf(client), worldId = exactAutomationId(player?.worldId), guildId = exactAutomationId(player?.guildId);
  const scenarioId = integer(player?.scenarioId, 1) ? player.scenarioId : 1;
  const snapshot = { now, worldId, guildId, playerId: exactAutomationId(player?.playerId), scenarioId,
    guildIdx: guildId ? Number(BigInt(guildId) % 1000n) : 0, nativeLimit: null, fuel: null,
    startTime: null, endTime: null, inWindow: false, fleets: [], targets: [], buildings: [], repairs: {}, notes: [], reason: '',
    attackDura: rows(config, 'WorldParamCfg').find(row => row.paramName === '攻城战消耗耐久')?.paramValue };
  const required = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界')?.playerLevel;
  if (!integer(required, 1) || !integer(player?.level, 1) || player.level < required) { snapshot.reason = '尚未满足世界玩法开放等级'; return snapshot; }
  if (!worldId || !snapshot.guildIdx || !snapshot.playerId) { snapshot.reason = '无法确认角色、区服或联盟身份'; return snapshot; }
  const season = Number(BigInt(worldId) / 1000000n % 1000n);
  const days = rows(config, 'GameplayOpenCfg').find(row => row.gameplay === '国战')?.openDays;
  const openDays = Array.isArray(days) && season > 0 ? days[Math.min(season, days.length) - 1] : null;
  if (!integer(openDays, 1) || !integer(player.worldOpenTime, 1) || player.worldOpenTime > now) { snapshot.reason = '无法确认城战赛季及开服条件'; return snapshot; }
  if (day(now) - day(player.worldOpenTime) + 1 < openDays) { snapshot.reason = '当前赛季尚未到城战开放日'; return snapshot; }
  const vip = rows(config, 'VipLevelCfg').find(row => row.level === player.vip?.vipLevel);
  const effect = vip?.effects?.find(row => row[0] === '每日城战委任次数');
  if (vip) snapshot.nativeLimit = effect ? effect[1] : 0;
  const get = async (request, body = {}) => {
    const response = request.replace(/Request$/, 'Response');
    if (!protocol?.[request] || !protocol?.[response]) throw new Error('当前协议缺少' + request);
    return client.request(request, body, response, 8000);
  };
  try {
    const [war, world, fleetReply, water, bag, guild, merge] = await Promise.all([
      get('WarDeclarationRequest'), get('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } }),
      get('MyFleetsRequest'), get('OnWaterRequest'), get('AllItemRequest'), get('GuildInfoRequest'), get('UniteWorldsPlanRequest'),
    ]);
    if (![war.declarations, world.cities, fleetReply.fleets, water.building, bag.items, merge.worldIds].every(Array.isArray)) throw new Error('城战、城市、舰队、建筑或库存数据不完整');
    if (exactAutomationId(guild.guild?.guildId) !== guildId || exactAutomationId(player.guildId) !== guildId) throw new Error('联盟身份已变化');
    snapshot.fleets = fleetReply.fleets; snapshot.buildings = water.building;
    snapshot.fuel = quantity(bag.items.find(row => row.itemId === '汽油')?.num ?? 0);
    snapshot.startTime = war.startTime; snapshot.endTime = war.endTime;
    if (!integer(war.startTime, 1) || !integer(war.endTime, war.startTime + 1)) throw new Error('服务器未返回有效城战时间');
    snapshot.inWindow = now >= war.startTime && now < war.endTime;
    if ((merge.matchMaking || (merge.worldIds.length && merge.executeTs > 0)) && (now >= (merge.executeTs ?? 0) - 3600 || day(now) === day(merge.executeTs))) throw new Error('合服匹配或执行期间暂停城战接续');
    const cityTable = scenarioId + '_CityCfg', costTable = scenarioId + '_AttackCityConsumeCfg';
    const cities = rows(config, cityTable), costs = rows(config, costTable);
    const refresh = '请运行 npm run sync-resources 更新配置与地图；使用微信缓存时先在游戏中进入当前地图，再运行 npm run sync-config 并重启控制台';
    if (!Array.isArray(cities) || !cities.length) throw new Error('缺少场景 ' + scenarioId + ' 的城市配置 ' + cityTable + '；' + refresh);
    if (!Array.isArray(costs) || !costs.length) throw new Error('缺少场景 ' + scenarioId + ' 的行军费用配置 ' + costTable + '；' + refresh);
    const home = cities.find(row => row.guildIndex === snapshot.guildIdx);
    if (!home) throw new Error('场景 ' + scenarioId + ' 的 ' + cityTable + ' 中未找到联盟编号 ' + snapshot.guildIdx + ' 的主城；' + refresh + '，仍有异常时请核对角色场景与联盟');
    snapshot.homeCityId = home.id;
    const map = await mapLoader(scenarioId, config?.resources ?? null);
    for (const declaration of war.declarations) {
      if (declaration.attackGuildIdx !== snapshot.guildIdx) continue;
      const live = world.cities.find(row => row.id === declaration.cityId), definition = cities.find(row => row.id === declaration.cityId);
      if (!live || !definition) { snapshot.notes.push('宣战城市' + declaration.cityId + '的状态或场景配置未取得'); continue; }
      if (live.guildIdx === snapshot.guildIdx || live.guildIdx !== declaration.defenceGuildIdx) continue;
      const petrol = cityPetrolCost(map, home.id, live.id, costs);
      if (!integer(petrol, 1)) { snapshot.notes.push((definition.name || '城市' + live.id) + '的行军汽油费用未确认'); continue; }
      const attackers = [...new Set(war.declarations.filter(row => row.cityId === live.id).map(row => row.attackGuildIdx))];
      let alliedCount = null, countReason = '';
      if (attackers.length !== 1 || attackers[0] !== snapshot.guildIdx) countReason = '多联盟共同进攻，无法拆分本联盟排队舰队数';
      else if (!integer(live.attackFleetNum) || !integer(live.priorityAtkFleetNum) || !Array.isArray(live.battlePoints)) countReason = '本联盟进攻队列数据未确认';
      else {
        const fighting = live.battlePoints.filter(point => point.leftFighter && !point.leftFighter.isNpc);
        if (fighting.some(point => point.leftFighter.guildIdx !== snapshot.guildIdx)) countReason = '进攻方身份已变化，等待重新核对';
        else alliedCount = live.attackFleetNum + live.priorityAtkFleetNum + fighting.length;
      }
      // 已同步在途：世界地图里的本盟舰队按目标城汇总；本人的在途舰队以 MyFleets 为准，
      // 避免和世界地图重复计数。归属不明的在途舰队不能当成 0。
      let transitCount = 0, transitReason = '';
      if (!Array.isArray(world.fleets)) transitReason = '在途舰队未同步';
      else {
        const ownIds = new Set(snapshot.fleets.map(row => row.buildingId));
        for (const fleet of world.fleets) {
          if (fleet.state !== 2 || fleet.targetCityId !== live.id || (fleet.treasureLootUid ?? 0) > 0 || fleet.chipWar?.rewardTs > 0) continue;
          const guild = exactAutomationId(fleet.owner?.guildId), playerId = exactAutomationId(fleet.owner?.playerId);
          if (!guild || !playerId) { transitReason = '在途舰队归属未同步'; break; }
          if (guild !== snapshot.guildId) continue;
          // 本人的同编号舰队可能与他人重名，必须按角色 ID 去重；MyFleets 已统计的跳过。
          if (playerId === snapshot.playerId) { if (!ownIds.has(fleet.buildingId)) transitCount++; continue; }
          transitCount++;
        }
        transitCount += snapshot.fleets.filter(fleet => fleet.state === 2 && fleet.targetCityId === live.id &&
          (fleet.treasureLootUid ?? 0) === 0 && !(fleet.chipWar?.rewardTs > 0) &&
          (!fleet.owner || exactAutomationId(fleet.owner.playerId) === snapshot.playerId)).length;
      }
      snapshot.targets.push({ id: live.id, ref: scenarioId + ':' + live.id, name: definition.name || '城市' + live.id,
        owner: live.guildIdx, petrol, assemble: war.assembleCityId === live.id, alliedCount, countReason,
        transitCount: transitReason ? null : transitCount, transitReason });
    }
    for (const id of preferences?.fleetIds ?? []) {
      const fleet = snapshot.fleets.find(row => row.buildingId === id);
      if (!preferences.autoRepair || !fleet || fleet.state !== 1 || !(fleet.durability < fleet.maxDura)) continue;
      try { snapshot.repairs[id] = await get('FleetRepairParamRequest', { buildingId: id }); }
      catch (error) { snapshot.repairs[id] = { error: error.message }; }
    }
  } catch (error) { snapshot.reason = '城战状态未确认：' + error.message; }
  return snapshot;
}

// 原生委任策略：-1 沿用服务器 VIP 额度；0 关闭所选舰队的原生委任；N>0 让原生先用 N 次
// （不超过 VIP 额度），达到后关闭开关并由工具接续。
function nativeState(fleet, snapshot, p) {
  const mode = p?.nativeCommissionLimit ?? -1;
  if (mode === 0) return { mode, target: 0, close: true, off: fleet?.autoFight?.isOn === true };
  if (mode === -1) {
    if (!fleet?.autoFight || !integer(fleet.autoFight.todayTimes)) return { mode, reason: '无法确认今日原生委任次数' };
    if (!integer(snapshot.nativeLimit, 1)) return { mode, reason: snapshot.nativeLimit === 0 ? '原生舰队委任尚未解锁' : '无法确认账号委任额度' };
    if (fleet.autoFight.todayTimes < snapshot.nativeLimit) return { mode, target: snapshot.nativeLimit, reason: '原生委任尚余 ' + (snapshot.nativeLimit - fleet.autoFight.todayTimes) + ' 次，暂不接续' };
    return { mode, target: snapshot.nativeLimit, close: false, off: false };
  }
  if (!integer(snapshot.nativeLimit, 0)) return { mode, reason: '无法确认账号委任额度' };
  const target = Math.min(mode, snapshot.nativeLimit);
  if (target > 0 && (!fleet?.autoFight || !integer(fleet.autoFight.todayTimes))) return { mode, target, reason: '无法确认今日原生委任次数' };
  if (target > 0 && fleet.autoFight.todayTimes < target) return { mode, target, reason: '原生委任计划尚余 ' + (target - fleet.autoFight.todayTimes) + ' 次，暂不接续' };
  return { mode, target, close: true, off: fleet?.autoFight?.isOn === true };
}

function fleetGate(fleet, snapshot, p) {
  const building = snapshot.buildings.find(row => row.buildingId === fleet.buildingId);
  if (!fleetNo(fleet.buildingId) || !(building?.level > 0)) return '远征船尚未建成或无法识别';
  if (!(building.fleet?.formation?.heroPositions ?? []).some(row => row.heroId)) return '请先保存舰队英雄编队';
  if (fleet.owner && exactAutomationId(fleet.owner.playerId) !== snapshot.playerId) return '舰队归属不符';
  if (fleet.state !== 1) return '舰队' + stateName(fleet);
  if (fleet.treasureLootUid > 0) return '舰队正在参与巨轮';
  if (fleet.curGridIdx > 0) return '舰队驻守在外';
  if (fleet.chipWar?.rewardTs > 0) return '舰队仍有矿场任务';
  if (!integer(fleet.durability) || !integer(fleet.maxDura, 1) || fleet.durability > fleet.maxDura) return '无法确认舰队耐久';
  const native = nativeState(fleet, snapshot, p);
  if (native.reason) return native.reason;
  if (native.close && native.off) return '原生委任待关闭后接续';
  return '';
}

export function cityWarReservedFleets(snapshot, settings, now = snapshot?.now) {
  const p = settings?.cityWar;
  if (!p?.enabled || !p.reserveDuringWar || snapshot?.reason || !(snapshot?.startTime <= now && now < snapshot.endTime)) return [];
  const valid = (snapshot.targets ?? []).some(target => p.targetMode === 'alliance' || p.cityRefs.includes(target.ref));
  return valid ? [...p.fleetIds] : [];
}

export function planCityWar(snapshot, settings, { usage = { counters: {} }, keys = {}, pendingPetrol = 0 } = {}) {
  keys=recordsInWorld(keys,snapshot.worldId);
  const p = settings?.cityWar;
  const plan = { actions: [], notes: [], reservedFleetIds: [], fleets: [], targets: snapshot.targets, nativeLimit: snapshot.nativeLimit,
    nativeCommissionLimit: p?.nativeCommissionLimit ?? -1, nativeOffFleetIds: [],
    startTime: snapshot.startTime, endTime: snapshot.endTime, fuel: snapshot.fuel, inWindow: snapshot.inWindow, reason: snapshot.reason };
  const currentKeys = Object.entries(keys).filter(([key, value]) => key.startsWith('cityWar:' + snapshot.worldId + ':') && !value.expired);
  for (const [, record] of currentKeys) if (!record.confirmed && record.details?.buildingId) plan.reservedFleetIds.push(record.details.buildingId);
  if (!p) return plan;
  for (const id of p.fleetIds) {
    const fleet = snapshot.fleets.find(row => row.buildingId === id), native = fleet ? nativeState(fleet, snapshot, p) : null;
    plan.fleets.push({ name: nameOf(id), state: fleet ? stateName(fleet) : '未取得', used: fleet?.autoFight?.todayTimes ?? null,
      limit: snapshot.nativeLimit, nativeMode: p.nativeCommissionLimit, nativeTarget: native?.target ?? null,
      durability: fleet?.durability, maxDura: fleet?.maxDura, reason: fleet ? fleetGate(fleet, snapshot, p) : '未取得舰队状态' });
  }
  if (!p.enabled) plan.notes.push('城战接续未开启');
  if (snapshot.reason) plan.notes.push(snapshot.reason);
  plan.notes.push(...snapshot.notes);
  if (!p.enabled || snapshot.reason) return plan;
  if (!snapshot.inWindow) { plan.notes.push('当前不在服务器城战时段'); return plan; }
  for (const id of p.fleetIds) {
    const fleet = snapshot.fleets.find(row => row.buildingId === id), native = fleet ? nativeState(fleet, snapshot, p) : null;
    if (native?.close && native.off) plan.nativeOffFleetIds.push(id);
  }
  if (plan.nativeOffFleetIds.length) plan.notes.push('发送前关闭所选舰队的原生委任：' + plan.nativeOffFleetIds.map(nameOf).join('、'));
  const selected = snapshot.targets.filter(row => p.targetMode === 'alliance' || p.cityRefs.includes(row.ref));
  const fewest = p.targetPriority === 'fewestAllied';
  const targetTotal = target => integer(target.alliedCount) && integer(target.transitCount) ? target.alliedCount + target.transitCount : null;
  if (fewest) for (const target of selected) {
    if (targetTotal(target) === null) plan.notes.push(target.name + '：' + (target.countReason || (target.transitCount == null ? target.transitReason : '') || '本联盟进攻、排队或在途数量未确认') + '，本次不按人数选择此点');
  }
  const candidates = selected.filter(row => !fewest || targetTotal(row) !== null);
  // 本轮已安排的舰队计入总数，但不再重复计算已同步在途舰队；在途数量已在读取时汇总。
  const assigned = new Map(candidates.map(target => [target.id, 0]));
  const totalOf = target => targetTotal(target) + (assigned.get(target.id) ?? 0);
  const originalOrder = (a, b) => p.targetMode === 'selected' ? p.cityRefs.indexOf(a.ref) - p.cityRefs.indexOf(b.ref)
    : Number(b.assemble) - Number(a.assemble) || a.petrol - b.petrol || a.id - b.id;
  // 队数最少的城为基准：相差 0–9 队时就近，差 10 队及以上时优先人少的城。
  const order = (a, b) => {
    if (!fewest) return originalOrder(a, b);
    const ta = totalOf(a), tb = totalOf(b), min = Math.min(...candidates.map(totalOf));
    const bandA = ta - min <= 9 ? 0 : 1, bandB = tb - min <= 9 ? 0 : 1;
    if (bandA !== bandB) return bandA - bandB;
    if (bandA === 0) return a.petrol - b.petrol || ta - tb || originalOrder(a, b);
    return ta - tb || a.petrol - b.petrol || originalOrder(a, b);
  };
  candidates.sort(order);
  if (!candidates.length) { plan.notes.push('没有符合选择的本联盟有效宣战目标'); return plan; }
  plan.reservedFleetIds.push(...cityWarReservedFleets(snapshot, settings));
  plan.reservedFleetIds = [...new Set(plan.reservedFleetIds)];
  if (!integer(snapshot.fuel) || !integer(pendingPetrol)) { plan.notes.push('无法确认汽油及未决预算'); return plan; }
  let fuel = snapshot.fuel - pendingPetrol, spent = usage.counters.cityWarPetrol ?? 0, dispatches = usage.counters.cityWarDispatches ?? 0;
  if (![spent, dispatches].every(n => integer(n))) { plan.notes.push('城战当日用量记录异常'); return plan; }
  for (const view of plan.fleets) {
    const id = p.fleetIds[plan.fleets.indexOf(view)], fleet = snapshot.fleets.find(row => row.buildingId === id);
    let reason = view.reason;
    if(!reason&&Object.values(keys).some(r=>r.details?.kind==='worldBoss'&&r.details.buildingId===id&&r.details.active!==false))reason='世界Boss首战尚未结束或结果待确认';
    if (!reason && Object.entries(keys).some(([key,r])=>key.startsWith('radar-send:'+snapshot.worldId+':') && r.details?.buildingId===id && r.details.active!==false)) reason='联盟情报尚在执行或结果待确认';
    if (!reason && Object.entries(keys).some(([key,r])=>key.startsWith('pirate-first:'+snapshot.worldId+':') && r.details?.buildingId===id && !['won','lost'].includes(r.details?.outcome))) reason='海盗首杀结果待确认，暂不接续出战或维修';
    if (!reason && Object.hasOwn(keys, keyOf(snapshot.worldId, id))) reason = '前次城战任务尚在执行或待确认';
    if (!reason && Object.entries(keys).some(([key, record]) => key.startsWith('treasure:' + snapshot.worldId + ':') && key.endsWith(':' + fleetNo(id)) && !record.confirmed && !record.expired)) reason = '巨轮派遣结果待确认，暂不接续出战或维修';
    if (!reason && keys['treasureRepair:' + snapshot.worldId + ':' + fleetNo(id)]?.confirmed === false) reason = '巨轮维修结果待确认，暂不接续出战或维修';
    if (!reason) reason = fleetRecordReason(keys,id);
    if (!reason && dispatches >= p.dailyDispatchLimit) reason = '已达今日工具接续出征上限';
    if (reason) { view.reason = reason; plan.notes.push(view.name + '：' + reason); continue; }
    candidates.sort(order);
    const target = candidates.find(row => row.id !== fleet.cityId);
    if (!target) { plan.notes.push(view.name + '：已在所选目标城市'); continue; }
    if (!integer(snapshot.attackDura, 1)) { plan.notes.push(view.name + '：无法确认城战耐久消耗'); continue; }
    const needsRepair = fleet.durability < Math.max(Math.ceil(fleet.maxDura * p.repairBelowPercent / 100), integer(snapshot.attackDura, 1) ? snapshot.attackDura : 1);
    let cost, request, body, kind;
    if (needsRepair) {
      if (!p.autoRepair) { plan.notes.push(view.name + '：耐久不足，自动维修已关闭'); continue; }
      const repair = snapshot.repairs[id];
      if (!(Number.isFinite(repair?.unitRepairCost) && repair.unitRepairCost > 0 && Number.isFinite(repair.unitRepairTime) && repair.unitRepairTime > 0)) { plan.notes.push(view.name + '：未取得有效维修报价'); continue; }
      cost = Math.ceil((fleet.maxDura - fleet.durability) * repair.unitRepairCost);
      if (!integer(cost, 1) || p.maxRepairCost > 0 && cost > p.maxRepairCost) { plan.notes.push(view.name + '：完整维修费用超过单次上限'); continue; }
      kind = 'cityRepair'; request = 'RepairFleetRequest'; body = { buildingId: id };
    } else { cost = target.petrol; kind = 'cityDispatch'; request = 'MoveFleetsToCityRequest'; body = { buildingId: [id], cityId: target.id }; }
    if (fuel - cost < p.petrolReserve) { plan.notes.push(view.name + '：汽油不足或会低于保留量'); continue; }
    if (p.dailyPetrolLimit > 0 && spent + cost > p.dailyPetrolLimit) { plan.notes.push(view.name + '：会超过今日城战汽油预算'); continue; }
    plan.actions.push({ kind, request, body, buildingId: id, cityId: target.id, cost,
      uniqueKey: keyOf(snapshot.worldId, id), beforeDurability: fleet.durability,
      label: view.name + (kind === 'cityRepair' ? '维修后继续城战' : '接续进攻' + target.name), costs: [{ id: '汽油', num: cost }] });
    fuel -= cost; spent += cost; if (kind === 'cityDispatch') { dispatches++; assigned.set(target.id, assigned.get(target.id) + 1); }
  }
  return plan;
}

function reconcile(snapshot,ledger){
 if(!snapshot.reason)settleFleetSnapshot(ledger,{worldId:snapshot.worldId,fleets:snapshot.fleets,now:snapshot.now,kinds:['cityRepair','cityDispatch']});
}

async function disableNativeCommission(client, protocol, ids) {
  if (!ids.length) return { ok: true, on: [], missing: [] };
  if (!protocol?.SetFleetAutoFightRequest) throw new Error('当前协议缺少 SetFleetAutoFightRequest');
  await client.sendWatch('SetFleetAutoFightRequest', { buildingIds: ids, isOn: false }, { window: 600 });
  const reply = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse', 8000);
  if (!Array.isArray(reply.fleets)) throw new Error('舰队状态未同步');
  const missing = ids.filter(id => !reply.fleets.some(row => row.buildingId === id));
  const on = ids.filter(id => reply.fleets.find(row => row.buildingId === id)?.autoFight?.isOn === true);
  return { ok: !missing.length && !on.length, on, missing };
}

export async function runCityWar(client, protocol, config, player, { getSettings, ledger, enabled = () => true, mapLoader, onStep, canUseFleet = () => true } = {}) {
  if (!cityWarEnabled(getSettings?.()) || !enabled()) return { results: [], reservedFleetIds: [] };
  if (active.has(client)) return { results: [], reservedFleetIds: [...getSettings().cityWar.fleetIds], notes: ['城战检查正在进行'] };
  if (!ledger?.updateKeyDetails || !ledger?.releaseCompletedKey) throw new Error('缺少持久城战任务记录');
  active.add(client);
  const results = [];
  try {
    const read = () => readCityWar(client, protocol, config, player, getSettings()?.cityWar, { mapLoader });
    let snapshot = await read();
    snapshot.attackDura = rows(config, 'WorldParamCfg').find(row => row.paramName === '攻城战消耗耐久')?.paramValue;
    reconcile(snapshot, ledger);
    const pending = () => { const p = ledger.pendingCounters(); return (p.cityWarPetrol ?? 0) + (p.treasurePetrol ?? 0) + (p.piratePetrol ?? 0) + (p.radarPetrol ?? 0) + (p.worldBossPetrol ?? 0) + (p.siliconPetrol ?? 0); };
    const settings = getSettings();
    let plan = planCityWar(snapshot, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords(), pendingPetrol: pending() });
    if (plan.nativeOffFleetIds.length) {
      const ids = [...plan.nativeOffFleetIds], signature = JSON.stringify([settings.cityWar.nativeCommissionLimit, ids]);
      const failure = nativeRejected.get(client);
      if (failure && failure.until > Date.now() && failure.signature === signature) {
        plan.notes.push(failure.reason);
        return { ...plan, results, remainingFuel: snapshot.fuel };
      }
      if (!enabled() || settings !== getSettings() || !cityWarEnabled(getSettings()) || !client.connected) {
        return { ...plan, results, remainingFuel: snapshot.fuel };
      }
      try {
        const off = await disableNativeCommission(client, protocol, ids);
        if (!off.ok) {
          const reason = '原生委任关闭结果待确认：' + (off.missing.length ? '舰队状态未同步' : off.on.map(nameOf).join('、'));
          nativeRejected.set(client, { until: Date.now() + 30000, signature, reason });
          plan.notes.push(reason);
          return { ...plan, results, remainingFuel: snapshot.fuel };
        }
        const closedNote = '已关闭原生委任：' + ids.map(nameOf).join('、');
        snapshot = await read();
        snapshot.attackDura = rows(config, 'WorldParamCfg').find(row => row.paramName === '攻城战消耗耐久')?.paramValue;
        reconcile(snapshot, ledger);
        plan = planCityWar(snapshot, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords(), pendingPetrol: pending() });
        plan.notes.unshift(closedNote);
        if (plan.nativeOffFleetIds.length) {
          plan.notes.push('原生委任关闭结果待确认：' + plan.nativeOffFleetIds.map(nameOf).join('、'));
          return { ...plan, results, remainingFuel: snapshot.fuel };
        }
      } catch (error) {
        if (error.prompt && error.request === 'SetFleetAutoFightRequest') {
          const reason = '关闭原生委任被拒绝：' + error.message;
          nativeRejected.set(client, { until: Date.now() + 300000, signature, reason });
          plan.notes.push(reason);
        } else plan.notes.push('关闭原生委任结果未知：' + error.message);
        return { ...plan, results, remainingFuel: snapshot.fuel };
      }
    }
    let remainingFuel = snapshot.fuel;
    for (const proposed of plan.actions) {
      if(!canUseFleet(proposed.buildingId)||legacyFleetReservationReason(client,proposed.buildingId))continue;
      if (!enabled() || !cityWarEnabled(getSettings()) || !client.connected) break;
      const fresh = await read(); fresh.attackDura = snapshot.attackDura;
      fresh.fuel = Math.min(fresh.fuel, remainingFuel);
      const reviewed = planCityWar(fresh, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords(), pendingPetrol: pending() });
      if (reviewed.nativeOffFleetIds.length) { plan.notes.push('原生委任状态变化，暂停本轮接续'); break; }
      const step = reviewed.actions.find(row => row.uniqueKey === proposed.uniqueKey && row.kind === proposed.kind && row.cityId === proposed.cityId && row.cost === proposed.cost);
      if (!step || !canUseFleet(step.buildingId) || legacyFleetReservationReason(client,step.buildingId) || settings !== getSettings() || !enabled() || exactAutomationId(player.guildId) !== fresh.guildId) continue;
      const currentVip = rows(config, 'VipLevelCfg').find(row => row.level === player.vip?.vipLevel);
      const currentLimit = currentVip?.effects?.find(row => row[0] === '每日城战委任次数')?.[1];
      // 只有沿用 VIP 额度的模式需要核对额度；0/N 模式按设置接管，不因缺少 VIP 行被拦住。
      const limitChanged = (settings.cityWar.nativeCommissionLimit ?? -1) < 0 && currentLimit !== fresh.nativeLimit;
      if (limitChanged || exactAutomationId(player.worldId) !== fresh.worldId ||
          nowOf(client) < fresh.startTime || nowOf(client) >= fresh.endTime) continue;
      const failure = rejected.get(client)?.get(step.uniqueKey);
      if (failure && failure.until > Date.now() && failure.signature === JSON.stringify(step.body)) continue;
      const details = { kind: step.kind, buildingId: step.buildingId, cityId: step.cityId, beforeDurability: step.beforeDurability, sentAt: fresh.now };
      const ticket = ledger.reserve({ cityWarPetrol: step.cost, cityWarDispatches: step.kind === 'cityDispatch' ? 1 : 0, cityWarRepairs: step.kind === 'cityRepair' ? 1 : 0 },
        { cityWarPetrol: settings.cityWar.dailyPetrolLimit || undefined, cityWarDispatches: settings.cityWar.dailyDispatchLimit }, {}, { uniqueKey: step.uniqueKey, details });
      if (!enabled() || settings !== getSettings() || !client.connected || legacyFleetReservationReason(client,step.buildingId)) { ledger.cancel(ticket); break; }
      let entry;
      try {
        await client.sendWatch(step.request, step.body, { window: 600 });
        const after = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse', 8000);
        reconcile({ ...fresh, now: nowOf(client), fleets: after.fleets ?? [], reason: '' }, ledger);
        const record = ledger.keyRecords()[step.uniqueKey];
        const confirmed = !record || record.confirmed;
        entry = { step, ok: confirmed, sent: true, status: confirmed ? 'confirmed' : 'unknown',
          note: confirmed ? (step.kind === 'cityRepair' ? '服务器已确认维修状态或耐久增加' : '服务器已确认舰队前往城战目标') : '请求已发送，结果待确认；保留汽油和舰队锁定' };
      } catch (error) {
        if (error.prompt && error.request === step.request) {
          ledger.cancel(ticket);
          const failures = rejected.get(client) ?? new Map(); rejected.set(client, failures);
          failures.set(step.uniqueKey, { until: Date.now() + 300000, signature: JSON.stringify(step.body) });
          entry = { step, ok: false, status: 'rejected', error: error.message };
        } else entry = { step, ok: false, status: 'unknown', error: '结果未知，保留预算与舰队锁定：' + error.message };
      }
      results.push(entry); onStep?.(entry);
      if (entry.status !== 'rejected') remainingFuel -= step.cost;
      if (entry.status === 'unknown') break;
    }
    return { ...plan, results, remainingFuel };
  } finally { active.delete(client); }
}
