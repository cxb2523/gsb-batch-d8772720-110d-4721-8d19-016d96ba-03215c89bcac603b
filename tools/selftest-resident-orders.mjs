import assert from 'node:assert/strict';
import { runLoop } from '../src/loop.mjs';
import { orderSlotsAfterHarvest, planWorld, runWorld, runWorldRound, submitResidentOrder, surveyWorld } from '../src/world.mjs';

const now = Math.floor(Date.now() / 1000);
const config = { materialName: id => id, tables: {
  GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
  BuildingCfg: { data: [{ buildingType: '食品厂' }] },
  BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 6 }] },
  BuildingProduceCfg: { data: [{ itemId: '烤鱼', buildType: '食品厂', unlockLevel: 1, produceTime: 60, costItem: [] }] },
  WeekOrderRwdCfg: { data: [{ periodId: 1001, rwdId: 0 }, { periodId: 1001, rwdId: 1 }, { periodId: 1001, rwdId: 2 }] },
} };
const protocol = Object.fromEntries(['OnWater', 'AllItem', 'AllResource', 'WeekInfo', 'WeekOrderInfo', 'CargoShips', 'FinishWorkerOrder']
  .flatMap(type => [[type + 'Request', true], [type + 'Response', true]]));
const order = { index: 1, requirements: [{ id: '烤鱼', num: 3 }] };
const reward = { asset: [{ id: 'EXP', num: 45 }] };
let playerSequence = 9100000000000000n;

function mock() {
  return {
    player: { playerId: String(++playerSequence), worldId: 1001001, level: 16 },
    connected: true, onWater: [order], stock: 50, weekly: 50, otherStock: [], otherWeekly: [], buildings: [], cargo: 0, calls: [],
    async request(name, body, response) {
      this.calls.push(name);
      switch (name) {
        case 'OnWaterRequest': return { workerOrder: this.onWater, building: this.buildings };
        case 'AllItemRequest': return this.itemReply ?? { items: [{ itemId: '烤鱼', num: this.stock }, ...this.otherStock] };
        case 'AllResourceRequest': return { list: [] };
        case 'WeekInfoRequest': return { activityTime: this.weekly === 0 ? [] : [{ type: 5, period: 1001, startTime: now - 60, endTime: now + 3600 }] };
        case 'WeekOrderInfoRequest':
          if (this.weekly == null) throw Error('周订单读取失败');
          return this.weekReply ?? { order: [{ id: '烤鱼', num: this.weekly }, ...this.otherWeekly] };
        case 'CargoShipsRequest':
          if (this.cargo == null) throw Error('货单读取失败');
          if (this.cargoReply) return this.cargoReply;
          return { ship: this.cargo > 0 ? [{ status: 0, orderItem: [{ asset: { id: '烤鱼', num: this.cargo } }] }] : [] };
        case 'FinishWorkerOrderRequest':
          assert.equal(response, 'FinishWorkerOrderResponse');
          for (const item of this.onWater.find(row => row.index === body.index)?.requirements ?? []) {
            if (item.id === '烤鱼') { assert(this.stock >= item.num); this.stock -= item.num; }
            else {
              const stored = this.otherStock.find(row => row.itemId === item.id);
              assert(stored && stored.num >= item.num); stored.num -= item.num;
            }
          }
          return { reward };
        default: assert.fail('意外请求 ' + name);
      }
    },
  };
}
async function plan(client, withCargo = false, produce = false) {
  const survey = await surveyWorld(client, protocol, { config, player: client.player, includeCargo: withCargo });
  return planWorld(survey, { config, enabled: key => ['finishOrder', 'denyOrder'].includes(key) || (key === 'startProduce' && produce),
    allowReroll: true, minOrderExp: null });
}

export async function testResidentOrders() {
  await testManualResidentOrder();
  await testActualShortages();
  await testWeeklyPriority();
  const client = mock();
  const held = await plan(client);
  assert.deepEqual(held.actions, []);
  assert.equal(held.orderDecisions[0].status, 'reserved');
  assert.match(held.orderDecisions[0].reason, /周订单预留 50.*可用 0.*上限 50/);
  client.weekly = 3;
  client.cargo = 47;
  assert.deepEqual((await plan(client, true)).orderDecisions[0].shortages[0],
    { id: '烤鱼', name: '烤鱼', required: 3, owned: 50, available: 0, weeklyReserved: 3, cargoReserved: 47, allocated: 0, missing: 3 });
  client.cargo = null;
  assert.equal((await plan(client, true)).orderDecisions[0].status, 'unknown');
  client.weekly = null;
  assert.equal((await plan(client)).orderDecisions[0].status, 'unknown');

  client.weekly = 46;
  client.onWater = [order, { ...order, index: 2 }, { ...order, index: 3, refreshTime: now - 1 }, { index: 4, requirements: [] }];
  const mixed = await plan(client);
  assert.deepEqual(mixed.orderDecisions.map(d => d.status), ['ready', 'reserved', 'refreshing', 'unknown']);
  assert.deepEqual(mixed.actions.map(a => a.body.index), [1]);

  // A reservation must still be read when the player enables ONLY resident orders.
  const only = mock();
  await runLoop(only, protocol, { rounds: 1, allowMutate: true, config, player: only.player, isEnabled: key => key === 'finishOrder' });
  assert(only.calls.includes('WeekOrderInfoRequest'));
  assert(!only.calls.includes('FinishWorkerOrderRequest'));

  // A denied slot can refresh. Don't permanently suppress it or block the other slot.
  const writes = [], rejected = new Set();
  const steps = [1, 2].map(index => ({ kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse', body: { index } }));
  const actor = { async request(name, { index }) {
    writes.push(index);
    if (writes.length === 1) throw Error('订单已改变');
    return { reward };
  } };
  const first = await runWorld(actor, protocol, { actions: steps }, { allowMutate: true, rejected });
  assert.deepEqual(first.results.map(e => e.ok), [false, true]);
  const next = await runWorld(actor, protocol, { actions: steps.slice(0, 1) }, { allowMutate: true, rejected });
  assert(next.results[0].ok);
  assert.deepEqual(writes, [1, 2, 1]);
  const noAck = await runWorld({ request: async () => ({}) }, protocol, { actions: steps.slice(0, 1) }, { allowMutate: true });
  assert(!noAck.results[0].ok);
  assert.match(noAck.results[0].error, /未返回.*奖励/);
  await testHarvestOrders();
}

async function testManualResidentOrder() {
  const context = client => ({ config, player: client.player, cargoEnabled: () => true });
  const survey = client => surveyWorld(client, protocol, { ...context(client), ordersOnly: true, includeCargo: true });
  const setup = () => {
    const client = mock();
    client.weekly = 0;
    client.onWater = [order, { ...order, index: 2, workerId: 30, textId: 4 }];
    return client;
  };
  const client = setup();
  client.stock = 3; // Enough for just one order; the earlier slot must not take precedence.
  const { orders } = await survey(client);
  const pick = { ...context(client), index: 2, orderKey: orders[1].orderKey };
  assert.equal((await survey(client)).orders[1].orderKey, pick.orderKey, '刷新相同订单时保持按钮标记');
  const writes = [];
  const request = client.request.bind(client);
  client.request = async (name, body, response) => {
    if (name === 'FinishWorkerOrderRequest') writes.push(body.index);
    return request(name, body, response);
  };
  const result = await submitResidentOrder(client, protocol, pick);
  assert.equal(result.index, 2);
  assert.deepEqual(result.reward, reward);
  assert.deepEqual(writes, [2], '只提交点选的槽位，即便其他订单也可交');
  await assert.rejects(submitResidentOrder(client, protocol, pick), /刷新|处理/);
  assert.deepEqual(writes, [2], '旧标记不能再次消费，即使服务器又返回外观相同的订单');
  await assert.rejects(submitResidentOrder(setup(), protocol, pick), /刷新|处理/);

  const noAck = setup();
  const noAckKey = (await survey(noAck)).orders[1].orderKey;
  const read = noAck.request.bind(noAck);
  let attempts = 0;
  noAck.request = async (name, ...args) => {
    if (name === 'FinishWorkerOrderRequest') { attempts++; return {}; }
    return read(name, ...args);
  };
  const uncertain = () => submitResidentOrder(noAck, protocol, { ...context(noAck), index: 2, orderKey: noAckKey });
  await assert.rejects(uncertain(), /未返回.*奖励/);
  await assert.rejects(uncertain(), /刷新|处理/);
  assert.equal(attempts, 1, '未确认奖励不可宣告成功，也不重复使用同一按钮');

  for (const update of [
    c => { c.onWater[1] = { ...c.onWater[1], workerId: 31 }; },
    c => { c.onWater[1] = { ...c.onWater[1], textId: 5 }; },
    c => { c.onWater[1] = { ...c.onWater[1], isSpecial: true }; },
    c => { c.onWater[1] = { ...c.onWater[1], requirements: [{ id: '烤鱼', num: 2 }] }; },
    c => { c.onWater[1] = { ...c.onWater[1], refreshTime: now + 60 }; },
    c => { c.onWater.push(c.onWater[1]); },
  ]) {
    const changed = setup();
    const original = (await survey(changed)).orders[1].orderKey;
    update(changed);
    await assert.rejects(submitResidentOrder(changed, protocol, { ...context(changed), index: 2, orderKey: original }), /刷新|处理/);
    assert(!changed.calls.includes('FinishWorkerOrderRequest'));
    if (changed.onWater.length === 3) assert.equal((await survey(changed)).orders[1].orderKey, null);
  }
  // A push uses protobuf int64 fields. Identical contents preserve the token;
  // removing then restoring an identical-looking slot still invalidates it.
  const pushed = setup();
  let receive;
  pushed.on = (_event, listener) => { receive = listener; };
  const key = (await survey(pushed)).orders[1].orderKey;
  receive({ name: 'SCWorkerOrder', body: { order: pushed.onWater.map(o => ({ ...o, requirements: [{ id: '烤鱼', num: { low: 3, high: 0 } }] })) } });
  assert.equal((await survey(pushed)).orders[1].orderKey, key);
  receive({ name: 'SCWorkerOrder', body: { order: [pushed.onWater[0]] } });
  receive({ name: 'SCWorkerOrder', body: { order: pushed.onWater } });
  await assert.rejects(submitResidentOrder(pushed, protocol, { ...context(pushed), index: 2, orderKey: key }), /刷新|处理/);
  assert(!pushed.calls.includes('FinishWorkerOrderRequest'));

  const auto = setup();
  const observed = await survey(auto);
  const actions = planWorld(observed, { config, enabled: kind => kind === 'finishOrder' }).actions.filter(step => step.body.index === 2);
  await runWorld(auto, protocol, { actions }, { allowMutate: true, player: auto.player });
  await assert.rejects(submitResidentOrder(auto, protocol, { ...context(auto), index: 2, orderKey: observed.orders[1].orderKey }), /刷新|处理/);
  assert.equal(auto.calls.filter(n => n === 'FinishWorkerOrderRequest').length, 1);

  const weekly = setup();
  weekly.weekly = weekly.stock = 50;
  weekly.otherWeekly = [{ id: '淡水', num: 1 }];
  const weeklyKey = (await survey(weekly)).orders[1].orderKey;
  assert.match((await submitResidentOrder(weekly, protocol, { ...context(weekly), index: 2, orderKey: weeklyKey })).label, /周订单待补 烤鱼 ×3/);

  for (const block of [c => { c.weekly = 50; }, c => { c.cargo = 49; }, c => { c.cargo = null; }, c => { c.stock = 0; }]) {
    const waiting = setup();
    const id = (await survey(waiting)).orders[1].orderKey;
    block(waiting);
    await assert.rejects(submitResidentOrder(waiting, protocol, { ...context(waiting), index: 2, orderKey: id }), /预留|材料|库存|贸易港/);
    assert(!waiting.calls.includes('FinishWorkerOrderRequest'));
  }
  const cancelled = setup();
  const cancelKey = (await survey(cancelled)).orders[1].orderKey;
  cancelled.calls.length = 0;
  await assert.rejects(submitResidentOrder(cancelled, protocol, { ...context(cancelled), index: 2, orderKey: cancelKey,
    enabled: () => !cancelled.calls.includes('CargoShipsRequest') }), /已取消/);
  assert(!cancelled.calls.includes('FinishWorkerOrderRequest'));
}

async function testActualShortages() {
  const client = mock();
  const cfg = { ...config, tables: { ...config.tables,
    BuildingProduceCfg: { data: ['烤鱼', '晾衣架'].map(itemId => ({ ...config.tables.BuildingProduceCfg.data[0], itemId })) },
  } };
  client.weekly = client.stock = 44;
  client.otherWeekly = [{ id: '淡水', num: 5 }];
  client.buildings = [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [], finishedProducts: [] } }];
  const requires = [{ id: '烤鱼', num: 3 }, { id: '晾衣架', num: 1 }];
  client.onWater = [{ index: 3, requirements: requires }];
  const inspect = async () => planWorld(await surveyWorld(client, protocol, { config: cfg, player: client.player }),
    { config: cfg, enabled: key => ['finishOrder', 'startProduce'].includes(key) });
  const first = await inspect();
  const decision = first.orderDecisions[0];
  assert.match(decision.reason, /烤鱼.*可从周订单临时使用 3/);
  assert.deepEqual(decision.shortages.map(s => [s.id, s.missing]), [['烤鱼', 0], ['晾衣架', 1]]);
  assert.deepEqual(decision.harvestNeeds, [{ id: '晾衣架', missing: 1 }]);
  assert(!first.actions.some(a => a.kind === 'finishOrder'));
  assert.equal(first.actions.find(a => a.kind === 'startProduce').body.productId, '晾衣架');

  // Two residents need 6 fish between them. Count the same 4 lendable fish once.
  client.weekly = client.stock = 4;
  client.onWater.push({ index: 4, requirements: requires });
  const shared = await inspect();
  const fishJobs = shared.actions.filter(a => a.kind === 'startProduce' && a.body.productId === '烤鱼' && a.label.includes('居民订单缺'));
  assert.deepEqual(fishJobs.map(a => a.label.match(/居民订单缺 (\d+)/)[1]), ['2', '1']);
}

async function testWeeklyPriority() {
  const pending = [{ id: '淡水', num: 5 }];
  const writeIndices = plan => plan.actions.filter(a => a.request === 'FinishWorkerOrderRequest').map(a => a.body.index);
  for (const [weekly, owned] of [[50, 50], [6, 6]]) {
    const client = mock(); client.otherWeekly = pending;
    client.weekly = weekly; client.stock = owned;
    const result = await plan(client);
    assert.deepEqual(writeIndices(result), [1], '整份周单缺淡水，居民材料齐全就交，不受能否并存的限制');
    assert(!result.actions.some(step => step.request.includes('WeekOrder') || step.request === 'DenyOrderRequest'));
    client.calls.length = 0;
    await runWorldRound(client, protocol, result, { config, player: client.player, allowMutate: true });
    assert(client.calls.includes('FinishWorkerOrderRequest'));
  }
  const client = mock(); client.otherWeekly = pending;
  client.otherStock = [{ itemId: '淡水', num: 5 }];
  assert.deepEqual(writeIndices(await plan(client)), [], '周单全部材料到齐时保留给玩家手动交付');

  client.otherStock = []; client.stock = 50; client.weekly = 50;
  client.cargo = 48;
  assert.deepEqual((await plan(client, true)).actions, [],
    '现货已全部算作周单预留，但其中有 48 件也是货轮所需，剩下 2 件交不了居民单');
  client.cargo = 47;
  client.onWater = [order, { ...order, index: 2 }];
  assert.deepEqual(writeIndices(await plan(client, true)), [1], '同一批库存最多交一份居民单，并留足 47 件贸易货物');
  client.cargo = null;
  assert.deepEqual((await plan(client, true)).actions, [], '读不到货轮时禁止交付和拒单');
  client.cargo = 0;
  for (const incomplete of [{}, { ship: [{ status: 0 }] }, { ship: [{ status: 0, orderItem: [{ asset: { id: '烤鱼', num: 0 } }] }] }]) {
    client.cargoReply = incomplete;
    assert.deepEqual((await plan(client, true)).actions, [], '贸易港缺少正在装货的船只或材料字段时，不动库存');
  }
  delete client.cargoReply;
  client.itemReply = {};
  assert.deepEqual((await plan(client)).actions, [], '库存响应缺少 items 时，不把所有材料当作零而拒单');
  delete client.itemReply;

  for (const bad of [[], [{ id: '烤鱼', num: 50 }, { id: '', num: 1 }], [{ id: '烤鱼', num: 0 }]]) {
    client.weekReply = { order: bad, gotRwdId: [1] };
    assert.deepEqual((await plan(client)).actions, [], '周活动开放但订单材料不可靠，保留库存并禁止自动拒单');
  }
  client.weekReply = { order: [{ id: '烤鱼', num: 50 }], gotRwdId: [1, 2], isGotFinal: false };
  assert.deepEqual(writeIndices(await plan(client)), [1, 2], '本期普通奖励都已领完、只待最终奖时无需再占用库存');
  delete client.weekReply;

  // An earlier order lacking a second item must not spend stock that the next complete order can use.
  client.onWater = [{ ...order, index: 3, requirements: [{ id: '烤鱼', num: 50 }, { id: '淡水', num: 1 }] }, order];
  assert.deepEqual(writeIndices(await plan(client)), [1], '一份居民订单要么完整交付，要么一件都不扣');
  client.weekly = null;
  assert.deepEqual((await plan(client)).actions, [], '未知周单既不交付，也不拒单重刷');

  client.onWater = [order]; client.weekly = 50; client.stock = 50;
  client.buildings = [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [], finishedProducts: [] } }];
  const refill = await plan(client, false, true);
  assert.deepEqual(writeIndices(refill), [1]);
  assert(refill.actions.findIndex(a => a.request === 'FinishWorkerOrderRequest')
    < refill.actions.findIndex(a => a.request === 'StartFactoryProduceRequest'), '先交居民单释放仓容，再安排补产');
  const queue = refill.actions.filter(a => a.request === 'StartFactoryProduceRequest');
  assert.deepEqual(queue.map(a => a.body.productId), ['烤鱼', '烤鱼', '烤鱼'],
    '50 件满仓交 3 件后只补释放的 3 个空间，下一轮不会再次重复补');
  for (const outcome of ['accepted', 'rejected', 'weekNowReady']) {
    const produced = [];
    const live = mock();
    live.otherWeekly = pending;
    live.buildings = structuredClone(client.buildings);
    let wroteResident = false;
    const actor = {
      player: live.player,
      async request(name, body, response) {
        if (name !== 'FinishWorkerOrderRequest') return live.request(name, body, response);
        wroteResident = true;
        if (outcome === 'rejected') throw Error('订单槽已刷新');
        live.stock -= 3;
        return { reward };
      },
      async sendWatch(name, body) {
        assert.equal(name, 'StartFactoryProduceRequest');
        produced.push(body.productId);
      },
    };
    const scopedPlan = await plan(actor, false, true);
    if (outcome === 'weekNowReady') live.otherStock = [{ itemId: '淡水', num: 5 }];
    await runWorldRound(actor, { ...protocol, StartFactoryProduceRequest: true }, scopedPlan,
      { allowMutate: true, config, player: live.player });
    assert.equal(wroteResident, outcome !== 'weekNowReady', '刚收的淡水凑齐整份周单时，原先的居民借料要取消');
    assert.equal(produced.length, outcome === 'accepted' ? 3 : 0, '只在居民交单已获服务端确认后，才使用它释放的容量排产');
  }
  client.stock = 47; client.onWater = []; client.buildings[0].factory.factoryQ = Array(3).fill({ productId: '烤鱼' });
  assert(!(await plan(client, false, true)).actions.some(a => a.request === 'StartFactoryProduceRequest'),
    '已经在产的 3 件覆盖了周单新缺口');

  const live = mock();
  live.otherWeekly = pending;
  live.buildings = [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [], finishedProducts: pending } }];
  const request = live.request.bind(live);
  live.request = async (name, body, response) => {
    if (name !== 'GainFactoryProduceRequest') return request(name, body, response);
    live.calls.push(name);
    live.otherStock = [{ itemId: '淡水', num: 5 }];
    live.buildings[0].factory.finishedProducts = [];
    return { products: { asset: pending } };
  };
  live.sendWatch = async name => live.calls.push(name);
  const fullProtocol = { ...protocol, GainFactoryProduceRequest: true, GainFactoryProduceResponse: true, StartFactoryProduceRequest: true };
  const player = live.player;
  const survey = await surveyWorld(live, fullProtocol, { config, player });
  const enabled = key => ['gainFactory', 'finishOrder', 'startProduce'].includes(key);
  const preliminary = planWorld(survey, { config, enabled });
  assert(preliminary.actions.some(a => a.request === 'GainFactoryProduceRequest'));
  await runWorldRound(live, fullProtocol, preliminary, { allowMutate: true, config, player, enabled });
  assert(live.calls.includes('GainFactoryProduceRequest'));
  assert(!live.calls.includes('FinishWorkerOrderRequest') && !live.calls.includes('StartFactoryProduceRequest'),
    '同轮收货已补齐整份周单：保留现有库存，不再按原计划借料或占用预期仓容');
}

async function testHarvestOrders() {
  const available = { ...protocol, GainFactoryProduceRequest: true, GainFactoryProduceResponse: true };
  function scenario({ finishAt = 0, confirm = true, reserved = false, pendingWeekly = false, cargoAfter = 0, pause = false, failRead = false } = {}) {
    const client = mock();
    client.stock = 0;
    client.weekly = pendingWeekly ? 3 : 0;
    client.otherWeekly = pendingWeekly ? [{ id: '淡水', num: 5 }] : [];
    const basic = client.request.bind(client);
    let collected = false, delivered = false;
    client.request = async (name, body, response) => {
      if (name === 'GainFactoryProduceRequest') {
        client.calls.push(name);
        collected = true; client.stock = 3;
        if (reserved) client.weekly = 3;
        if (cargoAfter) client.cargo = cargoAfter;
        return confirm ? { products: { asset: [{ id: '烤鱼', num: 3 }] } } : {};
      }
      if (name === 'OnWaterRequest') {
        if (failRead && collected) throw Error('收货后探测失败');
        client.calls.push(name);
        const done = Date.now() >= finishAt;
        return {
          building: [{ buildingId: '1食品厂', level: 1, factory: {
            factoryQ: done ? [] : [{ productId: '烤鱼', finishTime: finishAt / 1000 }],
            finishedProducts: done && !collected ? [{ id: '烤鱼', num: 3 }] : [],
          } }],
          workerOrder: delivered ? [] : [order],
        };
      }
      if (name === 'FinishWorkerOrderRequest') {
        assert(collected && client.stock >= 3 && client.cargo === 0 && (client.weekly === 0 || pendingWeekly));
        delivered = true;
      }
      return basic(name, body, response);
    };
    return { client, enabled: key => key === 'collect' || (key === 'finishOrder' && !(pause && collected)) };
  }
  for (const [cargoAfter, confirmed] of [[0, true], [2, false]]) {
    const { client } = scenario({ pendingWeekly: true, cargoAfter });
    const player = client.player;
    const initial = await surveyWorld(client, available, { config, player, includeCargo: true });
    const manual = planWorld(initial, { config, enabled: key => ['gainFactory', 'finishOrder', 'denyOrder'].includes(key),
      allowReroll: true, minOrderExp: null });
    assert(!manual.actions.some(a => a.kind === 'denyOrder'), '即使开了拒单，待收成品即将补足居民单时也要保留槽位');
    await runWorldRound(client, available, manual, { config, player, allowMutate: true, cargoEnabled: () => true });
    assert.equal(client.calls.includes('FinishWorkerOrderRequest'), confirmed,
      '收货后按实时库存再评估周单缺口和货轮，居民可交才发写请求');
  }
  const run = (s, options = {}) => runLoop(s.client, available, { rounds: 1, allowMutate: true, config,
    player: s.client.player, isEnabled: s.enabled, ...options });

  for (const options of [{}, { reserved: true }, { confirm: false }, { pause: true }]) {
    const s = scenario(options);
    await run(s);
    assert.equal(s.client.calls.filter(n => n === 'FinishWorkerOrderRequest').length, Object.keys(options).length ? 0 : 1);
    const followup = !options.pause && options.confirm !== false;
    assert.equal(s.client.calls.filter(n => n === 'AllItemRequest').length, followup ? (options.reserved ? 2 : 4) : 1,
      '居民交付确认后额外读取完整库存，核销本次材料预留');
    if (!Object.keys(options).length) assert(s.client.calls.lastIndexOf('AllItemRequest') > s.client.calls.indexOf('FinishWorkerOrderRequest'));
    assert.equal(s.client.calls.filter(n => n === 'AllResourceRequest').length, 1, '补交只核对订单库存和预留');
  }
  // Manual world run and the CLI share the same round executor, including reroll protection.
  for (const failRead of [false, true]) {
    const { client } = scenario({ failRead });
    const player = client.player;
    const initial = await surveyWorld(client, available, { config, player });
    const manual = planWorld(initial, { config, enabled: key => ['gainFactory', 'finishOrder', 'denyOrder'].includes(key),
      allowReroll: true, minOrderExp: null });
    assert(!manual.actions.some(a => a.kind === 'denyOrder'), '预计本轮收齐时不要先把订单拒掉');
    const result = await runWorldRound(client, available, manual, { config, player, allowMutate: true });
    assert.deepEqual(result.results.map(e => e.ok), [true, !failRead], '保留已确认的收货，单独报告补交或补交失败');
    assert.equal(result.results.at(-1).step.kind, failRead ? 'checkResidentOrders' : 'finishOrder');
  }
  const pending = { orderDecisions: [
    { index: 1, shortages: [{ id: '烤鱼', missing: 1 }] },
    { index: 2, shortages: [{ id: '烤鱼', missing: 1 }, { id: '淡水', missing: 1 }] },
    { index: 3, shortages: [{ id: '烤鱼', missing: 1 }] },
  ] };
  const haul = [{ step: { kind: 'collectProduct' }, ok: true, body: { reward: [{ product: { asset: [{ id: '烤鱼', num: 1 }] } }] } }];
  assert.deepEqual([...orderSlotsAfterHarvest(pending, haul, new Set([1]))], [3],
    '不重试本轮已尝试的槽，不为仍缺其他材料的订单重复查库存');
  const farm = [{ step: { kind: 'farm', request: 'FarmHarvestRequest' }, ok: true,
    body: { reward: [{ reward: { type: 0, id: '番茄', num: 2 }, critical: 1 }] } }];
  assert.deepEqual([...orderSlotsAfterHarvest({ orderDecisions: [{ index: 4, shortages: [{ id: '番茄', missing: 2 }] }] }, farm, new Set())], [4],
    '农田按 v74 的 CriticalAsset.reward 读取本次实际到账产物');

  const realNow = Date.now;
  let time = realNow();
  const start = time;
  const fast = scenario({ finishAt: start + 5000 });
  const deliveries = [];
  try {
    Date.now = () => time;
    await run(fast, { rounds: 2, everyMs: 10000, sleep: async ms => { time += ms; }, onStep: entry => {
      if (entry.step?.kind === 'finishOrder' && entry.ok) deliveries.push(time - start);
    } });
  } finally { Date.now = realNow; }
  assert.deepEqual(deliveries, [5250], '在两次常规轮之间，工厂到期收货后立即补交');
}
