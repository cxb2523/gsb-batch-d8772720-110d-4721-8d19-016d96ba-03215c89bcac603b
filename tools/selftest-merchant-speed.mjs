import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { merchantSpeedMatches, planMerchantSpeed, runMerchantSpeed } from '../src/merchant-speed.mjs';
import {
  beginOrderMaterialSpend, cancelOrderMaterialSpend, pendingOrderMaterialSpends, refreshOrderMaterialSpends
} from '../src/order-reservations.mjs';

const protocol = loadProtocol();
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-speed-'));
const pointer = '海商王加速';
const now = Date.UTC(2026, 10, 12, 13, 15) / 1000; // 北京时间 21:15。
const config = { tables: {
  ActivityTradeCfg: { data: [
    { key: '海商王贸易时间', value: '10-22' }, { key: '海商王行驶时间', value: '120' },
    { key: '海商王加速时长', value: '30' }, { key: '海商王刷新时间', value: '10,12,14,16,18,20' }
  ] },
  TradeShipCfg: { data: [{ lv: 1, capacity: 1000, profitMargin: 300 }] },
  TradeGoodsCfg: { data: [{ goodsId: 1001, unitPrice: 50, capacity: 1 }] }
} };
let count = 0, passed = 0;
function fixture(at = now) {
  const id = ++count;
  const event = { period: 1001, startTime: at - 86400, endTime: at + 86400 };
  const state = { period: event.period,
    cargo: { cargoLv: 1, cityId: 10, moveToCityId: 20, moveStartTime: at - 2700, moveEndTime: at + 4500 },
    player: { coins: 1000, profit: 2000, goods: [{ pid: 1, goodsId: 1001, num: 100, buyPrice: 10, cityId: 10 }] } };
  const settings = { merchant: { autoSpeedUp: true, speedUpMinProfit: 1000, keepPointers: 1, estimateDiscountPercent: 10 } };
  const radar = { radar: [{ cityId: 10, specGoodsId: 1001 }, { cityId: 20, specGoodsId: 1002 }] };
  const stock = new Map([[pointer, 4]]), calls = [], reports = [];
  const player = { playerId: String(80000 + id), worldId: '2002001001', guildId: '1001', level: 37 };
  let active = true, mode = '', hook = () => {};
  const client = { connected: true, tradeWindow: event, serverClockOffsetMs: at * 1000 - Date.now(),
    async request(name, body = {}, response) {
      assert.ok(protocol[name], name + ' 必须存在于真实协议');
      assert.ok(protocol[response], response + ' 必须存在于真实协议');
      protocol[name].encode(body).finish();
      calls.push({ name, body });
      await hook(name, body);
      if (name === 'TradeInfoRequest') return structuredClone(state);
      if (name === 'TradeGuildRadarRequest') return structuredClone(radar);
      if (name === 'AllItemRequest') {
        if (mode === 'inventory-fails' && calls.some(row => row.name === 'TradeSpeedRequest')) throw Error('库存回读超时');
        return { items: [...stock].map(([itemId, num]) => ({ itemId, num })) };
      }
      assert.equal(name, 'TradeSpeedRequest', '不得购买指针或升级商船');
      if (mode === 'not-sent') throw Object.assign(Error('明确未发送'), { notSent: true });
      if (mode === 'rejected') throw Object.assign(Error('拒绝'), { request: name, prompt: { prompt: 1 } });
      if (mode === 'unknown') throw Error('响应未知');
      stock.set(pointer, stock.get(pointer) - body.useNum);
      state.cargo.moveEndTime -= body.useNum * 1800;
      if (mode === 'applied-timeout') throw Error('回包丢失');
      return { moveEndTime: state.cargo.moveEndTime };
    }
  };
  const ledger = createUsageLedger('merchant-speed-' + id, { file: path.join(folder, id + '.json') });
  const ctx = { player, ledger, label: '海商王', enabled: () => active,
    settings: () => settings, report: report => reports.push(report) };
  return { event, state, settings, radar, stock, client, ctx, ledger, calls, reports, player, now: at,
    run: () => runMerchantSpeed(client, config, ctx, event, structuredClone(state)),
    plan: options => planMerchantSpeed(config, event, state, radar, stock, settings.merchant, at, options),
    mode: value => { mode = value; }, hook: value => { hook = value; }, pause: () => { active = false; },
    sent: () => calls.filter(row => row.name === 'TradeSpeedRequest') };
}
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }
const sample = (f, changes = {}) => ({ period: f.event.period, startTime: f.event.startTime,
  observedAt: f.now - 10, turnoverProfitPerSecond: 1, ...changes });

try {
  await test('最少两枚指针保留一分钟成交，收益使用折扣基准价', async () => {
    const f = fixture(), plan = f.plan();
    assert.equal(plan.kind, 'speed');
    assert.equal(plan.useNum, 2);
    assert.equal(plan.estimatedProfit, 3605);
    assert.equal(plan.expected.afterEndTime, now + 900);
    assert.match(plan.label, /非目的港实时报价/);
    assert.equal(await f.run(), true);
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 2 }]);
    assert.equal(f.stock.get(pointer), 2);
    assert.equal(f.reports.at(-1).status, 'confirmed');
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    const sendIndex = f.calls.findIndex(row => row.name === 'TradeSpeedRequest');
    assert.deepEqual(f.calls.slice(sendIndex + 1).map(row => row.name), ['TradeInfoRequest', 'AllItemRequest']);
    assert.equal(await f.run(), false, '已经赶得上窗口，不继续加速');
    assert.equal(f.sent().length, 1);
  });
  await test('关闭加速和正常到港都不读取库存或发送请求', async () => {
    const f = fixture();
    f.settings.merchant.autoSpeedUp = false;
    assert.equal(await f.run(), false);
    f.settings.merchant.autoSpeedUp = true;
    f.state.cargo.moveEndTime = now + 100;
    assert.equal(await f.run(), false);
    assert.equal(f.calls.length, 0);
  });
  await test('同一期确认成交速率驱动常规周转，比较数量并记录估算增益', async () => {
    const f = fixture(now - 6 * 3600), metrics = sample(f);
    const plan = f.plan({ metrics });
    assert.equal(plan.kind, 'speed');
    assert.equal(plan.useNum, 3);
    assert.equal(plan.accelerationReason, 'turnover');
    assert.equal(plan.savedSeconds, 4500);
    assert.equal(plan.estimatedIncrementalProfit, 4500);
    assert.equal(plan.expected.estimatedIncrementalProfit, 4500);
    assert.match(plan.label, /近期确认成交速率/);
    f.ctx.merchantMetrics = metrics;
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 3 }]);
    assert.equal(f.reports.at(-1).status, 'confirmed');
    const record = Object.values(f.ledger.keyRecords()).find(row => row.details?.expected?.request === 'TradeSpeedRequest');
    assert.equal(record.details.expected.accelerationReason, 'turnover');
    assert.equal(record.details.expected.savedSeconds, 4500);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  });
  await test('deadline模式保持最少抢救策略，缺样本或低收益不擅自预估周转', async () => {
    const f = fixture(now - 6 * 3600), metrics = sample(f);
    assert.equal(f.plan().kind, 'none');
    assert.equal(f.plan({ metrics: { ...metrics, turnoverProfitPerSecond: 0.1 } }).kind, 'wait');
    f.settings.merchant.speedUpMode = 'deadline';
    assert.equal(f.plan({ metrics }).kind, 'none');
    f.ctx.merchantMetrics = metrics;
    assert.equal(await f.run(), false);
    assert.equal(f.calls.length, 0);
    const g = fixture();
    g.settings.merchant.speedUpMode = 'deadline';
    assert.equal(g.plan({ metrics: sample(g, { turnoverProfitPerSecond: 100 }) }).useNum, 2);
  });
  await test('周转样本过期、跨期、跨起点或未来时间均退化为保守策略', async () => {
    const f = fixture(now - 6 * 3600);
    for (const invalid of [
      { observedAt: f.now - 14401 }, { observedAt: f.now + 1 }, { period: 1002 },
      { startTime: f.event.startTime - 86400 }, { turnoverProfitPerSecond: NaN },
      { turnoverProfitPerSecond: -1 }, { turnoverProfitPerSecond: Infinity },
      { turnoverObservedAt: null }, { turnoverObservedAt: f.now + 1 },
      { turnoverSampleCount: 1 }, { turnoverSampleSeconds: 59 }
    ]) assert.equal(f.plan({ metrics: sample(f, invalid) }).kind, 'none');
    assert.equal(f.plan({ turnoverProfitPerSecond: 1 }).kind, 'none', '无期次/时间元数据的裸速率不可信');
    assert.equal(f.plan(sample(f)).kind, 'speed', '允许完整元数据的扁平纯函数选项');
    f.ctx.merchantMetrics = sample(f, { observedAt: f.now - 14401 });
    assert.equal(await f.run(), false);
    assert.equal(f.calls.length, 0);
  });
  await test('成交样本独立保留两段航程，新行情不能延长旧出售证据', async () => {
    const f = fixture(now - 6 * 3600);
    const valid = sample(f, { observedAt: f.now, turnoverObservedAt: f.now - 7200,
      turnoverSampleCount: 2, turnoverSampleSeconds: 7200 });
    const plan = f.plan({ metrics: valid });
    assert.equal(plan.kind, 'speed', '成交样本超过300秒报价时效仍可用于周转');
    assert.equal(plan.evidenceExpiresAt, valid.turnoverObservedAt + 14400);
    assert.equal(f.plan({ metrics: { ...valid, turnoverObservedAt: f.now - 14400 } }).kind, 'speed');
    assert.equal(f.plan({ metrics: { ...valid, turnoverObservedAt: f.now - 14401 } }).kind, 'none');
    assert.equal(f.plan({ metrics: { ...valid, turnoverObservedAt: null } }).kind, 'none',
      '明确无成交时间时不能回退到新行情时间');
    assert.equal(f.plan({ metrics: sample(f, { observedAt: f.now - 7200 }) }).kind, 'speed', '兼容旧样本时间字段');
    f.settings.merchant.quoteMaxAgeSeconds = 18000;
    assert.equal(f.plan({ metrics: { ...valid, turnoverObservedAt: f.now - 15000 } }).kind, 'speed');
    f.ctx.merchantMetrics = valid;
    await f.run();
    assert.equal(f.sent().length, 1);
  });
  await test('指针不足时选有证据且可成交的部分加速，不用不足数量抢救截止', async () => {
    const f = fixture(now - 6 * 3600);
    f.settings.merchant.keepPointers = 3;
    const plan = f.plan({ metrics: sample(f) });
    assert.equal(plan.useNum, 1);
    assert.equal(plan.estimatedIncrementalProfit, 1800);
    f.ctx.getMerchantMetrics = () => sample(f);
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    assert.equal(f.stock.get(pointer), 3);
    const g = fixture();
    g.settings.merchant.keepPointers = 3;
    assert.equal(g.plan({ metrics: sample(g) }).kind, 'wait');
    g.ctx.merchantMetrics = () => sample(g);
    await g.run();
    assert.equal(g.sent().length, 0, '一枚赶不及窗口不能因存在历史速率而盲目加速');
  });
  await test('航程上限扣除本程已确认指针，达到上限后不重复消费', async () => {
    const f = fixture(now - 6 * 3600);
    f.settings.merchant.speedUpMaxPerLeg = 3;
    f.ctx.merchantMetrics = sample(f);
    const cargo = f.state.cargo;
    f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'prior-speed', details: {
      scope: 'merchant:' + f.event.startTime + ':' + f.event.period,
      expected: { request: 'TradeSpeedRequest', period: f.event.period, city: cargo.cityId,
        destination: cargo.moveToCityId, moveStartTime: cargo.moveStartTime, useNum: 2 }
    } }));
    assert.equal(f.plan({ metrics: sample(f), usedPointers: 2 }).useNum, 1);
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    await f.run();
    assert.equal(f.sent().length, 1);
    assert.equal(f.plan({ metrics: sample(f), usedPointers: 3 }).kind, 'wait');
  });
  await test('已观察目标报价可支持抢刷新，未知报价或无法赶上有效期不计收益', async () => {
    const at = now - 7 * 3600 - 20 * 60; // 北京时间 13:55，下一次14:00刷新。
    const f = fixture(at);
    f.settings.merchant.speedUpMinProfit = 100;
    const market = { cityId: 20, period: f.event.period, startTime: f.event.startTime,
      observedAt: at - 10, goods: [{ goodsId: 1001, price: 90 }] };
    assert.equal(f.plan().kind, 'none');
    const plan = f.plan({ targetMarket: market });
    assert.equal(plan.kind, 'speed');
    assert.equal(plan.useNum, 3);
    assert.equal(plan.accelerationReason, 'refresh');
    assert(plan.estimatedIncrementalProfit > 0);
    assert.match(plan.label, /刷新前兑现已观察报价/);
    f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'refresh-quote', details: { merchantMarket: market } }));
    await f.run();
    assert.equal(f.sent()[0].body.useNum, 3);
    const g = fixture(at);
    g.settings.merchant.speedUpMinProfit = 100;
    g.settings.merchant.keepPointers = 2;
    assert.equal(g.plan({ targetMarket: market }).kind, 'wait', '仅两枚加速仍无法赶上已知刷新时点');
    assert.equal(g.plan({ targetMarket: { ...market, observedAt: at - 301 } }).kind, 'none');
    assert.equal(g.plan({ targetMarket: { ...market, goods: [{ goodsId: 1001, price: 0 }] } }).kind, 'none');
    g.settings.merchant.keepPointers = 1;
    assert.equal(g.plan({ targetMarket: market, actionSeconds: 300 }).kind, 'wait', '较慢轮询来不及在刷新前完成出售');
  });
  await test('周转不足以完成下一循环或本轮间隔过长时不消耗指针', async () => {
    const f = fixture();
    f.state.cargo.moveEndTime = now + 1200;
    assert.equal(f.plan({ metrics: sample(f) }).kind, 'wait', '剩45分钟不足再完成一次两小时贸易');
    const g = fixture(now - 3 * 3600);
    assert.equal(g.plan({ metrics: sample(g), actionSeconds: 3600 }).kind, 'wait');
  });
  await test('收益样本或本程上限在复查期间变化时取消加速', async () => {
    for (const mutation of [
      f => { f.ctx.merchantMetrics = sample(f, { period: 9999 }); },
      f => { f.settings.merchant.speedUpMaxPerLeg = 1; },
      f => { f.settings.merchant.speedUpMode = 'deadline'; }
    ]) {
      const f = fixture(now - 6 * 3600);
      f.ctx.merchantMetrics = sample(f);
      f.hook(name => { if (name === 'TradeInfoRequest') mutation(f); });
      await f.run();
      assert.equal(f.sent().length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    }
  });
  await test('预留后样本变化或超过证据有效期，取消未发送指针并释放票据', async () => {
    for (const change of [
      f => { f.ctx.merchantMetrics = sample(f, { turnoverProfitPerSecond: 0.1 }); },
      f => { f.client.serverClockOffsetMs += 14401000; }
    ]) {
      const f = fixture(now - 6 * 3600);
      f.ctx.merchantMetrics = sample(f);
      const reserve = f.ledger.reserve;
      let observed = false;
      f.ledger.reserve = (...args) => {
        const ticket = reserve(...args);
        if (args[3]?.uniqueKey?.startsWith('event-action:')) { observed = true; change(f); }
        return ticket;
      };
      await f.run();
      assert.equal(observed, true);
      assert.equal(f.sent().length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('指针保留量、收益阈值与目的港资格同时限制发送', async () => {
    for (const edit of [
      f => f.stock.set(pointer, 2),
      f => { f.settings.merchant.speedUpMinProfit = 2000; },
      f => { f.radar.radar = [{ cityId: 10 }]; },
      f => { f.state.player.goods[0].cityId = 20; },
      f => { f.radar.radar[1].specGoodsId = 1001; },
      f => { f.state.player.goods[0].buyPrice = 46; },
      f => { f.state.player.goods[0].num = 1001; }
    ]) {
      const f = fixture(); edit(f); assert.equal(await f.run(), true); assert.equal(f.sent().length, 0);
    }
  });
  await test('按活动截止计算且不足一分钟不盲目使用指针', async () => {
    const f = fixture(); f.event.endTime = now + 180;
    assert.equal(f.plan().useNum, 3);
    f.event.endTime = now + 59;
    assert.equal(f.plan().kind, 'wait');
    await f.run(); assert.equal(f.sent().length, 0);
  });
  await test('立即到港计划跨秒复查仍可执行，以新时刻核对结果', async () => {
    const f = fixture(); f.event.endTime = now + 180;
    f.hook(name => { if (name === 'TradeInfoRequest') f.client.serverClockOffsetMs += 2000; });
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 3 }]);
    assert.equal(f.reports.at(-1).status, 'confirmed');
  });
  await test('两批估算利润必须预留两轮出售时间并增加最低指针数', async () => {
    const f = fixture(); f.state.cargo.moveEndTime = now + 4410;
    assert.equal(f.plan().useNum, 1, '一批到港后可留90秒');
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 });
    const plan = f.plan();
    assert.equal(plan.saleCount, 2); assert.equal(plan.saleSeconds, 120);
    assert.equal(plan.useNum, 2, '一枚仅剩90秒，不足以完成两笔出售');
    assert.equal(plan.estimatedProfit, 7210);
    await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 2 }]);
  });
  await test('自然到港仅剩90秒时两批需要一枚指针，只有一批可卖则无需', async () => {
    const f = fixture(); f.state.cargo.moveEndTime = now + 2610;
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 });
    assert.equal(f.plan().saleCount, 2); assert.equal(f.plan().useNum, 1);
    await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    const g = fixture(); g.state.cargo.moveEndTime = now + 2610;
    g.state.player.goods.push({ ...g.state.player.goods[0], pid: 2, cityId: 20 });
    assert.equal(g.plan().kind, 'none');
    assert.equal(await g.run(), false); assert.equal(g.sent().length, 0);
  });
  await test('180秒挂机间隔不会用只能留出60到120秒的方案消耗指针', async () => {
    for (const remaining of [60, 120]) {
      const f = fixture(); f.event.endTime = now + remaining;
      f.settings.loop = { everySeconds: 180 };
      assert.equal(f.plan({ actionSeconds: 180 }).kind, 'wait');
      await f.run(); assert.equal(f.sent().length, 0);
    }
  });
  await test('长挂机间隔按实际逐批时间增加指针，CLI间隔也参与', async () => {
    for (const cli of [false, true]) {
      const f = fixture(); f.state.cargo.moveEndTime = now + 4410;
      assert.equal(f.plan().useNum, 1);
      const plan = f.plan({ actionSeconds: 180 });
      assert.equal(plan.useNum, 2); assert.equal(plan.saleSeconds, 180);
      assert.match(plan.label, /预留 180 秒/);
      if (cli) { f.settings.loop = { everySeconds: 60 }; f.ctx.everyMs = 180000; }
      else f.settings.loop = { everySeconds: 180 };
      await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 2 }]);
    }
    const g = fixture(); g.state.cargo.moveEndTime = now + 2580;
    g.settings.loop = { everySeconds: 180 };
    assert.equal(g.plan().kind, 'none');
    await g.run(); assert.deepEqual(g.sent().map(row => row.body), [{ useNum: 1 }],
      '正常到港只剩120秒，首次快速判断也必须考虑180秒间隔');
  });
  await test('加速复查期间调大网页或CLI挂机间隔必须取消发送', async () => {
    for (const edit of [f => { f.settings.loop = { everySeconds: 180 }; },
      f => { f.ctx.everyMs = 180000; }]) {
      const f = fixture(); f.state.cargo.moveEndTime = now + 4410;
      f.hook(name => { if (name === 'TradeInfoRequest') edit(f); });
      await f.run(); assert.equal(f.sent().length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    }
  });
  await test('窗口只能出售一批时不累加两批收益消耗指针', async () => {
    const f = fixture(); f.event.endTime = now + 90;
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 });
    assert.equal(f.plan().kind, 'wait');
    await f.run(); assert.equal(f.sent().length, 0);
  });
  await test('当前有效到访低价压低加速估值，过期高价不提高基准估值', async () => {
    const f = fixture();
    const market = { cityId: 20, period: f.event.period, startTime: f.event.startTime,
      observedAt: now - 10, goods: [{ goodsId: 1001, price: 15 }] };
    assert.equal(f.plan({ markets: [market] }).kind, 'wait', '不能忽略已知低价按基准利润消耗指针');
    f.settings.merchant.speedUpMinProfit = 100;
    const low = f.plan({ markets: [market] });
    assert.equal(low.estimatedProfit, 309);
    assert.ok(low.expected.afterEndTime - market.observedAt > 300,
      '到港可能超过旧价TTL，仍保守采用低价上限而非恢复较高基准');
    assert.equal(f.plan({ markets: [{ ...market, goods: [{ goodsId: 1001, price: 100 }] }] }).estimatedProfit, 3605);
    for (const invalid of [
      { ...market, period: 2000 },
      { ...market, startTime: f.event.startTime - 86400 },
      { ...market, observedAt: now + 1 },
      { ...market, observedAt: now - 301 },
      { ...market, goods: [{ goodsId: 1001, price: 0 }] },
      { ...market, goods: [market.goods[0], market.goods[0]] }
    ]) assert.equal(f.plan({ markets: [invalid] }).estimatedProfit, 3605);
    f.settings.merchant.quoteMaxAgeSeconds = 10000;
    assert.equal(f.plan({ markets: [{ ...market, observedAt: now - 4501 }] }).estimatedProfit, 3605,
      '前一刷新周期的报价不能被当前TTL延长复活');
  });
  await test('加速执行从持久行情读取低价且复查期间出现低价会停发', async () => {
    for (const late of [false, true]) {
      const f = fixture();
      const remember = () => f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'market-low', details: {
        merchantMarket: { cityId: 20, period: f.event.period, startTime: f.event.startTime,
          observedAt: now, goods: [{ goodsId: 1001, price: 15 }] }
      } }));
      if (late) f.hook(name => { if (name === 'TradeInfoRequest') remember(); });
      else remember();
      await f.run(); assert.equal(f.sent().length, 0);
    }
  });
  await test('空批次条目安全等待，探索航程不会使用指针', async () => {
    const f = fixture(); f.state.player.goods = [null];
    assert.equal(f.plan().kind, 'wait'); await f.run(); assert.equal(f.sent().length, 0);
    const g = fixture();
    g.ledger.confirm(g.ledger.reserve({}, {}, {}, { uniqueKey: 'explore-leg', details: {
      scope: 'merchant:' + g.event.startTime + ':' + g.event.period,
      expected: { request: 'TradeMoveRequest', city: 10, destination: 20,
        start: g.state.cargo.moveStartTime, exploration: true }
    } }));
    assert.equal(await g.run(), false); assert.equal(g.calls.length, 0);
  });
  await test('发送前关闭开关、修改保留量或改变航程取消发送', async () => {
    for (const edit of [f => f.pause(), f => { f.settings.merchant.keepPointers = 3; },
      f => { f.state.cargo.moveToCityId = 30; }]) {
      const f = fixture(); let n = 0;
      f.hook(name => { if (name === 'TradeInfoRequest' && ++n === 1) edit(f); });
      await f.run(); assert.equal(f.sent().length, 0); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    }
  });
  await test('未确认指针预留阻止重复使用，且不阻塞其他材料', async () => {
    const f = fixture();
    const handle = beginOrderMaterialSpend(f.player, [{ id: pointer, have: 4, need: 1 }], '前次指针',
      { operation: { verify: async () => false } });
    await f.run(); assert.equal(f.sent().length, 0);
    assert.equal(Object.keys(f.ledger.keyRecords()).length, 0, '明确未发送释放持久票据');
    cancelOrderMaterialSpend(handle);
    const other = beginOrderMaterialSpend(f.player, [{ id: '木头', have: 4, need: 1 }], '其他材料',
      { operation: { verify: async () => false } });
    await f.run(); assert.equal(f.sent().length, 1); cancelOrderMaterialSpend(other);
  });
  await test('请求结果未知保留票据与指针，不因库存下降或重试而重发', async () => {
    const f = fixture(); f.mode('unknown'); await f.run();
    assert.equal(f.reports.at(-1).status, 'unknown');
    f.stock.set(pointer, 2); // 无关操作改变库存，不能据此确认航程。
    await refreshOrderMaterialSpends(f.client, f.player);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
    f.stock.set(pointer, 4); await f.run();
    assert.equal(f.sent().length, 1);
    assert.equal(Object.values(f.ledger.keyRecords()).filter(row => !row.confirmed).length, 1);
  });
  await test('加速未知记录保留原快照和尝试时间，恢复回调复用同一证据', async () => {
    const f = fixture(now - 6 * 3600), outcomes = [];
    f.settings.merchant.speedUpMaxPerLeg = 1;
    f.ctx.merchantMetrics = sample(f);
    f.ctx.onMerchantOutcome = entry => outcomes.push(structuredClone(entry));
    const original = structuredClone({ coins: f.state.player.coins, profit: f.state.player.profit,
      goods: f.state.player.goods, cargo: f.state.cargo });
    f.mode('unknown'); await f.run();
    const pending = Object.values(f.ledger.keyRecords()).find(row => !row.confirmed);
    assert.deepEqual(pending.details.before, original);
    assert.equal(pending.details.attemptedAt, f.now);
    assert.equal(outcomes[0].status, 'unknown');
    assert.deepEqual(outcomes[0].before, original);
    f.state.cargo.moveEndTime -= 1800;
    f.stock.set(pointer, 3);
    f.client.serverClockOffsetMs += 1000;
    f.mode(''); await f.run();
    assert.equal(f.sent().length, 1, '恢复结果不重复发送指针');
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[1].status, 'confirmed');
    assert.equal(outcomes[1].actionKey, outcomes[0].actionKey);
    assert.equal(outcomes[1].attemptedAt, outcomes[0].attemptedAt);
    assert.deepEqual(outcomes[1].before, original);
    assert.equal(outcomes[1].after.cargo.moveEndTime, original.cargo.moveEndTime - 1800);
    assert.equal(Object.values(f.ledger.keyRecords()).filter(row => !row.confirmed).length, 0);
  });
  await test('明确未发送和服务端拒绝释放材料及持久票据', async () => {
    for (const mode of ['not-sent', 'rejected']) {
      const f = fixture(); f.mode(mode); await f.run();
      assert.equal(f.sent().length, 1);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
      assert.equal(Object.keys(f.ledger.keyRecords()).length, 0);
    }
  });
  await test('回包丢失仅以同程提前证据恢复，完整库存失败继续预留', async () => {
    const f = fixture(); const expected = f.plan().expected;
    f.mode('applied-timeout'); await f.run();
    assert.equal(f.sent().length, 1);
    assert.equal(merchantSpeedMatches(expected, f.state, now), true);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    const g = fixture(); g.mode('inventory-fails'); await g.run();
    assert.equal(g.reports.at(-1).status, 'confirmed');
    assert.equal(pendingOrderMaterialSpends(g.player).length, 1);
    g.mode(''); await refreshOrderMaterialSpends(g.client, g.player);
    assert.equal(pendingOrderMaterialSpends(g.player).length, 0);
  });
  await test('自然到港、其他航程和未达预期的缩短不确认加速', async () => {
    const f = fixture(), expected = f.plan().expected;
    const arrived = { cargo: { ...f.state.cargo, cityId: 20, moveToCityId: 0, moveEndTime: 0 } };
    assert.equal(merchantSpeedMatches(expected, arrived, expected.beforeEndTime + 1), false);
    assert.equal(merchantSpeedMatches(expected, arrived, expected.beforeEndTime - 1), true);
    arrived.cargo.moveStartTime += 1;
    assert.equal(merchantSpeedMatches(expected, arrived, now), false);
    f.state.cargo.moveEndTime -= 10;
    assert.equal(merchantSpeedMatches(expected, f.state, now), false);
  });
  console.log('海商王指针测试通过：' + passed + ' 项');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
