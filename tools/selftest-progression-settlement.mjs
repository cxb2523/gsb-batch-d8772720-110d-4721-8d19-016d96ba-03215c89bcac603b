// Issue #17：成功状态后读取完整余额，收入/生产不能阻塞后续养成。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-progression-settlement-'));
process.env.CW_DATA_DIR = directory;
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { pendingGoldSpend, reserveGold, cancelUnsentGold } = await import('../src/gold-reservations.mjs');
const { pendingOrderMaterialSpends } = await import('../src/order-reservations.mjs');
const { readEquipmentCrafting, startEquipmentCraft } = await import('../src/equipment-crafting.mjs');
const { readEquipmentForge, runEquipmentForge } = await import('../src/equipment-forge.mjs');
const { readAntiqueUpgrade, runAntiqueUpgrade } = await import('../src/antique-upgrade.mjs');
const { servicePetBreeding } = await import('../src/pet-breeding.mjs');
const { upgradeFishingOnce } = await import('../src/fishing-upgrade.mjs');
const { serviceBoats } = await import('../src/boats.mjs');
const { warForgeFixture, warForgeSettings } = await import('./fixtures/war-forge.mjs');
const { antiqueFixture, antiqueSettings } = await import('./fixtures/antique.mjs');
let serial = 1700200, sequence = 0;
const player = () => ({ playerId: String(++serial), worldId: 2001001001, level: 40 });
const usage = () => createUsageLedger('模拟成长账号', { file: path.join(directory, 'usage-' + (++sequence) + '.json') });
const checks = [];
async function check(name, test) {
  try { await test(); checks.push(true); console.log('通过：' + name); }
  catch (error) { checks.push(false); console.error('失败：' + name + '\n' + error.stack); }
}
function equipmentFixture() {
  const f = warForgeFixture();
  f.config.tables.BuildingUnlockCfg.data.find(row => row.buildingType === '装备厂').consume = [['GOLD', 1]];
  f.start = async (client = f.client) => {
    const view = await readEquipmentCrafting(client, f.config, f.player);
    return startEquipmentCraft(client, f.config, f.player, { buildingId: view.buildingId, makeId: 1001,
      previewKey: view.recipes.find(row => row.makeId === 1001).previewKey });
  };
  return f;
}

await check('旧装备开工成功后金币回涨，同账号下一笔可继续', async () => {
  const f = equipmentFixture(), send = f.client.sendWatch;
  f.client.sendWatch = async (...args) => { await send(...args); f.state.gold += 5000; };
  await f.start();
  assert.equal(f.state.gold, 103000); assert.equal(pendingGoldSpend(f.player), null);
  f.state.factory.equipMaking = null;
  await f.start(); assert.equal(f.client.writes.length, 2);
});

await check('旧装备未知结果保留，换连接见匹配队列后恢复且不串账号', async () => {
  const f = equipmentFixture(); f.unknown = true;
  await assert.rejects(f.start(), /未确认本批装备开工/);
  const held = pendingGoldSpend(f.player); assert(held);
  const reconnected = { ...f.client };
  f.unknown = false;
  await assert.rejects(f.start(reconnected), /扣款尚未同步/); assert.equal(f.client.writes.length, 1);
  const other = { ...f.player, worldId: 2002001001 };
  const otherTicket = reserveGold(other, 100000, 1, 'OtherRequest');
  f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) + 600 };
  f.state.gold += 3000;
  assert.equal((await readEquipmentCrafting(reconnected, f.config, f.player)).state, 'making');
  assert.equal(pendingGoldSpend(f.player), null); assert.equal(pendingGoldSpend(other), otherTicket);
  cancelUnsentGold(otherTicket);
});

await check('旧装备业务成功但金币读取缺失时不释放，后续完整查询恢复', async () => {
  const f = equipmentFixture(), read = f.client.request;
  let broken = true;
  f.client.request = async (...args) => args[0] === 'AllResourceRequest' && f.client.writes.length && broken ? {} : read(...args);
  await f.start(); assert(pendingGoldSpend(f.player));
  await assert.rejects(readEquipmentCrafting({ ...f.client }, f.config, f.player), /资源库存/);
  assert(pendingGoldSpend(f.player));
  broken = false; await readEquipmentCrafting({ ...f.client }, f.config, f.player);
  assert.equal(pendingGoldSpend(f.player), null);
});

await check('详细锻造队列确认后材料及金币回涨，领取后继续锻造', async () => {
  const f = equipmentFixture(), settings = warForgeSettings(), ledger = usage(), send = f.client.sendWatch;
  f.client.sendWatch = async (...args) => {
    await send(...args);
    if (args[0] === 'MakeEquipRequest') { f.state.gold += 5000; f.state.materials.蓝武器材料 += 80; }
  };
  const run = () => runEquipmentForge(f.client, f.protocol, f.config, f.player, { getSettings: () => settings, ledger });
  assert.equal((await run()).results[0].status, 'confirmed');
  assert.equal(pendingGoldSpend(f.player), null); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  f.finishForge(); await run();
  assert.equal(f.client.writes.filter(row => row.name === 'MakeEquipRequest').length, 2);
  assert.equal(f.client.writes.filter(row => row.name === 'PickMadeEquipRequest').length, 1);
});

await check('详细锻造未知保留，匹配新队列后不完整材料仍保留，重连完整读取恢复', async () => {
  const f = equipmentFixture(), settings = warForgeSettings(), ledger = usage(); f.unknown = true;
  const first = await runEquipmentForge(f.client, f.protocol, f.config, f.player, { getSettings: () => settings, ledger });
  assert.equal(first.results[0].status, 'unknown'); assert(pendingGoldSpend(f.player));
  const read = f.client.request;
  f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) + 600 };
  f.client.request = async (...args) => args[0] === 'AllItemRequest' ? {} : read(...args);
  await readEquipmentForge({ ...f.client }, f.protocol, f.config, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  f.client.request = read; f.unknown = false; f.state.materials.蓝武器材料 += 100; f.state.gold += 5000;
  await runEquipmentForge({ ...f.client }, f.protocol, f.config, f.player, { getSettings: () => settings, ledger });
  assert.equal(f.client.writes.length, 1); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  assert.equal(pendingGoldSpend(f.player), null);
});

function suitFixture() {
  const f = antiqueFixture(); f.player = player(); f.settings = antiqueSettings(); f.ledger = usage();
  Object.assign(f.settings.antique, { activate: false, star: false, master: false, suitQualities: ['BLUE'] });
  f.state.suits = [{ id: 1001, level: 1 }]; f.state.items.set('蓝藏品经验', 100);
  f.run = (client = f.client) => runAntiqueUpgrade(client, f.protocol, f.config, f.player, { getSettings: () => f.settings, ledger: f.ledger });
  return f;
}
await check('藏品套装成功后金币收入遮蔽扣减也能连续升级', async () => {
  const f = suitFixture(), send = f.client.sendWatch;
  f.client.sendWatch = async (...args) => { await send(...args); f.state.gold += 100; };
  const result = await f.run();
  assert.equal(f.state.suits[0].level, 3); assert.equal(f.client.writes.length, 2);
  assert(result.results.every(row => row.status === 'confirmed'));
  assert.equal(f.state.gold, 1090); assert.equal(pendingGoldSpend(f.player), null);
});

await check('藏品套装未知结果不重发，后来等级更新可跨连接核销', async () => {
  const f = suitFixture(); f.client.unknown = true;
  assert.equal((await f.run()).results[0].status, 'unknown');
  f.client.unknown = false; await f.run({ ...f.client }); assert.equal(f.client.writes.length, 1);
  f.state.suits[0].level = 2; f.state.gold += 100;
  await f.run({ ...f.client });
  assert.equal(f.state.suits[0].level, 3); assert.equal(f.client.writes.length, 2);
  assert.equal(pendingGoldSpend(f.player), null);
});

await check('藏品套装回读缺金币、读取时切账号均不能释放旧金币预留', async () => {
  const f = suitFixture(), read = f.client.request; f.client.unknown = true;
  await f.run(); const ticket = pendingGoldSpend(f.player); assert(ticket);
  const original = { ...f.player }; f.state.suits[0].level = 2;
  f.client.request = async (...args) => args[0] === 'AllResourceRequest' ? { list: [] } : read(...args);
  const broken = await readAntiqueUpgrade(f.client, f.protocol, f.config, f.player);
  assert.match(broken.reason, /金币余额/); assert.equal(pendingGoldSpend(f.player), ticket);
  f.client.request = async (...args) => {
    const result = await read(...args);
    if (args[0] === 'AllResourceRequest') f.player.worldId++;
    return result;
  };
  await readAntiqueUpgrade(f.client, f.protocol, f.config, f.player);
  assert.equal(pendingGoldSpend(original), ticket);
  f.player = original; f.client.request = read;
  await readAntiqueUpgrade(f.client, f.protocol, f.config, f.player);
  assert.equal(pendingGoldSpend(f.player), null);
});

await check('装备和藏品明确未发送时撤销资源及持久额度，不留下未知占用', async () => {
  const notSent = async () => { throw Object.assign(new Error('模拟发送前停止'), { notSent: true }); };
  const old = equipmentFixture(); old.client.sendWatch = notSent;
  await assert.rejects(old.start(), /发送前停止/); assert.equal(pendingGoldSpend(old.player), null);
  const forge = equipmentFixture(), ledger = usage(), settings = warForgeSettings(); forge.client.sendWatch = notSent;
  const result = await runEquipmentForge(forge.client, forge.protocol, forge.config, forge.player, { ledger, getSettings: () => settings });
  assert.equal(result.results[0].status, 'cancelled'); assert.equal(pendingGoldSpend(forge.player), null);
  assert.equal(pendingOrderMaterialSpends(forge.player).length, 0); assert.equal(ledger.snapshot().uncertain, 0);
  const suit = suitFixture(); suit.client.sendWatch = notSent;
  assert.equal((await suit.run()).results[0].status, 'cancelled');
  assert.equal(pendingGoldSpend(suit.player), null); assert.equal(suit.ledger.snapshot().uncertain, 0);
});

function petFixture() {
  const config = { tables: {
    BuildingUnlockCfg: { data: [{ buildingId: '1宠物培育室', buildingType: '宠物培育室', playerLevel: 1 }] },
    PetSpeciesCfg: { data: [{ spId: 1, season: 1, name: '测试海兽' }] },
    PetBreedCfg: { data: [{ petId: '蓝宠物1', spId: 1, quality: 'BLUE', qualityIndex: 1, season: 1, breedTime: 600,
      cost: [['宠物1蓝基因', 10], ['GOLD', 1000]] }] },
  } };
  const protocol = Object.fromEntries(['OnWater', 'AllPet', 'AllItem', 'AllResource'].flatMap(name => [[name + 'Request', {}], [name + 'Response', {}]]));
  protocol.PetBreedRequest = protocol.GetMaturePetRequest = {};
  const f = { player: player(), gold: 20000, genes: 100, pets: [], writes: [], unknown: false, badItems: false,
    room: { buildingId: '1宠物培育室', level: 1, petBreed: { breedQ: [], maturePets: [], maxQLength: 2 } } };
  f.job = () => { const now = Math.floor(Date.now() / 1000); f.room.petBreed.breedQ.push({ idx: f.writes.length, petId: '蓝宠物1', star: 0, startTime: now, finishTime: now + 600 }); };
  f.client = { connected: true, async request(name) {
    if (name === 'OnWaterRequest') return { building: [structuredClone(f.room)] };
    if (name === 'AllItemRequest') return f.badItems ? {} : { items: [{ itemId: '宠物1蓝基因', num: f.genes }] };
    if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: f.gold }] };
    if (name === 'AllPetRequest') return { pets: f.pets };
    throw new Error('意外读取 ' + name);
  }, async sendWatch(name) {
    f.writes.push(name); if (f.unknown) throw new Error('模拟超时');
    if (name === 'PetBreedRequest') { f.genes = f.genes - 10 + 20; f.gold = f.gold - 1000 + 2000; f.job(); }
    else if (name === 'GetMaturePetRequest') {
      f.room.petBreed.maturePets = []; f.pets.push({ uid: String(++serial), petId: '蓝宠物1', star: 0 });
    } else throw new Error('意外写入 ' + name);
  } };
  f.run = async (client = f.client, enabled = () => true) => {
    const reports = []; await servicePetBreeding(client, protocol, config, { player: f.player, enabled, report: entry => reports.push(entry) }); return reports;
  };
  return f;
}
await check('旧海兽培育金币和基因增长，成熟后仍可领取并继续培育', async () => {
  const f = petFixture(); assert((await f.run()).some(row => row.ok));
  assert.equal(f.gold, 21000); assert.equal(f.genes, 110); assert.equal(pendingGoldSpend(f.player), null);
  f.room.petBreed.breedQ = []; f.room.petBreed.maturePets = [{ petId: '蓝宠物1', star: 0 }];
  assert((await f.run({ ...f.client })).filter(row => row.ok).length === 2);
  assert.deepEqual(f.writes, ['PetBreedRequest', 'GetMaturePetRequest', 'PetBreedRequest']);
});

await check('旧海兽未知不重发，后来队列可确认，但完整库存读取失败时继续保留', async () => {
  const f = petFixture(); f.unknown = true; await f.run();
  const connection = { ...f.client }; f.unknown = false; await f.run(connection);
  assert.equal(f.writes.length, 1);
  f.job(); f.badItems = true; await f.run(connection); assert.equal(f.writes.length, 1);
  f.badItems = false; f.gold += 2000; f.genes += 20;
  assert((await f.run(connection)).some(row => /已核对上次/.test(row.reason)));
  await f.run(connection); assert.equal(f.writes.length, 2);
});

await check('旧同种海兽队列加速、自然成熟及领奖均不能证明未知的新培育已执行', async () => {
  const f = petFixture(); f.job(); f.unknown = true;
  await f.run(); assert.equal(f.writes.length, 1);
  const ticket = pendingGoldSpend(f.player); assert(ticket);
  const reconnected = { ...f.client }; f.unknown = false;
  f.room.petBreed.breedQ[0].finishTime -= 100;
  await f.run(reconnected);
  assert.equal(pendingGoldSpend(f.player), ticket, '旧队列加速不产生新队列身份');
  f.room.petBreed.breedQ = []; f.room.petBreed.maturePets = [{ petId: '蓝宠物1', star: 0 }];
  await f.run(reconnected);
  assert.equal(pendingGoldSpend(f.player), ticket, '旧队列自然成熟不能确认新的培育请求');
  f.room.petBreed.maturePets = []; f.pets.push({ uid: String(++serial), petId: '蓝宠物1', star: 0 });
  await f.run(reconnected);
  assert.equal(pendingGoldSpend(f.player), ticket, '旧队列产物被其他入口领取也不能确认新培育');
  assert.equal(f.writes.length, 1);
  f.job();
  assert((await f.run(reconnected)).some(row => /已核对上次/.test(row.reason)));
  assert.equal(pendingGoldSpend(f.player), null, '真正出现新队列身份后才能核销');
});

const enhanceConfig = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '小玩法升级', playerLevel: 1 }] },
  BuildingCfg: { data: [{ buildingType: '潜水船' }, { buildingType: '探险船' }] }, BuildingUpgradeCfg: { data: [] },
  ...Object.fromEntries(['Fish', 'Dive', 'Salvage'].map(name => [name + 'LevelCfg', { data: [
    { level: 1, enhance: 10, cost: ['GOLD', 50] }, { level: 2, enhance: 10, condition: ['钓鱼椅', 1] },
  ] }])),
} };
function enhanceFixture() {
  const f = { player: player(), gold: 10000, progress: 1, writes: [], mode: '', enabled: true };
  f.client = { connected: true, async request(name) {
    if (name === 'OnWaterRequest') return { building: [{ buildingId: '1钓鱼椅', level: 1 }, { buildingId: '1潜水船', level: 1 }, { buildingId: '1探险船', level: 1 }],
      fishingLevel: { level: 1, enhance: f.progress }, divingLevel: { level: 1, enhance: f.progress }, salvageLevel: { level: 1, enhance: f.progress } };
    if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: f.gold }] };
    if (!['FishingLevelUpRequest', 'DivingLevelUpRequest', 'SalvageLevelUpRequest'].includes(name)) throw new Error('意外请求 ' + name);
    f.writes.push(name);
    if (f.mode === 'refused') throw Object.assign(new Error('模拟拒绝'), { prompt: {}, request: name });
    if (f.mode === 'unknown') throw new Error('模拟超时');
    f.gold = f.gold - 50 + 100; f.progress++;
    return { levelInfo: { level: 1, enhance: f.progress } };
  } };
  f.run = async (kind, before) => {
    const guard = createActionGuard(f.client, () => null, null, { player: f.player });
    const options = { beforeAction: before ? async action => { const ticket = await guard.before(action); before(); return ticket; } : guard.before,
      afterAction: guard.after, cancelAction: guard.cancel };
    if (kind === 'fishEnhance') return upgradeFishingOnce(f.client, enhanceConfig, { playerLevel: 10, reserveGold: 0, enabled: () => f.enabled, ...options });
    const results = []; await serviceBoats(f.client, enhanceConfig, key => key === kind && f.enabled, row => results.push(row), options); return results[0];
  };
  return f;
}
for (const kind of ['fishEnhance', 'diveEnhance', 'salvageEnhance']) {
  await check(kind + ' 接真实guard：首次和收入回涨后的强化均成功', async () => {
    const f = enhanceFixture(); assert((await f.run(kind)).ok); assert((await f.run(kind)).ok);
    assert.equal(f.writes.length, 2); assert.equal(pendingGoldSpend(f.player), null);
  });
  await check(kind + ' 明确拒绝和发送前关闭释放，未知结果保留', async () => {
    const f = enhanceFixture(); f.mode = 'refused';
    if (kind === 'fishEnhance') await assert.rejects(f.run(kind), /模拟拒绝/); else assert.equal((await f.run(kind)).ok, false);
    assert.equal(pendingGoldSpend(f.player), null); f.mode = '';
    const before = f.writes.length; await f.run(kind, () => { f.enabled = false; });
    assert.equal(f.writes.length, before); assert.equal(pendingGoldSpend(f.player), null);
    f.enabled = true; f.mode = 'unknown';
    if (kind === 'fishEnhance') await assert.rejects(f.run(kind), /模拟超时/); else assert.equal((await f.run(kind)).ok, false);
    assert(pendingGoldSpend(f.player));
  });
}

console.log(checks.filter(Boolean).length + '/' + checks.length + ' 通过；' + directory);
if (checks.some(ok => !ok)) process.exitCode = 1;
