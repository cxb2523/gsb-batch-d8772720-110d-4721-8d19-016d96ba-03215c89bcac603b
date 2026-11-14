import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { defaultSettings } from '../src/automation-settings.mjs';
import { runLoop } from '../src/loop.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';

const protocol = loadProtocol();
const wakeups = [
  ['SCNewGuildAidAsk', ['guildAidHelp']],
  ['SCGuildAidHelp', ['guildAidCollect', 'guildAidHelp']],
  ['SCTreasureLootRefresh', ['treasureLoot']],
  ['SCJoinGuild', ['guildOrders', 'radarAuto', 'radarRepair', 'guildWelfare', 'guildAidCollect', 'guildAidHelp', 'guildTitleReward', 'treasureLoot']],
  ['SCLeaveGuild', ['guildOrders', 'radarAuto', 'radarRepair', 'guildWelfare']],
  ['SCGuildOrder', ['guildOrders']],
  ['SCRadarUpdate', ['radarAuto', 'radarRepair']],
  ['SCRadarEventState', ['radarAuto', 'radarRepair']],
  ['SCUpdateEquip', ['equipmentCollect', 'equipmentCraft']],
  ['SCEquipDelete', ['equipmentCollect', 'equipmentCraft']],
  ['SCPetsUpdate', ['petCollect', 'petBreed']],
  ['SCPetDelete', ['petCollect', 'petBreed']],
  ['SCBreedLevelUpdate', ['petCollect', 'petBreed']],
  ['SCUpdateWaterBuilding', ['equipmentCollect', 'equipmentCraft', 'petCollect', 'petBreed', 'museumCollect', 'museumExplore']],
  ['SCMuseumPopularityChanged', ['museumCollect', 'museumExplore', 'museumAchievements']],
  ['SCMuseumRevenueUpdate', ['museumRevenue']],
  ['SCTradeGuildTask', ['tradeTasks']],
  ['SCActivityActiveScoreUpdate', ['festivalActive']],
  ['SCNewCampaignReport', ['campaignReports']],
  ['SCOpenRankRedDot', ['openRankRewards']],
  ['SCAllActivity', ['festivalSign', 'festivalActive', 'festivalGifts', 'snowballFree', 'compassSpin', 'weekGift', 'weekTimes', 'weekPass', 'newbieLogin']],
];

for (const [name, keys] of wakeups) {
  assert(protocol[name], '推送名称必须存在于真实协议：' + name);
  const a = new EventEmitter(), b = new EventEmitter();
  const sa = rewardSchedule(a), sb = rewardSchedule(b);
  for (const key of [...keys, 'mail']) {
    for (const suffix of ['', ':instance']) {
      for (const s of [sa, sb]) {
        s.defer(key + suffix, s.now() + 300);
        s.expect(key + suffix, s.now() + 300);
      }
    }
  }
  sa.observe(keys[0], '保留最近检查结果', 'waiting');
  a.emit('message', { name, body: {} });
  for (const key of keys) {
    for (const suffix of ['', ':instance']) {
      assert.equal(sa.due(key + suffix), true, name + ' 应唤醒 ' + key + suffix);
      assert.equal(sa.nextCheck(key + suffix), null, '推送也清除界面中的旧预计检查时间');
      assert.equal(sb.due(key + suffix), false, '不能清除其他账号的调度');
    }
  }
  assert.equal(sa.due('mail'), false, '无关任务的截止时间应保留');
  assert.equal(sa.status(keys[0]).text, '保留最近检查结果', '保留新版 observe 状态');
  assert.equal(rewardSchedule(a), sa, '同一连接停止再开始仍共享调度');
}

{
  const client = new EventEmitter(), scheduler = rewardSchedule(client);
  scheduler.defer('crossRankDaily', scheduler.now() + 300);
  client.emit('message', { name: 'SCRedPoint', body: { redPoint: [{ type: 33, num: 1 }] } });
  assert.equal(scheduler.redPoint(33), 1);
  assert.equal(scheduler.due('crossRankDaily'), true);
  scheduler.clearRedPoint(33);
  assert.equal(scheduler.redPoint(33), 0);
  scheduler.observe('mail', '已检查');
  scheduler.expect('mail', scheduler.now() + 100);
  client.emit('message', { name: 'SCDailyTaskReset', body: {} });
  assert.equal(scheduler.status('mail'), null);
  assert.equal(scheduler.nextCheck('mail'), null);
}

const legacyKeys = ['guildOrders', 'radarAuto', 'radarRepair', 'equipmentCollect', 'equipmentCraft',
  'museumCollect', 'museumExplore', 'petCollect', 'petBreed'];
function loopFixture() {
  const client = new EventEmitter(), reads = [], reports = [];
  let queued = false;
  client.connected = true;
  client.request = async name => { reads.push(name); throw new Error('受控未开放：' + name); };
  client.sendWatch = async name => assert.fail('测试禁止游戏写操作：' + name);
  const options = {
    allowMutate: true, rounds: 1,
    player: { level: 1, playerId: '1', guildId: 0, worldId: 2001001001 },
    config: { tables: {
      ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 16 }, { moduleId: '联盟情报', playerLevel: 18 }] },
      BuildingUnlockCfg: { data: [
        { buildingType: '装备厂', buildingId: '1装备厂', playerLevel: 17 },
        { buildingType: '博物馆', buildingId: '1博物馆', playerLevel: 28 },
        { buildingType: '宠物培育室', buildingId: '1宠物培育室', playerLevel: 23 },
      ] },
      MuseumExpeditionTeamCfg: { data: [{ teamCount: 1, playerLevel: 28 }] },
    } },
    async schedule(work) {
      assert.equal(queued, false);
      queued = true;
      try { await work(); } finally { queued = false; }
    },
    onStep(entry) { assert.equal(queued, true, '兼容服务也必须进入账号队列'); reports.push(entry); },
  };
  return { client, reads, reports, options };
}

for (const getSettings of [() => null, () => defaultSettings()]) {
  const f = loopFixture();
  await runLoop(f.client, {}, { ...f.options, getSettings, isEnabled: key => legacyKeys.includes(key) });
  for (const key of legacyKeys) {
    assert(f.reports.some(entry => entry.key === key && entry.skipped), '原主分支开关仍有实际服务入口：' + key);
  }
  assert.deepEqual(f.reads, [], '未解锁的原服务在读取游戏前给出等待原因');
}

for (const getSettings of [() => null, () => defaultSettings()]) {
  const f = loopFixture();
  const keys = ['seasonTasks', 'crossRankDaily', 'passStageRewards', 'guildAidCollect', 'museumRevenue'];
  const reward = { reward: { asset: [{ type: 0, id: '木材', num: 1 }] } };
  const responses = {
    MyGuildAidRequest: { aids: [{ helper: { playerId: 2 } }] },
    GotMyGuildAidRequest: reward,
    SeasonTaskRequest: { task: [{ stage: 1, personProgress: 10, teamProgress: 0 }], got: [] },
    GotSeasonTaskRequest: { ...reward, got: [{ stage: 1, gotPerson: true }] },
    GetDailyRewardRequest: reward,
    PassStageStateRequest: { isOver: false, maxOpenStage: 2 },
    PassStageRequest: { rwdStage: [1, 2] },
    PassStageGotRewardRequest: reward,
    OnWaterRequest: { building: [{ buildingId: '1博物馆', level: 1 }] },
    MuseumInfoRequest: { uncollectedRevenue: 10 },
    MuseumCollectRevenueRequest: { collected: 10 },
  };
  const requests = [];
  f.client.request = async (name, body, response) => {
    assert(protocol[name], '兼容入口请求必须存在于真实协议：' + name);
    for (const type of [response].flat()) assert(protocol[type], '兼容入口回包必须存在于真实协议：' + type);
    protocol[name].decode(protocol[name].encode(body ?? {}).finish());
    requests.push([name, body]);
    assert(Object.hasOwn(responses, name), '未预期请求：' + name);
    return structuredClone(responses[name]);
  };
  Object.assign(f.options.player, { level: 30, guildId: 2 });
  f.options.config.tables.ModuleOpenCfg.data.push({ moduleId: '世界', playerLevel: 1 });
  f.options.config.tables.SeasonTaskCfg = { data: [{ season: 1, stage: 1, personTarget: 10, teamTarget: 100 }] };
  rewardSchedule(f.client);
  f.client.emit('message', { name: 'SCRedPoint', body: { redPoint: [{ type: 33, num: 1 }] } });
  const options = { ...f.options, getSettings, isEnabled: key => keys.includes(key) };
  await runLoop(f.client, protocol, options);
  for (const name of ['GotMyGuildAidRequest', 'GotSeasonTaskRequest', 'GetDailyRewardRequest', 'PassStageGotRewardRequest', 'MuseumCollectRevenueRequest']) {
    assert(requests.some(([request]) => request === name), '旧领奖开关必须真正进入写协议：' + name);
  }
  assert.deepEqual(requests.filter(([name]) => name === 'PassStageGotRewardRequest').map(([, body]) => body.stage), [1, 2],
    '领取函数提前 defer 后，仍应完成本轮已核对的全部奖励');
  for (const key of keys) assert(f.reports.some(entry => entry.taskKey === key && entry.ok), '成功领取必须带回原开关 key：' + key);
  requests.length = 0;
  await runLoop(f.client, protocol, options);
  assert.deepEqual(requests, [], '下一轮应尊重已经记录的复查时间，避免持续重发');
}

{
  const f = loopFixture(), settings = defaultSettings();
  const controlled = ['radarAuto', 'radarRepair', 'equipmentCollect', 'equipmentCraft', 'museumCollect',
    'museumExplore', 'museumAchievements', 'petCollect', 'petBreed', 'treasureLoot', 'heroGrowth'];
  settings.radar.enabled = settings.forge.enabled = settings.museum.enabled = settings.pet.enabled = true;
  settings.treasure.enabled = true;
  settings.treasure.autoJoin = settings.treasure.follow = false;
  settings.loop.heroes = true;
  await runLoop(f.client, {}, { ...f.options, getSettings: () => settings, isEnabled: key => controlled.includes(key) });
  for (const key of controlled) {
    const entries = f.reports.filter(entry => entry.key === key);
    assert.equal(entries.length, 1, '每个被详细配置接管的旧入口只报告一次：' + key);
    assert(entries.every(entry => entry.skipped && /接管/.test(entry.reason)), '详细配置接管后不运行旧消费路径：' + key);
  }
}

{
  const f = loopFixture();
  await runLoop(f.client, {}, { ...f.options, isEnabled: () => false });
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.reports, []);
}

console.log('迁移回归通过：真实推送唤醒、账号隔离、观察状态、旧服务/领奖实际接线、复查节流及详细配置接管防重。');
