import { runLoop } from '../src/loop.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUsageLedger,
  importAutomationSettings,
  exportAutomationSettings,
  validateSettings
} from '../src/automation-settings.mjs';
import {
  militaryRewards,
  riverActivity,
  compassActivity,
  beautyActivity,
  leadingCandidate
} from '../src/seasonal-activities.mjs';
import { merchantActivity, merchantProgress, readMerchantStatus, merchantJournalSummary, readMerchantJournal } from '../src/merchant-activity.mjs';
import { seasonalFixture } from './fixtures/seasonal-suite.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-')),
  file = () => path.join(folder, Math.random() + '.json');
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('通过：' + name);
}
function setup() {
  const f = seasonalFixture(),
    store = file(),
    ledger = createUsageLedger('fixture', { file: store }),
    reports = [];
  let enabled = true;
  const run = (service, key) =>
    service(f.client, f.config, {
      player: f.player,
      clientInfo: { appId: '14021170', channelId: '1400', originVersion: '74.0.0' },
      language: 'zh_CN',
      key,
      label: key,
      ledger,
      settings: () => f.settings,
      enabled: () => enabled,
      report: (r) => reports.push(r)
    });
  return {
    ...f,
    ledger,
    store,
    reports,
    run,
    pause: () => {
      enabled = false;
    },
    sent: (n) => f.state.writes.filter((r) => r.name === n)
  };
}
await test('军备五档积分与专属免费格分别领取，商城普通包与付费格不进入', async () => {
  const f = setup();
  await f.run(militaryRewards, 'armsRaceRewards');
  await f.run(militaryRewards, 'armsRaceRewards');
  assert.equal(f.sent('GetDailyRewardRequest').length, 1);
  assert.deepEqual(
    f.sent('LimitedShopGotFreeRequest').map((r) => r.body.id),
    [90000]
  );
  assert.equal(f.state.writes.length, 2);
});
await test('走江积分、战令及免费/广告助力分别回读，二次检查无重复', async () => {
  const f = setup();
  for (let i = 0; i < 2; i++)
    for (const key of ['riverScore', 'riverPass', 'riverHelp']) await f.run(riverActivity, key);
  assert.deepEqual(
    f.state.writes.map((r) => r.name),
    [
      'SnowballClaimRewardRequest',
      'BattlePassGotRewardRequest',
      'SnowballClaimGiftRequest',
      'WatchAdvRequest',
      'GotAdvRewardRequest'
    ]
  );
  assert.equal(f.sent('BattlePassGotRewardRequest')[0].body.type, 10);
  assert.deepEqual(f.sent('GotAdvRewardRequest')[0].body, { type: 4, id: 1001 });
});
await test('广告权益不足等待后领取，活动未开放不读写活动协议', async () => {
  const f = setup();
  f.player.vip.vipLevel = 0;
  f.settings.ads = { noPrivilege: false, waitSeconds: 0.01 };
  await f.run(riverActivity, 'riverHelp');
  assert.equal(f.sent('GotAdvRewardRequest').length, 1);
  f.client.festivals[0].subActivity[0].openTime = f.now + 100;
  const before = f.state.reads.length;
  await f.run(riverActivity, 'riverScore');
  assert.equal(f.state.reads.length, before);
});
await test('罗盘免费日包、库存阈值和每批数量，真实编码后仅消耗铜钱', async () => {
  const f = setup();
  await f.run(compassActivity, 'compassDaily');
  await f.run(compassActivity, 'compassDaily');
  await f.run(compassActivity, 'compassReward');
  await f.run(compassActivity, 'compassReward');
  assert.equal(f.sent('ClaimCompassWheelRewardRequest').length, 1);
  assert.equal(f.sent('ClaimFreeSelectGiftRequest').length, 1);
  await f.run(compassActivity, 'compassSpin');
  await f.run(compassActivity, 'compassSpin');
  assert.equal(f.sent('SpinCompassWheelRequest').length, 1);
  assert.equal(f.sent('SpinCompassWheelRequest')[0].body.num, 10);
  assert.equal(f.state.stock['活动26捞尸人_抽奖券'], 2);
  f.settings.eventActions.compassThreshold = 20;
  f.settings.eventActions.compassDrawCount = 5;
  f.state.stock['活动26捞尸人_抽奖券'] = 25;
  await f.run(compassActivity, 'compassSpin');
  assert.equal(f.sent('SpinCompassWheelRequest').at(-1).body.num, 5);
  f.state.wheel.cost.id = 'RUBY';
  await f.run(compassActivity, 'compassSpin');
  assert.equal(f.sent('SpinCompassWheelRequest').length, 2);
});
await test('罗盘未知结果跨账本实例防重，暂停或中途提阈值不会发送', async () => {
  const f = setup();
  f.state.mode = 'unknown';
  await f.run(compassActivity, 'compassSpin');
  f.state.mode = '';
  await compassActivity(f.client, f.config, {
    key: 'compassSpin',
    label: '罗盘',
    ledger: createUsageLedger('fixture', { file: f.store }),
    enabled: () => true,
    settings: () => f.settings,
    report: (r) => f.reports.push(r)
  });
  assert.equal(f.sent('SpinCompassWheelRequest').length, 1);
  assert(f.reports.some((r) => r.status === 'pending' || r.reason?.includes('待确认')));
  const g = setup();
  let reads = 0;
  g.state.onRead = (name) => {
    if (name === 'AllItem' && ++reads === 2) g.settings.eventActions.compassThreshold = 30;
  };
  await g.run(compassActivity, 'compassSpin');
  assert.equal(g.state.writes.length, 0);
  const h = setup();
  h.pause();
  await h.run(compassActivity, 'compassSpin');
  assert.equal(h.state.writes.length, 0);
});
await test('风采只按服务端票数，平票按编号，当日已投1票补2票并领包', async () => {
  const f = setup();
  assert.equal(leadingCandidate(f.state.beauty, f.config).no, 620);
  for (let i = 0; i < 2; i++) {
    await f.run(beautyActivity, 'beautyVotes');
    await f.run(beautyActivity, 'beautyGift');
  }
  assert.deepEqual(
    f.sent('BeautyVoteRequest').map((r) => r.body),
    [{ no: 620, count: 2 }]
  );
  assert.equal(f.sent('GotBeautyVoteRequest').length, 1);
  assert.equal(f.state.stock['代颜人投票券'], 7);
  assert.equal(f.state.beauty.todayVote, 3);
});
await test('投票券不足只投已有数量，展示期和未知结果不重复投票', async () => {
  const f = setup();
  f.state.stock['代颜人投票券'] = 1;
  f.state.mode = 'unknown';
  await f.run(beautyActivity, 'beautyVotes');
  f.state.mode = '';
  f.state.beauty.player[0].vote = 100;
  await f.run(beautyActivity, 'beautyVotes');
  assert.equal(f.sent('BeautyVoteRequest').length, 1);
  const g = setup();
  g.client.beautyWindow.endTime = g.now;
  await g.run(beautyActivity, 'beautyVotes');
  assert.equal(g.state.writes.length, 0);
});
await test('海商王真实行情模型低价买入、按商情走商、到港盈利出售', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeBuyRequest')[0].body, { cityId: 10, goodsId: 1001, buyNum: 250 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeMoveRequest')[0].body, { cityId: 10, mvToCityId: 20 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 2);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  f.state.markets[20].goods[0].price = 30;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 0);
  f.state.markets[20].goods[0].price = 65;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert(f.state.trade.player.profit > 6000);
});
await test('无紧缺共享时仍可买入并走普通港，到港出售不依赖商情', async () => {
  const f = setup();
  for (const port of f.state.radar.radar) port.rareGoodsId = 0;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  const radar = f.state.radar.radar;
  f.state.radar.radar = [];
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  f.state.radar.radar = radar;
  f.state.markets[20].goods = [{ goodsId: 1002, price: 35, stock: 0 }];
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest')[1].body.goodsId, 1002);
  const empty = setup();
  empty.state.radar.radar = [];
  await empty.run(merchantActivity, 'merchantTrade');
  assert.equal(empty.state.writes.length, 0, '港口列表完全未知时不盲目装货或选取世界城市');
});
await test('大跌幅但少量库存不再压过整船收益，售罄商品不进入组合', async () => {
  for (const remaining of [1, 0]) {
    const f = setup();
    f.state.radar.radar[1].specGoodsId = 1003;
    f.state.markets[10].goods = [
      { goodsId: 1001, price: 10, stock: 60000 - remaining },
      { goodsId: 1002, price: 35, stock: 0 }
    ];
    await f.run(merchantActivity, 'merchantTrade');
    const buy = f.sent('TradeBuyRequest')[0].body;
    assert.equal(buy.goodsId, 1002);
    assert.equal(buy.buyNum, 285);
    await f.run(merchantActivity, 'merchantTrade');
    if (remaining) assert.deepEqual(f.sent('TradeBuyRequest')[1].body, { cityId: 10, goodsId: 1001, buyNum: 1 });
    else assert.equal(f.sent('TradeBuyRequest').length, 1);
  }
});
await test('多商品组合逐笔复查采购，夹具更新库存并为每批分配唯一编号', async () => {
  const f = setup();
  f.state.radar.radar[1].specGoodsId = 1003;
  f.state.markets[10].goods = [
    { goodsId: 1001, price: 20, stock: 59990 },
    { goodsId: 1002, price: 30, stock: 59980 }
  ];
  await f.run(merchantActivity, 'merchantTrade');
  assert(f.reports.some(row => /组合 2 种/.test(row.label)));
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeBuyRequest').map(row => [row.body.goodsId, row.body.buyNum]), [[1002, 20], [1001, 10]]);
  assert.equal(f.state.trade.player.coins, 9200);
  assert.equal(new Set(f.state.trade.player.goods.map(g => g.pid)).size, 2);
  assert.deepEqual(f.state.markets[10].goods.map(g => g.stock), [60000, 60000]);
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeMoveRequest')[0].body, { cityId: 10, mvToCityId: 20 });
});
await test('雷达读取失败仍核对本港利润出售，空船没有可靠港口列表时不盲目行动', async () => {
  for (const loaded of [true, false]) {
    const f = setup();
    f.state.onRead = name => { if (name === 'TradeGuildRadar') throw Error('联盟商情暂不可用'); };
    if (loaded) f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 20, buyPrice: 20, num: 10 }];
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeSellRequest').length, loaded ? 1 : 0);
    assert.equal(f.sent('TradeBuyRequest').length, 0);
    assert.equal(f.sent('TradeMoveRequest').length, 0);
  }
});
await test('同商品不同成本逐批出售，保留来源为当前港的批次', async () => {
  const f = setup();
  f.state.trade.cargo.cityId = 20;
  f.state.radar.radar = [];
  f.state.trade.player.goods = [
    { pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 },
    { pid: 202, goodsId: 1001, cityId: 30, buyPrice: 60, num: 10 },
    { pid: 203, goodsId: 1001, cityId: 20, buyPrice: 10, num: 5 }
  ];
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeSellRequest')[0].body, { cityId: 20, pid: 201, sellNum: 10 });
  assert.equal(f.state.trade.player.profit, 6258);
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeSellRequest')[1].body, { cityId: 20, pid: 202, sellNum: 10 });
  assert.equal(f.state.trade.player.profit, 6310);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 2);
  assert.deepEqual(f.state.trade.player.goods.map(g => g.pid), [203]);
});
await test('清仓按批次亏损上限出售，不对亏损加成或扣累计利润', async () => {
  for (const maxLossPercent of [0, 10]) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 1800;
    f.settings.merchant.maxLossPercent = maxLossPercent;
    f.state.radar.radar = [];
    f.state.trade.player.goods = [
      { pid: 201, goodsId: 1001, cityId: 20, buyPrice: 44, num: 10 },
      { pid: 202, goodsId: 1001, cityId: 20, buyPrice: 60, num: 10 }
    ];
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeSellRequest').length, maxLossPercent ? 1 : 0);
    assert.equal(f.state.trade.player.profit, 6000);
    if (maxLossPercent) {
      assert.equal(f.sent('TradeSellRequest')[0].body.pid, 201);
      assert.equal(f.state.trade.player.coins, 10400);
      const records = Object.values(f.ledger.keyRecords()).filter(row => row.details?.expected?.request === 'TradeSellRequest');
      assert.equal(records.length, 1);
      assert.equal(records[0].confirmed, true, '亏损成交也须确认防重记录');
      await f.run(merchantActivity, 'merchantTrade');
      assert.equal(f.sent('TradeSellRequest').length, 1, '超过止损比例的批次仍持有');
    }
  }
});
await test('已售完、价格变化、非交易时段及临近结束不买入', async () => {
  for (const mutate of [
    (f) => (f.state.markets[10].goods[0].stock = 60000),
    (f) => (f.client.serverClockOffsetMs += 11 * 3600000),
    (f) => (f.client.tradeWindow.endTime = f.now + 400),
    (f) => {
      let n = 0;
      f.state.onRead = (name) => {
        if (name === 'TradeCity' && ++n === 2) f.state.markets[10].goods[0].price = 80;
      };
    }
  ]) {
    const f = setup();
    mutate(f);
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeBuyRequest').length, 0);
  }
});
await test('发送前库存变化、暂停和策略变化均撤销旧采购计划', async () => {
  for (const update of [
    f => { f.state.markets[10].goods[0].stock = 59999; },
    f => { f.state.markets[10].goods[0].price = 41; },
    f => f.pause(),
    f => { f.settings.merchant.minExpectedProfit = 100000; }
  ]) {
    const f = setup();
    let reads = 0;
    f.state.onRead = name => { if (name === 'TradeCity' && ++reads === 2) update(f); };
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.state.writes.length, 0);
    assert(!Object.values(f.ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  }
});
await test('同批货无利润寻价跨刷新与重载后不往返，换新货同周期可重访', async () => {
  const seed = () => {
    const f = setup();
    f.state.trade.player.coins = 0;
    f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 30, buyPrice: 100, num: 10 }];
    f.state.radar.radar[0].specGoodsId = 1003;
    f.state.radar.radar.forEach(port => { port.rareGoodsId = 0; });
    f.state.markets[20].goods[0].price = 40;
    return f;
  };
  const f = seed();
  f.state.trade.player.goods.push({ pid: 202, goodsId: 1002, cityId: 30, buyPrice: 100, num: 5 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  assert.match(f.reports.at(-1).label, /寻价/);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  f.state.trade.player.goods.reverse(); // 服务端只调整批次返回顺序，不应开启重复寻价。
  const restarted = createUsageLedger('fixture', { file: f.store });
  for (let i = 0; i < 2; i++) await merchantActivity(f.client, f.config, {
    player: f.player, key: 'merchantTrade', label: '海商王', ledger: restarted,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row)
  });
  assert.equal(f.sent('TradeMoveRequest').length, 1, '同货舱和资金不因两小时刷新或重启重走已离开的港');

  const g = seed();
  await g.run(merchantActivity, 'merchantTrade');
  const first = Object.values(g.ledger.keyRecords()).find(row => row.details?.expected?.request === 'TradeMoveRequest');
  assert(first.details.expected.cargoSignature);
  // 模拟游戏内手动加速到港，仍在同一次市场刷新周期；卖货后资金和持货均变化。
  g.client.serverClockOffsetMs += 60000;
  Object.assign(g.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  g.state.markets[20].goods[0].price = 120;
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeSellRequest').length, 1);
  g.state.markets[20].goods = [{ goodsId: 1002, price: 20, stock: 0 }];
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeBuyRequest')[0].body.goodsId, 1002);
  await g.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(g.sent('TradeMoveRequest').map(row => row.body.mvToCityId), [20, 10]);
  const legs = Object.values(g.ledger.keyRecords()).filter(row => row.details?.expected?.request === 'TradeMoveRequest');
  assert.equal(legs[0].details.expected.marketEpoch, legs[1].details.expected.marketEpoch);
  assert.notEqual(legs[0].details.expected.cargoSignature, legs[1].details.expected.cargoSignature);
});
await test('动作预留后跨过整船采购或多批出售截止，取消发送且不遗留待确认记录', async () => {
  for (const kind of ['buy', 'move']) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 7200 + (kind === 'buy' ? 190 : 130);
    if (kind === 'move') {
      f.state.trade.player.coins = 0;
      f.state.trade.player.goods = [
        { pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 },
        { pid: 202, goodsId: 1002, cityId: 10, buyPrice: 40, num: 10 }
      ];
      f.state.radar.radar[1].specGoodsId = 1003;
    }
    const reserve = f.ledger.reserve;
    let reservations = 0;
    f.ledger.reserve = (...args) => {
      const ticket = reserve(...args);
      if (args[3]?.uniqueKey?.startsWith('event-action:')) {
        assert.equal(args[3].details.expected.request, kind === 'buy' ? 'TradeBuyRequest' : 'TradeMoveRequest');
        reservations++;
        f.client.serverClockOffsetMs += 11000;
      }
      return ticket;
    };
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(reservations, 1, '必须已计划且预留动作，不能由提前等待掩盖门控');
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert(!Object.keys(f.ledger.keyRecords()).some(key => key.startsWith('event-action:')));
  }
});
await test('每轮间隔五分钟时停止来不及完成的采购，展示预览使用相同间隔', async () => {
  const f = setup();
  f.client.tradeWindow.endTime = f.now + 7200 + 190;
  const preview = () => merchantProgress(f.config, f.client.tradeWindow, f.state.trade, f.player, f.now,
    async name => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[f.state.trade.cargo.cityId], f.ledger, f.settings);
  assert.match(await preview(), /计划买入：/, '一分钟轮询下此窗口足够采购、航行和出售');
  f.settings.loop.everySeconds = 300;
  f.settings.merchant.monitorSeconds = 300;
  assert.doesNotMatch(await preview(), /计划买入：/, '五分钟轮询不能继续使用每步一分钟估计');
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 0);
  assert.equal(f.state.writes.length, 0);
});
await test('真实运行间隔优先于较短配置，直接服务和挂机入口均阻止超时采购', async () => {
  const direct = setup();
  direct.client.tradeWindow.endTime = direct.now + 7200 + 190;
  await merchantActivity(direct.client, direct.config, {
    player: direct.player, key: 'merchantTrade', label: '海商王', ledger: direct.ledger,
    everyMs: 300000, settings: () => direct.settings, enabled: () => true, report: row => direct.reports.push(row)
  });
  assert.equal(direct.settings.loop.everySeconds, 60);
  assert.equal(direct.sent('TradeBuyRequest').length, 0);
  for (const everyMs of [60000, 300000]) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 7200 + 190;
    Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
    f.settings.schedule.merchantTrade = true;
    f.settings.merchant.monitorSeconds = everyMs / 1000;
    await runLoop(f.client, f.protocol, {
      config: f.config, player: f.player, rounds: 1, allowMutate: true,
      isEnabled: key => key === 'merchantTrade', getSettings: () => f.settings,
      everyMs: 60000, getEveryMs: () => everyMs, usageLedger: f.ledger, sleep: async () => {}
    });
    assert(f.state.reads.includes('TradeInfoRequest'), '必须通过真实挂机入口执行海商王状态检查');
    assert.equal(f.sent('TradeBuyRequest').length, everyMs === 60000 ? 1 : 0);
  }
});
await test('复查或动作预留期间调大轮询间隔，配置与挂机动态间隔均取消旧动作', async () => {
  for (const stage of ['second-read', 'reservation', 'loop-reservation']) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 7200 + 190;
    let changed = false, actualEveryMs = 60000;
    const change = () => {
      changed = true;
      f.settings.merchant.monitorSeconds = 300;
      if (stage === 'loop-reservation') actualEveryMs = 300000;
      else f.settings.loop.everySeconds = 300;
    };
    if (stage === 'second-read') {
      let reads = 0;
      f.state.onRead = name => { if (name === 'TradeCity' && ++reads === 2) change(); };
    } else {
      const reserve = f.ledger.reserve;
      f.ledger.reserve = (...args) => {
        const ticket = reserve(...args);
        if (args[3]?.uniqueKey?.startsWith('event-action:')) change();
        return ticket;
      };
    }
    if (stage === 'loop-reservation') {
      Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
      f.settings.schedule.merchantTrade = true;
      await runLoop(f.client, f.protocol, {
        config: f.config, player: f.player, rounds: 1, allowMutate: true,
        isEnabled: key => key === 'merchantTrade', getSettings: () => f.settings,
        getEveryMs: () => actualEveryMs, usageLedger: f.ledger, sleep: async () => {}
      });
    } else await f.run(merchantActivity, 'merchantTrade');
    assert.equal(changed, true, '确保间隔在已产生采购计划后变化');
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert(!Object.keys(f.ledger.keyRecords()).some(key => key.startsWith('event-action:')));
  }
});
await test('海商王进度区分持仓、计划商品和城池；无共享仍显示并执行出售', async () => {
  const f = setup();
  const progress = () => merchantProgress(f.config, f.window, f.state.trade, f.player, f.now,
    async (name) => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[f.state.trade.cargo.cityId], f.ledger);
  const buy = await progress();
  assert.match(buy, /当前商品：空载/);
  assert.match(buy, /计划买入：.+目标城池：/);
  await f.run(merchantActivity, 'merchantTrade');
  await f.run(merchantActivity, 'merchantTrade');
  const sailing = await progress();
  assert.match(sailing, /当前商品：.+ ×250/);
  assert.match(sailing, /目标城池：.+航行中/);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  assert.match(await progress(), /计划卖出：.+目标城池：/);
  for (const port of f.state.radar.radar) port.rareGoodsId = 0;
  assert.match(await progress(), /计划卖出：.+目标城池：/);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.state.writes.length, 3);
});
await test('展示计划使用传入策略且不写账本或刷新本港历史时间戳', async () => {
  const f = setup();
  const preview = settings => merchantProgress(f.config, f.window, f.state.trade, f.player, f.now,
    async name => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[f.state.trade.cargo.cityId], f.ledger, settings);
  assert.equal(fs.existsSync(f.store), false);
  assert.match(await preview(f.settings), /计划买入：/);
  assert.equal(fs.existsSync(f.store), false);
  f.settings.merchant.minExpectedProfit = 1000000000;
  assert.doesNotMatch(await preview(f.settings), /计划买入：/);
  f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'preview-marker', details: { observedAt: f.now - 60 } }));
  const before = fs.readFileSync(f.store, 'utf8');
  await preview(f.settings);
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
  assert.equal(f.state.writes.length, 0);
});
await test('海商王买入回包丢失，回读核对持仓后才进入下一步', async () => {
  const f = setup();
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = '';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(f.sent('TradeMoveRequest').length, 0);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
});
await test('真实活动入口保留采购原before，未知重连后日志只补确认一次', async () => {
  const f = setup(), before = structuredClone(f.state.trade.player);
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  const [actionKey, record] = Object.entries(f.ledger.keyRecords()).find(([, row]) => row.details?.expected?.request === 'TradeBuyRequest');
  assert.equal(record.confirmed, false);
  assert.equal(record.details.before.coins, before.coins);
  assert.deepEqual(record.details.before.goods, before.goods);
  assert(Number.isSafeInteger(record.details.attemptedAt));
  let summary = merchantJournalSummary(f.ledger, f.client.tradeWindow, { time: f.now });
  assert.equal(summary.unknownActions, 1);
  assert.equal(summary.buyCost, 0);
  f.state.mode = '';
  f.client.serverClockOffsetMs += 60000;
  const reopened = createUsageLedger('fixture', { file: f.store });
  await merchantActivity(f.client, f.config, { player: f.player, key: 'merchantTrade', label: '海商王', ledger: reopened,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row) });
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(reopened.keyRecords()[actionKey].confirmed, true);
  assert.equal(reopened.keyRecords()[actionKey].details.before.coins, before.coins);
  summary = merchantJournalSummary(reopened, f.client.tradeWindow, { time: f.now + 60 });
  assert.equal(summary.unknownActions, 0);
  assert.equal(summary.buys, 1);
  assert.equal(summary.buyCost, 10000);
  assert.equal(summary.batches[0].purchasedAt, record.details.attemptedAt);
  assert.equal(readMerchantJournal(reopened).filter(row => row.type === 'trade' && row.expected.request === 'TradeBuyRequest').length, 1);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(merchantJournalSummary(reopened, f.client.tradeWindow).buyCost, 10000);
});
await test('售出未知恢复用原批次成本记录实际收益，不把期初累计利润当本轮收益', async () => {
  const f = setup();
  f.state.trade.cargo.cityId = 20;
  f.state.radar.radar = [];
  f.state.trade.player.goods = [{ pid: 501, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).realizedProfit, 0);
  f.state.mode = '';
  const reopened = createUsageLedger('fixture', { file: f.store });
  await merchantActivity(f.client, f.config, { player: f.player, key: 'merchantTrade', label: '海商王', ledger: reopened,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row) });
  const summary = merchantJournalSummary(reopened, f.client.tradeWindow);
  assert.equal(summary.sellProceeds, 658);
  assert.equal(summary.realizedProfit, 258);
  assert.equal(summary.sells, 1);
  assert.equal(summary.unknownActions, 0);
  assert.equal(f.sent('TradeSellRequest').length, 1);
});
await test('旧版未知执行记录缺before仍可恢复，成交统计不虚构历史成本', async () => {
  const f = setup();
  f.state.trade.player.coins = 0;
  f.state.trade.player.goods = [{ pid: 600, goodsId: 1001, cityId: 10, buyPrice: 40, num: 250 }];
  const scope = 'merchant:' + f.client.tradeWindow.startTime + ':' + f.client.tradeWindow.period;
  f.ledger.reserve({}, {}, {}, { uniqueKey: 'event-action:legacy-merchant-buy', details: { scope,
    expected: { request: 'TradeBuyRequest', city: 10, goodsId: 1001, price: 40, owned: 250, coins: 0 } } });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.keyRecords()['event-action:legacy-merchant-buy'].confirmed, true);
  assert.equal(f.state.writes.length, 0);
  const summary = merchantJournalSummary(f.ledger, f.client.tradeWindow);
  assert.equal(summary.buyCost, 0);
  assert.equal(summary.buys, 0);
  assert.equal(summary.unverifiedConfirmations, 1);
});
await test('只读实时诊断不交易、不补确认、不写日志且航行不读异地报价', async () => {
  const f = setup();
  assert.equal(fs.existsSync(f.store), false);
  const first = await readMerchantStatus(f.client, f.config, { player: f.player, ledger: f.ledger, settings: f.settings });
  assert.equal(first.available, true);
  assert.equal(first.plan.kind, 'buy');
  assert.equal(f.state.writes.length, 0);
  assert.equal(fs.existsSync(f.store), false, '查询不能创建行情或交易账本');
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = '';
  const before = fs.readFileSync(f.store, 'utf8'), writeCount = f.state.writes.length;
  await readMerchantStatus(f.client, f.config, { player: f.player, ledger: f.ledger, settings: f.settings });
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
  assert.equal(f.state.writes.length, writeCount);
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).unknownActions, 1);
  Object.assign(f.state.trade.cargo, { moveStartTime: f.now, moveEndTime: f.now + 7200, moveToCityId: 20 });
  const start = f.state.reads.length;
  const sailing = await readMerchantStatus(f.client, f.config, { player: f.player, ledger: f.ledger, settings: f.settings });
  assert.match(sailing.plan.reason, /航行中/);
  assert.deepEqual(f.state.reads.slice(start), ['TradeInfoRequest']);
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
});
await test('升级开启但预算或总钻石开关不满足时返回false并继续普通采购', async () => {
  for (const diamondsAllowed of [false, true]) {
    const f = setup();
    f.settings.merchant.autoUpgrade = true;
    f.settings.resources.allowDiamonds = diamondsAllowed;
    f.settings.resources.diamondDailyLimit = 0;
    f.settings.merchant.upgradeDailyDiamondLimit = 0;
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeCargoUpgradeRequest').length, 0);
    assert.equal(f.sent('TradeBuyRequest').length, 1);
    assert.equal(f.reports.at(-1).status, 'confirmed');
  }
});
await test('自然航程仅够处理一批时按可实现高收益子集选港并到港售出', async () => {
  const f = setup();
  f.settings.merchant.liquidationMinutes = 0;
  f.client.tradeWindow.endTime = f.now + 7200 + 90;
  f.state.trade.player.coins = 0;
  f.state.trade.player.goods = [
    { pid: 701, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 },
    { pid: 702, goodsId: 1002, cityId: 10, buyPrice: 20, num: 10 }
  ];
  f.state.radar.radar[1].specGoodsId = 1003;
  f.state.markets[20].goods.push({ goodsId: 1002, price: 65, stock: 0 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  assert.match(f.reports.at(-1).label, /预计释放舱位 10/);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveEndTime: 0, moveToCityId: 0 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest')[0].body.pid, 702);
  assert.deepEqual(f.state.trade.player.goods.map(g => g.pid), [701]);
  assert.equal(f.sent('TradeSpeedRequest').length, 0);
  f.client.serverClockOffsetMs += 91000;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1, '活动截止后不继续处置剩余批次');
});
await test('买入花完商会币且累计利润为零，协议默认零字段当轮正确确认', async () => {
  const f = setup();
  f.state.trade.player.profit = 0;
  const request = f.client.request;
  let omitted = false;
  f.client.request = async (name, body, response) => {
    const reply = await request(name, body, response);
    if (name !== 'TradeBuyRequest') return reply;
    const player = { ...reply.player };
    assert.equal(player.coins, 0);
    assert.equal(player.profit, 0);
    delete player.coins;
    delete player.profit;
    const decoded = f.protocol.TradeBuyResponse.decode(f.protocol.TradeBuyResponse.encode({ player }).finish());
    assert.equal(Object.hasOwn(decoded.player, 'coins'), false);
    assert.equal(Object.hasOwn(decoded.player, 'profit'), false);
    omitted = true;
    return decoded;
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(omitted, true);
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1, '不应多花一轮补确认零字段');
});
await test('期末保本清仓允许零收益成交，累计利润零字段可确认', async () => {
  const f = setup();
  f.client.tradeWindow.endTime = f.now + 1800;
  f.state.trade.player.profit = 0;
  f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 20, buyPrice: 40, num: 10 }];
  const request = f.client.request;
  f.client.request = async (name, body, response) => {
    const reply = await request(name, body, response);
    if (name !== 'TradeSellRequest') return reply;
    const player = { ...reply.player };
    delete player.profit;
    delete player.goods;
    return f.protocol.TradeSellResponse.decode(f.protocol.TradeSellResponse.encode({ player }).finish());
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.equal(f.state.trade.player.coins, 10400);
  assert.equal(f.state.trade.player.profit, 0);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
});
await test('原采购明确未发送释放记录，后续回读未发送错误不释放已写操作', async () => {
  const f = setup();
  const request = f.client.request;
  let blockWrite = true;
  f.client.request = async (name, body, response) => {
    if (name === 'TradeBuyRequest' && blockWrite) throw Object.assign(Error('排队期间连接关闭，未发送'), { notSent: true });
    return request(name, body, response);
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 0);
  assert(!Object.values(f.ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  blockWrite = false;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(f.reports.at(-1).status, 'confirmed');

  const g = setup();
  const gRequest = g.client.request;
  let blockRead = true;
  g.client.request = async (name, body, response) => {
    if (name === 'TradeInfoRequest' && g.sent('TradeBuyRequest').length && blockRead)
      throw Object.assign(Error('回读未发送'), { notSent: true });
    return gRequest(name, body, response);
  };
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeBuyRequest').length, 1);
  assert.equal(g.reports.at(-1).status, 'unknown');
  assert(Object.values(g.ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  blockRead = false;
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeBuyRequest').length, 1);
  assert.equal(g.reports.at(-1).status, 'confirmed');
});
await test('售出回包丢失后跨账本实例先确认消失批次，不重复售出', async () => {
  const f = setup();
  f.state.trade.cargo.cityId = 20;
  f.state.radar.radar = [];
  f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.state.trade.player.goods.length, 0);
  f.state.mode = '';
  const ledger = createUsageLedger('fixture', { file: f.store });
  await merchantActivity(f.client, f.config, {
    player: f.player, key: 'merchantTrade', label: '海商王', ledger,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row)
  });
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.match(f.reports.at(-1).reason, /前次操作/);
  assert(!Object.values(ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 1);
});
await test('航行回包丢失后在途中回读确认，不重发出航或被航行等待吞掉', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  f.state.mode = '';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.match(f.reports.at(-1).reason, /前次操作/);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 2);
  assert.equal(f.sent('TradeMoveRequest').length, 1);
});
await test('未执行的未知采购不会靠新目标或重载账本绕过，其他账号独立', async () => {
  const f = setup();
  f.state.mode = 'unknown';
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = '';
  f.state.markets[10].goods[0].price = 30;
  for (const account of ['fixture', 'other-fixture']) {
    const ledger = createUsageLedger(account, { file: f.store });
    await merchantActivity(f.client, f.config, {
      player: f.player, key: 'merchantTrade', label: '海商王', ledger,
      settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row)
    });
    assert.equal(f.sent('TradeBuyRequest').length, account === 'fixture' ? 1 : 2);
  }
});
await test('贸易战令、已达利润、联盟任务与商情礼包逐项核验', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantRewards');
  await f.run(merchantActivity, 'merchantRewards');
  assert.equal(f.sent('BattlePassGotRewardRequest')[0].body.type, 3);
  assert.equal(f.sent('GotTradeAchievementRequest').length, 1);
  assert(f.sent('TradeGotTaskRequest').length > 0);
  assert.equal(f.sent('GotTradeReportRequest').length, 1);
});
await test('旧导出保留显式关闭值，新默认与罗盘阈值入参校验', () => {
  const f = setup(),
    doc = exportAutomationSettings(f.settings);
  delete doc.settings.eventActions;
  for (const k of [
    'armsRaceRewards',
    'riverScore',
    'riverPass',
    'riverHelp',
    'compassDaily',
    'compassSpin',
    'merchantTrade',
    'merchantRewards',
    'beautyVotes',
    'beautyGift'
  ])
    delete doc.settings.schedule[k];
  doc.settings.schedule.compassReward = false;
  const restored = importAutomationSettings(doc);
  assert.equal(restored.schedule.compassReward, false);
  assert.equal(restored.schedule.armsRaceRewards, true);
  for (const key of ['compassSpin', 'merchantTrade', 'beautyVotes']) assert.equal(restored.schedule[key], false, key + ' 消耗型任务需主动开启');
  assert.deepEqual(restored.eventActions, { compassThreshold: 10, compassDrawCount: 10 });
  restored.eventActions.compassDrawCount = 3;
  assert.throws(() => validateSettings(restored));
});
await test('跨日礼包核对、活动中途关闭和候选人名单按游戏客户端筛选', async () => {
  const f = setup();
  f.client.seriesSnapshotDay = Math.floor((f.now + 28800) / 86400) - 1;
  f.client.festivals[0].subActivity[2].dailySelectGift.boughtTimes[1000] = 1;
  await f.run(compassActivity, 'compassDaily');
  assert.equal(f.sent('ClaimFreeSelectGiftRequest').length, 1);
  const g = setup();
  g.state.beauty.player.push({ no: 999999, rank: 1, playerId: 1000, vote: 99999 });
  await g.run(beautyActivity, 'beautyVotes');
  assert.equal(g.sent('BeautyVoteRequest')[0].body.no, 620);
  const h = setup();
  let reads = 0;
  h.state.onRead = (name) => {
    if (name === 'BeautyInfo' && ++reads === 2) h.client.beautyWindow = { ...h.window, endTime: h.now };
  };
  await h.run(beautyActivity, 'beautyVotes');
  assert.equal(h.state.writes.length, 0);
});
await test('正常挂机循环从保存的开关执行投票与奖励，未启用的走商不会发送', async () => {
  const f = setup();
  Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
  const enabled = new Set(['beautyVotes', 'beautyGift']);
  await runLoop(f.client, f.protocol, {
    config: f.config,
    player: f.player,
    rounds: 1,
    allowMutate: true,
    isEnabled: (k) => enabled.has(k),
    getSettings: () => f.settings,
    usageLedger: f.ledger,
    sleep: async () => {}
  });
  assert.deepEqual(
    f.state.writes.map((w) => w.name),
    ['BeautyVoteRequest', 'GotBeautyVoteRequest']
  );
});
console.log('活动专项 ' + passed + '/' + passed + ' 通过');
