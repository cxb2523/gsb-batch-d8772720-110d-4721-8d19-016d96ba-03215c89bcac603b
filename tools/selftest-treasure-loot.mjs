import os from 'node:os';
// 巨轮专项：虚构游戏响应与隔离本地接口，不读取真实凭据、不连接或操作游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, validateSettings, createUsageLedger, saveAutomationSettings, loadAutomationSettings, exportAutomationSettings, importAutomationSettings, nativeTaskValues } from '../src/automation-settings.mjs';
import { exactAutomationId } from '../src/automation-policy.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { readTreasureLoot, planTreasureLoot, runTreasureLoot, treasureDispatchKey } from '../src/treasure-loot.mjs';
import { runLoop } from '../src/loop.mjs';
import { treasureFixture, treasureSettings } from './fixtures/treasure-loot.mjs';

const parent = path.join(os.tmpdir(),'cw-treasure-test-runs');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-'));
const results = [];
let number = 0;
const ledger = (options = {}) => createUsageLedger('测试账号', { file: path.join(directory, 'ledger-' + (++number) + '.json'), ...options });
const check = async (name, fn) => {
  try { await fn(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
};
async function preview(fixture, settings, options) {
  return planTreasureLoot(await readTreasureLoot(fixture.client, fixture.protocol, fixture.config, fixture.player, { preferences: settings.treasure }), fixture.config, settings, options);
}
async function run(fixture, settings, usage = ledger(), options = {}) {
  return runTreasureLoot(fixture.client, fixture.protocol, fixture.config, fixture.player, { getSettings: () => settings, ledger: usage, ...options });
}

try {
  await check('默认关闭、旧设置与旧版本1导入兼容、严格名单校验', () => {
    assert.equal(defaultSettings().treasure.enabled, false);
    const original = defaultSettings(); delete original.treasure;
    const file = path.join(directory, 'old.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { a: { revision: 7, settings: original } } }));
    const bytes = fs.readFileSync(file);
    assert.equal(loadAutomationSettings('a', { file }).settings.treasure.enabled, false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const imported = importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: original });
    assert.equal(imported.treasure.enabled, false); assert.deepEqual(imported.building, original.building);
    const bad = treasureSettings(); bad.treasure.fleetIds = []; assert.throws(() => validateSettings(bad), /舰队/);
    bad.treasure.fleetIds = ['1远征船']; bad.treasure.follow = true; assert.throws(() => validateSettings(bad), /昵称或角色ID/);
    bad.treasure.followNames = ['甲', '甲']; assert.throws(() => validateSettings(bad), /重复/);
    bad.treasure.followNames = ['甲']; bad.treasure.followPlayerIds = ['9e15']; assert.throws(() => validateSettings(bad), /完整的正整数/);
    bad.treasure.followPlayerIds = ['9007199254740995']; assert.equal(validateSettings(bad).treasure.followPlayerIds[0], '9007199254740995');
    bad.treasure.checkEverySeconds = 0; assert.throws(() => validateSettings(bad), /5–300/);
  });

  await check('真实客户端协议可精确编解码巨轮排名ID与派遣字段', () => {
    const protocol = loadProtocol();
    const id = '9007199254740995';
    const encoded = protocol.TreasureLootRankResponse.encode({ items: [{ playerId: id, nickname: '同行者甲', power: 100, progress: 1, estProgress: 1, rank: 1, guildIdx: 7, avatar: {}, rewardTimes: 0 }] }).finish();
    assert.equal(exactAutomationId(protocol.TreasureLootRankResponse.decode(encoded).items[0].playerId), id);
    const dispatch = protocol.TreasureLootSendFleetsRequest.decode(protocol.TreasureLootSendFleetsRequest.encode({ uid: 71, fleetBuildingIds: ['1远征船'] }).finish());
    assert.equal(dispatch.uid, 71); assert.deepEqual(dispatch.fleetBuildingIds, ['1远征船']);
  });

  await check('实际协议解码的全部只读响应贯穿读取、规划与派遣确认', async () => {
    const f = treasureFixture(), protocol = loadProtocol(), s = treasureSettings(), original = f.client.request;
    f.protocol = protocol;
    f.player = protocol.LoginResponse.decode(protocol.LoginResponse.encode({ result: 0, initSeqNo: 1, playerInfo: f.player }).finish()).playerInfo;
    assert.equal(typeof f.player.worldId, 'object', '登录返回的区服编号是Long，必须覆盖此入口');
    Object.assign(s.treasure, { follow: true, followPlayerIds: ['9007199254740995'], petrolReserve: 1000 });
    f.client.request = async (name, body) => {
      const reply = await original(name, body);
      if (name === 'TreasureLootRankRequest') reply.items = reply.items.map(row => ({ power: 100, progress: 1, estProgress: 1, rank: 1, avatar: {}, rewardTimes: 0, ...row }));
      if (name === 'TreasureLootListRequest') for (const target of reply.treasure) target.reward.asset = target.reward.asset.map(row => ({ type: 1, ...row }));
      const type = protocol[name.replace(/Request$/, 'Response')];
      return type.decode(type.encode(reply).finish());
    };
    const rawBag = await f.client.request('AllItemRequest'); assert.equal(typeof rawBag.items[0].num, 'object');
    const rawTargets = await f.client.request('TreasureLootListRequest'); assert.equal(typeof rawTargets.treasure[0].reward.asset[0].num, 'object');
    const snapshot = await readTreasureLoot(f.client, protocol, f.config, f.player);
    assert.equal(snapshot.reason, ''); assert.equal(snapshot.fuel, 3000); assert.ok(snapshot.targets.every(target => !target.reason));
    assert.equal(snapshot.targets[0].reward[0].num, 1);
    const plan = planTreasureLoot(snapshot, f.config, s); assert.equal(plan.actions.length, 2); assert.equal(plan.actions[0].followPlayerId, '9007199254740995');
    const result = await run(f, s); assert.equal(f.client.writes.length, 2); assert.ok(result.results.every(row => row.status === 'confirmed'));
  });

  await check('登录区服编号的数字、文本和Long得到同一开放条件及派遣键', async () => {
    const protocol = loadProtocol();
    for (const value of [1001001, '1001001', protocol.PlayerInfo.decode(protocol.PlayerInfo.encode({ worldId: 1001001 }).finish()).worldId]) {
      const f = treasureFixture(); f.player.worldId = value;
      const snapshot = await readTreasureLoot(f.client, f.protocol, f.config, f.player);
      assert.equal(snapshot.reason, ''); assert.equal(snapshot.worldId, 1001001);
      assert.equal((await preview(f, treasureSettings())).actions[0].uniqueKey, 'treasure:1001001:72:1');
      const result = await run(f, treasureSettings());
      assert.equal(f.client.writes.length, 2); assert(result.results.every(row => row.status === 'confirmed'));
    }
  });

  await check('真实登录Long贯穿未知派遣后续确认与防重', async () => {
    const f = treasureFixture(), protocol = loadProtocol(), usage = ledger(), settings = treasureSettings();
    f.player = protocol.LoginResponse.decode(protocol.LoginResponse.encode({ playerInfo: f.player }).finish()).playerInfo;
    settings.treasure.fleetIds = ['1远征船'];
    f.client.onSend = async () => {};
    await run(f, settings, usage);
    assert.equal(usage.snapshot().uncertain, 1);
    f.state.fleets[0].treasureLootUid = 72; f.state.fleets[0].state = 2;
    await run(f, settings, usage);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(f.client.writes.length, 1);
  });

  await check('区服异常、缺少开服时间和未到开放日仍拦截并给出具体原因', async () => {
    const cases = [
      [f => { f.player.worldId = '9007199254740993'; }, /无法精确确认.*区服编号/],
      [f => { f.player.worldId = 1001; }, /识别巨轮赛季/],
      [f => { f.config.tables.GameplayOpenCfg.data[0].openDays = []; }, /开放天数/],
      [f => { delete f.player.worldOpenTime; }, /缺少有效.*开服时间/],
      [f => { f.player.worldOpenTime = Math.floor(Date.now() / 1000) + 3600; }, /晚于/],
      [f => { f.player.worldOpenTime = Math.floor(Date.now() / 1000); }, /第 3 天开放/],
    ];
    for (const [change, reason] of cases) {
      const f = treasureFixture(); change(f);
      assert.match((await readTreasureLoot(f.client, f.protocol, f.config, f.player)).reason, reason);
      await run(f, treasureSettings()); assert.equal(f.client.writes.length, 0);
    }
  });

  await check('越界或负数int64数量拒绝规划，不损失精度后继续执行', async () => {
    for (const amount of ['9007199254740993', '-1']) {
      const f = treasureFixture(), protocol = loadProtocol(), original = f.client.request;
      f.client.request = async (name, body) => name === 'AllItemRequest'
        ? protocol.AllItemResponse.decode(protocol.AllItemResponse.encode({ items: [{ itemId: '汽油', num: amount }] }).finish()) : original(name, body);
      assert.equal((await preview(f, treasureSettings())).actions.length, 0);
      const g = treasureFixture(); g.state.targets[0].reward.asset[0].num = protocol.DisplayAsset.decode(protocol.DisplayAsset.encode({ type: 1, id: '紫芯片宝箱', num: amount }).finish()).num;
      g.state.targets = [g.state.targets[0]];
      assert.equal((await preview(g, treasureSettings())).actions.length, 0);
    }
  });

  await check('自动参加只选万吨，按奖励/进度筛选且空名单不擅选舰队', async () => {
    const f = treasureFixture(), s = treasureSettings();
    f.state.targets.push({ ...structuredClone(f.state.targets[1]), uid: 73, color: 4 });
    let p = await preview(f, s); assert.equal(p.actions.length, 2); assert.ok(p.actions.every(a => a.body.uid === 72)); assert.deepEqual(f.client.writes, []);
    s.treasure.rewardItems = ['紫芯片宝箱']; p = await preview(f, s); assert.ok(p.actions.every(a => a.body.uid === 71));
    s.treasure.maxProgress = 20; assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.fleetIds = []; assert.equal((await preview(f, s)).actions.length, 0);
  });

  await check('跟随当前占领者，精确ID优先且不跟历史排名、同名歧义或自己', async () => {
    const f = treasureFixture(), s = treasureSettings(); Object.assign(s.treasure, { autoJoin: false, follow: true, followPlayerIds: ['9007199254740995'] });
    let p = await preview(f, s); assert.equal(p.actions[0].mode, 'follow'); assert.equal(p.actions[0].body.uid, 71);
    f.state.defenders[71] = []; f.state.targets[0].ownerFleetNum = 0;
    assert.equal((await preview(f, s)).actions.length, 0);
    f.state.defenders[71] = [{ name: '同行者甲', guildIdx: 7 }]; f.state.targets[0].ownerFleetNum = 1;
    f.state.ranks[71].push({ ...f.state.ranks[71][0], playerId: '9007199254740997' });
    assert.equal((await preview(f, s)).actions.length, 0);
    f.state.ranks[71] = [{ playerId: f.player.playerId, nickname: '同行者甲', guildIdx: 7 }];
    s.treasure.followPlayerIds = []; s.treasure.followNames = ['同行者甲'];
    assert.equal((await preview(f, s)).actions.length, 0);
  });

  await check('跟随名单顺序跨货轮生效，名单优先于自动参加且避战更优先', async () => {
    const f = treasureFixture(), s = treasureSettings(); Object.assign(s.treasure, { follow: true, followNames: ['首选同伴', '同行者甲'] });
    f.state.defenders[71].push({ name: '首选同伴', guildIdx: 7 });
    f.state.ranks[71].push({ playerId: '9007199254740997', nickname: '首选同伴', guildIdx: 7 });
    let p = await preview(f, s); assert.equal(p.actions[0].body.uid, 71); assert.equal(p.actions[0].followName, '首选同伴');
    s.treasure.avoidNames = ['首选同伴']; p = await preview(f, s); assert.equal(p.actions.length, 0, '开启跟随时禁止回退到名单外货轮');
    s.treasure.autoJoin = false; assert.equal((await preview(f, s)).actions.length, 0);
  });

  await check('跟随为硬条件，零进度本盟守军可按最新完整ID识别，离开和同名仍阻止', async () => {
    const f=treasureFixture(),s=treasureSettings();Object.assign(s.treasure,{follow:true,autoJoin:true,followPlayerIds:['9007199254740995']});
    const snapshot=await readTreasureLoot(f.client,f.protocol,f.config,f.player);
    snapshot.targets[0].rank=[];snapshot.followMembers=[{id:'9007199254740995',name:'同行者甲'}];
    let p=planTreasureLoot(snapshot,f.config,s);assert.equal(p.actions[0].body.uid,71);assert.equal(p.actions[0].mode,'follow');
    snapshot.followMembers.push({id:'9007199254740996',name:'同行者甲'});assert.equal(planTreasureLoot(snapshot,f.config,s).actions.length,0);
    snapshot.followMembers.pop();snapshot.targets[0].defenders=[];assert.equal(planTreasureLoot(snapshot,f.config,s).actions.length,0);
    s.treasure.follow=false;assert(planTreasureLoot(snapshot,f.config,s).actions.length>0);
  });

  await check('默认避开其他联盟，允许争夺仍不能越过避战名单', async () => {
    const f = treasureFixture(), s = treasureSettings(); f.state.targets = [f.state.targets[0]];
    f.state.targets[0].ownerGuildIdx = 8; f.state.defenders[71][0].guildIdx = 8; f.state.ranks[71][0].guildIdx = 8;
    assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.allowHostile = true; assert.equal((await preview(f, s)).actions.length, 2);
    s.treasure.avoidNames = ['同行者甲']; assert.equal((await preview(f, s)).actions.length, 0);
  });

  await check('等级、开服日、联盟职务、身份变化和合服都阻止派遣', async () => {
    for (const change of [
      f => { f.player.level = 18; }, f => { f.player.worldOpenTime = Math.floor(Date.now() / 1000); },
      f => { f.player.guildId = '0'; }, f => { f.state.guild.myTitle = 1; },
      f => { f.state.guild.guild.guildId = '9007199254741008'; },
      f => { f.state.merge = { worldIds: [2], matchMaking: true, executeTs: Math.floor(Date.now() / 1000) + 100 }; },
    ]) { const f = treasureFixture(); change(f); await run(f, treasureSettings()); assert.equal(f.client.writes.length, 0); }
  });

  await check('忙碌、驻守、无编队和低耐久舰队不被抢占', async () => {
    for (const change of [
      f => { f.state.fleets[0].state = 2; }, f => { f.state.fleets[0].treasureLootUid = 99; },
      f => { f.state.fleets[0].curGridIdx = 10; }, f => { f.state.fleets[0].chipWar = { rewardTs: 100 }; },
      f => { f.state.fleets[0].durability = 79; }, f => { f.state.fleets[0].maxDura = 0; },
      f => { f.state.buildings[0].fleet.formation.heroPositions = []; }, f => { f.state.buildings[0].level = 0; },
    ]) { const f = treasureFixture(), s = treasureSettings(); s.treasure.fleetIds = ['1远征船']; s.treasure.autoRepair = false; change(f); assert.equal((await preview(f, s)).actions.length, 0); }
  });

  await check('实际协议空闲舰队不因自动作战偏好开启而误判忙碌', async () => {
    const f = treasureFixture(), protocol = loadProtocol(), s = treasureSettings(), read = f.client.request;
    f.state.fleets.forEach(fleet => { fleet.autoFight = { isOn: true, todayTimes: 0 }; });
    f.client.request = async (name, body) => {
      const reply = await read(name, body);
      return name === 'MyFleetsRequest' ? protocol.MyFleetsResponse.decode(protocol.MyFleetsResponse.encode(reply).finish()) : reply;
    };
    const plan = await preview(f, s);
    assert.equal(plan.actions.length, 2);
    assert(plan.fleets.every(row => row.state === '空闲' && row.autoFight === true && row.reason === ''));
    const result = await run(f, s);
    assert(result.results.every(row => row.status === 'confirmed'));
    assert(f.state.fleets.every(fleet => fleet.autoFight.isOn));
    assert(f.client.writes.every(row => row.name === 'TreasureLootSendFleetsRequest'), '不关闭或改写原生自动作战开关');
  });

  await check('自动作战开启时仍按实际行军战斗维修排队状态阻止派遣', async () => {
    for (const [state, reason] of [[2, '行军中'], [3, '战斗中'], [4, '维修中'], [5, '排队中'], [0, '无法识别']]) {
      const f = treasureFixture(), s = treasureSettings(); s.treasure.fleetIds = ['1远征船'];
      Object.assign(f.state.fleets[0], { state, autoFight: { isOn: true } });
      const plan = await preview(f, s); assert.equal(plan.actions.length, 0); assert.match(plan.notes.join(';'), new RegExp(reason));
      await run(f, s); assert.equal(f.client.writes.length, 0);
    }
    const f = treasureFixture(), s = treasureSettings(); s.treasure.fleetIds = ['1远征船'];
    f.state.fleets[0].autoFight = { isOn: true };
    f.client.onRequest = name => { if (name === 'WorldInfoRequest') f.state.fleets[0].state = 2; };
    await run(f, s); assert.equal(f.client.writes.length, 0, '出征前变成行军也不能沿用旧空闲状态');
  });

  await check('没有目标时空闲舰队仍显示空闲，不混同目标与舰队阻断', async () => {
    const f = treasureFixture(), s = treasureSettings(); f.state.targets = [];
    f.state.fleets.forEach(fleet => { fleet.autoFight = { isOn: true }; });
    const plan = await preview(f, s);
    assert.equal(plan.actions.length, 0); assert.deepEqual(plan.notes, ['当前没有可读取的万吨货轮，保持等待，不抢小型或中型货轮']);
    assert(plan.fleets.every(fleet => fleet.state === '空闲' && !fleet.reason));
  });

  await check('汽油共同预算、每日次数和游戏领奖上限同时限制计划', async () => {
    const f = treasureFixture(), s = treasureSettings(); f.state.fuel = 1100; s.treasure.petrolReserve = 600;
    assert.equal((await preview(f, s)).actions.length, 1);
    s.treasure.petrolReserve = 0; s.treasure.dailyDispatchLimit = 2;
    assert.equal((await preview(f, s, { usage: { counters: { treasureDispatches: 1 } } })).actions.length, 1);
    f.state.stats.todayRewardTimes = 3; assert.equal((await preview(f, s)).actions.length, 0);
  });

  await check('完整挂机链路可独立运行巨轮，出征后以舰队目标确认', async () => {
    const f = treasureFixture(), s = treasureSettings(), usage = ledger();
    const flags = nativeTaskValues(s, {});
    const outcome = await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
      getSettings: () => s, usageLedger: usage, isEnabled: key => flags[key] === true });
    assert.equal(f.client.writes.length, 2); assert.ok(outcome.history[0].world.results.every(row => row.status === 'confirmed'));
    assert.equal(usage.snapshot().counters.treasureDispatches, 2); assert.equal(usage.snapshot().uncertain, 0);
    assert.ok(f.client.reads.some(row => row.name === 'WorldInfoRequest'));
  });

  await check('目标消失、跟随对象离开或联盟变化发生在复核期间则不发送', async () => {
    for (const kind of ['gone', 'left', 'guild']) {
      const f = treasureFixture(), s = treasureSettings(); s.treasure.fleetIds = ['1远征船']; Object.assign(s.treasure, { autoJoin: false, follow: true, followNames: ['同行者甲'] });
      f.client.onRequest = name => { if (name === 'WorldInfoRequest') { if (kind === 'gone') f.state.targets = []; if (kind === 'left') { f.state.defenders[71] = []; f.state.targets[0].ownerFleetNum = 0; } if (kind === 'guild') f.player.guildId = '9007199254741008'; } };
      await run(f, s); assert.equal(f.client.writes.length, 0, kind);
    }
  });

  await check('轮间按巨轮间隔检查，暂停后不再继续派遣', async () => {
    const originalNow = Date.now; let clock = originalNow(); const started = clock;
    Date.now = () => clock;
    try {
      const f = treasureFixture(), s = treasureSettings(), usage = ledger(), stop = { aborted: false };
      s.treasure.fleetIds = ['1远征船']; f.state.targets = [f.state.targets[0]];
      const flags = nativeTaskValues(s, {}), sentAt = []; let refreshed = false;
      f.client.onSend = (_, body) => { sentAt.push(clock - started); f.state.fleets[0].treasureLootUid = body.uid; f.state.fleets[0].state = 2; f.state.fuel -= 500; if (sentAt.length === 2) stop.aborted = true; return {}; };
      await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 2, everyMs: 60000, allowMutate: true,
        stop, getSettings: () => s, usageLedger: usage, isEnabled: key => flags[key] === true,
        sleep: async ms => { clock += ms; if (!refreshed) { refreshed = true; f.state.fleets[0].state = 1; f.state.fleets[0].treasureLootUid = 0;
          f.state.targets[0] = { ...f.state.targets[0], uid: 73 }; f.state.defenders[73] = f.state.defenders[71]; f.state.ranks[73] = f.state.ranks[71]; } },
      });
      assert.deepEqual(sentAt, [0, 15000]); assert.equal(stop.aborted, true); assert.equal(f.client.writes.length, 2);
    } finally { Date.now = originalNow; }
  });

  await check('派遣前关闭、暂停及预约后的取消均不发送也不占次数', async () => {
    for (const kind of ['disabled', 'paused', 'reserved']) {
      const f = treasureFixture(), s = treasureSettings(), usage = ledger(); let enabled = true;
      f.client.onRequest = name => { if (name === 'WorldInfoRequest') { if (kind === 'disabled') s.treasure.enabled = false; if (kind === 'paused') enabled = false; } };
      if (kind === 'reserved') { const original = usage.reserve; usage.reserve = (...args) => { const ticket = original(...args); enabled = false; return ticket; }; }
      await run(f, s, usage, { enabled: () => enabled }); assert.equal(f.client.writes.length, 0);
      assert.equal(usage.snapshot().counters.treasureDispatches ?? 0, 0); assert.equal(usage.snapshot().uncertain, 0);
    }
  });

  await check('关闭反复攻占时相同舰队与货轮跨轮、重启与换日不重复派遣', async () => {
    const f = treasureFixture(), s = treasureSettings(); s.treasure.fleetIds = ['1远征船']; s.treasure.repeatAttack = false; f.state.targets = [f.state.targets[0]];
    const file = path.join(directory, 'restart-ledger.json'); let now = Date.parse('2026-11-03T15:59:00Z');
    let usage = ledger({ file, now: () => now }); await run(f, s, usage); assert.equal(f.client.writes.length, 1);
    f.state.fleets[0].state = 1; f.state.fleets[0].treasureLootUid = 0;
    usage = createUsageLedger('测试账号', { file, now: () => now }); await run(f, s, usage); assert.equal(f.client.writes.length, 1);
    now += 120000; assert.equal(usage.snapshot().counters.treasureDispatches, undefined); await run(f, s, usage); assert.equal(f.client.writes.length, 1);
  });

  await check('发送结果未知保留次数/汽油和舰队防重，后续读取可确认', async () => {
    const f = treasureFixture(), s = treasureSettings(), usage = ledger(); s.treasure.fleetIds = ['1远征船'];
    f.client.onSend = () => { throw new Error('回执连接中断'); };
    let result = await run(f, s, usage); assert.equal(result.results[0].status, 'unknown');
    assert.equal(usage.snapshot().counters.treasureDispatches, 1); assert.equal(usage.pendingCounters().treasurePetrol, 500);
    await run(f, s, usage); assert.equal(f.client.writes.length, 1);
    f.state.fleets[0].treasureLootUid = 72; f.state.fleets[0].state = 2;
    await run(f, s, usage); assert.equal(usage.snapshot().uncertain, 0); assert.equal(usage.pendingCounters().treasurePetrol, undefined);
  });

  await check('没有确认回包不假报成功，明确服务器拒绝才释放预约', async () => {
    const f = treasureFixture(), s = treasureSettings(), usage = ledger(); s.treasure.fleetIds = ['1远征船'];
    f.client.onSend = () => ({}); let result = await run(f, s, usage);
    assert.equal(result.results[0].status, 'unknown'); assert.equal(result.results[0].sent, true); assert.equal(usage.snapshot().uncertain, 1);
    const g = treasureFixture(), second = ledger(); g.client.onSend = () => { const error = new Error('无权限'); error.prompt = {}; error.request = 'TreasureLootSendFleetsRequest'; throw error; };
    result = await run(g, s, second); assert.equal(result.results[0].status, 'rejected'); assert.equal(second.snapshot().uncertain, 0);
    assert.equal(second.snapshot().counters.treasureDispatches, 0); assert.deepEqual(second.keyRecords(), {});
  });

  await check('换日中的确认与明确拒绝不会留下错误防重状态', () => {
    let now = Date.parse('2026-11-03T15:59:59Z'); const usage = ledger({ now: () => now });
    const first = usage.reserve({ treasureDispatches: 1 }, {}, {}, { uniqueKey: 'treasure:1001001:71:1' });
    const second = usage.reserve({ treasureDispatches: 1 }, {}, {}, { uniqueKey: 'treasure:1001001:71:2' });
    now += 2000; usage.confirm(first); usage.cancel(second);
    assert.equal(usage.keyRecords()['treasure:1001001:71:1'].confirmed, true); assert.equal(usage.hasKey('treasure:1001001:71:2'), false);
    assert.deepEqual(usage.snapshot().counters, {});
  });

  await check('未知派遣预算跨午夜与重启保留，旧回执不改当天次数', async () => {
    let now = Date.parse('2026-11-03T15:59:59Z');
    const file = path.join(directory, 'unknown-midnight.json');
    let usage = createUsageLedger('测试账号', { file, now: () => now });
    const ticket = usage.reserve({ treasureDispatches: 1, treasurePetrol: 500 }, {}, {}, { uniqueKey: 'treasure:1001001:71:1' });
    const f = treasureFixture(), s = treasureSettings(); f.state.fuel = 1000; s.treasure.petrolReserve = 500;
    const checkPlan = () => preview(f, s, { usage: usage.snapshot(), keys: usage.keyRecords(), pendingFuel: usage.pendingCounters().treasurePetrol ?? 0 });
    assert.equal((await checkPlan()).actions.length, 0);
    now += 2000; usage = createUsageLedger('测试账号', { file, now: () => now });
    assert.deepEqual(usage.snapshot().counters, {}); assert.equal(usage.snapshot().uncertain, 1); assert.equal(usage.pendingCounters().treasurePetrol, 500);
    assert.equal((await checkPlan()).actions.length, 0);
    const today = usage.reserve({ treasureDispatches: 1, treasurePetrol: 500 }, {}, {}, { uniqueKey: 'treasure:1001001:72:2' });
    usage.confirm(ticket);
    assert.equal(usage.snapshot().counters.treasureDispatches, 1); assert.equal(usage.pendingCounters().treasurePetrol, 500); assert.equal(usage.snapshot().uncertain, 1);
    usage.cancel(today); assert.equal(usage.snapshot().counters.treasureDispatches, 0); assert.equal(usage.snapshot().uncertain, 0);
    const later = usage.reserve({ treasureDispatches: 1, treasurePetrol: 500 }, {}, {}, { uniqueKey: 'treasure:1001001:73:1' });
    now += 86400000;
    const current = usage.reserve({ treasureDispatches: 1 }, {}, {}, { uniqueKey: 'treasure:1001001:74:2' });
    usage.cancel(later); assert.equal(usage.snapshot().counters.treasureDispatches, 1); assert.equal(usage.hasKey('treasure:1001001:73:1'), false);
    usage.confirm(current); assert.equal(usage.snapshot().uncertain, 0);
  });

  await check('跨日未知派遣由后续舰队状态确认时释放预算且不增加当天计数', async () => {
    let now = Date.parse('2026-11-03T15:59:59Z'); const usage = ledger({ now: () => now });
    const f = treasureFixture(), s = treasureSettings(); s.treasure.fleetIds = ['1远征船'];
    usage.reserve({ treasureDispatches: 1, treasurePetrol: 500 }, {}, {}, { uniqueKey: treasureDispatchKey(f.player.worldId, 71, '1远征船') });
    now += 2000; f.state.fleets[0].treasureLootUid = 71; f.state.fleets[0].state = 2;
    await run(f, s, usage);
    assert.deepEqual(usage.snapshot().counters, {}); assert.equal(usage.snapshot().uncertain, 0); assert.equal(usage.pendingCounters().treasurePetrol, undefined);
    assert.equal(f.client.writes.length, 0);
  });

  await check('并发检查只发送一轮，关闭总开关完全不请求游戏', async () => {
    const f = treasureFixture(), s = treasureSettings(), usage = ledger();
    await Promise.all([run(f, s, usage), run(f, s, usage)]); assert.equal(f.client.writes.length, 2);
    const g = treasureFixture(); s.treasure.enabled = false; await run(g, s); assert.deepEqual(g.client.reads, []); assert.deepEqual(g.client.writes, []);
  });

  await check('真实库存暂未回写时，同轮预算仍保留已派出舰队的费用', async () => {
    const f = treasureFixture(); let s = treasureSettings(); f.state.fuel = 1000;
    f.client.onSend = (_, body) => {
      f.state.fleets.find(row => row.buildingId === body.fleetBuildingIds[0]).treasureLootUid = body.uid;
      s = structuredClone(s); s.treasure.petrolReserve = 400;
      return {};
    };
    await run(f, s, ledger(), { getSettings: () => s }); assert.equal(f.client.writes.length, 1);
  });

  await check('世界配置预览与保存不出征，按账号隔离并兼容原接口', async () => {
    process.env.CW_DATA_DIR = directory;
    const { saveStore, DATA_DIR } = await import('../src/accounts.mjs'); assert.equal(DATA_DIR, directory);
    saveStore({ activeId: '巨轮甲', accounts: ['巨轮甲', '巨轮乙'].map(id => ({ id, label: id, url: 'ws://127.0.0.1:1', login: {}, automation: { enabled: false, paused: true } })) });
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 }); await app.listen();
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const api = async (account, route, body) => { const res = await fetch(origin + route + '?account=' + encodeURIComponent(account), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: res.status, body: await res.json() }; };
    try {
      const original = fs.readFileSync(path.join(directory, 'accounts.json'));
      const initial = (await api('巨轮甲', '/api/settings')).body;
      const s = initial.settings; Object.assign(s.treasure, { enabled: true, follow: true, followNames: ['同行者甲'], fleetIds: ['1远征船'], minDurabilityPercent: 80 });
      const saved = await api('巨轮甲', '/api/settings', { settings: s, revision: initial.revision, baseRevision: initial.baseRevision }); assert.equal(saved.status, 200);
      assert.equal((await api('巨轮乙', '/api/settings')).body.settings.treasure.enabled, false);
      const f = treasureFixture(), session = app.sessions.get('巨轮甲'); session.client = f.client; session.player = f.player; session.paused = false;
      const response = await api('巨轮甲', '/api/settings/preview', { settings: s, category: 'world' });
      assert.equal(response.status, 200); assert.equal(response.body.scopeLabel, '万吨巨轮'); assert.equal(response.body.actions[0].kind, 'treasureDispatch');
      assert.deepEqual(f.client.writes, []); assert.equal(session.loop.running, false);
      assert.deepEqual(fs.readFileSync(path.join(directory, 'accounts.json')), original);
      assert.deepEqual(Object.keys(exportAutomationSettings(s)), ['format', 'version', 'settings']);
      session.paused = true;
      assert.equal((await api('巨轮甲', '/api/settings/preview', { settings: s, category: 'world' })).status, 400);
    } finally { await app.close(); }
  });
} finally {
  const report = { at: new Date().toISOString(), kind: '巨轮受控数据与隔离接口验证，未操作真实游戏', total: results.length, passed: results.filter(row => row.passed).length, results };
  const file = path.join(parent, 'result-' + Date.now() + '.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(parent) || !path.basename(resolved).startsWith('run-')) throw new Error('临时测试目录边界校验失败，未清理');
  fs.rmSync(resolved, { recursive: true });
  console.log(`巨轮专项：${report.passed}/${report.total} 组通过`); console.log(file);
  if (report.passed !== report.total) process.exitCode = 1;
}
