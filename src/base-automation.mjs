import { cleanupAfterClaim } from './claim-cleanup.mjs';
import { collectAntiqueFloaters } from './antique-floaters.mjs';
import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';
import { budgetPreview, createActionGuard, resourceReserve, exactAutomationId, automationWireId, nativePreferenceEnabled, AutomationSkip } from './automation-policy.mjs';
import { serviceBoats } from './boats.mjs';
import { serviceCargo } from './cargo.mjs';
import { collectFloaters } from './collections.mjs';
import { fishOnce } from './fishing.mjs';
import { upgradeFishingOnce } from './fishing-upgrade.mjs';
import { readOrderReservedStock } from './order-reservations.mjs';
import { petSpendSnapshot, confirmPetSpend } from './spend-evidence.mjs';
import { readAllianceRecruitDemand } from './alliance-automation.mjs';
import { readGuildShips, guildShipDemands } from './guild-ships.mjs';
import { watchHeroRaidPushes, heroRaidDemands } from './hero-raid-automation.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const quantities = list => (list ?? []).map(item => Array.isArray(item) ? { id: item[0], num: Number(item[1]) } : { id: item.id, num: Number(item.num) });
const validCosts = list => Array.isArray(list) && list.length > 0 && list.every(item => typeof item.id === 'string' && Number.isSafeInteger(item.num) && item.num > 0);
const stateByClient = new WeakMap();
function petRooms(buildings, config) {
  return (buildings ?? []).filter(b => b.level > 0 && b.petBreed &&
    (b.type ?? rows(config, 'BuildingUnlockCfg').find(row => row.buildingId === b.buildingId)?.buildingType) === '宠物培育室');
}
function petQueue(room, config) {
  const data = room.petBreed;
  const configured = rows(config, 'BuildingUpgradeCfg').find(row => row.buildingType === '宠物培育室' && row.level === room.level)?.effect?.find(row => row[0] === '培育队列')?.[1];
  if (!Number.isSafeInteger(room.level) || !Number.isSafeInteger(data.maxQLength) || data.maxQLength < 1 ||
      !Array.isArray(data.breedQ) || !Array.isArray(data.maturePets) || (configured != null && (!Number.isSafeInteger(configured) || configured < 1))) return null;
  // 客户端按建筑等级解锁队列；协议的最大长度不能越过已解锁数量。
  return { jobs: data.breedQ.length, mature: data.maturePets.length, capacity: Math.min(room.level, data.maxQLength, configured ?? room.level) };
}
function normalizeBaseReply(request, raw) {
  const value = normalize(raw);
  if (request === 'AllPetRequest') for (const [index, pet] of (value.pets ?? []).entries()) pet.uid = exactAutomationId(raw.pets[index].uid);
  if (request === 'GuildShipRequest') for (const list of ['ship', 'ownRun']) for (const [index, ship] of (value[list] ?? []).entries()) {
    for (const [cabinIndex, cabin] of (ship.cabin ?? []).entries()) if (cabin.player) cabin.player.playerId = exactAutomationId(raw[list][index].cabin[cabinIndex].player?.playerId);
  }
  return value;
}
// 客户端 WorldIdRule：百万位以上的后三位为赛季。
export function gameSeason(player) {
  const id = Number(player?.worldId?.toString?.() ?? player?.worldId);
  return Number.isSafeInteger(id) && id > 0 ? Math.floor(id / 1_000_000 % 1000) : null;
}

// 这些状态由登录后的服务器推送提供，不能根据本地配置表伪造一个“正在进行”的活动或事件。
export function watchBasePushes(client) {
  if (stateByClient.has(client)) return stateByClient.get(client);
  const state = { choices: new Map(), raids: watchHeroRaidPushes(client).raids, choiceObserved: false, invalidChoice: false };
  stateByClient.set(client, state);
  const reset=()=>{state.choices.clear();state.raids.clear();state.choiceObserved=false;state.invalidChoice=false;};
  client.on?.('login',reset);client.on?.('close',reset);
  client.on?.('message', ({ name, body }) => {
    if (name === 'SCChoiceEventUpdate') {
      state.choiceObserved = true;
      for (const raw of body?.events ?? []) {
        const uid = exactAutomationId(raw.uid);
        if (uid) state.choices.set(uid, { ...normalize(raw), uid });
        else state.invalidChoice = true;
      }
    }
  });
  return state;
}

export async function surveyBaseAutomation(client, protocol, config, player, settings, waterSurvey, { ledger, enabled = () => true } = {}) {
  const notes = [];
  const state = watchBasePushes(client);
  if (state.invalidChoice) notes.push('部分随机事件的标识无法精确确认，已跳过');
  const needs = new Set(settings?.factory.demandFirst || settings?.factory.speedUpSources.length ? settings.factory.demandPriority : []);
  const get = async (request, response = request.replace(/Request$/, 'Response')) => {
    if (!protocol[request] || !protocol[response]) { notes.push(`${request} 的状态接口不可用`); return null; }
    try { return normalizeBaseReply(request, await client.request(request, {}, response, 8000)); }
    catch { notes.push(`${request} 本轮未取得状态`); return null; }
  };
  const member = !!exactAutomationId(player?.guildId);
  const [museum, heroes, pets, gold, guildOrder, guildShip, radar] = await Promise.all([
    settings.museum.enabled || settings.museum.upgrade || needs.has('museum') ? get('MuseumInfoRequest') : null,
    settings.museum.enabled ? get('AllHeroRequest') : null,
    settings.pet.enabled && settings.pet.advance ? get('AllPetRequest') : null,
    settings.gold.enabled ? get('ClickGoldInfoRequest') : null,
    member && needs.has('guildRecruit') && !settings.alliance?.enabled ? get('GuildOrderRequest') : null,
    member && needs.has('guildShip') && !settings.guildShip?.enabled ? get('GuildShipRequest') : null,
    needs.has('refugee') ? get('RadarInfoRequest') : null,
  ]);
  let guildRecruitDemand = [];
  if (member && settings.alliance?.enabled && settings.alliance.recruit && settings.alliance.recruitProduction) {
    try { guildRecruitDemand = await readAllianceRecruitDemand(client, protocol, config, player, settings, { ledger, enabled }); }
    catch (error) { notes.push('联盟募兵补产：' + error.message); }
  }
  let guildShipDemand = [];
  // 红船补料有独立开关，不依赖工厂“优先需求”或需求来源排序；仍由工厂总开关决定是否生产。
  if (member && settings.alliance?.enabled && settings.guildShip?.enabled && settings.guildShip.produceMissing) {
    try { guildShipDemand = guildShipDemands(await readGuildShips(client, protocol, config, { player, getSettings: () => settings, enabled }), settings, ledger); }
    catch (error) { notes.push('联盟商船补产：' + error.message); }
  }
  return { now: waterSurvey.serverNow ?? waterSurvey.now, player, world: waterSurvey, museum, heroes: heroes?.heroes ?? [], pets: pets?.pets ?? [], gold,
    guildOrder, guildRecruitDemand, guildShip, guildShipDemand, heroRaidDemand: heroRaidDemands(client, config, player, settings, { ledger }),
    radar, choices: [...state.choices.values()], raids: [...state.raids.values()], choiceObserved: state.choiceObserved, notes };
}

function museumFactor(stage, snapshot, config, settings) {
  const p = settings.museum;
  const costs = quantities(stage.expedition?.cost?.asset);
  const matched = p.materialFactor && costs.some(item => p.factorMaterials.includes(item.id) || (p.stockThreshold > 0 && snapshot.world.have(item.id) <= p.stockThreshold));
  const selected = matched ? p.matchedFactor : p.factor;
  const available = rows(config, 'MuseumExploreTimeFactorCfg').filter(row => row.playerLevel <= (snapshot.player?.level ?? 0)).map(row => row.factor);
  return { factor: Math.min(selected, Math.max(1, ...available)), matched, costs };
}

function stageAvailable(stage, snapshot, config, settings) {
  const row = rows(config, 'MuseumExpeditionStageCfg').find(r => r.stageId === stage.stageId);
  if (!row || (settings.museum.maps.length && !settings.museum.maps.includes(String(stage.stageId)))) return false;
  const requirement = row.areaLevelReq ?? [];
  return !requirement.length || (snapshot.museum?.exhibitions ?? []).some(ex => ex.exhibitionId === requirement[0] && ex.level >= requirement[1]);
}

export function baseDemands(snapshot, config, settings) {
  const demands = [];
  const add = (source, requirements) => { const items = quantities(requirements); if (validCosts(items)) demands.push({ source, requirements: items }); };
  for (const stage of snapshot.museum?.exploreStages ?? []) {
    if (!settings.museum.enabled || stage.expedition?.endTime > 0 || !stageAvailable(stage, snapshot, config, settings)) continue;
    const { factor, costs } = museumFactor(stage, snapshot, config, settings);
    add('museum', costs.map(item => ({ ...item, num: item.num * factor })));
  }
  if (settings.museum.upgrade) for (const ex of snapshot.museum?.exhibitions ?? []) {
    const next = rows(config, 'MuseumAreaCfg').find(r => r.areaId === ex.exhibitionId && r.level === ex.level + 1);
    if (next && next.playerLevelReq <= (snapshot.player?.level ?? 0)) add('museum', next.costArr);
  }
  if (settings.alliance?.enabled) demands.push(...(snapshot.guildRecruitDemand ?? []));
  else add('guildRecruit', snapshot.guildOrder?.order?.requirements);
  if (settings.guildShip?.enabled) demands.push(...(snapshot.guildShipDemand ?? []));
  else {
    const self = exactAutomationId(snapshot.player?.playerId ?? snapshot.player?.id);
    const guildShips = new Map([...(snapshot.guildShip?.ship ?? []), ...(snapshot.guildShip?.ownRun ?? [])].map(ship => [ship.shipId, ship]));
    for (const ship of guildShips.values()) if (ship.state === 1) {
      for (const cabin of ship.cabin ?? []) if (self && String(cabin.player?.playerId ?? '') === self) add('guildShip', cabin.order);
    }
  }
  for (const event of snapshot.radar?.radarInfo?.events ?? []) if (!(event.startTime > 0)) add('refugee', event.refugee?.requirements);
  if (settings.heroRaid?.enabled && settings.heroRaid.orders) demands.push(...(snapshot.heroRaidDemand ?? []));
  for (const b of snapshot.world.buildings) {
    add('petAdvance', b.petServe?.upgradeRequirements);
    if (petRooms([b], config).length) for (const job of b.petBreed.breedQ ?? []) if (job.finishTime > snapshot.now) add('petFeed', job.feedRequirements);
  }
  if (settings.factory.keepStock > 0) {
    const recipes = rows(config, 'BuildingProduceCfg').filter(r => snapshot.world.factories.some(b => b.type === r.buildType && b.level >= r.unlockLevel && !settings.factory.disabledTypes.includes(b.type)));
    add('factory', recipes.map(r => ({ id: r.itemId, num: Math.min(settings.factory.keepStock, snapshot.world.stockCap) })));
  }
  return demands;
}

export async function previewNativeAutomation(client, config, player, settings, flags, world, usage) {
  const actions = [], notes = [];
  const enabled = key => flags[key] === true && nativePreferenceEnabled(settings, key);
  const reads = new Set(['FishEncyclopediaRequest','OnWaterRequest', 'AllItemRequest', 'AllResourceRequest', 'GameEffectRequest', 'CargoShipsRequest', 'WeekInfoRequest', 'WeekOrderInfoRequest']);
  // 除 dryRun 分支外再限定请求白名单，预览路径始终不能发送游戏写入。
  const readonly = new Proxy(client, { get(target, key) {
    if (key === 'request') return (name, ...args) => {
      if (!reads.has(name)) throw new Error('只读预览不允许此游戏动作');
      return target.request(name, ...args);
    };
    if (key === 'sendWatch' || key === 'send') return () => { throw new Error('只读预览禁止发送游戏写入'); };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const record = entry => {
    if (entry?.action) actions.push(entry.action);
    else if (entry?.reason || entry?.error) notes.push((entry.label || '采集') + '：' + (entry.reason || entry.error));
  };
  const group = async (label, action) => { try { await action(); } catch (error) { notes.push(label + '：' + error.message); } };
  if (enabled('autoFish')) await group('钓鱼', async () => record(await fishOnce(readonly, config, () => enabled('autoFish'), { dryRun: true, fishBook: settings.gather.fishBook })));
  if (enabled('fishEnhance')) await group('钓具养成', async () => record(await upgradeFishingOnce(readonly, config, { playerLevel: player?.level,
    reserveGold: settings.gather.fishingGoldReserve, targetLevel: settings.gather.targetLevel, enabled: () => enabled('fishEnhance'), dryRun: true })));
  if (['autoDive', 'autoSalvage', 'diveEnhance', 'salvageEnhance'].some(enabled)) await group('船只', () => serviceBoats(readonly, config, enabled, record, { settings, dryRun: true }));
  if (enabled('antiqueFloaters')) await group('藏品宝箱',()=>collectAntiqueFloaters(readonly,config,{enabled:()=>enabled('antiqueFloaters'),report:record,dryRun:true}));
  if (enabled('floaters')) await group('漂浮物', () => collectFloaters(readonly, config, world.floaters, enabled, record, { settings, dryRun: true }));
  if (enabled('cargo') && player?.level >= (rows(config, 'CargoUnlockCfg')[0]?.playerLevel ?? 9)) await group('贸易港', () => serviceCargo(readonly, config, {
    enabled: () => enabled('cargo'), getSettings: () => settings, ledger: { snapshot: () => usage }, dryRun: true,
    log(label, details) { if (details?.action) actions.push(details.action); else if (details?.skipped) notes.push(label); },
  }));
  if (settings.gather.keyOpen && actions.some(action => action.kind === 'autoDive') && world.have('保险箱钥匙') >= 1) {
    actions.push({ kind: 'diveKey', label: '潜水成功后使用 1 把现有保险箱钥匙', costs: [{ id: '保险箱钥匙', num: 1 }] });
  }
  return { actions, notes };
}

export function planBaseAutomation(snapshot, config, settings, usage = {}, { diveCompleted = false } = {}) {
  const actions = [], notes = [...snapshot.notes];
  const { world, now, player } = snapshot;
  const working = new Map(world.stock);
  const free = id => (working.get(id) ?? 0) - resourceReserve(settings, id);
  const add = step => {
    if ((step.costs ?? []).some(item => !Number.isSafeInteger(item.num) || item.num < 0 || free(item.id) < item.num)) { notes.push(`${step.label}：现有材料不足或需保留`); return false; }
    for (const item of step.costs ?? []) working.set(item.id, (working.get(item.id) ?? 0) - item.num);
    actions.push({ scope: 'base', ...step });
    return true;
  };
  if (settings.loop.world) {
    planMuseum();
    planPets();
    if (settings.events.enabled) {
      if (!snapshot.choiceObserved) notes.push('随机事件：尚未收到本次连接的事件状态');
      for (const event of snapshot.choices) {
        const row = rows(config, 'EventChoiceCfg').find(r => r.eventId === event.eventId);
        const option = row?.title === '发现海上资源补给' && row.option2 === '建造居民房' ? 2 : row?.title === '居民想要离开' && row.option2 === '让他离开' ? 2 : settings.events.otherOption ?? 1;
        if (option == null) { notes.push(`随机事件“${row?.title ?? event.eventId}”留待手动选择`); continue; }
        add({ kind: 'choiceEvent', setting: 'events.enabled', request: 'SelectChoiceRequest', response: 'GotRewardResponse', body: { uid: String(event.uid), optionIndex: option }, label: `${row?.title ?? '随机事件 '+event.eventId}：${row?.['option'+option] ?? '自动选择第'+option+'项'}` });
      }
    }
    if (settings.gather.enabled !== false && settings.gather.diving && settings.gather.keyOpen && diveCompleted && free('保险箱钥匙') >= 1) {
      add({ kind: 'diveKey', setting: 'gather.keyOpen', request: 'AntiqueRecruitRequest', response: 'AntiqueRecruitResponse', body: { type: 2, way: 2 },
        costs: [{ id: '保险箱钥匙', num: 1 }], label: '潜水后使用 1 把保险箱钥匙开箱' });
    }
  }
  if (settings.loop.dailies && settings.gold.enabled) {
    const info = snapshot.gold?.info;
    const price = rows(config, 'OfflineParamCfg').find(r => r.paramName === '点金价格')?.paramValue;
    if (!info || !Number.isSafeInteger(price) || price < 1) notes.push('付费点金：未能确认当天次数和单价');
    else {
      const recorded = Math.max(info.paidTimes ?? 0, usage.counters?.goldPaidTimes ?? 0);
      const remaining = Math.max(0, Math.min(settings.gold.times, info.maxPaidTimes ?? 0) - recorded);
      const budget = settings.resources.allowDiamonds ? Math.max(0, settings.resources.diamondDailyLimit - (usage.counters?.diamonds ?? 0)) : 0;
      const count = Math.min(remaining, Math.floor(Math.max(0, free('RUBY')) / price), Math.floor(budget / price));
      if (count > 0) add({ kind: 'paidGold', setting: 'gold.enabled', scope: 'daily', request: 'ClickGoldRequest', response: 'ClickGoldResponse', body: { times: count, free: false },
        costs: [{ id: 'RUBY', num: count * price }], counters: { goldPaidTimes: count }, counterMinimums: { goldPaidTimes: info.paidTimes ?? 0 },
        verify: { paidBefore: info.paidTimes ?? 0 }, label: `付费点金 ${count} 次（今日目标 ${settings.gold.times}，已完成 ${info.paidTimes ?? 0}）` });
      else if (remaining > 0) notes.push('付费点金：钻石开关、保留余额或每日额度限制了本次操作');
      else if (recorded > (info.paidTimes ?? 0)) notes.push(`付费点金：游戏已完成 ${info.paidTimes ?? 0} 次，已计入或预留 ${recorded} 次，等待未确认结果，不再追加`);
    }
  }
  const checked = budgetPreview(actions, world.stock, settings, usage);
  return { actions: checked.actions, notes: [...notes, ...checked.notes], demands: baseDemands(snapshot, config, settings) };

  function planMuseum() {
    const pref = settings.museum, data = snapshot.museum;
    if (!pref.enabled && !pref.upgrade) return;
    if (!data) { notes.push('博物馆：本轮未取得状态，待开放或连接恢复后再检查'); return; }
    if (pref.enabled) {
      const claimed = new Set((data.claimedAchievements ?? []).map(Number));
      for (const row of rows(config, 'MuseumAchievementCfg')) if (!claimed.has(row.score) && Number(data.topPopularity ?? data.popularity ?? 0) >= row.score) {
        add({ kind: 'museumAchievement', setting: 'museum.enabled', request: 'MuseumClaimAchievementRequest', response: null, body: { popularityThreshold: row.score }, label: `领取博物馆人气 ${row.score} 成就` });
      }
      let guides = Math.max(0, Math.min(free('博物馆加速'), pref.dailyGuideLimit - (usage.counters?.museumGuides ?? 0)));
      for (const stage of data.exploreStages ?? []) {
        if (!(stage.expedition?.endTime > 0)) continue;
        if (stage.expedition.endTime <= now) add({ kind: 'museumComplete', setting: 'museum.enabled', request: 'MuseumCompleteExploreRequest', response: 'MuseumCompleteExploreResponse', body: { stageId: stage.stageId }, label: `领取地图 ${stage.stageId} 的探宝结果` });
        else if (pref.useGuide && guides > 0 && (!pref.maps.length || pref.maps.includes(String(stage.stageId)))) {
          const useNum = Math.min(guides, Math.ceil((stage.expedition.endTime - now) / 1800));
          guides -= useNum;
          add({ kind: 'museumGuide', setting: 'museum.useGuide', request: 'MuseumSpeedUpExploreRequest', response: 'MuseumSpeedUpExploreResponse', body: { stageId: stage.stageId, useNum },
            costs: [{ id: '博物馆加速', num: useNum }], counters: { museumGuides: useNum }, verify: { endTime: stage.expedition.endTime }, label: `地图 ${stage.stageId} 使用 ${useNum} 本探险指南` });
        }
      }
      const occupied = (data.exploreStages ?? []).filter(stage => stage.expedition?.endTime > 0);
      const maxTeams = Math.max(0, ...rows(config, 'MuseumExpeditionTeamCfg').filter(row => row.playerLevel <= (player?.level ?? 0)).map(row => row.teamCount));
      let freeTeams = Math.max(0, maxTeams - occupied.length);
      const busy = new Set(occupied.flatMap(stage => stage.expedition.heroIds ?? []));
      const candidates = (data.exploreStages ?? []).filter(stage => !(stage.expedition?.endTime > 0) && stageAvailable(stage, snapshot, config, settings))
        .map(stage => ({ stage, ...museumFactor(stage, snapshot, config, settings) })).sort((a, b) => Number(a.matched) - Number(b.matched) || a.stage.stageId - b.stage.stageId);
      for (const { stage, factor, costs } of candidates) {
        if (!freeTeams) break;
        if (!validCosts(costs)) { notes.push(`地图 ${stage.stageId}：服务器尚未下发派遣材料，本轮不派遣`); continue; }
        const requirements = costs.map(item => ({ ...item, num: item.num * factor }));
        const condition = rows(config, 'MuseumExpeditionConditionCfg').find(r => r.conditionId === stage.expedition?.conditionId);
        const count = condition?.heroCount ?? 3;
        const heroes = snapshot.heroes.filter(hero => !busy.has(hero.heroId)).sort((a, b) => Number(b.power ?? 0) - Number(a.power ?? 0)).slice(0, count);
        if (!(count > 0) || heroes.length !== count) { notes.push(`地图 ${stage.stageId}：没有足够的空闲英雄`); continue; }
        if (add({ kind: 'museumStart', setting: 'museum.enabled', request: 'MuseumStartExploreRequest', response: 'MuseumStartExploreResponse',
          body: { stageId: stage.stageId, heroIds: heroes.map(hero => hero.heroId), factor }, costs: requirements, label: `派遣地图 ${stage.stageId}，${factor} 倍探宝` })) {
          freeTeams--; for (const hero of heroes) busy.add(hero.heroId);
        }
      }
    }
    if (pref.upgrade) for (const ex of data.exhibitions ?? []) {
      const levels = Array.from({ length: 3 }, (_, index) => Number(ex.keywordLevels?.[index] ?? 0));
      const stageRows = rows(config, 'MuseumAreaIndicatorCfg').filter(row => row.areaId === ex.exhibitionId && row.areaLevel === ex.level);
      const cap = Math.max(0, ...stageRows.map(row => row.level));
      if (!cap) { notes.push(`展区 ${ex.exhibitionId}：缺少当前等级的技能配置`); continue; }
      if (levels.every(level => level >= cap)) {
        const next = rows(config, 'MuseumAreaCfg').find(row => row.areaId === ex.exhibitionId && row.level === ex.level + 1);
        if (!next || next.playerLevelReq > (player?.level ?? 0)) continue;
        const costs = quantities(next.costArr);
        if (!validCosts(costs)) { notes.push(`展区 ${ex.exhibitionId}：升级消耗不明`); continue; }
        add({ kind: 'museumExhibition', setting: 'museum.upgrade', request: 'MuseumUpgradeExhibitionRequest', response: 'MuseumCaseUpdateResponse', body: { exhibitionId: ex.exhibitionId },
          costs, verify: { level: ex.level + 1 }, label: `博物馆展区 ${ex.exhibitionId} 升至 ${ex.level + 1} 级` });
      } else {
        const index = levels.indexOf(Math.min(...levels));
        const next = rows(config, 'MuseumAreaIndicatorCfg').find(row => row.areaId === ex.exhibitionId && row.level === levels[index] + 1 && row.areaLevel <= ex.level);
        if (!next?.upgradeCost) continue;
        add({ kind: 'museumKeyword', setting: 'museum.upgrade', request: 'MuseumUpgradeKeywordRequest', response: 'MuseumCaseUpdateResponse', body: { exhibitionId: ex.exhibitionId, keywordType: index + 1 },
          costs: quantities([next.upgradeCost]), verify: { index, level: levels[index] + 1 }, label: `博物馆展区 ${ex.exhibitionId} 技能 ${index + 1} 升至 ${levels[index] + 1} 级` });
      }
    }
  }

  function planPets() {
    const pref = settings.pet;
    if (!pref.enabled) return;
    const rooms = petRooms(world.buildings, config);
    const season = gameSeason(player);
    const matureBefore = rooms.reduce((sum, room) => sum + (room.petBreed.maturePets?.length ?? 0), 0);
    let claimPlanned = false, breedPlanned = false;
    if (!rooms.length) notes.push('海兽培育：未找到已建成的真实培育室');
    if (matureBefore > 0 && pref.breed) notes.push(pref.claim ? '海兽培育：先领取已完成海兽，确认领取后下次检查再培育' : '海兽培育：有已完成海兽待领取，自动领取已关闭，暂不继续培育');
    for (const room of rooms) {
      const data = room.petBreed;
      const queue = petQueue(room, config);
      if (!queue) { notes.push('海兽培育：队列状态或容量未确认，等待下次检查'); continue; }
      if (pref.breed && queue.jobs >= queue.capacity) notes.push(`海兽培育队列已满（${queue.jobs}/${queue.capacity}），等待完成并领取后再培育`);
      if (pref.claim && data.maturePets?.length && !claimPlanned) claimPlanned = add({ kind: 'petClaim', setting: 'pet.claim', request: 'GetMaturePetRequest', response: null, body: {}, verify: { matureBefore }, label: '领取已培育完成的海兽' });
      if (pref.feed) for (const job of data.breedQ ?? []) {
        const costs = quantities(job.feedRequirements);
        if (job.finishTime > now && validCosts(costs)) add({ kind: 'petFeed', setting: 'pet.feed', request: 'PetFeedRequest', response: null, body: { jobIdx: job.idx }, costs, verify: { finishTime: job.finishTime }, label: `喂养培育队列 ${job.idx}` });
      }
      if (pref.breed && pref.species.length && !breedPlanned && matureBefore === 0 && queue.jobs < queue.capacity) {
        if (!(season > 0)) { notes.push('海兽培育：无法确认当前赛季，本轮不开始培育'); continue; }
        const quality = ['BLUE', 'PURPLE', 'ORANGE', 'RED'];
        const candidates = rows(config, 'PetBreedCfg').filter(row => pref.species.includes(String(row.spId)) && row.season <= season && quality.includes(row.quality) && quality.indexOf(row.quality) <= quality.indexOf(pref.quality))
          .sort((a, b) => quality.indexOf(a.quality) - quality.indexOf(b.quality) || pref.species.indexOf(String(a.spId)) - pref.species.indexOf(String(b.spId)));
        for (const row of candidates) {
          const original = quantities(row.cost);
          if (!validCosts(original)) continue;
          const costs = original.map(item => ({ ...item }));
          let universal = false;
          const own = costs[0];
          const missing = Math.max(0, own.num - Math.max(0, free(own.id)));
          if (missing > 0 && pref.universal) {
            const name = ({ BLUE: '蓝', PURPLE: '紫', ORANGE: '橙', RED: '红' })[row.quality];
            const item = row.spId <= 3 ? `${name}宠基因自选包` : ['ORANGE', 'RED'].includes(row.quality) ? `${name}宠基因自选包2` : null;
            if (item && free(item) >= missing) { own.num -= missing; costs.push({ id: item, num: missing }); universal = true; }
          }
          if (costs.some(item => free(item.id) < item.num)) continue;
          breedPlanned = add({ kind: 'petBreed', setting: 'pet.breed', request: 'PetBreedRequest', response: null, body: { petId: row.petId, universal }, costs: costs.filter(item => item.num > 0),
            verify: { queueBefore: rooms.reduce((sum, room) => sum + (room.petBreed.breedQ?.length ?? 0), 0) },
            label: `培育${rows(config, 'PetSpeciesCfg').find(s => s.spId === row.spId)?.name ?? row.petId}（${({ BLUE: '蓝', PURPLE: '紫', ORANGE: '橙', RED: '红' })[row.quality]}）` });
          break;
        }
      }
    }
    if (pref.advance) for (const b of world.buildings.filter(b => b.petServe?.petUid)) {
      const pet = snapshot.pets.find(p => String(p.uid) === String(b.petServe.petUid));
      if (!pet) continue;
      const required = rows(config, 'PetFeedAttrCfg').filter(row => row.level === (pet.grade ?? 0)).reduce((sum, row) => sum + (row.attrCounts ?? []).reduce((n, count) => n + count, 0), 0);
      const fed = (pet.profFeed ?? []).reduce((sum, prof) => sum + (prof.attrFeed ?? []).reduce((n, attr) => n + attr.times, 0), 0);
      const next = rows(config, 'PetAdvancedCfg').find(row => row.grade === (pet.grade ?? 0) + 1);
      if (!next || !(required > 0)) continue;
      if (fed >= required && pet.level >= next.level) add({ kind: 'petAdvance', setting: 'pet.advance', request: 'PetUpgradeRequest', response: null, body: { buildingId: b.buildingId }, verify: { petUid: String(pet.uid), grade: next.grade }, label: `海兽 ${pet.petId} 进阶至 ${next.grade} 阶` });
      else if (fed < required) {
        const costs = quantities(b.petServe.upgradeRequirements);
        if (validCosts(costs)) add({ kind: 'petAdvanceFeed', setting: 'pet.advance', request: 'PetUpgradeFeedRequest', response: null, body: { buildingId: b.buildingId }, costs,
          verify: { petUid: String(pet.uid), fed, grade: pet.grade ?? 0 }, label: `海兽 ${pet.petId} 投喂进阶材料` });
      } else notes.push(`海兽 ${pet.petId} 进阶需要等级 ${next.level}`);
    }
  }
}

export async function runBaseAutomation(client, protocol, config, plan, { player = null, getSettings, ledger, enabled = () => true, onStep } = {}) {
  const guard = createActionGuard(client, getSettings, ledger, { enabled, player });
  const results = [];
  for (const step of plan.actions) {
    if (!enabled()) break;
    let ticket = null, choiceTicket = null, prepared = false, sent = false, writePending = false, entry, petBefore, waterSnapshot;
    try {
      const current = getSettings();
      const [group, key] = step.setting.split('.');
      if (!current[group]?.[key] || (group === 'pet' && !current.pet.enabled) || (group === 'museum' && !current.museum.enabled && key !== 'upgrade')) continue;
      if (!protocol[step.request]) throw new Error('当前协议不支持此动作');
      if (step.kind === 'museumComplete' && (!protocol.MuseumCompleteExploreResponse || !protocol.MuseumRewardRequest || !protocol.MuseumRewardResponse)) throw new Error('当前协议不能完整确认探宝结算与领奖');
      if(step.kind==='choiceEvent') {
        if(!protocol.GotRewardResponse||!ledger)throw new AutomationSkip('随机事件回执或记录不可用');
        const choiceKey='choice-event:'+step.body.uid;
        if(ledger.hasKey(choiceKey))throw new AutomationSkip('此随机事件已处理或结果待确认，不重复选择');
        choiceTicket=ledger.reserve({},{},{},{uniqueKey:choiceKey,details:{kind:'choiceEvent',eventUid:step.body.uid}});
      }
      if (step.kind === 'museumStart' && player) {
        const reserved = await readOrderReservedStock(client, protocol, config, { player, enabled: () => enabled() && current === getSettings(), itemIds: (step.costs ?? []).map(row => row.id) });
        const costs = new Map();
        for (const cost of step.costs ?? []) {
          if (typeof cost.id !== 'string' || !Number.isSafeInteger(cost.num) || cost.num <= 0) throw new AutomationSkip('博物馆派遣消耗未确认');
          const total = (costs.get(cost.id) ?? 0) + cost.num;
          if (!Number.isSafeInteger(total)) throw new AutomationSkip('博物馆派遣消耗无法精确确认');
          costs.set(cost.id, total);
        }
        if (!costs.size || [...costs].some(([id, need]) => (reserved.available.get(id) ?? 0) < need)) throw new AutomationSkip('博物馆派遣材料不足，或已为周订单、贸易港和居民订单预留');
      }
      if (['petBreed', 'petClaim', 'petFeed'].includes(step.kind)) {
        const fresh = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse', 8000));
        if (!Array.isArray(fresh.building)) throw new AutomationSkip('海兽培育：未取得最新队列状态，等待下次检查');
        const rooms = petRooms(fresh.building, config), queues = rooms.map(room => petQueue(room, config));
        if (!rooms.length || queues.some(q => !q)) throw new AutomationSkip('海兽培育：真实培育室或队列容量未确认，暂不操作');
        if (step.kind !== 'petClaim') {
          petBefore = petSpendSnapshot(rooms);
          if (!petBefore) throw new AutomationSkip('海兽培育：队列身份或时间数据不完整，暂不操作');
          waterSnapshot = fresh;
        }
        const mature = queues.reduce((n, q) => n + q.mature, 0);
        if (step.kind === 'petBreed') {
          if (mature) throw new AutomationSkip('海兽培育：有已完成海兽待领取，领取确认后再培育');
          if (!queues.some(q => q.jobs < q.capacity)) throw new AutomationSkip('海兽培育队列已满，等待完成并领取后再培育');
          step.verify.queueBefore = queues.reduce((n, q) => n + q.jobs, 0);
        } else if (step.kind === 'petClaim') {
          if (!mature) throw new AutomationSkip('当前没有可领取的已完成海兽');
          step.verify.matureBefore = mature;
        } else if (!rooms.some(room => room.petBreed.breedQ.some(job => job.idx === step.body.jobIdx && job.finishTime > Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000)))) {
          throw new AutomationSkip('海兽喂养队列已变化，等待下次检查');
        }
        if (!enabled() || current !== getSettings() || !getSettings().pet.enabled || !getSettings().pet[key]) throw new AutomationSkip('海兽操作设置已变化或已暂停');
      }
      ticket = await guard.before(step, { waterSnapshot }); prepared = true;
      if (!enabled() || current !== getSettings()) { await guard.cancel(step, ticket, { notSent: true }); if(choiceTicket)ledger.cancel(choiceTicket); break; }
      const wireBody = step.kind === 'choiceEvent' ? { ...step.body, uid: automationWireId(step.body.uid) } : step.body;
      sent = writePending = true;
      if (step.response && protocol[step.response]) {
        const reply = await client.request(step.request, wireBody, step.response, 15000);
        writePending = false;
        let body = normalize(reply);
        if(step.kind==='choiceEvent' && !body.reward?.asset?.length)throw new Error('随机事件奖励回执尚未确认');
        if (step.kind === 'museumStart' && !(body.expedition?.endTime > 0)) throw new Error('服务器尚未确认探宝队伍出发');
        if (step.kind === 'museumComplete') {
          if (!Number.isSafeInteger(body.grade) || body.grade < 1 || body.grade > 5) throw new Error('服务器尚未确认探宝结算');
          if (!enabled() || !getSettings()?.loop.world || !getSettings()?.museum.enabled) throw new AutomationSkip('探宝已结算，操作已暂停，奖励留待下次领取');
          const reward = normalize(await client.request('MuseumRewardRequest', { stageId: step.body.stageId }, 'MuseumRewardResponse', 15000));
          if (reward.exploreStage?.stageId !== step.body.stageId || reward.exploreStage.expedition?.endTime > 0) throw new Error('服务器尚未确认探宝奖励领取完成');
          body = { settlement: body, ...reward };
        }
        if (step.kind === 'museumGuide' && (!Number.isSafeInteger(body.expedition?.endTime) || body.expedition.endTime >= step.verify.endTime)) throw new Error('服务器尚未确认探险指南缩短了时间，额度暂时保留');
        if (step.kind === 'paidGold') {
          const after = normalize(await client.request('ClickGoldInfoRequest', {}, 'ClickGoldInfoResponse'));
          if (!Number.isSafeInteger(after.info?.paidTimes) || after.info.paidTimes < step.verify.paidBefore + step.body.times) throw new Error('服务器尚未确认付费点金次数，额度暂时保留');
        }
        if (step.kind === 'museumKeyword' || step.kind === 'museumExhibition') {
          const after = normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
          const ex = after.exhibitions?.find(row => row.exhibitionId === step.body.exhibitionId);
          const actual = step.kind === 'museumKeyword' ? ex?.keywordLevels?.[step.verify.index] : ex?.level;
          if (!Number.isSafeInteger(actual) || actual < step.verify.level) throw new Error('服务器尚未确认博物馆升级');
        }
        entry = { step, ok: true, body };
      } else {
        const watched = await client.sendWatch(step.request, wireBody, { window: 500 });
        writePending = false;
        entry = { step, ok: true, sent: watched };
        if (step.kind === 'museumAchievement') {
          const after = normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
          if (!after.claimedAchievements?.some(score => Number(score) === step.body.popularityThreshold)) throw new Error('服务器尚未确认博物馆成就已领取');
          entry = { step, ok: true, body: { claimed: step.body.popularityThreshold } };
        } else if (['petClaim', 'petBreed', 'petFeed'].includes(step.kind)) {
          const after = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
          if (!Array.isArray(after.building)) throw new Error('无法核对海兽培育状态');
          const rooms = petRooms(after.building, config);
          if (!rooms.length || rooms.some(room => !petQueue(room, config))) throw new Error('无法完整确认真实培育室队列，等待下次检查');
          const mature = rooms.reduce((sum, b) => sum + (b.petBreed.maturePets?.length ?? 0), 0);
          const confirmed = step.kind === 'petClaim' ? mature < step.verify.matureBefore
            : confirmPetSpend(petBefore, petSpendSnapshot(rooms), step.request, step.body);
          if (!confirmed) throw new Error('服务器尚未确认海兽操作结果');
          entry = { step, ok: true, body: { confirmed: true } };
        } else if (step.kind === 'petAdvance' || step.kind === 'petAdvanceFeed') {
          const after = normalizeBaseReply('AllPetRequest', await client.request('AllPetRequest', {}, 'AllPetResponse'));
          const pet = after.pets?.find(p => String(p.uid) === step.verify.petUid);
          const fed = (pet?.profFeed ?? []).reduce((sum, prof) => sum + (prof.attrFeed ?? []).reduce((n, attr) => n + attr.times, 0), 0);
          const confirmed = pet && (step.kind === 'petAdvance' ? pet.grade >= step.verify.grade : fed > step.verify.fed || pet.grade > step.verify.grade);
          if (!confirmed) throw new Error('服务器尚未确认海兽进阶进度');
          entry = { step, ok: true, body: { confirmed: true } };
        }
      }
      if (step.kind === 'choiceEvent') {ledger.confirm(choiceTicket);watchBasePushes(client).choices.delete(String(step.body.uid));}
      await guard.after(step, ticket, entry);
    } catch (error) {
      const notSent = !sent || (writePending && error.notSent === true);
      if(choiceTicket && (notSent || error.prompt&&error.request==='SelectChoiceRequest'))ledger.cancel(choiceTicket);
      if (prepared && (notSent || error.prompt && error.request === step.request)) await guard.cancel(step, ticket, { notSent, error });
      entry = { step, ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}), error: error.message };
    }
    results.push(entry); onStep?.(entry);
    if(step.kind==='petClaim'&&entry.ok){
      const pref=getSettings();
      const cleanup=await cleanupAfterClaim(client,config,pref,ledger,'pet',()=>enabled()&&client.connected&&getSettings()===pref&&pref.loop.world&&pref.pet.enabled&&pref.pet.claim);
      if(cleanup){const row={...cleanup,step:{kind:'petRelease',label:cleanup.label}};results.push(row);onStep?.(row);}
    }
  }
  return results;
}
