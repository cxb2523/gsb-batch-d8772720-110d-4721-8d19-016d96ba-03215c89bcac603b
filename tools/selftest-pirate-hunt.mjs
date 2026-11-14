import {testPirateRecovery} from './selftest-pirate-recovery.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { pirateHuntOptions, startPirateHunt } from '../src/pirates.mjs';

const player = { level: 16, worldId: 1000001, scenarioId: 1 };
const cfg = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }] },
  WorldPirateCfg: { data: [1, 2, 3].map(level => ({ type: 1, level, season: '1', showName: '海盗先锋', power: 84000 * level })) },
  '1_CityCfg': { data: [{ id: 1, name: '太阳岛' }] },
  '1_SeasonTaskCfg': { data: [{ stage: 1, season: 1, maxPirateLevel: 1 }] },
  WorldParamCfg: { data: [{ paramName: '打野怪消耗汽油', paramValue: 300 }] },
  HeroCfg: { data: [{ id: '瑞文', name: '骑士瑞文' }] },
} };

function fixture() {
  const client = new EventEmitter();
  client.writes = [];
  const fleet = { buildingId: '1远征船', state: 1, durability: 42, power: 84000 };
  const building = { buildingId: fleet.buildingId, level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '瑞文', pos: { x: 1, y: 1 } }] } } };
  const data = {
    OnWaterResponse: { building: [building] }, MyFleetsResponse: { fleets: [fleet] },
    SeasonTaskStageResponse: { stage: 1 }, PirateKillRecordResponse: { records: [] },
    UniteWorldsPlanResponse: { worldIds: [], executeTs: 0 },
    AllItemResponse: { items: [{ itemId: '汽油', num: 300 }] },
    AllPirateResponse: { pirates: [1, 2, 3].map(level => ({ type: 1, level, uid: 200 + level, cityId: 1, gridIdx: 400 + level })) },
  };
  client.request = async (name, body, response) => {
    if (name === 'WorldInfoRequest') {
      assert.deepEqual(body, { screenCenter: { x: 0, y: 0 } });
      assert.equal(response, 'WorldInfoResponse');
      return { fleets: [] };
    }
    assert.deepEqual(body, {});
    assert.equal(response, name.replace(/Request$/, 'Response'));
    assert(Object.hasOwn(data, response));
    return data[response];
  };
  client.sendWatch = async (name, body) => {
    assert.equal(name, 'ChallengePirateRequest');
    assert.deepEqual(body, { uid: 201, cityId: 1, fleetBuildingIds: ['1远征船'] });
    client.writes.push(body);
  };
  return { client, data, fleet, building };
}
const options = client => pirateHuntOptions(client, cfg, player);
async function selection(client) {
  const view = await options(client);
  return { targetKey: view.targets[0]?.targetKey, fleetKey: view.fleets[0]?.key };
}
const send = (client, choice) => startPirateHunt(client, cfg, player, choice);

export async function testPirateHunt() {
  testPirateRecovery();
  const { client, data, fleet } = fixture();
  const view = await options(client);
  assert.equal(view.targets.length, 1);
  assert.deepEqual(view.fleets[0].heroes, ['骑士瑞文']);
  assert.equal(view.targets[0].location, '太阳岛 · 第 1 处');
  assert.equal(view.fuelPerFleet, 300);
  const updates = [], choose = { ...(await selection(client)), report: e => updates.push(e) };
  assert.equal((await send(client, choose)).status, 'sent');
  await assert.rejects(send(client, choose), /变化|等待|请求/);
  const renewed = await selection(client);
  await assert.rejects(send(client, renewed), /等待|请求|派出/);
  assert.equal(client.writes.length, 1);
  client.emit('message', { name: 'SCPirateCampaignEnd', body: { uid: 999, isWin: true } });
  assert.deepEqual(updates, []);
  client.emit('message', { name: 'SCMyFleetUpdate', body: { fleets: [{ ...fleet, state: 2, targetCityId: 1, targetGridIdx: 401 }] } });
  client.emit('message', { name: 'SCPirateCampaignBegin', body: { uid: 201 } });
  client.emit('message', { name: 'SCPirateCampaignEnd', body: { uid: 201, isWin: true } });
  assert.deepEqual(updates.map(e => e.status), ['started', 'ended']);
  data.PirateKillRecordResponse.records = [{ type: 1, maxKilledLevel: 1 }];
  const after = await options(client);
  assert.equal(updates.at(-1).status, 'won');
  assert.match(after.targets[0].reason, /赛季阶段/);

  for (const [mutate, reason] of [
    [({ data }) => { data.AllItemResponse.items[0].num = 299; }, /汽油/],
    [({ data }) => { data.UniteWorldsPlanResponse = { worldIds: [1], executeTs: Math.floor(Date.now() / 1000) + 40 }; }, /合服/],
    [({ data }) => { data.SeasonTaskStageResponse.stage = 99; }, /赛季/],
    [({ data }) => { data.AllPirateResponse.pirates = []; }, /暂无/],
    [({ data }) => { data.AllPirateResponse.pirates.push({ ...data.AllPirateResponse.pirates[0] }); }, /重复/],
    [({ building }) => { building.fleet.formation.heroPositions = []; }, /变化|编入/],
    [({ fleet }) => { fleet.durability = 0; }, /耐久/],
    [({ fleet }) => { fleet.state = 2; }, /闲置/],
    [({ fleet }) => { fleet.treasureLootUid = 50; }, /其他任务/],
    [({ data }) => { data.MyFleetsResponse.fleets = []; }, /已建成.*编队/],
  ]) {
    const f = fixture();
    const keys = await selection(f.client);
    mutate(f);
    await assert.rejects(send(f.client, keys), reason);
    assert.deepEqual(f.client.writes, []);
  }
  const blocked = await pirateHuntOptions({ request: () => assert.fail() }, cfg, { level: 15, worldId: 1000001 });
  assert(blocked.locked);
  const uncertain = fixture(), keys = await selection(uncertain.client);
  uncertain.client.sendWatch = async name => { uncertain.client.writes.push(name); throw Error('连接中断'); };
  assert.equal((await send(uncertain.client, keys)).status, 'unknown');
  await assert.rejects(send(uncertain.client, await selection(uncertain.client)), /等待|请求|派出/);
  assert.equal(uncertain.client.writes.length, 1, '未确认时刷新后也不重发');
  const paused = fixture();
  await assert.rejects(send(paused.client, { ...(await selection(paused.client)), enabled: () => false }), /暂停/);
  assert.equal(paused.client.writes.length, 0);

  const foreign = fixture(), events = [];
  await send(foreign.client, { ...(await selection(foreign.client)), report: e => events.push(e.status) });
  foreign.client.emit('message', { name: 'SCPirateCampaignBegin', body: { uid: 201 } });
  foreign.client.emit('message', { name: 'SCPirateCampaignEnd', body: { uid: 201, isWin: false } });
  assert.deepEqual(events, ['pending', 'unknown'], '仅目标广播不足以宣称本队已出征或失败');
  await assert.rejects(send(foreign.client, await selection(foreign.client)), /等待|请求|派出/);

  const recovering = fixture(), observed = [];
  const choice = await selection(recovering.client);
  recovering.client.sendWatch = async () => {
    const push = fields => recovering.client.emit('message', {name:'SCMyFleetUpdate',body:{fleets:[{buildingId:'1远征船',...fields}]}});
    push({state:2,targetCityId:0,targetGridIdx:401,moveEndTs:nowForTest()});
    push({state:5,cityId:39,curGridIdx:401});
    recovering.client.emit('message',{name:'SCPirateCampaignBegin',body:{uid:201}});
    push({state:3,cityId:39,curGridIdx:401});
    recovering.client.emit('message',{name:'SCPirateCampaignEnd',body:{uid:201,isWin:false}});
  };
  function nowForTest(){return Math.floor(Date.now()/1000)+7;}
  const lost=await send(recovering.client,{...choice,report:e=>observed.push(e.status)});
  assert.equal(lost.status,'lost');assert(observed.includes('started'));assert.equal(observed.at(-1),'lost');
  assert(!(await options(recovering.client)).fleets[0].reason);

  const unrelated=fixture();
  await send(unrelated.client,await selection(unrelated.client));
  unrelated.client.emit('message',{name:'SCMyFleetUpdate',body:{fleets:[{buildingId:'1远征船',state:3,curGridIdx:999},{buildingId:'2远征船',state:3,curGridIdx:401}]}});
  unrelated.client.emit('message',{name:'SCPirateCampaignEnd',body:{uid:201,isWin:false}});
  assert.match((await options(unrelated.client)).fleets[0].reason,/待确认|已派出/);

  const rejected = fixture();
  const rejection = Object.assign(new Error('server prompt: insufficient petrol'), { request: 'ChallengePirateRequest', prompt: {} });
  rejected.client.sendWatch = async () => { throw rejection; };
  await assert.rejects(send(rejected.client, await selection(rejected.client)), /insufficient petrol/);
  const retry = await options(rejected.client);
  assert(!retry.targets[0].reason && !retry.fleets[0].reason, '收到明确拒绝后允许用户重新选择');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await testPirateHunt();
  console.log('pirate hunt ok: real target, formation, fuel, merge, confirmed dispatch and results, no duplicate attempts');
}
