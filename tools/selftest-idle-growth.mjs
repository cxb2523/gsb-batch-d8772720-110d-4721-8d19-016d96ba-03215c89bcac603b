// Spending automation: guild aid, hero growth, stage pushing and treasure dispatch.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../src/proto.mjs';
import { planGuildAid, serviceGuildAid } from '../src/guild-aid.mjs';
import { limitHeroSteps, serviceHeroGrowth, serviceStageAuto, stageRetryWait } from '../src/progress-automation.mjs';
import { pickTreasure, serviceTreasureLoot } from '../src/treasure-loot.mjs';
import { isFleetReserved, registerFleetReservations } from '../src/fleet-reservations.mjs';
import { runStages } from '../src/stages.mjs';

const protocol = loadProtocol();
function fakeClient(handlers) {
  const client = new EventEmitter();
  client.connected = true;
  client.serverClockOffsetMs = 0;
  client.promptNames = {};
  client.calls = [];
  const call = (name, body) => {
    assert(protocol[name], '协议没有 ' + name);
    protocol[name].encode(body ?? {}).finish();
    client.calls.push([name, body]);
    const handler = handlers[name];
    if (handler === undefined) throw new Error('未预期的请求 ' + name);
    return typeof handler === 'function' ? handler(body) : handler;
  };
  client.request = async (name, body, response) => {
    for (const reply of [response].flat()) assert(protocol[reply], '协议没有 ' + reply);
    return call(name, body);
  };
  client.sendWatch = async (name, body) => ({ sent: 1, name, result: call(name, body) });
  client.sent = name => client.calls.filter(([request]) => request === name);
  return client;
}
const prompt = (request, text = 'refused') => Object.assign(new Error('server prompt: ' + text), { prompt: { prompt: 1 }, request });
const collect = () => { const entries = []; return { entries, report: entry => entries.push(entry) }; };

// ---- 联盟互助 ----
{
  const me = { low: 1, high: 0 };
  const other = { low: 2, high: 0 };
  const now = 1000;
  const asks = [
    { reqId: 1, reqItemId: '木材', endTime: 3000, asker: { playerId: other } },
    { reqId: 2, reqItemId: '木材', endTime: 2000, asker: { playerId: other } },
    { reqId: 3, reqItemId: '玻璃', endTime: 1500, asker: { playerId: other } },
    { reqId: 4, reqItemId: '木材', endTime: 500, asker: { playerId: other } },
    { reqId: 5, reqItemId: '木材', endTime: 1100, asker: { playerId: me } },
  ];
  const stock = new Map([['木材', 1], ['玻璃', 0]]);
  assert.deepEqual(planGuildAid(asks, stock, '1', now, 5).map(ask => ask.reqId), [2], '跳过过期、自己和无余量的求助，最快过期的优先');
  assert.deepEqual(planGuildAid(asks, new Map([['木材', 9]]), '1', now).map(ask => ask.reqId), [2], '默认每轮只响应一次');
}
const reservedWorld = (items, orderNeed = []) => ({
  OnWaterRequest: { building: [], workerOrder: orderNeed.length ? [{ index: 0, requirements: orderNeed, workerId: 1 }] : [] },
  AllItemRequest: () => ({ items: items() }),
  WeekInfoRequest: { activityTime: [] },
  CargoShipsRequest: { ship: [] },
});
const reservationConfig = { tables: { CargoUnlockCfg: { data: [{ index: 1, playerLevel: 9 }] }, ModuleOpenCfg: { data: [] } } };
const aidPlayer = (id = 11) => ({ level: 20, playerId: { low: id, high: 0 }, worldId: { low: 5, high: 0 }, guildId: { low: 7, high: 0 } });
const ask = (reqId, item = '木材') => ({ reqId: { low: reqId, high: 0 }, reqItemId: item, endTime: 4_000_000_000, asker: { playerId: { low: 99, high: 0 } } });
{
  // 居民订单需要 5 个木材，库存 5 个时不能拿去互助。
  const client = fakeClient({ ...reservedWorld(() => [{ itemId: '木材', num: 5 }], [{ type: 0, id: '木材', num: 5 }]),
    GuildAidListRequest: { askItems: [ask(1)] } });
  const { entries, report } = collect();
  await serviceGuildAid(client, protocol, reservationConfig, { player: aidPlayer(11), enabled: () => true, report });
  assert.match(entries[0].reason, /没有可用于互助/);
  assert.equal(client.sent('GuildAidHelpRequest').length, 0);
}
{
  let wood = 6,inventoryReady=true;
  const client = fakeClient({ ...reservedWorld(() => inventoryReady?[{ itemId: '木材', num: wood }]:undefined, [{ type: 0, id: '木材', num: 5 }]),
    GuildAidListRequest: { askItems: [ask(1), ask(2)] },
    GuildAidHelpRequest: () => {inventoryReady=false;return { reward: { asset: [{ id: '功勋', num: 10 }] } };} });
  const { entries, report } = collect();
  const player = aidPlayer(12);
  await serviceGuildAid(client, protocol, reservationConfig, { player, enabled: () => true, report });
  assert.equal(entries[0].ok, true);
  assert.equal(client.sent('GuildAidHelpRequest')[0][1].reqId.length, 1, '一次只响应一个，结果才可确认');
  await serviceGuildAid(client, protocol, reservationConfig, { player, enabled: () => true, report });
  assert.match(entries[1].reason??entries[1].error, /库存|尚未确认/, '完整库存不可读时不能继续消耗');
  assert.equal(client.sent('GuildAidHelpRequest').length, 1);
  wood = 5;inventoryReady=true;
  await serviceGuildAid(client, protocol, reservationConfig, { player, enabled: () => true, report });
  assert.match(entries[2].reason, /没有可用于互助/, '扣减后不再有余量');
}
{
  const client = fakeClient({ ...reservedWorld(() => [{ itemId: '木材', num: 9 }]), GuildAidListRequest: { askItems: [ask(1)] },
    GuildAidHelpRequest: () => { throw prompt('GuildAidHelpRequest'); } });
  const { entries, report } = collect();
  const player = aidPlayer(13);
  await serviceGuildAid(client, protocol, reservationConfig, { player, enabled: () => true, report });
  assert.equal(entries[0].ok, false);
  await serviceGuildAid(client, protocol, reservationConfig, { player, enabled: () => true, report });
  assert.equal(client.sent('GuildAidHelpRequest').length, 2, '明确被拒后释放预扣，可以重新核对');
}
{
  let wood=3;const asks=[ask(701),ask(702)],player=aidPlayer(701);
  const client=fakeClient({...reservedWorld(()=>[{itemId:'木材',num:wood}]),GuildAidListRequest:()=>({askItems:asks}),
    GuildAidHelpRequest:body=>{wood+=2;asks.splice(asks.findIndex(row=>row.reqId.low===body.reqId[0].low),1);return {reward:{asset:[{id:'功勋',num:10}]}};}});
  assert.equal((await serviceGuildAid(client,protocol,reservationConfig,{player,enabled:()=>true})).ok,true);
  assert.equal((await serviceGuildAid(client,protocol,reservationConfig,{player,enabled:()=>true})).ok,true);
  assert.equal(wood,7);assert.equal(client.sent('GuildAidHelpRequest').length,2,'互助成功后的补产不会卡住后续请求');
}
{
  const player=aidPlayer(702),asks=[ask(711),ask(712,'玻璃')];let writes=0;
  const client=fakeClient({...reservedWorld(()=>[{itemId:'木材',num:8},{itemId:'玻璃',num:8}]),GuildAidListRequest:()=>({askItems:asks}),
    GuildAidHelpRequest:()=>{writes++;if(writes===1)throw Error('unknown gift');return {reward:{asset:[{id:'功勋',num:10}]}};}});
  assert.equal((await serviceGuildAid(client,protocol,reservationConfig,{player,enabled:()=>true})).ok,false);
  assert.equal((await serviceGuildAid(client,protocol,reservationConfig,{player,enabled:()=>true})).ok,true,'木材赠送未知不阻止无关玻璃赠送');
  assert.equal(writes,2);
}
{
  const player=aidPlayer(703);let unsent=true;
  const client=fakeClient({...reservedWorld(()=>[{itemId:'木材',num:8}]),GuildAidListRequest:()=>({askItems:[ask(713)]}),
    GuildAidHelpRequest:()=>{if(unsent)throw Object.assign(Error('not sent'),{notSent:true});return {reward:{asset:[{id:'功勋',num:10}]}};}});
  assert.equal((await serviceGuildAid(client,protocol,reservationConfig,{player,enabled:()=>true})).ok,false);unsent=false;
  assert.equal((await serviceGuildAid(client,protocol,reservationConfig,{player,enabled:()=>true})).ok,true,'明确未发送后释放材料及求助ID记录');
  assert.equal(client.sent('GuildAidHelpRequest').length,2);
}
{
  const client = fakeClient({});
  const { entries, report } = collect();
  await serviceGuildAid(client, protocol, reservationConfig, { player: { ...aidPlayer(), guildId: 0 }, enabled: () => true, report });
  assert.match(entries[0].reason, /未加入联盟/);
  assert.equal(client.calls.length, 0);
}

// ---- 英雄养成 ----
assert.deepEqual(limitHeroSteps([{ kind: 'level', from: 1, to: 9, count: 8 }]), [{ kind: 'level', from: 1, to: 6, count: 5 }], '升级步骤按次数拆开');
assert.equal(limitHeroSteps([{ kind: 'level', from: 1, to: 3, count: 2 }, { kind: 'star', to: 1 }, { kind: 'skill', to: 2 }, { kind: 'star', to: 2 }, { kind: 'star', to: 3 }]).length, 4);
{
  const { planHeroes } = await import('../src/heroes.mjs');
  const { getConfig } = await import('../src/config.mjs');
  let real = null;
  try { real = getConfig(); } catch { /* 没有配置表时跳过真实规划 */ }
  assert(real, '测试依赖本机配置表');
  const hero = real.tables.HeroCfg.data[0];
  const other = real.tables.HeroCfg.data[1];
  const heroes = [{ heroId: hero.id, level: 1, star: 0, skillLevels: [1, 0, 0, 0] }, { heroId: other.id, level: 1, star: 0, skillLevels: [1, 0, 0, 0] }];
  const items = [{ itemId: '英雄经验', num: 100000000 }, { itemId: hero.universalItemId, num: 100000 }];
  const client = fakeClient({
    GetFormationRequest: { formation: { heroPositions: [{ heroId: hero.id, pos: { x: 1, y: 1 } }] } },
    AllHeroRequest: { heroes },
    AllItemRequest: { items },
    HeroLevelUpRequest: () => ({}),
  });
  const { entries, report } = collect();
  await serviceHeroGrowth(client, protocol, real, { player: { level: 60 }, enabled: () => true, report });
  assert.equal(entries[0].ok, true, JSON.stringify(entries));
  const ups = client.sent('HeroLevelUpRequest');
  assert.equal(ups.length, 5, '每轮最多 5 步');
  assert(ups.every(([, body]) => body.heroId === hero.id), '只养成主线阵容');
  assert.equal(client.sent('HeroStarUpRequest').length, 0, '不能使用万能碎片升星');
  assert.equal(planHeroes({ config: real, heroes, itemNum: id => (id === hero.universalItemId ? 100000 : 0), playerLevel: 60, allowUniversal: false, heroIds: [hero.id] })
    .steps.filter(step => step.kind === 'star').length, 0);

  const empty = fakeClient({ GetFormationRequest: { formation: { heroPositions: [] } } });
  const none = collect();
  await serviceHeroGrowth(empty, protocol, real, { player: { level: 60 }, enabled: () => true, report: none.report });
  assert.match(none.entries[0].reason, /无法确认主线阵容/);
  assert.equal(empty.calls.length, 1);

  const refused = fakeClient({
    GetFormationRequest: { formation: { heroPositions: [{ heroId: hero.id }] } }, AllHeroRequest: { heroes }, AllItemRequest: { items },
    HeroLevelUpRequest: () => { throw prompt('HeroLevelUpRequest'); },
  });
  const rejected = collect();
  await serviceHeroGrowth(refused, protocol, real, { player: { level: 60 }, enabled: () => true, report: rejected.report });
  assert.equal(rejected.entries.at(-1).ok, false);
  assert.equal(refused.sent('HeroLevelUpRequest').length, 1, '被拒后本轮不再重试同类操作');
}

// ---- 主线推图 ----
const stageConfig = { tables: { StageCfg: { data: [1, 2, 3, 4, 5, 6].map(stage => ({ stage, playerLevel: stage === 6 ? 99 : 1 })) } } };
const battle = won => stage => ({ initialData: { mainlineStage: stage }, stats: { isLeftWin: won(stage) } });
{
  const { wins, reachedLimit } = await runStages(fakeClient({ ChallengeStageRequest: ({ stage }) => battle(() => true)(stage) }),
    { level: 10, mainlineStage: 1 }, stageConfig, { allowMutate: true, maxWins: 2, wait: async () => {} });
  assert.equal(wins, 2);
  assert.equal(reachedLimit, true);
}
assert.equal(stageRetryWait(null, { mainlineStage: 3 }, 100), null);
assert.equal(stageRetryWait({ stage: 2, power: 100, at: 0 }, { mainlineStage: 3, power: 100 }, 100), null, '已过关不用等待');
assert.equal(stageRetryWait({ stage: 3, power: 100, at: 0 }, { mainlineStage: 3, power: 100 }, 100), 21600);
assert.equal(stageRetryWait({ stage: 3, power: 100, at: 0 }, { mainlineStage: 3, power: 103 }, 100), null, '战力涨 3% 就重试');
assert.equal(stageRetryWait({ stage: 3, power: 100, at: 0 }, { mainlineStage: 3, power: 100 }, 21600), null, '超过 6 小时重试');
assert.equal(stageRetryWait({ stage: 3, power: 0, at: 0 }, { mainlineStage: 3, power: 5 }, 100), 21600, '未知战力不能当作已上涨');
{
  const player = { level: 10, mainlineStage: 1, power: 1000 };
  const client = fakeClient({ ChallengeStageRequest: ({ stage }) => battle(s => s < 3)(stage) });
  const { entries, report } = collect();
  const options = { player, enabled: () => true, report, wait: async () => {} };
  await serviceStageAuto(client, stageConfig, options);
  assert.equal(player.mainlineStage, 3, '过关后要更新关卡');
  assert.match(entries[0].label, /第 1、2 关/);
  assert.match(entries[1].label, /第 3 关战败/);
  assert.equal(client.sent('ChallengeStageRequest').length, 3);
  await serviceStageAuto(client, stageConfig, options);
  assert.equal(client.sent('ChallengeStageRequest').length, 3, '战力没涨时不能空打');
  assert.match(entries[2].reason, /等待战力上涨/);
  player.power = 1100;
  await serviceStageAuto(client, stageConfig, options);
  assert.equal(client.sent('ChallengeStageRequest').length, 4, '战力上涨后重试');
}
{
  const player = { level: 10, mainlineStage: 1, power: 1000 };
  const client = fakeClient({ ChallengeStageRequest: ({ stage }) => battle(() => true)(stage) });
  const { report } = collect();
  await serviceStageAuto(client, stageConfig, { player, enabled: () => true, report, wait: async () => {} });
  assert.equal(client.sent('ChallengeStageRequest').length, 3, '每轮最多 3 关');
  const busy = fakeClient({});
  const skipped = collect();
  await serviceStageAuto(busy, stageConfig, { player, enabled: () => true, report: skipped.report, isBusy: () => true });
  assert.match(skipped.entries[0].reason, /手动推关/);
  const locked = collect();
  await serviceStageAuto(fakeClient({}), stageConfig, { player: { level: 1, mainlineStage: 6, power: 1 }, enabled: () => true, report: locked.report, wait: async () => {} });
  assert.match(locked.entries[0].reason, /等级/);
}

// ---- 世界宝藏 ----
assert.equal(pickTreasure([{ uid: 1, color: 4, progress: 10, ownerGuildIdx: 9 }, { uid: 2, color: 2, progress: 10, ownerGuildIdx: 0 }], 4).uid, 2, '不去其他联盟的宝藏');
assert.equal(pickTreasure([{ uid: 1, color: 2, progress: 10, ownerGuildIdx: 0 }, { uid: 2, color: 4, progress: 50, ownerGuildIdx: 4 }], 4).uid, 2, '优先品质高的');
assert.equal(pickTreasure([{ uid: 1, color: 2, progress: 100, ownerGuildIdx: 0 }], 4), null);
assert.equal(pickTreasure([{ uid: 1, color: 2, progress: 1, ownerGuildIdx: 0 }], 4, new Map([[1, 200]]), 100), null, '被拒的宝藏暂时不再尝试');

const treasureConfig = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界宝藏', playerLevel: 19 }] },
  GameplayOpenCfg: { data: [{ gameplay: '世界宝藏', openDays: [3] }] },
  GuildTitleCfg: { data: [{ title: 1, treasureLoot: 0 }, { title: 2, treasureLoot: 1 }] },
  TreasureLootParamCfg: { data: [{ paramName: '每日宝藏奖励次数', paramValue: 3 }] },
  TreasureLootCfg: { data: [{ quality: 'BLUE', name: '小型货轮' }, { quality: 'PURPLE', name: '中型货轮' }, { quality: 'ORANGE', name: '万吨货轮' }] },
  WorldParamCfg: { data: [{ paramName: '进攻宝藏消耗汽油', paramValue: 500 }] },
} };
const treasurePlayer = { level: 21, worldId: 2_001_000_007, guildId: 2004001001004, worldOpenTime: 1000 };
const idleFleet = (id, extra = {}) => ({ buildingId: id, state: 1, durability: 100, maxDura: 100, treasureLootUid: 0, power: 10, ...extra });
const realNow = Date.now;
Date.now = () => Date.UTC(2026, 10, 5, 2) ; // 北京时间 10:00
const treasureWorld = (overrides = {}) => {
  const state = { fleets: [idleFleet('1远征船', { power: 5 }), idleFleet('2远征船', { power: 50 }), idleFleet('3远征船', { durability: 10 })] };
  return { state, client: fakeClient({
    GuildInfoRequest: { myTitle: 2 },
    TreasureLootStatsRequest: { todayRewardTimes: 0 },
    MyFleetsRequest: () => ({ fleets: state.fleets }),
    AllItemRequest: { items: [{ itemId: '汽油', num: 20000 }] },
    TreasureLootListRequest: { treasure: [{ uid: 7, color: 5, progress: 10, ownerGuildIdx: 0, reward: { asset: [{ id: '蓝芯片宝箱', num: 3 }] } }] },
    TreasureLootSendFleetsRequest: ({ fleetBuildingIds }) => {
      state.fleets = state.fleets.map(fleet => (fleet.buildingId === fleetBuildingIds[0] ? { ...fleet, treasureLootUid: 7 } : fleet));
      return {};
    },
    ...overrides,
  }) };
};
try {
  {
    const { client, state } = treasureWorld();
    const { entries, report } = collect();
    const options = { player: treasurePlayer, protocol, enabled: () => true, report };
    await serviceTreasureLoot(client, treasureConfig, options);
    assert.equal(entries[0].ok, true, JSON.stringify(entries));
    assert.deepEqual(client.sent('TreasureLootSendFleetsRequest')[0][1], { uid: 7, fleetBuildingIds: ['2远征船'] }, '选耐久达标里战力最高的一队');
    assert.equal(isFleetReserved(client, '2远征船'), true, '派遣后要占用舰队，其他玩法不能再用');
    await serviceTreasureLoot(client, treasureConfig, options);
    assert.match(entries[1].reason, /尚未返回/);
    assert.equal(client.sent('TreasureLootSendFleetsRequest').length, 1, '一次只派一队');
    state.fleets = state.fleets.map(fleet => ({ ...fleet, treasureLootUid: 0 }));
    await serviceTreasureLoot(client, treasureConfig, options);
    assert.equal(isFleetReserved(client, '2远征船'), true, '已派出，返回后才可再次使用');
    assert.equal(client.sent('TreasureLootSendFleetsRequest').length, 2);
  }
  const reasonFor = async (player, overrides, config = treasureConfig) => {
    const { client } = treasureWorld(overrides);
    const { entries, report } = collect();
    await serviceTreasureLoot(client, config, { player, protocol, enabled: () => true, report });
    assert.equal(client.sent('TreasureLootSendFleetsRequest').length, 0);
    return entries[0].reason;
  };
  assert.match(await reasonFor({ ...treasurePlayer, level: 10 }), /19 级开放/);
  assert.match(await reasonFor({ ...treasurePlayer, guildId: 0 }), /未加入联盟/);
  assert.match(await reasonFor(treasurePlayer, { GuildInfoRequest: { myTitle: 1 } }), /职级不能占领/);
  assert.match(await reasonFor(treasurePlayer, { TreasureLootStatsRequest: { todayRewardTimes: 3 } }), /已用完/);
  assert.match(await reasonFor(treasurePlayer, { AllItemRequest: { items: [{ itemId: '汽油', num: 10400 }] } }), /保留 10000 汽油/);
  assert.match(await reasonFor(treasurePlayer, { TreasureLootListRequest: { treasure: [{ uid: 7, color: 5, progress: 10, ownerGuildIdx: 9 }] } }), /无主或本盟/);
  assert.match(await reasonFor(treasurePlayer, { MyFleetsRequest: { fleets: [idleFleet('1远征船', { durability: 50 })] } }), /耐久/);
  assert.match(await reasonFor(treasurePlayer, { MyFleetsRequest: { fleets: [idleFleet('1远征船', { treasureLootUid: 3 }), idleFleet('2远征船', { treasureLootUid: 4 }), idleFleet('3远征船', { treasureLootUid: 5 })] } }), /足够领完/);
  assert.match(await reasonFor({ ...treasurePlayer, worldOpenTime: Date.now() / 1000 }), /尚未开放/);
  {
    const { client } = treasureWorld();
    registerFleetReservations(client, 'radar', () => false, () => true);
    const { entries, report } = collect();
    await serviceTreasureLoot(client, treasureConfig, { player: treasurePlayer, protocol, enabled: () => true, report });
    assert.match(entries[0].reason, /尚未确认/, '其他玩法结果未确认时等待');
    assert.equal(client.sent('TreasureLootSendFleetsRequest').length, 0);
  }
  {
    const { client } = treasureWorld({ TreasureLootSendFleetsRequest: () => { throw prompt('TreasureLootSendFleetsRequest'); } });
    const { entries, report } = collect();
    await serviceTreasureLoot(client, treasureConfig, { player: treasurePlayer, protocol, enabled: () => true, report });
    assert.equal(entries[0].ok, false);
    assert.equal(isFleetReserved(client, '2远征船'), false, '明确被拒后释放舰队');
  }
  {
    const { client } = treasureWorld({ TreasureLootSendFleetsRequest: () => ({}) });
    const { entries, report } = collect();
    await serviceTreasureLoot(client, treasureConfig, { player: treasurePlayer, protocol, enabled: () => true, report });
    assert.match(entries[0].error, /未确认/);
    assert.equal(isFleetReserved(client, '2远征船'), true, '结果不明时继续占用舰队，不重复派遣');
  }
  Date.now = () => Date.UTC(2026, 10, 5, 12, 30); // 北京时间 20:30
  assert.match(await reasonFor(treasurePlayer), /城战/);
} finally {
  Date.now = realNow;
}
console.log('idle growth ok: reserved aid materials, formation-only heroes, stage backoff, treasure fleet reservation and fuel floor');
