import os from 'node:os';
// 虚构状态经过真实协议编解码；不连接游戏，不读取真实账号或修改配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, validateSettings, importAutomationSettings, loadAutomationSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { readTreasureLoot, planTreasureLoot, runTreasureLoot } from '../src/treasure-loot.mjs';
import { readCityWar, planCityWar, runCityWar } from '../src/city-war.mjs';
import { treasureCycleFixture, treasureCycleSettings } from './fixtures/treasure-cycle.mjs';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';

const parent = path.join(os.tmpdir(),'cw-target-limits-tests');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-'));
let sequence = 0;
const results = [];
const ledger = () => createUsageLedger('虚构验证账号', { file: path.join(directory, `usage-${sequence++}.json`) });
const check = async (name, work) => { try { await work(); results.push({ name, passed: true }); console.log('通过：' + name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); } };
const ownRank = (f, progress, uid = 72, estProgress = progress) => { f.state.ranks[uid] = [{ playerId: f.player.playerId, nickname: f.player.nickname, guildIdx: 7, progress, estProgress }]; };
const readTreasure = (f, s) => readTreasureLoot(f.client, f.protocol, f.config, f.player, { preferences: s.treasure });
const treasurePlan = async (f, s) => planTreasureLoot(await readTreasure(f, s), f.config, s);
const runTreasure = (f, s, usage = ledger()) => runTreasureLoot(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger: usage });
const readWar = (f, s) => readCityWar(f.client, f.protocol, f.config, f.player, s.cityWar, { mapLoader: f.mapLoader });
const warPlan = async (f, s) => planCityWar(await readWar(f, s), s);
const warFixture = () => {
  const f = warForgeFixture();
  f.state.war.declarations.push({ attackGuildIdx: 7, defenceGuildIdx: 8, cityId: 3 });
  Object.assign(f.state.cities[1], { attackFleetNum: 8, priorityAtkFleetNum: 2 });
  Object.assign(f.state.cities[2], { attackFleetNum: 1, priorityAtkFleetNum: 1 });
  return f;
};

try {
  await check('新增设置、0/100边界、旧值及导入兼容，读取不改旧文件', () => {
    const old = validateSettings(defaultSettings()); delete old.treasure.personalProgressLimit; delete old.cityWar.targetPriority; delete old.cityWar.nativeCommissionLimit;
    old.treasure.maxProgress = 87; old.cityWar.targetMode = 'selected'; old.cityWar.cityRefs = ['1:3'];
    const file = path.join(directory, 'old.json'); fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old: { settings: old, revision: 21 } } }));
    const bytes = fs.readFileSync(file); const loaded = loadAutomationSettings('old', { file });
    assert.equal(loaded.settings.treasure.personalProgressLimit, 20); assert.equal(loaded.settings.cityWar.targetPriority, 'fewestAllied');
    assert.equal(loaded.settings.cityWar.nativeCommissionLimit, -1);
    assert.equal(loaded.revision, 21); assert.deepEqual(fs.readFileSync(file), bytes);
    const imported = importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: old });
    assert.deepEqual(imported, loaded.settings);
    const preserved = structuredClone(imported); delete preserved.treasure.personalProgressLimit; delete preserved.cityWar.targetPriority; delete preserved.cityWar.nativeCommissionLimit; assert.deepEqual(preserved, old);
    for (const n of [0, 20, 100]) { const s = defaultSettings(); s.treasure.personalProgressLimit = n; assert.equal(validateSettings(s).treasure.personalProgressLimit, n); }
    for (const n of [-1, 101, 20.5, '20']) { const s = defaultSettings(); s.treasure.personalProgressLimit = n; assert.throws(() => validateSettings(s)); }
    for (const n of [-1, 0, 2, 1000]) { const s = defaultSettings(); s.cityWar.nativeCommissionLimit = n; assert.equal(validateSettings(s).cityWar.nativeCommissionLimit, n); }
    for (const n of [-2, 1001, 1.5, '2']) { const s = defaultSettings(); s.cityWar.nativeCommissionLimit = n; assert.throws(() => validateSettings(s)); }
    const bad = defaultSettings(); bad.cityWar.targetPriority = 'random'; assert.throws(() => validateSettings(bad));
  });
  await check('只认精确本人ID与实际进度，预计值和联盟进度不代替', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); ownRank(f, 19, 72, 99); f.state.targets[0].progress = 85;
    assert.equal((await treasurePlan(f, s)).actions.length, 1);
    ownRank(f, 20, 72, 0); const p = await treasurePlan(f, s); assert.equal(p.actions.length, 0); assert.match(p.targets[0].reason, /20% \/ 20%/);
    f.state.ranks[72] = [{ playerId: '9007199254740994', nickname: f.player.nickname, guildIdx: 7, progress: 100 }];
    assert.equal((await treasurePlan(f, s)).targets[0].personalProgress, 0);
  });
  await check('达标后被打回不再派遣，也不为该货轮提前维修', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); ownRank(f, 19);
    await runTreasure(f, s, usage); assert.equal(f.client.writes.length, 1);
    f.returnFromTreasure('1远征船', 100); ownRank(f, 20);
    await runTreasure(f, s, usage); await runTreasure(f, s, usage); assert.equal(f.client.writes.length, 1);
    assert.equal(usage.snapshot().counters.treasureDispatches, 1);
  });
  await check('逐艘计算，已达标货轮不阻止其他未达标货轮', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); ownRank(f, 20);
    f.state.targets.push({ ...f.state.targets[0], uid: 73, progress: 25 }); f.state.defenders[73] = []; ownRank(f, 5, 73);
    f.state.fleets[0].durability = 100;
    const p = await treasurePlan(f, s); assert.equal(p.actions.length, 1); assert.equal(p.actions[0].kind, 'treasureRepair'); assert.equal(p.actions[0].targetUid, 73);
  });
  await check('上限0停止新派遣及维修，不召回正在参与的舰队', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); s.treasure.personalProgressLimit = 0;
    f.state.fleets[0].durability = 100; await runTreasure(f, s); assert.equal(f.client.writes.length, 0);
    Object.assign(f.state.fleets[0], { state: 5, treasureLootUid: 72 }); await runTreasure(f, s); assert.equal(f.client.writes.length, 0); assert.equal(f.state.fleets[0].treasureLootUid, 72);
  });
  await check('排名失败、重复本人、无效实际进度都不派遣', async () => {
    for (const kind of ['failed', 'duplicate', 'negative', 'overflow']) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(); ownRank(f, kind === 'negative' ? -1 : kind === 'overflow' ? 101 : 5);
      if (kind === 'duplicate') f.state.ranks[72].push({ ...f.state.ranks[72][0] });
      if (kind === 'failed') f.beforeRead = name => { if (name === 'TreasureLootRankRequest') throw new Error('模拟查询失败'); };
      await runTreasure(f, s); assert.equal(f.client.writes.length, 0, kind); assert.ok((await treasurePlan(f, s)).targets[0].reason);
    }
  });
  await check('派遣前进度达到上限，取消本次派遣', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); ownRank(f, 19); let reads = 0;
    f.beforeRead = name => { if (name === 'TreasureLootRankRequest' && ++reads >= 2) ownRank(f, 20); };
    await runTreasure(f, s); assert.equal(f.client.writes.length, 0); assert.ok(reads >= 2);
  });
  await check('维修前进度达标或查询失效，都不花汽油', async () => {
    for (const failed of [false, true]) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(); ownRank(f, 19); f.state.fleets[0].durability = 100; let reads = 0;
      f.beforeRead = name => { if (name === 'TreasureLootRankRequest' && ++reads >= 2) { if (failed) throw new Error('模拟失效'); ownRank(f, 20); } };
      await runTreasure(f, s); assert.equal(f.client.writes.length, 0); assert.equal(f.state.fuel, 50000);
    }
  });
  await check('城战少人优先，合计普通/精英队列及当前交战', async () => {
    const f = warFixture(), s = warForgeSettings();
    f.state.cities[2].battlePoints = [{ index: 1, leftFighter: { name: '己方甲', guildIdx: 7, isNpc: false } }];
    const snapshot = await readWar(f, s); assert.equal(snapshot.targets.find(t => t.id === 3).alliedCount, 3);
    const p = planCityWar(snapshot, s); assert.equal(p.actions[0].cityId, 3); assert.equal(p.actions[0].request, 'MoveFleetsToCityRequest');
    s.cityWar.targetPriority = 'original'; assert.equal(planCityWar(snapshot, s).actions[0].cityId, 2);
  });
  await check('人数优先仍限制在所选已宣战城市，原优先顺序可选', async () => {
    const f = warFixture(), s = warForgeSettings(); s.cityWar.targetMode = 'selected'; s.cityWar.cityRefs = ['1:2'];
    assert.equal((await warPlan(f, s)).actions[0].cityId, 2);
    s.cityWar.cityRefs = ['1:2', '1:3']; assert.equal((await warPlan(f, s)).actions[0].cityId, 3);
    s.cityWar.targetPriority = 'original'; assert.equal((await warPlan(f, s)).actions[0].cityId, 2);
  });
  await check('多联盟共同进攻不能用总数冒充本盟人数，未知不当0', async () => {
    const f = warFixture(), s = warForgeSettings();
    f.state.war.declarations.push({ cityId: 3, attackGuildIdx: 9, defenceGuildIdx: 8 });
    const p = await warPlan(f, s); assert.equal(p.targets.find(t => t.id === 3).alliedCount, null); assert.equal(p.actions[0].cityId, 2); assert.match(p.notes.join(' '), /多联盟/);
    f.state.cities[1].attackFleetNum = -1; const q = await warPlan(f, s); assert.equal(q.actions.length, 0); assert.match(q.notes.join(' '), /未确认/);
  });
  await check('队数相近时就近，差10队以上选人少城，在途舰队计入总数', async () => {
    const f = warFixture(), s = warForgeSettings();
    Object.assign(f.state.cities[1], { attackFleetNum: 30, priorityAtkFleetNum: 0 });
    Object.assign(f.state.cities[2], { attackFleetNum: 31, priorityAtkFleetNum: 0 });
    let p = await warPlan(f, s); assert.equal(p.actions[0].cityId, 3, '30 对 31，选更近的城市');
    Object.assign(f.state.cities[1], { attackFleetNum: 0, priorityAtkFleetNum: 0 });
    Object.assign(f.state.cities[2], { attackFleetNum: 0, priorityAtkFleetNum: 0 });
    p = await warPlan(f, s); assert.deepEqual(p.actions.map(a => a.cityId), [3, 3], '同人数时选更近的城市');
    for (let i = 0; i < 11; i++) f.state.fleets.push({ buildingId: (10 + i) + '远征船', state: 2, targetCityId: 3,
      treasureLootUid: 0, curGridIdx: 0, owner: { playerId: '9007199254741999', guildId: f.player.guildId } });
    p = await warPlan(f, s); assert.equal(p.targets.find(t => t.id === 3).transitCount, 11);
    assert.deepEqual(p.actions.map(a => a.cityId), [2, 2], '相差 10 队以上时改选人少的城市');
  });
  await check('在途舰队归属未同步时不把未知当作0', async () => {
    const f = warFixture(), s = warForgeSettings();
    Object.assign(f.state.cities[1], { attackFleetNum: 0, priorityAtkFleetNum: 0 });
    Object.assign(f.state.cities[2], { attackFleetNum: 0, priorityAtkFleetNum: 0 });
    f.state.fleets.push({ buildingId: '20远征船', state: 2, targetCityId: 2, treasureLootUid: 0, curGridIdx: 0, owner: null });
    const p = await warPlan(f, s);
    assert.equal(p.targets.find(t => t.id === 2).transitCount, null);
    assert.ok(p.actions.every(a => a.cityId === 3));
    assert.match(p.notes.join(' '), /在途舰队归属未同步/);
  });
  await check('发送前人数反转不向旧目标误派遣', async () => {
    const f = warFixture(), s = warForgeSettings(); s.cityWar.fleetIds = ['1远征船']; let reads = 0;
    f.beforeRead = name => { if (name === 'WorldInfoRequest' && ++reads >= 2) f.state.cities[2].attackFleetNum = 100; };
    await runCityWar(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger: ledger(), mapLoader: f.mapLoader });
    assert.equal(f.client.writes.length, 0); assert.ok(reads >= 2);
  });
  await check('新优先策略不绕过原生委任次数、汽油和时段限制', async () => {
    const f = warFixture(), s = warForgeSettings(); f.state.fleets.forEach(fleet => { fleet.autoFight.todayTimes = 0; });
    assert.equal((await warPlan(f, s)).actions.length, 0);
    f.state.fleets.forEach(fleet => { fleet.autoFight.todayTimes = 4; }); s.cityWar.petrolReserve = 50000; assert.equal((await warPlan(f, s)).actions.length, 0);
    s.cityWar.petrolReserve = 0; f.state.war.startTime += 7200; f.state.war.endTime += 7200; assert.equal((await warPlan(f, s)).actions.length, 0);
  });
} finally {
  const report = { at: new Date().toISOString(), kind: '虚构受控数据，真实协议编解码；未连接游戏', passed: results.filter(x => x.passed).length, total: results.length, results };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`个人进度/城战优先专项：${report.passed}/${report.total}`); console.log(path.join(directory, 'result.json'));
  if (report.passed !== report.total) process.exitCode = 1;
}
