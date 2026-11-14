import assert from 'node:assert/strict';
import { findConfigPack, loadConfig } from '../src/config.mjs';
import { collectEquipmentCraft, readEquipmentCrafting, startEquipmentCraft } from '../src/equipment-crafting.mjs';

const buildingId = '1装备厂';
const player = { level: 17, worldId: 2001001001 };
let accountSerial = 610000;
const blueId = 1001;
const gold = 'GOLD';
const oldUid = { low: 0, high: 2097152, unsigned: false };
const newUid = { low: 1, high: 2097152, unsigned: false };
const now = () => Math.floor(Date.now() / 1000);

const buildingRule = {
  buildingId, buildingType: '装备厂', playerLevel: 17, curPeople: 0, condition: [],
  consume: [['建筑蓝图', 7], ['粗铁', 3], ['墙纸', 2]],
};
const recipes = [
  { makeId: blueId, type: '武器', libId: 1001, seconds: 1800, season: 1, costItem: [['蓝武器材料', 40], [gold, 2000]] },
  { makeId: 1004, type: '武器', libId: 1004, seconds: 43200, season: 2, costItem: [['红武器材料', 800], [gold, 500000]] },
];
const config = {
  tables: {
    BuildingUnlockCfg: { data: [buildingRule] },
    BuildingCfg: { data: [{ buildingType: '装备厂', name: '装备厂' }, { buildingType: '建材厂', name: '建材厂' }] },
    BuildingProduceCfg: { data: [{ buildType: '建材厂', itemId: '墙纸', unlockLevel: 2 }] },
    BuildingEquipMakeCfg: { data: recipes },
    EquipMakeLibCfg: { data: [
      { libId: 1001, equipId: '蓝武器1', rate: 100 }, { libId: 1004, equipId: '红武器1', rate: 100 },
    ] },
    EquipCfg: { data: [
      { id: '蓝武器1', name: '鱼叉枪', type: '武器', quality: 'BLUE', qualityName: '蓝' },
      { id: '红武器1', name: '红色武器', type: '武器', quality: 'RED', qualityName: '红' },
    ] },
  },
  materialName: id => ({ GOLD: '金币', 蓝武器材料: '稀有枪械材料' })[id] || id,
  materialSources: id => id === '蓝武器材料' ? ['击败海盗'] : [],
};

function finishPickup() {
  delete this.building.equipMaking;
  this.equips.push({ uid: newUid, equipId: '蓝武器1', star: 1 });
  return { equipId: '蓝武器1' };
}

function fixture(rules = config) {
  const f = {
    player: { ...player, playerId: ++accountSerial },
    building: { buildingId, level: 1 },
    items: { 建筑蓝图: 8, 粗铁: 3, 墙纸: 1, 蓝武器材料: 40, 红武器材料: 800 },
    gold: 2000,
    equips: [{ uid: oldUid, equipId: '蓝武器1', star: 1 }],
    calls: [], writes: [],
    view(p = this.player) { return readEquipmentCrafting(this, rules, p); },
    start(recipe, options = {}) {
      return startEquipmentCraft(this, rules, this.player, {
        buildingId, makeId: recipe.makeId, previewKey: recipe.previewKey, ...options,
      });
    },
    collect(job, options = {}) {
      return collectEquipmentCraft(this, rules, this.player, { buildingId, previewKey: job.previewKey, ...options });
    },
    async recipe() { return (await this.view()).recipes.find(row => row.makeId === blueId); },
    setJob(finishTime) {
      this.building.equipMaking = { makeId: blueId, finishTime, equipId: '蓝武器1', star: 1 };
    },
    onMake() { this.setJob(now() + 1800); },
    onPick: finishPickup,
    async request(name, body, response) {
      this.calls.push(name);
      switch (name) {
        case 'OnWaterRequest': return { building: [structuredClone(this.building)] };
        case 'AllItemRequest': return { items: Object.entries(this.items).map(([itemId, num]) => ({ itemId, num })) };
        case 'AllResourceRequest': return { list: [{ res: 3, amount: this.gold }] };
        case 'EquipsRequest': return { equip: structuredClone(this.equips) };
        case 'PickMadeEquipRequest':
          assert.equal(response, 'PickMadeEquipResponse');
          assert.deepEqual(body, { buildingId });
          this.writes.push(name);
          return this.onPick();
        default: assert.fail('意外请求 ' + name);
      }
    },
    async sendWatch(name, body) {
      assert.equal(name, 'MakeEquipRequest');
      assert.deepEqual(body, { buildingId, makeId: blueId, universal: false });
      this.writes.push(name);
      this.onMake();
    },
  };
  return f;
}

{
  const f = fixture();
  assert.equal((await f.view({ ...player, level: 16 })).state, 'locked');
  assert.deepEqual(f.calls, []);
  f.building.level = 0;
  const preview = await f.view();
  assert.equal(preview.state, 'unbuilt');
  assert.equal(preview.requiredLevel, 17);
  assert.deepEqual(preview.buildCosts.map(r => [r.id, r.need, r.have]),
    [['建筑蓝图', 7, 8], ['粗铁', 3, 3], ['墙纸', 2, 1]]);
  assert.match(preview.buildCosts.find(row => row.id === '墙纸').sources.join('、'), /建材厂/);
  f.building.buildFinishTime = now() + 100;
  const building = await f.view();
  assert.equal(building.state, 'building');
  assert.equal(building.buildFinishTime, f.building.buildFinishTime);
  assert.deepEqual(f.writes, []);
}

{
  const gated = fixture({ ...config, tables: { ...config.tables, BuildingUnlockCfg: { data: [
    { ...buildingRule, condition: [['1礼堂', 1]] },
  ] } } });
  gated.building.level = 0;
  gated.items.墙纸 = 2;
  const view = await gated.view();
  assert.match(view.reason, /礼堂/);
  assert.ok(view.recipes.every(recipe => !recipe.canStart));
  assert.deepEqual(gated.writes, []);
}

{
  const f = fixture({ ...config, tables: { ...config.tables, BuildingEquipMakeCfg: { data: [] } } });
  f.building.buildFinishTime = now() + 30;
  const view = await f.view();
  assert.equal(view.state, 'building');
  assert.equal(view.buildingId, buildingId);
  assert.deepEqual(view.buildCosts.map(row => [row.id, row.need]), buildingRule.consume);
  assert.deepEqual(view.recipes, []);
}

for (const empty of [{}, { makeId: 0, finishTime: 0, equipId: '', star: 0 }]) {
  const f = fixture();
  f.building.equipMaking = empty;
  const view = await f.view();
  assert.equal(view.state, 'idle');
  assert.equal(view.job, null);
  assert.ok(view.recipes[0].canStart);
}
{
  const f = fixture();
  f.building.equipMaking = { makeId: 0, finishTime: now() + 100 };
  await assert.rejects(f.view(), /队列/);
  assert.deepEqual(f.writes, []);
}

{
  const f = fixture();
  const view = await f.view();
  assert.equal(view.state, 'idle');
  assert.equal(view.season, 1);
  assert.deepEqual(view.recipes.map(r => r.makeId), [blueId]);
  const recipe = view.recipes[0];
  assert.equal(recipe.seconds, 1800);
  assert.equal(recipe.canStart, true);
  assert.deepEqual(recipe.costs.map(r => [r.id, r.need, r.have]), [['蓝武器材料', 40, 40], [gold, 2000, 2000]]);
  assert.deepEqual(recipe.costs[0].sources, ['击败海盗']);
  const later = await f.view({ ...player, worldId: 2002001001 });
  assert.deepEqual(later.recipes.map(r => r.makeId).sort(), [blueId, 1004]);
  assert.deepEqual(f.writes, []);
}

for (const change of [
  f => { f.items.蓝武器材料 = 39; f.items['万能装备材料'] = 100; },
  f => { f.gold--; },
  f => { f.building.auto = true; },
  f => { f.building.level = 0; },
  f => { f.setJob(now() + 60); },
]) {
  const f = fixture();
  const recipe = await f.recipe();
  change(f);
  assert.equal((await f.recipe())?.canStart === true, false);
  await assert.rejects(f.start(recipe));
  assert.deepEqual(f.writes, []);
}

{
  const f = fixture();
  const recipe = await f.recipe();
  await assert.rejects(f.start(recipe, { enabled: () => false }));
  await assert.rejects(f.start(recipe, { buildingId: '1种子厂' }));
  await assert.rejects(f.start(recipe, { previewKey: '过期' }));
  assert.deepEqual(f.writes, []);
  const started = await Promise.allSettled([f.start(recipe), f.start(recipe)]);
  assert.equal(started.filter(r => r.status === 'fulfilled').length, 1);
  const making = await f.view();
  assert.equal(making.state, 'making');
  assert.equal(making.job.makeId, blueId);
  await assert.rejects(f.start(recipe));
  await assert.rejects(f.collect(making.job));
  assert.deepEqual(f.writes, ['MakeEquipRequest']);
}
for (const onMake of [
  () => {},
  function () { this.setJob(now() + 100); this.building.equipMaking.makeId = 1004; },
  () => { throw new Error('服务器拒绝开工'); },
]) {
  const f = fixture();
  f.onMake = onMake;
  const recipe = await f.recipe();
  await assert.rejects(f.start(recipe));
  await assert.rejects(f.start(recipe)); // a lost or empty acknowledgement cannot enable replay
  assert.deepEqual(f.writes, ['MakeEquipRequest']);
}

{
  const f = fixture();
  f.setJob(now() + 60);
  // Server-clock offset affects whether the finished job can be collected.
  assert.equal((await f.view()).state, 'making');
  f.serverClockOffsetMs = 120_000;
  const ready = await f.view();
  assert.equal(ready.state, 'ready');
  await assert.rejects(f.collect(ready.job, { enabled: () => false }));
  await assert.rejects(f.collect(ready.job, { previewKey: '过期' }));
  f.building.equipMaking.finishTime--;
  await assert.rejects(f.collect(ready.job));
  assert.deepEqual(f.writes, []);
  const job = (await f.view()).job;
  const picked = await Promise.allSettled([f.collect(job), f.collect(job)]);
  assert.equal(picked.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.view()).state, 'idle');
  await assert.rejects(f.collect(job));
  assert.deepEqual(f.writes, ['PickMadeEquipRequest']);
}

{
  const f = fixture();
  f.setJob(now() - 1);
  delete f.building.equipMaking.star;
  f.onPick = function () {
    const receipt = finishPickup.call(this);
    this.equips.at(-1).star = 3;
    this.building.equipMaking = {};
    return receipt;
  };
  const job = (await f.view()).job;
  assert.equal(job.star, null);
  assert.match((await f.collect(job)).label, /鱼叉枪.*3\s*星/);
  assert.equal((await f.view()).state, 'idle');
  assert.deepEqual(f.writes, ['PickMadeEquipRequest']);
}

{
  const f = fixture();
  f.setJob(now() - 1);
  const ready = await f.view();
  f.building.auto = true;
  await assert.rejects(f.collect(ready.job));
  assert.equal((await f.view()).job.previewKey, null);
  assert.deepEqual(f.writes, []);
}

for (const onPick of [
  function () { return { equipId: '蓝武器1' }; }, // building still holds the job
  function () { delete this.building.equipMaking; return { equipId: '蓝武器1' }; }, // old item only
  function () { finishPickup.call(this); return { equipId: '红武器1' }; }, // wrong receipt
  function () { const receipt = finishPickup.call(this); this.equips.at(-1).star = 0; return receipt; },
  () => { throw new Error('服务器拒绝领取'); },
]) {
  const f = fixture();
  f.setJob(now() - 1);
  f.onPick = onPick;
  await assert.rejects(f.collect((await f.view()).job));
  assert.deepEqual(f.writes, ['PickMadeEquipRequest']);
}

// If the local client pack is available, also exercise the catalogue without fixture rows.
if (findConfigPack()) {
  const f = fixture(loadConfig());
  const view = await f.view();
  assert.equal(view.buildingId, buildingId);
  const blue = view.recipes.find(r => r.makeId === blueId);
  assert.ok(blue?.canStart);
  assert.equal(blue.costs.find(r => r.id === '蓝武器材料').need, 40);
  assert.equal(blue.costs.find(r => r.id === gold).need, 2000);
}

console.log('equipment crafting ok: construction, recipes, material gates, server-confirmed start and pickup, stale previews and concurrent clicks');
