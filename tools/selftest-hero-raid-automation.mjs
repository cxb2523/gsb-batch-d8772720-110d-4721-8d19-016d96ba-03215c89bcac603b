import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hero-raid-'));
process.env.CW_DATA_DIR = root;
const { createUsageLedger, defaultSettings } = await import('../src/automation-settings.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { watchHeroRaidPushes, runHeroRaidAutomation, heroRaidDemands } = await import('../src/hero-raid-automation.mjs');
const { watchBasePushes } = await import('../src/base-automation.mjs');
const protocol = loadProtocol(), actual = loadConfig(), table = data => ({ data });
let serial = 0, passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
const wire = (name, value) => protocol[name].decode(protocol[name].encode(value).finish());
function fixture() {
  const id = ++serial, now = Math.floor(Date.now() / 1000), start = now - 86400;
  const f = { id, player: { playerId: String(9007199300000000n + BigInt(id)), worldId: '2002001', guildId: '1001', level: 50 },
    settings: defaultSettings(), file: path.join(root, id + '.json'), calls: [], writes: [], reports: [],
    gameRaid: { raidId: 1001, startTime: start, finishTime: now + 86400, order: { orderId: 1, gotOrderId: 0, gotTimes: 0 }, drawTimesInfo: { times: 0, gotIndex: 0 } },
    stock: {}, fail: '', lost: '', readHook: null, wrongReceipt: false, workerOrder: [], disconnected: false };
  Object.assign(f.settings.heroRaid, { enabled: true, orders: true, rewards: true });
  const orders = actual.tables.HeroRaidOrderCfg.data.filter(row => row.raidId === 1001);
  f.config = { materialName: id => id, tables: { HeroRaidOrderCfg: table(orders), HeroRaidOrderRewardCfg: actual.tables.HeroRaidOrderRewardCfg,
    HeroRaidLotteryTimesCfg: actual.tables.HeroRaidLotteryTimesCfg, CargoUnlockCfg: table([{ index: 1, playerLevel: 9 }]) } };
  for (const row of orders) for (const [item] of row.orderList) f.stock[item] = 500;
  f.ledger = createUsageLedger('hero-' + id, { file: f.file });
  f.connect = () => {
    const client = new EventEmitter(); client.connected = true; client.serverClockOffsetMs = 0;
    watchHeroRaidPushes(client); f.client = client;
    client.request = async (name, body, response) => {
      wire(name, body); f.calls.push(name); await f.readHook?.(name, body, client);
      let value;
      if (name === 'OnWaterRequest') value = { workerOrder: f.workerOrder };
      else if (name === 'AllItemRequest') value = { items: Object.entries(f.stock).map(([itemId, num]) => ({ itemId, num })) };
      else if (name === 'WeekInfoRequest') value = { activityTime: [] };
      else if (name === 'CargoShipsRequest') value = { ship: [] };
      else {
        f.writes.push({ name, body: wire(name, body) });
        if (f.fail === name) throw Object.assign(Error('明确未发送'), { notSent: true });
        if (f.fail === 'reject:' + name) throw Object.assign(Error('服务端拒绝'), { prompt: { prompt: 1 }, request: name });
        if (f.fail === 'unknown:' + name) throw Error('无已知结果');
        assert.equal(body.raidId, f.gameRaid.raidId);
        if (name === 'HeroRaidFinishOrderRequest') {
          const row = orders.find(row => row.orderId === f.gameRaid.order.orderId);
          for (const [item, num] of row.orderList) { assert(f.stock[item] >= num); f.stock[item] -= num; }
          f.gameRaid.order.gotOrderId = row.orderId; f.gameRaid.order.orderId = Math.min(orders.at(-1).orderId, row.orderId + 1);
          value = { order: structuredClone(f.gameRaid.order), reward: { asset: [{ type: 0, id: '英雄副本抽卡券', num: 1 }] } };
        } else if (name === 'HeroRaidGotOrderRewardRequest') {
          const tiers = actual.tables.HeroRaidOrderRewardCfg.data.filter(row => row.raidId === f.gameRaid.raidId && row.orderCount <= f.gameRaid.order.gotOrderId);
          f.gameRaid.order.gotTimes = Math.max(...tiers.map(row => row.orderCount));
          value = { order: structuredClone(f.gameRaid.order), reward: { asset: [{ type: 0, id: '英雄副本抽卡券', num: 1 }] } };
        } else if (name === 'HeroRaidGotRewardRequest') {
          const tiers = actual.tables.HeroRaidLotteryTimesCfg.data.filter(row => row.raidId === f.gameRaid.raidId && row.reqTimes <= f.gameRaid.drawTimesInfo.times);
          f.gameRaid.drawTimesInfo.gotIndex = Math.max(...tiers.map(row => row.index));
          value = { gotInfo: structuredClone(f.gameRaid.drawTimesInfo), reward: { asset: [{ type: 0, id: '橙卡万能碎片', num: 10 }] } };
        } else throw Error('禁止未知写协议：' + name);
        if (f.lost === name) throw Error('服务端已处理，回执丢失');
        if (f.wrongReceipt) value = {};
      }
      return wire(response, value);
    };
    return client;
  };
  f.connect();
  f.push = (name = 'SCAllActivity') => f.client.emit('message', { name, body: wire(name, name === 'SCAllActivity' ? { raid: [f.gameRaid] } : { raid: f.gameRaid }) });
  f.run = () => runHeroRaidAutomation(f.client, protocol, f.config, f.player, { getSettings: () => f.settings, ledger: f.ledger, enabled: () => true, report: row => f.reports.push(row) });
  f.demands = () => heroRaidDemands(f.client, f.config, f.player, f.settings, { ledger: f.ledger });
  return f;
}

try {
  await test('没有免费抽次数字段与接口，自动化从不发送消耗抽卡券的 Prize 请求', async () => {
    assert(protocol.HeroRaidPrizeRequest); assert(!protocol.HeroRaidInfoRequest);
    assert.equal('freeTimes' in new protocol.HeroRaidTimes(), false);
    const f = fixture(); f.push(); await f.run(); assert(f.writes.every(row => row.name !== 'HeroRaidPrizeRequest'));
  });
  await test('总开关和订单子开关独立，未接到推送不得按配置造活动', async () => {
    const f = fixture(); await f.run(); assert.equal(f.writes.length, 0); assert.deepEqual(f.demands(), []);
    f.push(); f.settings.heroRaid.enabled = false; await f.run(); assert.equal(f.writes.length, 0);
    f.settings.heroRaid.enabled = true; f.settings.heroRaid.orders = false; await f.run(); assert.equal(f.writes.length, 0);
  });
  await test('登录全量与单个开放推送同步，重连及断开清空旧活动', async () => {
    const f = fixture(), base = watchBasePushes(f.client); f.push(); assert.equal(base.raids.size, 1);
    f.client.emit('login'); assert.equal(base.raids.size, 0); await f.run(); assert.equal(f.writes.length, 0);
    f.push('SCHeroRaidOpen'); await f.run(); assert.equal(f.writes.length, 1);
    f.client.emit('close'); assert.equal(watchHeroRaidPushes(f.client).raids.size, 0);
  });
  await test('真实配置重复材料合并，订单明确回执才推进，下一轮按新订单', async () => {
    const f = fixture(); f.push(); const demand = f.demands()[0];
    assert.equal(demand.requirements.find(row => row.id === '海藻酒').num, 4);
    await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.stock.海藻酒, 496);
    assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).order.gotOrderId, 1);
    await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.gameRaid.order.gotOrderId, 2);
  });
  await test('当前解锁日与活动边界约束订单，最后一单完成后停止生产需求', async () => {
    const f = fixture(); f.gameRaid.order = { orderId: 5, gotOrderId: 4, gotTimes: 3 }; f.gameRaid.startTime = Math.floor(Date.now() / 1000) - 1;
    f.push(); await f.run(); assert.equal(f.writes.length, 0); assert.deepEqual(f.demands(), []);
    f.gameRaid.finishTime = Math.floor(Date.now() / 1000) - 1; f.gameRaid.startTime -= 86400; f.push(); await f.run(); assert.equal(f.writes.length, 0);
    const g = fixture(); const last = g.config.tables.HeroRaidOrderCfg.data.at(-1).orderId; g.gameRaid.order = { orderId: last, gotOrderId: last, gotTimes: last }; g.push();
    g.settings.heroRaid.rewards = false; await g.run(); assert.equal(g.writes.length, 0); assert.deepEqual(g.demands(), []);
  });
  await test('居民订单预留与当前库存共同约束，不足不挪用且不买材料', async () => {
    const f = fixture(); f.stock.漂流瓶 = 3; f.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '漂流瓶', num: 1 }] }]; f.push();
    await f.run(); assert.equal(f.writes.length, 0); assert.match(f.reports.at(-1).reason, /保留其他订单/);
  });
  await test('订单请求未知跨重启防重，真实进度推送后可核销并继续', async () => {
    const f = fixture(); f.push(); f.lost = 'HeroRaidFinishOrderRequest'; await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
    assert.deepEqual(f.demands(), []); f.ledger = createUsageLedger('hero-' + f.id, { file: f.file }); f.lost = ''; await f.run(); assert.equal(f.writes.length, 1);
    f.connect(); f.push(); await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.gameRaid.order.gotOrderId, 2);
  });
  await test('无证据的未知请求跨日保留；明确未发送及拒绝释放记录', async () => {
    const f = fixture(); f.gameRaid.finishTime += 3 * 86400; f.push(); f.fail = 'unknown:HeroRaidFinishOrderRequest'; await f.run();
    const beforeDay = f.ledger.snapshot().day; f.client.serverClockOffsetMs = 86400000;
    f.ledger = createUsageLedger('hero-' + f.id, { file: f.file, now: () => Date.now() + f.client.serverClockOffsetMs });
    f.fail = ''; await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1); assert.notEqual(f.ledger.snapshot().day, beforeDay);
    for (const failure of ['HeroRaidFinishOrderRequest', 'reject:HeroRaidFinishOrderRequest']) {
      const g = fixture(); g.push(); g.fail = failure; await g.run(); assert.equal(g.ledger.snapshot().uncertain, 0);
      g.fail = ''; await g.run(); assert.equal(g.writes.length, 2);
    }
  });
  await test('明确回执后库存读取失败仍保持消耗防重，不把读取失败当未发送', async () => {
    const f = fixture(); f.push(); f.readHook = name => { if (name === 'AllItemRequest' && f.writes.length) throw Object.assign(Error('读取连接断开'), { notSent: true }); };
    await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
    await f.run(); assert.equal(f.writes.length, 1); f.readHook = null; await f.run(); assert.equal(f.writes.length, 2);
  });
  await test('无效奖励或不匹配订单回执保留票据，不能重复消费', async () => {
    const f = fixture(); f.push(); f.wrongReceipt = true; await f.run(); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.wrongReceipt = false; await f.run(); assert.equal(f.writes.length, 1);
  });
  await test('读取材料期间关闭配置、切角色、推送更新或活动结束均阻止旧计划', async () => {
    for (const change of [f => f.settings.heroRaid.orders = false, f => f.player.playerId = '999', f => { f.gameRaid.order.gotOrderId = 1; f.gameRaid.order.orderId = 2; f.push(); }, f => { f.gameRaid.finishTime = Math.floor(Date.now() / 1000) - 1; f.push(); }]) {
      const f = fixture(); f.push(); f.readHook = name => { if (name === 'AllItemRequest') change(f); }; await f.run(); assert.equal(f.writes.length, 0);
    }
  });
  await test('达标订单与累计抽取奖励分别核验回执，只领取既有进度', async () => {
    const f = fixture(); f.gameRaid.order = { orderId: 3, gotOrderId: 2, gotTimes: 0 }; f.gameRaid.drawTimesInfo = { times: 10, gotIndex: 0 }; f.push();
    await f.run(); assert.deepEqual(f.writes.map(row => row.name), ['HeroRaidFinishOrderRequest', 'HeroRaidGotOrderRewardRequest', 'HeroRaidGotRewardRequest']);
    f.settings.heroRaid.orders = false; await f.run(); assert.equal(f.writes.length, 3);
    assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).drawTimesInfo.gotIndex, 1);
  });
  await test('达标奖励未知后不重领，收到已领档位推送才解除记录', async () => {
    for (const name of ['HeroRaidGotOrderRewardRequest', 'HeroRaidGotRewardRequest']) {
      const f = fixture(); f.settings.heroRaid.orders = false; f.gameRaid.order = { orderId: 4, gotOrderId: 3, gotTimes: name === 'HeroRaidGotOrderRewardRequest' ? 0 : 3 }; f.gameRaid.drawTimesInfo = { times: 10, gotIndex: name === 'HeroRaidGotRewardRequest' ? 0 : 1 }; f.push();
      f.lost = name; await f.run(); assert.equal(f.writes.length, 1); f.lost = ''; await f.run(); assert.equal(f.writes.length, 1);
      f.connect(); f.push(); await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('重复活动编号或不完整推送封锁旧状态，不能并发提交同一订单', async () => {
    const f = fixture(); f.push(); f.client.emit('message', { name: 'SCAllActivity', body: { raid: [f.gameRaid, f.gameRaid] } }); await f.run(); assert.equal(f.writes.length, 0);
    f.push(); await Promise.all([f.run(), f.run()]); assert.equal(f.writes.length, 1);
  });
  console.log(`${passed}/${passed} 超凡英雄自动化测试通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
