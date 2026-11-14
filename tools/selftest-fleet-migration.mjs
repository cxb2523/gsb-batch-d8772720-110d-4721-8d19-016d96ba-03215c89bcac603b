// 两代调度器同时启用时，用真实旧情报入口与新玩法入口验证预留互通。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { serviceRadar } from '../src/radar.mjs';
import { runAllianceRadar } from '../src/alliance-radar.mjs';
import { pickTreasureFleet, runTreasureLoot } from '../src/treasure-loot.mjs';
import { runCityWar } from '../src/city-war.mjs';
import { runWorldBoss } from '../src/world-boss.mjs';
import { inspectHunt, startPirateHunt } from '../src/pirates.mjs';
import { runSinglePirateHunt, runPirateAdvance } from '../src/pirate-advance.mjs';
import { settleFleetSnapshot } from '../src/fleet-settlement.mjs';
import {
  bridgeFleetReservations, dispatchReservationReason, legacyFleetReservationReason, reserveDispatch
} from '../src/fleet-availability.mjs';
import {
  hasOtherFleetReservations, isFleetReserved, observeFleetReservations, registerFleetReservations
} from '../src/fleet-reservations.mjs';
import { treasureFixture, treasureSettings } from './fixtures/treasure-loot.mjs';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';
import { pirateAdvanceFixture } from './fixtures/pirate-advance.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fleet-migration-'));
const protocol = loadProtocol(), world = '2002001001', id = '1远征船';
let sequence = 0, passed = 0;
const ledger = () => createUsageLedger('虚构迁移账号', { file: path.join(directory, ++sequence + '.json') });
const home = () => ({ buildingId: id, state: 1, curGridIdx: 0, treasureLootUid: 0,
  durability: 2000, maxDura: 2000, power: 1200 });
const test = async (label, action) => { await action(); passed++; console.log('通过：' + label); };

function radarFixture({ unknown = false } = {}) {
  const player = { playerId: 42, guildId: 1001007, worldId: Number(world), level: 36 };
  const data = { fleets: [home()], fuel: 20000, events: [
    { uid: '9001', eventId: 10001, color: 3, gridIdx: 9001, createTime: 0,
      state: 1, startTime: 0, pirate: { type: 1, level: 1 }, reward: { asset: [] } }
  ] };
  const config = { tables: Object.fromEntries(Object.entries({
    ModuleOpenCfg: [{ moduleId: '联盟情报', playerLevel: 18 }],
    RadarRandEventCfg: [{ eventId: 10001, type: '击退海盗', param1: 1, eventName: '虚构情报' }],
    WorldParamCfg: [{ paramName: '情报事件消耗汽油', paramValue: 500 }],
    WorldPirateCfg: [{ season: '2', type: 1, level: 1, power: 1000 }],
  }).map(([key, rows]) => [key, { data: rows }])) };
  const settings = defaultSettings();
  Object.assign(settings.radar, { enabled: true, fleetIds: [id], types: ['pirate'], petrolReserve: 0 });
  const client = { connected: true, writes: [], async request(name, body = {}, response) {
    assert(protocol[name], name); assert(protocol[response], response);
    protocol[name].decode(protocol[name].encode(body).finish());
    let value;
    if (name === 'GuildInfoRequest') value = { guild: { guildId: player.guildId } };
    else if (name === 'RadarInfoRequest') value = { radarInfo: { events: data.events } };
    else if (name === 'MyFleetsRequest') value = { fleets: data.fleets };
    else if (name === 'AllItemRequest') value = { items: [{ itemId: '汽油', num: data.fuel }] };
    else if (name === 'OnWaterRequest') value = { building: [{ buildingId: id, level: 1,
      fleet: { formation: { heroPositions: [{ heroId: '兰博', pos: { x: 0, y: 0 } }] } } }] };
    else if (name === 'UniteWorldsPlanRequest') value = { worldIds: [] };
    else assert.fail('意外请求：' + name);
    return protocol[response].decode(protocol[response].encode(value).finish());
  }, async sendWatch(name, body) {
    assert(protocol[name], name);
    protocol[name].decode(protocol[name].encode(body).finish());
    assert.equal(name, 'RadarSendFleetsRequest');
    this.writes.push({ name, body: structuredClone(body) });
    if (!unknown) {
      Object.assign(data.fleets[0], { state: 2, targetGridIdx: 9001 });
      Object.assign(data.events[0], { state: 3, startTime: Math.floor(Date.now() / 1000) });
      data.fuel -= 500;
    }
  } };
  return { client, data, config, settings, player };
}
const legacyRadar = f => serviceRadar(f.client, protocol, f.config,
  { player: f.player, enabled: key => key === 'radarAuto' });
const modernRadar = (f, l) => runAllianceRadar(f.client, f.config, f.player,
  { getSettings: () => f.settings, ledger: l, enabled: () => true, report: () => {} });
const bridge = (f, l) => bridgeFleetReservations(f.client, () => f.settings, l, world);
function bossFixture() {
  const f = radarFixture();
  f.config.tables.ModuleOpenCfg.data.push({ moduleId: '世界', playerLevel: 16 });
  f.config.tables.WorldParamCfg.data.push({ paramName: '进攻首领消耗汽油', paramValue: 300 });
  Object.assign(f.settings.worldBoss, { enabled: true, fleetIds: [id], petrolReserve: 0 });
  let count = 0;
  const request = f.client.request;
  f.client.request = async (name, body = {}, response) => {
    assert(protocol[name], name); assert(protocol[response], response);
    protocol[name].decode(protocol[name].encode(body).finish());
    let result;
    if (name === 'WorldBossInfoRequest') result = { info: { bossId: 1, gridIdx: 99 } };
    else if (name === 'CounterInfoRequest') result = { counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: count, updateTime: Math.floor(Date.now() / 1000) }] };
    else if (name === 'ChallengeWorldBossRequest') {
      f.client.writes.push({ name, body }); count++;
      Object.assign(f.data.fleets[0], { state: 2, targetGridIdx: 99 }); result = {};
    } else return request.call(f.client, name, body, response);
    return protocol[response].decode(protocol[response].encode(result).finish());
  };
  return f;
}
async function modernPirate(f, l, advance = false) {
  const options = { ledger: l, getSettings: () => f.settings, enabled: () => true };
  if (advance) return runPirateAdvance({ ...f, ...options, options: f.settings.pirateHunt,
    sleep: async () => assert.fail('首杀应在首个目标后停止，不能进入等待循环') });
  const snap = await inspectHunt(f.client, f.config, f.player);
  return runSinglePirateHunt(f.client, f.config, f.player, { ...options,
    targetKey: snap.view.targets[0].targetKey, fleetKey: snap.view.fleets[0].key });
}
const addRadar = (l, suffix = '9001', selectedWorld = world) => {
  const key = 'radar-send:' + selectedWorld + ':' + suffix;
  const ticket = l.reserve({ radarPetrol: 500 }, {}, {}, { uniqueKey: key,
    details: { kind: 'radarSend', eventKey: suffix, buildingId: id, active: true } });
  return { key, ticket };
};

try {
  await test('空桥不锁住原自动情报和宝藏选船，桥接检查不递归', async () => {
    const f = radarFixture(), l = ledger(); bridge(f, l);
    assert.equal(hasOtherFleetReservations(f.client, 'radar'), false);
    assert.equal(isFleetReserved(f.client, id), false);
    assert.equal(pickTreasureFleet([home()], f.client)?.buildingId, id);
    const entries = await legacyRadar(f); assert.equal(f.client.writes.length, 1, JSON.stringify(entries));
  });

  await test('旧情报未知派遣阻止新调度，只有旧 owner 的出征及返航证据解除', async () => {
    const f = radarFixture({ unknown: true }), l = ledger(); bridge(f, l);
    await legacyRadar(f); assert.equal(f.client.writes.length, 1);
    assert.match(dispatchReservationReason(f.client, f.settings, 'worldBoss', id), /原自动任务/);
    await modernRadar(f, l); assert.equal(f.client.writes.length, 1);
    reserveDispatch(f.client, 'maintenance', []);
    settleFleetSnapshot(l, { worldId: world, fleets: [home()], events: [] });
    observeFleetReservations(f.client, { fleets: [home()], fuel: f.data.fuel });
    assert(legacyFleetReservationReason(f.client, id), '无出征证据时仅见空闲不能释放旧 owner');
    observeFleetReservations(f.client, { fleets: [{ ...home(), state: 2, targetGridIdx: 9001 }], fuel: 19500 });
    assert(legacyFleetReservationReason(f.client, id));
    observeFleetReservations(f.client, { fleets: [home()], fuel: 19500 });
    assert.equal(legacyFleetReservationReason(f.client, id), '');
    assert.equal(dispatchReservationReason(f.client, f.settings, 'worldBoss', id), '');
  });

  await test('新账本未知及已确认在途记录均阻止旧派遣，归队加事件终态才释放', async () => {
    const f = radarFixture(), l = ledger(), { key, ticket } = addRadar(l); bridge(f, l);
    assert.equal(pickTreasureFleet([home()], f.client), null);
    await legacyRadar(f); assert.equal(f.client.writes.length, 0);
    settleFleetSnapshot(l, { worldId: world, fleets: [home()], events: [] });
    assert(isFleetReserved(f.client, id), '未知派遣不可仅凭归队核销');
    l.confirm(ticket);
    observeFleetReservations(f.client, { fleets: [home()], fuel: 19500 });
    assert(isFleetReserved(f.client, id), '旧 owner 的快照不可越权清除新账本');
    settleFleetSnapshot(l, { worldId: world, fleets: [home()], events: [{ uid: '9001', state: 3 }] });
    assert(isFleetReserved(f.client, id));
    settleFleetSnapshot(l, { worldId: world, fleets: [home()], events: [{ uid: '9001', state: 4 }] });
    assert.equal(isFleetReserved(f.client, id), false);
    assert.equal(pickTreasureFleet([home()], f.client)?.buildingId, id);
    assert(l.hasKey(key)); assert.equal(l.confirmedCounters().radarPetrol, 500);
    await legacyRadar(f); assert.equal(f.client.writes.length, 1);
  });

  await test('新调度临时预留阻止旧入口，各 owner 只解除自己的预留且过期可恢复', async () => {
    const f = radarFixture(), l = ledger(); bridge(f, l);
    reserveDispatch(f.client, 'worldBoss', [id]);
    reserveDispatch(f.client, 'maintenance', [id]);
    await legacyRadar(f); assert.equal(f.client.writes.length, 0);
    assert.equal(pickTreasureFleet([home()], f.client), null);
    reserveDispatch(f.client, 'maintenance', []);
    assert(isFleetReserved(f.client, id), '清除维修不得解除 Boss 预留');
    reserveDispatch(f.client, 'worldBoss', []);
    assert.equal(hasOtherFleetReservations(f.client, 'radar'), false);
    reserveDispatch(f.client, 'maintenance', [id], Date.now() - 1);
    assert.equal(isFleetReserved(f.client, id), false);
    await legacyRadar(f); assert.equal(f.client.writes.length, 1);
  });

  await test('桥接按区服隔离，并从重建账本恢复未决记录', () => {
    const f = radarFixture(), l = ledger(); addRadar(l, '9002', '2002001002'); bridge(f, l);
    assert.equal(isFleetReserved(f.client, id), false);
    const own = addRadar(l);
    assert(isFleetReserved(f.client, id));
    const file = path.join(directory, 'reopened.json');
    const previous = createUsageLedger('虚构迁移账号', { file });
    const saved = addRadar(previous);
    const next = radarFixture();
    bridge(next, createUsageLedger('虚构迁移账号', { file }));
    assert.equal(pickTreasureFleet([home()], next.client), null);
    previous.cancel(saved.ticket);
    assert.equal(isFleetReserved(next.client, id), false);
    l.cancel(own.ticket);
    assert.equal(hasOtherFleetReservations(f.client, 'radar'), false, '其他区服未决记录不会锁住当前区服');
  });

  await test('新城战直接调用不能因城战时段预留开启而抢占旧 owner 舰队', async () => {
    const f = warForgeFixture(), settings = warForgeSettings(), l = ledger();
    settings.cityWar.fleetIds = [id]; settings.cityWar.reserveDuringWar = true;
    const held = new Set([id]);
    registerFleetReservations(f.client, 'radar', selected => held.has(selected), () => held.size > 0);
    bridgeFleetReservations(f.client, () => settings, l, String(f.player.worldId));
    const run = () => runCityWar(f.client, f.protocol, f.config, f.player,
      { getSettings: () => settings, ledger: l, mapLoader: f.mapLoader, canUseFleet: () => true });
    await run(); assert.equal(f.client.writes.length, 0);
    held.clear(); await run(); assert.equal(f.client.writes.length, 1);
  });

  await test('新巨轮和新情报直接调用均检查旧 owner，解除后能够派遣', async () => {
    const f = treasureFixture(), settings = treasureSettings(), l = ledger();
    settings.treasure.fleetIds = [id];
    const held = new Set([id]);
    registerFleetReservations(f.client, 'radar', selected => held.has(selected), () => held.size > 0);
    bridgeFleetReservations(f.client, () => settings, l, String(f.player.worldId));
    const run = () => runTreasureLoot(f.client, f.protocol, f.config, f.player,
      { getSettings: () => settings, ledger: l });
    await run(); assert.equal(f.client.writes.length, 0);
    held.clear(); await run(); assert.equal(f.client.writes.length, 1);
    const r = radarFixture(), rl = ledger(), other = new Set([id]); bridge(r, rl);
    registerFleetReservations(r.client, 'treasureLoot', selected => other.has(selected), () => other.size > 0);
    await modernRadar(r, rl); assert.equal(r.client.writes.length, 0);
    other.clear(); await modernRadar(r, rl); assert.equal(r.client.writes.length, 1);
  });

  await test('预留预算后出现旧 owner 占用时，三条新派遣入口取消预算且不发送', async () => {
    for (const kind of ['cityWar', 'treasure', 'radar']) {
      const f = kind === 'cityWar' ? warForgeFixture() : kind === 'treasure' ? treasureFixture() : radarFixture();
      const settings = kind === 'cityWar' ? warForgeSettings() : kind === 'treasure' ? treasureSettings() : f.settings;
      settings[kind].fleetIds = [id];
      const l = ledger(), reserve = l.reserve;
      l.reserve = (...args) => {
        const ticket = reserve(...args);
        registerFleetReservations(f.client, 'old-owner', selected => selected === id);
        return ticket;
      };
      if (kind === 'cityWar') await runCityWar(f.client, f.protocol, f.config, f.player,
        { getSettings: () => settings, ledger: l, mapLoader: f.mapLoader });
      else if (kind === 'treasure') await runTreasureLoot(f.client, f.protocol, f.config, f.player,
        { getSettings: () => settings, ledger: l });
      else await modernRadar(f, l);
      assert.equal(f.client.writes.length, 0, kind);
      assert.equal(l.snapshot().uncertain, 0, kind);
      assert.deepEqual(l.keyRecords(), {}, kind);
    }
  });
  await test('世界Boss和单次首杀默认入口不抢占旧 owner，忽略自己的桥后可正常发送', async () => {
    for (const kind of ['worldBoss', 'pirateHunt']) {
      const f = kind === 'worldBoss' ? bossFixture() : pirateAdvanceFixture(), l = ledger(), held = new Set([id]);
      bridgeFleetReservations(f.client, () => f.settings, l, String(f.player.worldId));
      registerFleetReservations(f.client, 'old-owner', selected => held.has(selected), () => held.size > 0);
      if (kind === 'worldBoss') await runWorldBoss(f.client, f.config, f.player,
        { getSettings: () => f.settings, ledger: l, enabled: () => true, report: () => {} });
      else await assert.rejects(() => modernPirate(f, l), /原自动任务/);
      assert.equal(f.client.writes.length, 0, kind);
      held.clear();
      if (kind === 'worldBoss') await runWorldBoss(f.client, f.config, f.player,
        { getSettings: () => f.settings, ledger: l, enabled: () => true, report: () => {} });
      else await modernPirate(f, l);
      assert.equal(f.client.writes.length, 1, kind + ' 不应被自己的预留阻塞');
    }
  });
  await test('预算预留期间出现旧占用，世界Boss、单次及连续首杀均取消预算且不发送', async () => {
    for (const kind of ['worldBoss', 'pirateSingle', 'pirateAdvance']) {
      const f = kind === 'worldBoss' ? bossFixture() : pirateAdvanceFixture(), l = ledger();
      bridgeFleetReservations(f.client, () => f.settings, l, String(f.player.worldId));
      const reserve = l.reserve;
      l.reserve = (...args) => {
        const ticket = reserve(...args);
        registerFleetReservations(f.client, 'old-owner', selected => selected === id);
        return ticket;
      };
      if (kind === 'worldBoss') await runWorldBoss(f.client, f.config, f.player,
        { getSettings: () => f.settings, ledger: l, enabled: () => true, report: () => {} });
      else if (kind === 'pirateSingle') await assert.rejects(() => modernPirate(f, l), /原自动任务/);
      else assert.match((await modernPirate(f, l, true)).reason, /原自动任务/);
      assert.equal(f.client.writes.length, 0, kind);
      assert.equal(l.snapshot().uncertain, 0, kind);
      assert.deepEqual(l.keyRecords(), {}, kind);
    }
  });
  await test('底层首杀在异步发送前回调结束后再次检查旧 owner', async () => {
    const f = pirateAdvanceFixture(), snap = await inspectHunt(f.client, f.config, f.player);
    await assert.rejects(() => startPirateHunt(f.client, f.config, f.player, {
      targetKey: snap.view.targets[0].targetKey, fleetKey: snap.view.fleets[0].key,
      async beforeSend() { await Promise.resolve(); registerFleetReservations(f.client, 'old-owner', selected => selected === id); }
    }), error => /原自动任务/.test(error.message) && error.notSent === true);
    assert.equal(f.client.writes.length, 0);
  });
  console.log('两代舰队预留迁移专项 ' + passed + '/' + passed + ' 通过');
} finally {
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('cw-fleet-migration-'))
    throw new Error('临时测试目录边界校验失败，未清理');
  fs.rmSync(resolved, { recursive: true, force: true });
}
