import assert from 'node:assert/strict';
import { loadProtocol } from '../src/proto.mjs';
import { loadConfig } from '../src/config.mjs';
import { uidText } from '../src/hero-equipment.mjs';
import { petBreedGoldReserve, servicePetBreeding } from '../src/pet-breeding.mjs';
import { readEquipmentCrafting, startEquipmentCraft } from '../src/equipment-crafting.mjs';

const protocol = loadProtocol();
const actual = loadConfig();
const now = () => Math.floor(Date.now() / 1000);
const wire = value => ({ low: Number(BigInt.asIntN(32, value)), high: Number(value >> 32n), unsigned: false });
const roundtrip = (name, body) => {
  try { return protocol[name].decode(protocol[name].encode(body).finish()); }
  catch (error) { throw new Error(name + ' fixture encode/decode: ' + error.message); }
};
let serial = 500;

function fixture() {
  const tables = Object.fromEntries(['BuildingUnlockCfg', 'PetBreedCfg', 'PetSpeciesCfg'].map(name =>
    [name, structuredClone(actual.tables[name])]));
  const f = {
    config: { tables }, protocol, connected: true,
    player: { playerId: ++serial, level: 23, worldId: 2004001001 },
    building: { buildingId: '1宠物培育室', level: 1, petBreed: { breedQ: [], maturePets: [], maxQLength: 2 } },
    gold: 1_500_000,
    items: Object.fromEntries(tables.PetBreedCfg.data.map(row => [row.cost[0][0], 5000])),
    pets: [], nextUid: 9007199254740992n,
    settings: { petCollect: true, petBreed: true }, deadlines: new Map(), reports: [], calls: [], writes: [],
    async run(options = {}) {
      return servicePetBreeding(this, this.protocol, this.config, {
        player: this.player, enabled: key => this.settings[key], report: entry => this.reports.push(entry),
        scheduler: this.scheduler, ...options,
      });
    },
    setMature(petId = '蓝宠物1', star = 0) { this.building.petBreed.maturePets.push({ petId, star }); },
    addPet(petId = '蓝宠物1', star = 0) {
      this.pets.push({ uid: wire(this.nextUid++), petId, star, level: 1 });
    },
    setJob({ petId = '蓝宠物1', idx = 0, finishTime = now() + 500, star } = {}) {
      this.building.petBreed.breedQ.push({ petId, idx, startTime: now() - 100, finishTime, ...(star == null ? {} : { star }) });
    },
    async request(name, body, response) {
      this.calls.push(name);
      assert.equal(response, name.replace('Request', 'Response'));
      await this.beforeRead?.(name);
      if (this.badRead === name) return {};
      let result;
      if (name === 'OnWaterRequest') result = { building: [this.building, ...(this.equipment ? [this.equipment] : [])] };
      else if (name === 'AllPetRequest') result = { pets: this.pets };
      else if (name === 'AllItemRequest') result = { items: Object.entries(this.items).map(([itemId, num]) => ({ itemId, num })) };
      else if (name === 'AllResourceRequest') result = { list: [{ res: 3, amount: this.reportedGold ?? this.gold }] };
      else assert.fail('意外读取 ' + name);
      return roundtrip(response, result);
    },
    async sendWatch(name, body) {
      assert(['GetMaturePetRequest', 'PetBreedRequest', 'MakeEquipRequest'].includes(name), '不能使用投喂/加速或购买接口');
      if (name !== 'MakeEquipRequest') assert(this.settings[name === 'GetMaturePetRequest' ? 'petCollect' : 'petBreed']);
      const decoded = roundtrip(name, body);
      this.writes.push({ name, body });
      await this.beforeWrite?.(name);
      if (this.reject) throw Object.assign(new Error('服务器拒绝'), { prompt: {}, request: name });
      if (this.unknown) throw new Error('连接中断');
      if (this.silent) return { sent: 1 };
      if (name === 'MakeEquipRequest') {
        const recipe = this.config.tables.BuildingEquipMakeCfg.data.find(row => row.makeId === body.makeId);
        this.gold -= recipe.costItem.find(([id]) => id === 'GOLD')[1];
        this.equipment.equipMaking = { makeId: body.makeId, finishTime: now() + recipe.seconds };
      } else if (name === 'GetMaturePetRequest') {
        if (!this.noPickup) for (const pet of this.building.petBreed.maturePets) this.addPet(pet.petId, pet.star);
        if (!this.noClear) this.building.petBreed.maturePets = [];
      } else {
        assert.equal(decoded.universal, false);
        assert.deepEqual(body, { petId: body.petId, universal: false });
        const recipe = this.config.tables.PetBreedCfg.data.find(row => row.petId === body.petId);
        assert.notEqual(recipe.quality, 'RED');
        assert(this.gold - recipe.cost[1][1] >= petBreedGoldReserve);
        if (!this.staleStock) {
          this.items[recipe.cost[0][0]] -= recipe.cost[0][1];
          this.gold -= recipe.cost[1][1];
        }
        if (!this.noQueue) this.setJob({ petId: body.petId, idx: Math.max(-1, ...this.building.petBreed.breedQ.map(job => job.idx)) + 1,
          finishTime: now() + recipe.breedTime });
      }
      await this.afterWrite?.(name);
      return { sent: 1 };
    },
  };
  f.scheduler = {
    due: key => !(f.deadlines.get(key) > now()),
    defer: (key, until) => f.deadlines.set(key, until),
  };
  return f;
}

function withEquipment(f) {
  f.equipment = { buildingId: '1装备厂', level: 1 };
  for (const name of ['BuildingEquipMakeCfg', 'EquipCfg', 'BuildingCfg']) f.config.tables[name] = actual.tables[name];
  f.items.紫武器材料 = 160; f.items.蓝武器材料 = 40;
  f.startEquipment = async function (makeId = 1002, goldReserve = 10000) {
    const preview = await readEquipmentCrafting(this, this.config, this.player);
    const recipe = preview.recipes.find(row => row.makeId === makeId);
    return startEquipmentCraft(this, this.config, this.player, {
      buildingId: '1装备厂', makeId, previewKey: recipe.previewKey, goldReserve,
    });
  };
  return f;
}

export async function testPetBreeding() {
  assert.equal(petBreedGoldReserve, 10000);
  assert(!protocol.PetBreedResponse && !protocol.GetMaturePetResponse);
  assert(actual.tables.BuildingUnlockCfg.data.some(row => row.buildingType === '宠物培育室' && row.playerLevel === 23));

  const disabled = fixture();
  await servicePetBreeding(disabled, protocol, disabled.config, { player: disabled.player });
  assert.equal(disabled.calls.length, 0);
  const locked = fixture(); locked.player.level = 1;
  await locked.run();
  assert.equal(locked.calls.length, 0);
  assert.deepEqual(locked.reports.map(row => [row.key, row.skipped]), [['petCollect', true], ['petBreed', true]]);

  const base = fixture();
  await base.run();
  assert.deepEqual(base.writes, [{ name: 'PetBreedRequest', body: { petId: '橙宠物1', universal: false } }]);
  assert.equal(base.gold, 1250000);
  assert.equal(base.building.petBreed.breedQ.length, 1, '每轮最多开一只，即使还有空位');
  assert(base.reports.some(row => row.key === 'petBreed' && row.ok));

  const season = fixture(); season.player.worldId = 2001001001;
  season.items = { 宠物5橙基因: 5000, 宠物6橙基因: 5000, 宠物1紫基因: 5000 };
  await season.run();
  assert.equal(season.writes[0].body.petId, '紫宠物1', '排除后续赛季物种和配方');

  const pickup = fixture(); pickup.setMature(); pickup.addPet();
  await pickup.run();
  assert.deepEqual(pickup.writes.map(row => row.name), ['GetMaturePetRequest', 'PetBreedRequest']);
  assert.deepEqual(pickup.pets.map(pet => uidText(pet.uid)), ['9007199254740992', '9007199254740993']);
  assert.equal(pickup.reports.filter(row => row.ok).length, 2, '收取必须证明新UID入库后才续产');

  const multiple = fixture(); multiple.setMature(); multiple.setMature('紫宠物2', 2);
  multiple.settings.petBreed = false;
  await multiple.run();
  assert.equal(multiple.writes.length, 1);
  assert.match(multiple.reports.find(row => row.ok).label, /2 只/);

  const finished = fixture(); finished.setJob({ finishTime: now() - 1 });
  await finished.run();
  assert.equal(finished.writes.length, 0, '到点但尚未移入成熟列表不能领取或占新队列');
  assert(finished.reports.every(row => /移入成熟/.test(row.reason)));
  const full = fixture(); full.building.petBreed.maxQLength = 1; full.setJob();
  await full.run(); assert.equal(full.writes.length, 0);
  assert.equal(full.deadlines.get('petBreed'), full.building.petBreed.breedQ[0].finishTime);
  const zero = fixture(); zero.building.petBreed.maxQLength = 0;
  await zero.run(); assert.equal(zero.writes.length, 0);
  const gameAuto = fixture(); gameAuto.building.auto = true; gameAuto.setMature();
  await gameAuto.run(); assert.equal(gameAuto.writes.length, 0);

  for (const key of ['petCollect', 'petBreed']) {
    const f = fixture(); f.setMature(); f.deadlines.set(key, now() + 500);
    await f.run();
    assert.deepEqual(f.writes.map(row => row.name), key === 'petBreed' ? ['GetMaturePetRequest'] : []);
  }

  const low = fixture(); low.gold = 13999;
  await low.run(); assert.equal(low.writes.length, 0);
  const exact = fixture(); exact.gold = 14000;
  await exact.run(); assert.equal(exact.writes[0].body.petId, '蓝宠物1'); assert.equal(exact.gold, 10000);
  const changed = fixture(); let reads = 0;
  changed.beforeRead = name => { if (name === 'AllResourceRequest' && ++reads === 2) changed.gold = 259999; };
  await changed.run(); assert.equal(changed.writes.length, 0, '执行前余额变化不回退盲发另一个配方');
  assert(changed.reports.some(row => /余额已变化/.test(row.reason)));

  for (const table of ['BuildingUnlockCfg', 'PetBreedCfg', 'PetSpeciesCfg']) {
    const f = fixture(); delete f.config.tables[table];
    await f.run(); assert.equal(f.writes.length, 0); assert(f.reports.some(row => row.ok === false));
  }
  for (const name of ['AllItemRequest', 'AllResourceRequest', 'AllPetRequest', 'OnWaterRequest']) {
    const f = fixture(); f.badRead = name;
    await f.run(); assert.equal(f.writes.length, 0); assert(f.reports.some(row => row.ok === false));
  }
  const universal = fixture(); universal.items = { 万能基因: 999999 };
  await universal.run(); assert.equal(universal.writes.length, 0);
  const wrongRecipe = fixture(); wrongRecipe.config.tables.PetBreedCfg.data[0].cost[0][0] = '万能基因';
  await wrongRecipe.run(); assert.equal(wrongRecipe.writes.length, 0);

  for (const change of [f => { f.settings = {}; }, f => { f.connected = false; }, f => { f.player.playerId++; }, f => { f.player.worldId++; }]) {
    const f = fixture(); f.beforeRead = name => { if (name === 'AllPetRequest') change(f); };
    await f.run(); assert.equal(f.writes.length, 0);
  }
  const cancelAfterPickup = fixture(); cancelAfterPickup.setMature();
  cancelAfterPickup.beforeWrite = name => { if (name === 'GetMaturePetRequest') cancelAfterPickup.settings.petBreed = false; };
  await cancelAfterPickup.run(); assert.deepEqual(cancelAfterPickup.writes.map(row => row.name), ['GetMaturePetRequest']);

  for (const flag of ['silent', 'unknown', 'noPickup', 'noClear']) {
    const f = fixture(); f.setMature(); f[flag] = true;
    await f.run(); assert.equal(f.writes.length, 1);
    f.deadlines.clear(); await f.run(); assert.equal(f.writes.length, 1, '未知收取不能重发或继续培育');
    const reconnected = Object.create(f); f.deadlines.clear();
    await reconnected.run(); assert.equal(f.writes.length, 1, '换连接不能清除账号未知操作');
    const other = fixture(); await other.run(); assert.equal(other.writes.length, 1, '一个账号的未知操作不阻塞其他账号');
  }
  for (const flag of ['silent', 'unknown', 'noQueue']) {
    const f = fixture(); f[flag] = true;
    await f.run(); assert.equal(f.writes.length, 1);
    f.deadlines.clear(); await f.run(); assert.equal(f.writes.length, 1, '未知培育不能重复花余额');
  }
  const replenished = fixture();
  replenished.afterWrite = name => {
    if (name === 'PetBreedRequest') { replenished.gold += 500000; replenished.items.宠物1橙基因 += 1600; }
  };
  await replenished.run(); replenished.deadlines.clear(); await replenished.run();
  assert.equal(replenished.writes.length, 2, '队列确认后读取的新库存即使增长也允许下一次培育');
  const late = fixture(); late.unknown = true;
  await late.run();
  late.unknown = false;
  late.setJob({ petId: '橙宠物1' }); late.gold -= 250000; late.items.宠物1橙基因 -= 800;
  late.deadlines.clear(); await late.run();
  assert.equal(late.writes.length, 1);
  assert(late.reports.some(row => /已核对上次/.test(row.reason)));
  late.deadlines.clear(); await late.run(); assert.equal(late.writes.length, 2, '对账之后下一轮可以继续');

  const refused = fixture(); refused.reject = true;
  await refused.run(); refused.reject = false; refused.deadlines.clear();
  await refused.run(); assert.equal(refused.writes.length, 2, '明确服务端拒绝可重新读状态后重试');
  const concurrent = fixture();
  await Promise.all([concurrent.run(), Object.create(concurrent).run()]);
  assert.equal(concurrent.writes.length, 1, '同账号跨连接并发也不重复');

  // Queue evidence followed by a complete balance allows new income to be used.
  const equipmentFirst = withEquipment(fixture());
  equipmentFirst.gold = 20000;
  equipmentFirst.afterWrite = name => { if (name === 'MakeEquipRequest') equipmentFirst.gold += 10000; };
  await equipmentFirst.startEquipment();
  assert.equal(equipmentFirst.gold, 20000);
  await equipmentFirst.run();
  assert.equal(equipmentFirst.writes.length, 2, '装备完成确认后，新增金币可继续用于培育');
  const newConnection = Object.create(equipmentFirst);
  newConnection.deadlines.clear(); await newConnection.run();
  assert.equal(equipmentFirst.writes.length, 3, '换连接后仍可使用已确认的新余额');
  const floor = withEquipment(fixture()); floor.gold = 20000;
  await floor.startEquipment(); await floor.run();
  assert.equal(floor.writes.length, 1, '业务已确认仍不能击穿一万金币保留量');
  floor.gold = 14000; floor.deadlines.clear(); await floor.run();
  assert.equal(floor.writes.length, 2); assert.equal(floor.gold, 10000);

  // The reverse order uses the new balance and still enforces each caller's floor.
  const petFirst = withEquipment(fixture()); petFirst.gold = 20000;
  await petFirst.run();
  assert.equal(petFirst.gold, 16000);
  await assert.rejects(petFirst.startEquipment(), /保留至少/);
  assert.equal(petFirst.writes.length, 1);
  const independent = withEquipment(fixture()); independent.gold = 20000;
  await independent.startEquipment(); assert.equal(independent.writes.length, 1, '账号之间不共享金币屏障');
  const otherWorld = withEquipment(fixture()); otherWorld.player.playerId = petFirst.player.playerId;
  otherWorld.player.worldId = 2001001001; otherWorld.gold = 20000;
  await otherWorld.startEquipment(); assert.equal(otherWorld.writes.length, 1, '同ID不同区服不共享金币屏障');
  await petFirst.startEquipment(1001);
  assert.equal(petFirst.gold, 14000, '余额同步后装备制造可继续');

  const refusal = withEquipment(fixture()); refusal.gold = 20000; refusal.reject = true;
  await assert.rejects(refusal.startEquipment(), /拒绝/);
  refusal.reject = false; await refusal.run();
  assert.equal(refusal.writes.length, 2, '明确对应的拒绝解除金币预占');
  const unknownEquip = withEquipment(fixture()); unknownEquip.gold = 20000; unknownEquip.unknown = true;
  await assert.rejects(unknownEquip.startEquipment(), /连接中断/);
  unknownEquip.unknown = false; unknownEquip.setMature(); unknownEquip.settings.petBreed = false;
  await unknownEquip.run();
  assert.equal(unknownEquip.writes.at(-1).name, 'GetMaturePetRequest', '未确认金币不妨碍领取成熟海兽');
  const manual = withEquipment(fixture()); manual.gold = 10000;
  await manual.startEquipment(1002, 0);
  assert.equal(manual.gold, 0, '手动goldReserve=0仍允许花到0');
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testPetBreeding();
  console.log('pet breeding ok: real protocol responses, queue/mature transitions, exact UIDs, season/quality/budget, cancellation, independent cooldown and unknown outcomes');
}
