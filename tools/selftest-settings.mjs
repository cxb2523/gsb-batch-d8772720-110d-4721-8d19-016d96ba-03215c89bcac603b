import os from 'node:os';
// 参数功能专项验证。仅使用受控数据与本机虚构账号，不连接游戏、不读取真实凭据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { defaultSettings, validateSettings, saveAutomationSettings, loadAutomationSettings, exportAutomationSettings, importAutomationSettings, createUsageLedger, beijingDay, nativeTaskValues, applyNativeTask, settingsFromNative } from '../src/automation-settings.mjs';
import { createActionGuard, budgetPreview, exactAutomationId, automationWireId } from '../src/automation-policy.mjs';
import { planWorld, runWorld } from '../src/world.mjs';
import { planBaseAutomation, runBaseAutomation, watchBasePushes, gameSeason, previewNativeAutomation } from '../src/base-automation.mjs';
import { planHeroes } from '../src/heroes.mjs';
import { DAILY_DRIVERS, runDailies } from '../src/dailies.mjs';
import { serviceCargo } from '../src/cargo.mjs';
import { runLoop } from '../src/loop.mjs';

const parent = path.join(os.tmpdir(),'cw-parameter-test-runs');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-'));
const results = [];
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
};
const table = data => ({ data });
const config = { tables: {
  BuildingCfg: table([{ buildingType: '食品厂', name: '食品厂' }, { buildingType: '仓库', name: '仓库' }, { buildingType: '农田', name: '农田' }]),
  BuildingUnlockCfg: table([{ buildingId: '2仓库', buildingType: '仓库', playerLevel: 1, curPeople: 0, condition: [], consume: [['建筑蓝图', 3]] }]),
  BuildingUpgradeCfg: table([{ buildingType: '仓库', level: 1, effect: [] }, { buildingType: '仓库', level: 2, playerLevel: 1, curPeople: 0, condition: [], effect: [], consume: [['建筑蓝图', 3]], costTime: 30 }]),
  BuildingProduceCfg: table([{ itemId: '产品甲', buildType: '食品厂', unlockLevel: 1, costItem: [['木材', 1]], produceTime: 60 }, { itemId: '产品乙', buildType: '食品厂', unlockLevel: 1, costItem: [['木材', 1]], produceTime: 100 }]),
  FarmlandPlantCfg: table([{ id: '小麦', material: ['小麦种子', 1], time: 60, produceNum: 5 }, { id: '玉米', material: ['玉米种子', 1], time: 90, produceNum: 5 }]),
  MuseumExploreTimeFactorCfg: table([{ factor: 1, playerLevel: 1 }, { factor: 2, playerLevel: 30 }, { factor: 3, playerLevel: 40 }]),
  MuseumExpeditionStageCfg: table([{ stageId: 1, areaLevelReq: [], name: '灯塔' }, { stageId: 2, areaLevelReq: [], name: '图书馆' }]),
  MuseumExpeditionTeamCfg: table([{ playerLevel: 28, teamCount: 1 }]),
  MuseumExpeditionConditionCfg: table([{ conditionId: 1, heroCount: 1 }]),
  MuseumAreaIndicatorCfg: table([{ areaId: 1, level: 1, areaLevel: 1, upgradeCost: ['人气币', 100] }]),
  MuseumAreaCfg: table([{ areaId: 1, level: 2, playerLevelReq: 30, costArr: [['建筑蓝图', 2]] }]),
  MuseumAchievementCfg: table([{ score: 100, rewards: [] }]),
  PetSpeciesCfg: table([{ spId: 1, name: '海豚' }]),
  PetBreedCfg: table([{ petId: '蓝宠物1', spId: 1, season: 1, quality: 'BLUE', cost: [['基因甲', 2], ['GOLD', 10]] }]),
  OfflineParamCfg: table([{ paramName: '点金价格', paramValue: 10 }, { paramName: '免费点金次数', paramValue: 1 }]),
  EventChoiceCfg: table([{ eventId: 1007, title: '发现海上资源补给', option2: '建造居民房' }, { eventId: 1001, title: '其他事件' }]),
} };
function building(type, properties = {}) { return { buildingId: '1' + type, type, level: 1, factory: null, farm: null, product: [], buildStartTime: 0, buildFinishTime: 0, population: 0, ...properties }; }
function survey(stock = {}, buildings = [], orders = []) {
  const inventory = new Map(Object.entries(stock));
  return { now: 10000, serverNow: 10000, player: { level: 36 }, have: id => inventory.get(id) ?? 0, stock: inventory,
    buildings, factories: buildings.filter(b => b.factory), orders, notes: [], weekOrder: new Map(), cargoOrder: new Map(), orderCheckError: '',
    orderOfTheDay: { orderNum: 0, rewardedNum: 0 }, stockCap: 50, factorySlots: 1, population: 100, futurePopulation: 100, maxPopulation: 1000, autoFarming: false,
    autoProduceEndTime: 0, autoProduceForever: false, cropIds: new Set(['小麦', '玉米']), floaters: [], fleets: [] };
}
function quiet() {
  const settings = defaultSettings();
  settings.building.build = settings.building.upgrade = settings.building.speedUp = false;
  settings.factory.produce = settings.factory.speedUp = false;
  settings.resident.enabled = false;
  return settings;
}
function order(index, requirements) { return { index, orderKey: 'order-' + index, workerId: 1, textId: 1, workerName: '测试居民', requirements, missing: requirements,
  rewardExp: 700, rewardGold: 200, isSpecial: false, refreshTime: 0 }; }
function extra(world, properties = {}) { return { now: world.now, player: world.player, world, notes: [], museum: null, heroes: [], pets: [], choices: [], raids: [], choiceObserved: true, ...properties }; }

try {
  await check('输入类型、未知字段、互斥开关和导入边界', () => {
    const initial = defaultSettings(); assert.deepEqual(validateSettings(initial).building, initial.building);
    const a = defaultSettings(); a.resources.diamondDailyLimit = -1; assert.throws(() => validateSettings(a), /整数/);
    const b = defaultSettings(); b.building.enabled = 'false'; assert.throws(() => validateSettings(b), /true 或 false/);
    const c = defaultSettings(); c.farm.customPlant = true; assert.throws(() => validateSettings(c), /只能开启一种/);
    const d = defaultSettings(); d.factory.demandPriority = []; d.factory.speedUpSources = ['cargo']; assert.throws(() => validateSettings(d), /加速来源/);
    assert.throws(() => validateSettings(JSON.parse('{"__proto__":{"polluted":true}}'), { partial: true }), /不支持/);
    assert.equal({}.polluted, undefined);
    const document = exportAutomationSettings(initial); assert.deepEqual(Object.keys(document), ['format', 'version', 'settings']);
    assert.deepEqual(importAutomationSettings(document), validateSettings(initial));
    assert.throws(() => importAutomationSettings({ ...document, accounts: [] }), /不能包含账号或凭据/);
    const changed = applyNativeTask(initial, 'collect', false); assert.equal(changed.building.collect, false); assert.equal(changed.factory.gain, false);
    assert.equal(nativeTaskValues(changed, {}).collect, false);
  });

  await check('按账号保存、版本冲突与损坏文件不覆盖', () => {
    const file = path.join(directory, 'settings.json');
    const a = defaultSettings(); a.building.keepBlueprints = 25;
    saveAutomationSettings('a', a, { file, revision: 0 });
    const b = defaultSettings(); b.building.keepBlueprints = 80;
    saveAutomationSettings('b', b, { file, revision: 0 });
    assert.equal(loadAutomationSettings('a', { file }).settings.building.keepBlueprints, 25);
    assert.equal(loadAutomationSettings('b', { file }).settings.building.keepBlueprints, 80);
    const bytes = fs.readFileSync(file); assert.throws(() => saveAutomationSettings('a', b, { file, revision: 0 }), /其他页面更新/); assert.deepEqual(fs.readFileSync(file), bytes);
    const broken = path.join(directory, 'broken.json'); fs.writeFileSync(broken, '{bad');
    assert.throws(() => loadAutomationSettings('a', { file: broken }), /停止/); assert.equal(fs.readFileSync(broken, 'utf8'), '{bad');
  });

  await check('两版任务设置迁移保留显式开关，缺省消费任务保持关闭', () => {
    const keys = ['festivalActive', 'festivalGifts', 'snowballFree', 'weekLotterySpin', 'weekCharge', 'weekChipFree', 'weekUniqueFree', 'weekOrderFinal', 'weekOrderSubmit', 'vipDaily', 'campaignReports', 'openRankRewards',
      'guildOrders', 'radarAuto', 'radarRepair', 'equipmentCollect', 'equipmentCraft', 'museumCollect', 'museumExplore', 'petCollect', 'petBreed'];
    for (const enabled of [true, false]) {
      const tasks = Object.fromEntries(keys.map(key => [key, enabled]));
      const settings = settingsFromNative(tasks);
      const restored = importAutomationSettings(exportAutomationSettings(settings));
      for (const key of keys) {
        assert.equal(restored.schedule[key], enabled, key + ' 保存值不能被新版默认值覆盖');
        assert.equal(nativeTaskValues(restored, {})[key], enabled);
      }
    }
    const oldDocument = exportAutomationSettings(defaultSettings());
    for (const key of keys) delete oldDocument.settings.schedule[key];
    const restored = importAutomationSettings(oldDocument);
    for (const key of ['guildOrders', 'radarAuto', 'radarRepair', 'equipmentCollect', 'equipmentCraft', 'museumCollect', 'museumExplore', 'petCollect', 'petBreed', 'weekLotterySpin', 'weekOrderSubmit', 'merchantTrade', 'beautyVotes', 'compassSpin']) assert.equal(restored.schedule[key], false, key);
    assert.equal(restored.schedule.weekOrderFinal, true);
    assert.equal(restored.schedule.vipDaily, true);
  });

  await check('每日额度持久化、跨账号、跨日、未知结果和发送前取消', () => {
    const file = path.join(directory, 'usage.json'); let now = Date.parse('2026-11-02T15:59:00Z');
    const a = createUsageLedger('a', { file, now: () => now });
    const ticket = a.reserve({ diamonds: 70 }, { diamonds: 100 });
    assert.equal(a.snapshot().uncertain, 1);
    const restarted = createUsageLedger('a', { file, now: () => now });
    assert.throws(() => restarted.reserve({ diamonds: 31 }, { diamonds: 100 }), /今日上限/);
    assert.equal(createUsageLedger('b', { file, now: () => now }).snapshot().counters.diamonds, undefined);
    a.confirm(ticket); assert.equal(a.snapshot().uncertain, 0); assert.equal(a.snapshot().counters.diamonds, 70);
    const noSend = a.reserve({ diamonds: 20 }, { diamonds: 100 }); a.cancel(noSend); assert.equal(a.snapshot().counters.diamonds, 70);
    assert.throws(() => a.reserve({ residentOrders: 1 }, { residentOrders: 5 }, { residentOrders: 5 }), /今日上限/);
    now += 120000; assert.equal(beijingDay(now), '2026-11-03'); assert.deepEqual(a.snapshot().counters, {});
  });

  await check('订单完整用量、禁用材料、阈值、每日上限和刷新开关', () => {
    const settings = quiet(); settings.resident.enabled = true;
    const state = survey({ 产品甲: 2 }, [], [order(0, [{ id: '产品甲', num: 2 }]), order(1, [{ id: '产品甲', num: 2 }])]);
    assert.equal(planWorld(state, { config, settings }).actions.filter(a => a.kind === 'finishOrder').length, 1);
    settings.resident.skipProduction = true;
    assert.equal(planWorld(state, { config, settings }).orderDecisions[1].status, 'filtered');
    settings.resident.skipProduction = false;
    settings.resident.blockedMaterials = ['产品甲']; assert.equal(planWorld(state, { config, settings }).actions.length, 0);
    settings.resident.reroll = true; assert.equal(planWorld(state, { config, settings }).actions.filter(a => a.kind === 'denyOrder').length, 2);
    settings.resident.blockedMaterials = []; settings.resident.reroll = false; settings.resident.minExp = 800;
    assert.equal(planWorld(state, { config, settings }).actions.length, 0);
    settings.resident.minExp = 0; settings.resident.minGold = 300; assert.equal(planWorld(state, { config, settings }).actions.length, 0);
    settings.resident.minGold = 0; settings.resident.dailyCap = 1;
    assert.equal(planWorld(state, { config, settings, usage: { counters: { residentOrders: 1 } } }).actions.length, 0);
    state.orderOfTheDay.orderNum = 1; assert.equal(planWorld(state, { config, settings }).actions.length, 0);
  });

  await check('生产优先级排序、清空来源与禁用工厂实际改变计划', () => {
    const settings = quiet(); settings.resident.enabled = true; settings.factory.produce = true; settings.factory.keepStock = 0;
    const factory = building('食品厂', { factory: { factoryQ: [], finishedProducts: [] } });
    const state = survey({ 木材: 20 }, [factory], [order(0, [{ id: '产品乙', num: 1 }])]); state.cargoOrder.set('产品甲', 1);
    settings.factory.demandPriority = ['resident', 'cargo'];
    assert.equal(planWorld(state, { config, settings }).actions.find(a => a.kind === 'startProduce')?.body.productId, '产品乙');
    settings.factory.demandPriority = ['cargo', 'resident'];
    assert.equal(planWorld(state, { config, settings }).actions.find(a => a.kind === 'startProduce')?.body.productId, '产品甲');
    settings.factory.demandPriority = []; assert.ok(!planWorld(state, { config, settings }).actions.some(a => a.kind === 'startProduce'));
    settings.factory.demandPriority = ['cargo']; settings.factory.disabledTypes = ['食品厂'];
    assert.ok(!planWorld(state, { config, settings }).actions.some(a => a.kind === 'startProduce'));
  });

  await check('关闭需求优先后联盟独立补料保留预留，订单来源前后或省略均只补真实缺口', () => {
    for (const source of ['guildRecruit', 'guildShip']) for (const priority of [[source, 'resident'], ['resident', source], []]) {
      const settings = quiet(); settings.factory.produce = true; settings.factory.keepStock = 0;
      settings.factory.demandFirst = false; settings.factory.demandPriority = priority;
      settings.alliance.enabled = true;
      if (source === 'guildRecruit') settings.alliance.recruit = settings.alliance.recruitProduction = true;
      else settings.guildShip.enabled = settings.guildShip.produceMissing = true;
      const state = survey({ 产品甲: 3, 木材: 20 }, [building('食品厂', { factory: { factoryQ: [], finishedProducts: [] } })],
        [order(0, [{ id: '产品甲', num: 3 }])]); state.factorySlots = 5;
      const extraDemand = [{ source, requirements: [{ id: '产品甲', num: 2 }], reserved: [{ id: '产品甲', num: 3 }] }];
      const plan = planWorld(state, { config, settings, extraDemand });
      assert.equal(plan.actions.filter(step => step.kind === 'startProduce').length, 2, source + ' ' + priority);
      assert.equal(plan.demands.find(row => row.id === '产品甲').required, 5);
      settings.alliance.enabled = false;
      assert.equal(planWorld(state, { config, settings, extraDemand }).actions.filter(step => step.kind === 'startProduce').length, 0);
    }
  });

  await check('建筑禁用、蓝图保留、加速器共用保留量', () => {
    const settings = quiet(); settings.building.build = true;
    const plot = building('仓库', { buildingId: '2仓库', level: 0 });
    const state = survey({ 建筑蓝图: 5 }, [plot]); settings.building.keepBlueprints = 3;
    assert.ok(!planWorld(state, { config, settings }).actions.some(a => a.kind === 'build'));
    settings.building.keepBlueprints = 2; assert.equal(planWorld(state, { config, settings }).actions.filter(a => a.kind === 'build').length, 1);
    settings.building.disabledTypes = ['仓库']; assert.ok(!planWorld(state, { config, settings }).actions.some(a => a.kind === 'build'));
    const active = survey({ 加速器: 5 }, [building('仓库', { buildFinishTime: 20000 }), building('食品厂', { factory: { factoryQ: [{ idx: 1, productId: '产品甲', finishTime: 20000 }], finishedProducts: [] } })]);
    settings.building.speedUp = true; settings.factory.speedUp = true; settings.resources.keepAccelerators = 3;
    const speed = planWorld(active, { config, settings, allowSpeedUp: true }).actions.filter(a => a.kind.startsWith('speedUp'));
    assert.equal(speed.reduce((sum, step) => sum + step.body.speedUp.useNum, 0), 2);
  });

  await check('已满足的来源不抢优先级，按来源加速不消耗无关额度', () => {
    const settings = quiet(); settings.resident.enabled = true; settings.factory.produce = true; settings.factory.keepStock = 0;
    settings.factory.demandPriority = ['cargo', 'resident', 'museum'];
    const factory = building('食品厂', { factory: { factoryQ: [], finishedProducts: [] } });
    const state = survey({ 木材: 20 }, [factory], [order(0, [{ id: '产品乙', num: 1 }])]); state.cargoOrder.set('产品甲', 1); state.factorySlots = 3;
    const extraDemand = [{ source: 'museum', requirements: [{ id: '产品甲', num: 2 }] }];
    assert.deepEqual(planWorld(state, { config, settings, extraDemand }).actions.filter(a => a.kind === 'startProduce').map(a => a.body.productId), ['产品甲', '产品乙', '产品甲']);
    const stocked = survey({ 产品甲: 1, 加速器: 5 }, [building('食品厂', { factory: { factoryQ: [{ idx: 0, productId: '产品甲', finishTime: 20000 }], finishedProducts: [] } })]); stocked.cargoOrder.set('产品甲', 1);
    settings.factory.produce = false; settings.factory.speedUpSources = ['cargo'];
    assert.ok(!planWorld(stocked, { config, settings, extraDemand, allowSpeedUp: true }).actions.some(a => a.kind === 'speedUpProduce'));
    settings.factory.speedUpSources = ['museum'];
    assert.ok(planWorld(stocked, { config, settings, extraDemand, allowSpeedUp: true }).actions.some(a => a.kind === 'speedUpProduce'));
  });

  await check('仅来源加速通过真实标志转换、需求读取和挂机执行链路', async () => {
    let settings = quiet();
    settings.schedule = Object.fromEntries(Object.keys(settings.schedule).map(key => [key, false]));
    settings.loop.tasks = settings.loop.dailies = false;
    settings.dailies.enabled = settings.resident.rewards = false;
    settings.building.collect = settings.building.finish = settings.factory.gain = false;
    settings.factory.demandPriority = ['cargo'];
    settings.factory.speedUpSources = ['cargo'];
    settings.factory.keepStock = 0;
    settings.resources.keepAccelerators = 2;
    assert.equal(settings.factory.produce, false);
    assert.equal(settings.cargo.enabled, false);
    let flags = nativeTaskValues(settings, {});
    assert.equal(flags.speedUp, true);
    assert.equal(flags.startProduce, false);
    assert.equal(flags.cargo, false);
    const factory = building('食品厂', { factory: { factoryQ: [{ idx: 0, productId: '产品甲', finishTime: Math.floor(Date.now() / 1000) + 600 }], finishedProducts: [] } });
    const responses = new Map([
      ['OnWaterRequest', { building: [factory], workerOrder: [] }],
      ['AllItemRequest', { items: [{ itemId: '加速器', num: 5 }] }],
      ['AllResourceRequest', { list: [] }], ['MyResFieldsRequest', {}], ['MyFleetsRequest', { fleets: [] }],
      ['WeekInfoRequest', { week: [] }], ['WeekOrderInfoRequest', {}],
      ['CargoShipsRequest', { ship: [{ index: 1, status: 0, orderItem: [{ asset: { id: '产品甲', num: 1 }, filled: false }] }] }],
    ]);
    const protocol = { SpeedUpFactoryProduceRequest: {} };
    for (const name of responses.keys()) { protocol[name] = {}; protocol[name.replace(/Request$/, 'Response')] = {}; }
    const reads = [], writes = [];
    const client = new EventEmitter(); client.connected = true;
    client.request = async name => { reads.push(name); assert.ok(responses.has(name), '不应读取 ' + name); return structuredClone(responses.get(name)); };
    client.sendWatch = async (name, body) => { writes.push({ name, body }); responses.set('AllItemRequest', { items: [{ itemId: '加速器', num: 2 }] }); return {}; };
    const options = { config, player: { playerId: '9102000000000001', worldId: 1001001, level: 36 }, rounds: 1, allowMutate: true,
      isEnabled: key => flags[key] === true, getSettings: () => settings };
    const result = await runLoop(client, protocol, options);
    assert.ok(reads.includes('CargoShipsRequest'), '关闭自动贸易和新增排产时仍须读取来源需求');
    assert.deepEqual(writes, [{ name: 'SpeedUpFactoryProduceRequest', body: { buildingId: '1食品厂', index: 0, speedUp: { type: 2, useNum: 3 } } }]);
    assert.equal(result.history[0].world.results[0].ok, true);
    settings = applyNativeTask(settings, 'speedUp', false);
    assert.deepEqual(settings.factory.demandPriority, ['cargo']);
    assert.deepEqual(settings.factory.speedUpSources, []);
    assert.equal(settings.building.speedUp, false); assert.equal(settings.factory.speedUp, false); assert.equal(settings.farm.speedUp, false);
    flags = nativeTaskValues(settings, {}); assert.equal(flags.speedUp, false);
    reads.length = 0; writes.length = 0;
    await runLoop(client, protocol, options);
    assert.deepEqual(reads, []); assert.deepEqual(writes, []);
    const farmOnly = structuredClone(settings); farmOnly.farm.enabled = farmOnly.farm.speedUp = true;
    assert.equal(nativeTaskValues(farmOnly, {}).speedUp, true);
    assert.equal(applyNativeTask(farmOnly, 'speedUp', false).farm.speedUp, false);
  });

  await check('农田自定义顺序、水位和收割独立开关', () => {
    const settings = quiet(); settings.farm.enabled = true; settings.farm.autoPlant = false; settings.farm.customPlant = true;
    settings.farm.crops = [{ id: '小麦', target: 0 }, { id: '玉米', target: 10 }];
    const state = survey({ 小麦种子: 5, 玉米种子: 5 }, [building('农田')]);
    const planted = planWorld(state, { config, settings }).actions.find(a => a.request === 'FarmPlantRequest');
    assert.equal(planted.body.args[0].productId, '玉米');
    state.buildings[0].farm = { productId: '玉米', ripeTime: 9000 };
    settings.farm.harvest = false; assert.ok(!planWorld(state, { config, settings }).actions.some(a => a.request === 'FarmHarvestRequest'));
    settings.farm.harvest = true; assert.ok(planWorld(state, { config, settings }).actions.some(a => a.request === 'FarmHarvestRequest'));
  });

  await check('博物馆地图、实际解锁倍数、指南累计上限与事件白名单', () => {
    const settings = quiet(); settings.museum.enabled = true; settings.museum.factor = 3; settings.museum.maps = ['2'];
    const state = survey({ 产品甲: 20, 博物馆加速: 10, 人气币: 1000, 建筑蓝图: 20 });
    const snapshot = extra(state, { museum: { topPopularity: 0, claimedAchievements: [], exhibitions: [{ exhibitionId: 1, level: 1, keywordLevels: [0, 0, 0] }], exploreStages: [1, 2].map(stageId => ({ stageId, expedition: { endTime: 0, conditionId: 1, cost: { asset: [{ id: '产品甲', num: 2 }] } } })) }, heroes: [{ heroId: '甲', power: 100 }] });
    const steps = planBaseAutomation(snapshot, config, settings).actions;
    const start = steps.find(a => a.kind === 'museumStart'); assert.equal(start.body.stageId, 2); assert.equal(start.body.factor, 2); assert.equal(settings.museum.factor, 3);
    settings.museum.useGuide = true; settings.museum.dailyGuideLimit = 2; snapshot.museum.exploreStages[1].expedition.endTime = 20000;
    const guide = planBaseAutomation(snapshot, config, settings, { counters: { museumGuides: 1 } }).actions.find(a => a.kind === 'museumGuide'); assert.equal(guide.body.useNum, 1);
    assert.ok(!planBaseAutomation(snapshot, config, settings, { counters: { museumGuides: 2 } }).actions.some(a => a.kind === 'museumGuide'));
    settings.events.enabled = true; snapshot.choices = [{ uid: '10', eventId: 1007 }, { uid: '11', eventId: 1001 }];
    const events = planBaseAutomation(snapshot, config, settings).actions.filter(a => a.kind === 'choiceEvent'); assert.equal(events.length, 2); assert.deepEqual(events[0].body, { uid: '10', optionIndex: 2 });
  });

  await check('点金按游戏当天付费次数补差且受钻石预算限制', () => {
    const settings = quiet(); settings.gold.enabled = true; settings.gold.times = 3; settings.resources.allowDiamonds = true; settings.resources.diamondDailyLimit = 15;
    const snapshot = extra(survey({ RUBY: 100 }), { gold: { info: { paidTimes: 1, maxPaidTimes: 7 } } });
    const action = planBaseAutomation(snapshot, config, settings).actions.find(a => a.kind === 'paidGold'); assert.equal(action.body.times, 1); assert.equal(action.costs[0].num, 10);
    assert.ok(!planBaseAutomation(snapshot, config, settings, { counters: { diamonds: 10 } }).actions.some(a => a.kind === 'paidGold'));
    snapshot.gold.info.paidTimes = 3; assert.ok(!planBaseAutomation(snapshot, config, settings).actions.some(a => a.kind === 'paidGold'));
    const driver = DAILY_DRIVERS[1006].evaluate({ task: { targetProgress: 5, progress: 0 }, probe: () => ({ info: { freeTimes: 1, paidTimes: 3, maxPaidTimes: 7 } }), config, ruby: 100, settings });
    assert.equal(driver.actions?.length ?? 0, 0);
  });

  await check('博物馆完成探索后继续领奖，领奖回执不完整时不报告成功', async () => {
    const settings = quiet(); settings.museum.enabled = true;
    const snapshot = extra(survey(), { museum: { topPopularity: 0, claimedAchievements: [], exhibitions: [], exploreStages: [{ stageId: 1, expedition: { endTime: 9000, heroIds: [] } }] } });
    const plan = planBaseAutomation(snapshot, config, settings);
    const protocol = { MuseumCompleteExploreRequest: {}, MuseumCompleteExploreResponse: {}, MuseumRewardRequest: {}, MuseumRewardResponse: {} };
    const calls = [];
    const client = { connected: true, async request(name) { calls.push(name); if (name === 'MuseumCompleteExploreRequest') return { grade: 2, progressGain: 5 }; if (name === 'MuseumRewardRequest') return { reward: { asset: [] }, exploreStage: { stageId: 1, expedition: { endTime: 0 } } }; throw new Error(name); } };
    const result = await runBaseAutomation(client, protocol, config, plan, { getSettings: () => settings });
    assert.deepEqual(calls, ['MuseumCompleteExploreRequest', 'MuseumRewardRequest']); assert.equal(result[0].ok, true);
    client.request = async name => name === 'MuseumCompleteExploreRequest' ? { grade: 2, progressGain: 5 } : {};
    assert.equal((await runBaseAutomation(client, protocol, config, plan, { getSettings: () => settings }))[0].ok, false);
  });

  await check('消耗回执未确认时保留指南、钻石与点金次数，避免重试超额', async () => {
    const settings = quiet(); settings.museum.enabled = true; settings.museum.useGuide = true; settings.museum.dailyGuideLimit = 1;
    const world = survey({ 博物馆加速: 5, RUBY: 100 });
    const snapshot = extra(world, { museum: { topPopularity: 0, claimedAchievements: [], exhibitions: [], exploreStages: [{ stageId: 1, expedition: { endTime: 20000, heroIds: [] } }] } });
    const ledger = createUsageLedger('uncertain', { file: path.join(directory, 'uncertain-usage.json') });
    const client = { connected: true, async request(name) {
      if (name === 'AllItemRequest') return { items: [{ itemId: '博物馆加速', num: 5 }] };
      if (name === 'AllResourceRequest') return { list: [{ res: 4, amount: 100 }] };
      if (name === 'ClickGoldInfoRequest') return { info: { paidTimes: 0 } };
      return {};
    } };
    const protocol = { MuseumSpeedUpExploreRequest: {}, MuseumSpeedUpExploreResponse: {}, ClickGoldRequest: {}, ClickGoldResponse: {} };
    const guide = await runBaseAutomation(client, protocol, config, planBaseAutomation(snapshot, config, settings), { getSettings: () => settings, ledger });
    assert.equal(guide[0].ok, false); assert.equal(ledger.snapshot().counters.museumGuides, 1); assert.equal(ledger.snapshot().uncertain, 1);
    assert.ok(!planBaseAutomation(snapshot, config, settings, ledger.snapshot()).actions.some(action => action.kind === 'museumGuide'));
    settings.museum.enabled = false; settings.gold.enabled = true; settings.gold.times = 1; settings.resources.allowDiamonds = true;
    snapshot.gold = { info: { paidTimes: 0, maxPaidTimes: 7 } };
    const gold = await runBaseAutomation(client, protocol, config, planBaseAutomation(snapshot, config, settings, ledger.snapshot()), { getSettings: () => settings, ledger });
    assert.equal(gold[0].ok, false); assert.equal(ledger.snapshot().counters.diamonds, 10); assert.equal(ledger.snapshot().counters.goldPaidTimes, 1);
    assert.ok(!planBaseAutomation(snapshot, config, settings, ledger.snapshot()).actions.some(action => action.kind === 'paidGold'));
  });

  await check('海兽培育按真实区服赛季开放，未知赛季不发送培育', () => {
    const settings = quiet(); settings.pet.enabled = true; settings.pet.breed = true; settings.pet.species = ['1'];
    const state = survey({ 基因甲: 2, GOLD: 100 }, [building('宠物培育室', { petBreed: { maxQLength: 2, breedQ: [], maturePets: [] } })]);
    const snapshot = extra(state); assert.ok(!planBaseAutomation(snapshot, config, settings).actions.some(a => a.kind === 'petBreed'));
    snapshot.player.worldId = 2001000001; assert.equal(gameSeason(snapshot.player), 1);
    assert.equal(planBaseAutomation(snapshot, config, settings).actions.filter(a => a.kind === 'petBreed').length, 1);
    const future = structuredClone(config); future.tables.PetBreedCfg.data[0].season = 3;
    assert.ok(!planBaseAutomation(snapshot, future, settings).actions.some(a => a.kind === 'petBreed'));
  });

  await check('事件64位标识不丢精度且只提交实际服务器事件', async () => {
    const id = '9007199254740993', wire = automationWireId(id);
    assert.equal(exactAutomationId(wire), id); assert.equal(exactAutomationId(Number(id)), null);
    const { loadProtocol } = await import('../src/proto.mjs'); const protocol = loadProtocol();
    const encoded = protocol.SelectChoiceRequest.encode({ uid: wire, optionIndex: 2 }).finish();
    assert.equal(exactAutomationId(protocol.SelectChoiceRequest.decode(encoded).uid), id);
    const client = new EventEmitter(); client.connected = true; const sent = [];
    client.request = async (name, body, response) => { sent.push({ name, body }); assert.equal(response,'GotRewardResponse'); return protocol.GotRewardResponse.decode(protocol.GotRewardResponse.encode({reward:{asset:[{id:'RUBY',num:1}]}}).finish()); };
    const tracked = watchBasePushes(client); client.emit('message', { name: 'SCChoiceEventUpdate', body: { events: [{ uid: wire, eventId: 1007 }] } });
    const settings = quiet(); settings.events.enabled = true;
    const snapshot = extra(survey(), { choices: [...tracked.choices.values()] });
    const plan = planBaseAutomation(snapshot, config, settings);
    await runBaseAutomation(client, protocol, config, plan, { getSettings: () => settings, ledger:createUsageLedger('choice-check',{file:path.join(directory,'choice-check.json')}) });
    assert.equal(sent.length, 1); assert.equal(exactAutomationId(sent[0].body.uid), id); assert.equal(tracked.choices.size, 0);
  });

  await check('英雄目标与经验保留、关闭升星不影响技能状态', () => {
    const cfg = { tables: { HeroCfg: table([{ id: '甲', quality: 'BLUE', universalItemId: '通用片' }]),
      HeroUpgradeCfg: table([{ level: 1, reqPlayerLv: 1, exp: 0 }, { level: 2, reqPlayerLv: 1, exp: 20 }, { level: 3, reqPlayerLv: 1, exp: 30 }]),
      HeroStarCfg: table([{ star: 1, consumeBlue: 2, maxSkillLevel: [1, 1, 1, 1] }]), HeroSkillUpCfg: table([]) } };
    const settings = defaultSettings(); settings.heroes.keepExp = 50; settings.heroes.targetLevel = 3; settings.heroes.star = false;
    const plan = planHeroes({ config: cfg, heroes: [{ heroId: '甲', level: 1, star: 0, skillLevels: [1] }], playerLevel: 10, itemNum: id => id === '英雄经验' ? 70 : 100, settings });
    assert.equal(plan.steps.find(step => step.kind === 'level').to, 2); assert.ok(!plan.steps.some(step => step.kind === 'star'));
    settings.heroes.heroIds = ['乙']; assert.equal(planHeroes({ config: cfg, heroes: [{ heroId: '甲', level: 1 }], playerLevel: 10, itemNum: () => 100, settings }).steps.length, 0);
  });

  await check('执行前预算拦截，不发送关闭或超额的游戏请求', async () => {
    const settings = defaultSettings(); settings.resources.allowDiamonds = true; settings.resources.diamondThreshold = 20; settings.resources.diamondDailyLimit = 100;
    const ledger = createUsageLedger('guard', { file: path.join(directory, 'guard-usage.json') });
    const sent = [];
    const client = { connected: true, async request(name) { if (name === 'AllResourceRequest') return { list: [{ res: 4, amount: 100 }] }; if (name === 'AllItemRequest') return { items: [{ itemId: '木材', num: 5 }] }; sent.push(name); return {}; }, async sendWatch(name) { sent.push(name); return {}; } };
    const guard = createActionGuard(client, () => settings, ledger);
    const step = { kind: 'daily', costs: [{ id: 'RUBY', num: 70 }] }; const ticket = await guard.before(step); assert.equal(ledger.snapshot().counters.diamonds, 70);
    await assert.rejects(() => guard.before({ kind: 'daily', costs: [{ id: 'RUBY', num: 11 }] }), /保留数量/);
    await guard.cancel(step, ticket, { notSent: true }); assert.equal(ledger.snapshot().counters.diamonds, 0);
    settings.factory.enabled = false;
    const result = await runWorld(client, { StartFactoryProduceRequest: {} }, { actions: [{ kind: 'startProduce', request: 'StartFactoryProduceRequest', body: { buildingId: '1食品厂', productId: '产品甲' }, costs: [{ id: '木材', num: 1 }] }] }, { allowMutate: true, config, settings, beforeStep: guard.before });
    assert.equal(result.results[0].skipped, true); assert.deepEqual(sent, []);
    const daily = { tasks: [{ task: { id: 1007, title: '折扣店' }, status: 'ready', actions: [{ request: 'DiscountShopBuyRequest', body: { id: 1 }, costs: [{ id: 'RUBY', num: 10 }] }] }] };
    await runDailies(client, {}, daily, { allowMutate: true, allowPaid: false, claimRewards: false }); assert.deepEqual(sent, []);
    assert.equal(budgetPreview([{ label: '消费', costs: [{ id: 'RUBY', num: 81 }] }], new Map([['RUBY', 100]]), settings).actions.length, 0);
    settings.resources.allowDiamonds = false;
    assert.equal(budgetPreview([{ label: '免费商品', costs: [{ id: 'RUBY', num: 0 }] }], new Map(), settings).actions.length, 1);
  });

  await check('贸易装货跨轮计数且达到上限后仍可收货', async () => {
    const settings = quiet(); settings.cargo.enabled = true; settings.cargo.dailyLoadLimit = 1;
    const ledger = createUsageLedger('cargo', { file: path.join(directory, 'cargo-usage.json') });
    const ships = [1, 2].map(index => ({ index, status: 0, orderItem: [{ asset: { id: '产品甲', num: 1 }, filled: false }] }));
    ships.push({ index: 3, status: 2, orderItem: [] }); const writes = [];
    const client = { connected: true, async request(name, body) {
      if (name === 'CargoShipsRequest') return { ship: structuredClone(ships) };
      if (name === 'AllItemRequest') return { items: [{ itemId: '产品甲', num: 10 }] };
      if (name === 'WeekInfoRequest') return { week: [] };
      if (name === 'FillCargoShipRequest') { writes.push(name); const ship = ships.find(s => s.index === body.shipIndex); ship.orderItem[0].filled = true; ship.status = 1; return {}; }
      if (name === 'DrawShipRewardRequest') { writes.push(name); ships.find(s => s.index === body.index).status = 1; return { reward: { asset: [] } }; }
      throw new Error('不应调用的接口 ' + name);
    } };
    const guard = createActionGuard(client, () => settings, ledger);
    const options = { enabled: () => true, log() {}, getSettings: () => settings, ledger, beforeAction: guard.before, afterAction: guard.after };
    await serviceCargo(client, config, options); await serviceCargo(client, config, options);
    assert.deepEqual(writes, ['FillCargoShipRequest', 'DrawShipRewardRequest']); assert.equal(ledger.snapshot().counters.cargoLoads, 1); assert.equal(ledger.snapshot().uncertain, 0);
  });

  await check('分组总开关与消费检查期间关闭钻石开关都能拦截', async () => {
    const settings = quiet(); settings.building.enabled = false; settings.factory.enabled = false;
    let requests = 0;
    const client = { connected: true, request: async () => { requests++; throw new Error('关闭状态不应请求游戏'); } };
    await runLoop(client, {}, { config, player: { level: 36 }, rounds: 1, allowMutate: true, isEnabled: key => key === 'collect', getSettings: () => settings });
    assert.equal(requests, 0);
    let current = defaultSettings(); current.resources.allowDiamonds = true;
    const ledger = createUsageLedger('changed', { file: path.join(directory, 'changed-usage.json') });
    const changed = { async request() { current = structuredClone(current); current.resources.allowDiamonds = false; return { list: [{ res: 4, amount: 100 }] }; } };
    const guard = createActionGuard(changed, () => current, ledger);
    await assert.rejects(() => guard.before({ kind: 'daily', costs: [{ id: 'RUBY', num: 10 }] }), /钻石消耗总开关/);
    assert.deepEqual(ledger.snapshot().counters, {});
  });

  await check('采集、船只、贸易与开箱预览覆盖开启项且完全不发送写入', async () => {
    const cfg = structuredClone(config);
    cfg.tables.BuildingCfg.data.push(...['钓鱼椅', '潜水船', '探险船'].map(buildingType => ({ buildingType, name: buildingType })));
    cfg.tables.BuildingUpgradeCfg.data[0].effect = [['资源储量上限', 1000]];
    cfg.tables.ModuleOpenCfg = table([{ moduleId: '小玩法升级', playerLevel: 7 }]);
    for (const [name, type] of [['Fish', '钓鱼椅'], ['Dive', '潜水船'], ['Salvage', '探险船']]) cfg.tables[name + 'LevelCfg'] = table([
      { level: 2, enhance: 10, cost: ['GOLD', 50], condition: [type, 2], reduceTime: 10, warehouse: 10 },
      { level: 3, enhance: 10, cost: ['GOLD', 100], condition: [type, 3], reduceTime: 20, warehouse: 20 },
    ]);
    cfg.tables.FishParamCfg = table([{ paramName: '自动钓鱼', paramValue: 2 }]); cfg.tables.DiveParamCfg = table([{ paramName: '自动潜水', paramValue: 2 }]); cfg.tables.SalvageParamCfg = table([{ paramName: '自动拾荒', paramValue: 2 }]);
    cfg.tables.GarbageProductionCfg = table([{ id: '塑料垃圾1', type: '拾取', production: ['塑料', 1] }]);
    const settings = quiet(); Object.assign(settings.gather, { fishing: true, floaters: true, diving: true, salvage: true, upgradeFishing: true, upgradeDiving: true, upgradeSalvage: true, targetLevel: 3, keyOpen: true }); settings.cargo.enabled = true;
    const buildings = ['仓库', '钓鱼椅', '潜水船', '探险船'].map(type => building(type));
    const state = survey({ 产品甲: 10, 保险箱钥匙: 2, GOLD: 20000 }, buildings); state.floaters = [{ floaterId: '塑料垃圾1', num: 2 }];
    const writes = [], reads = [];
    const client = { connected: true, async request(name) {
      reads.push(name);
      if (name === 'OnWaterRequest') return { building: buildings, fishingLevel: { level: 2, enhance: 1 }, divingLevel: { level: 2, enhance: 1 }, salvageLevel: { level: 2, enhance: 1 } };
      if (name === 'AllItemRequest') return { items: [{ itemId: '产品甲', num: 10 }, { itemId: '保险箱钥匙', num: 2 }] };
      if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: 20000 }] };
      if (name === 'GameEffectRequest') return { effects: [{ id: 16, value: 1000 }] };
      if (name === 'WeekInfoRequest') return { week: [] };
      if (name === 'CargoShipsRequest') return { ship: [{ index: 1, status: 0, orderItem: [{ asset: { id: '产品甲', num: 1 }, filled: false }] }, { index: 2, status: 2 }] };
      writes.push(name); throw new Error('预览不能写入');
    }, async sendWatch(name) { writes.push(name); throw new Error('预览不能写入'); } };
    const plan = await previewNativeAutomation(client, cfg, state.player, settings, nativeTaskValues(settings, {}), state, { counters: {} });
    for (const kind of ['autoFish', 'fishEnhance', 'autoDive', 'diveEnhance', 'autoSalvage', 'salvageEnhance', 'floaters', 'cargoLoad', 'cargoReward', 'diveKey']) assert.ok(plan.actions.some(action => action.kind === kind), kind + ' 应显示计划');
    assert.deepEqual(writes, []); assert.ok(reads.includes('GameEffectRequest'));
  });

  await check('设置接口保存不连接游戏、账号隔离、导入只校验、预览不自动登录', async () => {
    process.env.CW_DATA_DIR = directory;
    const { saveStore, DATA_DIR } = await import('../src/accounts.mjs'); assert.equal(DATA_DIR, directory);
    saveStore({ activeId: 'qa-a', accounts: ['qa-a', 'qa-b'].map(id => ({ id, label: id, url: 'ws://127.0.0.1:1', login: {}, automation: { enabled: false, paused: true } })) });
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 }); await app.listen();
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const api = async (account, route, body) => { const response = await fetch(origin + route + '?account=' + account, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: response.status, body: await response.json() }; };
    try {
      const before = fs.readFileSync(path.join(directory, 'accounts.json'));
      const a = (await api('qa-a', '/api/settings')).body; a.settings.building.keepBlueprints = 123;
      const save = await api('qa-a', '/api/settings', { settings: a.settings, revision: a.revision, baseRevision: a.baseRevision }); assert.equal(save.status, 200); assert.equal(save.body.revision, 1);
      assert.deepEqual(fs.readFileSync(path.join(directory, 'accounts.json')), before);
      assert.equal(app.sessions.get('qa-a').client, null); assert.equal(app.sessions.get('qa-a').loop.running, false);
      assert.equal((await api('qa-b', '/api/settings')).body.settings.building.keepBlueprints, 0);
      const exported = (await api('qa-a', '/api/settings/export')).body; assert.deepEqual(Object.keys(exported), ['format', 'version', 'settings']);
      exported.settings.building.keepBlueprints = 200;
      assert.equal((await api('qa-a', '/api/settings/validate', { document: exported })).status, 200);
      assert.equal((await api('qa-a', '/api/settings')).body.settings.building.keepBlueprints, 123);
      const invalid = structuredClone(save.body.settings); invalid.resident.dailyCap = -5;
      const failure = await api('qa-a', '/api/settings', { settings: invalid, revision: 1 }); assert.equal(failure.status, 400); assert.ok(failure.body.fields['resident.dailyCap']);
      assert.equal((await api('qa-a', '/api/settings/preview', { settings: save.body.settings })).status, 400); assert.equal(app.sessions.get('qa-a').client, null);
      const session = app.sessions.get('qa-a'); const queries = []; session.paused = false; session.player = { level: 36 };
      session.client = { connected: true, stop() {}, async request(name) { queries.push(name); if (name === 'AllHeroRequest') return { heroes: [{ heroId: '兰博', level: 180, star: 20 }] }; if (name === 'AllItemRequest') return { items: [] }; throw new Error('英雄预览不应读取其他模块'); } };
      const heroPreview = await api('qa-a', '/api/settings/preview', { settings: save.body.settings, category: 'heroes' });
      assert.equal(heroPreview.status, 200); assert.equal(heroPreview.body.scopeLabel, '英雄养成'); assert.equal(heroPreview.body.counts.heroes, 1); assert.deepEqual(queries, ['AllHeroRequest', 'AllItemRequest']);
    } finally { await app.close(); }
  });
} finally {
  const report = { at: new Date().toISOString(), kind: '受控数据与本地接口检查，未执行真实游戏动作', passed: results.filter(r => r.passed).length, total: results.length, results };
  fs.writeFileSync(path.join(parent, 'result-' + Date.now() + '.json'), JSON.stringify(report, null, 2));
  const resolved = fs.realpathSync(directory), expectedParent = fs.realpathSync(parent);
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('run-')) throw new Error('测试目录边界校验失败，未清理');
  fs.rmSync(resolved, { recursive: true });
  console.log(`参数专项：${report.passed}/${report.total} 组通过`);
  if (report.passed !== report.total) process.exitCode = 1;
}
