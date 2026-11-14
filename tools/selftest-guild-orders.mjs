import assert from 'node:assert/strict';
import { readGuildOrderView, serviceGuildOrders } from '../src/guild-orders.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, pendingOrderMaterialSpends } from '../src/order-reservations.mjs';

const stamp = Math.floor(Date.now() / 1000);
const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 16 }] },
  CargoUnlockCfg: { data: [{ index: 1, playerLevel: 9 }] },
  GuildOrderNumCfg: { data: [{ season: 1, playerLevel: 1, maxNum: -1 }, { season: 2, playerLevel: 1, maxNum: 10 },
    { season: 2, playerLevel: 25, maxNum: -1 }] },
  GuildOrderCfg: { data: [{ itemId: 'WHEAT' }] },
}, materialName: id => ({ WHEAT: '小麦', MERIT: '功勋' })[id] || id };
const names = ['GuildInfo', 'GuildOrder', 'GuildCityInfo', 'CounterInfo', 'OnWater', 'AllItem', 'WeekInfo', 'WeekOrderInfo', 'CargoShips', 'FinishGuildOrder'];
const protocol = Object.fromEntries(names.flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
const asset = n => ({ id: 'WHEAT', type: 0, num: n });
let serial = 10;
function fixture() {
  const player = { playerId: ++serial, guildId: { low: 7, high: 2097152 }, worldId: 2000001, level: 20 };
  const bodies = {
    GuildInfoRequest: { guild: { guildId: player.guildId } },
    GuildOrderRequest: { order: { requirements: [asset(5)], nextRefreshTime: stamp + 86400 } },
    GuildCityInfoRequest: { cities: [{ cityId: 1, recommended: false }, { cityId: 2, recommended: true }] },
    CounterInfoRequest: { counters: [] },
    OnWaterRequest: { workerOrder: [] },
    AllItemRequest: { items: [{ itemId: 'WHEAT', num: 30 }] },
    WeekInfoRequest: { activityTime: [] },
    WeekOrderInfoRequest: { order: [asset(10)], isGotFinal: false },
    CargoShipsRequest: { ship: [] },
    FinishGuildOrderRequest: { reward: { asset: [{ id: 'MERIT', type: 0, num: 225 }] } },
  };
  const calls = [], reports = [];
  let hook = () => {};
  const client = { promptNames: { 95: 'NO_GUILD' }, async request(name, body, response) {
    calls.push({ name, body });
    assert.equal(response, name.replace(/Request$/, 'Response'));
    await hook(name, body);
    const result = bodies[name];
    if (result instanceof Error) throw result;
    if (name === 'FinishGuildOrderRequest' && result?.reward?.asset?.length) {
      for (const cost of bodies.GuildOrderRequest.order.requirements) {
        bodies.AllItemRequest.items.find(item => item.itemId === cost.id).num -= cost.num;
      }
    }
    return structuredClone(result);
  } };
  const options = { player, enabled: () => true, report: row => reports.push(row) };
  return { player, bodies, client, calls, reports, options,
    hook(fn) { hook = fn; },
    run: more => serviceGuildOrders(client, protocol, config, { ...options, ...more }),
    writes: () => calls.filter(call => call.name === 'FinishGuildOrderRequest'),
  };
}

export async function testGuildOrders() {
  const off = fixture();
  assert((await serviceGuildOrders(off.client, protocol, config, { player: off.player })).skipped);
  assert.equal(off.calls.length, 0, 'automatic order submission requires an explicit enabled function');
  const locked = fixture();
  locked.player.level = 15;
  assert.match((await locked.run()).reason, /16/);
  assert.equal(locked.calls.length, 0);
  const noGuild = fixture();
  noGuild.player.guildId = 0;
  assert.match((await noGuild.run()).reason, /未加入联盟/);
  assert.equal(noGuild.calls.length, 0);

  const f = fixture();
  const view = await readGuildOrderView(f.client, protocol, config, f.options);
  assert.equal(view.cityId, 2);
  assert.equal(view.maxNum, 10, 'must not use season 1 unlimited quota');
  assert.equal(view.doneToday, 0, 'successful sparse full counter snapshot starts at zero');
  assert.equal(view.canFinish, true);
  assert.equal((await f.run()).ok, true);
  assert.deepEqual(f.writes(), [{ name: 'FinishGuildOrderRequest', body: { cityId: 2 } }]);
  assert(f.calls.filter(c => c.name === 'GuildOrderRequest').length >= 3, 'preview and execution reread the order');
  assert.equal(f.reports.at(-1).key, 'guildOrders');
  assert.match((await f.run()).reason, /尚未确认/, 'stale count does not repeat even with explicit success reply');
  assert.equal(f.writes().length, 1);
  f.bodies.CounterInfoRequest = { counters: [{ type: 'DAILY_FINISH_GUILD_ORDER', num: 1 }] };
  assert.match((await f.run()).reason, /重新核对/);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.writes().length, 2);

  const production = fixture();
  production.hook(name=>{if(name==='FinishGuildOrderRequest'){
    production.bodies.AllItemRequest.items[0].num+=10;
    production.bodies.CounterInfoRequest={counters:[{type:'DAILY_FINISH_GUILD_ORDER',num:production.writes().length}]};
  }});
  assert.equal((await production.run()).ok,true);
  assert.equal(production.bodies.AllItemRequest.items[0].num,35);
  assert.equal(pendingOrderMaterialSpends(production.player).length,0,'明确奖励后的完整库存允许补产抵消扣款');
  assert.match((await production.run()).reason,/重新核对/);
  assert.equal((await production.run()).ok,true);
  assert.equal(production.writes().length,2);

  const lostAccepted=fixture();
  lostAccepted.hook(name=>{if(name==='FinishGuildOrderRequest'){
    lostAccepted.bodies.AllItemRequest.items[0].num+=5;
    lostAccepted.bodies.CounterInfoRequest={counters:[{type:'DAILY_FINISH_GUILD_ORDER',num:1}]};
    lostAccepted.bodies.FinishGuildOrderRequest=new Error('accepted reply lost');
  }});
  assert.match((await lostAccepted.run()).error,/结果未确认/);
  assert.equal(pendingOrderMaterialSpends(lostAccepted.player).length,1);
  assert.match((await serviceGuildOrders({...lostAccepted.client},protocol,config,lostAccepted.options)).reason,/重新核对/);
  assert.equal(pendingOrderMaterialSpends(lostAccepted.player).length,0,'跨连接按完成计数和新库存核销未知扣款');
  assert.equal(lostAccepted.writes().length,1);

  const incomplete=fixture();
  incomplete.hook(name=>{if(name==='AllItemRequest'&&incomplete.writes().length)incomplete.bodies.AllItemRequest={};});
  assert.equal((await incomplete.run()).ok,true);
  assert.equal(pendingOrderMaterialSpends(incomplete.player).length,1,'业务回执不能替代完整库存');
  const unrelated=beginOrderMaterialSpend(incomplete.player,[{id:'wood',have:20,need:1}],'无关材料',{operation:{}});cancelOrderMaterialSpend(unrelated);
  assert.equal(pendingOrderMaterialSpends(incomplete.player).length,1,'无关材料不释放或占用旧小麦票据');
  incomplete.hook(()=>{});incomplete.bodies.AllItemRequest={items:[{itemId:'WHEAT',num:50}]};
  await incomplete.run();assert.equal(pendingOrderMaterialSpends(incomplete.player).length,0);

  const held = fixture();
  held.bodies.WeekInfoRequest.activityTime = [{ type: 5, period: 1, startTime: stamp - 100, endTime: stamp + 86400 }];
  held.bodies.OnWaterRequest.workerOrder = [{ index: 1, requirements: [asset(10)] }];
  held.bodies.CargoShipsRequest.ship = [{ status: 0, orderItem: [{ filled: false, asset: asset(6) }] }];
  const heldView = await readGuildOrderView(held.client, protocol, config, held.options);
  assert.deepEqual(heldView.requirements[0], { id: 'WHEAT', name: '小麦', need: 5, have: 30, reserved: 26,
    weekly: 10, cargo: 6, resident: 10, available: 4, missing: 1 });
  assert.match((await held.run()).reason, /已预留 26/);
  assert.equal(held.writes().length, 0);
  held.bodies.AllItemRequest.items[0].num = 31;
  assert.equal((await held.run()).ok, true);

  const mixedResidents = fixture();
  mixedResidents.bodies.AllItemRequest.items[0].num = 15;
  mixedResidents.bodies.OnWaterRequest.workerOrder = [
    { index: 1, workerId: 9, requirements: [asset(10)], refreshTime: 0 },
    { index: 2, workerId: 10, requirements: [asset(100)], refreshTime: stamp + 60 },
    { index: 3, workerId: 11, requirements: [asset(100)], refreshTime: stamp - 60 },
    { index: 4, requirements: [] },
  ];
  const mixedView = await readGuildOrderView(mixedResidents.client, protocol, config, mixedResidents.options);
  assert.equal(mixedView.requirements[0].resident, 10, 'refreshing slots retain stale requirements, even past the timestamp');
  assert.equal(mixedView.requirements[0].available, 5);
  assert.equal((await mixedResidents.run()).ok, true);
  for (const order of [
    { index: 1, workerId: 9, requirements: [] },
    { index: 1, textId: 7, requirements: [] },
    { index: 1, isSpecial: true, requirements: [] },
    { index: 1 },
    { index: 1, requirements: [], refreshTime: -1 },
  ]) {
    const incomplete = fixture(); incomplete.bodies.OnWaterRequest.workerOrder = [order];
    assert.equal((await incomplete.run()).ok, false, JSON.stringify(order));
    assert.equal(incomplete.writes().length, 0);
  }
  const duplicate = fixture();
  duplicate.bodies.OnWaterRequest.workerOrder = [{ index: 1, requirements: [] }, { index: 1, requirements: [asset(5)] }];
  assert.match((await duplicate.run()).error, /槽位重复/);
  assert.equal(duplicate.writes().length, 0);

  const cap = fixture();
  cap.bodies.CounterInfoRequest.counters = [{ type: 'DAILY_FINISH_GUILD_ORDER', num: 10 }];
  assert.match((await cap.run()).reason, /本赛季上限 10/);
  assert.equal(cap.writes().length, 0);
  const high = fixture(); high.player.level = 25;
  high.bodies.CounterInfoRequest.counters = [{ type: 'DAILY_FINISH_GUILD_ORDER', num: 20 }];
  assert.equal((await high.run()).ok, true);
  const unknownSeason = fixture(); unknownSeason.player.worldId = 9000001;
  assert.match((await unknownSeason.run()).error, /次数配置/);
  assert.equal(unknownSeason.writes().length, 0);

  for (const name of ['GuildInfoRequest', 'GuildCityInfoRequest', 'CounterInfoRequest', 'AllItemRequest', 'WeekInfoRequest', 'CargoShipsRequest', 'OnWaterRequest']) {
    const broken = fixture(); broken.bodies[name] = {};
    assert.equal((await broken.run()).ok, false, name);
    assert.equal(broken.writes().length, 0, name);
  }
  const badNum = fixture(); badNum.bodies.CounterInfoRequest.counters = [{ type: 'DAILY_FINISH_GUILD_ORDER', num: 'oops' }];
  assert.equal((await badNum.run()).ok, false);
  assert.equal(badNum.writes().length, 0);
  const noCity = fixture(); noCity.bodies.GuildCityInfoRequest.cities = [];
  assert.match((await noCity.run()).reason, /没有.*城市/);
  assert.equal(noCity.writes().length, 0);
  const refresh = fixture(); refresh.bodies.GuildOrderRequest.order.nextRefreshTime = stamp - 1;
  assert.match((await refresh.run()).reason, /正在刷新/);

  const cancel = fixture(); let allowed = true;
  cancel.hook(name => { if (name === 'AllItemRequest') allowed = false; });
  assert((await cancel.run({ enabled: () => allowed })).skipped);
  assert.equal(cancel.writes().length, 0);
  const changed = fixture(); let reads = 0;
  changed.hook(name => { if (name === 'GuildOrderRequest' && ++reads === 2) changed.bodies.GuildOrderRequest.order.requirements = [asset(6)]; });
  assert.match((await changed.run()).reason, /已变化/);
  assert.equal(changed.writes().length, 0);
  const stockChanged = fixture(); let bags = 0;
  stockChanged.hook(name => { if (name === 'AllItemRequest' && ++bags === 2) stockChanged.bodies.AllItemRequest.items[0].num = 4; });
  assert.match((await stockChanged.run()).reason, /还缺/);
  assert.equal(stockChanged.writes().length, 0);
  const moved = fixture(); let guildReads = 0;
  moved.hook(name => { if (name === 'GuildInfoRequest' && ++guildReads === 3) moved.player.guildId = 999; });
  assert.match((await moved.run()).reason, /联盟状态已变化/);
  assert.equal(moved.writes().length, 0);

  const rejected = fixture(); rejected.bodies.FinishGuildOrderRequest = Object.assign(new Error('not enough'), { prompt: { prompt: 7 }, request: 'FinishGuildOrderRequest' });
  assert.match((await rejected.run()).error, /被拒绝/);
  rejected.bodies.FinishGuildOrderRequest = { reward: { asset: [{ id: 'MERIT', type: 0, num: 225 }] } };
  assert.equal((await rejected.run()).ok, true);
  assert.equal(rejected.writes().length, 2, 'explicit rejection can retry after fresh reads');
  const unsent=fixture();unsent.bodies.FinishGuildOrderRequest=Object.assign(new Error('socket closed before send'),{notSent:true});
  assert.match((await unsent.run()).error,/未发送/);assert.equal(pendingOrderMaterialSpends(unsent.player).length,0);
  unsent.bodies.FinishGuildOrderRequest={reward:{asset:[{id:'MERIT',type:0,num:225}]}};
  assert.equal((await unsent.run()).ok,true);assert.equal(unsent.writes().length,2,'明确未发送释放共享材料及私有订单防重，允许重新核对后发送');
  const timeout = fixture(); timeout.bodies.FinishGuildOrderRequest = new Error('timeout');
  assert.match((await timeout.run()).error, /结果未确认/);
  assert.match((await timeout.run()).reason, /尚未确认/);
  assert.equal(timeout.writes().length, 1);
  const reconnected = { ...timeout.client };
  assert.match((await serviceGuildOrders(reconnected, protocol, config, timeout.options)).reason, /尚未确认/);
  assert.equal(timeout.writes().length, 1, 'unknown outcome guard survives connection replacement');
  timeout.client.serverClockOffsetMs=86400000;
  await timeout.run();
  assert.equal(pendingOrderMaterialSpends(timeout.player).length,1,'跨日或库存变化本身不能证明未知订单成功');
  assert.equal(timeout.writes().length,1);
  const empty = fixture(); empty.bodies.FinishGuildOrderRequest = {};
  assert.match((await empty.run()).error, /未返回明确/);
  assert((await empty.run()).skipped);
  assert.equal(empty.writes().length, 1);

  const scheduled = fixture(); let until = 0;
  const scheduler = { now: () => stamp, due: task => { assert.equal(task, 'guildOrders'); return until <= stamp; },
    defer: (task, time) => { assert.equal(task, 'guildOrders'); until = time; } };
  assert.equal((await scheduled.run({ scheduler })).ok, true);
  const before = scheduled.calls.length;
  assert((await scheduled.run({ scheduler })).skipped);
  assert.equal(scheduled.calls.length, before);

  const concurrent = fixture(); let unblock;
  concurrent.hook(name => name === 'GuildInfoRequest' && !unblock ? new Promise(resolve => { unblock = resolve; }) : undefined);
  const first = concurrent.run();
  await Promise.resolve();
  assert.match((await concurrent.run()).reason, /正在核对/);
  unblock();
  assert.equal((await first).ok, true);
  assert.equal(concurrent.writes().length, 1);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testGuildOrders();
  console.log('guild orders ok: season quotas, reserved stock, fresh reads, cancellation and unknown-outcome guards');
}
