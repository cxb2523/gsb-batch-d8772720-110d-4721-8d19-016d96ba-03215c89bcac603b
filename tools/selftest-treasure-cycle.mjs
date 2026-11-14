import os from 'node:os';
// 巨轮新批注专项：真实协议编解码的虚构业务数据，禁止真实连接和消费。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, validateSettings, createUsageLedger, loadAutomationSettings, exportAutomationSettings, importAutomationSettings } from '../src/automation-settings.mjs';
import { readTreasureLoot, planTreasureLoot, runTreasureLoot, treasureDispatchKey, treasureRepairKey } from '../src/treasure-loot.mjs';
import { readCityWar, planCityWar } from '../src/city-war.mjs';
import { readGuildMembers } from '../src/guild.mjs';
import { runLoop } from '../src/loop.mjs';
import { treasureCycleFixture, treasureCycleSettings } from './fixtures/treasure-cycle.mjs';

const parent = path.join(os.tmpdir(),'cw-treasure-cycle-test-runs');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-')), results = [];
let sequence = 0;
const ledger = (options = {}) => createUsageLedger('虚构巨轮账号', { file: path.join(directory, 'ledger-' + (++sequence) + '.json'), ...options });
const read = (f, s) => readTreasureLoot(f.client, f.protocol, f.config, f.player, { preferences: s.treasure });
const preview = async (f, s, options) => planTreasureLoot(await read(f, s), f.config, s, options);
const run = (f, s, usage = ledger(), options = {}) => runTreasureLoot(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger: usage, ...options });
const low = f => { f.state.fleets[0].durability = 1500; };
const check = async (name, work) => { try { await work(); results.push({ name, passed: true }); console.log('通过：' + name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); } };

try {
  await check('旧配置原值与文件不变，新增行为默认值及导入校验正确', () => {
    const old = defaultSettings(); old.treasure.minDurabilityPercent = 91; old.treasure.followNames = ['原有名单'];
    for (const key of ['avoidPlayerIds', 'participationMode', 'repeatAttack', 'autoRepair', 'maxRepairCost', 'dailyRepairPetrolLimit']) delete old.treasure[key];
    const file = path.join(directory, 'legacy.json'); fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { legacy: { settings: old, revision: 17 } } }));
    const original = fs.readFileSync(file), loaded = loadAutomationSettings('legacy', { file });
    assert.equal(loaded.revision, 17); assert.equal(loaded.settings.treasure.minDurabilityPercent, 91); assert.deepEqual(loaded.settings.treasure.followNames, ['原有名单']);
    assert.equal(loaded.settings.treasure.participationMode, 'untilFull'); assert.equal(loaded.settings.treasure.autoRepair, true); assert.equal(loaded.settings.treasure.repeatAttack, true); assert.deepEqual(fs.readFileSync(file), original);
    const imported = importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: old }); assert.deepEqual(imported, loaded.settings);
    for (const [key, value] of [['participationMode', 'bad'], ['maxRepairCost', -1], ['dailyRepairPetrolLimit', -1], ['avoidPlayerIds', ['9e16']], ['avoidPlayerIds', ['9223372036854775808']]]) {
      const s = defaultSettings(); s.treasure[key] = value; assert.throws(() => validateSettings(s));
    }
  });

  await check('已确认同船出征被打回后可再派，纯预览不修改历史账本', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger();
    await run(f, s, usage); assert.equal(f.client.writes.length, 1); assert.equal(usage.keyRecords()[treasureDispatchKey(1001001, 72, '1远征船')].confirmed, true);
    await run(f, s, usage); assert.equal(f.client.writes.length, 1);
    f.returnFromTreasure('1远征船'); const before = usage.keyRecords();
    const p = await preview(f, s, { usage: usage.snapshot(), keys: before }); assert.equal(p.actions[0].body.uid, 72); assert.deepEqual(usage.keyRecords(), before);
    await run(f, s, usage); assert.equal(f.client.writes.length, 2); assert.equal(usage.snapshot().counters.treasureDispatches, 2); assert.equal(usage.snapshot().counters.treasurePetrol, 1000);
  });

  await check('确认记录在重建和换日后仍可返航再派，次数记入实际发送日', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), file = path.join(directory, 'repeat.json'); let now = Date.parse('2026-11-03T15:59:00Z');
    let usage = ledger({ file, now: () => now }); await run(f, s, usage); f.returnFromTreasure('1远征船'); now += 120000;
    usage = ledger({ file, now: () => now }); await run(f, s, usage);
    assert.equal(f.client.writes.length, 2); assert.equal(usage.snapshot().counters.treasureDispatches, 1); assert.equal(usage.pendingCounters().treasurePetrol, undefined);
  });

  await check('省略协议默认字段的返航回包仍能识别空闲并再次派遣', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); f.omitIdleDefaults = true;
    await run(f, s, usage); f.returnFromTreasure('1远征船');
    const wireFleet = (await f.client.request('MyFleetsRequest')).fleets[0];
    assert.equal(wireFleet.state, 1); assert.equal(wireFleet.treasureLootUid, 0); assert.equal(wireFleet.curGridIdx, 0);
    assert.equal(Object.hasOwn(wireFleet, 'state'), false); assert.equal(Object.hasOwn(wireFleet, 'treasureLootUid'), false); assert.equal(Object.hasOwn(wireFleet, 'curGridIdx'), false);
    const snapshot = await read(f, s); assert.equal(snapshot.fleets[0].state, 1); assert.equal(snapshot.fleets[0].treasureLootUid, 0); assert.equal(snapshot.fleets[0].curGridIdx, 0);
    await run(f, s, usage); assert.equal(f.client.writes.length, 2); assert.equal(usage.snapshot().counters.treasureDispatches, 2);
  });

  await check('省略默认字段时可读维修报价，修后释放维修键并派遣', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); f.omitIdleDefaults = true; low(f);
    const snapshot = await read(f, s); assert.equal(snapshot.repairs['1远征船'].unitRepairCost, 2);
    await run(f, s, usage); assert.equal(f.client.writes[0].name, 'RepairFleetRequest');
    f.finishRepair('1远征船'); await run(f, s, usage);
    assert.equal(usage.hasKey(treasureRepairKey(1001001, '1远征船')), false); assert.equal(f.client.writes[1].name, 'TreasureLootSendFleetsRequest');
  });

  await check('协议省略零耐久仍能维修，满额零动作只显示中性条件', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); f.omitIdleDefaults = true; f.state.fleets[0].durability = 0;
    const raw = (await f.client.request('MyFleetsRequest')).fleets[0]; assert.equal(raw.durability, 0); assert.equal(Object.hasOwn(raw, 'durability'), false);
    assert.equal((await preview(f, s)).actions[0].kind, 'treasureRepair');
    f.state.stats.todayRewardTimes = 3; const plan = await preview(f, s); assert.equal(plan.actions.length, 0);
    assert.equal(plan.fleets[0].reason, '耐久不足，需先维修'); assert(!plan.fleets[0].reason.includes('安排'));
  });

  await check('未知派遣不能因空闲或反复攻占而重发，也不能转为维修', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); f.unknown = true;
    await run(f, s, usage); f.returnFromTreasure('1远征船', 1000); await run(f, s, usage);
    assert.equal(f.client.writes.length, 1); assert.equal(usage.snapshot().uncertain, 1); assert.equal(usage.pendingCounters().treasurePetrol, 500);
    assert.match((await preview(f, s, { keys: usage.keyRecords() })).notes.join(' '), /派遣结果尚未确认/);
  });

  await check('普通维修完整循环：低耐久维修、等待、满耐久再派、再次被打回后继续', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); low(f);
    let result = await run(f, s, usage); assert.equal(result.results[0].step.kind, 'treasureRepair'); assert.equal(result.results[0].status, 'confirmed');
    assert.equal(usage.snapshot().counters.treasureDispatches ?? 0, 0); assert.equal(usage.snapshot().counters.treasureRepairPetrol, 1000);
    await run(f, s, usage); assert.equal(f.client.writes.length, 1);
    f.finishRepair('1远征船'); await run(f, s, usage); assert.equal(f.client.writes[1].name, 'TreasureLootSendFleetsRequest');
    f.returnFromTreasure('1远征船', 1500); await run(f, s, usage); assert.equal(f.client.writes[2].name, 'RepairFleetRequest');
    f.finishRepair('1远征船'); await run(f, s, usage);
    assert.deepEqual(f.client.writes.map(row => row.name), ['RepairFleetRequest', 'TreasureLootSendFleetsRequest', 'RepairFleetRequest', 'TreasureLootSendFleetsRequest']);
    assert.equal(usage.snapshot().counters.treasureRepairs, 2); assert.equal(usage.snapshot().counters.treasureDispatches, 2); assert.equal(usage.snapshot().counters.treasurePetrol, 3000);
  });

  await check('零耐久可普通维修，未知或异常耐久上限不维修不出征', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); f.state.fleets[0].durability = 0; s.treasure.minDurabilityPercent = 0;
    assert.equal((await preview(f, s)).actions[0].kind, 'treasureRepair');
    for (const [durability, maxDura] of [[10, 0], [-1, 2000], [2001, 2000]]) { const g = treasureCycleFixture(); Object.assign(g.state.fleets[0], { durability, maxDura }); await run(g, s); assert.equal(g.client.writes.length, 0); }
  });

  await check('关闭自动维修仍跳过低耐久；满耐久不额外维修', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); low(f); s.treasure.autoRepair = false;
    let p = await preview(f, s); assert.equal(p.actions.length, 0); assert.match(p.notes.join(' '), /自动维修已关闭/);
    f.state.fleets[0].durability = 2000; p = await preview(f, s); assert.equal(p.actions[0].kind, 'treasureDispatch');
  });

  await check('两种参与模式都服从预算与避战，打满后仅每次参与可继续', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); f.state.stats.todayRewardTimes = 3;
    assert.equal((await preview(f, s)).actions.length, 0); low(f); assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.participationMode = 'always'; assert.equal((await preview(f, s)).actions[0].kind, 'treasureRepair');
    f.state.fleets[0].durability = 2000; assert.equal((await preview(f, s)).actions[0].kind, 'treasureDispatch');
    s.treasure.petrolReserve = f.state.fuel; assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.petrolReserve = 0; s.treasure.dailyDispatchLimit = 1; assert.equal((await preview(f, s, { usage: { counters: { treasureDispatches: 1 } } })).actions.length, 0);
  });

  await check('单次、每日维修上限及修后出征汽油保留量实际门控', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); low(f);
    s.treasure.maxRepairCost = 999; assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.maxRepairCost = 1000; s.treasure.dailyRepairPetrolLimit = 999; assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.dailyRepairPetrolLimit = 1000; assert.equal((await preview(f, s, { usage: { counters: { treasureRepairPetrol: 1 } } })).actions.length, 0);
    s.treasure.petrolReserve = f.state.fuel - 1499; assert.equal((await preview(f, s)).actions.length, 0);
    s.treasure.petrolReserve = f.state.fuel - 1500; assert.equal((await preview(f, s)).actions[0].costs[0].num, 1000);
    s.treasure.maxRepairCost = s.treasure.dailyRepairPetrolLimit = 0; assert.equal((await preview(f,s,{usage:{counters:{treasureRepairPetrol:1000000}}})).actions[0].kind,'treasureRepair');
    s.treasure.petrolReserve=f.state.fuel;assert.equal((await preview(f,s)).actions.length,0);
  });

  await check('没有合适货轮、每日派遣满额或关闭反复攻占时不做无用维修', async () => {
    for (const kind of ['noTarget', 'progress', 'limit', 'repeatOff']) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger();
      if (kind === 'repeatOff') { s.treasure.repeatAttack = false; await run(f, s, usage); f.returnFromTreasure('1远征船', 1500); }
      else low(f);
      if (kind === 'noTarget') f.state.targets = [];
      if (kind === 'progress') f.state.targets[0].progress = 100;
      if (kind === 'limit') { s.treasure.dailyDispatchLimit = 1; const t = usage.reserve({ treasureDispatches: 1 }); usage.confirm(t); }
      const count = f.client.writes.length; await run(f, s, usage); assert.equal(f.client.writes.length, count);
    }
  });

  await check('维修完成后再次核验奖励次数与目标，不沿用过期派遣意图', async () => {
    for (const kind of ['quota', 'target', 'follow']) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); low(f); await run(f, s, usage); f.finishRepair('1远征船');
      if (kind === 'quota') f.state.stats.todayRewardTimes = 3;
      if (kind === 'target') f.state.targets = [];
      if (kind === 'follow') Object.assign(s.treasure, { follow: true, autoJoin: false, followPlayerIds: ['9007199254740995'] });
      await run(f, s, usage); assert.equal(f.client.writes.length, 1);
    }
  });

  await check('未知维修跨日与重建不重发，后续读到维修后释放未知预算', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), file = path.join(directory, 'repair-restart.json'); let now = Date.parse('2026-11-03T15:59:00Z');
    let usage = ledger({ file, now: () => now }); low(f); f.unknown = true; await run(f, s, usage); assert.equal(usage.pendingCounters().treasurePetrol, 1000);
    now += 120000; usage = ledger({ file, now: () => now }); await run(f, s, usage); assert.equal(f.client.writes.length, 1); assert.equal(usage.snapshot().counters.treasureRepairs, undefined);
    Object.assign(f.state.fleets[0], { state: 4, repairing: { startTs: Math.floor(Date.now() / 1000), endTs: Math.floor(Date.now() / 1000) + 300 } });
    await run(f, s, usage); assert.equal(usage.snapshot().uncertain, 0); assert.equal(usage.snapshot().counters.treasureRepairs, undefined);
    f.unknown = false; f.finishRepair('1远征船'); await run(f, s, usage); assert.equal(f.client.writes.length, 2); assert.equal(usage.snapshot().counters.treasureDispatches, 1);
  });

  await check('明确拒绝维修才返还预约；空回包不假报成功', async () => {
    for (const reject of [true, false]) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); low(f); f.reject = reject; f.unknown = !reject;
      const result = await run(f, s, usage); assert.equal(result.results[0].status, reject ? 'rejected' : 'unknown');
      assert.equal(usage.snapshot().counters.treasureRepairs, reject ? 0 : 1); assert.equal(usage.snapshot().uncertain, reject ? 0 : 1);
    }
  });

  await check('城战与巨轮未知维修对同队双向互斥，共享汽油占用', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); low(f);
    usage.reserve({ cityWarPetrol: 1000 }, {}, {}, { uniqueKey: 'cityWar:1001001:1', details: { buildingId: '1远征船', kind: 'cityRepair', beforeDurability: 1500 } });
    assert.equal((await preview(f, s, { keys: usage.keyRecords(), pendingFuel: 1000 })).actions.length, 0);
    const other = ledger(); other.reserve({ treasurePetrol: 1000, treasureRepairPetrol: 1000 }, {}, {}, { uniqueKey: treasureRepairKey(1001001, '1远征船'), details: { buildingId: '1远征船', beforeDurability: 1500 } });
    Object.assign(s.cityWar, { enabled: true, fleetIds: ['1远征船'] });
    const war = await readCityWar(f.client, f.protocol, f.config, f.player, s.cityWar, { mapLoader: f.mapLoader });
    const p = planCityWar(war, s, { keys: other.keyRecords(), pendingPetrol: other.pendingCounters().treasurePetrol });
    assert.equal(p.actions.length, 0); assert.match(p.notes.join(' '), /巨轮维修结果待确认/);
    const g = treasureCycleFixture(); low(g); s.treasure.petrolReserve = g.state.fuel - 1500;
    assert.equal((await preview(g, s, { pendingFuel: 1 })).actions.length, 0);
  });

  await check('维修发送前暂停、设置关闭、城战接管和报价变化均拦截', async () => {
    for (const kind of ['pause', 'off', 'reserved', 'quote']) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); low(f); let enabled = true, quotes = 0;
      f.beforeRead = name => { if (name === 'WorldInfoRequest') { if (kind === 'pause') enabled = false; if (kind === 'off') s.treasure.autoRepair = false; } if (name === 'FleetRepairParamRequest' && ++quotes === 2 && kind === 'quote') f.state.repair.unitRepairCost = 3; };
      await run(f, s, usage, { enabled: () => enabled, canUseFleet: () => kind !== 'reserved' }); assert.equal(f.client.writes.length, 0); assert.equal(usage.snapshot().uncertain, 0);
    }
  });

  await check('修理中的舰队与并发检查不重复发起普通维修', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); low(f);
    await Promise.all([run(f, s, usage), run(f, s, usage)]); assert.equal(f.client.writes.length, 1);
    await run(f, s, usage); assert.equal(f.client.writes.length, 1);
  });

  await check('完整挂机15秒轮间链路完成维修后派遣', async () => {
    const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
    try {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(), controller = new AbortController(), sent = [], start = now; low(f);
      f.beforeRead = name => { if (name === 'MyFleetsRequest' && now - start >= 15000 && f.state.fleets[0].state === 4) f.finishRepair('1远征船'); };
      f.beforeSend = name => { sent.push([name, now - start]); if (name === 'TreasureLootSendFleetsRequest') controller.abort(); };
      await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 0, everyMs: 60000, allowMutate: true,
        getSettings: () => s, usageLedger: usage, isEnabled: () => false, stop: controller.signal,
        sleep: async ms => { now += ms; if (now - start > 120000) throw new Error('未在轮间接续'); } });
      assert.deepEqual(sent, [['RepairFleetRequest', 0], ['TreasureLootSendFleetsRequest', 15000]]);
    } finally { Date.now = originalNow; }
  });

  await check('真实成员协议保持64位ID、同名独立选择，排除自己和黑名单', async () => {
    const f = treasureCycleFixture(); const view = await readGuildMembers(f.client, f.config, f.player);
    assert.equal(view.members.length, 3); assert.deepEqual(view.members.filter(m => m.name === '同名盟友').map(m => m.id).sort(), ['9007199254740995', '9007199254740997']);
    assert(!view.members.some(m => m.name === '黑名单成员')); assert.equal(f.client.writes.length, 0);
    const s = treasureCycleSettings(); s.treasure.follow = true; s.treasure.followPlayerIds = [view.members[0].id]; assert.equal(validateSettings(s).treasure.followPlayerIds[0], view.members[0].id);
  });

  await check('读取过程中联盟身份改变或成员ID冲突时拒绝返回误导名单', async () => {
    const f = treasureCycleFixture(); f.beforeRead = name => { if (name === 'GuildMemberRequest') f.player.guildId = '9007199254741008'; };
    await assert.rejects(readGuildMembers(f.client, f.config, f.player), /角色或联盟已变化/);
    const g = treasureCycleFixture(); g.state.members.titleList[0].members.push({ playerId: '9007199254740995', nickname: '另一昵称', guildTitle: 2 });
    await assert.rejects(readGuildMembers(g.client, g.config, g.player), /昵称冲突/);
    const h = treasureCycleFixture(); h.player.guildId = '0'; const v = await readGuildMembers(h.client, h.config, h.player); assert.equal(v.state, 'notJoined'); assert.deepEqual(v.members, []);
  });

  await check('所选避战ID只约束当前参与者，历史排名本身不阻挡', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); s.treasure.avoidPlayerIds = ['9007199254740995'];
    f.state.ranks[72] = [{ playerId: '9007199254740995', nickname: '更名后的盟友', guildIdx: 7 }];
    assert.equal((await preview(f, s)).actions.length, 1);
    f.state.targets[0].ownerGuildIdx = 7; f.state.targets[0].ownerFleetNum = 1; f.state.defenders[72] = [{ name: '更名后的盟友', guildIdx: 7 }];
    const p = await preview(f, s); assert.equal(p.actions.length, 0); assert.match(p.notes.join(' '), /所选避战玩家/);
  });

  await check('隔离HTTP成员选择按账号读取，保存导入两种模式和ID不执行游戏', async () => {
    process.env.CW_DATA_DIR = directory;
    const { saveStore, DATA_DIR } = await import('../src/accounts.mjs'); assert.equal(DATA_DIR, directory);
    saveStore({ activeId: 'cycle-a', accounts: ['cycle-a', 'cycle-b'].map(id => ({ id, label: id, url: 'ws://127.0.0.1:1', login: {}, automation: { enabled: false, paused: true } })) });
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 }); await app.listen();
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const api = async (account, route, body) => { const r = await fetch(base + route + '?account=' + account, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, body: await r.json() }; };
    try {
      const initial = (await api('cycle-a', '/api/settings')).body; await api('cycle-b', '/api/settings'); const a = treasureCycleFixture(), b = treasureCycleFixture();
      b.state.members.titleList = [{ guildTitle: 2, members: [{ playerId: '9007199254741099', nickname: '乙账号盟友', guildTitle: 2 }] }]; b.state.members.total = 1;
      for (const [id, f] of [['cycle-a', a], ['cycle-b', b]]) Object.assign(app.sessions.get(id), { client: f.client, player: f.player, paused: false });
      assert.equal((await api('cycle-a', '/api/settings/players')).body.members.length, 3); assert.equal((await api('cycle-b', '/api/settings/players')).body.members[0].name, '乙账号盟友');
      const s = initial.settings; Object.assign(s.treasure, { enabled: true, follow: true, followPlayerIds: ['9007199254740995'], avoidPlayerIds: ['9007199254740997'], fleetIds: ['1远征船'], participationMode: 'always' });
      const saved = await api('cycle-a', '/api/settings', { settings: s, revision: initial.revision, baseRevision: initial.baseRevision }); assert.equal(saved.status, 200);
      assert.equal((await api('cycle-b', '/api/settings')).body.settings.treasure.participationMode, 'untilFull');
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.body.settings)).treasure, s.treasure);
      assert.equal((await api('cycle-a', '/api/settings/preview', {category:'world',settings:s})).body.actions.length,0,'没有跟随对象时不为其他货轮维修');
      a.state.members.titleList[0].members[1].nickname='指定盟友';
      a.state.targets[0].ownerGuildIdx=7;a.state.targets[0].ownerFleetNum=1;
      a.state.defenders[a.state.targets[0].uid]=[{name:'指定盟友',guildIdx:7,isNpc:false}];
      a.state.ranks[a.state.targets[0].uid]=[];
      low(a); const previewResult = await api('cycle-a', '/api/settings/preview', { category: 'world', settings: s }); assert.equal(previewResult.status, 200); assert.equal(previewResult.body.actions[0].kind, 'treasureRepair'); assert.equal(previewResult.body.treasure.participationMode, 'always');
      assert.equal(a.client.writes.length, 0); assert.equal(b.client.writes.length, 0); assert.equal(app.sessions.get('cycle-a').loop.running, false);
      app.sessions.get('cycle-a').paused = true; assert.equal((await api('cycle-a', '/api/settings/players')).status, 400);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
} finally {
  const report = { at: new Date().toISOString(), kind: '巨轮循环与盟友选择：真实协议的受控数据，未操作真实游戏', total: results.length, passed: results.filter(row => row.passed).length, results };
  const file = path.join(parent, 'result-' + Date.now() + '.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(parent) || !path.basename(resolved).startsWith('run-')) throw new Error('临时测试目录越界，未清理');
  fs.rmSync(resolved, { recursive: true });
  console.log(`巨轮循环专项：${report.passed}/${report.total} 组通过`); console.log(file);
  if (report.total !== report.passed) process.exitCode = 1;
}
