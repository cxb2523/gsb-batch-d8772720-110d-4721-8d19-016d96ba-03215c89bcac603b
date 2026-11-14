// Issue #17: run the real action guard/world/base consumers with offline replies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProtocol } from '../src/proto.mjs';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import { runBaseAutomation } from '../src/base-automation.mjs';
import { runWorld } from '../src/world.mjs';
import { runHeroPlan } from '../src/heroes.mjs';
import { serviceCargo } from '../src/cargo.mjs';
import { uidText } from '../src/hero-equipment.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialSpends,
  readOrderMaterialState, settleOrderMaterialState, pendingOrderMaterialSpends, refreshOrderMaterialSpends } from '../src/order-reservations.mjs';

const protocol = loadProtocol(), now = () => Math.floor(Date.now() / 1000);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-spend-settlement-'));
let serial = 17700000, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const asset = (id, num) => ({ type: 0, id, num });
function fixture() {
  const player = { playerId: ++serial, worldId: 1000001, level: 40, guildId: 1 };
  const settings = defaultSettings(); settings.pet.enabled = settings.pet.advance = settings.cargo.enabled = true;
  const state = { stock: new Map([['fish', 100], ['wood', 100], ['加速器', 100], ['英雄经验', 100]]), income: 1,
    buildings: [], orders: [{ index: 1, workerId: 1, textId: 1, requirements: [asset('fish', 10)] }], orderNum: 0,
    pets: [{ uid: '101', petId: '紫宠物1', grade: 1, profFeed: [{ attrFeed: [{ times: 0 }] }] }],
    heroes: [{ heroId: 'A', level: 1, star: 1, skillLevels: [1] }], ships: [], writes: [], reads: [], mode: 'ok', running: true };
  const client = { connected: true,
    async request(name, body = {}) {
      assert(protocol[name], 'real protocol request exists: ' + name);
      protocol[name].encode(body).finish();
      if (name.endsWith('Request') && /^(AllItem|AllResource|AllPet|AllHero|OnWater|CargoShips|WeekInfo)Request$/.test(name)) {
        state.reads.push(name);
        let value;
        if (name === 'AllItemRequest') {
          if (state.badBag && state.writes.length) {
            if (state.badBag === 'throw') throw new Error('测试库存读取失败');
            return state.badBag;
          }
          value = { items: [...state.stock].map(([itemId, num]) => ({ itemId, num })) };
        } else if (name === 'AllResourceRequest') value = { list: [{ res: 3, amount: 100000 }] };
        else if (name === 'AllPetRequest') value = { pets: state.pets };
        else if (name === 'AllHeroRequest') value = { heroes: state.heroes };
        else if (name === 'OnWaterRequest') value = { building: state.buildings, workerOrder: state.orders, orderOfTheDay: { orderNum: state.orderNum } };
        else if (name === 'CargoShipsRequest') value = { ship: state.ships };
        else value = { activityTime: [] };
        const result = structuredClone(value);
        await state.afterRead?.(name);
        return result;
      }
      state.writes.push(name);
      if (state.mode === 'reject') throw Object.assign(new Error('明确拒绝'), { request: name, prompt: {} });
      if (state.mode === 'unknown') throw new Error('结果未知');
      if (name === 'PetUpgradeFeedRequest') { state.stock.set('fish', state.stock.get('fish') - 10 + state.income); state.pets[0].profFeed[0].attrFeed[0].times++; }
      else if (name === 'FinishWorkerOrderRequest') {
        state.stock.set('fish', state.stock.get('fish') - 10 + state.income); state.orders[0].textId++; state.orderNum++;
      } else if (name === 'FillCargoShipRequest') {
        const ship = state.ships.find(row => row.index === body.shipIndex);
        for (const index of body.cargoIndex) { const slot = ship.orderItem[index - 1]; state.stock.set(slot.asset.id, state.stock.get(slot.asset.id) - slot.asset.num + state.income); slot.filled = true; }
        ship.status = 1; ship.arriveTime = now() + 3600;
      } else if (name === 'HeroLevelUpRequest') { state.heroes[0].level++; state.stock.set('英雄经验', state.stock.get('英雄经验') - 10 + state.income); }
      else if (state.mutate) state.mutate(name, body);
      else throw new Error('测试禁止未声明写操作：' + name);
      if (state.mode === 'lost') throw new Error('成功后回包丢失');
      return { reward: { asset: [asset('EXP', 1)] } };
    },
    async sendWatch(name, body) { return this.request(name, body); }
  };
  const ledger = createUsageLedger('offline', { file: path.join(directory, player.playerId + '.json') });
  const guard = () => createActionGuard(client, () => settings, ledger, { player, enabled: () => state.running });
  const feed = () => ({ kind: 'petAdvanceFeed', setting: 'pet.advance', scope: 'base', request: 'PetUpgradeFeedRequest', response: null,
    body: { buildingId: '1民居' }, costs: [{ id: 'fish', num: 10 }], verify: { petUid: uidText(state.pets[0].uid), grade: 1, fed: state.pets[0].profFeed[0].attrFeed[0].times }, label: '进阶投喂' });
  const runFeed = () => runBaseAutomation(client, protocol, { tables: {} }, { actions: [feed()] }, { player, getSettings: () => settings, enabled: () => state.running });
  const runWorldStep = step => runWorld(client, protocol, { actions: [step] }, { player, allowMutate: true, enabled: () => state.running });
  return { player, settings, state, client, guard, feed, runFeed, runWorldStep };
}

for (const income of [1, 10, 20]) await test('海兽进阶投喂成功，补产 ' + income + ' 后可继续且不阻无关材料', async () => {
  const f = fixture(); f.state.income = income;
  assert.equal((await f.runFeed())[0].ok, true);
  assert.equal((await f.runFeed())[0].ok, true);
  assert.equal(f.state.writes.length, 2);
  const g = f.guard(), step = { request: 'OtherRequest', costs: [{ id: 'wood', num: 1 }] };
  const ticket = await g.before(step); await g.cancel(step, ticket, { notSent: true });
});

await test('居民订单奖励成功后补产，可交下一张订单', async () => {
  const f = fixture(); f.state.income = 20;
  const step = { kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse', body: { index: 1 }, costs: [{ id: 'fish', num: 10 }] };
  assert.equal((await f.runWorldStep(step)).results[0].ok, true);
  assert.equal((await f.runWorldStep(step)).results[0].ok, true);
  assert.equal(f.state.writes.length, 2);
});

await test('贸易港第一船补产后，同种和不同材料的后续船均可装货', async () => {
  const f = fixture(); f.state.income = 20;
  f.state.ships = ['fish', 'fish', 'wood'].map((id, i) => ({ index: i + 1, status: 0, orderItem: [{ filled: false, asset: asset(id, 10) }] }));
  const g = f.guard();
  await serviceCargo(f.client, { tables: {} }, { enabled: () => true, getSettings: () => f.settings, beforeAction: g.before, afterAction: g.after, cancelAction: g.cancel, log() {} });
  assert.equal(f.state.writes.length, 3);
});

await test('投喂回包丢失后由新连接核对进度，补产不阻塞且不重发旧操作', async () => {
  const f = fixture(); f.state.mode = 'lost';
  assert.equal((await f.runFeed())[0].ok, false);
  f.state.mode = 'ok';
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  const next = { ...f.client };
  await refreshOrderMaterialSpends(next, { ...f.player });
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  assert.equal(f.state.writes.length, 1);
});

await test('超出安全整数范围的海兽UID可在丢回包后准确恢复', async () => {
  const f = fixture(); f.state.pets[0].uid = { low: 1, high: 2097152 }; f.state.mode = 'lost';
  await f.runFeed();
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  await refreshOrderMaterialSpends({ ...f.client }, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0); assert.equal(f.state.writes.length, 1);
});

for (const kind of ['cargo', 'resident']) await test('真实协议省略零值和false仍能恢复丢回包：' + kind, async () => {
  const f = fixture(), original = f.client.request.bind(f.client);
  f.client.request = async (name, body) => {
    const result = await original(name, body);
    if (['OnWaterRequest', 'CargoShipsRequest'].includes(name)) {
      const type = protocol[name.replace('Request', 'Response')]; return type.decode(type.encode(result).finish());
    }
    return result;
  };
  f.state.mode = 'lost';
  if (kind === 'resident') {
    f.state.orders[0].index = 0;
    await f.runWorldStep({ kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse', body: { index: 0 }, costs: [{ id: 'fish', num: 10 }] });
  } else {
    f.state.ships = [{ index: 1, status: 0, orderItem: [{ filled: false, asset: asset('fish', 10) }] }];
    const g = f.guard();
    await assert.rejects(serviceCargo(f.client, { tables: {} }, { enabled: () => true, getSettings: () => f.settings, beforeAction: g.before, afterAction: g.after, cancelAction: g.cancel, log() {} }), /回包丢失/);
  }
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  await refreshOrderMaterialSpends({ ...f.client }, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0); assert.equal(f.state.writes.length, 1);
});

await test('业务未知时即使库存跌破旧阈值也不释放，但无关材料可使用', async () => {
  const f = fixture(); f.state.mode = 'unknown'; await f.runFeed();
  f.state.stock.set('fish', 0);
  await refreshOrderMaterialSpends(f.client, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  assert.throws(() => confirmOrderMaterialSpends(f.player, f.state.stock, ['fish']), /尚未确认/);
  const g = f.guard(), step = { request: 'OtherRequest', costs: [{ id: 'wood', num: 1 }] };
  const ticket = await g.before(step); await g.cancel(step, ticket, { notSent: true });
  assert.equal(f.state.writes.length, 1);
});

for (const completion of ['cancel', 'confirm']) await test('同一guard恢复未知操作后，相同请求的新票据独立' + completion, async () => {
  const f = fixture(), g = f.guard(), first = f.feed(), oldTicket = await g.before(first);
  f.state.mode = 'lost'; await assert.rejects(f.client.sendWatch(first.request, first.body));
  await refreshOrderMaterialSpends({ ...f.client }, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  const second = f.feed(), ticket = await g.before(second);
  assert.notEqual(ticket, oldTicket);
  // An obsolete completion/cancellation must not release the new generation.
  await g.cancel(first, oldTicket, { notSent: true });
  await g.after(first, oldTicket, { ok: true });
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  if (completion === 'cancel') await g.cancel({ ...second }, ticket, { notSent: true });
  else {
    f.state.mode = 'ok'; await f.client.sendWatch(second.request, second.body);
    await g.after({ ...second }, ticket, { ok: true, sent: true });
  }
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});

for (const baseline of [[], [{ buildingId: 'target' }]]) await test('升级前缺少目标或必填等级时，完整回读不能证明未知升级成功', async () => {
  const f = fixture(); f.state.buildings = baseline;
  const g = f.guard(), step = { request: 'UpgradeBuildingRequest', body: { buildingId: 'target' }, costs: [{ id: 'wood', num: 10 }] };
  await g.before(step); f.state.mode = 'unknown'; await assert.rejects(f.client.sendWatch(step.request, step.body));
  f.state.buildings = [{ buildingId: 'target', level: 5 }];
  await refreshOrderMaterialSpends({ ...f.client }, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
});

for (const change of ['mature', 'feed']) await test('已有同种培育队列' + change + '不能冒充本次未知培育成功', async () => {
  const f = fixture();
  const room = { buildingId: '1宠物培育室', level: 2, petBreed: { breedQ: [{ idx: 7, petId: 'same', startTime: 10, finishTime: 20 }], maturePets: [] } };
  f.state.buildings = [room];
  const g = f.guard(), step = { request: 'PetBreedRequest', body: { petId: 'same', universal: false }, costs: [{ id: 'fish', num: 10 }] };
  await g.before(step);
  f.state.mode = 'unknown'; await assert.rejects(f.client.sendWatch(step.request, step.body));
  if (change === 'mature') { room.petBreed.breedQ = []; room.petBreed.maturePets = [{ petId: 'same' }]; }
  else room.petBreed.breedQ[0].finishTime--;
  await refreshOrderMaterialSpends(f.client, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
});

for (const baseline of [{}, { breedQ: [] }, { maturePets: [] },
  { breedQ: [{ petId: 'same' }], maturePets: [] },
  { breedQ: [0, 1].map(() => ({ idx: 7, petId: 'same', startTime: 10, finishTime: 20 })), maturePets: [] }]) {
  await test('不完整或重复培育基线不能把后来正常回读的旧队列当成新培育', async () => {
    const f = fixture(), room = { buildingId: '1宠物培育室', level: 2, petBreed: baseline };
    f.state.buildings = [room];
    const g = f.guard(), step = { request: 'PetBreedRequest', body: { petId: 'same', universal: false }, costs: [{ id: 'fish', num: 10 }] };
    await g.before(step);
    f.state.mode = 'unknown'; await assert.rejects(f.client.sendWatch(step.request, step.body));
    room.petBreed = { breedQ: [{ idx: 7, petId: 'same', startTime: 10, finishTime: 20 }], maturePets: [] };
    await refreshOrderMaterialSpends({ ...f.client }, f.player);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  });
}

for (const request of ['PetBreedRequest', 'PetFeedRequest']) await test(request + '回包丢失后按有效新队列或投喂进度核销，拒绝异常队列', async () => {
  const f = fixture(), room = { buildingId: '1宠物培育室', level: 2,
    petBreed: { breedQ: [{ idx: 7, petId: 'same', startTime: 10, finishTime: 20 }], maturePets: [] } };
  f.state.buildings = [room];
  const g = f.guard(), step = { request, body: request === 'PetBreedRequest' ? { petId: 'same', universal: false } : { jobIdx: 7 }, costs: [{ id: 'fish', num: 10 }] };
  await g.before(step);
  f.state.mode = 'unknown'; await assert.rejects(f.client.sendWatch(step.request, step.body));
  room.petBreed.breedQ = [{ petId: 'same' }];
  await refreshOrderMaterialSpends(f.client, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  room.petBreed.breedQ = [{ idx: request === 'PetBreedRequest' ? 8 : 7, petId: 'same', startTime: 10, finishTime: 19 }];
  f.state.stock.set('fish', 110);
  await refreshOrderMaterialSpends({ ...f.client }, f.player);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});

for (const badBag of ['throw', {}, { items: [{ itemId: 'fish', num: 100 }, { itemId: 'fish', num: 100 }] }, { items: [{ itemId: 'fish', num: -1 }] }]) {
  await test('明确成功后库存读取不完整仍保留，恢复完整读取后解除：' + JSON.stringify(badBag), async () => {
    const f = fixture(); f.state.badBag = badBag;
    assert.equal((await f.runFeed())[0].ok, true);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
    await refreshOrderMaterialSpends({ ...f.client }, f.player);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
    delete f.state.badBag;
    await refreshOrderMaterialSpends({ ...f.client }, f.player);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  });
}

for (const boundary of ['pause', 'identity']) await test('结算库存读取期间' + boundary + '不能释放原账号记录', async () => {
  const f = fixture(), original = f.player.playerId;
  f.state.badBag = 'throw'; await f.runFeed(); delete f.state.badBag;
  f.state.afterRead = name => { if (name === 'AllItemRequest') { if (boundary === 'pause') f.state.running = false; else f.player.playerId++; } };
  await refreshOrderMaterialSpends(f.client, f.player, { enabled: () => f.state.running });
  assert.equal(pendingOrderMaterialSpends({ ...f.player, playerId: original }).length, 1);
  f.player.playerId = original; f.state.running = true; delete f.state.afterRead;
  await refreshOrderMaterialSpends(f.client, f.player); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});

await test('已捕获的旧结算快照不能删除后来建立的新预留', async () => {
  const f = fixture(), cost = [{ id: 'fish', have: 100, need: 10 }];
  const first = beginOrderMaterialSpend(f.player, cost, '旧操作', { operation: { confirmed: true } });
  const snapshot = await readOrderMaterialState(f.client, f.player);
  cancelOrderMaterialSpend(first);
  const second = beginOrderMaterialSpend(f.player, cost, '新操作', { operation: {} });
  settleOrderMaterialState(f.player, snapshot, f.state.stock);
  assert.deepEqual(pendingOrderMaterialSpends(f.player), [second]);
  cancelOrderMaterialSpend(second);
});

await test('其他账号的完整库存不能结算本账号操作', async () => {
  const f = fixture(); f.state.badBag = 'throw'; await f.runFeed(); delete f.state.badBag;
  await refreshOrderMaterialSpends(f.client, { ...f.player, playerId: f.player.playerId + 100000 });
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
});

const worldCases = [
  ['建造', 'BuildBuildingRequest', { buildingId: '1民居' }, [], s => s.buildings.push({ buildingId: '1民居', level: 1 })],
  ['升级', 'UpgradeBuildingRequest', { buildingId: '1民居' }, [{ buildingId: '1民居', level: 1 }], s => s.buildings[0].level++],
  ['排产', 'StartFactoryProduceRequest', { buildingId: '1食品厂', productId: '鱼罐头' }, [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [] } }], s => s.buildings[0].factory.factoryQ.push({ idx: 1, productId: '鱼罐头', finishTime: now() + 600 })],
  ['建筑加速', 'SpeedUpUpgradeBuildingRequest', { buildingId: '1民居', speedUp: { type: 2, useNum: 1 } }, [{ buildingId: '1民居', level: 1, buildFinishTime: now() + 3600 }], s => s.buildings[0].buildFinishTime -= 60],
  ['生产加速', 'SpeedUpFactoryProduceRequest', { buildingId: '1食品厂', index: 1, speedUp: { type: 2, useNum: 1 } }, [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [{ idx: 1, productId: '鱼罐头', finishTime: now() + 3600 }] } }], s => s.buildings[0].factory.factoryQ[0].finishTime -= 60],
  ['农田加速', 'FarmSpeedUpRequest', { buildingId: '1农田', param: { type: 2, useNum: 1 } }, [{ buildingId: '1农田', level: 1, farm: { productId: '小麦', plantTime: now(), ripeTime: now() + 3600 } }], s => s.buildings[0].farm.ripeTime -= 60]
];
for (const [name, request, body, buildings, mutate] of worldCases) await test(name + '静默写入后核对业务状态，可结算净增加的材料', async () => {
  const f = fixture(); f.state.buildings = structuredClone(buildings);
  f.state.mutate = () => { mutate(f.state); f.state.stock.set('fish', 105); };
  const step = { kind: 'build', request, response: null, body, costs: [{ id: 'fish', num: 1 }] };
  const result = await f.runWorldStep(step);
  assert.equal(result.results[0].status, 'confirmed', JSON.stringify(result.results));
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  assert.equal(f.state.writes.length, 1);
});

await test('真实协议省略工厂队列零号idx仍可确认新排产', async () => {
  const f = fixture(), original = f.client.request.bind(f.client);
  f.state.buildings = [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [] } }];
  f.client.request = async (name, body) => {
    const value = await original(name, body);
    return name === 'OnWaterRequest' ? protocol.OnWaterResponse.decode(protocol.OnWaterResponse.encode(value).finish()) : value;
  };
  f.state.mutate = () => f.state.buildings[0].factory.factoryQ.push({ productId: '鱼罐头', finishTime: now() + 600 });
  const result = await f.runWorldStep({ kind: 'build', request: 'StartFactoryProduceRequest', response: null, body: { buildingId: '1食品厂', productId: '鱼罐头' }, costs: [{ id: 'fish', num: 1 }] });
  assert.equal(result.results[0].status, 'confirmed');
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});

await test('英雄连续升级回读目标等级，经验补入不阻塞下一次', async () => {
  const f = fixture(); f.settings.heroes.enabled = f.settings.heroes.level = true; f.state.income = 20;
  const g = f.guard();
  const results = await runHeroPlan(f.client, protocol, { steps: [{ kind: 'level', heroId: 'A', from: 1, to: 3, count: 2, levelCosts: [10, 10], costs: [{ id: '英雄经验', num: 20 }] }] },
    { allowMutate: true, getSettings: () => f.settings, beforeAction: g.before, afterAction: g.after, cancelAction: g.cancel });
  assert.equal(results.filter(row => row.ok).length, 2); assert.equal(f.state.heroes[0].level, 3);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});

console.log('共享消费状态结算专项 ' + passed + '/' + passed + ' 通过');
