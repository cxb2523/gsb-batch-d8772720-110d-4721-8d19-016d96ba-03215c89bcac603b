import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { automationTasks, defaultFishingGoldReserve } from '../src/automation.mjs';
import { surveyDailies, runDailies } from '../src/dailies.mjs';
import { runWorld } from '../src/world.mjs';
import { runLoop } from '../src/loop.mjs';
import { testFishing } from './selftest-fishing.mjs';
import { testFishingUpgrade } from './selftest-fishing-upgrade.mjs';
import { testAntiqueRecruit } from './selftest-antique-recruit.mjs';
import { testActivitySchedule } from './selftest-activity-schedule.mjs';
import { testResidentOrders } from './selftest-resident-orders.mjs';
import { testResidentHttp } from './selftest-resident-http.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';

// Never use the player's account store or open a game connection.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-auto-test-'));
process.env.CW_DATA_DIR = dir;
process.env.CW_CONFIG_PACK = path.join(dir, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [1, 'ItemCfg', { data: [{ id: '烤鱼', show_name: '烤鱼' }] }],
  [2, 'ResourceCfg', { data: [{ id: 'GOLD', show_name: '金币' }] }],
  [3, 'WorkerBaseCfg', { data: [{ id: 1, showName: '居民甲' }, { id: 2, showName: '居民乙' }] }],
]));
const { saveStore, DATA_DIR } = await import('../src/accounts.mjs');
assert.equal(DATA_DIR, dir);
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let logins = 0;
let finishedLogins = 0;
const live = new Set();
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function () { logins++; this.stopping = false; live.add(this); return { playerInfo: {} }; };
GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); };
GameClient.prototype.send = function (name) {
  assert.equal(name, 'LoginFinishRequest');
  finishedLogins++;
  this.emit('message', { name: 'SCAllActivity', body: { festivalActivities: [
    { type: '捞尸人联动活动', subActivity: [{ subActivityType: 30 }] },
  ] } });
};
GameClient.prototype.request = async name => {
  assert.equal(name, 'EmailBoxRequest');
  return {};
};
const tasks = Object.fromEntries(automationTasks.map(t => [t.key, t.key === 'mail']));
saveStore({ activeId: 'a', accounts: ['a', 'b'].map(id => ({
  id, url: 'ws://invalid.invalid', login: {}, automation: { tasks, enabled: id === 'a' },
})) });
let app;
async function open() {
  app = createConsole({ port: 0 });
  await app.listen();
}
async function api(id, route, payload) {
  const url = 'http://127.0.0.1:' + app.server.address().port + '/api/loop' + route + '?account=' + id;
  const res = await fetch(url, payload && { method: 'POST', body: JSON.stringify({ confirm: true, ...payload }) });
  assert.equal(res.status, 200);
  return res.json();
}
try {
  await open();
  assert.equal((await api('a', '')).running, true);
  assert.equal(finishedLogins, logins);
  assert.equal(app.sessions.get('a').client.festivals[0].type, '捞尸人联动活动');
  const request = (route, payload) => fetch('http://127.0.0.1:' + app.server.address().port + '/api/' + route + '?account=a',
    payload && { method: 'POST', body: JSON.stringify(payload) });
  const player = app.sessions.get('a').player;
  app.sessions.get('a').client.emit('message', { name: 'SCPlayerExpUpdate', body: { level: 7, exp: 100 } });
  assert.equal(player.level, 7);
  assert.equal((await api('a', '')).fishingGoldReserve, defaultFishingGoldReserve);
  assert.equal((await api('a', '')).tasks.find(t => t.key === 'fishEnhance').enabled, false);
  await api('a', '/fishing-reserve', { fishingGoldReserve: 12500 });
  assert.equal((await request('loop/fishing-reserve', { fishingGoldReserve: -1 })).status, 400);
  assert.equal((await api('b', '')).fishingGoldReserve, defaultFishingGoldReserve);
  assert.equal((await (await request('accounts/pause', { paused: true })).json()).paused, true);
  const before = logins;
  await app.close();
  await open();
  assert.equal((await api('a', '')).running, false);
  assert.equal((await api('a', '')).fishingGoldReserve, 12500);
  for (const [route, payload] of [['overview'], ['connect', {}], ['worlds/enter', { confirm: true, worldId: 1 }], ['loop/start', { confirm: true }]]) {
    assert.match((await (await request(route, payload)).json()).error, /账号已暂停/);
  }
  assert.equal(logins, before);
  assert.equal((await (await request('accounts/pause', { paused: false })).json()).paused, false);
  assert.equal((await api('a', '')).running, true);
  assert.equal(logins, before + 1);
  assert.equal((await api('b', '')).running, false);
  await api('a', '/task', { key: 'mail', enabled: false });
  await app.sessions.get('a').loop.job;
  assert.equal((await api('b', '')).tasks.find(t => t.key === 'mail').enabled, true);
  await app.close();
  await open();
  const paused = await api('a', '');
  assert.equal(paused.running, false);
  assert.equal(paused.tasks.some(t => t.enabled), false);
  await api('a', '/task', { key: 'mail', enabled: true });
  await api('a', '/start', { everySeconds: 120 });
  await app.close();
  await open();
  assert.equal((await api('a', '')).everyMs, 120000);
  assert.equal((await api('a', '')).running, true);
  await api('a', '/stop', {});
  await app.sessions.get('a').loop.job;
  assert.equal((await api('a', '')).running, false);

  let build = true;
  const sent = [];
  const plan = { actions: ['build', 'build', 'gainFactory'].map((kind, index) =>
    ({ kind, request: kind, body: { index } })) };
  await runWorld({ async sendWatch(name) { sent.push(name); build = false; } },
    { build: true, gainFactory: true }, plan, { allowMutate: true, enabled: kind => kind !== 'build' || build });
  assert.deepEqual(sent, ['build', 'gainFactory']);

  // Free recruitment must use the current account's building state on each round.
  function recruitClient() {
    return {
      buildings: [], ways: [],
      async request(name, body) {
        switch (name) {
          case 'DailyTaskInfoRequest': return { dailyTask: [{ id: 1002, progress: 0, targetProgress: 1 }] };
          case 'AllItemRequest': return { items: [] };
          case 'AllResourceRequest': return { list: [] };
          case 'RecruitInfoRequest': return { hero: { freeEndTimeSeconds: 0 } };
          case 'OnWaterRequest':
            if (!this.buildings) throw new Error('暂时无法读取建筑');
            return { building: this.buildings };
          case 'RecruitStartRequest': this.ways.push(body.way); return {};
          default: throw new Error('意外请求：' + name);
        }
      },
    };
  }
  const recruitProtocol = { OnWaterRequest: true, OnWaterResponse: true, RecruitStartRequest: true, RecruitStartResponse: true };
  async function recruitRound(client, buildings, expected, waitReason) {
    client.buildings = buildings;
    const before = client.ways.length;
    const survey = await surveyDailies(client, recruitProtocol, { probeGift: false });
    if (waitReason) {
      assert.equal(survey.tasks[0].status, 'waiting');
      assert.match(survey.tasks[0].reason, waitReason);
    }
    await runDailies(client, recruitProtocol, survey, { allowMutate: true, claimRewards: false });
    assert.deepEqual(client.ways.slice(before), expected);
  }
  const unbuilt = [{ buildingId: '1广播站', level: 0 }];
  const constructing = [{ buildingId: '1广播站', level: 0, buildFinishTime: Date.now() / 1000 + 60 }];
  const built = [{ buildingId: '1广播站', level: 1 }];
  const accountA = recruitClient(), accountB = recruitClient();
  await recruitRound(accountA, [], [], /未建/);
  await recruitRound(accountA, unbuilt, [], /未建/);
  await recruitRound(accountB, built, [1]);
  await recruitRound(accountA, constructing, [], /建造|竣工/);
  await recruitRound(accountA, null, [], /读取/);
  await recruitRound(accountA, built, [1]);
  await recruitRound(accountB, null, [], /读取/);
  // Two reward periods expire between ordinary rounds. The server clock is 2 s ahead.
  const realNow = Date.now;
  let now = 100_000, finish = 105;
  const draws = [];
  try {
    Date.now = () => now;
    const client = { serverClockOffsetMs: 2000, async request(name) {
      if (name === 'AfkInfoRequest') return { afkInfo: { afkFinishTime: finish } };
      assert.equal(name, 'DrawAfkRewardRequest');
      draws.push(now);
      finish += 4;
      return { afkFinishTime: finish };
    } };
    await runLoop(client, { DrawAfkRewardRequest: true, DrawAfkRewardResponse: true }, {
      allowMutate: true, rounds: 2, everyMs: 10_000, isEnabled: key => key === 'afk',
      sleep: async ms => { now += ms; },
    });
    assert.deepEqual(draws, [103_000, 107_000]);

    now = 100_000;
    const work = [];
    let collected = false, restocked = false;
    const factoryClient = { connected: true, serverClockOffsetMs: 2000, async request(name) {
      if (name === 'GainFactoryProduceRequest') { collected = true; work.push(['收成品', now]); return {}; }
      assert.equal(name, 'OnWaterRequest');
      const done = now >= 103_000;
      const factoryQ = restocked ? [{ productId: '布匹', finishTime: 200 }] : done ? [] : [{ productId: '布匹', finishTime: 105 }];
      return { building: [{ buildingId: '1材料厂', level: 1, factory: { factoryQ,
        finishedProducts: done && !collected ? [{ id: '布匹', num: 1 }] : [] } }] };
    }, async sendWatch(name) {
      assert.equal(name, 'StartFactoryProduceRequest');
      assert.equal(collected, true);
      restocked = true;
      work.push(['补产', now]);
    } };
    const config = { tables: {
      BuildingCfg: { data: [{ buildingType: '材料厂' }] },
      GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
      BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 1 }] },
      BuildingProduceCfg: { data: [{ buildType: '材料厂', unlockLevel: 1, itemId: '布匹', produceTime: 60 }] },
    } };
    await runLoop(factoryClient, { OnWaterRequest: true, OnWaterResponse: true, GainFactoryProduceRequest: true,
      GainFactoryProduceResponse: true, StartFactoryProduceRequest: true }, { config, allowMutate: true, rounds: 2,
      everyMs: 10_000, isEnabled: k => ['collect', 'startProduce'].includes(k), sleep: async ms => { now += ms; } });
    assert.deepEqual(work, [['收成品', 103_250], ['补产', 103_250]]);
  } finally { Date.now = realNow; }
  // Progression gates are checked on every round. An unchanged wait is logged
  // once; reaching the required level changes the reason without a new login.
  {
    const player = { level: 6 };
    const notices = [];
    const config = { tables: { ModuleOpenCfg: { data: [
      { moduleId: '小玩法升级', playerLevel: 7 }, { moduleId: '藏品', playerLevel: 10 },
    ] } } };
    const client = { connected: true, async request(name) {
      assert.equal(name, 'OnWaterRequest', '没有广播站或钓鱼椅时应只读海面信息');
      return { building: [] };
    } };
    await runLoop(client, {}, { player, config, allowMutate: true, rounds: 3, everyMs: 1,
      isEnabled: key => ['fishEnhance', 'freeAntiqueRecruit', 'antiqueRecruitRewards'].includes(key),
      sleep: async () => {}, onStep: entry => notices.push(entry),
      onRound: ({ round }) => { if (round === 2) player.level = 10; },
    });
    assert.equal(notices.filter(n => n.round === 1 && n.skipped).length, 3);
    assert.equal(notices.filter(n => n.round === 2).length, 0);
    assert.deepEqual(notices.filter(n => n.round === 3).map(n => n.reason).sort(),
      ['广播站尚未建成', '广播站尚未建成', '尚未建成钓鱼椅'].sort());
  }
  await testFishing();
  await testFishingUpgrade();
  await testAntiqueRecruit();
  await testActivitySchedule();
  await testResidentOrders();
  await import('./selftest-fleet-settlement.mjs');
  await testResidentHttp(app);
  {
    const client = new EventEmitter();
    const reads = [];
    const rewards = rewardSchedule(client), reset = rewards.nextDay();
    client.request = async name => {
      reads.push(name);
      if (name === 'EmailBoxRequest') return { email: [] };
      assert.equal(name, 'DailyGiftPackRequest');
      return { resetTime: reset, drawnPack: ['赠礼'] };
    };
    const run = () => runLoop(client, { DailyGiftPackRequest: true, DailyGiftPackResponse: true }, {
      allowMutate: true, rounds: 1, isEnabled: key => ['mail', 'gift'].includes(key),
    });
    await run();
    await run();
    assert.deepEqual(reads, ['DailyGiftPackRequest', 'EmailBoxRequest']);
    assert.equal(rewards.nextCheck('gift'), reset);
    assert(rewardSchedule(new EventEmitter()).due('gift'), '其他账号不共享已领状态');
    client.emit('message', { name: 'SCNewEmail', body: {} });
    await run();
    assert.deepEqual(reads.slice(2), ['EmailBoxRequest'], '新邮件只唤醒邮箱');
    client.emit('message', { name: 'SCDailyTaskReset', body: {} });
    assert(rewards.due('gift'), '游戏跨日推送可以提前唤醒');
  }
  console.log('automation ok: 账号隔离、重启恢复、暂停持久化、轮内跳过、钓鱼、钓具养成、藏品招募、居民订单手动交付');
} finally {
  if (app?.server.listening) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
