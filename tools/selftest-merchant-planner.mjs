import assert from 'node:assert/strict';
import { merchantActionSeconds, merchantSettings, merchantTiming, optimizePurchasePlan, planMerchant } from '../src/merchant-planner.mjs';

const table = data => ({ data });
const now = Date.UTC(2026, 10, 12, 4, 10) / 1000;
function fixture() {
  const config = { tables: {
    ActivityTradeCfg: table([
      { key: '海商王贸易时间', value: '10-22' },
      { key: '海商王行驶时间', value: '120' },
      { key: '海商王刷新时间', value: '10,12,14,16,18,20' }
    ]),
    TradeShipCfg: table([{ lv: 1, capacity: 10, profitMargin: 300 }]),
    TradeGoodsCfg: table([
      { goodsId: 1, capacity: 1, unitPrice: 100, maxCount: 20, itemName: '鱼' },
      { goodsId: 2, capacity: 1, unitPrice: 200, maxCount: 20, itemName: '水' },
      { goodsId: 3, capacity: 1, unitPrice: 300, maxCount: 20, itemName: '盐' }
    ])
  } };
  const event = { startTime: now - 86400, endTime: now + 86400, period: 1001 };
  const state = { period: 1001, player: { coins: 1000, profit: 0, goods: [] },
    cargo: { cityId: 10, cargoLv: 1, moveEndTime: 0, moveToCityId: 0 } };
  const market = { goods: [{ goodsId: 1, price: 50, stock: 0 }], specGoodsId: 1 };
  const radar = { radar: [{ cityId: 10, specGoodsId: 1, rareGoodsId: 0 }, { cityId: 20, specGoodsId: 2, rareGoodsId: 0 },
    { cityId: 30, specGoodsId: 3, rareGoodsId: 0 }] };
  const f = { config, event, state, market, radar, now, visited: [], settings: {}, markets: [] };
  f.plan = () => planMerchant(config, event, state, f.market, f.radar, f.now, f.visited,
    { settings: f.settings, markets: f.markets, actionSeconds: f.actionSeconds });
  f.batch = (extra = {}) => ({ pid: 1, goodsId: 1, cityId: 10, buyPrice: 50, num: 10, ...extra });
  f.history = (cityId, price, extra = {}) => ({ cityId, observedAt: f.now, period: event.period, startTime: event.startTime,
    goods: [{ goodsId: 1, price, stock: 0 }], ...extra });
  return f;
}
let tests = 0;
const test = (name, fn) => { fn(); tests++; console.log('通过：' + name); };

test('配置归一化与北京时间交易、刷新边界使用真实配置', () => {
  const f = fixture(), timing = merchantTiming(f.config, f.event, f.now);
  assert.equal(timing.travelSeconds, 7200);
  assert.equal(timing.nextRefreshAt - f.now, 110 * 60);
  assert(timing.tradingOpen);
  assert.equal(merchantTiming(f.config, f.event, Date.UTC(2026, 10, 12, 14) / 1000).tradingOpen, false);
  assert.equal(merchantSettings({ maxLossPercent: 200 }).maxLossPercent, 100);
  assert.equal(merchantSettings({ minExpectedProfit: -1 }).minExpectedProfit, 1);
  assert.equal(merchantSettings({ autoSpeedUp: 'true' }).autoSpeedUp, false);
});

test('每动作余量取配置和真实间隔较大值，非法输入安全回落', () => {
  assert.equal(merchantActionSeconds(), 60);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: 1 } }, 10), 60);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: 180 } }, 300), 300);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: 300 } }, 180), 300);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: -1 } }, NaN), 60);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: '300' } }, Infinity), 60);
  const f = fixture(), before = f.plan();
  for (const value of [undefined, 0, -1, 1, 59, 60, 60.5, NaN, Infinity, '180']) {
    f.actionSeconds = value;
    assert.deepEqual(f.plan(), before);
  }
});

test('长轮询间隔按实际操作预算阻止截止前无法完成的采购', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7200 + 500;
  assert.equal(f.plan().kind, 'buy');
  f.actionSeconds = 180;
  assert.notEqual(f.plan().kind, 'buy');
  f.actionSeconds = 300;
  assert.notEqual(f.plan().kind, 'buy');
});

test('长轮询间隔按可售批次数约束出航和最新发送时间', () => {
  const f = fixture();
  f.state.player.goods = [f.batch()];
  f.event.endTime = f.now + 7200 + 200;
  f.settings.liquidationMinutes = 0;
  f.actionSeconds = 180;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.latestActionAt, f.event.endTime - 7200 - 180);
  f.actionSeconds = 300;
  assert.equal(f.plan().kind, 'wait');
});

test('刷新等待与空船寻价也按长轮询间隔计算完整后续动作', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 5, 59) / 1000;
  f.event.endTime = f.now + 7200 + 500;
  f.settings.liquidationMinutes = 0;
  f.market.goods[0].stock = 20;
  assert.equal(f.plan().mode, 'WAIT_REFRESH');
  f.actionSeconds = 180;
  assert.notEqual(f.plan().mode, 'WAIT_REFRESH');
  f.event.endTime = f.now + 14400 + 900;
  f.settings.refreshWaitSeconds = 0;
  f.market.goods[0].price = 100;
  const explore = f.plan();
  assert.equal(explore.exploration, true);
  assert.equal(explore.latestActionAt, f.event.endTime - 14400 - 4 * 180);
  f.actionSeconds = 300;
  assert.equal(f.plan().kind, 'wait');
});

test('组合采购截止对多笔操作逐一计入长轮询间隔', () => {
  const f = fixture();
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  f.actionSeconds = 300;
  const plan = f.plan(), timing = merchantTiming(f.config, f.event, f.now);
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.purchases.length, 2);
  assert.equal(plan.latestActionAt, timing.tradeEndTime - 7200 - 1500);
});

test('没有联盟紧缺共享也能按风险折扣估算先选港再买入', () => {
  const f = fixture(), plan = f.plan();
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.destination, 20);
  assert.equal(plan.count, 10);
  assert.equal(plan.expectedProfit, 412);
  assert.equal(plan.estimated, true);
  assert.match(plan.label, /风险折扣估算/);
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 500;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.destination, 20);
});

test('单位容量收益与组合采购取代单商品跌幅优先', () => {
  const f = fixture();
  f.config.tables.TradeGoodsCfg.data[0].capacity = 6;
  f.config.tables.TradeGoodsCfg.data[1].capacity = 5;
  f.config.tables.TradeGoodsCfg.data[1].unitPrice = 100;
  f.market.goods = [{ goodsId: 1, price: 40, stock: 19 }, { goodsId: 2, price: 45, stock: 18 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.goodsId, 2);
  assert.equal(plan.count, 2);
  assert.equal(plan.expectedProfit, 93);
});

test('有界组合背包在容量和现金双约束下优于逐件贪心', () => {
  const offers = [
    { goodsId: 1, price: 6, capacity: 6, count: 1, unitProfit: 11 },
    { goodsId: 2, price: 5, capacity: 5, count: 2, unitProfit: 9 }
  ];
  const plan = optimizePurchasePlan(offers, 10, 10);
  assert.equal(plan.profit, 18);
  assert.equal(plan.purchases[0].goodsId, 2);
  assert.equal(plan.purchases[0].count, 2);
  const mixed = optimizePurchasePlan([
    { goodsId: 1, price: 2, capacity: 3, count: 2, unitProfit: 9 },
    { goodsId: 2, price: 3, capacity: 2, count: 3, unitProfit: 8 }
  ], 10, 10);
  assert.equal(mixed.profit, 34);
  assert.deepEqual(mixed.purchases.map(row => [row.goodsId, row.count]), [[1, 2], [2, 2]]);
});

test('小规模组合与穷举比较，库存、余舱和现金均不超限', () => {
  let seed = 19;
  const random = max => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let sample = 0; sample < 100; sample++) {
    const offers = Array.from({ length: 3 }, (_, i) => ({ goodsId: i + 1, price: random(8) + 1,
      capacity: random(6) + 1, count: random(4) + 1, unitProfit: random(10) + 1 }));
    const capacity = random(15) + 1, cash = random(25) + 1;
    let expected = 0;
    for (let a = 0; a <= offers[0].count; a++) for (let b = 0; b <= offers[1].count; b++) for (let c = 0; c <= offers[2].count; c++) {
      const counts = [a, b, c];
      const cost = offers.reduce((sum, item, i) => sum + item.price * counts[i], 0);
      const space = offers.reduce((sum, item, i) => sum + item.capacity * counts[i], 0);
      if (cost <= cash && space <= capacity) expected = Math.max(expected, offers.reduce((sum, item, i) => sum + item.unitProfit * counts[i], 0));
    }
    const actual = optimizePurchasePlan(offers, capacity, cash);
    assert.equal(actual.profit, expected, '小空间应取得全局最优');
    assert.equal(actual.approximate, false);
    assert(actual.cost <= cash && actual.capacity <= capacity);
    for (const item of actual.purchases) assert(item.count <= offers.find(o => o.goodsId === item.goodsId).count);
  }
});

test('大空间有界近似也遵守两项资源与库存限制', () => {
  const offers = Array.from({ length: 15 }, (_, i) => ({ goodsId: i + 1, price: 71 + i * 23,
    capacity: 1 + i % 5, count: 60000, unitProfit: 14 + i * 11 }));
  const plan = optimizePurchasePlan(offers, 81000, 10000000, { maxStates: 128 });
  assert(plan.approximate);
  assert(plan.profit > 0);
  assert(plan.cost <= 10000000 && plan.capacity <= 81000);
  assert(plan.purchases.every(item => item.count <= 60000));
});

test('每批成本和来源港独立计算，本港出售不依赖商情接口', () => {
  const f = fixture();
  f.state.cargo.cityId = 30;
  f.state.player.goods = [f.batch({ pid: 1, cityId: 20, buyPrice: 40, num: 5 }), f.batch({ pid: 2, cityId: 30, buyPrice: 80, num: 5 })];
  f.market.goods[0].price = 100;
  f.radar = null;
  const plan = f.plan();
  assert.equal(plan.kind, 'sell');
  assert.equal(plan.pid, 1);
  assert.equal(plan.count, 5);
  assert.equal(plan.gain, 309);
  assert.equal(plan.estimated, false);
});

test('目的港按所有批次总收益排序而不是首个紧缺匹配', () => {
  const f = fixture();
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, num: 9, buyPrice: 80 })];
  f.radar.radar = [{ cityId: 20, specGoodsId: 2, rareGoodsId: 1 }, { cityId: 30, specGoodsId: 3, rareGoodsId: 2 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert(plan.expectedProfit > 900);
});

test('出售决策按整船实际目标比较，不被另一港单批最高收益绑住', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, num: 9, buyPrice: 80 })];
  f.market.goods = [{ goodsId: 1, price: 60, stock: 20 }, { goodsId: 2, price: 70, stock: 20 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 2 }, { cityId: 40, specGoodsId: 1 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'sell');
  assert.equal(plan.pid, 1, '港40承接整船主要收益，货1当前出售比为了港30的单批收益占舱更好');
  f.state.player.goods.shift();
  f.state.player.coins += plan.count * 50 + plan.gain;
  assert.equal(f.plan().destination, 40);
});

test('没有指针也选自然可达的高收益出售子集，不因整船售不完选低收益港', () => {
  const f = fixture();
  f.settings.autoSpeedUp = true;
  f.settings.keepPointers = 100;
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7200 + 90;
  f.state.player.goods = [f.batch({ num: 5 }), f.batch({ pid: 2, goodsId: 2, num: 5, buyPrice: 80 })];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert.deepEqual(plan.salePids, [2]);
  assert.equal(plan.expectedProfit, 515);
  assert.equal(plan.accelerationRequired, 0);
  assert.equal(plan.latestActionAt, f.event.endTime - 7200 - 60);
});

test('可售子集仍遵守本批来源港和清仓亏损上限', () => {
  const f = fixture();
  f.settings.maxLossPercent = 10;
  f.settings.liquidationMinutes = 180;
  f.event.endTime = f.now + 7200 + 90;
  f.state.player.goods = [f.batch({ pid: 1, cityId: 20, num: 5, buyPrice: 100 }),
    f.batch({ pid: 2, cityId: 30, num: 5, buyPrice: 101 })];
  f.radar.radar = [{ cityId: 20, specGoodsId: 2 }, { cityId: 30, specGoodsId: 2 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert.deepEqual(plan.salePids, [1]);
  assert.equal(plan.expectedProfit, -50);
});

test('当前盈利小但继续持有风险调整后收益明显更高时保留', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods[0].price = 55;
  f.market.goods[0].stock = 20;
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
});

test('不可回访的高估收益港不会阻止本港实际盈利出售', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods[0].price = 55;
  f.market.goods[0].stock = 20;
  f.visited = [30];
  assert.equal(f.plan().kind, 'sell');
});

test('释放舱位可采购高收益组合时，优先本港获利出售', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods = [{ goodsId: 1, price: 75, stock: 20 }, { goodsId: 2, price: 50, stock: 0 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'sell');
  assert.match(plan.label, /再采购预计收益/);
});

test('赶不及执行的换货机会不能诱导提前出售原本应持有的货', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7440;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, num: 9, buyPrice: 80 })];
  f.market.goods = [{ goodsId: 1, price: 55, stock: 20 }, { goodsId: 2, price: 70, stock: 20 }, { goodsId: 3, price: 1, stock: 0 }];
  f.radar.radar = [{ cityId: 40, specGoodsId: 99 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 40);
});

test('已持货占用容量，少量库存不会丢弃其他组合机会', () => {
  const f = fixture();
  f.state.player.goods = [f.batch({ num: 6 })];
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 17 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.purchases.reduce((sum, row) => sum + row.count * row.capacity, 0), 4);
  assert.equal(plan.purchases.find(row => row.goodsId === 1).count, 1);
  assert.equal(plan.purchases.find(row => row.goodsId === 2).count, 3);
});

test('组合采购逐笔重算后仍补齐其余商品，再执行整船出航', () => {
  const f = fixture();
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const executed = [];
  for (let step = 0; step < 3; step++) {
    const plan = f.plan();
    executed.push(plan.kind);
    if (plan.kind === 'move') {
      assert.equal(plan.destination, 30);
      break;
    }
    assert.equal(plan.kind, 'buy');
    f.state.player.coins -= plan.price * plan.count;
    f.state.player.goods.push(f.batch({ pid: step + 1, goodsId: plan.goodsId, buyPrice: plan.price, num: plan.count }));
    f.market.goods.find(row => row.goodsId === plan.goodsId).stock += plan.count;
    f.now += 60;
  }
  assert.deepEqual(executed, ['buy', 'buy', 'move']);
  assert.equal(f.state.player.goods.reduce((sum, row) => sum + row.num, 0), 10);
});

test('已知低价压低目的港估值，过期或跨期报价不当现价', () => {
  const f = fixture();
  f.state.player.goods = [f.batch()];
  f.markets = [f.history(20, 30)];
  assert.equal(f.plan().destination, 30);
  f.markets[0].observedAt -= 301;
  assert.equal(f.plan().destination, 20);
  f.markets = [f.history(20, 30, { period: 999 })];
  assert.equal(f.plan().destination, 20);
  f.markets = [f.history(20, 30, { startTime: f.event.startTime - 86400 })];
  assert.equal(f.plan().destination, 20);
  f.settings.quoteMaxAgeSeconds = 86400;
  f.markets = [f.history(20, 30, { observedAt: f.now - 601 })];
  assert.equal(f.plan().destination, 20, '跨12点刷新仍不能沿用低报价');
});

test('历史记录不能自行增加当前列表中没有的航行港', () => {
  const f = fixture();
  f.radar = { radar: [] };
  f.markets = [f.history(20, 1000)];
  assert.equal(f.plan().kind, 'wait');
  assert.match(f.plan().reason, /港口列表/);
});

test('本港缺货且刷新收益值得等待才进入 WAIT_REFRESH', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 5, 59) / 1000;
  f.market.goods[0].stock = 20;
  const plan = f.plan();
  assert.equal(plan.kind, 'wait');
  assert.equal(plan.mode, 'WAIT_REFRESH');
  assert.equal(plan.nextCheckAt - f.now, 60);
  f.settings.refreshWaitSeconds = 0;
  assert.notEqual(f.plan().mode, 'WAIT_REFRESH');
  f.market.goods[0].stock = 0;
  f.settings.refreshWaitSeconds = 120;
  assert.equal(f.plan().kind, 'buy', '充足库存没有等待收益');
});

test('等待会错过交易窗口时不等刷新，现有货及时出航', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 5, 59) / 1000;
  f.event.endTime = f.now + 7200 + 90;
  f.settings.liquidationMinutes = 0;
  f.state.player.goods = [f.batch({ num: 5 })];
  f.market.goods[0].stock = 20;
  assert.equal(f.plan().kind, 'move');
});

test('最后一程按实际可售批次数留余量，不被其他滞销货卡住', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7330;
  f.state.cargo.cityId = 20;
  f.state.player.coins = 0;
  f.state.player.goods = [f.batch({ num: 1 }),
    ...Array.from({ length: 9 }, (_, i) => f.batch({ pid: i + 2, goodsId: 2, num: 1, buyPrice: 200 }))];
  f.market.goods = [{ goodsId: 1, price: 55, stock: 20 }, { goodsId: 2, price: 190, stock: 20 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert.equal(plan.latestActionAt, f.event.endTime - 7200 - 60);
});

test('采购与空船寻价暴露完整操作截止，不仅预留单次出售时间', () => {
  const f = fixture();
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan(), timing = merchantTiming(f.config, f.event, f.now);
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.purchases.length, 2);
  assert.equal(plan.latestActionAt, timing.tradeEndTime - 7200 - 300);
  f.market.goods = [{ goodsId: 1, price: 100, stock: 0 }];
  const explore = f.plan();
  assert.equal(explore.exploration, true);
  assert.equal(explore.latestActionAt, timing.tradeEndTime - 14400 - 240);
});

test('活动临近结束禁止新采购，同时仍可本港获利出售', () => {
  const f = fixture();
  f.event.endTime = f.now + 7300;
  assert.notEqual(f.plan().kind, 'buy', '必须为采购和到港出售留出时间');
  f.event.endTime = f.now + 30;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.market.goods[0].price = 70;
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().mode, 'FINAL_LIQUIDATION');
});

test('期末仅显式配置限额内清仓，亏损不乘利润加成', () => {
  const f = fixture();
  f.event.endTime = f.now + 120;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.market.goods[0].price = 45;
  assert.equal(f.plan().kind, 'wait');
  f.settings.maxLossPercent = 10;
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().gain, -50);
  f.settings.maxLossPercent = 9;
  assert.equal(f.plan().kind, 'wait');
});

test('清仓期可执行更少亏损的异港路线，已访问港不阻止本港止损', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 180;
  f.settings.maxLossPercent = 20;
  f.event.endTime = f.now + 9000;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch({ buyPrice: 100 })];
  f.market.goods[0].price = 80;
  assert.equal(f.plan().kind, 'move');
  assert.equal(f.plan().destination, 30);
  assert.equal(f.plan().expectedProfit, -100);
  f.visited = [30];
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().gain, -200);
  f.settings.maxLossPercent = 0;
  f.market.goods[0].price = 100;
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().gain, 0, '期末保本出售不需要允许亏损');
});

test('持货寻价和空船调港有边界，不凭过期商情循环往返', () => {
  const f = fixture();
  f.state.player.goods = [f.batch({ buyPrice: 95 })];
  f.market.goods[0].price = 95;
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.exploration, true);
  assert.equal(plan.expectedProfit, 0);
  f.visited = [20, 30];
  assert.equal(f.plan().kind, 'wait');
  f.state.player.goods = [];
  f.visited = [];
  assert.equal(f.plan().exploration, true);
  f.event.endTime = f.now + 10800;
  assert.equal(f.plan().kind, 'wait', '空船调港后还需一次载货航程');
});

test('重复批次、重复报价、过期本港快照和超舱均停止执行', () => {
  const mutations = [
    f => f.state.player.goods = [f.batch({ num: 5 }), f.batch({ num: 5 })],
    f => f.market.goods.push({ ...f.market.goods[0] }),
    f => f.market.observedAt = f.now - 301,
    f => f.market.observedAt = f.now + 1,
    f => f.state.player.goods = [f.batch({ num: 11 })],
    f => f.state.player.goods = [f.batch({ buyPrice: Number.MAX_SAFE_INTEGER })],
    f => f.state.player.goods = [null],
    f => f.market.goods = [null]
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.equal(f.plan().kind, 'wait');
  }
});

test('畸形历史快照被忽略，不因空记录中断当前合法计划', () => {
  const f = fixture();
  for (const goods of [[null], [{ goodsId: 1, price: -1 }], [{ goodsId: 1, price: 20 }, { goodsId: 1, price: 200 }]]) {
    f.markets = [null, f.history(20, 30, { goods })];
    assert.equal(f.plan().kind, 'buy');
    assert.equal(f.plan().destination, 20);
  }
});

test('矛盾港口信息不参与目的港选择，坏库存不能购买', () => {
  const f = fixture();
  f.radar.radar.push({ cityId: 20, specGoodsId: 3, rareGoodsId: 1 });
  assert.equal(f.plan().destination, 30);
  f.market.goods[0].stock = 21;
  assert.notEqual(f.plan().kind, 'buy');
  f.market.goods[0].stock = -1;
  assert.notEqual(f.plan().kind, 'buy');
});

console.log('海商王纯策略验证完成：' + tests + ' 项');
