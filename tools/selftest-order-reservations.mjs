import assert from 'node:assert/strict';
import { readOrderReservedStock } from '../src/order-reservations.mjs';

const now = Math.floor(Date.now() / 1000);
const config = { tables: { CargoUnlockCfg: { data: [{ index: 1, playerLevel: 9 }] } } };
const names = ['OnWater', 'AllItem', 'WeekInfo', 'WeekOrderInfo', 'CargoShips'];
const protocol = Object.fromEntries(names.flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
const asset = (id, num) => ({ type: 0, id, num });
function fixture() {
  const player = { playerId: { low: 1, high: 2097152 }, worldId: 1000001, level: 20, guildId: 0 };
  const responses = {
    OnWaterRequest: { workerOrder: [{ index: 1, workerId: 8, requirements: [asset('fish', 5)] }] },
    AllItemRequest: { items: [{ itemId: 'fish', num: 20 }, { itemId: 'wood', num: 4 }, { itemId: 'iron', num: 10 }] },
    WeekInfoRequest: { activityTime: [{ type: 5, period: 1, startTime: now - 100, endTime: now + 1000 }] },
    WeekOrderInfoRequest: { order: [asset('fish', 10), asset('wood', 10), asset('cloth', 3)], isGotFinal: false },
    CargoShipsRequest: { ship: [{ status: 0, orderItem: [{ filled: false, asset: asset('fish', 3) }, { filled: true, asset: asset('fish', 100) }] }] },
  };
  const calls = [];
  let hook = () => {};
  const client = { async request(name, body, response) {
    calls.push(name);
    assert.deepEqual(body, {});
    assert.equal(response, name.replace(/Request$/, 'Response'));
    await hook(name);
    if (responses[name] instanceof Error) throw responses[name];
    return structuredClone(responses[name]);
  } };
  return { player, responses, client, calls,
    hook: value => { hook = value; },
    read: (options = {}, selectedProtocol = protocol, selectedConfig = config) => readOrderReservedStock(client, selectedProtocol, selectedConfig, { player, ...options }),
  };
}

export async function testOrderReservations() {
  const f = fixture();
  const state = await f.read();
  assert.deepEqual([...state.stock], [['fish', 20], ['wood', 4], ['iron', 10]]);
  assert.equal(state.reservations.weekly.get('fish'), 10);
  assert.equal(state.reservations.cargo.get('fish'), 3);
  assert.equal(state.reservations.resident.get('fish'), 5);
  assert.equal(state.reserved.get('fish'), 18);
  assert.equal(state.available.get('fish'), 2);
  assert.equal(state.available.get('wood'), 0, 'reservations exceeding stock never produce negative availability');
  assert.equal(state.available.get('cloth'), 0, 'items only present in demand are explicit zero availability');
  assert.equal(state.available.get('iron'), 10);
  assert.equal(state.stock.get('fish'), 20, 'available budget must not mutate the observed inventory');

  f.responses.OnWaterRequest.workerOrder.push(
    { index: 2, refreshTime: now + 1, requirements: [asset('fish', 1000)] },
    { index: 3, refreshTime: now - 1, requirements: [asset('fish', 1000)] },
    { index: 4, requirements: [] },
  );
  assert.equal((await f.read()).reserved.get('fish'), 18);
  f.responses.WeekOrderInfoRequest.isGotFinal = true;
  assert.equal((await f.read()).available.get('fish'), 12, 'completed weekly orders no longer hold stock');

  const lockedCargo = fixture();
  lockedCargo.player.level = 8;
  assert.equal((await lockedCargo.read()).reservations.cargo.size, 0);
  assert(!lockedCargo.calls.includes('CargoShipsRequest'));
  const noWeek = fixture(); noWeek.responses.WeekInfoRequest.activityTime = [];
  assert.equal((await noWeek.read()).reservations.weekly.size, 0);
  assert(!noWeek.calls.includes('WeekOrderInfoRequest'));

  for (const name of ['OnWaterRequest', 'AllItemRequest', 'WeekInfoRequest', 'WeekOrderInfoRequest', 'CargoShipsRequest']) {
    const broken = fixture(); broken.responses[name] = {};
    await assert.rejects(broken.read(), undefined, name + ' missing payload must fail closed');
    const rejected = fixture(); rejected.responses[name] = new Error('read timeout');
    await assert.rejects(rejected.read(), /read timeout/, name + ' failure must never yield empty reservations');
  }
  for (const mutate of [
    f => { f.responses.AllItemRequest.items[0].num = -1; },
    f => { f.responses.AllItemRequest.items.push({ itemId: 'fish', num: 1 }); },
    f => { f.responses.CargoShipsRequest.ship[0].orderItem[0].filled = undefined; },
    f => { f.responses.OnWaterRequest.workerOrder[0].requirements = []; },
    f => { f.responses.OnWaterRequest.workerOrder.push({ index: 1, requirements: [] }); },
    f => { f.responses.OnWaterRequest.workerOrder[0].requirements[0].num = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.responses.OnWaterRequest.workerOrder[0].requirements[0].type = 1; },
    f => { f.responses.WeekInfoRequest.activityTime[0].endTime = null; },
  ]) {
    const broken = fixture(); mutate(broken);
    await assert.rejects(broken.read());
  }
  const noProtocol = fixture();
  await assert.rejects(noProtocol.read({}, { ...protocol, WeekOrderInfoResponse: undefined }), /协议缺少周订单/);
  await assert.rejects(fixture().read({}, protocol, { tables: {} }), /贸易港开放条件/);
  const absent = fixture(); delete absent.player.playerId;
  await assert.rejects(absent.read(), /账号身份/);
  assert.equal(absent.calls.length, 0);

  const paused = fixture();
  await assert.rejects(paused.read({ enabled: () => false }), /已暂停/);
  assert.equal(paused.calls.length, 0);
  for (const when of ['AllItemRequest', 'WeekOrderInfoRequest']) {
    const cancelled = fixture(); let on = true;
    cancelled.hook(name => { if (name === when) on = false; });
    await assert.rejects(cancelled.read({ enabled: () => on }), /已暂停/, when);
  }
  for (const field of ['playerId', 'worldId', 'guildId', 'level']) {
    for (const when of ['AllItemRequest', 'WeekOrderInfoRequest']) {
      const changed = fixture();
      changed.hook(name => { if (name === when) changed.player[field] = 99; });
      await assert.rejects(changed.read(), /账号身份已变化/, field + ' during ' + when);
    }
  }
  const nestedId = fixture();
  nestedId.hook(name => { if (name === 'WeekOrderInfoRequest') nestedId.player.playerId.low = 2; });
  await assert.rejects(nestedId.read(), /账号身份已变化/, 'do not lose int64 precision in identity checks');
  const first = fixture(), second = fixture();
  second.player.playerId = 55;
  second.responses.AllItemRequest.items[0].num = 100;
  const [one, two] = await Promise.all([first.read(), second.read()]);
  assert.equal(one.available.get('fish'), 2);
  assert.equal(two.available.get('fish'), 82, 'parallel accounts cannot share budgets');
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testOrderReservations();
  console.log('order reservations ok: shared budgets, refreshing slots, missing reads, cancellation and identity isolation');
}
