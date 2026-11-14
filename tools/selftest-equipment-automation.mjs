import assert from 'node:assert/strict';
import { equipmentCraftGoldReserve, serviceEquipmentCrafting } from '../src/equipment-automation.mjs';

const buildingId = '1装备厂';
const now = () => Math.floor(Date.now() / 1000);
const player = { level: 17, worldId: 2001001001 };
let accountSerial = 620000;
const types = ['武器', '防具', '饰品'];
const recipes = types.flatMap((type, index) => [2, 3].map(quality => ({
  makeId: (index + 1) * 1000 + quality, type, libId: (index + 1) * 1000 + quality,
  seconds: quality * 100, season: 1,
  costItem: [[type + quality + '材料', quality * 10], ['GOLD', quality === 2 ? 2000 : 10000]],
})));
const config = {
  tables: {
    BuildingUnlockCfg: { data: [{ buildingId, buildingType: '装备厂', playerLevel: 17, consume: [['建筑蓝图', 1]] }] },
    BuildingEquipMakeCfg: { data: recipes },
    EquipMakeLibCfg: { data: recipes.map(row => ({ libId: row.libId, equipId: row.type + (row.makeId % 1000), rate: 100 })) },
    EquipCfg: { data: recipes.map(row => ({ id: row.type + (row.makeId % 1000), name: row.type + (row.makeId % 1000),
      type: row.type, qualityIndex: row.makeId % 1000 })) },
  },
  materialName: id => id,
};

function fixture(rules = structuredClone(config.tables)) {
  const f = {
    config: { ...config, tables: rules }, player: { ...player, playerId: ++accountSerial },
    building: { buildingId, level: 1 }, gold: 100_000,
    items: Object.fromEntries([['建筑蓝图', 2], ...recipes.map(row => [row.costItem[0][0], 1000])]),
    equips: [], heroes: [], serial: 1, calls: [], writes: [], reports: [],
    settings: { equipmentCollect: true, equipmentCraft: true },
    deadlines: new Map(), deferrals: [],
    makeJob(makeId = 1002, finishTime = now() - 1) {
      const row = recipes.find(recipe => recipe.makeId === makeId);
      this.building.equipMaking = { makeId, finishTime, equipId: row.type + (row.makeId % 1000), star: 1 };
    },
    addEquip(type = '武器', quality = 2) {
      this.equips.push({ uid: String(this.serial++), equipId: type + quality, star: 1 });
    },
    async run(options = {}) {
      return serviceEquipmentCrafting(this, this.config, {
        player: this.player,
        enabled: key => this.settings[key] && this.scheduler.due(key),
        report: entry => this.reports.push(entry), scheduler: this.scheduler, ...options,
      });
    },
    async request(name, body, response) {
      this.calls.push(name);
      await this.beforeRequest?.(name);
      switch (name) {
        case 'OnWaterRequest': return { building: [structuredClone(this.building)] };
        case 'AllItemRequest': return { items: Object.entries(this.items).map(([itemId, num]) => ({ itemId, num })) };
        case 'AllResourceRequest': return { list: [{ res: 3, amount: this.gold }] };
        case 'EquipsRequest': return { equip: structuredClone(this.equips) };
        case 'AllHeroRequest': return { heroes: structuredClone(this.heroes) };
        case 'PickMadeEquipRequest': {
          assert.equal(response, 'PickMadeEquipResponse');
          assert.deepEqual(body, { buildingId });
          this.writes.push({ name, body });
          const job = this.building.equipMaking;
          if (this.pickFailure) throw new Error('领取回包丢失');
          if (!this.leaveJob) delete this.building.equipMaking;
          if (!this.missingPickup) this.equips.push({ uid: String(this.serial++), equipId: job.equipId, star: job.star });
          return { equipId: job.equipId };
        }
        default: assert.fail('意外请求 ' + name);
      }
    },
    async sendWatch(name, body) {
      assert.equal(name, 'MakeEquipRequest');
      const recipe = recipes.find(row => row.makeId === body.makeId);
      assert.deepEqual(body, { buildingId, makeId: recipe.makeId, universal: false });
      assert.ok(this.settings.equipmentCraft);
      const cost = recipe.costItem.find(([id]) => id === 'GOLD')[1];
      assert.ok(this.gold - cost >= equipmentCraftGoldReserve, '写请求必须保留金币');
      this.writes.push({ name, body });
      if (this.makeFailure) throw new Error('制造回包丢失');
      if (!this.missingStart) {
        this.gold -= cost;
        this.items[recipe.costItem[0][0]] -= recipe.costItem[0][1];
        this.makeJob(recipe.makeId, now() + recipe.seconds);
      }
    },
  };
  f.scheduler = {
    due: key => !(f.deadlines.get(key) > now()),
    defer(key, until) {
      f.deferrals.push({ key, until, writes: f.writes.length });
      f.deadlines.set(key, until);
    },
  };
  return f;
}

assert.equal(equipmentCraftGoldReserve, 10000);

// Disabled by default, without any reads or writes.
{
  const f = fixture();
  await serviceEquipmentCrafting(f, f.config, { player });
  assert.deepEqual(f.calls, []);
  f.settings = {};
  await f.run();
  assert.deepEqual(f.calls, []);
}

// Balance equipment types before quality, then choose the highest affordable tier.
{
  const f = fixture();
  f.addEquip('武器'); f.addEquip('饰品');
  await f.run();
  assert.deepEqual(f.writes.map(row => [row.name, row.body.makeId]), [['MakeEquipRequest', 2003]]);
  assert.ok(f.reports.some(row => row.key === 'equipmentCraft' && row.ok && /10,000/.test(row.label)));
  assert.equal(f.gold, 90000);
}
{
  const f = fixture();
  f.items['武器3材料'] = 0;
  f.addEquip('防具'); f.addEquip('饰品');
  await f.run();
  assert.equal(f.writes[0].body.makeId, 1002, '稀少部位优先于其他部位更高品质');
}
{
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    f.addEquip('武器');
    f.heroes.push({ heroId: '英雄' + i, equips: [{ uid: f.equips.at(-1).uid }] });
  }
  f.addEquip('防具'); f.addEquip('饰品');
  await f.run();
  assert.equal(f.writes[0].body.makeId, 1003, '已穿戴的装备不计入闲置库存');
}

// Collect and restart in one round; the collected type is counted on the fresh read.
{
  const f = fixture();
  f.makeJob(); f.addEquip('饰品');
  await f.run();
  assert.deepEqual(f.writes.map(row => [row.name, row.body.makeId]),
    [['PickMadeEquipRequest', undefined], ['MakeEquipRequest', 2003]]);
  assert.equal(f.equips.length, 2);
  assert.equal(f.reports.filter(row => row.ok).length, 2);
  assert.ok(f.deferrals.length > 0);
  assert.ok(f.deferrals.every(row => row.writes === 2), '调度延后不能提前禁用后续动作');
}
{
  const f = fixture();
  f.makeJob(); f.settings.equipmentCraft = false;
  await f.run();
  assert.deepEqual(f.writes.map(row => row.name), ['PickMadeEquipRequest']);
}
{
  const f = fixture();
  f.makeJob(); f.settings.equipmentCollect = false;
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.ok(f.reports.some(row => row.skipped));
}

// Ongoing production waits for the server finish time; separate calls respect cooldown.
{
  const f = fixture();
  f.makeJob(1002, now() + 500);
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.equal(f.deadlines.get('equipmentCraft'), f.building.equipMaking.finishTime);
  const reads = f.calls.length;
  await f.run();
  assert.equal(f.calls.length, reads);
}
for (const deferred of ['equipmentCollect', 'equipmentCraft']) {
  const f = fixture(); f.makeJob();
  f.deadlines.set(deferred, now() + 500);
  await f.run({ enabled: key => f.settings[key] });
  assert.deepEqual(f.writes.map(row => row.name), deferred === 'equipmentCraft' ? ['PickMadeEquipRequest'] : [],
    '一个开关到期不能带动另一个未到期的开关');
}
{
  const f = fixture();
  await f.run({ scheduler: undefined });
  assert.deepEqual(f.writes.map(row => row.name), ['MakeEquipRequest']);
}

// Preserve the budget even if a formerly affordable preview changes before write.
for (const gold of [11999, 10000, 0]) {
  const f = fixture(); f.gold = gold;
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.ok(f.reports.some(row => row.key === 'equipmentCraft' && row.skipped));
}
{
  const f = fixture(); f.gold = 12000;
  await f.run();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.makeId, 1002);
  assert.equal(f.gold, 10000);
}
{
  const f = fixture();
  let reads = 0;
  f.beforeRequest = name => { if (name === 'AllResourceRequest' && ++reads === 2) f.gold = 19999; };
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.ok(f.reports.some(row => row.ok === false && /保留/.test(row.error)));
}

// Missing configuration or uncertain inventory must not choose a fallback recipe.
for (const table of ['BuildingUnlockCfg', 'BuildingEquipMakeCfg', 'EquipMakeLibCfg', 'EquipCfg']) {
  const f = fixture(); delete f.config.tables[table];
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.ok(f.reports.some(row => row.ok === false));
}
for (const mutate of [
  f => { f.config.tables.EquipCfg.data[0].qualityIndex = undefined; },
  f => { f.equips = [{ uid: '1', equipId: '未知装备' }]; },
  f => { f.addEquip(); f.equips.push({ ...f.equips[0] }); },
  f => { f.config.tables.EquipMakeLibCfg.data[0].rate = 0; },
  f => { f.heroes = undefined; },
  f => { f.heroes = [{ heroId: '英雄', equips: [{ uid: '99' }] }]; },
  f => { f.addEquip(); f.heroes = [{ equips: [{ uid: '1' }, { uid: '1' }] }]; },
  f => { f.heroes = [{ equips: {} }]; },
]) {
  const f = fixture(); mutate(f);
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.ok(f.reports.some(row => row.ok === false));
}

// Changes made while reads are in flight are checked again at the write boundary.
for (const name of ['EquipsRequest', 'AllResourceRequest']) {
  const f = fixture();
  f.beforeRequest = request => { if (request === name) f.settings.equipmentCraft = false; };
  await f.run();
  assert.deepEqual(f.writes, []);
}
{
  const f = fixture(); f.makeJob();
  f.beforeRequest = request => { if (request === 'EquipsRequest') f.settings = {}; };
  await f.run();
  assert.deepEqual(f.writes, []);
}
{
  const f = fixture(); f.makeJob();
  f.beforeRequest = request => { if (request === 'PickMadeEquipRequest') f.settings.equipmentCraft = false; };
  await f.run();
  assert.deepEqual(f.writes.map(row => row.name), ['PickMadeEquipRequest']);
}
{
  const f = fixture(); f.building.auto = true; f.makeJob();
  await f.run();
  assert.deepEqual(f.writes, []);
}

// Do not follow a failed or unconfirmed pickup with another write, or retry a failed start.
for (const flag of ['pickFailure', 'missingPickup', 'leaveJob']) {
  const f = fixture(); f.makeJob(); f[flag] = true;
  await f.run();
  assert.deepEqual(f.writes.map(row => row.name), ['PickMadeEquipRequest']);
  assert.ok(f.reports.some(row => row.key === 'equipmentCollect' && row.ok === false));
}
for (const flag of ['makeFailure', 'missingStart']) {
  const f = fixture(); f[flag] = true;
  await f.run();
  assert.deepEqual(f.writes.map(row => row.name), ['MakeEquipRequest']);
  assert.ok(f.reports.some(row => row.key === 'equipmentCraft' && row.ok === false));
}

// Parallel invocations cannot duplicate collection or start in a single factory.
{
  const f = fixture();
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.writes.length, 1);
}

console.log('equipment automation ok: pickup/restart, balanced types and quality, budget recheck, cooldown, pause, missing data and failed-write isolation');
