// 货轮筛选专项：虚构状态经真实协议编解码，只访问隔离 HTTP，不登录或操作真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, validateSettings, importAutomationSettings, exportAutomationSettings, saveAutomationSettings, loadAutomationSettings, createUsageLedger, nativeTaskValues, settingsCatalog } from '../src/automation-settings.mjs';
import { automationWireId } from '../src/automation-policy.mjs';
import { readTreasureLoot, planTreasureLoot, runTreasureLoot, serviceTreasureLoot } from '../src/treasure-loot.mjs';
import { readWorldTarget } from '../src/world-target.mjs';
import { runLoop } from '../src/loop.mjs';
import { treasureCycleFixture, treasureCycleSettings } from './fixtures/treasure-cycle.mjs';
import { loadConfig } from '../src/config.mjs';
import { matchesTreasureRewards, treasureRewardOptions } from '../src/treasure-reward-filter.mjs';

const parent = path.join(os.tmpdir(), 'cw-treasure-filter-tests');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-'));
let sequence = 0;
const results = [];
const ledger = () => createUsageLedger('虚构货轮筛选账号', { file: path.join(directory, 'usage-' + sequence++ + '.json') });
const check = async (name, work) => {
  try { await work(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
};
const read = (f, s) => readTreasureLoot(f.client, f.protocol, f.config, f.player, { preferences: s.treasure });
const preview = async (f, s) => planTreasureLoot(await read(f, s), f.config, s);
const run = (f, s, usage = ledger(), options = {}) => runTreasureLoot(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger: usage, ...options });
const small = (f, quality = 'BLUE') => { f.state.targets[0].color = f.protocol.Color[quality]; return f.state.targets[0]; };
const addTarget = (f, quality, uid) => {
  const target = { ...structuredClone(f.state.targets[0]), uid, color: f.protocol.Color[quality] };
  f.state.targets.push(target); f.state.defenders[uid] = []; f.state.ranks[uid] = []; return target;
};
const assertUnused = (f, usage) => {
  assert.deepEqual(f.client.writes, []); assert.equal(usage.snapshot().uncertain, 0);
  assert.equal(usage.snapshot().counters.treasureDispatches ?? 0, 0);
  assert.equal(usage.snapshot().counters.treasureRepairs ?? 0, 0);
  assert.equal(usage.pendingCounters().treasurePetrol ?? 0, 0);
};
const morning = async work => {
  const realNow = Date.now; Date.now = () => Date.UTC(2026, 10, 14, 2);
  try { await work(); } finally { Date.now = realNow; }
};
const legacyFixture = () => {
  const f = treasureCycleFixture();
  // 旧入口用 Number 做 guildId 取模，隔离角色使用可精确表示的联盟编号。
  f.player.guildId = automationWireId('2004001001007');
  f.state.guild.guild.guildId = f.player.guildId;
  for (const fleet of f.state.fleets) { fleet.owner.guildId = f.player.guildId; fleet.autoFight.isOn = false; }
  return f;
};
const legacy = (f, s, options = {}) => serviceTreasureLoot(f.client, f.config, { player: f.player, protocol: f.protocol, getSettings: () => s, enabled: () => true, ...options });
const supplyFixture = () => {
  const f = treasureCycleFixture();
  f.config.tables.ItemCfg = { data: [
    { id: '展示补给材料', show_name: '垃圾袋', type: '通用' },
    ...['普通', '优秀', '稀有', '史诗', '传说'].map(quality => ({ id: quality + '补给材料', show_name: quality + '垃圾袋', type: '补给材料' })),
    { id: '同名其他物品', show_name: '传说垃圾袋', type: '通用' },
    { id: '紫芯片宝箱', show_name: '紫芯片宝箱', type: '宝箱' },
  ] };
  for (const [index, type] of f.config.tables.TreasureLootCfg.data.entries()) type.rewardLib = [1005 + index * 1000];
  f.config.tables.TreasureLootRewardCfg = { data: [
    ...['稀有', '史诗', '传说'].map((quality, index) => ({ libId: 1005 + index * 1000, reward: [quality + '补给材料', 2] })),
    { libId: 3005, reward: ['同名其他物品', 1] }, { libId: 3005, reward: ['紫芯片宝箱', 1] },
    { libId: 9999, reward: ['普通补给材料', 1] },
  ] };
  f.state.targets[0].reward.asset = [{ id: '传说补给材料', num: 2 }];
  return f;
};

try {
  await check('实际配置包含垃圾袋及货轮奖励，专用目录置前且不改通用材料', () => {
    const config = loadConfig(), catalog = settingsCatalog(config);
    const generic = catalog.treasureRewards.find(option => option.value === '展示补给材料');
    assert.equal(generic?.label, '垃圾袋（任意品质）');
    assert.equal(catalog.materials.find(option => option.value === generic.value)?.label, '垃圾袋');
    assert(catalog.treasureRewards.indexOf(generic) < 120, '泛称垃圾袋在首屏可见');
    for (const quality of ['稀有', '史诗', '传说']) {
      const id = quality + '补给材料', index = catalog.treasureRewards.findIndex(option => option.value === id);
      assert(index >= 0 && index < 120, quality + '垃圾袋应在首屏');
      assert.equal(catalog.treasureRewards[index].label, quality + '垃圾袋');
      assert(matchesTreasureRewards(config, [generic.value], [{ id, num: 2 }]), '来自实际奖励表的品质可由泛称匹配');
    }
    assert.deepEqual(catalog.treasureRewards.map(option => option.value).sort(), catalog.materials.map(option => option.value).sort(), '保留全部原材料选项');
    const before = structuredClone(catalog.materials), separate = treasureRewardOptions(config, catalog.materials);
    separate[0].label = '仅修改专用目录'; assert.deepEqual(catalog.materials, before, '目录不能共用可变选项对象');
    const s = defaultSettings(); s.treasure.rewardItems = ['展示补给材料', '传说补给材料'];
    assert.deepEqual(validateSettings(s, { catalog }).treasure.rewardItems, s.treasure.rewardItems);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(s), { catalog }).treasure.rewardItems, s.treasure.rewardItems, '既有展示ID保存与导入继续兼容');
    const source = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
    const groups = new Function(source.slice(0, source.indexOf('function configGet(')) + '\nreturn configGroups;')();
    const fields = groups.flatMap(group => group.fields), field = fields.find(row => row.key === 'treasure.rewardItems');
    assert.equal(field.catalog, 'treasureRewards'); assert.match(field.help, /任意品质/); assert.match(field.help, /搜索/);
    assert.equal(fields.find(row => row.key === 'guildShip.rewardItems').catalog, 'materials', '不改联盟商船材料选择');
  });

  await check('泛称仅匹配已引用奖励库中的真实补给材料，品质和混选保留精确语义', () => {
    const f = supplyFixture(), matches = (selected, id) => matchesTreasureRewards(f.config, selected, [{ id, num: 2 }]);
    for (const quality of ['稀有', '史诗', '传说']) assert(matches(['展示补给材料'], quality + '补给材料'));
    for (const id of ['普通补给材料', '优秀补给材料', '展示补给材料', '同名其他物品', '紫芯片宝箱', '专武材料']) assert.equal(matches(['展示补给材料'], id), false, id);
    assert(matches(['传说补给材料'], '传说补给材料')); assert.equal(matches(['传说补给材料'], '史诗补给材料'), false);
    assert(matches(['展示补给材料', '紫芯片宝箱'], '紫芯片宝箱'));
    assert(matches(['展示补给材料', '紫芯片宝箱'], '史诗补给材料'));
    assert(matches(['普通补给材料'], '普通补给材料'), '指定真实ID保留旧精确匹配，不受泛称奖励集合影响');
    assert(matches([], '紫芯片宝箱'), '空选择仍为不筛选');
  });

  await check('泛称映射缺少配置时拒绝猜测，混选其他物品和具体ID仍有效', () => {
    const changes = [
      f => { delete f.config.tables.ItemCfg; },
      f => { delete f.config.tables.TreasureLootRewardCfg; },
      f => { delete f.config.tables.TreasureLootCfg; },
      f => { f.config.tables.ItemCfg.data = f.config.tables.ItemCfg.data.filter(row => row.id !== '展示补给材料'); },
      f => { f.config.tables.TreasureLootCfg.data.forEach(row => { row.rewardLib = []; }); },
      f => { f.config.tables.ItemCfg.data.forEach(row => { row.type = '通用'; }); },
      f => { f.config.tables.TreasureLootRewardCfg.data.forEach(row => { row.reward[1] = 0; }); },
    ];
    for (const change of changes) {
      const f = supplyFixture(); change(f);
      assert.equal(matchesTreasureRewards(f.config, ['展示补给材料'], [{ id: '传说补给材料', num: 2 }]), false);
      assert(matchesTreasureRewards(f.config, ['传说补给材料'], [{ id: '传说补给材料', num: 2 }]));
      assert(matchesTreasureRewards(f.config, ['展示补给材料', '紫芯片宝箱'], [{ id: '紫芯片宝箱', num: 1 }]));
    }
  });

  await check('真实协议普通派遣按泛称匹配，具体品质不扩张到其他垃圾袋', async () => {
    const f = supplyFixture(), s = treasureCycleSettings(), usage = ledger(); s.treasure.rewardItems = ['展示补给材料'];
    addTarget(f, 'ORANGE', 73).reward.asset = [{ id: '紫芯片宝箱', num: 1 }]; f.state.targets[1].progress = 1;
    let plan = await preview(f, s); assert.equal(plan.actions.length, 1); assert.equal(plan.actions[0].targetUid, 72);
    s.treasure.rewardItems = ['史诗补给材料']; plan = await preview(f, s); assert.equal(plan.actions.length, 0);
    s.treasure.rewardItems = ['传说补给材料']; assert.equal((await preview(f, s)).actions[0].targetUid, 72);
    s.treasure.rewardItems = ['展示补给材料']; const result = await run(f, s, usage);
    assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].body.uid, 72);
    assert.equal(result.results[0].status, 'confirmed'); assert.equal(usage.snapshot().counters.treasureDispatches, 1);
  });

  await check('泛称奖励不能绕过只抢万吨，关闭吨位筛选才允许小船', async () => {
    const f = supplyFixture(), s = treasureCycleSettings(), usage = ledger(); small(f);
    f.state.targets[0].reward.asset = [{ id: '稀有补给材料', num: 2 }]; s.treasure.rewardItems = ['展示补给材料'];
    await run(f, s, usage); assertUnused(f, usage);
    s.treasure.onlyTenThousand = false; const snapshot = await read(f, s);
    assert.equal(planTreasureLoot(snapshot, f.config, s).actions.length, 1);
    s.treasure.onlyTenThousand = true; assert.equal(planTreasureLoot(snapshot, f.config, s).actions.length, 0);
  });

  await check('泛称奖励和跟随名单同时满足才派遣，不跟随时不转抢其他垃圾袋货轮', async () => {
    const f = supplyFixture(), s = treasureCycleSettings(), usage = ledger();
    Object.assign(s.treasure, { rewardItems: ['展示补给材料'], follow: true, followPlayerIds: ['9007199254740999'] });
    Object.assign(f.state.targets[0], { ownerGuildIdx: 7, ownerFleetNum: 1 });
    f.state.defenders[72] = [{ name: '海上的风', guildIdx: 7, isNpc: false }];
    f.state.ranks[72] = [{ playerId: '9007199254740999', nickname: '海上的风', guildIdx: 7, progress: 1 }];
    addTarget(f, 'ORANGE', 73).progress = 0;
    let plan = await preview(f, s); assert.equal(plan.actions.length, 1); assert.equal(plan.actions[0].mode, 'follow'); assert.equal(plan.actions[0].targetUid, 72);
    const defenders = f.state.defenders[72]; f.state.defenders[72] = [];
    assert.equal((await preview(f, s)).actions.length, 0, '未命中跟随者不因普通参与开关转抢其他垃圾袋货轮');
    f.state.defenders[72] = defenders; f.state.targets[0].reward.asset = [{ id: '紫芯片宝箱', num: 1 }];
    assert.equal((await preview(f, s)).actions.length, 0, '命中跟随者仍要满足奖励');
    f.state.targets[0].reward.asset = [{ id: '史诗补给材料', num: 2 }];
    await run(f, s, usage); assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].body.uid, 72);
  });

  await check('最终复核奖励或映射变化取消派遣与维修，不占用汽油次数', async () => {
    for (const mode of ['otherReward', 'exactQuality', 'missingMapping']) for (const durability of [2000, 1500]) {
      const f = supplyFixture(), s = treasureCycleSettings(), usage = ledger();
      s.treasure.rewardItems = [mode === 'exactQuality' ? '传说补给材料' : '展示补给材料']; f.state.fleets[0].durability = durability;
      let lists = 0;
      f.beforeRead = name => {
        if (name !== 'TreasureLootListRequest' || ++lists !== 2) return;
        if (mode === 'missingMapping') delete f.config.tables.TreasureLootRewardCfg;
        else f.state.targets[0].reward.asset = [{ id: mode === 'exactQuality' ? '史诗补给材料' : '紫芯片宝箱', num: 2 }];
      };
      const result = await run(f, s, usage); assert.equal(lists, 2); assertUnused(f, usage);
      assert(result.results.some(row => row.skipped && /变化/.test(row.reason)), mode);
    }
  });

  await check('最终回读后改选具体品质由最新设置复核，旧泛称计划不能穿透', async () => {
    const f = supplyFixture(), usage = ledger(); let s = treasureCycleSettings(), ranks = 0;
    s.treasure.rewardItems = ['展示补给材料'];
    f.beforeRead = name => { if (name === 'TreasureLootRankRequest' && ++ranks === 2) { s = structuredClone(s); s.treasure.rewardItems = ['史诗补给材料']; } };
    await run(f, s, usage, { getSettings: () => s }); assert.equal(ranks, 2); assertUnused(f, usage);
  });

  await check('开关默认只抢万吨，旧设置与导入补默认且显式关闭按账号保留', () => {
    assert.equal(defaultSettings().treasure.onlyTenThousand, true);
    const old = defaultSettings(); delete old.treasure.onlyTenThousand;
    const file = path.join(directory, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old: { revision: 4, settings: old } } }));
    const original = fs.readFileSync(file);
    assert.equal(loadAutomationSettings('old', { file }).settings.treasure.onlyTenThousand, true);
    assert.deepEqual(fs.readFileSync(file), original, '读取旧设置不改写文件');
    for (const format of ['crazywaterworld-automation', 'crazywaterword-automation']) {
      assert.equal(importAutomationSettings({ format, version: 1, settings: old }).treasure.onlyTenThousand, true);
    }
    const all = defaultSettings(); all.treasure.onlyTenThousand = false;
    saveAutomationSettings('all', all, { file, revision: 0 });
    assert.equal(loadAutomationSettings('all', { file }).settings.treasure.onlyTenThousand, false);
    assert.equal(loadAutomationSettings('old', { file }).settings.treasure.onlyTenThousand, true);
    assert.equal(importAutomationSettings(exportAutomationSettings(all)).treasure.onlyTenThousand, false);
    for (const invalid of ['false', 0, null]) {
      all.treasure.onlyTenThousand = invalid; assert.throws(() => validateSettings(all), /开关值/);
    }
  });

  await check('混合列表只读取万吨详情，保留全部 UID 且真实协议派遣只到万吨', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger();
    addTarget(f, 'BLUE', 73).progress = 0; addTarget(f, 'PURPLE', 74).progress = 1;
    const snap = await read(f, s);
    assert.deepEqual(snap.allUids, [72, 73, 74]); assert.equal(snap.targets.length, 1);
    assert.equal(snap.targets[0].quality, 'ORANGE'); assert.equal(snap.targets[0].name, '万吨货轮');
    assert(f.calls.filter(c => ['TreasureLootDefenceRequest', 'TreasureLootRankRequest'].includes(c.name)).every(c => c.body.uid === 72));
    await run(f, s, usage); assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].body.uid, 72);
    assert.equal(usage.snapshot().counters.treasureDispatches, 1);
  });

  await check('仅小中型货轮时空闲或低耐久舰队均等待，不派遣、不维修、不占用预算', async () => {
    for (const durability of [2000, 1500]) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger();
      small(f); addTarget(f, 'PURPLE', 73); f.state.fleets[0].durability = durability;
      const fuel = f.state.fuel, plan = await preview(f, s);
      assert.equal(plan.actions.length, 0); assert.match(plan.notes.join(' '), /等待/);
      await run(f, s, usage); assertUnused(f, usage); assert.equal(f.state.fuel, fuel);
    }
  });

  await check('缺省 preferences 仍只万吨；旧快照在重新开启开关后不能绕过 planner', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(); small(f);
    assert.equal((await readTreasureLoot(f.client, f.protocol, f.config, f.player)).targets.length, 0);
    s.treasure.onlyTenThousand = false; const snap = await read(f, s);
    assert.equal(planTreasureLoot(snap, f.config, s).actions.length, 1);
    s.treasure.onlyTenThousand = true; assert.equal(planTreasureLoot(snap, f.config, s).actions.length, 0);
    s.treasure.onlyTenThousand = false; delete snap.targets[0].quality;
    assert.equal(planTreasureLoot(snap, f.config, s).actions.length, 0, '无法确认类型的旧快照必须等待');
  });

  await check('关闭筛选后小型与中型均可派遣，名称正确且未知品质仍跳过', async () => {
    for (const [quality, name] of [['BLUE', '小型货轮'], ['PURPLE', '中型货轮']]) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(); s.treasure.onlyTenThousand = false; small(f, quality);
      const snap = await read(f, s); assert.equal(snap.targets[0].quality, quality); assert.equal(snap.targets[0].name, name);
      assert.match(planTreasureLoot(snap, f.config, s).actions[0].label, new RegExp(name));
      await run(f, s); assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].body.uid, 72);
    }
    for (const color of [0, 1, 2, 6, 99]) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger();
      s.treasure.onlyTenThousand = false; f.state.targets[0].color = color;
      await run(f, s, usage); assertUnused(f, usage);
    }
  });

  await check('缺失或冲突的配置/协议映射不会把未知目标当作小船放行', async () => {
    for (const kind of ['configMissing', 'configDuplicate', 'protocolMissing', 'protocolDuplicate']) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); small(f); s.treasure.onlyTenThousand = false;
      if (kind === 'configMissing') f.config.tables.TreasureLootCfg.data = f.config.tables.TreasureLootCfg.data.filter(r => r.quality !== 'BLUE');
      if (kind === 'configDuplicate') f.config.tables.TreasureLootCfg.data.push({ quality: 'BLUE', name: '冲突类型' });
      if (kind.startsWith('protocol')) {
        f.protocol = { ...f.protocol, Color: { ...f.protocol.Color } };
        if (kind === 'protocolMissing') delete f.protocol.Color.BLUE;
        else f.protocol.Color.PURPLE = f.protocol.Color.BLUE;
      }
      await run(f, s, usage); assertUnused(f, usage);
    }
  });

  await check('跟随当前守军同样遵守筛选，未命中不转抢其他小船', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); small(f);
    Object.assign(s.treasure, { follow: true, followPlayerIds: ['9007199254740999'] });
    Object.assign(f.state.targets[0], { ownerGuildIdx: 7, ownerFleetNum: 1 });
    f.state.defenders[72] = [{ name: '海上的风', guildIdx: 7, isNpc: false }];
    f.state.ranks[72] = [{ playerId: '9007199254740999', nickname: '海上的风', guildIdx: 7, progress: 1 }];
    await run(f, s, usage); assertUnused(f, usage);
    s.treasure.onlyTenThousand = false; const plan = await preview(f, s);
    assert.equal(plan.actions[0].mode, 'follow'); assert.equal(plan.actions[0].targetUid, 72);
    await run(f, s, usage); assert.equal(f.client.writes.length, 1);
  });

  await check('跟随已出发行军不绕过只抢万吨，关闭筛选后同目标可参与', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); small(f);
    Object.assign(s.treasure, { follow: true, followPlayerIds: ['9007199254740999'] });
    const now = Math.floor(Date.now() / 1000), original = f.client.request;
    const lead = { buildingId: '1远征船', owner: { playerId: automationWireId('9007199254740999'), nickname: '海上的风', guildId: f.player.guildId }, state: 2,
      treasureLootUid: 72, targetGridIdx: 500, startGridIdx: 100, moveStartTs: now - 1, moveEndTs: now + 180 };
    f.client.request = async (name, body, response) => {
      const value = await original(name, body, response);
      if (name !== 'WorldInfoRequest') return value;
      const type = f.protocol.WorldInfoResponse; return type.decode(type.encode({ ...value, fleets: [...value.fleets, lead] }).finish());
    };
    await run(f, s, usage); assertUnused(f, usage);
    s.treasure.onlyTenThousand = false; const plan = await preview(f, s);
    assert.equal(plan.actions[0].followPhase, 'departing'); await run(f, s, usage); assert.equal(f.client.writes.length, 1);
  });

  await check('出征或备战维修复查期间打开筛选、目标变为小船均取消且不占次数', async () => {
    for (const kind of ['settings', 'quality']) for (const durability of [2000, 1500]) {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); f.state.fleets[0].durability = durability;
      if (kind === 'settings') { small(f); s.treasure.onlyTenThousand = false; }
      f.beforeRead = name => { if (name === 'WorldInfoRequest') { if (kind === 'settings') s.treasure.onlyTenThousand = true; else small(f); } };
      await run(f, s, usage); assertUnused(f, usage);
    }
  });

  await check('完成复查读取时替换设置对象为只万吨也会被最后规划拦截', async () => {
    const f = treasureCycleFixture(), usage = ledger(); let s = treasureCycleSettings(), ranks = 0;
    small(f); s.treasure.onlyTenThousand = false;
    f.beforeRead = name => { if (name === 'TreasureLootRankRequest' && ++ranks === 2) { s = structuredClone(s); s.treasure.onlyTenThousand = true; } };
    await run(f, s, usage, { getSettings: () => s }); assert.equal(ranks, 2); assertUnused(f, usage);
  });

  await check('先无万吨再出现万吨会于后续检查继续，不因等待锁住舰队', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); small(f);
    await run(f, s, usage); assertUnused(f, usage);
    addTarget(f, 'ORANGE', 73); await run(f, s, usage);
    assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].body.uid, 73);
  });

  await check('地图目标预览与实际派遣遵守同一筛选且预览不写游戏', async () => {
    const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(); small(f);
    const view = () => readWorldTarget(f.client, f.protocol, f.config, f.player, s, usage, { layer: 'treasure', key: 'treasure-72' });
    let result = await view(); assert.equal(result.actions.length, 0); assert.match(result.notes.join(' '), /只抢万吨|等待/);
    s.treasure.onlyTenThousand = false; result = await view(); assert.equal(result.actions.length, 1); assert.match(result.actions[0].label, /小型货轮/);
    assertUnused(f, usage);
  });

  await check('旧挂机默认只抢万吨；关闭后已知小中型可参与，未知类型仍等待', () => morning(async () => {
    for (const [onlyTenThousand, color, expected] of [[true, 3, 0], [true, 4, 0], [true, 5, 1], [false, 3, 1], [false, 4, 1], [false, 6, 0]]) {
      const f = legacyFixture(), s = treasureCycleSettings(), entries = []; s.treasure.onlyTenThousand = onlyTenThousand; f.state.targets[0].color = color;
      await legacy(f, s, { report: e => entries.push(e) }); assert.equal(f.client.writes.length, expected, JSON.stringify(entries));
      if (!expected) assert.match(entries[0].reason, /等待/);
    }
    const f = legacyFixture(); small(f);
    await legacy(f, null); assert.equal(f.client.writes.length, 0, '未保存详细设置的旧挂机也只抢万吨');
  }));

  await check('旧挂机发送前重新核对开关和原目标，失效时不会改抢其他目标', () => morning(async () => {
    for (const kind of ['settings', 'quality', 'gone']) {
      const f = legacyFixture(), s = treasureCycleSettings(), entries = []; let reads = 0;
      if (kind === 'settings') { small(f); s.treasure.onlyTenThousand = false; }
      f.beforeRead = name => {
        if (name !== 'TreasureLootListRequest' || ++reads !== 2) return;
        if (kind === 'settings') s.treasure.onlyTenThousand = true;
        if (kind === 'quality') small(f);
        if (kind === 'gone') f.state.targets[0].uid = 73;
      };
      await legacy(f, s, { report: e => entries.push(e) }); assert.equal(reads, 2); assert.equal(f.client.writes.length, 0, JSON.stringify(entries));
      assert.match(entries[0].reason, /变化|等待/);
    }
  }));

  await check('完整挂机旧入口接收账号筛选配置：默认等待，显式关闭才派小船', () => morning(async () => {
    for (const onlyTenThousand of [true, false]) {
      const f = legacyFixture(), s = treasureCycleSettings(), usage = ledger(); small(f);
      Object.assign(s.treasure, { enabled: false, onlyTenThousand, autoRepair: false }); s.schedule.treasureLoot = true;
      const flags = nativeTaskValues(s, {});
      const result = await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
        getSettings: () => s, usageLedger: usage, isEnabled: key => flags[key] === true });
      assert.equal(f.client.writes.length, onlyTenThousand ? 0 : 1, JSON.stringify(result.history));
      if (!onlyTenThousand) assert.equal(f.client.writes[0].body.uid, 72);
    }
  }));

  await check('完整挂机详细入口先等待小船，下一次检查出现万吨后自动派遣', async () => {
    const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
    try {
      const f = treasureCycleFixture(), s = treasureCycleSettings(), usage = ledger(), stop = new AbortController(); small(f); s.treasure.autoRepair = false;
      const start = now; let appeared = false;
      f.beforeSend = name => { if (name === 'TreasureLootSendFleetsRequest') stop.abort(); };
      await runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds: 0, everyMs: 60000, allowMutate: true,
        getSettings: () => s, usageLedger: usage, isEnabled: () => false, stop: stop.signal,
        sleep: async ms => { assert.equal(f.client.writes.length, 0); now += ms; if (!appeared) { appeared = true; addTarget(f, 'ORANGE', 73); } if (now - start > 60000) throw Error('新万吨目标没有在检查间隔后继续派遣'); } });
      assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].body.uid, 73); assert.equal(usage.snapshot().counters.treasureDispatches, 1);
    } finally { Date.now = originalNow; }
  });

  await check('隔离控制台保存与预览保留显式关闭、按账号隔离且不启动挂机', async () => {
    process.env.CW_DATA_DIR = directory;
    const { saveStore, DATA_DIR } = await import('../src/accounts.mjs'); assert.equal(DATA_DIR, directory);
    saveStore({ activeId: '货轮筛选甲', accounts: ['货轮筛选甲', '货轮筛选乙'].map(id => ({ id, label: id, url: 'ws://127.0.0.1:1', login: {}, automation: { enabled: false, paused: true } })) });
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 }); await app.listen();
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const api = async (account, route, body) => { const response = await fetch(origin + route + '?account=' + encodeURIComponent(account), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: response.status, body: await response.json() }; };
    try {
      const initial = (await api('货轮筛选甲', '/api/settings')).body, s = initial.settings;
      Object.assign(s.treasure, { enabled: true, onlyTenThousand: false, fleetIds: ['1远征船'] });
      const saved = await api('货轮筛选甲', '/api/settings', { settings: s, revision: initial.revision, baseRevision: initial.baseRevision }); assert.equal(saved.status, 200);
      assert.equal((await api('货轮筛选甲', '/api/settings')).body.settings.treasure.onlyTenThousand, false);
      assert.equal((await api('货轮筛选乙', '/api/settings')).body.settings.treasure.onlyTenThousand, true);
      const f = treasureCycleFixture(), session = app.sessions.get('货轮筛选甲'); small(f); session.client = f.client; session.player = f.player; session.paused = false;
      let view = await api('货轮筛选甲', '/api/settings/preview', { settings: s, category: 'world' });
      assert.equal(view.status, 200); assert(view.body.actions.some(a => a.kind === 'treasureDispatch'), JSON.stringify(view.body));
      s.treasure.onlyTenThousand = true; view = await api('货轮筛选甲', '/api/settings/preview', { settings: s, category: 'world' });
      assert.equal(view.status, 200); assert.equal(view.body.actions.length, 0); assert.equal(session.loop.running, false); assert.deepEqual(f.client.writes, []);
    } finally { await app.close(); }
  });
} finally {
  const report = { kind: '货轮筛选：真实协议受控数据与隔离接口，未操作真实游戏', total: results.length, passed: results.filter(r => r.passed).length, results };
  const file = path.join(parent, 'result-' + Date.now() + '.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(parent) || !path.basename(resolved).startsWith('run-')) throw Error('临时测试目录边界校验失败，未清理');
  fs.rmSync(resolved, { recursive: true });
  console.log(`货轮筛选专项：${report.passed}/${report.total} 组通过`); console.log(file);
  if (report.passed !== report.total) process.exitCode = 1;
}
