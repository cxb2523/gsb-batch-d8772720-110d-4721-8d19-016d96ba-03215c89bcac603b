import { automationControlFields, automationControls, idleControlFields } from './automation-controls.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskSettings } from './automation.mjs';
import { EXTENDED_DEFAULTS, EXTENDED_CONSTRAINTS, SILICON_FLEET_NUMBERS, validateSiliconFleets } from './extended-settings.mjs';
import { treasureRewardOptions } from './treasure-reward-filter.mjs';

// 设置与登录凭据分开保存。导出只包含设置，不包含账号、凭据或用量账本。
const dataDirectory = () => process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.resolve(import.meta.dirname, '../data');
export const settingsFile = () => path.join(dataDirectory(), 'automation-settings.json');
export const usageFile = () => path.join(dataDirectory(), 'automation-usage.json');
export const SETTINGS_FORMAT = 'crazywaterworld-automation';
const LEGACY_SETTINGS_FORMAT = 'crazywaterword-automation';
export const DEMAND_SOURCES = [
  ['cargo', '贸易港口 / 货船'], ['guildRecruit', '联盟募兵'], ['museum', '博物馆探宝'],
  ['guildShip', '联盟商船'], ['heroRaid', '红卡订单'], ['resident', '居民订单'],
  ['merchant', '不差钱商人'], ['building', '建筑建造 / 升级'], ['refugee', '救援难民'],
  ['petAdvance', '海兽进阶'], ['petFeed', '海兽喂养'], ['factory', '工厂补料'],
];

export const DEFAULT_SETTINGS = {
  ...EXTENDED_DEFAULTS,
  // 连接被顶号后，挂机可按当前账号的策略自动恢复连接。
  // 时间使用北京时间（HH:mm）；深夜窗口支持跨午夜配置。
  login: { autoReconnect: false, intervalSeconds: 900, jitterSeconds: 0, quietHours: true, quietStart: '02:00', quietEnd: '07:00', quietIntervalSeconds: 60, maxRetries: 5 },
  schedule: taskSettings(),
  eventActions: { compassThreshold: 10, compassDrawCount: 10 },
  merchant: { quoteMaxAgeSeconds: 300, estimateDiscountPercent: 10, refreshWaitSeconds: 120, liquidationMinutes: 120,
    maxLossPercent: 0, minExpectedProfit: 1, autoSpeedUp: false, speedUpMinProfit: 1000, keepPointers: 0,
    speedUpMode: 'profit', speedUpMaxPerLeg: 4, monitorSeconds: 60,
    refreshWindowMinutes: 8, dailyPointerLimit: 28, autoBuyPointers: false, pointerDailyDiamondLimit: 0,
    profitLimit: 0, firstDepartureMode: 'smart', firstDepartureTime: '10:00', firstDepartureWaitMinutes: 29,
    autoUpgrade: false, upgradeCoinValuePerDiamond: 100, upgradeMinReturnPercent: 150, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300 },
  loop: { rounds: 0, everySeconds: 60, tasks: true, dailies: true, world: true, heroes: false },
  building: { enabled: true, collect: true, build: true, upgrade: true, finish: true, supply: false, disabledTypes: [], speedUp: true, keepBlueprints: 0, maxBuilds: 5, maxUpgrades: 2 },
  factory: { enabled: true, gain: true, produce: true, cooperateNative: false, disabledTypes: [], keepStock: 50, demandFirst: true, demandPriority: DEMAND_SOURCES.map(([id]) => id), speedUpSources: [], speedUp: true, speedUpItems: [] },
  farm: { enabled: false, harvest: true, autoPlant: true, customPlant: false, crops: [], speedUp: false },
  // The new master gate preserves legacy selections; no individual task is enabled by it.
  gather: { enabled: true, fishing: false, fishBook: false, floaters: false, antiqueFloaters: false, continueWhenFull: false, diving: false, keyOpen: false, salvage: false, upgradeFishing: false, upgradeDiving: false, upgradeSalvage: false, targetLevel: 2, fishingGoldReserve: 10000 },
  resident: { enabled: true, skipCrops: false, skipProduction: false, blockedMaterials: [], minExp: 0, minGold: 0, dailyCap: 0, rewards: true, reroll: false },
  cargo: { enabled: false, dailyLoadLimit: 0 },
  events: { enabled: false, otherOption: 1 },
  pet: { release: false, releaseQualities: [], enabled: false, claim: true, breed: false, species: [], quality: 'BLUE', universal: false, feed: false, advance: false },
  museum: { enabled: false, upgrade: false, factor: 1, materialFactor: false, factorMaterials: [], stockThreshold: 0, matchedFactor: 1, maps: [], useGuide: false, dailyGuideLimit: 0 },
  resources: { keepAccelerators: 0, allowDiamonds: false, diamondThreshold: 0, diamondDailyLimit: 2000 },
  // noPrivilege 仅保留旧配置/导出的兼容字段；无权益账号统一走等待领取。
  ads: { noPrivilege: true, waitSeconds: 15 },
  gold: { enabled: false, times: 3 },
  heroes: { enabled: true, level: true, star: true, skill: true, heroIds: [], universal: true, keepExp: 0, targetLevel: 0, targetStar: 0 },
  dailies: { enabled: true, claimTasks: true, claimDailyChest: true, claimWeeklyChest: true, claimGift: true },
  tasks: { main: true, branch: true, achievements: true },
  progression: { enabled: true, mainline: false, trials: false, raidIds: ['1','2','3'], maxFailures: 3 },
  trials: { paid: false, ads: false, raidIds: ['1','2','3'], paidPerRaidLimit: 1, dailyDiamondBudget: 450, maxSingleCost: 50 },
  fleetDispatch: { priority: ['cityWar','pirateHunt','worldBoss','follow','treasure','radar','silicon'] },
  worldBoss: { enabled: false, fleetIds: [], minDurabilityPercent: 80, petrolReserve: 0 },
  radar: { enabled:false, fleetIds:[], types:['pirate','collect','refugee','spy','fixed'], allowMaterials:false, minDurabilityPercent:80, petrolReserve:1000, dailyPetrolLimit:10000, checkEverySeconds:30 },
  pirateSweep: { type: '1' },
  pirateHunt: { enabled: false, maxFailures: 3, fleetIds: [], types: [], maxLevel: 0, minDurabilityPercent: 80, petrolReserve: 0, fuelBudget: 10000, checkEverySeconds: 15 },
  treasure: { enabled: false, autoJoin: true, onlyTenThousand: true, follow: false, fleetIds: [], followNames: [], followPlayerIds: [], avoidPlayerIds: [],
    rewardItems: [], avoidNames: [], allowHostile: false, minDurabilityPercent: 80, petrolReserve: 0,
    maxProgress: 90, personalProgressLimit: 20, dailyDispatchLimit: 0, checkEverySeconds: 15, participationMode: 'untilFull', repeatAttack: true,
    autoRepair: true, maxRepairCost: 15000, dailyRepairPetrolLimit: 20000 },
  cityWar: { enabled: false, fleetIds: [], targetMode: 'alliance', targetPriority: 'fewestAllied', cityRefs: [], autoRepair: true,
    nativeCommissionLimit: -1, repairBelowPercent: 80, petrolReserve: 0, maxRepairCost: 15000, dailyPetrolLimit: 20000,
    dailyDispatchLimit: 10, reserveDuringWar: true, checkEverySeconds: 15 },
  forge: { decompose: false, decomposeQualities: [], enabled: false, buildingIds: [], recipeIds: [], universal: false, materialReserve: 0,
    universalReserve: 0, goldReserve: 0, dailyLimit: 5, dailyGoldLimit: 100000, checkEverySeconds: 30 },
  antique: { enabled: false, activate: false, activateQualities: [], star: false, starQualities: [], targetStar: 0, universal: false,
    master: false, targetMasterLevel: 0, suit: false, suitQualities: [], goldReserve: 0, dailyGoldLimit: 20000,
    maxActions: 20, checkEverySeconds: 60 },
};

const int = (max = 1_000_000_000, min = 0) => ({ kind: 'number', min, max });
const strings = (max = 300) => ({ kind: 'list', max });
const constraints = {
  ...EXTENDED_CONSTRAINTS,
  ...Object.fromEntries([0, 1, 2].flatMap(index => Object.entries(SILICON_FLEET_NUMBERS).map(([key, rule]) => ['silicon.fleets.' + index + '.' + key, rule]))),
  'login.intervalSeconds': int(86400, 1), 'login.jitterSeconds': int(86400),
  'login.quietIntervalSeconds': int(86400, 1), 'login.maxRetries': int(10000, 1),
  'login.quietStart': { kind: 'time' }, 'login.quietEnd': { kind: 'time' },
  'eventActions.compassThreshold':int(999999,1), 'eventActions.compassDrawCount':int(50,1),
  'merchant.quoteMaxAgeSeconds': int(86400, 1), 'merchant.estimateDiscountPercent': int(100),
  'merchant.refreshWaitSeconds': int(3600), 'merchant.liquidationMinutes': int(1440), 'merchant.maxLossPercent': int(100),
  'merchant.minExpectedProfit': int(1000000000, 1), 'merchant.speedUpMinProfit': int(1000000000, 1), 'merchant.keepPointers': int(1000000),
  'merchant.speedUpMode': { kind: 'choice', values: ['deadline', 'profit', 'refresh', 'arrival'] }, 'merchant.speedUpMaxPerLeg': int(100, 1),
  'merchant.refreshWindowMinutes': int(30, 1), 'merchant.dailyPointerLimit': int(1000), 'merchant.pointerDailyDiamondLimit': int(100000),
  'merchant.profitLimit': int(1000000000), 'merchant.firstDepartureMode': { kind: 'choice', values: ['smart', 'time'] },
  'merchant.firstDepartureTime': { kind: 'time' }, 'merchant.firstDepartureWaitMinutes': int(120),
  'merchant.monitorSeconds': int(300, 10), 'merchant.upgradeCoinValuePerDiamond': int(1000000, 1),
  'merchant.upgradeMinReturnPercent': int(10000, 100), 'merchant.upgradeMaxLevel': int(5, 1), 'merchant.upgradeDailyDiamondLimit': int(100000),
  'ads.waitSeconds':int(120,5),
  'fleetDispatch.priority': {...strings(7),values:['cityWar','pirateHunt','worldBoss','follow','treasure','radar','silicon']},
  'worldBoss.fleetIds': strings(10), 'worldBoss.minDurabilityPercent': int(100), 'worldBoss.petrolReserve': int(),
  'events.otherOption': int(2,1), 'radar.fleetIds': strings(10), 'radar.types': {...strings(5),values:['pirate','collect','refugee','spy','fixed']},
  'radar.minDurabilityPercent':int(100), 'radar.petrolReserve':int(), 'radar.dailyPetrolLimit':int(), 'radar.checkEverySeconds':int(300,10),
  'loop.rounds': int(100000), 'loop.everySeconds': int(86400, 1),
  'building.keepBlueprints': int(), 'building.maxBuilds': int(100), 'building.maxUpgrades': int(100),
  'building.disabledTypes': strings(), 'factory.disabledTypes': strings(), 'factory.keepStock': int(100000),
  'factory.demandPriority': { ...strings(12), values: DEMAND_SOURCES.map(([id]) => id) },
  'factory.speedUpSources': { ...strings(12), values: DEMAND_SOURCES.map(([id]) => id) },
  'factory.speedUpItems': strings(), 'farm.crops': { kind: 'crops' }, 'gather.targetLevel': int(1000, 1), 'gather.fishingGoldReserve': int(),
  'resident.blockedMaterials': strings(), 'resident.minExp': int(), 'resident.minGold': int(), 'resident.dailyCap': int(),
  'pet.releaseQualities': { ...strings(4), values: ['BLUE','PURPLE','ORANGE','RED'] },
  'forge.decomposeQualities': { ...strings(5), values: ['GREEN','BLUE','PURPLE','ORANGE','RED'] },
  'cargo.dailyLoadLimit': int(), 'pet.species': strings(), 'pet.quality': { kind: 'choice', values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'museum.factor': int(3, 1), 'museum.factorMaterials': strings(), 'museum.stockThreshold': int(), 'museum.matchedFactor': int(3, 1),
  'museum.maps': strings(), 'museum.dailyGuideLimit': int(), 'resources.keepAccelerators': int(), 'resources.diamondThreshold': int(),
  'resources.diamondDailyLimit': int(), 'gold.times': int(1000), 'heroes.heroIds': strings(), 'heroes.keepExp': int(),
  'heroes.targetLevel': int(10000), 'heroes.targetStar': int(1000),
  'trials.raidIds': { ...strings(3), values: ['1','2','3'] }, 'trials.paidPerRaidLimit': int(100),
  'trials.dailyDiamondBudget': int(100000), 'trials.maxSingleCost': int(10000),
  'progression.raidIds': { ...strings(3), values: ['1','2','3'] }, 'progression.maxFailures': int(100, 1),
  'pirateHunt.maxFailures': int(100, 1),
  'pirateSweep.type': {kind:'choice',values:['1','2','3']},
  'pirateHunt.fleetIds': strings(10), 'pirateHunt.types': strings(20), 'pirateHunt.maxLevel': int(1000),
  'pirateHunt.minDurabilityPercent': int(100), 'pirateHunt.petrolReserve': int(), 'pirateHunt.fuelBudget': int(), 'pirateHunt.checkEverySeconds': int(60, 5),
  'treasure.fleetIds': strings(10), 'treasure.followNames': strings(30), 'treasure.followPlayerIds': strings(30),
  'treasure.rewardItems': strings(100), 'treasure.avoidNames': strings(30),
  'treasure.minDurabilityPercent': int(100), 'treasure.petrolReserve': int(), 'treasure.maxProgress': int(100, 1),
  'treasure.personalProgressLimit': int(100),
  'treasure.dailyDispatchLimit': int(1000), 'treasure.checkEverySeconds': int(300, 5),
  'treasure.avoidPlayerIds': strings(100), 'treasure.participationMode': { kind: 'choice', values: ['untilFull', 'always'] },
  'treasure.maxRepairCost': int(10000000), 'treasure.dailyRepairPetrolLimit': int(100000000),
  'cityWar.fleetIds': strings(10), 'cityWar.targetMode': { kind: 'choice', values: ['alliance', 'selected'] },
  'cityWar.targetPriority': { kind: 'choice', values: ['fewestAllied', 'original'] },
  'cityWar.cityRefs': strings(100), 'cityWar.nativeCommissionLimit': { kind: 'number', min: -1, max: 1000 },
  'cityWar.repairBelowPercent': int(100, 1), 'cityWar.petrolReserve': int(),
  'cityWar.maxRepairCost': int(10000000), 'cityWar.dailyPetrolLimit': int(100000000),
  'cityWar.dailyDispatchLimit': int(1000, 1), 'cityWar.checkEverySeconds': int(300, 5),
  'forge.buildingIds': strings(10), 'forge.recipeIds': strings(100), 'forge.materialReserve': int(),
  'forge.universalReserve': int(), 'forge.goldReserve': int(), 'forge.dailyLimit': int(1000, 1),
  'forge.dailyGoldLimit': int(1000000000, 1), 'forge.checkEverySeconds': int(300, 10),
  'antique.activateQualities': { ...strings(4), values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'antique.starQualities': { ...strings(4), values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'antique.suitQualities': { ...strings(4), values: ['BLUE', 'PURPLE', 'ORANGE', 'RED'] },
  'antique.targetStar': int(25), 'antique.targetMasterLevel': int(100), 'antique.goldReserve': int(),
  'antique.dailyGoldLimit': int(100000000), 'antique.maxActions': int(100, 1), 'antique.checkEverySeconds': int(3600, 10),
};

export class SettingsError extends Error {
  constructor(errors) {
    super(Object.values(errors)[0] || '设置不合法');
    this.name = 'SettingsError';
    this.fields = errors;
  }
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const copy = (value) => structuredClone(value);
export function defaultSettings() { return copy(DEFAULT_SETTINGS); }

// 兼容上游已有的快捷开关。未保存细化配置时，执行仍沿用上游行为。
const nativeFields = {
  stageAuto: ['progression.mainline'],
  trialPaidSweep: ['trials.paid'], trialAdSweep: ['trials.ads'],
  diveEnhance: ['gather.upgradeDiving'], autoDive: ['gather.diving'], salvageEnhance: ['gather.upgradeSalvage'],
  autoSalvage: ['gather.salvage'], autoFish: ['gather.fishing'], fishEnhance: ['gather.upgradeFishing'],
  floaters: ['gather.floaters'], antiqueFloaters: ['gather.antiqueFloaters'], cargo: ['cargo.enabled'], farm: ['farm.enabled'],
  collect: ['building.collect', 'factory.gain'], finishUpgrade: ['building.finish'], build: ['building.build'],
  buildSupply: ['building.supply'],
  upgrade: ['building.upgrade'], finishOrder: ['resident.enabled'], startProduce: ['factory.produce'],
  speedUp: ['building.speedUp', 'factory.speedUp'], denyOrder: ['resident.reroll'], paidGold: ['gold.enabled'],
  dailyRewards: ['dailies.claimTasks'], chests: ['dailies.claimDailyChest', 'dailies.claimWeeklyChest'], gift: ['dailies.claimGift'],
  tasks: ['loop.tasks', 'resident.rewards'],
};
export function applyNativeTask(settings, key, enabled) {
  const result = copy(settings);
  if (Object.hasOwn(result.schedule, key)) result.schedule[key] = enabled;
  for (const field of nativeFields[key] ?? []) { const [group, name] = field.split('.'); result[group][name] = enabled; }
  if (key === 'speedUp' && !enabled) {
    result.factory.speedUpSources = [];
    result.farm.speedUp = false;
  }
  return result;
}
export function settingsFromNative(tasks, { rounds = 0, everySeconds = 60, fishingGoldReserve = 10000 } = {}) {
  let result = defaultSettings();
  for (const [key, value] of Object.entries(taskSettings(tasks))) result = applyNativeTask(result, key, value);
  result.loop.rounds = rounds;
  result.loop.everySeconds = Math.max(1, Number.isSafeInteger(everySeconds) ? everySeconds : 60);
  result.gather.fishingGoldReserve = fishingGoldReserve;
  return result;
}
export function nativeTaskValues(settings, current) {
  const result = { ...current, ...settings.schedule };
  for (const [key, fields] of Object.entries(nativeFields)) result[key] = fields.some(field => { const [group, name] = field.split('.'); return settings[group][name]; });
  result.startProduce = settings.factory.produce || settings.factory.cooperateNative;
  result.speedUp = settings.building.speedUp || settings.factory.speedUp || settings.farm.speedUp || settings.factory.speedUpSources.length > 0;
  return result;
}

export function hasExtraWork(settings) {
  if (settings?.alliance?.enabled || settings?.heroRaid?.enabled || settings?.silicon?.enabled) return true;
  return !!settings && ((settings.loop.world && (settings.museum.enabled || settings.museum.upgrade || settings.events.enabled || settings.pet.enabled || (settings.gather.enabled !== false && settings.gather.diving && settings.gather.keyOpen))) || (settings.loop.heroes && settings.heroes.enabled)
    || (settings.progression?.enabled && (settings.progression.mainline || settings.progression.trials)) || settings.pirateHunt?.enabled);
}
export function hasBaseWork(settings) {
  return !!settings && ((settings.loop.world && (settings.museum.enabled || settings.museum.upgrade || settings.events.enabled ||
    settings.pet.enabled || (settings.gather.enabled !== false && settings.gather.diving && settings.gather.keyOpen))) ||
    (settings.loop.dailies && settings.gold.enabled));
}
export function settingsUiRules() {
  return { controlFields: idleControlFields, controlGroups: Object.fromEntries(automationControls.flatMap(c=>c.fields.map(path=>[path,c.idleGroup??c.group]))), mappedTasks: Object.keys(nativeFields), numbers: Object.fromEntries(Object.entries(constraints).filter(([, rule]) => rule.kind === 'number').map(([key, rule]) => [key, { min: rule.min, max: rule.max }])) };
}

export function validateSettings(input, { partial = false, catalog = null } = {}) {
  const errors = Object.create(null);
  const output = defaultSettings();
  if (!plain(input)) throw new SettingsError({ settings: '配置必须是 JSON 对象' });
  for (const group of Object.keys(input)) if (!Object.hasOwn(DEFAULT_SETTINGS, group)) errors[group] = `不支持的设置分组：${group}`;
  for (const [group, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(input, group)) { if (!partial) errors[group] = `缺少设置分组：${group}`; continue; }
    if (!plain(input[group])) { errors[group] = `${group} 必须是对象`; continue; }
    for (const key of Object.keys(input[group])) if (!Object.hasOwn(defaults, key)) errors[`${group}.${key}`] = `不支持的设置项：${group}.${key}`;
    for (const [key, initial] of Object.entries(defaults)) {
      const name = `${group}.${key}`;
      if (!Object.hasOwn(input[group], key)) { if (!partial) errors[name] = '缺少此设置项'; continue; }
      const value = input[group][key];
      const rule = constraints[name];
      if (typeof initial === 'boolean') {
        if (typeof value !== 'boolean') errors[name] = '开关值必须为 true 或 false';
        else output[group][key] = value;
      } else if (rule?.kind === 'number') {
        if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) errors[name] = `请输入 ${rule.min}–${rule.max} 之间的整数`;
        else output[group][key] = value;
      } else if (rule?.kind === 'choice') {
        if (!rule.values.includes(value)) errors[name] = '请选择有效选项';
        else output[group][key] = value;
      } else if (rule?.kind === 'time') {
        if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) errors[name] = '请输入有效时间（HH:mm）';
        else output[group][key] = value;
      } else if (rule?.kind === 'list') {
        if (!Array.isArray(value) || value.length > rule.max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 120) || new Set(value).size !== value.length) errors[name] = '选项必须为不重复的有效列表';
        else if (rule.values && value.some(v => !rule.values.includes(v))) errors[name] = '列表中含有不支持的选项';
        else output[group][key] = [...value];
      } else if (rule?.kind === 'siliconFleets') {
        const fleets = validateSiliconFleets(value, errors, catalog);
        if (fleets) output[group][key] = fleets;
      } else if (rule?.kind === 'crops') {
        if (!Array.isArray(value) || value.length > 100) errors[name] = '作物列表不合法';
        else {
          const ids = new Set();
          for (const row of value) {
            if (!plain(row) || Object.keys(row).some(k => !['id', 'target'].includes(k)) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 120 || ids.has(row.id) || !Number.isSafeInteger(row.target) || row.target < 0 || row.target > 100000) { errors[name] = '作物不能重复，备货数量必须是 0–100000 的整数'; break; }
            ids.add(row.id);
          }
          if (!errors[name]) output[group][key] = copy(value);
        }
      }
    }
  }
  if (!Object.hasOwn(input, 'progression')) output.progression.mainline = input.schedule?.stageAuto === true;
  if (output.progression.trials && !output.progression.raidIds.length) errors['progression.raidIds'] = '请选择自动推关的试炼副本';
  if (output.pirateHunt.enabled && !output.pirateHunt.fleetIds.length) errors['pirateHunt.fleetIds'] = '请选择自动讨伐海盗的舰队';
  if(output.forge.decompose && !output.forge.decomposeQualities.length)errors['forge.decomposeQualities']='请选择可自动分解的装备品质';
  if(output.pet.release && !output.pet.releaseQualities.length)errors['pet.releaseQualities']='请选择可自动放生的海兽品质';
  if (output.antique.enabled && ![output.antique.activate, output.antique.star, output.antique.master, output.antique.suit].some(Boolean)) errors['antique.enabled'] = '请至少开启一项藏品养成动作';
  if (output.antique.activate && !output.antique.activateQualities.length) errors['antique.activateQualities'] = '请选择自动激活的藏品品质';
  if (output.antique.star && !output.antique.starQualities.length) errors['antique.starQualities'] = '请选择自动升星的藏品品质';
  if (output.antique.suit && !output.antique.suitQualities.length) errors['antique.suitQualities'] = '请选择自动升级的藏品套装品质';
  if (['cityWar','pirateHunt','treasure','radar'].some(k=>!output.fleetDispatch.priority.includes(k))) errors['fleetDispatch.priority']='请保留全部任务，只调整顺序';
  for(const key of ['worldBoss','follow','silicon'])if(!output.fleetDispatch.priority.includes(key))output.fleetDispatch.priority.push(key);
  if (output.silicon.windows.some(value => !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value))) errors['silicon.windows'] = '时段格式为 HH:mm-HH:mm，每行一个；支持跨午夜';
  if (output.pirateHunt.fleetIds.some(value=>! /^[1-9]\d*远征船$/.test(value))) errors['pirateHunt.fleetIds']='请选择有效的海盗首杀舰队';
  if (output.pirateHunt.types.some(value=>! /^[1-9]\d*$/.test(value))) errors['pirateHunt.types']='请选择有效的海盗类型';
  if (![1,5,10,50].includes(output.eventActions.compassDrawCount)) errors['eventActions.compassDrawCount']='请选择1、5、10或50次';
  if (output.farm.autoPlant && output.farm.customPlant) errors['farm.customPlant'] = '自动种植和自定义种植只能开启一种';
  if (output.factory.speedUpSources.some(source => !output.factory.demandPriority.includes(source))) errors['factory.speedUpSources'] = '加速来源必须保留在需求优先级列表中';
  if (output.farm.customPlant && !output.farm.crops.length) errors['farm.crops'] = '启用自定义种植前，请至少添加一种作物';
  if (output.pet.enabled && output.pet.breed && !output.pet.species.length) errors['pet.species'] = '启用自动培育前，请选择培育种类';
  if (output.treasure.enabled && !output.treasure.autoJoin && !output.treasure.follow) errors['treasure.autoJoin'] = '请至少开启自动参加或跟随指定玩家';
  if (output.treasure.enabled && !output.treasure.fleetIds.length) errors['treasure.fleetIds'] = '请明确选择参与巨轮的舰队，空名单不会派遣';
  if (output.treasure.follow && !output.treasure.followNames.length && !output.treasure.followPlayerIds.length && !errors['treasure.followNames'] && !errors['treasure.followPlayerIds']) errors['treasure.followNames'] = '开启跟随前，请添加玩家完整昵称或角色ID';
  for (const field of ['followNames', 'avoidNames']) if (output.treasure[field].some(value => value !== value.trim() || value.length > 40 || /[\r\n\u0000-\u001f]/.test(value))) errors['treasure.' + field] = '请输入不重复的完整昵称，每项不超过40字符，不含首尾空格或换行';
  for (const field of ['followPlayerIds', 'avoidPlayerIds']) if (output.treasure[field].some(value => !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > (1n << 63n) - 1n)) errors['treasure.' + field] = '角色ID必须为完整的正整数文本，不能使用科学计数法';
  if (output.treasure.fleetIds.some(value => !/^[1-9]\d*远征船$/.test(value))) errors['treasure.fleetIds'] = '请选择有效的远征舰队';
  if (output.cityWar.enabled && !output.cityWar.fleetIds.length) errors['cityWar.fleetIds'] = '请明确选择参与城战接续的舰队';
  if (output.cityWar.fleetIds.some(value => !/^[1-9]\d*远征船$/.test(value))) errors['cityWar.fleetIds'] = '请选择有效的远征舰队';
  if (output.cityWar.enabled && output.cityWar.targetMode === 'selected' && !output.cityWar.cityRefs.length) errors['cityWar.cityRefs'] = '指定目标模式至少选择一座城市';
  if (output.cityWar.cityRefs.some(value => !/^[1-9]\d{0,3}:[1-9]\d{0,5}$/.test(value))) errors['cityWar.cityRefs'] = '城市选项必须包含有效场景和城市编号';
  if (output.forge.enabled && !output.forge.buildingIds.length) errors['forge.buildingIds'] = '请选择装备锻造工厂';
  if (output.forge.enabled && !output.forge.recipeIds.length) errors['forge.recipeIds'] = '请选择至少一种锻造配方';
  if (output.forge.recipeIds.some(value => !/^[1-9]\d{0,8}$/.test(value))) errors['forge.recipeIds'] = '请选择有效的锻造配方';
  if (catalog) {
    for (const [name, collection] of Object.entries({
      'building.disabledTypes': 'buildings', 'factory.disabledTypes': 'factories', 'factory.speedUpItems': 'materials',
      'resident.blockedMaterials': 'materials', 'museum.factorMaterials': 'materials', 'museum.maps': 'maps',
      'heroes.heroIds': 'heroes', 'pet.species': 'petSpecies',
      'treasure.fleetIds': 'expeditionFleets', 'treasure.rewardItems': 'materials',
      'cityWar.fleetIds': 'expeditionFleets', 'cityWar.cityRefs': 'cityTargets',
      'radar.fleetIds':'expeditionFleets','worldBoss.fleetIds':'expeditionFleets',
      'pirateHunt.fleetIds': 'expeditionFleets', 'pirateHunt.types': 'pirateTypes',
      'forge.buildingIds': 'forgeBuildings', 'forge.recipeIds': 'forgeRecipes',
      'alliance.allowedMaterials': 'materials', 'alliance.blockedMaterials': 'materials',
      'alliance.requestMaterials': 'materials', 'alliance.techIds': 'guildTech',
      'guildShip.rewardItems': 'materials', 'guildShip.disabledMaterials': 'materials', 'guildFort.materials': 'materials',
    })) {
      const [group, key] = name.split('.');
      const allowed = new Set((catalog[collection] ?? []).map(v => String(v.value)));
      if (output[group][key].some(v => !allowed.has(v))) errors[name] = '包含当前游戏配置中不存在的选项，请重新选择';
    }
    const crops = new Set((catalog.crops ?? []).map(v => v.value));
    if (output.farm.crops.some(v => !crops.has(v.id))) errors['farm.crops'] = '包含当前游戏中不存在的作物';
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);
  output.ads.noPrivilege = true;
  output.schedule = nativeTaskValues(output, output.schedule);
  return output;
}

export function settingsCatalog(config) {
  const rows = name => config?.tables?.[name]?.data ?? [];
  const option = (value, label = value) => ({ value: String(value), label: String(label) });
  const unique = list => [...new Map(list.map(x => [x.value, x])).values()];
  const buildable = new Set(rows('BuildingUnlockCfg').map(r => r.buildingType));
  const buildings = unique(rows('BuildingCfg').filter(r => !buildable.size || buildable.has(r.buildingType)).map(r => option(r.buildingType, r.name || r.buildingType)));
  const counts = new Map();
  for (const item of buildings) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  for (const item of buildings) if (counts.get(item.label) > 1) item.label += `（${item.value}）`;
  const factoryTypes = new Set(rows('BuildingProduceCfg').map(r => r.buildType));
  const materials = unique([...rows('ItemCfg').map(r => option(r.id, r.show_name || r.showName || r.name || r.id)), ...rows('ResourceCfg').map(r => option(r.id, r.show_name || r.id))]);
  return {
    buildings, factories: buildings.filter(r => factoryTypes.has(r.value)),
    guildTech: unique(rows('GuildTechCfg').map(r => option(r.techId, r.name || '科技 ' + r.techId))),
    materials, treasureRewards: treasureRewardOptions(config, materials),
    crops: rows('FarmlandPlantCfg').map(r => option(r.id)),
    maps: rows('MuseumExpeditionStageCfg').map(r => option(r.stageId, r.name)),
    heroes: rows('HeroCfg').filter(r => r.universalItemId || r.quality).map(r => option(r.id, r.showName || r.id)),
    petSpecies: unique(rows('PetBreedCfg').map(r => option(r.spId, rows('PetSpeciesCfg').find(s => s.id === r.spId || s.spId === r.spId)?.name || `海兽种类 ${r.spId}`))),
    radarTypes: [['pirate','击退海盗'],['collect','收集资源'],['refugee','解救难民'],['spy','城战试探'],['fixed','固定情报']].map(([value,label])=>option(value,label)),
    pirateTypes: unique(rows('WorldPirateCfg').map(r=>option(r.type,r.showName))),
    trialRaids: rows('TrialRaidCfg').map(r => option(r.raidId, r.title)),
    demandSources: DEMAND_SOURCES.map(([value, label]) => option(value, label)),
    expeditionFleets: rows('BuildingUnlockCfg').filter(r => r.buildingType === '远征船' && /^[1-9]\d*远征船$/.test(r.buildingId)).map(r => option(r.buildingId, '远征舰队 ' + r.buildingId.replace('远征船', '') + ' 队')),
    cityTargets: Object.entries(config?.tables ?? {}).filter(([name]) => /^\d+_CityCfg$/.test(name)).flatMap(([name, table]) => (table.data ?? []).map(row => option(name.split('_')[0] + ':' + row.id, '场景' + name.split('_')[0] + ' · ' + row.name + '（' + row.id + '）'))),
    forgeBuildings: rows('BuildingUnlockCfg').filter(r => r.buildingType === '装备厂').map(r => option(r.buildingId, r.buildingId)),
    equipQualities: [['GREEN','绿色'],['BLUE','蓝色'],['PURPLE','紫色'],['ORANGE','橙色'],['RED','红色']].map(([v,n])=>option(v,n)),
    petQualities: [['BLUE','蓝色'],['PURPLE','紫色'],['ORANGE','橙色'],['RED','红色']].map(([v,n])=>option(v,n)),
    antiqueQualities: [['BLUE','蓝色'],['PURPLE','紫色'],['ORANGE','橙色'],['RED','红色']].map(([v,n])=>option(v,n)),
    forgeRecipes: rows('BuildingEquipMakeCfg').map(r => option(r.makeId, r.type + ' · ' + (r.costItem ?? []).map(([id, num]) => (config?.materialName?.(id) || id) + '×' + num).join('、') + ' · 赛季' + r.season + '起')),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取${path.basename(file)}，为保护已保存设置与额度，已停止本次操作`); }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function accountKey(accountId) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(accountId)) throw new Error('账号标识不合法');
  return accountId;
}

export function loadAutomationSettings(accountId, { file = settingsFile() } = {}) {
  const key = accountKey(accountId);
  const store = readJson(file, { version: 1, accounts: {} });
  if (store.version !== 1 || !plain(store.accounts)) throw new Error('设置文件格式不支持，未覆盖原文件');
  const entry = Object.hasOwn(store.accounts, key) ? store.accounts[key] : null;
  return { settings: entry ? validateSettings(entry.settings, { partial: true }) : defaultSettings(), revision: entry?.revision ?? 0, savedAt: entry?.savedAt ?? null };
}

export function saveAutomationSettings(accountId, input, { revision, file = settingsFile(), catalog = null } = {}) {
  const settings = validateSettings(input, { catalog });
  const key = accountKey(accountId);
  const store = readJson(file, { version: 1, accounts: {} });
  if (store.version !== 1 || !plain(store.accounts)) throw new Error('设置文件格式不支持，未覆盖原文件');
  const current = Object.hasOwn(store.accounts, key) ? store.accounts[key] : null;
  if (!Number.isSafeInteger(revision) || revision !== (current?.revision ?? 0)) throw new SettingsError({ revision: '设置已在其他页面更新，请重新载入后再保存' });
  const entry = { revision: revision + 1, savedAt: new Date().toISOString(), settings };
  Object.defineProperty(store.accounts, key, { value: entry, enumerable: true, configurable: true, writable: true });
  atomicJson(file, store);
  return copy(entry);
}

export function exportAutomationSettings(settings) { return { format: SETTINGS_FORMAT, version: 1, settings: validateSettings(settings) }; }
export function importAutomationSettings(document, options) {
  if (!plain(document) || ![SETTINGS_FORMAT, LEGACY_SETTINGS_FORMAT].includes(document.format) || document.version !== 1 || Object.keys(document).some(k => !['format', 'version', 'settings'].includes(k))) throw new SettingsError({ import: '请选择本工具导出的配置文件（版本 1），文件不能包含账号或凭据' });
  // 原版本1导出没有巨轮分组，只补新增默认值；既有分组仍严格校验。
  const input = plain(document.settings) ? { ...document.settings } : document.settings;
  if (plain(input) && !Object.hasOwn(input, 'progression')) input.progression = { ...DEFAULT_SETTINGS.progression, mainline: input.schedule?.stageAuto === true };
  if (plain(input?.pirateHunt)) input.pirateHunt = { ...DEFAULT_SETTINGS.pirateHunt, ...input.pirateHunt };
  if (plain(input)) for (const group of ['login', 'treasure', 'cityWar', 'forge', 'antique', 'trials', 'pirateHunt', 'radar','worldBoss','pirateSweep','eventActions','merchant','ads']) if (!Object.hasOwn(input, group)) input[group] = copy(DEFAULT_SETTINGS[group]);
  if (plain(input?.login)) input.login = { ...DEFAULT_SETTINGS.login, ...input.login };
  if (plain(input?.merchant)) input.merchant = { ...DEFAULT_SETTINGS.merchant, ...input.merchant };
  if (plain(input)) for (const group of Object.keys(EXTENDED_DEFAULTS)) {
    if (!Object.hasOwn(input, group)) input[group] = copy(DEFAULT_SETTINGS[group]);
    else if (plain(input[group])) input[group] = { ...copy(DEFAULT_SETTINGS[group]), ...input[group] };
  }
  if (plain(input?.antique)) input.antique = { ...DEFAULT_SETTINGS.antique, ...input.antique };
  if (plain(input?.treasure)) {
    input.treasure = { ...input.treasure };
    for (const key of ['onlyTenThousand', 'avoidPlayerIds', 'participationMode', 'repeatAttack', 'autoRepair', 'maxRepairCost', 'dailyRepairPetrolLimit', 'personalProgressLimit']) {
      if (!Object.hasOwn(input.treasure, key)) input.treasure[key] = copy(DEFAULT_SETTINGS.treasure[key]);
    }
  }
  if (plain(input?.cityWar) && !Object.hasOwn(input.cityWar, 'targetPriority')) input.cityWar = { ...input.cityWar, targetPriority: DEFAULT_SETTINGS.cityWar.targetPriority };
  if (plain(input?.cityWar) && !Object.hasOwn(input.cityWar, 'nativeCommissionLimit')) input.cityWar = { ...input.cityWar, nativeCommissionLimit: DEFAULT_SETTINGS.cityWar.nativeCommissionLimit };
  if (plain(input?.schedule) && !Object.hasOwn(input.schedule, 'worldOnlineRewards')) input.schedule = { ...input.schedule, worldOnlineRewards: false };
  if (plain(input?.schedule)) input.schedule = { ...taskSettings(), ...input.schedule };
  if (plain(input?.events)) input.events = {otherOption:1,...input.events};
  if (plain(input?.pet)) input.pet={release:false,releaseQualities:[],...input.pet};
  if (plain(input?.forge)) input.forge={decompose:false,decomposeQualities:[],...input.forge};
  if (plain(input?.gather)) input.gather = { enabled:true, fishBook:false, antiqueFloaters: false, ...input.gather };
  return validateSettings(input, options);
}

export function beijingDay(now = Date.now()) { return new Date(now + 8 * 3600_000).toISOString().slice(0, 10); }

// 用量在发送前占用；未收到确定结果时保留额度，避免网络超时或重启造成重复消费。
export function createUsageLedger(accountId, { file = usageFile(), now = Date.now } = {}) {
  const key = accountKey(accountId);
  const read = () => {
    const store = readJson(file, { version: 1, accounts: {} });
    if (store.version !== 1 || !plain(store.accounts)) throw new Error('额度账本格式异常，已停止消费动作');
    const day = beijingDay(now());
    let entry = Object.hasOwn(store.accounts, key) ? store.accounts[key] : null;
    if (entry && (!plain(entry.counters) || !plain(entry.pending) || !plain(entry.confirmed))) throw new Error('额度账本损坏，已停止消费动作');
    if (entry?.keys != null && !plain(entry.keys)) throw new Error('派遣记录损坏，已停止消费动作');
    if (!entry || entry.day !== day) {
      // 每日统计换日，未决派遣不换日；保留汽油占用与待确认状态，且不计入新一天的出征次数。
      const pending = {};
      for (const [id, reservation] of Object.entries(entry?.pending ?? {})) {
        if (reservation.uniqueKey) pending[id] = { ...reservation, day: reservation.day ?? entry.day };
      }
      entry = { day, counters: {}, pending, confirmed: {}, keys: entry?.keys ?? {} };
    }
    if (!plain(entry.counters) || !plain(entry.pending) || !plain(entry.confirmed) || (entry.keys != null && !plain(entry.keys))) throw new Error('额度账本损坏，已停止消费动作');
    entry.keys ??= {};
    Object.defineProperty(store.accounts, key, { value: entry, enumerable: true, writable: true, configurable: true });
    return { store, entry };
  };
  return {
    snapshot() { const { entry } = read(); return { day: entry.day, counters: { ...entry.counters }, uncertain: Object.keys(entry.pending).length }; },
    confirmedCounters() { return { ...read().entry.confirmed }; },
    hasKey(uniqueKey) { return Object.hasOwn(read().entry.keys, uniqueKey); },
    keyRecords() { return copy(read().entry.keys); },
    reservationTime(uniqueKey) {
      const { entry } = read();
      return entry.pending[entry.keys[uniqueKey]?.id]?.at ?? null;
    },
    pendingCounters() {
      const totals = {};
      for (const reservation of Object.values(read().entry.pending)) for (const [name, amount] of Object.entries(reservation.counters)) totals[name] = (totals[name] ?? 0) + amount;
      return totals;
    },
    resolveKey(uniqueKey, confirmed, details) {
      const { store, entry } = read();
      if (!Object.hasOwn(entry.keys, uniqueKey)) return;
      const record = entry.keys[uniqueKey];
      if (details !== undefined) {
        if (!plain(details)) throw new Error('任务记录内容不合法');
        record.details = copy(details);
      }
      if (confirmed) {
        const pending = entry.pending[record.id];
        if (pending) {
          if ((pending.day ?? entry.day) === entry.day) for (const [name, amount] of Object.entries(pending.counters)) entry.confirmed[name] = Number(entry.confirmed[name] ?? 0) + amount;
          delete entry.pending[record.id];
        }
        record.confirmed = true;
      } else record.expired = true;
      atomicJson(file, store);
    },
    reserve(counters, limits = {}, minimums = {}, { uniqueKey = null, details = null } = {}) {
      const { store, entry } = read();
      if (uniqueKey !== null) {
        if (typeof uniqueKey !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(uniqueKey) || ['__proto__', 'constructor', 'prototype'].includes(uniqueKey)) throw new Error('派遣记录标识不合法');
        if (Object.hasOwn(entry.keys, uniqueKey)) throw new Error('该目标已有派遣记录，已阻止重复发送');
      }
      if (details !== null && (!uniqueKey || !plain(details))) throw new Error('任务记录内容不合法');
      for (const [name, amount] of Object.entries(counters)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name) || !Number.isSafeInteger(amount) || amount < 0) throw new Error('消费计数不合法');
        const used = Math.max(Number(entry.counters[name] ?? 0), Number(minimums[name] ?? 0));
        if (!Number.isSafeInteger(used) || used < 0) throw new Error('历史消费计数不合法，已停止消费动作');
        if (limits[name] != null && used + amount > limits[name]) throw new Error(`达到今日上限：${({ diamonds: '钻石', residentOrders: '居民订单', cargoLoads: '贸易港装货', museumGuides: '探险指南', goldPaidTimes: '付费点金次数', treasureDispatches: '巨轮出征次数' })[name] ?? name}`);
      }
      const id = crypto.randomUUID();
      for (const [name, amount] of Object.entries(counters)) entry.counters[name] = Math.max(Number(entry.counters[name] ?? 0), Number(minimums[name] ?? 0)) + amount;
      entry.pending[id] = { at: now(), day: entry.day, counters: copy(counters), ...(uniqueKey ? { uniqueKey } : {}) };
      if (uniqueKey) entry.keys[uniqueKey] = { id, confirmed: false, ...(details ? { details: copy(details) } : {}) };
      atomicJson(file, store);
      return { id, day: entry.day };
    },
    updateKeyDetails(uniqueKey, details) {
      if (!plain(details)) throw new Error('任务记录内容不合法');
      const { store, entry } = read();
      if (!Object.hasOwn(entry.keys, uniqueKey)) throw new Error('任务记录已不存在');
      entry.keys[uniqueKey].details = copy(details);
      atomicJson(file, store);
    },
    releaseCompletedKey(uniqueKey) {
      const { store, entry } = read();
      const record = Object.hasOwn(entry.keys, uniqueKey) ? entry.keys[uniqueKey] : null;
      if (!record) return;
      if (!record.confirmed || Object.hasOwn(entry.pending, record.id)) throw new Error('待确认任务不可释放');
      delete entry.keys[uniqueKey];
      atomicJson(file, store);
    },
    confirm(ticket) {
      if (!ticket) return;
      const { store, entry } = read();
      if (!Object.hasOwn(entry.pending, ticket.id)) {
        const record = Object.values(entry.keys).find(value => value.id === ticket.id);
        if (record) { record.confirmed = true; atomicJson(file, store); }
        return;
      }
      if ((entry.pending[ticket.id].day ?? ticket.day) === entry.day) for (const [name, amount] of Object.entries(entry.pending[ticket.id].counters)) entry.confirmed[name] = Number(entry.confirmed[name] ?? 0) + amount;
      const uniqueKey = entry.pending[ticket.id].uniqueKey;
      if (uniqueKey && entry.keys[uniqueKey]?.id === ticket.id) entry.keys[uniqueKey].confirmed = true;
      delete entry.pending[ticket.id];
      atomicJson(file, store);
    },
    cancel(ticket) {
      if (!ticket) return;
      const { store, entry } = read();
      if (!Object.hasOwn(entry.pending, ticket.id)) {
        const uniqueKey = Object.keys(entry.keys).find(value => entry.keys[value].id === ticket.id);
        if (uniqueKey) { delete entry.keys[uniqueKey]; atomicJson(file, store); }
        return;
      }
      if ((entry.pending[ticket.id].day ?? ticket.day) === entry.day) for (const [name, amount] of Object.entries(entry.pending[ticket.id].counters)) entry.counters[name] = Math.max(0, Number(entry.counters[name] ?? 0) - amount);
      const uniqueKey = entry.pending[ticket.id].uniqueKey;
      if (uniqueKey && entry.keys[uniqueKey]?.id === ticket.id) delete entry.keys[uniqueKey];
      delete entry.pending[ticket.id];
      atomicJson(file, store);
    },
  };
}
