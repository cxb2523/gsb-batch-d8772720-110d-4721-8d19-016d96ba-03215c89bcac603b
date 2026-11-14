import assert from 'node:assert/strict';
import { runWorld, submitResidentOrder, surveyWorld } from '../src/world.mjs';
import { beginOrderMaterialSpend, confirmOrderMaterialSpends } from '../src/order-reservations.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';

let sequence = 810000;
const protocol = Object.fromEntries(['OnWater', 'AllItem', 'WeekInfo', 'WeekOrderInfo', 'FinishWorkerOrder', 'BuildBuilding']
  .flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
const config = { tables: { GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] } } };
const action = { kind: 'build', request: 'BuildBuildingRequest', response: 'BuildBuildingResponse',
  body: { buildingId: 'test' }, costs: [{ id: 'fish', num: 3 }], label: '测试建造' };
function fixture(player = { playerId: ++sequence, worldId: 9001, level: 16 }) {
  const state = { stock: 10, writes: [], mode: 'ok' };
  const client = { async request(name) {
    if (name === 'AllItemRequest') {
      if (state.unavailable && state.writes.length) throw new Error('消费后库存暂不可读');
      return { items: [{ itemId: 'fish', num: state.stock }] };
    }
    if (name === 'OnWaterRequest') return { building: [], workerOrder: [{ index: 1, workerId: 1, requirements: [{ id: 'fish', num: 3 }] }] };
    if (name === 'WeekInfoRequest') return { activityTime: [] };
    if (name === 'BuildBuildingRequest' || name === 'FinishWorkerOrderRequest') {
      state.writes.push(name);
      if (state.mode === 'reject') throw Object.assign(new Error('明确拒绝'), { request: name, prompt: {} });
      if (state.mode === 'unknown') throw new Error('结果未知');
      return name === 'FinishWorkerOrderRequest' ? { reward: { asset: [{ id: 'EXP', num: 1 }] } } : {};
    }
    throw new Error('意外请求 ' + name);
  } };
  const run = options => runWorld(client, protocol, { actions: [action] }, { allowMutate: true, player, ...options });
  const read = () => surveyWorld(client, protocol, { config, player, ordersOnly: true });
  const submit = async () => {
    const survey = await read();
    return submitResidentOrder(client, protocol, { config, player, index: 1, orderKey: survey.orders[0].orderKey });
  };
  return { state, client, player, run, submit };
}
let count = 0;
async function test(name, run) { await run(); console.log('通过：' + name); count++; }

await test('直接海面执行被旧材料扣款阻止，同步后恢复', async () => {
  const f = fixture();
  beginOrderMaterialSpend(f.player, [{ id: 'fish', have: 10, need: 3 }], '旧联盟订单');
  assert.equal((await f.run()).results[0].skipped, true);
  assert.equal(f.state.writes.length, 0);
  f.state.stock = 7;
  assert.equal((await f.run()).results[0].ok, true);
  assert.doesNotThrow(() => confirmOrderMaterialSpends(f.player, new Map([['fish', 7]])), '明确结果后的完整新库存完成结算，不要求净下降');
});
await test('海面成功后换连接可补读库存，未知业务继续保护', async () => {
  for (const mode of ['ok', 'unknown']) {
    const first = fixture(); first.state.mode = mode; first.state.unavailable = true;
    await first.run();
    assert.throws(() => confirmOrderMaterialSpends(first.player, new Map([['fish', 0]])), /尚未确认/, '缓存余额不能替代业务证据后的完整读取');
    const replacement = fixture({ ...first.player, guildId: 22 });
    const result = (await replacement.run()).results[0];
    assert.equal(mode === 'ok' ? result.ok : result.skipped, true);
    assert.equal(replacement.state.writes.length, mode === 'ok' ? 1 : 0);
    assert.equal((await fixture().run()).results[0].ok, true, '其他账号不共享消费屏障');
  }
});
await test('明确拒绝释放海面材料，未发送取消也释放', async () => {
  const f = fixture(); f.state.mode = 'reject';
  assert.equal((await f.run()).results[0].ok, false);
  confirmOrderMaterialSpends(f.player, new Map([['fish', 10]]));
  f.state.mode = 'ok';
  assert.equal((await f.run()).results[0].ok, true);
  const paused = fixture(); let on = true;
  const guard = createActionGuard(paused.client, () => null, null, { player: paused.player, enabled: () => on });
  const result = await paused.run({ enabled: () => on, beforeStep: async step => {
    const ticket = await guard.before(step); on = false; return ticket;
  }, cancelStep: guard.cancel, afterStep: guard.after });
  assert.equal(paused.state.writes.length, 0);
  assert.equal(result.results.some(row => row.ok), false);
  confirmOrderMaterialSpends(paused.player, new Map([['fish', 10]]));
});
await test('手动居民交单与旧消费者双向共享未同步扣款', async () => {
  const f = fixture();
  beginOrderMaterialSpend(f.player, [{ id: 'fish', have: 10, need: 3 }], '旧博物馆');
  await assert.rejects(f.submit(), /尚未确认/);
  assert.equal(f.state.writes.length, 0);
  f.state.stock = 7;
  await f.submit();
  assert.deepEqual(f.state.writes, ['FinishWorkerOrderRequest']);
  assert.doesNotThrow(() => confirmOrderMaterialSpends(f.player, new Map([['fish', 7]])));
});
await test('手动交单明确拒绝可重读重试，未知结果保留材料', async () => {
  for (const mode of ['reject', 'unknown']) {
    const f = fixture(); f.state.mode = mode;
    await assert.rejects(f.submit());
    if (mode === 'reject') {
      confirmOrderMaterialSpends(f.player, new Map([['fish', 10]]));
      f.state.mode = 'ok'; await f.submit();
      assert.equal(f.state.writes.length, 2);
    } else assert.throws(() => confirmOrderMaterialSpends(f.player, new Map([['fish', 10]])), /尚未确认/);
  }
});
console.log('海面材料迁移专项 ' + count + '/' + count + ' 通过');
