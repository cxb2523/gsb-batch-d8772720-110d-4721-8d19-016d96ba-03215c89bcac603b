// 海面世界的只读探测与计划器：收成品、竣工、建造新建筑、交居民订单、按订单缺口排产、余料升级建筑。
//
// 所有事实都来自客户端自身的调用点与配置表，没有推测：
// - buildingId 形如 "1食品厂" / "1A民居" / "1指标楼A"，即 <序号><可选字母><建筑类型>，
//   类型按最长后缀去比 BuildingCfg.buildingType（58 种）。
// - 人口不是协议字段，是客户端算出来的：初始人口 + Σ BuildingUpgradeCfg[建筑类型][当前等级].effect 里的
//   「人口增加」；人口上限 = GameParamCfg 初始人口上限 + Σ「人口上限」。所以升级前的人口校验
//   可以离线复算（WaterModel._refreshPopulation 同款规则）。
// - 工厂队列上限 = BuildingProduceParamCfg 制造位上限（6），成品存量上限 = GameParamCfg 产品存量初始上限（50）。
// - 加速只花「加速器」：SpeedUpCostParam{type:2, useNum}（SpeedUpCost.SPEED_UP_ITEM=2）。
//   type=1 是钻石、type=3 是广告，本模块永不使用。
//
// 交互原则与 tasks.mjs 一致：先只读探测，再算出计划，显式授权后才逐条执行；
// 没有配套 Response 的写请求走 client.sendWatch()。

import fs from 'node:fs';
import path from 'node:path';
import { SERVER, assetUrl } from '../tools/sync-art.mjs';
import { activeResources } from './resource-store.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { normalize } from './worlds.mjs';
import { residentFilter, resourceReserve, worldPreferenceEnabled, worldActionAllowed, exactAutomationId, AutomationSkip, createActionGuard } from './automation-policy.mjs';
import { readWeekOrder } from './activities.mjs';
import { RESOURCE, displayMaterial } from './config.mjs';
import { captureFarmMaterialState, farmInventory, settleFarmMaterialState } from './farm-planting.mjs';

// 与客户端FactoryUtil一致：活动工坊只使用服务器limitTimeItem开放窗口。
export function factoryRecipeAvailability(recipe, festivals, now) {
  if (!recipe) return {allowed:false,reason:'配方未确认',signature:'missing'};
  if (!recipe.limitType && recipe.buildType!=='活动工厂') return {allowed:true,signature:'ordinary'};
  if (!Array.isArray(festivals)) return {allowed:false,reason:'活动配方开放状态未同步',signature:'unknown'};
  const windows=festivals.flatMap(event=>(event.festivalData?.limitTimeItem??[]).filter(row=>row.item===recipe.limitType).map(row=>({item:row.item,openTime:row.openTime,closeTime:row.closeTime})));
  const valid=windows.filter(w=>Number.isSafeInteger(w.openTime)&&Number.isSafeInteger(w.closeTime)&&w.openTime>0&&w.closeTime>=w.openTime);
  const allowed=valid.some(w=>w.openTime<=now&&now<=w.closeTime);
  return {allowed,reason:allowed?'':'当前活动未开放此配方',signature:JSON.stringify(valid)};
}
const factoryFailures = new WeakMap();

export const SPEED_UP_ITEM = '加速器';
export const SPEED_UP_ITEM_TYPE = 2;
const STOCK_PARAM = '产品存量初始上限';
const SLOTS_PARAM = '制造位上限';
const POPULATION_PARAM = '初始人口上限';

function rowsOf(config, name) {
  return config?.tables?.[name]?.data ?? [];
}

// 这些常量散在几张 param 表里（人口/存量在 GameParamCfg，制造位在 BuildingProduceParamCfg），
// 名字不重复，所以统一按名字查。
function paramOf(config, name) {
  for (const table of ['GameParamCfg', 'BuildingProduceParamCfg']) {
    const row = rowsOf(config, table).find((r) => r.paramName === name);
    if (row) return row.paramValue ?? 0;
  }
  return 0;
}

function indexBy(config, name, key) {
  const out = new Map();
  for (const row of rowsOf(config, name)) out.set(row[key], row);
  return out;
}

// effect 是一组 [名字, 数值]，人口与上限都从这里累加。
function sumEffect(effect, name) {
  let total = 0;
  for (const entry of effect ?? []) {
    if (entry?.[0] === name) total += Number(entry[1] ?? 0);
  }
  return total;
}

// <序号><可选字母><建筑类型> 里抠出类型：取能匹配上的最长后缀。
export function makeTypeResolver(config) {
  const types = [...new Set(rowsOf(config, 'BuildingCfg').map((r) => r.buildingType))]
    .sort((a, b) => b.length - a.length);
  return (buildingId) => types.find((type) => buildingId.endsWith(type)) ?? null;
}

export function displayBuilding(config, building) {
  const { buildingId, type } = building;
  const name = rowsOf(config, 'BuildingCfg').find(row => row.buildingType === type)?.name || type;
  if (!name) return buildingId;
  const prefix = buildingId.endsWith(type) ? buildingId.slice(0, -type.length) : '';
  const hasPeers = rowsOf(config, 'BuildingUnlockCfg').some(row => row.buildingType === type && row.buildingId !== buildingId);
  return hasPeers && /^\d+$/.test(prefix) ? `${name}（${prefix} 号）` : name;
}

function durationText(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return seconds + ' 秒';
  return minutes + ' 分钟' + (rest ? ' ' + rest + ' 秒' : '');
}

// 活动页和挂机共用游戏配方；同类工厂优先使用等级最高的一座。
export function weekFactoryInfo(config, itemId, buildings) {
  const recipe = rowsOf(config, 'BuildingProduceCfg').find(row => row.itemId === itemId);
  if (!recipe) return null;
  const type = recipe.buildType;
  const best = buildings?.filter(b => b.type === type).sort((a, b) => b.level - a.level
    || Number(b.buildFinishTime > 0) - Number(a.buildFinishTime > 0))[0];
  return {
    type, name: rowsOf(config, 'BuildingCfg').find(row => row.buildingType === type)?.name || type,
    required: recipe.unlockLevel, level: buildings ? (best?.level ?? 0) : null,
    buildingId: best?.buildingId, constructing: best?.buildFinishTime > 0,
  };
}

export function upgradeRow(config, buildingType, level) {
  return rowsOf(config, 'BuildingUpgradeCfg').find((r) => r.buildingType === buildingType && r.level === level) ?? null;
}

export function topLevel(config, buildingType) {
  return rowsOf(config, 'BuildingUpgradeCfg')
    .filter((r) => r.buildingType === buildingType)
    .reduce((max, r) => Math.max(max, r.level), 0);
}

// v74 identifies orders by reusable slots. Keep a per-connection token that
// changes if the game replaces the slot, or we have already attempted its delivery.
const residentSessions = new WeakMap();
function trackResidentOrders(client) {
  let session = residentSessions.get(client);
  if (session) return session;
  session = new Map();
  residentSessions.set(client, session);
  client.on?.('message', ({ name, body }) => {
    if (name === 'SCWorkerOrder') rememberResidentOrders(session, normalize(body?.order ?? []));
  });
  return session;
}

export function watchResidentRefreshes(client,ledger,player){
 const session=trackResidentOrders(client),world=exactAutomationId(player?.worldId),id=exactAutomationId(player?.playerId);
 if(ledger&&world&&id)session.manualRefresh={ledger,identity:world+':'+id};
 return session;
}

function rememberResidentOrders(session, orders) {
  const keys = new Map();
  for (const order of orders) {
    const index = order.index ?? 0;
    if (keys.has(index)) { keys.set(index, null); session.delete(index); continue; }
    const quantities = new Map();
    for (const item of order.requirements ?? []) quantities.set(item.id ?? '', (quantities.get(item.id ?? '') ?? 0) + Number(item.num ?? 0));
    const needs = [...quantities].sort(([a], [b]) => a.localeCompare(b));
    const signature = JSON.stringify([order.workerId ?? 0, order.textId ?? 0, !!order.isSpecial, order.refreshTime ?? 0, needs]);
    if (session.get(index)?.signature !== signature) session.set(index, { key: randomUUID(), signature });
    keys.set(index, session.get(index).key);
  }
  session.refreshPending=new Set();
  if(session.manualRefresh){const {ledger,identity}=session.manualRefresh;
    for(const[key,record]of Object.entries(ledger.keyRecords())){
      const detail=record.details;if(detail?.kind!=='manualOrderRefresh'||detail.identity!==identity)continue;
      const row=session.get(detail.index);if(!row||!keys.has(detail.index))continue;
      if(row.signature!==detail.signature){if(!record.confirmed)ledger.resolveKey(key,true);ledger.releaseCompletedKey(key);}
      else if(!record.confirmed){keys.set(detail.index,null);session.refreshPending.add(detail.index);}
    }
  }
  for (const index of session.keys()) if (!keys.has(index)) session.delete(index);
  return keys;
}

// 只读探测：一次拉齐海面状态、库存、资源田、舰队。
export async function surveyWorld(client, protocol, { config = null, player = null, includeWeekOrder = true, includeCargo = false, ordersOnly = false, timeout = 8000 } = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      const raw = await client.request(name, {}, responseName, timeout);
      const value = normalize(raw);
      if (name === 'OnWaterRequest') for (const [index, building] of (value.building ?? []).entries()) {
        if (building.petServe) building.petServe.petUid = exactAutomationId(raw.building[index].petServe?.petUid);
      }
      return value;
    } catch {
      return null;
    }
  };

  const orderSession = trackResidentOrders(client);
  let farmState;
  // A later round may only harvest, with no new spending to invoke the guard.
  // Capture old attempts before the ordered world/inventory reads below.
  try { if (player) farmState = captureFarmMaterialState(player); } catch { /* Incomplete preview identity cannot settle writes. */ }
  const water = await get('OnWaterRequest');
  if (!water) throw new Error('拿不到 OnWaterResponse，无法探测海面');
  const orderKeys = rememberResidentOrders(orderSession, water.workerOrder ?? []);
  const [itemList, resourceList, resFields, fleets] = await Promise.all([
    get('AllItemRequest'),
    ordersOnly ? null : get('AllResourceRequest'),
    ordersOnly ? null : get('MyResFieldsRequest'),
    ordersOnly ? null : get('MyFleetsRequest'),
  ]);
  if (farmState) {
    try { settleFarmMaterialState(player, { ...farmState, water }, farmInventory(itemList)); }
    catch { /* A partial snapshot keeps the original seed and plot reservation. */ }
  }

  // 道具和资源合到一张库存表里，消耗项的 id 有的是道具名（木材）、有的是资源名（GOLD）。
  const stock = new Map();
  const addStock = (id, num) => stock.set(id, (stock.get(id) ?? 0) + Number(num ?? 0));
  if (Array.isArray(itemList?.items)) for (const item of itemList.items) {
    if (item?.itemId || item?.id) addStock(item.itemId ?? item.id, item.num ?? item.count);
  }
  for (const entry of resourceList?.list ?? []) addStock(RESOURCE[entry.res] ?? String(entry.res), entry.amount);

  const resolveType = makeTypeResolver(config);
  const notes = [];

  // 人口 / 人口上限：客户端同款累加，只算已建成的（level > 0）。
  let population = paramOf(config, '初始人口');
  let futurePopulation = population;
  let maxPopulation = paramOf(config, POPULATION_PARAM);
  const buildings = [];
  for (const raw of water.building ?? []) {
    const buildingId = raw.buildingId;
    const type = resolveType(buildingId);
    const level = raw.level ?? 0;
    const current = upgradeRow(config, type, level);
    population += sumEffect(current?.effect, '人口增加');
    const future = raw.buildStartTime > 0 ? upgradeRow(config, type, level + 1) : current;
    futurePopulation += sumEffect(future?.effect, '人口增加');
    maxPopulation += sumEffect(current?.effect, '人口上限');
    if (!type) notes.push(`暂时无法识别建筑「${buildingId}」，本轮跳过`);
    buildings.push({
      buildingId,
      type,
      level,
      farm: raw.farm ?? null,
      factory: raw.factory ?? null,
      petBreed: raw.petBreed ?? null,
      petServe: raw.petServe ?? null,
      product: (raw.product?.asset ?? []).map((a) => ({ id: a.id, num: Number(a.num ?? 0) })),
      buildStartTime: raw.buildStartTime ?? 0,
      buildFinishTime: raw.buildFinishTime ?? 0,
      auto: raw.auto === true,
      population: sumEffect(current?.effect, '人口增加'),
    });
  }

  // WaterModel creates level-0 building models locally after the level and
  // prerequisite checks. Unbuilt plots of any category can be absent from the reply.
  const levels = new Map(buildings.map(b => [b.buildingId, b.level]));
  for (const row of rowsOf(config, 'BuildingUnlockCfg')) {
    if (levels.has(row.buildingId) || row.playerLevel > (player?.level ?? 1)) continue;
    if (!(row.condition ?? []).every(([id, lv]) => (levels.get(id) ?? 0) >= lv)) continue;
    buildings.push({ buildingId: row.buildingId, type: row.buildingType, level: 0,
      factory: null, product: [], buildStartTime: 0, buildFinishTime: 0, population: 0 });
  }

  const orderCfg = indexBy(config, 'WorkerOrderCfg', 'itemId');
  const specOrderCfg = indexBy(config, 'WorkerSpecOrderCfg', 'times');
  const workerNames = new Map(rowsOf(config, 'WorkerBaseCfg').map(worker => [String(worker.id), worker.showName]));
  const have = (id) => stock.get(id) ?? 0;

  const orders = (water.workerOrder ?? []).map((raw) => {
    const quantities = new Map();
    for (const row of raw.requirements ?? []) quantities.set(row.id, (quantities.get(row.id) ?? 0) + Number(row.num ?? 0));
    const requirements = Array.from(quantities, ([id, num]) => ({ id, num }));
    const missing = requirements
      .map((r) => ({ id: r.id, num: Math.max(0, r.num - have(r.id)) }))
      .filter((r) => r.num > 0);
    // 订单经验：特殊订单看 WorkerSpecOrderCfg（times 就是 textId），普通订单按需求项累加。
    let rewardExp = null;
    if (raw.isSpecial) {
      const row = specOrderCfg.get(raw.textId) ?? specOrderCfg.get(String(raw.textId));
      rewardExp = Number((row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1] ?? 0) || null;
    } else {
      let total = 0;
      let known = requirements.length > 0;
      for (const r of requirements) {
        const row = orderCfg.get(r.id);
        const exp = (row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1];
        if (exp === undefined) known = false;
        else total += Number(exp) * r.num;
      }
      rewardExp = known ? total : null;
    }
    let rewardGold = null;
    if (raw.isSpecial) {
      const row = specOrderCfg.get(raw.textId) ?? specOrderCfg.get(String(raw.textId));
      const reward = (row?.reward ?? []).find(x => x[0] === 'GOLD');
      if (reward) rewardGold = Number(reward[1]);
    } else if (requirements.length && requirements.every(r => (orderCfg.get(r.id)?.reward ?? []).some(x => x[0] === 'GOLD'))) {
      rewardGold = requirements.reduce((sum, r) => sum + Number(orderCfg.get(r.id).reward.find(x => x[0] === 'GOLD')[1]) * r.num, 0);
    }
    return {
      index: raw.index ?? 0,
      orderKey: orderKeys.get(raw.index ?? 0),
      refreshPending: orderSession.refreshPending?.has(raw.index??0)??false,
      workerId: raw.workerId,
      workerName: workerNames.get(String(raw.workerId)) || '未知居民',
      textId: raw.textId,
      isSpecial: raw.isSpecial === true,
      refreshTime: raw.refreshTime ?? 0,
      requirements,
      missing,
      rewardExp,
      rewardGold,
    };
  });

  let weekOrder = new Map();
  const cargoOrder = new Map();
  const stockKnown = Array.isArray(itemList?.items) && itemList.items.every(item =>
    (item?.itemId || item?.id) && Number.isSafeInteger(item.num ?? item.count ?? 0) && (item.num ?? item.count ?? 0) >= 0);
  let orderCheckError = !stockKnown ? '未能读取仓库库存' : includeWeekOrder &&
    (!protocol.WeekInfoRequest || !protocol.WeekOrderInfoRequest) ? '无法确认周订单预留' : '';
  if (includeCargo && !player?.level) orderCheckError = '无法确认贸易港的开放状态';
  if (includeWeekOrder && itemList && protocol.WeekInfoRequest && protocol.WeekOrderInfoRequest) {
    try {
      const { needed, finished } = await readWeekOrder(client, undefined, config);
      if (!finished) weekOrder = needed;
      if (includeCargo && player?.level >= (config?.tables?.CargoUnlockCfg?.data[0]?.playerLevel ?? 9)) {
        const ships = await get('CargoShipsRequest');
        const ordersKnown = Array.isArray(ships?.ship) && ships.ship.every(ship => ship &&
          ((ship.status ?? 0) !== 0 || (Array.isArray(ship.orderItem) && ship.orderItem.every(slot =>
            slot && (slot.filled || (slot.asset?.id && Number.isSafeInteger(slot.asset.num) && slot.asset.num > 0))))));
        if (!ordersKnown) {
          notes.push('本轮未能读取贸易港货单');
          orderCheckError = '未能确认贸易港货单预留';
        }
        for (const ship of ordersKnown ? ships.ship : []) {
          if ((ship.status ?? 0) !== 0) continue;
          for (const { filled, asset } of ship.orderItem ?? []) {
            if (!filled && asset?.num > 0) cargoOrder.set(asset.id, (cargoOrder.get(asset.id) ?? 0) + Number(asset.num));
          }
        }
      }
    } catch (error) {
      notes.push('本轮未能读取周订单：' + error.message);
      orderCheckError = '未能确认周订单预留';
    }
  }
  const factories = buildings.filter((b) => b.factory);
  const resFieldInfo = resFields?.info ?? null;
  const vip = rowsOf(config, 'VipLevelCfg').find(row => row.level === player?.vip?.vipLevel);
  const stockBonus = Number(vip?.effects?.find(([effect]) => effect === '加工品存量上限')?.[1] ?? 0);

  return {
    now: Math.floor(Date.now() / 1000),
    serverNow: Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000),
    player,
    stock,
    have,
    buildings,
    factories,
    orders,
    orderCheckError,
    weekOrder,
    cargoOrder,
    orderOfTheDay: water.orderOfTheDay ?? { orderNum: 0, rewardedNum: 0 },
    autoProduceEndTime: water.autoProduceEndTime ?? 0,
    autoProduceForever: water.autoProduceForever === true,
    festivals: Array.isArray(client.festivals)?normalize(client.festivals):null,
    floaters: water.floater ?? [],
    floaterCount: (water.floater ?? []).length,
    population,
    futurePopulation,
    maxPopulation,
    autoFarming: water.autoFarming === true,
    cropIds: new Set(rowsOf(config, 'FarmlandPlantCfg').map(row => row.id)),
    fishingLevel: water.fishingLevel ?? null,
    salvageLevel: water.salvageLevel ?? null,
    divingLevel: water.divingLevel ?? null,
    stockCap: paramOf(config, STOCK_PARAM) + stockBonus,
    factorySlots: paramOf(config, SLOTS_PARAM),
    resFields: resFieldInfo ? normalize(resFieldInfo) : null,
    fleets: fleets ? normalize(fleets.fleets ?? []) : null,
    worldOpenLevel: rowsOf(config, 'ModuleOpenCfg').find(r => r.moduleId === '世界')?.playerLevel,
    notes,
  };
}

// 计划：收成品 → 竣工 → 建造 → 交单 → 排产 → 余料升级 → 加速。每步都只排「客户端确实会发的请求」。
export function planWorld(survey, {
  config = null,
  allowSpeedUp = false,
  allowReroll = false,
  minOrderExp = 0,
  maxUpgrades = Infinity,
  enabled: taskEnabled = () => true,
  settings = null,
  usage = { counters: {} },
  extraDemand = [],
} = {}) {
  const { now, have } = survey;
  const enabled = kind => taskEnabled(kind) && worldPreferenceEnabled(settings, kind);
  const blockedBuilding = b => !!settings?.building.disabledTypes.some(id => id === b.type || id === b.buildingId);
  const blockedFactory = b => !!settings?.factory.disabledTypes.some(id => id === b.type || id === b.buildingId);
  if (settings) maxUpgrades = settings.building.maxUpgrades;
  const name = id => displayMaterial(config, id);
  const buildingName = b => displayBuilding(config, b);
  const actions = [];
  const notes = [];
  const reserved = new Map();
  const orderDecisions = [];
  const dueHarvest = new Map();
  const markHarvest = (id, num) => dueHarvest.set(id, (dueHarvest.get(id) ?? 0) + num);
  const reserve = (id, num) => reserved.set(id, (reserved.get(id) ?? 0) + Number(num ?? 0));
  const free = (id) => have(id) - (reserved.get(id) ?? 0) - resourceReserve(settings, id);

  // 给手动交周订单留出已有库存，在产和待收的成品也计入缺口。
  const weeklyGap = new Map();
  const weeklyHeld = new Map();
  const borrowedTotals = new Map();
  const weeklyNeeds = [...(survey.weekOrder ?? [])];
  const weeklyIncomplete = !survey.orderCheckError && weeklyNeeds.every(([id, num]) => id && Number.isSafeInteger(num) && num > 0)
    && weeklyNeeds.some(([id, num]) => have(id) < num);
  for (const [id, required] of weeklyNeeds) {
    const held = Math.min(required, have(id));
    if (held > 0) reserve(id, held);
    weeklyHeld.set(id, held);
    weeklyGap.set(id, required - held);
  }
  const cargoGap = new Map();
  const cargoHeld = new Map();
  for (const [id, required] of survey.cargoOrder ?? []) {
    const held = Math.min(required, free(id));
    reserve(id, held);
    cargoHeld.set(id, held);
    cargoGap.set(id, required - held);
  }
  const incomingForResidents = new Map();
  const credit = (id, num) => {
    const weekly = Math.min(weeklyGap.get(id) ?? 0, num);
    if (weekly) weeklyGap.set(id, weeklyGap.get(id) - weekly);
    const cargo = Math.min(cargoGap.get(id) ?? 0, num - weekly);
    if (cargo) cargoGap.set(id, cargoGap.get(id) - cargo);
    return num - weekly - cargo;
  };
  const creditExistingProduction = () => {
    incomingForResidents.clear();
    for (const [id, required] of weeklyNeeds) weeklyGap.set(id, required - weeklyHeld.get(id));
    for (const [id, required] of survey.cargoOrder ?? []) cargoGap.set(id, required - cargoHeld.get(id));
    const addIncoming = (id, num) => incomingForResidents.set(id, (incomingForResidents.get(id) ?? 0) + credit(id, num));
    for (const { factory } of survey.factories) {
      for (const item of factory.finishedProducts ?? []) addIncoming(item.id, item.num);
      for (const job of factory.factoryQ ?? []) addIncoming(job.productId, 1);
    }
  };
  creditExistingProduction();
  const initialWeeklyGap = new Map(weeklyGap);

  const factoryTargets = new Map();
  if (enabled('weekFactory')) {
    for (const [id, gap] of weeklyGap) {
      if (gap <= 0) continue;
      const target = weekFactoryInfo(config, id, survey.buildings);
      if (!target || target.level >= target.required) continue;
      if (blockedBuilding({ type: target.type, buildingId: target.buildingId }) || blockedFactory({ type: target.type, buildingId: target.buildingId })) continue;
      if ((factoryTargets.get(target.type)?.required ?? 0) < target.required) factoryTargets.set(target.type, target);
    }
  }
  // 1. 收成品：工厂走 GainFactoryProduce，非工厂建筑的囤积产物一次性批量收。
  for (const b of survey.factories) {
    if (enabled('gainFactory') && (b.factory.finishedProducts ?? []).length > 0) {
      for (const item of b.factory.finishedProducts) markHarvest(item.id, Number(item.num));
      actions.push({
        kind: 'gainFactory',
        request: 'GainFactoryProduceRequest',
        response: 'GainFactoryProduceResponse',
        body: { buildingId: b.buildingId },
        label: `收取${buildingName(b)}的成品：${b.factory.finishedProducts.map(item => name(item.id) + ' ×' + item.num).join('、')}`,
      });
    }
  }
  const collectible = survey.buildings.filter((b) => !b.factory && b.product.length > 0);
  if (enabled('collectProduct') && collectible.length > 0) {
    for (const b of collectible) for (const item of b.product) markHarvest(item.id, item.num);
    actions.push({
      kind: 'collectProduct',
      request: 'CollectBuildingProductRequest',
      response: 'CollectBuildingProductResponse',
      body: { buildingId: collectible.map(b => b.buildingId) },
      label: `收取建筑产物：${collectible.map(buildingName).join('、')}`,
    });
  }

  // 2. 竣工：建造时间已过的建筑先收尾，收尾后它才能继续升级。
  for (const b of survey.buildings) {
    if (enabled('finishUpgrade') && b.buildFinishTime > 0 && b.buildFinishTime <= now) {
      actions.push({
        kind: 'finishUpgrade',
        request: 'FinishUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId },
        label: `完成${buildingName(b)}的施工`,
      });
    }
  }

  // 3. 建造：OnWaterResponse 里 level=0 的建筑是空位——要么「已解锁但没盖」，要么正在盖。
  //    客户端的分支很明确（subpackages/main/game.js 的 _toBuildOrUpgradeRequest）：
  //    `0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`，所以建造这一条与升级不是同一个请求。
  //    首建门槛、前置建筑和材料取自每个具体地块的 BuildingUnlockCfg。
  const builds = [];
  const buildMaterials = new Map();
  const unavailableRecipes=new Map();
  const produceRows = rowsOf(config, 'BuildingProduceCfg').filter(row=>{const gate=factoryRecipeAvailability(row,survey.festivals,survey.serverNow??now);if(!gate.allowed&&survey.factories.some(b=>b.type===row.buildType)){notes.push(name(row.itemId)+'：'+gate.reason);unavailableRecipes.set(row.buildType,gate.reason);}return gate.allowed;});
  const craftable = new Set(produceRows.filter(row =>
    survey.factories.some(b => b.type === row.buildType && b.level >= row.unlockLevel)).map(row => row.itemId));
  const unlocks = indexBy(config, 'BuildingUnlockCfg', 'buildingId');
  const levels = new Map(survey.buildings.map(b => [b.buildingId, b.level]));
  let plannedPopulation = survey.futurePopulation ?? survey.population;
  for (const b of survey.buildings) {
    if (!enabled('build')) break;
    if (blockedBuilding(b)) continue;
    if (!b.type || b.level !== 0) continue;
    // 有开工或完工时间就已有工程；即便已到竣工时间且竣工开关关闭，也不是空地。
    if (b.buildStartTime > 0 || b.buildFinishTime > 0) continue;
    const row = unlocks.get(b.buildingId);
    if (!row) continue;
    const missingBuildings = (row.condition ?? []).filter(([id, lv]) => (levels.get(id) ?? 0) < lv);
    if (missingBuildings.length) {
      const requirements = missingBuildings.map(([id, level]) => {
        const type = unlocks.get(id)?.buildingType;
        return `${buildingName({ buildingId: id, type })}达到 ${level} 级`;
      });
      notes.push(`${buildingName(b)} 建造有额外条件：需要${requirements.join('、')}`);
      continue;
    }
    if (row.curPeople > survey.population) {
      notes.push(`${buildingName(b)} 需要人口 ${row.curPeople}，当前 ${survey.population}`);
      continue;
    }
    if (row.playerLevel > (survey.player?.level ?? 1)) {
      notes.push(`${buildingName(b)} 建造要等级 ${row.playerLevel}，当前 ${survey.player?.level ?? 1}，先推主线`);
      continue;
    }
    const consume = (row.consume ?? []).map(([id, n]) => ({ id, num: Number(n) }));
    if (!consume.every((c) => free(c.id) >= c.num)) {
      const missing = consume.filter(c => free(c.id) < c.num);
      if (enabled('buildSupply') && enabled('startProduce') && missing.every(c => craftable.has(c.id))) {
        for (const c of missing) {
          if ((buildMaterials.get(c.id)?.num ?? 0) < c.num) buildMaterials.set(c.id, { num: c.num, name: buildingName(b) });
        }
      }
      const short = missing.map((c) => `${name(c.id)} ${free(c.id)}/${c.num}` + (config?.materialSources?.(c.id)?.length ? `（来源：${config.materialSources(c.id).join("、")}）` : "")).join(' ');
      notes.push(`${buildingName(b)} 建造材料不足（${short}），不买材料，等下一轮`);
      continue;
    }
    const effect = upgradeRow(config, b.type, 1)?.effect;
    builds.push({ building: b, row, consume, gain: sumEffect(effect, '人口增加'), capacity: sumEffect(effect, '人口上限') });
  }
  const upgradeReasons = [];
  const typeLevels = new Map();
  for (const b of survey.buildings) typeLevels.set(b.type, Math.max(typeLevels.get(b.type) ?? 0, b.level));
  let upgradeCount = 0;
  planUpgrades(true);
  builds.sort((a, b) => Number(b.row.category === '指标') - Number(a.row.category === '指标')
    || Number(b.gain > 0) - Number(a.gain > 0)
    || a.row.playerLevel - b.row.playerLevel || a.building.buildingId.localeCompare(b.building.buildingId));
  const priorityPlots = new Set();
  for (const target of factoryTargets.values()) {
    if (target.level || target.constructing) continue;
    const plot = builds.find(u => u.building.type === target.type);
    if (plot) priorityPlots.add(plot.building.buildingId);
  }
  builds.sort((a, b) => Number(priorityPlots.has(b.building.buildingId)) - Number(priorityPlots.has(a.building.buildingId)));
  let buildCount = 0;
  for (const u of builds) {
    if (settings && buildCount >= settings.building.maxBuilds) { notes.push('已达到每轮建造数量上限'); break; }
    if (u.gain && plannedPopulation + u.gain > survey.maxPopulation) {
      notes.push(`${buildingName(u.building)} 增加 ${u.gain} 人，需上限 ${plannedPopulation + u.gain}，当前上限 ${survey.maxPopulation}；先建指标建筑`);
      continue;
    }
    if (!u.consume.every(c => free(c.id) >= c.num)) {
      notes.push(`${buildingName(u.building)} 建材已预留给本轮其他地块，下一轮重新检查`);
      continue;
    }
    plannedPopulation += u.gain;
    buildCount++;
    for (const c of u.consume) reserve(c.id, c.num);
    actions.push({
      kind: 'build',
      request: 'BuildBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      costs: u.consume,
      label: `建造${buildingName(u.building)}（需要角色 ${u.row.playerLevel} 级）`
        + (priorityPlots.has(u.building.buildingId) ? `，周订单需要 ${factoryTargets.get(u.building.type).required} 级` : '')
        + (u.capacity ? `，竣工后人口上限 +${u.capacity}` : '')
        + (u.gain ? `，竣工后人口 +${u.gain}` : ''),
    });
  }

  // Count ripe crops too: keep the order until the actual harvest reply is known.
  if (enabled('farm') && (!settings || settings.farm.harvest) && (!survey.autoFarming || settings)) {
    const crops = rowsOf(config, 'FarmlandPlantCfg');
    for (const plot of survey.buildings.filter(b => b.type === '农田' && b.level > 0 && !b.buildStartTime && !b.buildFinishTime)) {
      const crop = crops.find(r => r.id === plot.farm?.productId);
      if (crop && plot.farm.ripeTime > 0 && plot.farm.ripeTime < (survey.serverNow ?? now)) {
        markHarvest(crop.id, crop.produceNum);
        actions.push({ kind: 'farm', request: 'FarmHarvestRequest', response: 'FarmHarvestResponse',
          body: { buildingId: [plot.buildingId] }, label: '农田收获 ' + name(crop.id) });
      }
    }
  }
  // 4. 交居民订单：材料齐就交；不齐时按开关决定要不要拒绝重刷。
  const lendable = id => {
    if (!weeklyIncomplete) return 0;
    const cargoOverlap = Math.max(0, (survey.cargoOrder?.get(id) ?? 0) - (cargoHeld.get(id) ?? 0));
    return Math.max(0, (weeklyHeld.get(id) ?? 0) - cargoOverlap);
  };
  let residentPlanned = 0;
  for (const order of survey.orders) {
    const label = `${order.workerName || '未知居民'}的订单 #${order.index}`;
    const decision = (status, reason, shortages = []) => {
      const harvestNeeds = shortages.filter(item => item.missing > 0)
        .map(({ id, missing }) => ({ id, missing }));
      orderDecisions.push({ index: order.index, status, reason, shortages, harvestNeeds });
      if (status !== 'ready' && status !== 'disabled') notes.push(label + ' ' + reason);
    };
    // v74 ignores the previous order's requirements while its slot is refreshing.
    if (order.refreshTime) { decision('refreshing', '订单刷新中，等待新需求'); continue; }
    if (order.orderKey === null) { decision('unknown', order.refreshPending?'上次手动换单结果待确认，等待服务器更新':'服务器返回重复的订单槽位，请刷新后再试'); continue; }
    if (survey.orderCheckError || !order.requirements.length || order.requirements.some(r => !r.id || !(r.num > 0))) {
      decision('unknown', survey.orderCheckError || '尚未收到完整订单需求');
      continue;
    }
    const countBefore = Math.max(Number(survey.orderOfTheDay?.orderNum ?? 0), Number(usage.counters?.residentOrders ?? 0));
    const filter = residentFilter(order, { ...survey, available: id => Math.max(0, free(id) + lendable(id)), cropIds: survey.cropIds ?? new Set(rowsOf(config, 'FarmlandPlantCfg').map(row => row.id)),
      orderOfTheDay: { ...survey.orderOfTheDay, orderNum: countBefore + residentPlanned } }, settings, usage);
    if (filter) {
      decision('filtered', filter);
      if (settings?.resident.enabled && settings.resident.reroll && enabled('denyOrder') && !filter.includes('上限') && (survey.player?.level ?? 0) >= 12) {
        actions.push({ kind: 'denyOrder', request: 'DenyOrderRequest', response: null, body: { index: order.index }, orderKey: order.orderKey,
          label: `刷新${label}：${filter}` });
      }
      continue;
    }
    const shortages = order.requirements.filter(r => free(r.id) < r.num).map(({ id, num }) => {
      const owned = have(id), available = Math.max(0, free(id));
      const weeklyReserved = weeklyHeld.get(id) ?? 0, cargoReserved = cargoHeld.get(id) ?? 0;
      const canBorrow = Math.min(num - available, lendable(id));
      return { id, name: name(id), required: num, owned, available, weeklyReserved, cargoReserved,
        allocated: owned - available - weeklyReserved - cargoReserved, ...(canBorrow ? { canBorrow } : {}),
        missing: num - available - canBorrow };
    });
    // A material may already be fully held for the week, so cargoHeld alone
    // does not cover the ship's outstanding demand when reallocating it.
    const canYield = weeklyIncomplete && shortages.every(item => item.missing === 0);
    if (!shortages.length || canYield) {
      if (!enabled('finishOrder')) { decision('disabled', '材料已齐，自动交居民订单未开启'); continue; }
      const weeklyBorrowed = shortages.map(({ id, canBorrow }) => ({ id, num: canBorrow }));
      const borrowedText = weeklyBorrowed.map(item => name(item.id) + ' ×' + item.num).join('、');
      decision('ready', borrowedText ? '周订单尚缺材料，先交居民订单，周订单待补 ' + borrowedText : '材料已齐，可交单');
      for (const { id, num } of weeklyBorrowed) {
        weeklyHeld.set(id, weeklyHeld.get(id) - num);
        reserve(id, -num);
        borrowedTotals.set(id, (borrowedTotals.get(id) ?? 0) + num);
      }
      for (const r of order.requirements) reserve(r.id, r.num);
      actions.push({
        kind: 'finishOrder',
        request: 'FinishWorkerOrderRequest',
        response: 'FinishWorkerOrderResponse',
        body: { index: order.index },
        costs: order.requirements,
        counters: { residentOrders: 1 },
        counterMinimums: { residentOrders: Number(survey.orderOfTheDay?.orderNum ?? 0) },
        weeklyBorrowed,
        orderKey: order.orderKey, requirements: order.requirements, workerId: order.workerId, textId: order.textId,
        label: `交付${label}${order.rewardExp == null ? '' : `（经验 ${order.rewardExp}）`}` +
          (borrowedText ? '；周订单待补 ' + borrowedText : ''),
      });
      residentPlanned++;
      continue;
    }
    const short = shortages.map(item => {
      const holds = [];
      if (item.weeklyReserved) holds.push('周订单预留 ' + item.weeklyReserved);
      if (item.cargoReserved) holds.push('贸易港预留 ' + item.cargoReserved);
      const cargoOverlap = Math.min(item.weeklyReserved, (survey.cargoOrder?.get(item.id) ?? 0) - item.cargoReserved);
      if (weeklyIncomplete && cargoOverlap > 0) holds.push('其中贸易港也需 ' + cargoOverlap);
      if (item.allocated) holds.push('本轮其他操作占用 ' + item.allocated);
      const limited = item.weeklyReserved > 0 && survey.stockCap > 0
        && item.weeklyReserved + item.required > survey.stockCap
        && rowsOf(config, 'BuildingProduceCfg').some(row => row.itemId === item.id);
      return item.name + '需 ' + item.required + '，库存 ' + item.owned
        + (holds.length ? '（' + holds.join('、') + '）' : '')
        + (item.canBorrow ? '，整单材料齐后可从周订单临时使用 ' + item.canBorrow : holds.length ? '，可用 ' + item.available : '')
        + (item.missing ? '，缺 ' + item.missing : '')
        + (item.missing && limited ? '；加工品存量上限 ' + survey.stockCap : '');
    }).join('；');
    if (shortages.every(item => item.owned >= item.required)) {
      const holdReason = !weeklyIncomplete && shortages.some(item => item.weeklyReserved) ? '周订单材料已齐，保留待玩家交单：' : '材料已预留：';
      decision('reserved', holdReason + short, shortages);
    } else if (enabled('finishOrder') && shortages.every(item => (dueHarvest.get(item.id) ?? 0) >= item.missing)) {
      decision('missing', '等待本轮收货后复查：' + short, shortages);
    } else if (allowReroll && enabled('denyOrder') && (minOrderExp === null || (order.rewardExp ?? 0) < minOrderExp)) {
      decision('reroll', '材料不足，将拒单重刷：' + short, shortages);
      actions.push({
        kind: 'denyOrder',
        request: 'DenyOrderRequest',
        response: null,
        body: { index: order.index },
        orderKey: order.orderKey,
        label: `拒绝${label}（材料不足：${short}）`,
      });
    } else {
      decision('missing', '材料不足：' + short, shortages);
    }
  }

  // 5. 排产：按需求补料；原生自动目标仅在协同开关开启时调整，保留正在生产项。
  if (borrowedTotals.size) creditExistingProduction();
  const demand = new Map();
  for (const [i, order] of survey.orders.entries()) {
    if (!['reserved', 'missing', 'disabled'].includes(orderDecisions[i].status)) continue;
    for (const item of order.requirements) demand.set(item.id, (demand.get(item.id) ?? 0) + item.num);
  }
  for (const [id, required] of demand) {
    demand.set(id, Math.max(0, required - free(id) - lendable(id) - (incomingForResidents.get(id) ?? 0)));
  }
  const buildingSupplies = [];
  if (settings?.building.supply && enabled('buildSupply')) for (const b of survey.buildings) {
    if (!b.type || blockedBuilding(b) || b.buildStartTime || b.buildFinishTime || (b.level === 0 ? !settings.building.build : !settings.building.upgrade)) continue;
    const row = b.level === 0 ? unlocks.get(b.buildingId) : upgradeRow(config, b.type, b.level + 1);
    if (!row || row.playerLevel > (survey.player?.level ?? 1) || row.curPeople > survey.population) continue;
    const unmet = b.level === 0 ? (row.condition ?? []).some(([id, lv]) => (levels.get(id) ?? 0) < lv)
      : (row.condition ?? []).some(([type, lv]) => (typeLevels.get(type) ?? 0) < lv);
    if (unmet) continue;
    const costs = (row.consume ?? []).map(([id, num]) => ({ id, num: Number(num) }));
    const missing = costs.filter(item => free(item.id) < item.num);
    if (missing.length && missing.every(item => craftable.has(item.id))) buildingSupplies.push({ source: 'building', requirements: costs });
  }
  const independentSources = settings?.alliance?.enabled ? [
    ...(settings.alliance.recruit && settings.alliance.recruitProduction ? ['guildRecruit'] : []),
    ...(settings.guildShip?.enabled && settings.guildShip.produceMissing ? ['guildShip'] : []),
  ] : [];
  const demandPriority = settings ? [...new Set([...settings.factory.demandPriority, ...independentSources])] : [];
  const detailedNeeds = settings ? settingDemands(survey, config, [
    { source: 'merchant', requirements: [...(survey.weekOrder ?? [])].map(([id, num]) => ({ id, num })) },
    { source: 'cargo', requirements: [...(survey.cargoOrder ?? [])].map(([id, num]) => ({ id, num })) },
    ...survey.orders.filter((order, i) => ['reserved', 'missing', 'disabled'].includes(orderDecisions[i]?.status))
      .map(order => ({ source: 'resident', requirements: order.requirements })),
    ...buildingSupplies,
    ...extraDemand,
  ], demandPriority) : null;
  const productionNeeded = id => (detailedNeeds?.get(id)?.num ?? 0) > 0 && (settings?.factory.demandFirst ||
    detailedNeeds.get(id).sources.some(source => independentSources.includes(source)));
  if(detailedNeeds)for(const crop of rowsOf(config,'FarmlandPlantCfg')) {const need=detailedNeeds.get(crop.id),seed=detailedNeeds.get(crop.material?.[0]);if(need?.num>0 && seed?.num>0)notes.push('生产依赖：缺'+name(crop.id)+' '+need.num+' → 缺'+name(crop.material[0])+' '+seed.num+' → 种子厂按需求补产'+(settings.factory.cooperateNative?'（已允许调整原生自动目标）':'（原生协同尚未开启）'));}
  if (enabled('farm') && settings && survey.autoFarming && (settings.farm.customPlant || !settings.farm.autoPlant)) {
    actions.push({ kind: 'farm', request: 'SetAutoFarmingRequest', response: null, body: { isOn: false }, label: '暂停游戏内自动种植，应用当前种植设置' });
  }
  if (enabled('farm') && !survey.autoFarming && (!settings || settings.farm.autoPlant || settings.farm.customPlant)) {
    const crops = rowsOf(config, 'FarmlandPlantCfg');
    const planted = new Map();
    const plots = survey.buildings.filter(b => b.type === '农田' && b.level > 0 && !b.buildStartTime && !b.buildFinishTime);
    for (const b of plots) {
      const crop = crops.find(r => r.id === b.farm?.productId);
      if (!crop) continue;
      planted.set(crop.id, (planted.get(crop.id) ?? 0) + crop.produceNum);
    }
    const custom = settings?.farm.customPlant ? new Map(settings.farm.crops.map((row, priority) => [row.id, { ...row, priority }])) : null;
    const shortage = id => Math.max(0, (custom ? (custom.get(id)?.target ?? 0) - have(id) : settings ? detailedNeeds.get(id)?.num ?? 0 : (weeklyGap.get(id) ?? 0) + (demand.get(id) ?? 0)) - (planted.get(id) ?? 0));
    const projected = id => have(id) + (planted.get(id) ?? 0);
    for (const crop of crops) {
      if (shortage(crop.id) > 0 && free(crop.material[0]) < crop.material[1])
        notes.push(name(crop.id) + ' 订单缺 ' + shortage(crop.id) + '，种植需要' + name(crop.material[0]));
    }
    for (const b of plots.filter(b => !b.farm?.productId)) {
      const choices = crops.filter(r => free(r.material[0]) >= r.material[1]
        && projected(r.id) < survey.stockCap * 5 && (custom ? custom.has(r.id) && shortage(r.id) > 0 : settings || !weeklyGap.has(r.id) || shortage(r.id) > 0));
      choices.sort((a, b) => (custom ? custom.get(a.id).priority - custom.get(b.id).priority : 0)
        || shortage(b.id) - shortage(a.id) || projected(a.id) - projected(b.id) || a.time - b.time);
      const crop = choices[0];
      if (!crop) continue;
      reserve(crop.material[0], crop.material[1]);
      const need = shortage(crop.id);
      planted.set(crop.id, (planted.get(crop.id) ?? 0) + crop.produceNum);
      actions.push({ kind: 'farm', request: 'FarmPlantRequest', response: 'OkResponse',
        body: { args: [{ buildingId: b.buildingId, productId: crop.id }] },
        costs: [{ id: crop.material[0], num: crop.material[1] }],
        label: '农田播种 ' + name(crop.id) + (need ? '（订单缺 ' + need + '）' : ''),
      });
    }
  }
  const incoming = new Map();
  const addIncoming = (id, num) => incoming.set(id, (incoming.get(id) ?? 0) + num);
  const projectedStock = id => have(id) + (incoming.get(id) ?? 0) - (borrowedTotals.get(id) ?? 0);
  const replacementJobs = new Map();
  for (const { factory } of survey.factories) {
    for (const job of factory.factoryQ ?? []) addIncoming(job.productId, 1);
    for (const item of factory.finishedProducts ?? []) addIncoming(item.id, Number(item.num));
  }
  const factoryReasons = new Map();
  const constructionGap = id => buildMaterials.has(id)
    ? Math.max(0, buildMaterials.get(id).num - free(id) - (incoming.get(id) ?? 0)) : 0;
  for (const b of survey.factories) {
    if (!enabled('startProduce')) break;
    if (blockedFactory(b)) { factoryReasons.set(b.buildingId, '已在设置中禁用此工厂'); continue; }
    if (b.factory.autoProductId && (survey.autoProduceForever || survey.autoProduceEndTime > (survey.serverNow ?? now))) {
      const desired = settings?.factory.cooperateNative ? produceRows.filter(row =>
        row.buildType === b.type && row.unlockLevel <= b.level && productionNeeded(row.itemId) && projectedStock(row.itemId) < survey.stockCap) : [];
      const choices = desired.filter(row => (row.costItem ?? []).every(([id,n]) => free(id) >= n));
      const shortages=desired.filter(row=>!choices.includes(row)).map(row=>name(row.itemId)+'：'+(row.costItem??[]).filter(([id,n])=>free(id)<n).map(([id,n])=>name(id)+'需'+n+'，可用'+free(id)+'，缺'+(n-free(id))).join('；'));
      if(shortages.length)notes.push(buildingName(b)+'原生协同等待原料：'+shortages.join('；'));
      const bFactoryTarget = b.factory.autoProductId;
      choices.sort((a,b) => detailedNeeds.get(a.itemId).priority - detailedNeeds.get(b.itemId).priority ||
        Number(b.itemId === bFactoryTarget) - Number(a.itemId === bFactoryTarget) || detailedNeeds.get(b.itemId).num - detailedNeeds.get(a.itemId).num);
      const best = choices[0];
      if (best && best.itemId !== b.factory.autoProductId) {
        actions.push({kind:'startProduce',request:'SetFactoryAutoProduceRequest',response:null,
          body:{buildingId:b.buildingId,productId:best.itemId},previousProduct:b.factory.autoProductId,eligibilityKey:factoryRecipeAvailability(best,survey.festivals,survey.serverNow??now).signature+':'+b.level,
          label:buildingName(b)+'：原生自动目标改为'+name(best.itemId)+'，保留当前生产队列',costs:[]});
        factoryReasons.set(b.buildingId,'按需求调整原生自动目标，当前队列继续完成');
      } else factoryReasons.set(b.buildingId, '游戏自动生产 '+name(b.factory.autoProductId)+(settings?.factory.cooperateNative?(shortages.length?'；等待所需原料':'；当前目标无需调整或需求已在产'):'；需求协同未开启'));
      continue;
    }
    if (settings && !settings.factory.produce) {factoryReasons.set(b.buildingId,'普通排产关闭；原生协同只调整已开启的自动目标');continue;}
    const queue = b.factory.factoryQ ?? [];
    if (queue.length >= survey.factorySlots) continue;
    for (let slot = queue.length; slot < survey.factorySlots; slot++) {
      const reasons = [];
      const cand = produceRows.filter(row => {
        if (row.buildType !== b.type || row.unlockLevel > b.level) return false;
        const id = row.itemId;
        let reason;
        if (projectedStock(id) >= survey.stockCap)
          reason = '库存、待收和在产合计已达 ' + survey.stockCap;
        else if (settings && projectedStock(id) >= settings.factory.keepStock && !productionNeeded(id))
          reason = '已达到设置的备货水位 ' + settings.factory.keepStock;
        else {
          const missing = (row.costItem ?? []).filter(([item, n]) => free(item) < n);
          if (missing.length) reason = missing.map(([item, n]) => name(item) + '需要 ' + n + '，可用 ' + free(item)).join('；');
        }
        if (reason) reasons.push(name(id) + '：' + reason);
        return !reason;
      });
      if (!cand.length) {
        factoryReasons.set(b.buildingId, reasons.join('；') || unavailableRecipes.get(b.type) || '当前等级没有已解锁的生产配方');
        break;
      }
      const customRank = row => productionNeeded(row.itemId) ? detailedNeeds.get(row.itemId).priority : Infinity;
      const compareCustom = (a, b) => customRank(a) - customRank(b)
        || (settings.factory.demandFirst ? (detailedNeeds.get(b.itemId)?.num ?? 0) - (detailedNeeds.get(a.itemId)?.num ?? 0) : 0)
        || projectedStock(a.itemId) - projectedStock(b.itemId) || a.produceTime - b.produceTime;
      const best = cand.sort(settings ? compareCustom : (a, b2) => (weeklyGap.get(b2.itemId) ?? 0) - (weeklyGap.get(a.itemId) ?? 0)
        || (cargoGap.get(b2.itemId) ?? 0) - (cargoGap.get(a.itemId) ?? 0)
        || (demand.get(b2.itemId) ?? 0) - (demand.get(a.itemId) ?? 0)
        || constructionGap(b2.itemId) - constructionGap(a.itemId)
        || projectedStock(a.itemId) - projectedStock(b2.itemId)
        || a.produceTime - b2.produceTime)[0];
      for (const [id, n] of best.costItem ?? []) reserve(id, n);
      const need = demand.get(best.itemId) ?? 0;
      const weeklyNeed = weeklyGap.get(best.itemId) ?? 0;
      const cargoNeed = cargoGap.get(best.itemId) ?? 0;
      const buildNeed = constructionGap(best.itemId);
      const projected = projectedStock(best.itemId);
      // The account may already be at its storage limit. Only run a dependent
      // job after enough resident deliveries have actually freed that stock.
      let needsConfirmedBorrow = Math.max(0, have(best.itemId) + (incoming.get(best.itemId) ?? 0) + 1 - survey.stockCap);
      const initialNeed = initialWeeklyGap.get(best.itemId) ?? 0;
      if (weeklyNeed && initialNeed) initialWeeklyGap.set(best.itemId, initialNeed - 1);
      else if (weeklyNeed && borrowedTotals.has(best.itemId)) {
        const replacement = (replacementJobs.get(best.itemId) ?? 0) + 1;
        replacementJobs.set(best.itemId, replacement);
        needsConfirmedBorrow = Math.max(needsConfirmedBorrow, replacement);
      }
      addIncoming(best.itemId, 1);
      if (detailedNeeds?.has(best.itemId)) {
        const need = detailedNeeds.get(best.itemId);
        need.num = Math.max(0, need.num - 1);
        const source = demandPriority.find(source => (need.productionBySource[source] ?? 0) > 0);
        if (source) need.productionBySource[source]--;
        need.priority = demandPriority.findIndex(source => (need.productionBySource[source] ?? 0) > 0);
        if (need.priority < 0) need.priority = Infinity;
      }
      if (need > 0 && !weeklyNeed && !cargoNeed) demand.set(best.itemId, need - 1);
      credit(best.itemId, 1);
      const displayFactory = buildingName(b);
      const displayProduct = name(best.itemId);
      const reason = weeklyNeed ? `周订单缺 ${weeklyNeed} 件` + (needsConfirmedBorrow ? '，居民交单后补回' : '') : cargoNeed ? `贸易港缺 ${cargoNeed} 件`
        : need ? `居民订单缺 ${need} 件` : buildNeed ? `${buildMaterials.get(best.itemId).name}建造缺 ${buildNeed} 件` : `补库存，排入后预计共 ${projected + 1} 件（含待收和在产）`;
      actions.push({
        kind: 'startProduce',
        request: 'StartFactoryProduceRequest',
        response: null,
        body: { buildingId: b.buildingId, productId: best.itemId },
        eligibilityKey:factoryRecipeAvailability(best,survey.festivals,survey.serverNow??now).signature+':'+b.level,
        costs: (best.costItem ?? []).map(([id, num]) => ({ id, num: Number(num) })),
        ...(needsConfirmedBorrow ? { needsConfirmedBorrow } : {}),
        displayFactory, displayProduct,
        label: `${displayFactory}安排生产${displayProduct} 1 件，耗时 ${durationText(best.produceTime)}。${reason}`,
      });
    }
  }

  // 6. 余料升级建筑：把订单与排产占用的材料扣掉之后再比升级消耗，按人口需求升序（便宜的先生效）。
  planUpgrades(false);

  function planUpgrades(priority) {
    const upgrades = [];
    for (const b of survey.buildings) {
      if (blockedBuilding(b)) continue;
      const target = factoryTargets.get(b.type);
      const forOrder = target?.buildingId === b.buildingId && b.level < target.required;
      if (forOrder !== priority || (!priority && !enabled('upgrade'))) continue;
      if (b.level <= 0) continue;
      if (!b.type) { upgradeReasons.push(buildingName(b) + '未找到建筑类型'); continue; }
      if (b.buildStartTime > 0 || b.buildFinishTime > 0) {
        upgradeReasons.push(buildingName(b) + '已有施工任务，本轮先检查竣工'); continue;
      }
      const next = b.level + 1;
      const row = upgradeRow(config, b.type, next);
      if (!row) {
        const max = topLevel(config, b.type);
        upgradeReasons.push(buildingName(b) + (max && b.level >= max ? '已达最高 ' + max + ' 级' : '缺少下一级配置'));
        continue;
      }
      const unmet = (row.condition ?? []).find(([type, lv]) => (typeLevels.get(type) ?? 0) < lv);
      if (unmet) {
        const prerequisite = rowsOf(config, 'BuildingCfg').find(cfg => cfg.buildingType === unmet[0])?.name || unmet[0];
        upgradeReasons.push(`${buildingName(b)}需要${prerequisite}达到 ${unmet[1]} 级`);
        continue;
      }
      if (row.playerLevel > (survey.player?.level ?? 1)) { upgradeReasons.push(buildingName(b) + '需要角色 ' + row.playerLevel + ' 级'); continue; }
      if (row.curPeople > survey.population) { upgradeReasons.push(buildingName(b) + '需要人口 ' + row.curPeople + '，当前 ' + survey.population); continue; }
      const consume = (row.consume ?? []).map(([id, num]) => ({ id, num: Number(num) }));
      const gain = Math.max(0, sumEffect(row.effect, '人口增加') - (b.population ?? 0));
      upgrades.push({ building: b, row, consume, gain, costTime: row.costTime ?? 0 });
    }
    upgrades.sort((a, b) => a.row.curPeople - b.row.curPeople || a.costTime - b.costTime);
    for (const u of upgrades) {
      if (upgradeCount >= maxUpgrades) {
        notes.push(`${buildingName(u.building)} 本轮升级额度用完，下一轮再升`);
        continue;
      }
      if (u.gain && plannedPopulation + u.gain > survey.maxPopulation) {
        upgradeReasons.push(buildingName(u.building) + '升级后人口超过上限 ' + survey.maxPopulation);
        continue;
      }
      const short = u.consume.filter(c => free(c.id) < c.num);
      if (short.length) {
        upgradeReasons.push(buildingName(u.building) + '缺' + short.map(c => name(c.id) + ' ×' + (c.num - free(c.id))).join('、'));
        continue;
      }
      upgradeCount++;
      plannedPopulation += u.gain;
      for (const c of u.consume) reserve(c.id, c.num);
      actions.push({
        kind: priority ? 'weekFactory' : 'upgrade',
        request: 'UpgradeBuildingRequest',
        response: null,
        body: { buildingId: u.building.buildingId },
        costs: u.consume,
        label: `${buildingName(u.building)}从 ${u.building.level} 级升至 ${u.building.level + 1} 级（耗时 ${durationText(u.costTime)}，需要 ${u.row.curPeople} 人）`
          + (priority ? `，周订单需要 ${factoryTargets.get(u.building.type).required} 级` : ''),
      });
    }
  }

  // 7. 加速：只花「加速器」，而且只对真的在等的建造/生产用。
  if (allowSpeedUp || (settings?.farm.enabled && settings.farm.speedUp)) {
    const speeders = Number(have(SPEED_UP_ITEM));
    let left = Math.max(0, speeders - resourceReserve(settings, SPEED_UP_ITEM));
    for (const b of survey.buildings) {
      if (settings && !enabled('speedUpUpgrade')) continue;
      if (b.buildFinishTime <= now) continue;
      const minutes = Math.ceil((b.buildFinishTime - now) / 60);
      if (minutes <= 0 || left <= 0) continue;
      const useNum = Math.max(1, Math.min(minutes, left));
      left -= useNum;
      actions.push({
        kind: 'speedUpUpgrade',
        request: 'SpeedUpUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
        costs: [{ id: SPEED_UP_ITEM, num: useNum }],
        label: `使用 ${useNum} 个${name(SPEED_UP_ITEM)}加速${buildingName(b)}施工`,
      });
    }
    for (const b of survey.factories) {
      if (settings && (!enabled('speedUpProduce') || blockedFactory(b))) continue;
      for (const job of b.factory.factoryQ ?? []) {
        if (settings) {
          const specific = settings.factory.speedUp && (!settings.factory.speedUpItems.length || settings.factory.speedUpItems.includes(job.productId));
          const need = detailedNeeds.get(job.productId);
          if (!specific && !(need?.unfilled > 0 && need.sources.some(source => settings.factory.speedUpSources.includes(source)))) continue;
        }
        if (job.finishTime <= now || left <= 0) continue;
        const minutes = Math.ceil((job.finishTime - now) / 60);
        if (minutes <= 0) continue;
        const useNum = Math.max(1, Math.min(minutes, left));
        left -= useNum;
        actions.push({
          kind: 'speedUpProduce',
          request: 'SpeedUpFactoryProduceRequest',
          response: null,
          body: { buildingId: b.buildingId, index: job.idx, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
          costs: [{ id: SPEED_UP_ITEM, num: useNum }],
          label: `使用 ${useNum} 个${name(SPEED_UP_ITEM)}加速${buildingName(b)}生产`,
        });
      }
    }
    if (settings?.farm.enabled && settings.farm.speedUp && enabled('farm')) {
      for (const b of survey.buildings) {
        if (!(b.farm?.ripeTime > (survey.serverNow ?? now)) || left <= 0) continue;
        const goal = settings.farm.customPlant ? settings.farm.crops.find(c => c.id === b.farm.productId)?.target ?? 0 : (detailedNeeds.get(b.farm.productId)?.unfilled ?? 0) + have(b.farm.productId);
        if (goal <= have(b.farm.productId)) continue;
        const useNum = Math.min(left, Math.ceil((b.farm.ripeTime - (survey.serverNow ?? now)) / 60));
        left -= useNum;
        actions.push({ kind: 'farm', request: 'FarmSpeedUpRequest', response: null, body: { buildingId: b.buildingId, param: { type: SPEED_UP_ITEM_TYPE, useNum } },
          costs: [{ id: SPEED_UP_ITEM, num: useNum }], label: `使用 ${useNum} 个加速器催熟${name(b.farm.productId)}` });
      }
    }
    if (left === speeders) notes.push(`${SPEED_UP_ITEM} 有 ${speeders} 个，但没有等待中的建造或生产`);
  }

  return { actions, notes, factoryReasons, upgradeReasons, orderDecisions, demands: detailedNeeds ? [...detailedNeeds].map(([id, need]) => ({ id, ...need })) : [], reserved: [...reserved].filter(([, n]) => n > 0) };
}

export function settingDemands(survey, config, records, priority) {
  const result = new Map();
  const recipes = new Map(rowsOf(config, 'BuildingProduceCfg').map(row => [row.itemId, row]));
  const crops = new Map(rowsOf(config, 'FarmlandPlantCfg').map(row => [row.id, row]));
  const incoming = new Map();
  const finished = new Map();
  for (const b of survey.factories) {
    for (const job of b.factory.factoryQ ?? []) incoming.set(job.productId, (incoming.get(job.productId) ?? 0) + 1);
    for (const item of b.factory.finishedProducts ?? []) finished.set(item.id, (finished.get(item.id) ?? 0) + Number(item.num));
  }
  for (const b of survey.buildings ?? []) {
    const crop = crops.get(b.farm?.productId);
    if (crop) incoming.set(crop.id, (incoming.get(crop.id) ?? 0) + crop.produceNum);
  }
  const add = (source, id, count, seen = new Set()) => {
    if (!id || !Number.isFinite(count) || count <= 0 || seen.has(id)) return;
    const previous = result.get(id);
    const required = (previous?.required ?? 0) + count;
    const unfilled = Math.max(0, required - survey.have(id) - (finished.get(id) ?? 0));
    const num = Math.max(0, unfilled - (incoming.get(id) ?? 0));
    const extra = Math.max(0, num - (previous?.num ?? 0));
    const immediate = Math.max(0, unfilled - (previous?.unfilled ?? 0));
    const productionBySource = { ...previous?.productionBySource };
    if (extra > 0) productionBySource[source] = (productionBySource[source] ?? 0) + extra;
    result.set(id, { required, unfilled, num, priority: Math.min(previous?.priority ?? Infinity, extra > 0 ? priority.indexOf(source) : Infinity),
      sources: [...new Set([...(previous?.sources ?? []), ...(immediate > 0 ? [source] : [])])], productionBySource });
    for (const [material, amount] of recipes.get(id)?.costItem ?? []) add(source, material, extra * Number(amount), new Set([...seen, id]));
    const crop = crops.get(id);
    if (crop?.produceNum > 0 && extra > 0) add(source, crop.material[0], Math.ceil(extra / crop.produceNum) * crop.material[1], new Set([...seen,id]));
  };
  const orderedRecords = priority.flatMap(source => records.filter(row => row.source === source));
  const reservationSources = new Set(['merchant', 'cargo', 'resident']);
  const reservedIds = new Set(orderedRecords.flatMap(record => (record.reserved ?? [])
    .filter(item => item.id && Number.isFinite(Number(item.num)) && Number(item.num) > 0).map(item => item.id)));
  const coveredReserve = new Map();
  // 招募/商船持有的是同一批订单预留，不是额外消费。先计入已选择的订单用量，
  // 让库存优先抵扣被保护的订单，独立补料仍归属于招募/商船自身。
  for (const record of orderedRecords) if (reservationSources.has(record.source)) for (const item of record.requirements ?? []) {
    const count = Number(item.num);
    if (!reservedIds.has(item.id) || !Number.isFinite(count) || count <= 0) continue;
    add(record.source, item.id, count);
    coveredReserve.set(item.id, (coveredReserve.get(item.id) ?? 0) + count);
  }
  for (const record of orderedRecords) {
    const missingReserve = new Map();
    for (const item of record.reserved ?? []) {
      const count = Number(item.num), covered = coveredReserve.get(item.id) ?? 0;
      if (!item.id || !Number.isFinite(count) || count <= covered) continue;
      // 未选择的订单来源仍保护库存；多个消费者只补齐一次共同预留水位。
      missingReserve.set(item.id, (missingReserve.get(item.id) ?? 0) + count - covered);
      coveredReserve.set(item.id, count);
    }
    for (const item of record.requirements ?? []) {
      if (reservationSources.has(record.source) && reservedIds.has(item.id)) continue;
      const count = Number(item.num);
      if (!Number.isFinite(count) || count <= 0) continue;
      // 同一记录合并补齐的水位后再展开配方，避免作物种子分别向上取整。
      add(record.source, item.id, count + (missingReserve.get(item.id) ?? 0));
      missingReserve.delete(item.id);
    }
    for (const [id, count] of missingReserve) add(record.source, id, count);
  }
  return result;
}

export function stepKey(step) {
  const target = step.body?.buildingId ?? step.body?.index ?? '';
  return `${step.kind}:${Array.isArray(target) ? target.join('+') : target}`;
}

const lastOrderSent = new WeakMap();
const nativeTargetChecks = new WeakMap();

// A collection request alone is not proof that the stock increased. Check the
// actual reward before spending another set of reads on affected resident slots.
export function orderSlotsAfterHarvest(plan, results, attempted) {
  const gained = new Map();
  for (const { step, ok, body } of results) {
    if (!ok || !body || !(step.kind === 'gainFactory' || step.kind === 'collectProduct' || step.request === 'FarmHarvestRequest')) continue;
    const reply = normalize(body);
    let assets;
    if (step.kind === 'gainFactory') assets = reply.products?.asset;
    else if (step.kind === 'collectProduct') assets = reply.reward?.flatMap(row => row.product?.asset ?? []);
    else if (step.request === 'FarmHarvestRequest') assets = reply.reward?.map(item => item.reward).filter(Boolean);
    for (const asset of assets ?? []) if (asset.num > 0) gained.set(asset.id, (gained.get(asset.id) ?? 0) + asset.num);
  }
  return new Set(plan.orderDecisions.filter(d => {
    const needs = d.harvestNeeds ?? d.shortages;
    return !attempted.has(d.index) && needs.length && needs.every(row => (gained.get(row.id) ?? 0) >= row.missing);
  }).map(d => d.index));
}

export async function runWorldRound(client, protocol, plan, {
  config, player, cargoEnabled = () => false, attemptedOrders = new Set(),
  finishEnabled, ...options
}) {
  const execution = { ...options, config, player, cargoEnabled };
  const result = await runWorld(client, protocol, plan, execution);
  const canFinish = finishEnabled ?? (() => !options.enabled || options.enabled('finishOrder'));
  for (const { step } of result.results) {
    if (step.kind === 'finishOrder' || step.kind === 'denyOrder') attemptedOrders.add(step.body.index);
  }
  result.followupCount = 0;
  if (!canFinish()) return result;
  const slots = orderSlotsAfterHarvest(plan, result.results, attemptedOrders);
  if (!slots.size) return result;
  try {
    const includeCargo = cargoEnabled();
    const survey = await surveyWorld(client, protocol, { config, player, ordersOnly: true, includeCargo });
    const allow = kind => kind === 'finishOrder' && canFinish() && (includeCargo || !cargoEnabled());
    if (!allow('finishOrder')) return result;
    if (survey.orderCheckError) throw new Error(survey.orderCheckError);
    survey.orders = survey.orders.filter(order => slots.has(order.index));
    const followup = planWorld(survey, { config, enabled: allow, settings: options.getSettings?.() ?? options.settings,
      usage: options.getUsage?.() ?? options.usage });
    const { results } = await runWorld(client, protocol, followup, { ...execution, enabled: allow });
    for (const { step } of results) attemptedOrders.add(step.body.index);
    result.followupCount = results.length;
    result.results.push(...results);
  } catch (error) {
    if (canFinish()) {
      const entry = { step: { kind: 'checkResidentOrders', label: '收货后核对居民订单' }, ok: false, error: error.message };
      result.followupCount = 1;
      result.results.push(entry);
      options.onStep?.(entry);
    }
  }
  return result;
}

// A harvest earlier in this round can complete the weekly order. Do not spend
// its stock based solely on a plan that was made before the harvest.
async function confirmResidentOrder(client, protocol, step, config, player, cargoEnabled, settings, usage) {
  if (!config || !player) return { reason: '无法复核周订单和贸易港预留' };
  const includeCargo = cargoEnabled();
  const survey = await surveyWorld(client, protocol, { config, player, ordersOnly: true, includeCargo });
  if (survey.orderCheckError) return { reason: survey.orderCheckError };
  const order = survey.orders.find(row => row.index === step.body.index);
  if (!order || (step.orderKey && order.orderKey !== step.orderKey)) return { reason: '这条居民订单已刷新或已处理，请查看当前订单' };
  if (!step.manualCheck && (order.workerId !== step.workerId || order.textId !== step.textId ||
    order.requirements.length !== step.requirements.length ||
    !order.requirements.every(item => step.requirements.some(old => item.id === old.id && item.num === old.num)))) {
    return { reason: '订单需求已刷新，留待下一轮重新安排' };
  }
  const fresh = planWorld({ ...survey, orders: [order] }, { config, enabled: kind => kind === 'finishOrder', settings: step.manualCheck ? null : settings, usage });
  const current = fresh.actions.find(action => action.kind === 'finishOrder');
  if (!current) return { reason: fresh.orderDecisions[0].reason };
  if ((!includeCargo && cargoEnabled()) || (!step.manualCheck && current.weeklyBorrowed.some(item =>
    item.num > (step.weeklyBorrowed.find(old => old.id === item.id)?.num ?? 0)))) {
    return { reason: '订单预留已变化，请重新核对库存' };
  }
  return { action: current };
}

// 手动换单只处理当前显示的一单，使用原拒单协议，不付费加速刷新。
export async function rerollResidentOrder(client,protocol,{index,orderKey,config,player,ledger,enabled=()=>true}){
 if(!Number.isSafeInteger(index)||index<0||typeof orderKey!=='string'||!orderKey)throw Error('请从当前订单列表选择换单');
 if(!enabled())throw Error('账号状态已变化，已取消换单');
 if(!Number.isSafeInteger(player?.level)||player.level<12)throw Error('手动换单需要角色12级');
 const session=watchResidentRefreshes(client,ledger,player),identity=session.manualRefresh?.identity;
 if(!identity||!ledger)throw Error('换单记录或角色身份不可用');
 if(session.get(index)?.key!==orderKey)throw Error('这条订单已变化，请刷新后再选择');
 const before=await surveyWorld(client,protocol,{config,player,ordersOnly:true,includeWeekOrder:false}),order=before.orders.find(r=>r.index===index);
 if(!order||order.orderKey!==orderKey)throw Error(order?.refreshPending?'上次换单结果待确认，暂不重复提交':'这条订单已刷新或已处理');
 if(order.refreshTime>0)throw Error('订单正在刷新，等待新订单');
 if(!order.requirements?.length)throw Error('当前订单需求未同步');
 if(session.get(index)?.key!==orderKey)throw Error('这条订单已变化，请刷新后再选择');
 const signature=session.get(index)?.signature;
 const key='manual-order:'+identity+':'+index+':'+createHash('sha256').update(signature).digest('hex').slice(0,24);
 if(ledger.hasKey(key))throw Error('上次换单结果待确认，暂不重复提交');
 if(!enabled())throw Error('账号状态已变化，已取消换单');
 const ticket=ledger.reserve({},{},{},{uniqueKey:key,details:{kind:'manualOrderRefresh',identity,index,signature}});
 // 使其他持有旧页面标识的提交/换单失效，下一次读取由记录与服务器签名核对。
 session.delete(index);
 try{
  await client.sendWatch('DenyOrderRequest',{index},{window:600});
  await surveyWorld(client,protocol,{config,player,ordersOnly:true,includeWeekOrder:false});
  if(session.get(index)?.signature&&session.get(index).signature!==signature){if(ledger.hasKey(key)){ledger.confirm(ticket);ledger.releaseCompletedKey(key);}return{index,label:'居民订单 #'+index+'已换单，等待新需求',status:'confirmed'};}
  throw Error('换单请求已发送，结果待确认；请稍后刷新，暂不重复提交');
 }catch(error){if(error.prompt&&error.request==='DenyOrderRequest')ledger.cancel(ticket);throw error;}
}

export async function submitResidentOrder(client, protocol, { index, orderKey, config, player, cargoEnabled = () => false, enabled = () => true }) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 2147483647 || typeof orderKey !== 'string' || !orderKey) {
    throw new Error('请从当前居民订单列表中选择要交付的一单');
  }
  if (!enabled()) throw new Error('账号托管状态已变化，已取消手动交单');
  if (trackResidentOrders(client).get(index)?.key !== orderKey) throw new Error('这条居民订单已刷新或已处理，请查看当前订单');
  const step = { kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse',
    body: { index }, orderKey, manualCheck: true, label: '交付居民订单 #' + index };
  const { results } = await runWorld(client, protocol, { actions: [step] }, {
    config, player, allowMutate: true, cargoEnabled, enabled,
  });
  const [entry] = results;
  if (!entry?.ok) throw new Error(entry?.error || '账号托管状态已变化，已取消手动交单');
  const reward = normalize(entry.body.reward);
  const prize = reward.asset.map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
  return { index, label: '已' + entry.step.label + '，获得' + prize, reward };
}

// 逐条执行。同类动作失败就跳过该类的剩余动作；被服务端拒过的具体动作记进 rejected，
// 循环模式下后续轮次不再重发（否则每轮都会骚扰一次同一个必败请求）。
export async function runWorld(client, protocol, plan, {
  allowMutate = false,
  window = 400,
  timeout = 15000,
  rejected = new Set(),
  onStep,
  enabled = () => true,
  config, player, cargoEnabled = () => false,
  settings = null, getSettings, usage, getUsage, beforeStep, afterStep, cancelStep,
} = {}) {
  if (!allowMutate) throw new Error('海面自动化会改变账号状态，需要 --yes');
  const results = [];
  const blocked = new Set();
  const failedRecipes = new Set();
  const confirmedBorrow = new Map();
  for (const step of plan.actions) {
    if (!enabled(step.kind)) continue;
    const currentSettings = getSettings?.() ?? settings;
    if (!step.manualCheck && !worldActionAllowed(currentSettings, step, config)) {
      const entry = { step, ok: false, skipped: true, error: '此动作已在设置中关闭或禁用' };
      results.push(entry); onStep?.(entry); continue;
    }
    const key = stepKey(step);
    const resident = step.kind === 'finishOrder' || step.kind === 'denyOrder';
    const recipe = step.kind === 'startProduce' ? JSON.stringify(step.body) : null;
    if (recipe && failedRecipes.has(recipe)) continue;
    let entry;
    if (step.needsConfirmedBorrow > (confirmedBorrow.get(step.body?.productId) ?? 0)) {
      entry = { step, ok: false, skipped: true, error: '尚未确认居民订单已释放相应库存，稍后复查补产' };
    } else if (!resident && rejected.has(key)) entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
    else if (blocked.has(step.kind)) entry = { step, ok: false, skipped: true, error: `同类动作已失败，本轮不再尝试` };
    else if (!protocol[step.request]) entry = { step, ok: false, error: `协议表里没有 ${step.request}` };
    else {
      // Direct CLI calls and manual orders use the same cross-connection
      // resource barrier, while a manual order keeps its own explicit consent.
      const localGuard = step.manualCheck || !beforeStep ? createActionGuard(client,
        () => step.manualCheck ? null : getSettings?.() ?? settings, null,
        { player, enabled: () => enabled(step.kind) }) : null;
      const prepareAction = localGuard?.before ?? beforeStep;
      const finishAction = localGuard?.after ?? afterStep;
      const cancelAction = localGuard?.cancel ?? cancelStep;
      let ticket = null, prepared = false, dispatched = false, writePending = false;
      let actual = step;
      try {
        // The official client waits for a business Response for planting. Keep
        // Prompt attribution until that reply/timeout, not a short silent window.
        const response = step.request === 'FarmPlantRequest' ? 'OkResponse' : step.response;
        if (step.request === 'FarmPlantRequest' && (!protocol.OkResponse || !protocol.OnWaterRequest || !protocol.OnWaterResponse)) {
          throw new AutomationSkip('当前协议不能确认农田播种结果');
        }
        if (step.kind === 'finishOrder') {
          if (!protocol[step.response]) throw new Error('当前协议不能确认居民订单交付结果');
          // WorkerOrderPop spaces consecutive commits by at least two seconds.
          const delay = (lastOrderSent.get(client) ?? 0) + 2000 - Date.now();
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          if (!enabled(step.kind)) continue;
          if (step.manualCheck || step.weeklyBorrowed?.length || currentSettings) {
            const fresh = await confirmResidentOrder(client, protocol, step, config, player, cargoEnabled, currentSettings, getUsage?.() ?? usage);
            if (fresh.reason) {
              entry = { step, ok: false, skipped: true, error: fresh.reason };
              results.push(entry);
              onStep?.(entry);
              continue;
            }
            if (!enabled(step.kind)) continue;
            actual = fresh.action;
          }
        }
        if (['StartFactoryProduceRequest','SetFactoryAutoProduceRequest'].includes(step.request)) {
          const recipe=rowsOf(config,'BuildingProduceCfg').find(row=>row.itemId===step.body.productId);
          const gate=factoryRecipeAvailability(recipe,client.festivals,Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000));
          if(recipe&&!gate.allowed)throw new AutomationSkip(gate.reason);
          const failures=factoryFailures.get(client),failure=failures?.get(JSON.stringify([step.request,step.body]));
          if(failure&&failure.signature===step.eligibilityKey&&Date.now()<failure.until)throw new AutomationSkip('前次生产被明确拒绝，等待条件变化：'+failure.reason);
          if(failure)failures.delete(JSON.stringify([step.request,step.body]));
        }
        if (step.request === 'SetFactoryAutoProduceRequest') {
          if (!currentSettings?.factory.cooperateNative) throw new Error('原生生产协同已关闭');
          const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
          const factory = water.building?.find(b => b.buildingId === step.body.buildingId)?.factory;
          if (!factory || !(water.autoProduceForever || water.autoProduceEndTime > (Date.now()+(client.serverClockOffsetMs||0))/1000)) throw new Error('原生自动生产状态已变化，等待下轮重算');
          if (factory.autoProductId === step.body.productId) continue;
          if (factory.autoProductId !== step.previousProduct) throw new Error('自动生产目标已变化，等待下轮重算');
          const checks = nativeTargetChecks.get(client) ?? new Map(); nativeTargetChecks.set(client,checks);
          const prior = checks.get(step.body.buildingId);
          if (prior && Date.now() < prior.until) { results.push({step,skipped:true,reason:prior.pending?'前次目标调整待确认':'目标调整冷却中'}); continue; }
          checks.set(step.body.buildingId,{until:Date.now()+300000,pending:true});
        }
        ticket = await prepareAction?.(actual);
        prepared = true;
        if (!enabled(step.kind) || (!step.manualCheck && !worldActionAllowed(getSettings?.() ?? settings, actual, config))) {
          if (prepared) await cancelAction?.(actual, ticket, { notSent: true });
          if(step.request==='SetFactoryAutoProduceRequest')nativeTargetChecks.get(client)?.delete(step.body.buildingId);
          continue;
        }
        if (step.kind === 'finishOrder') lastOrderSent.set(client, Date.now());
        if (resident && actual.orderKey) {
          const session = trackResidentOrders(client);
          if (session.get(step.body.index)?.key !== actual.orderKey) throw new Error('这条居民订单已刷新或已处理，请查看当前订单');
          session.delete(step.body.index); // A lost reply can still have consumed this slot.
        }
        if (response && protocol[response]) {
          dispatched = writePending = true;
          const body = await client.request(step.request, step.body, response, timeout);
          writePending = false;
          if (step.kind === 'finishOrder' && !body?.reward?.asset?.length) throw new Error('服务端尚未返回居民订单的交付奖励');
          for (const item of actual.weeklyBorrowed ?? []) confirmedBorrow.set(item.id, (confirmedBorrow.get(item.id) ?? 0) + item.num);
          entry = { step: actual, ok: true, body };
        } else {
          // 没有配套 Response：静默即成功，回包是 PromptResponse 就是被拒。
          dispatched = writePending = true;
          const sent = await client.sendWatch(step.request, step.body, { window });
          writePending = false;
          entry = { step, ok: true, sent };
          if (step.request === 'SetFactoryAutoProduceRequest') {
            const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
            const confirmed = water.building?.find(b => b.buildingId === step.body.buildingId)?.factory?.autoProductId === step.body.productId;
            nativeTargetChecks.get(client).set(step.body.buildingId,{until:Date.now()+(confirmed?60000:300000),pending:!confirmed});
            entry = {step,ok:confirmed,status:confirmed?'confirmed':'unknown',reason:confirmed?'已回读确认自动生产目标；本次未逐项核对原队列':'目标切换结果待确认，暂不重复提交'};
          }
        }
        await finishAction?.(actual, ticket, entry);
      } catch (error) {
        // A later read/settlement failure cannot prove the completed write was unsent.
        const notSent = !dispatched || (writePending && error.notSent === true);
        if (prepared && (notSent || error.prompt && error.request === actual.request)) await cancelAction?.(actual, ticket, { notSent, error });
        if(['StartFactoryProduceRequest','SetFactoryAutoProduceRequest'].includes(step.request)&&error.prompt&&error.request===step.request){
          const failures=factoryFailures.get(client)??new Map();factoryFailures.set(client,failures);
          failures.set(JSON.stringify([step.request,step.body]),{signature:step.eligibilityKey,until:/limited item not available/i.test(error.message)?Infinity:Date.now()+300000,reason:error.message});
        }
        if(step.request==='SetFactoryAutoProduceRequest'&&(notSent||error.prompt&&error.request===step.request))nativeTargetChecks.get(client)?.delete(step.body.buildingId);
        if (recipe && error.code !== 'AUTOMATION_SKIP') failedRecipes.add(recipe);
        // Each plot has independent prerequisites. A failed build must not
        // suppress other plots, or prevent a later fresh survey from retrying it.
        if (error.code !== 'AUTOMATION_SKIP' && !resident && !['build', 'farm', 'upgrade', 'weekFactory', 'startProduce'].includes(step.kind)) {
          rejected.add(key);
          blocked.add(step.kind);
        }
        entry = { step, ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}), error: error.message };
        if (step.request === 'FarmPlantRequest' && prepared && !notSent && !(error.prompt && error.request === actual.request)) {
          entry.status = 'unknown';
          entry.reason = '播种响应未确认：' + error.message;
          await finishAction?.(actual, ticket, entry);
        }
      }
    }
    results.push(entry);
    onStep?.(entry);
    if (entry.ok) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { results, rejected, blocked: [...blocked] };
}

// --- 资源田 ------------------------------------------------------------------
//
// 「哪些 gridIdx 是田、是什么类型」不在协议里也不在 591 张配置表里，只在 CDN bundle world_map 的
// JsonAsset 里。地图首次读取时自动缓存到 work/cdn/，编码是 resType * 10000 + cityId。
// 占田（ChallengeResFieldRequest）要求「该田所属城是我方城 + 有闲置且 durability > 0 的舰队」，
// 账号没有舰队时这一步必然失败，所以本模块只做只读报告 + 显式手动占田/放弃，不做无人值守的自动占田。

export const MAP_DIR = path.resolve(import.meta.dirname, '../work/cdn');

export function mapPath(scenarioId) {
  return path.join(MAP_DIR, `world_map.world_map${scenarioId > 0 ? scenarioId : 1}.json`);
}

const mapLoads = new Map();

// 版本来自游戏包 src/settings.0afbd.json 的 assets.bundleVers.world_map。
async function fetchMap(file, scenarioId) {
  const getJson = async url => {
    const reply = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!reply.ok) throw new Error('地图下载失败（HTTP ' + reply.status + '）');
    return reply.json();
  };
  const cfg = await getJson(SERVER + 'remote/world_map/config.2ca75.json');
  const entry = Object.entries(cfg.paths).find(([, row]) => row[0] === 'world_map' + scenarioId && cfg.types[row[1]] === 'cc.JsonAsset');
  if (!entry) throw new Error('游戏资源中没有场景 ' + scenarioId + ' 的地图');
  const raw = await getJson(assetUrl('world_map', cfg, Number(entry[0]), 'cc.JsonAsset'));
  const map = parseMap(raw, file, scenarioId);
  fs.mkdirSync(MAP_DIR, { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(raw));
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return map;
}

export function loadMapAsset(id, resources = activeResources()) {
  const scenarioId = id > 0 ? id : 1;
  if (!Number.isSafeInteger(scenarioId)) throw new Error('地图场景编号无效');
  const file = resources ? resources.mapFiles[scenarioId] : mapPath(scenarioId);
  if (!file) throw new Error('当前资源版本中没有场景 ' + scenarioId + ' 的地图');
  if (!mapLoads.has(file)) {
    const job = (async () => {
      try { return parseMap(JSON.parse(fs.readFileSync(file, 'utf8')), file, scenarioId); }
      catch (error) { if (resources) throw error; return fetchMap(file, scenarioId); }
    })().catch(error => { mapLoads.delete(file); throw error; });
    mapLoads.set(file, job);
    if (mapLoads.size > 16) mapLoads.delete(mapLoads.keys().next().value);
  }
  return mapLoads.get(file);
}

function parseMap(raw, file, scenarioId) {
  const data = raw?.[5]?.[0]?.[2];
  if (!Array.isArray(data?.mapData) || !data.mapInfo?.width || data.mapData.length !== data.mapInfo.width * data.mapInfo.height)
    throw new Error('地图格子数据不完整');
  const { mapInfo, cityInfo, mapData } = data;
  return {
    file,
    scenarioId: scenarioId > 0 ? scenarioId : 1,
    width: mapInfo?.width ?? 0,
    height: mapInfo?.height ?? 0,
    tileWidth: mapInfo?.tileWidth ?? 0,
    tileHeight: mapInfo?.tileHeight ?? 0,
    cityInfo,
    cityAt(gridIdx) { return mapData[gridIdx] === undefined ? 0 : mapData[gridIdx] % 1000; },
    fieldCount: mapData.reduce((n, v) => n + (Math.floor(v / 10000) % 10 ? 1 : 0), 0),
    fieldAt(gridIdx) {
      const v = mapData[gridIdx];
      if (v === undefined) return null;
      const resType = Math.floor(v / 10000) % 10;
      if (!resType) return null;
      return { gridIdx, resType, cityId: v % 1000 };
    },
  };
}

// 舰队状态：1=IDLE 2=MOVING 3=BATTLING 4=REPAIRING 5=QUEUING（客户端 FleetState 枚举）。
export function idleFleets(survey) {
  return (survey.fleets ?? []).filter((f) => Number(f.state) === 1 && Number(f.durability) > 0);
}

export function formatFieldReport(survey, map, mapError) {
  const lines = [];
  const info = survey.resFields;
  const fields = info?.fields ?? [];
  const locked = survey.player?.level > 0 && survey.player.level < survey.worldOpenLevel;
  if (locked) lines.push(`世界玩法 ${survey.worldOpenLevel} 级开放，当前角色 ${survey.player.level} 级`);
  lines.push(info ? `已占资源田 ${fields.length}/${info.maxNum ?? '?'}` : '未取得资源田信息');
  for (const f of fields) {
    const at = map?.fieldAt(f.gridIdx);
    lines.push(`  gridIdx=${f.gridIdx} cityId=${f.cityId} type=${f.type}${at ? ` (地图: 城 ${at.cityId} 类型 ${at.resType})` : ''}`);
  }
  const idle = idleFleets(survey);
  if (!survey.fleets) lines.push('未取得舰队信息，可稍后刷新');
  else if (survey.fleets.length) lines.push(`舰队 ${survey.fleets.length} 支，其中闲置可用 ${idle.length} 支${idle.length ? `（${idle.map(f => f.buildingId).join('、')}）` : ''}`);
  else if (!locked) lines.push('当前账号暂无舰队');
  if (map) lines.push(`场景 ${map.scenarioId} · 地图 ${map.width}×${map.height}，资源田 ${map.fieldCount} 块，城池 ${Object.keys(map.cityInfo ?? {}).length} 座`);
  else lines.push('本次未取得场景地图' + (mapError ? '：' + mapError : ''));
  return lines.join('\n');
}

// 手动占田：显式给 gridIdx，舰队要么点名要么自动挑闲置的；条件不满足就直接拒绝，不发请求。
export function planFieldOccupy(survey, gridIdx, { fleetBuildingIds = [] } = {}) {
  const info = survey.resFields;
  if (survey.player?.level < survey.worldOpenLevel) return { error: `世界玩法 ${survey.worldOpenLevel} 级开放` };
  if (!info || !survey.fleets) return { error: '未取得资源田或舰队状态，请刷新后重试' };
  if (info && (info.fields ?? []).length >= (info.maxNum ?? 0)) {
    return { error: `已占 ${info.fields.length}/${info.maxNum} 块田，达到上限` };
  }
  const idle = idleFleets(survey);
  const picks = fleetBuildingIds.length > 0 ? fleetBuildingIds : idle.slice(0, 1).map((f) => f.buildingId);
  if (picks.length === 0) {
    return { error: '没有闲置且耐久>0 的舰队可派，占田会被服务端拒绝' };
  }
  const known = new Set((survey.fleets ?? []).map((f) => f.buildingId));
  const unknown = picks.filter((id) => !known.has(id));
  if (unknown.length > 0) return { error: `舰队 ${unknown.join(',')} 不在 MyFleetsResponse 里` };
  return {
    action: {
      kind: 'challengeField',
      request: 'ChallengeResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx), fleetBuildingIds: picks },
      label: `占田 gridIdx=${gridIdx} 派 ${picks.join(',')}`,
    },
  };
}

export function planFieldGiveUp(survey, gridIdx) {
  const owned = (survey.resFields?.fields ?? []).some((f) => Number(f.gridIdx) === Number(gridIdx));
  if (!owned) return { error: `gridIdx=${gridIdx} 不在我已占的田里` };
  return {
    action: {
      kind: 'giveUpField',
      request: 'GiveUpResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx) },
      label: `放弃资源田 gridIdx=${gridIdx}`,
    },
  };
}

export function formatWorldPlan(survey, plan) {
  const lines = [];
  lines.push(`人口 ${survey.population}/${survey.maxPopulation}  库存 ${survey.stock.size} 种  工厂 ${survey.factories.length} 栋  订单 ${survey.orders.length} 条`);
  if (survey.futurePopulation > survey.population) lines.push(`民居施工完成后人口 ${survey.futurePopulation}`);
  if (survey.resFields) {
    const fields = survey.resFields.fields ?? [];
    lines.push(`资源田 ${fields.length}/${survey.resFields.maxNum ?? '?'}${fields.length ? `  已占 ${fields.map((f) => f.gridIdx).join(',')}` : ''}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of [...survey.notes, ...plan.notes]) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
