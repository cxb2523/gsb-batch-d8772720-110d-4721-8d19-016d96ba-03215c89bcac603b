// Issue #15 regression: fake clients only; never connect to a game account.
import assert from 'node:assert/strict';
import { loadProtocol } from '../src/proto.mjs';
import { runWorld, surveyWorld } from '../src/world.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import {
  beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialSpends,
  pendingFarmMaterialSpends, settleFarmMaterialSpend,
} from '../src/order-reservations.mjs';

const protocol = loadProtocol();
for (const name of ['FarmPlantRequest', 'OkResponse', 'OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse']) {
  assert.equal(typeof protocol[name]?.encode, 'function', '真实协议必须包含 ' + name);
}

let nextPlayer = 1515000;
const seed = crop => crop + '种子';
const emptyPlot = buildingId => ({ buildingId, level: 1, farm: null });
const plant = (crop, buildingId = '1农田') => ({
  kind: 'farm', request: 'FarmPlantRequest', response: null,
  body: { args: [{ buildingId, productId: crop }] },
  costs: [{ id: seed(crop), num: 1 }], label: '农田播种 ' + crop,
});
const ordinary = {
  kind: 'startProduce', request: 'StartFactoryProduceRequest', response: 'OkResponse',
  body: { buildingId: '1加工厂', productId: '测试加工品' }, costs: [{ id: '木材', num: 1 }], label: '普通材料消费',
};

function fixture({ player, state } = {}) {
  player ??= { playerId: ++nextPlayer, worldId: 9001, level: 20 };
  state ??= {
    stock: new Map([['番茄种子', 20], ['小麦种子', 20], ['木材', 20]]),
    buildings: ['1农田', '2农田', '3农田'].map(emptyPlot),
    mode: 'normal', writes: [], reads: [], waterError: null, bagError: null,
    waterTransform: null, bagTransform: null, onRead: null,
  };
  const client = {
    connected: true, serverClockOffsetMs: 0,
    async request(name, body, response, timeout) {
      if (name === 'OnWaterRequest') {
        state.reads.push(name);
        await state.onRead?.(name);
        if (state.waterError) throw state.waterError;
        const value = { building: structuredClone(state.buildings), autoFarming: false };
        return state.waterTransform ? state.waterTransform(value) : value;
      }
      if (name === 'AllItemRequest') {
        state.reads.push(name);
        await state.onRead?.(name);
        if (state.bagError) throw state.bagError;
        const value = { items: [...state.stock].map(([itemId, num]) => ({ itemId, num })) };
        return state.bagTransform ? state.bagTransform(value) : value;
      }
      if (name === 'FarmPlantRequest') {
        assert.equal(response, 'OkResponse', '播种必须等待通用业务回包，不能使用静默窗口');
        assert.ok(Number.isFinite(timeout) && timeout > 0);
        state.writes.push({ name, body: structuredClone(body) });
        if (state.mode === 'rejectLate') {
          await new Promise(resolve => setTimeout(resolve, 450));
          throw Object.assign(new Error('明确拒绝播种'), { request: name, prompt: { prompt: 1 } });
        }
        if (state.mode === 'unknown') throw new Error('timeout waiting for OkResponse (sent FarmPlantRequest)');
        if (state.mode === 'emptyReply') return {};
        for (const arg of body.args) {
          const plot = state.buildings.find(row => row.buildingId === arg.buildingId);
          assert.ok(plot, '测试只允许在现有地块播种');
          const now = Math.floor(Date.now() / 1000);
          plot.farm = { productId: arg.productId, plantTime: now, ripeTime: now + 60 };
          if (state.mode !== 'replenished') state.stock.set(seed(arg.productId), state.stock.get(seed(arg.productId)) - 1);
        }
        if (state.mode === 'timeoutAfterPlant') throw new Error('timeout waiting for OkResponse (sent FarmPlantRequest)');
        return {};
      }
      if (name === 'StartFactoryProduceRequest') {
        state.writes.push({ name, body: structuredClone(body) });
        state.stock.set('木材', state.stock.get('木材') - 1);
        return {};
      }
      throw new Error('测试出现意外请求 ' + name);
    },
    async sendWatch() { throw new Error('FarmPlantRequest 不得再走 sendWatch'); },
  };
  const run = (step = plant('番茄'), options = {}) => runWorld(client, protocol, { actions: [step] }, {
    allowMutate: true, player, ...options,
  });
  const pending = () => pendingFarmMaterialSpends(player);
  const survey = () => surveyWorld(client, protocol, { player, ordersOnly: true, includeWeekOrder: false });
  return { player, state, client, run, pending, survey };
}

function showPlanted(f, crop = '番茄', buildingId = '1农田') {
  const now = Math.floor(Date.now() / 1000);
  f.state.buildings.find(row => row.buildingId === buildingId).farm = { productId: crop, plantTime: now, ripeTime: now + 60 };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log('通过：' + name);
  passed++;
}

await test('播种等待真实 OkResponse，正常扣款后回读地块与完整库存确认', async () => {
  const f = fixture();
  const result = (await f.run()).results[0];
  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed');
  assert.equal('sent' in result, false);
  assert.equal(f.state.stock.get('番茄种子'), 19);
  assert.equal(f.pending().length, 0);
  assert.ok(f.state.reads.filter(name => name === 'OnWaterRequest').length >= 2);
  assert.ok(f.state.reads.filter(name => name === 'AllItemRequest').length >= 2);
});

await test('成功播种后补货掩盖扣款，按地块和完整新库存解除预留', async () => {
  const f = fixture(); f.state.mode = 'replenished';
  assert.equal((await f.run()).results[0].ok, true);
  assert.equal(f.state.stock.get('番茄种子'), 20);
  assert.equal(f.pending().length, 0);
  assert.equal((await f.run(plant('番茄', '2农田'))).results[0].ok, true);
  assert.equal(f.state.writes.length, 2);
});

await test('超过旧 400ms 窗口的明确拒绝仍归属播种并释放预留', async () => {
  const f = fixture(); f.state.mode = 'rejectLate';
  const result = (await f.run()).results[0];
  assert.equal(result.ok, false);
  assert.match(result.error, /明确拒绝播种/);
  assert.equal(f.pending().length, 0);
  f.state.mode = 'normal';
  assert.equal((await f.run()).results[0].ok, true);
  assert.equal(f.state.writes.length, 2);
});

await test('未知结果继续保护同一种子，也保护同地块的另一种作物', async () => {
  const f = fixture(); f.state.mode = 'unknown';
  assert.equal((await f.run()).results[0].ok, false);
  assert.equal(f.pending().length, 1);
  f.state.mode = 'normal';
  assert.equal((await f.run(plant('番茄', '2农田'))).results[0].skipped, true);
  assert.equal((await f.run(plant('小麦', '1农田'))).results[0].skipped, true);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.pending().length, 1);
});

await test('未知番茄结果不阻止其他地块消费小麦种子', async () => {
  const f = fixture(); f.state.mode = 'unknown'; await f.run();
  f.state.mode = 'normal';
  assert.equal((await f.run(plant('小麦', '2农田'))).results[0].ok, true);
  assert.deepEqual(f.state.writes.map(row => row.body.args[0].productId), ['番茄', '小麦']);
  assert.equal(f.pending().length, 1, '不能顺便释放仍未知的番茄记录');
});

await test('未知结果跨连接和公会变化保留，其他账号不受影响', async () => {
  const first = fixture(); first.state.mode = 'unknown'; await first.run();
  first.state.mode = 'normal';
  const replacement = fixture({ player: { ...first.player, guildId: 123 }, state: first.state });
  assert.equal((await replacement.run(plant('番茄', '2农田'))).results[0].skipped, true);
  assert.equal(first.state.writes.length, 1);
  assert.equal((await fixture().run()).results[0].ok, true);
  assert.equal(first.pending().length, 1);
});

await test('未知结果后来在地块上确认，由普通材料消费触发结算', async () => {
  const f = fixture(); f.state.mode = 'unknown'; await f.run();
  const now = Math.floor(Date.now() / 1000);
  f.state.buildings[0].farm = { productId: '番茄', plantTime: now, ripeTime: now + 60 };
  f.state.mode = 'normal';
  assert.equal((await f.run(ordinary)).results[0].ok, true);
  assert.equal(f.pending().length, 0);
  assert.deepEqual(f.state.writes.map(row => row.name), ['FarmPlantRequest', 'StartFactoryProduceRequest']);
});

await test('旧播种回读失败不阻止无关材料消费者', async () => {
  const f = fixture(); f.state.mode = 'unknown'; await f.run();
  f.state.waterError = new Error('OnWaterRequest 暂时不可读');
  assert.equal((await f.run(ordinary)).results[0].ok, true);
  assert.equal(f.pending().length, 1);
  assert.equal(f.state.writes.length, 2);
});

await test('空地的 null 和空 productId 表示均可发送，已有作物不可覆盖', async () => {
  const empty = fixture(); empty.state.buildings[0].farm = { productId: '', plantTime: 0, ripeTime: 0 };
  assert.equal((await empty.run()).results[0].ok, true);
  const occupied = fixture(); const now = Math.floor(Date.now() / 1000);
  occupied.state.buildings[0].farm = { productId: '小麦', plantTime: now, ripeTime: now + 60 };
  assert.equal((await occupied.run()).results[0].skipped, true);
  assert.equal(occupied.state.writes.length, 0);
  assert.equal(occupied.pending().length, 0);
});

await test('发送前缺失地块、重复地块、未建成与升级中均不写入', async () => {
  for (const mutate of [
    f => { f.state.buildings.shift(); },
    f => { f.state.buildings.push(emptyPlot('1农田')); },
    f => { f.state.buildings[0].level = 0; },
    f => { f.state.buildings[0].buildStartTime = 123; f.state.buildings[0].buildFinishTime = 456; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await f.run()).results[0].ok, false);
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.pending().length, 0);
  }
});

await test('回读缺失或重复地块、其他作物与无效生长时间不能确认播种', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const mutate of [
    water => { water.building = water.building.filter(row => row.buildingId !== '1农田'); },
    water => { water.building.push(structuredClone(water.building[0])); },
    water => { water.building[0].farm.productId = '小麦'; },
    water => { water.building[0].farm.plantTime = 0; },
    water => { water.building[0].farm.ripeTime = 0; },
    water => { water.building[0].farm.ripeTime = now - 1; },
  ]) {
    const f = fixture(); f.state.mode = 'replenished';
    f.state.waterTransform = value => { if (f.state.writes.length) mutate(value); return value; };
    const result = (await f.run()).results[0];
    assert.equal(result.ok, false);
    assert.equal(f.pending().length, 1);
    assert.equal(f.state.writes.length, 1);
  }
});

await test('仅 OkResponse 但地块仍为空，不能释放未知播种记录', async () => {
  const f = fixture(); f.state.mode = 'emptyReply';
  const result = (await f.run()).results[0];
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
  assert.equal(f.pending().length, 1);
  assert.equal((await f.run()).results[0].skipped, true);
  assert.equal(f.state.writes.length, 1);
});

await test('发送前完整库存校验失败不能产生写操作或材料记录', async () => {
  for (const transform of [
    () => ({}),
    value => { value.items[0].num = -1; return value; },
    value => { value.items.push({ itemId: '番茄种子', num: 20 }); return value; },
  ]) {
    const f = fixture(); f.state.bagTransform = transform;
    assert.equal((await f.run()).results[0].ok, false);
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.pending().length, 0);
  }
});

await test('播种后的库存读取失败或数据不完整保留记录，恢复读取后才结算', async () => {
  for (const fail of ['throw', 'malformed']) {
    const f = fixture(); f.state.mode = 'replenished';
    f.state.bagTransform = value => {
      if (!f.state.writes.length) return value;
      if (fail === 'throw') throw new Error('库存读取失败');
      return {};
    };
    assert.equal((await f.run()).results[0].ok, false);
    assert.equal(f.pending().length, 1);
    f.state.bagTransform = null;
    assert.equal((await f.run(ordinary)).results[0].ok, true);
    assert.equal(f.pending().length, 0);
  }
});

await test('发送前关闭开关取消已准备的材料记录，不发播种请求', async () => {
  const f = fixture(); let enabled = true;
  const guard = createActionGuard(f.client, () => null, null, { player: f.player, enabled: () => enabled });
  await f.run(plant('番茄'), {
    enabled: () => enabled,
    beforeStep: async step => { const ticket = await guard.before(step); enabled = false; return ticket; },
    afterStep: guard.after, cancelStep: guard.cancel,
  });
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.pending().length, 0);
});

await test('未知播种在下轮只读探测中结算，收割前保存确认结果', async () => {
  const f = fixture(); f.state.mode = 'unknown'; await f.run();
  assert.equal(f.pending().length, 1);
  showPlanted(f);
  const readsBefore = f.state.reads.length;
  const state = await f.survey();
  assert.equal(state.buildings[0].farm.productId, '番茄');
  assert.deepEqual(f.state.reads.slice(readsBefore), ['OnWaterRequest', 'AllItemRequest']);
  assert.equal(f.pending().length, 0);
  assert.equal(f.state.writes.length, 1, '只读探测不发送新消费');
  f.state.buildings[0].farm = null; // 后续收割不能让已经确认的播种重新出现。
  await f.survey();
  assert.equal(f.pending().length, 0);
  assert.equal(f.state.writes.length, 1);
});

await test('只读探测的库存缺失或重复时不能释放已观察作物的旧记录', async () => {
  for (const transform of [
    () => ({}),
    value => { value.items.push({ itemId: '番茄种子', num: 20 }); return value; },
  ]) {
    const f = fixture(); f.state.mode = 'unknown'; await f.run(); showPlanted(f);
    f.state.bagTransform = transform;
    await f.survey();
    assert.equal(f.pending().length, 1);
    assert.equal(f.state.writes.length, 1);
    f.state.bagTransform = null;
    await f.survey();
    assert.equal(f.pending().length, 0);
  }
});

await test('只读探测期间角色或区服变化，不能结算旧账号的播种记录', async () => {
  for (const field of ['playerId', 'worldId']) {
    for (const when of ['OnWaterRequest', 'AllItemRequest']) {
      const f = fixture(); f.state.mode = 'unknown'; await f.run(); showPlanted(f);
      const oldPlayer = { ...f.player };
      f.state.onRead = name => { if (name === when) f.player[field] += 100000; };
      await f.survey();
      assert.equal(pendingFarmMaterialSpends(oldPlayer).length, 1);
      assert.equal(f.pending().length, 0, '旧记录不能迁移到新身份');
      assert.equal(f.state.writes.length, 1);
    }
  }
});

await test('发送前回读期间角色或区服变化立即停止，旧账号记录不被释放', async () => {
  for (const field of ['playerId', 'worldId']) {
    for (const when of ['OnWaterRequest', 'AllItemRequest']) {
      const f = fixture(); f.state.mode = 'unknown'; await f.run(); showPlanted(f);
      const oldPlayer = { ...f.player };
      const readsBefore = f.state.reads.length;
      f.state.onRead = name => { if (name === when) f.player[field] += 100000; };
      const result = (await f.run(plant('小麦', '2农田'))).results[0];
      assert.equal(result.skipped, true);
      assert.match(result.error, /账号已切换/);
      assert.equal(pendingFarmMaterialSpends(oldPlayer).length, 1);
      assert.equal(f.state.writes.length, 1);
      assert.deepEqual(f.state.reads.slice(readsBefore), when === 'OnWaterRequest'
        ? ['OnWaterRequest'] : ['OnWaterRequest', 'AllItemRequest'], '发现切号后不再继续请求');
    }
  }
});

await test('缺少 OkResponse 协议时不发播种请求，也不降级到 sendWatch', async () => {
  const f = fixture(); let watchCalls = 0;
  f.client.sendWatch = async () => { watchCalls++; throw new Error('不应降级'); };
  const result = await runWorld(f.client, { ...protocol, OkResponse: undefined }, { actions: [plant('番茄')] }, {
    allowMutate: true, player: f.player,
  });
  assert.equal(result.results[0].ok, false);
  assert.equal(f.state.writes.length, 0);
  assert.equal(watchCalls, 0);
  assert.equal(f.pending().length, 0);
});

await test('业务响应超时但实际已种植，回读作物与库存仍可确认成功', async () => {
  const f = fixture(); f.state.mode = 'timeoutAfterPlant';
  const result = (await f.run()).results[0];
  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed');
  assert.equal('error' in result, false);
  assert.equal(f.state.stock.get('番茄种子'), 19);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.pending().length, 0);
});

await test('准备与回读之间切号，不用旧连接数据结算另一账号的播种', async () => {
  const first = fixture(), second = fixture();
  const oldPlayer = { ...first.player };
  const step = plant('番茄');
  const guard = createActionGuard(first.client, () => null, null, { player: first.player });
  const ticket = await guard.before(step);
  const otherHandle = beginOrderMaterialSpend(second.player, [{ id: '番茄种子', have: 20, need: 1 }], '另一账号播种', {
    farm: { args: structuredClone(step.body.args) },
  });
  assert.equal(pendingFarmMaterialSpends(oldPlayer).length, 1);
  assert.equal(second.pending().length, 1);
  showPlanted(first); // 若错误使用新账号身份，这份旧连接状态会误解开另一账号记录。
  Object.assign(first.player, second.player);
  const readsBefore = first.state.reads.length;
  const outcome = { ok: true };
  await guard.after(step, ticket, outcome);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'unknown');
  assert.match(outcome.reason, /账号已切换/);
  assert.equal(first.state.reads.length, readsBefore, '发现切号后不得读取旧连接的任何状态');
  assert.equal(first.state.writes.length, 0);
  assert.equal(pendingFarmMaterialSpends(oldPlayer).length, 1);
  assert.deepEqual(second.pending(), [otherHandle]);
});

await test('旧消费者仍全账号阻止，多个播种预留独立取消且旧句柄不能释放新记录', () => {
  const f = fixture();
  const stock = new Map(f.state.stock);
  const legacy = beginOrderMaterialSpend(f.player, [{ id: '木材', have: 20, need: 1 }], '旧消费者');
  const beginFarm = (crop, buildingId) => beginOrderMaterialSpend(f.player, [{ id: seed(crop), have: 20, need: 1 }], '播种' + crop, {
    farm: { args: [{ buildingId, productId: crop }] },
  });
  assert.throws(() => confirmOrderMaterialSpends(f.player, stock, ['番茄种子']), { code: 'ORDER_MATERIAL_SPEND_PENDING' });
  assert.throws(() => beginFarm('番茄', '1农田'), /尚未确认/);
  assert.throws(() => beginOrderMaterialSpend(f.player, [{ id: '小麦种子', have: 20, need: 1 }], '另一个旧消费者'), /尚未确认/);
  cancelOrderMaterialSpend(legacy);
  const first = beginFarm('番茄', '1农田');
  const second = beginFarm('小麦', '2农田');
  assert.deepEqual(f.pending(), [first, second]);
  assert.doesNotThrow(() => confirmOrderMaterialSpends(f.player, stock, ['木材']));
  assert.throws(() => confirmOrderMaterialSpends(f.player, stock, ['番茄种子']), { code: 'ORDER_MATERIAL_SPEND_PENDING' });
  assert.throws(() => confirmOrderMaterialSpends(f.player, stock, ['小麦种子']), { code: 'ORDER_MATERIAL_SPEND_PENDING' });
  cancelOrderMaterialSpend(first);
  assert.deepEqual(f.pending(), [second]);
  const replacement = beginFarm('番茄', '1农田');
  cancelOrderMaterialSpend(first);
  assert.equal(settleFarmMaterialSpend(f.player, first), false);
  assert.deepEqual(f.pending(), [second, replacement], '旧句柄的取消/结算不能释放新句柄');
  assert.equal(settleFarmMaterialSpend(fixture().player, replacement), false, '另一账号不能结算此预留');
  assert.equal(settleFarmMaterialSpend(f.player, replacement), true);
  assert.deepEqual(f.pending(), [second]);
  cancelOrderMaterialSpend(second);
  assert.equal(f.pending().length, 0);
});

console.log('农田播种专项 ' + passed + '/' + passed + ' 通过');
