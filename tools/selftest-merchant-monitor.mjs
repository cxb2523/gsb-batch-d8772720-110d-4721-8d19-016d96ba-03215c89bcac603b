// 真实 runLoop 与离线协议夹具，虚拟时钟只推进等待，不登录任何真实账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { watchMerchant, merchantMonitorSeconds } from '../src/merchant-monitor.mjs';
import { runLoop } from '../src/loop.mjs';
import { seasonalFixture } from './fixtures/seasonal-suite.mjs';

const base = Date.UTC(2026, 10, 5, 4), originalNow = Date.now;
let wall = base, passed = 0, serial = 0;
Date.now = () => wall;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-monitor-'));
const test = async (name, run) => { wall = base; await run(); passed++; console.log('通过：' + name); };
const smallConfig = { tables: { ActivityTradeCfg: { data: [
  { key: '海商王贸易时间', value: '10-22' }, { key: '海商王行驶时间', value: '120' },
  { key: '海商王刷新时间', value: '10,12,14,16,18,20' }
] } } };
const event = () => ({ period: 1001, startTime: base / 1000 - 86400, endTime: base / 1000 + 86400 });

function integration({ mainEveryMs = 3600000 } = {}) {
  const f = seasonalFixture(), stop = { aborted: false }, sleeps = [], reports = [];
  Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false, everySeconds: 3600 });
  f.settings.schedule.merchantTrade = true;
  f.settings.merchant.monitorSeconds = 60;
  const ledger = createUsageLedger('monitor-' + (++serial), { file: path.join(folder, serial + '.json') });
  let scheduled = 0, active = false, sleepHook = null, reportHook = null;
  const request = f.client.request;
  f.client.request = async (...args) => {
    assert.equal(active, true, '所有协议必须处于已有串行 schedule 中');
    return request(...args);
  };
  const run = () => runLoop(f.client, f.protocol, {
    config: f.config, player: f.player, rounds: 2, everyMs: mainEveryMs, allowMutate: true,
    getEveryMs: () => mainEveryMs, isEnabled: key => key === 'merchantTrade' && f.settings.schedule.merchantTrade,
    getSettings: () => f.settings,
    usageLedger: ledger, stop,
    schedule: async work => {
      assert.equal(active, false, '不得并发排入第二个任务');
      scheduled++; active = true;
      try { return await work(); } finally { active = false; }
    },
    sleep: async ms => {
      assert(ms > 0, '不能零毫秒忙轮询');
      sleeps.push(ms);
      assert(sleeps.length < 100, '监控应有界等待，不能忙轮询');
      if (sleepHook) await sleepHook(ms, sleeps.length);
      else wall += ms;
    },
    onStep: row => { reports.push(row); reportHook?.(row); }
  });
  return { ...f, stop, sleeps, reports, ledger, run, isScheduled: () => active,
    scheduled: () => scheduled, sleepHook: fn => { sleepHook = fn; }, reportHook: fn => { reportHook = fn; } };
}

try {
  await test('当前港库存推送仅失效一次，远端推送不注入报价或发送请求', () => {
    const client = new EventEmitter(), monitor = watchMerchant(client), signals = [];
    client.request = () => { throw Error('推送不能发协议'); };
    assert.equal(watchMerchant(client), monitor);
    const off = monitor.subscribe(value => signals.push(value));
    monitor.observe({ event: event(), state: { cargo: { cityId: 10, moveEndTime: 0 } }, time: wall / 1000,
      config: smallConfig, settings: { monitorSeconds: 60 },
      market: { cityId: 10, goods: [{ goodsId: 1001, price: 40, stock: 100 }] },
      radar: { radar: [{ cityId: 10 }, { cityId: 20 }] } });
    const before = monitor.snapshot().market;
    client.emit('message', { name: 'SCTradeCityGoods', body: { cityId: 20 } });
    assert.equal(signals.length, 0);
    for (let i = 0; i < 30; i++) client.emit('message', { name: 'SCTradeCityGoods', body: { cityId: 10 } });
    assert.equal(signals.length, 1, '重复推送合并为一次失效通知');
    assert.equal(monitor.due(), true);
    assert.deepEqual(monitor.snapshot().market, before, '推送不含完整价格，不能改写已读取报价');
    monitor.defer(wall / 1000 + 60);
    client.emit('message', { name: 'SCTradeCityReport', body: { cityId: 20, rareGoodsId: 1001 } });
    assert.equal(signals.length, 2, '已知远端报告只唤醒重新规划');
    assert.deepEqual(monitor.snapshot().market, before);
    off();
    assert.equal(client.listenerCount('message'), 0);
    assert.equal(client.listenerCount('close'), 0);
  });
  await test('周期、到港、刷新和活动变更决定检查期限，航行不更新本港报价时间', () => {
    const client = new EventEmitter(), monitor = watchMerchant(client), off = monitor.subscribe(() => {});
    const now = wall / 1000;
    monitor.observe({ event: event(), state: { cargo: { cityId: 10, moveEndTime: now + 20 } }, time: now,
      config: smallConfig, settings: { monitorSeconds: 60 } });
    assert.equal(monitor.nextCheckAt, now + 20);
    monitor.observe({ event: event(), state: { cargo: { cityId: 10, moveEndTime: 0 } }, time: now,
      market: { goods: [{ goodsId: 1001, price: 40, stock: 1 }] } });
    wall += 10000;
    monitor.observe({ event: event(), state: { cargo: { cityId: 10, moveEndTime: now + 90 } }, time: wall / 1000,
      market: { goods: [{ goodsId: 1001, price: 1, stock: 2 }] } });
    assert.equal(monitor.snapshot().market.observedAt, now);
    assert.equal(monitor.snapshot().market.goods[0].price, 40);
    wall = base + 7180000;
    monitor.observe({ event: event(), state: { cargo: { cityId: 10, moveEndTime: 0 } }, time: wall / 1000,
      config: smallConfig, settings: { merchant: { monitorSeconds: 300 } } });
    assert.equal(monitor.nextCheckAt, base / 1000 + 7200);
    client.emit('message', { name: 'SCAllActivity', body: { trade: { ...event(), period: 1002 } } });
    assert.equal(monitor.due(), true);
    assert.equal(monitor.snapshot().market, null);
    assert.equal(monitor.snapshot().cityId, null);
    assert.equal(merchantMonitorSeconds({ merchant: { monitorSeconds: 1 } }), 10);
    assert.equal(merchantMonitorSeconds({ merchant: { monitorSeconds: 999 } }), 300);
    off();
  });
  await test('一小时主循环之间按60秒监控串行推进购货和出航', async () => {
    const f = integration();
    f.reportHook(() => { if (f.state.writes.length >= 2) f.stop.aborted = true; });
    await f.run();
    assert.deepEqual(f.state.writes.map(row => row.name), ['TradeBuyRequest', 'TradeMoveRequest']);
    assert.equal(f.sleeps[0], 60000);
    assert(wall - base < 3600000);
    assert(f.scheduled() >= 2);
  });
  await test('较快主循环仍遵守海商王due，读取失败按监控间隔重试', async () => {
    const fast = integration({ mainEveryMs: 10000 });
    await fast.run();
    assert.equal(fast.state.writes.length, 1, '第二个十秒主轮不重复未到期的海商王检查');
    assert.equal(fast.state.writes[0].name, 'TradeBuyRequest');
    wall = base;
    const failed = integration();
    let checked = 0;
    failed.state.onRead = name => {
      if (name !== 'TradeCity') return;
      if (++checked === 3) failed.stop.aborted = true;
      throw Error('本港报价暂不可读');
    };
    await failed.run();
    assert.equal(checked, 3);
    assert.deepEqual(failed.sleeps, [60000, 60000]);
    assert.equal(failed.state.writes.length, 0);
  });
  await test('本港库存推送提前唤醒且合并风暴，所有操作仍在串行任务中', async () => {
    const f = integration();
    let emitted = false;
    f.sleepHook(ms => {
      if (!emitted) {
        emitted = true; wall += 1000;
        const reads = f.state.reads.length;
        assert.equal(f.isScheduled(), false);
        for (let i = 0; i < 30; i++) f.client.emit('message', { name: 'SCTradeCityGoods', body: { cityId: 10 } });
        assert.equal(f.state.reads.length, reads, '推送处理本身不读写游戏');
      } else wall += ms;
    });
    f.reportHook(() => { if (f.state.writes.length >= 2) f.stop.aborted = true; });
    await f.run();
    assert.deepEqual(f.state.writes.map(row => row.name), ['TradeBuyRequest', 'TradeMoveRequest']);
    assert.equal(wall - base, 10000, '推送提前检查，同时保留10秒节流');
    assert(f.sleeps.length <= 3);
  });
  await test('到港期限短于监控周期时及时回读并出售', async () => {
    const f = integration(), now = f.now;
    f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
    Object.assign(f.state.trade.cargo, { moveStartTime: now - 100, moveEndTime: now + 25, moveToCityId: 20 });
    f.sleepHook(ms => {
      wall += ms;
      if (wall / 1000 >= now + 25) Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
    });
    f.reportHook(() => { if (f.state.writes.some(row => row.name === 'TradeSellRequest')) f.stop.aborted = true; });
    await f.run();
    assert.equal(f.sleeps[0], 25000);
    assert.equal(f.state.writes[0].name, 'TradeSellRequest');
  });
  await test('刷新期限重新读取价格库存，旧售罄快照不沿用', async () => {
    const f = integration(), ports = f.state.radar.radar;
    f.client.serverClockOffsetMs += 7180000;
    f.state.radar.radar = [];
    f.state.markets[10].goods[0].stock = 60000;
    f.sleepHook(ms => {
      wall += ms;
      f.state.radar.radar = ports;
      f.state.markets[10].goods[0].stock = 0;
      f.state.markets[10].goods[0].price = 20;
    });
    f.reportHook(() => { if (f.state.writes.length) f.stop.aborted = true; });
    await f.run();
    assert.equal(f.sleeps[0], 20000);
    assert.deepEqual(f.state.writes.map(row => row.name), ['TradeBuyRequest']);
    assert.equal(f.state.writes[0].body.buyNum, 500);
  });
  await test('活动期次推送提前唤醒，回调不登录或发送交易', async () => {
    const f = integration(), activeEvent = { ...f.client.tradeWindow };
    f.client.tradeWindow = { ...activeEvent, endTime: f.now - 1 };
    let emitted = false;
    f.sleepHook(ms => {
      if (!emitted) {
        emitted = true; wall += 1000;
        f.client.tradeWindow = activeEvent;
        f.client.emit('message', { name: 'SCAllActivity', body: { trade: activeEvent } });
        assert.equal(f.state.reads.length, 0);
        assert.equal(f.state.writes.length, 0);
      } else wall += ms;
    });
    f.reportHook(() => { if (f.state.writes.length) f.stop.aborted = true; });
    await f.run();
    assert.equal(f.state.writes[0].name, 'TradeBuyRequest');
    assert.equal(wall - base, 10000);
  });
  await test('等待期间关闭开关、停止或身份改变，不因推送继续执行', async () => {
    for (const mode of ['disabled', 'stopped', 'identity']) {
      wall = base;
      const f = integration();
      let reads;
      f.sleepHook((ms, index) => {
        wall += ms;
        if (index === 1) {
          reads = f.state.reads.length;
          if (mode === 'disabled') f.settings.schedule.merchantTrade = false;
          if (mode === 'stopped') f.stop.aborted = true;
          if (mode === 'identity') f.player.playerId = '999999999';
          f.client.emit('message', { name: 'SCTradeCityGoods', body: { cityId: 10 } });
        } else f.stop.aborted = true;
      });
      await f.run();
      assert.equal(f.state.reads.length, reads);
      assert.equal(f.state.writes.length, 1);
      const monitor = watchMerchant(f.client), revision = monitor.snapshot().revision;
      f.client.emit('message', { name: 'SCTradeCityGoods', body: { cityId: 10 } });
      assert.equal(monitor.snapshot().revision, revision, '退出loop后监控监听已移除');
    }
  });
  console.log('海商王监控测试通过：' + passed + ' 项');
} finally {
  Date.now = originalNow;
  fs.rmSync(folder, { recursive: true, force: true });
}
