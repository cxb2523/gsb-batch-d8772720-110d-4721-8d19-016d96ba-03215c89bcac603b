// 新旧金币消费者的互通回归：隔离虚构角色、临时账本和真实协议编解码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import { loadConfig } from '../src/config.mjs';
import { readEquipmentCrafting, startEquipmentCraft } from '../src/equipment-crafting.mjs';
import { runEquipmentForge } from '../src/equipment-forge.mjs';
import { runBaseAutomation } from '../src/base-automation.mjs';
import { servicePetBreeding } from '../src/pet-breeding.mjs';
import { reserveGold } from '../src/gold-reservations.mjs';
import { beginOrderMaterialSpend, confirmOrderMaterialSpends, cancelOrderMaterialSpend } from '../src/order-reservations.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-migration-'));
const actual = loadConfig(), results = [];
let sequence = 0;
const ledger = () => createUsageLedger('模拟资源账号', { file: path.join(directory, `usage-${++sequence}.json`) });
const encode = (f, name, value) => f.protocol[name].decode(f.protocol[name].encode(value).finish());
function fixture() {
  const f = warForgeFixture();
  f.config.tables.BuildingUnlockCfg.data.find(row => row.buildingType === '装备厂').consume = [['GOLD', 1]];
  f.config.tables.BuildingUnlockCfg.data.push({ buildingId: '1宠物培育室', buildingType: '宠物培育室', playerLevel: 23 });
  for (const name of ['PetBreedCfg', 'PetSpeciesCfg', 'BuildingUpgradeCfg']) f.config.tables[name] = actual.tables[name];
  f.recipe = actual.tables.PetBreedCfg.data.find(row => row.spId === 1 && row.quality === 'BLUE');
  f.room = { buildingId: '1宠物培育室', level: 3, petBreed: { maxQLength: 3, breedQ: [], maturePets: [] } };
  f.state.buildings.push(f.room);
  f.state.gold = 1000000;
  f.state.materials[f.recipe.cost[0][0]] = 1000;
  const read = f.client.request, send = f.client.sendWatch;
  f.client.request = async (name, body, response) => {
    if (name === 'AllPetRequest') return encode(f, 'AllPetResponse', { pets: [] });
    const reply = await read(name, body, response);
    if (name === 'AllResourceRequest' && f.reportedGold != null) return encode(f, 'AllResourceResponse', { list: [{ res: 3, amount: f.reportedGold }] });
    return reply;
  };
  f.client.sendWatch = async (name, body, options) => {
    if (name !== 'PetBreedRequest') { const result = await send(name, body, options); f.state.gold += f.replenishGold ?? 0; return result; }
    encode(f, name, body); f.client.writes.push({ name, body });
    if (f.petReject) throw Object.assign(new Error('模拟明确拒绝'), { prompt: {}, request: name });
    if (f.petUnknown) throw new Error('模拟连接中断');
    f.room.petBreed.breedQ.push({ idx: f.room.petBreed.breedQ.length + 1, petId: body.petId, startTime: Math.floor(Date.now()/1000), finishTime: Math.floor(Date.now()/1000) + 3600 });
    if (!f.petStale) for (const [id, amount] of f.recipe.cost) {
      if (id === 'GOLD') f.state.gold -= amount;
      else f.state.materials[id] -= amount;
    }
    f.state.gold += f.replenishGold ?? 0;
  };
  f.oldCraft = async () => {
    const view = await readEquipmentCrafting(f.client, f.config, f.player);
    const recipe = view.recipes.find(row => row.makeId === 1001);
    return startEquipmentCraft(f.client, f.config, f.player, { buildingId: view.buildingId, makeId: 1001, previewKey: recipe.previewKey });
  };
  // Runners compare settings object identity across awaits.
  const forgeSettings = warForgeSettings();
  f.forge = (u = ledger()) => runEquipmentForge(f.client, f.protocol, f.config, f.player, { ledger: u, getSettings: () => forgeSettings });
  const petSettings = defaultSettings(); petSettings.loop.world = true; petSettings.pet.enabled = petSettings.pet.breed = true;
  f.basePet = (u = ledger()) => runBaseAutomation(f.client, f.protocol, f.config, { actions: [{
    kind: 'petBreed', scope: 'base', setting: 'pet.breed', request: 'PetBreedRequest', body: { petId: f.recipe.petId, universal: false },
    costs: f.recipe.cost.map(([id, num]) => ({ id, num })), verify: { queueBefore: f.room.petBreed.breedQ.length },
  }] }, { player: f.player, ledger: u, getSettings: () => petSettings });
  f.oldPet = async () => {
    const reports = [];
    await servicePetBreeding(f.client, f.protocol, f.config, { player: f.player, enabled: key => key === 'petBreed', report: row => reports.push(row) });
    return reports;
  };
  return f;
}
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
}

await check('旧装备成功并回读完整金币后，收入增长不阻止新锻造和新海兽', async () => {
  const f = fixture(); f.replenishGold = 5000;
  await f.oldCraft(); f.state.factory.equipMaking = null;
  assert.equal((await f.forge()).results[0].status, 'confirmed');
  assert.equal((await f.basePet())[0].ok, true);
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'MakeEquipRequest', 'PetBreedRequest']);
});

await check('新锻造确认队列且金币回涨时，旧装备和旧海兽可使用新余额', async () => {
  const f = fixture(); f.replenishGold = 5000;
  assert.equal((await f.forge()).results[0].status, 'confirmed');
  f.state.factory.equipMaking = null;
  await f.oldCraft();
  assert((await f.oldPet()).some(row => row.ok));
  assert.equal(f.client.writes.length, 3);
});

await check('新海兽确认队列且金币回涨后，旧装备和旧海兽仍可继续', async () => {
  const f = fixture(); f.replenishGold = 5000;
  assert.equal((await f.basePet())[0].ok, true);
  await f.oldCraft();
  assert((await f.oldPet()).some(row => row.ok));
  assert.equal(f.client.writes.length, 3);
});

await check('旧海兽结果未知时阻止新锻造，身份和区服隔离', async () => {
  const f = fixture(); f.petUnknown = true;
  assert((await f.oldPet()).some(row => /连接中断/.test(row.error)));
  assert((await f.forge()).results.some(row => row.skipped)); assert.equal(f.client.writes.length, 1);
  const other = fixture(); assert.equal((await other.forge()).results[0].status, 'confirmed');
  const differentWorld = { ...f.player, worldId: 2001001001 };
  reserveGold(differentWorld, 1000000, 1, 'MakeEquipRequest');
});

await check('新锻造明确拒绝释放共享金币，未知结果保留', async () => {
  const rejected = fixture(); rejected.reject = true;
  assert.equal((await rejected.forge()).results[0].status, 'rejected');
  rejected.reject = false; await rejected.oldCraft(); assert.equal(rejected.client.writes.length, 2);
  const unknown = fixture(); unknown.unknown = true;
  assert.equal((await unknown.forge()).results[0].status, 'unknown');
  unknown.unknown = false; await assert.rejects(unknown.oldCraft, /金币扣款尚未同步/);
  assert.equal(unknown.client.writes.length, 1);
});

await check('新海兽明确拒绝释放共享金币，未知结果保留', async () => {
  const rejected = fixture(); rejected.petReject = true;
  assert.equal((await rejected.basePet())[0].ok, false);
  rejected.petReject = false; await rejected.oldCraft(); assert.equal(rejected.client.writes.length, 2);
  const unknown = fixture(); unknown.petUnknown = true;
  assert.equal((await unknown.basePet())[0].ok, false);
  await assert.rejects(unknown.oldCraft, /金币扣款尚未同步/); assert.equal(unknown.client.writes.length, 1);
});

await check('guard 保持账本票据契约，只接受未发送或同请求拒绝的取消证据', async () => {
  const f = fixture(), settings = defaultSettings(), usage = ledger();
  const guard = createActionGuard(f.client, () => settings, usage, { player: f.player });
  const step = { request: 'PetBreedRequest', body: { petId: f.recipe.petId }, costs: [{ id: 'GOLD', num: 100 }], counters: { goldPaidTimes: 1 } };
  const ticket = await guard.before(step); assert(ticket); assert.equal(usage.snapshot().counters.goldPaidTimes, 1);
  await guard.cancel(step, ticket, { error: new Error('结果未知') });
  assert.equal(usage.snapshot().counters.goldPaidTimes, 1); await assert.rejects(f.oldCraft, /金币扣款尚未同步/);
  await guard.cancel(step, ticket, { error: { prompt: {}, request: 'OtherRequest' } });
  await assert.rejects(f.oldCraft, /金币扣款尚未同步/);
  await guard.cancel({ ...step, kind: 'daily' }, ticket, { notSent: true });
  assert.equal(usage.snapshot().counters.goldPaidTimes, 0); await f.oldCraft();
});

await check('无详细设置的 guard 仍遵守金币屏障，暂停复核未发送时释放', async () => {
  const f = fixture();
  reserveGold(f.player, f.state.gold, 1, 'MakeEquipRequest');
  const guard = createActionGuard(f.client, () => null, null, { player: f.player });
  const step = { request: 'PetBreedRequest', costs: [{ id: 'GOLD', num: 100 }] };
  await assert.rejects(() => guard.before(step), /金币扣款尚未同步/);
  f.state.gold--; const ticket = await guard.before(step); assert(ticket, '无日用量计数的消费仍返回独立操作票据');
  await guard.cancel({ ...step }, ticket, { notSent: true }); await f.oldCraft();
  const paused = fixture(); let reads = 0;
  const original = paused.client.request;
  paused.client.request = async (...args) => { const reply = await original(...args); if (args[0] === 'OnWaterRequest') reads++; return reply; };
  const settings = defaultSettings(); settings.loop.world = true; settings.pet.enabled = settings.pet.breed = true;
  const action = { kind: 'petBreed', setting: 'pet.breed', request: 'PetBreedRequest', body: { petId: paused.recipe.petId }, costs: paused.recipe.cost.map(([id, num]) => ({ id, num })), verify: {} };
  await runBaseAutomation(paused.client, paused.protocol, paused.config, { actions: [action] }, { player: paused.player, getSettings: () => settings, enabled: () => reads === 0 });
  assert.equal(paused.client.writes.length, 0); await paused.oldCraft();
});

await check('预算预留后共享金币被其他入口占用时撤销新锻造预算', async () => {
  const f = fixture(), usage = ledger(), original = usage.reserve.bind(usage);
  usage.reserve = (...args) => { const ticket = original(...args); reserveGold(f.player, f.state.gold, 1, 'PetBreedRequest'); return ticket; };
  const result = await f.forge(usage); assert(result.results.some(row => row.skipped));
  assert.equal(f.client.writes.length, 0); assert.equal(usage.snapshot().counters.forgeStarts ?? 0, 0); assert.equal(usage.snapshot().uncertain, 0);
});

await check('旧材料扣款未同步阻止新锻造，确认材料扣款后才能发包', async () => {
  const f = fixture();
  beginOrderMaterialSpend(f.player, [{ id: '蓝武器材料', have: f.state.materials.蓝武器材料, need: 1 }], '模拟旧联盟订单');
  const first = await f.forge(); assert(first.results.some(row => row.skipped && /材料扣款尚未确认/.test(row.error))); assert.equal(f.client.writes.length, 0);
  f.state.materials.蓝武器材料--;
  assert.equal((await f.forge()).results[0].status, 'confirmed');
});

await check('新锻造队列确认并回读完整材料后，同期补充材料不再阻止旧消费者', async () => {
  const f = fixture(), send = f.client.sendWatch, before = f.state.materials.蓝武器材料;
  f.client.sendWatch = async (...args) => { const result = await send(...args); if (args[0] === 'MakeEquipRequest') f.state.materials.蓝武器材料 = before + 40; return result; };
  assert.equal((await f.forge()).results[0].status, 'confirmed');
  confirmOrderMaterialSpends(f.player, new Map(Object.entries(f.state.materials)));
  const next = beginOrderMaterialSpend(f.player, [{ id: '蓝武器材料', have: f.state.materials.蓝武器材料, need: 1 }], '下一笔旧订单');
  cancelOrderMaterialSpend(next);
});

await check('新锻造未知结果保留材料，明确拒绝撤销材料占用', async () => {
  for (const rejected of [true, false]) {
    const f = fixture(); f.reject = rejected; f.unknown = !rejected;
    const result = await f.forge(); assert.equal(result.results[0].status, rejected ? 'rejected' : 'unknown');
    const confirm = () => confirmOrderMaterialSpends(f.player, new Map(Object.entries(f.state.materials)));
    if (rejected) confirm(); else assert.throws(confirm, /材料扣款尚未确认/);
  }
});

console.log(`${results.filter(row => row.passed).length}/${results.length} 通过；${directory}`);
if (results.some(row => !row.passed)) process.exitCode = 1;
