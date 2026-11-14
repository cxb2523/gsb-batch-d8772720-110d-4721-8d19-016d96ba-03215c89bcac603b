import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { recordMerchantSnapshot, recordMerchantTrade, readMerchantJournal, merchantJournalSummary, replayMerchantJournal } from '../src/merchant-journal.mjs';
import { readMerchantReplayFile, runMerchantBacktest } from './merchant-backtest.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-journal-'));
const file = path.join(folder, 'usage.json'), now = Date.UTC(2026, 10, 12, 4, 10) / 1000;
const event = { period: 1001, startTime: now - 86400, endTime: now + 86400 };
const config = { tables: {
  ActivityTradeCfg: { data: [{ key: '海商王贸易时间', value: '10-22' }, { key: '海商王行驶时间', value: '120' }, { key: '海商王刷新时间', value: '10,12,14,16,18,20' }] },
  TradeShipCfg: { data: [{ lv: 1, capacity: 10, profitMargin: 300 }] },
  TradeGoodsCfg: { data: [{ goodsId: 1, capacity: 1, unitPrice: 100, maxCount: 20, itemName: '鱼' }, { goodsId: 2, capacity: 1, unitPrice: 200, maxCount: 20, itemName: '水' }] }
} };
const state = (goods = [], coins = 1000, profit = 0, cityId = 10) => ({ period: event.period,
  player: { coins, profit, goods }, cargo: { cityId, cargoLv: 1, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 } });
const batch = (extra = {}) => ({ pid: 1, goodsId: 1, cityId: 10, buyPrice: 50, num: 10, ...extra });
const radar = { radar: [{ cityId: 10, specGoodsId: 1, rareGoodsId: 0 }, { cityId: 20, specGoodsId: 2, rareGoodsId: 0 }] };
const market = (price = 50) => ({ goods: [{ goodsId: 1, price, stock: 0 }], specGoodsId: 1 });
const ledger = name => createUsageLedger(name, { file, now: () => now * 1000 });
const snapshot = (book, extra = {}) => recordMerchantSnapshot(book, { event, state: state(), market: market(), radar, time: now, config, ...extra });
const buyExpected = { request: 'TradeBuyRequest', city: 10, goodsId: 1, price: 50, owned: 10, coins: 500 };
const trade = (book, extra = {}) => recordMerchantTrade(book, { event, expected: buyExpected, before: state(), after: state([batch()], 500),
  time: now + 1, attemptedAt: now, status: 'confirmed', actionKey: 'buy-1', ...extra });
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('通过：' + name); };

try {
  test('快照按真实刷新周期和状态去重，不把商情采集时刻当发布时间', () => {
    const book = ledger('snapshot');
    assert(snapshot(book).recorded);
    assert.equal(snapshot(book, { time: now + 30 }).recorded, false);
    assert(snapshot(book, { time: now + 7200 }).recorded);
    const entries = readMerchantJournal(book, event);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].market.observedAt, now);
    assert.equal(entries[0].market.confidence, 'observed');
    assert.equal(entries[0].radar.observedAt, now);
    assert.equal(entries[0].radar.reportedAt, null);
    assert.equal(entries[0].radar.confidence, 'signal-only');
  });

  test('未知动作不计成功，重启恢复后只计一次并保留原采购时间', () => {
    const book = ledger('recovery');
    trade(book, { status: 'unknown', after: null });
    assert.equal(merchantJournalSummary(book, event).confirmedTrades, 0);
    assert.equal(merchantJournalSummary(book, event).unknownActions, 1);
    const reopened = ledger('recovery');
    trade(reopened, { time: now + 300 });
    const result = merchantJournalSummary(reopened, event);
    assert.equal(result.confirmedTrades, 1);
    assert.equal(result.buyCost, 500);
    assert.equal(result.unknownActions, 0);
    assert.equal(result.batches[0].purchasedAt, now);
    assert.equal(result.batches[0].purchaseTimeSource, 'request-observed');
    assert.equal(trade(reopened, { time: now + 301 }).recorded, false);
    assert.equal(trade(reopened, { time: now + 302, status: 'unknown', after: null }).recorded, false);
    assert.equal(merchantJournalSummary(reopened, event).buyCost, 500);
  });

  test('实际已确认出售回款减批次成本，包含亏损且不拿服务端累计利润代替', () => {
    const book = ledger('profit');
    trade(book);
    trade(book, { expected: { request: 'TradeSellRequest', pid: 1, gain: 999999 }, before: state([batch()], 500, 6000, 20),
      after: state([], 950, 6000, 20), time: now + 7200, actionKey: 'sell-loss' });
    const result = merchantJournalSummary(book, event, { time: event.endTime + 1 });
    assert.equal(result.status, 'ended');
    assert.equal(result.confirmedTrades, 2);
    assert.equal(result.sellProceeds, 450);
    assert.equal(result.realizedProfit, -50);
    assert.equal(result.batches[0].num, 0);
    assert.equal(result.turnoverProfitPerSecond, null);
  });

  test('外部已有批次采购时间未知，同商品不同批次独立保留', () => {
    const book = ledger('lots');
    snapshot(book, { state: state([batch({ num: 3 }), batch({ pid: 2, cityId: 30, buyPrice: 60, num: 4 })]) });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.batches.length, 2);
    assert(result.batches.every(row => row.purchasedAt === null));
    assert.deepEqual(result.batches.map(row => [row.cityId, row.buyPrice]), [[10, 50], [30, 60]]);
  });

  test('账号和活动期次隔离，不删除或确认游戏执行pending账本', () => {
    const first = ledger('isolation-a'), second = ledger('isolation-b');
    first.reserve({}, {}, {}, { uniqueKey: 'event-action:unresolved', details: { scope: 'merchant:' + event.startTime + ':' + event.period } });
    trade(first);
    assert.equal(merchantJournalSummary(second, event).confirmedTrades, 0);
    const next = { ...event, startTime: event.startTime + 86400 * 7, endTime: event.endTime + 86400 * 7 };
    assert.equal(merchantJournalSummary(first, next).confirmedTrades, 0);
    assert.equal(first.keyRecords()['event-action:unresolved'].confirmed, false);
    assert.equal(first.snapshot().uncertain, 1);
  });

  test('缺少前后回执的确认不虚构金额，拒绝动作不计消费', () => {
    const book = ledger('incomplete');
    trade(book, { before: null, actionKey: 'missing-before' });
    trade(book, { status: 'rejected', after: null, actionKey: 'rejected' });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.confirmedTrades, 0);
    assert.equal(result.buyCost, 0);
    assert.equal(result.unverifiedConfirmations, 1);
    assert.equal(result.rejectedActions, 1);
  });

  test('加速记录确认用量，升级只接收实际钻石证据', () => {
    const book = ledger('consumption'), after = state(); after.cargo.cargoLv = 2;
    const upgrade = { request: 'TradeCargoUpgradeRequest', period: event.period, startTime: event.startTime,
      fromLevel: 1, toLevel: 2, diamonds: 300 };
    const speed = { request: 'TradeSpeedRequest', useNum: 2, accelerationReason: 'turnover',
      estimatedIncrementalProfit: 3600, incrementalProfit: 3600, savedSeconds: 3600 };
    trade(book, { actionKey: 'speed', expected: speed, after: state() });
    trade(book, { actionKey: 'upgrade-estimate', expected: upgrade, after });
    trade(book, { actionKey: 'upgrade-real', expected: upgrade, after, actualDiamondSpent: 300,
      beforeDiamonds: 1000, afterDiamonds: 700 });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.pointerUsed, 2);
    assert.equal(result.diamondSpent, 300);
    assert.equal(result.upgrades, 1);
    assert.equal(result.unverifiedConfirmations, 1);
    const entries = readMerchantJournal(book, event);
    assert.deepEqual(entries.find(entry => entry.expected.request === 'TradeSpeedRequest').expected, speed);
    const confirmed = entries.find(entry => entry.metrics.upgrades);
    assert.deepEqual(confirmed.expected, upgrade);
    assert.equal(confirmed.beforeDiamonds, 1000);
    assert.equal(confirmed.afterDiamonds, 700);
  });

  test('升级仅核验实际接口、同一期次、相邻船级及明确费用，未发送不计消费', () => {
    const book = ledger('upgrade-contract'), after = state(); after.cargo.cargoLv = 2;
    const expected = { request: 'TradeCargoUpgradeRequest', period: event.period, startTime: event.startTime,
      fromLevel: 1, toLevel: 2, diamonds: 300 };
    const invalid = [
      { expected: { ...expected, request: 'TradeUpRequest' } },
      { expected: { ...expected, period: event.period + 1 } },
      { expected: { ...expected, startTime: event.startTime - 1 } },
      { expected: { ...expected, fromLevel: 2 } },
      { expected: { ...expected, toLevel: 3 } },
      { expected: { ...expected, diamonds: 301 } },
      { actualDiamondSpent: 301 },
      { before: after },
      { after: state() },
      { actualDiamondSpent: undefined, beforeDiamonds: 1000, afterDiamonds: 700 }
    ];
    invalid.forEach((extra, i) => trade(book, { actionKey: 'invalid-' + i, expected, after,
      actualDiamondSpent: 300, ...extra }));
    trade(book, { actionKey: 'cancelled', expected, status: 'cancelled', after: null });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.upgrades, 0);
    assert.equal(result.diamondSpent, 0);
    assert.equal(result.unverifiedConfirmations, invalid.length);
    assert.equal(result.rejectedActions, 1);
  });

  test('周转历史只用至少两笔实际出售及观察耗时，样本不足返回null', () => {
    const book = ledger('turnover');
    snapshot(book);
    for (let i = 1; i <= 2; i++) trade(book, { actionKey: 'sell-' + i, expected: { request: 'TradeSellRequest', pid: i },
      before: state([batch({ pid: i })], 500, 0, 20), after: state([], 1100, 100, 20), time: now + i * 100 });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.turnoverProfitPerSecond, 1);
    assert.equal(result.sampleSeconds, 200);
    assert.equal(result.observedAt, now + 200);
    assert.equal(result.turnoverObservedAt, now + 200);
    assert.equal(result.turnoverSampleCount, 2);
    assert.equal(result.turnoverSampleSeconds, 200);
    assert.equal(result.period, event.period);
    assert.equal(result.startTime, event.startTime);
    snapshot(book, { time: now + 7200 });
    const newer = merchantJournalSummary(book, event);
    assert.equal(newer.observedAt, now + 7200);
    assert.equal(newer.sampleSeconds, 7200);
    assert.equal(newer.turnoverObservedAt, result.turnoverObservedAt, '新行情不能给旧成交样本续期');
    assert.equal(newer.turnoverSampleSeconds, result.turnoverSampleSeconds);
    assert.equal(newer.turnoverProfitPerSecond, result.turnoverProfitPerSecond, '无新出售不重算历史成交速率');
  });

  test('只有新快照或未核验出售时没有有效周转样本时间', () => {
    const book = ledger('no-sale');
    snapshot(book);
    trade(book, { actionKey: 'unverified-sale', expected: { request: 'TradeSellRequest', pid: 1 },
      before: null, after: state(), time: now + 200 });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.observedAt, now + 200);
    assert.equal(result.turnoverObservedAt, null);
    assert.equal(result.turnoverSampleCount, 0);
    assert.equal(result.turnoverSampleSeconds, 0);
    assert.equal(result.turnoverProfitPerSecond, null);
  });

  test('回放匹配真实成交利润，未走过的反事实选择不给虚构实际收益', () => {
    const book = ledger('replay');
    snapshot(book);
    trade(book);
    const held = state([batch()], 500, 0, 20);
    snapshot(book, { state: held, market: market(120), time: now + 7200 });
    trade(book, { actionKey: 'sale', expected: { request: 'TradeSellRequest', pid: 1 }, before: held,
      after: state([], 1721, 721, 20), time: now + 7201 });
    const replay = replayMerchantJournal(config, readMerchantJournal(book), { variants: [
      { name: '记录', settings: null }, { name: '禁止估价采购', settings: { estimateDiscountPercent: 100 } }
    ] });
    assert.equal(replay.variants[0].verifiedDecisions, 2);
    assert.equal(replay.variants[0].verifiedRealizedProfit, 721);
    assert.equal(replay.variants[0].fullStrategyRealizedProfit, null);
    assert.equal(replay.variants[1].decisions[0].verifiedRealizedProfit, null);
    assert.equal(replay.variants[1].fullStrategyRealizedProfit, null);
  });

  test('未来到港价格不会前视污染更早时点的采购选择', () => {
    const book = ledger('no-lookahead');
    snapshot(book);
    const original = readMerchantJournal(book), first = replayMerchantJournal(config, original).variants[0].decisions[0];
    snapshot(book, { state: state([], 1000, 0, 20), market: market(1), time: now + 7200 });
    const appended = replayMerchantJournal(config, readMerchantJournal(book)).variants[0].decisions[0];
    assert.deepEqual(appended, first);
  });

  test('快照有界保留且无关执行记录不变，丢弃数量明确可见', () => {
    const records = {}, book = { keyRecords: () => structuredClone(records), hasKey: key => !!records[key],
      reserve: (_a, _b, _c, { uniqueKey, details }) => { records[uniqueKey] = { confirmed: false, details: structuredClone(details) }; return uniqueKey; },
      confirm: key => { records[key].confirmed = true; }, resolveKey: (key, confirmed, details) => { records[key] = { confirmed, details: structuredClone(details) }; } };
    records['unrelated-pending'] = { confirmed: false, details: { scope: 'other' } };
    for (let i = 0; i < 515; i++) snapshot(book, { time: now + i, market: market(50 + i) });
    const result = merchantJournalSummary(book, event);
    assert.equal(result.snapshots, 512);
    assert.equal(result.droppedSnapshots, 3);
    assert.equal(book.keyRecords()['unrelated-pending'].confirmed, false);
  });

  test('坏JSON、坏日志都报错且不覆盖原文件，CLI不自动读取账号', () => {
    const bad = path.join(folder, 'bad.json');
    fs.writeFileSync(bad, '{broken');
    assert.throws(() => readMerchantReplayFile(bad), /有效 JSON/);
    assert.equal(fs.readFileSync(bad, 'utf8'), '{broken');
    assert.throws(() => runMerchantBacktest([]), /显式指定/);
    assert.throws(() => readMerchantReplayFile(file), /显式指定/);
    const book = ledger('broken-journal');
    book.confirm(book.reserve({}, {}, {}, { uniqueKey: 'merchant-journal:' + event.startTime + ':' + event.period,
      details: { merchantJournal: { version: 99, event } } }));
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => snapshot(book), /损坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  test('CLI只读所选账号并输出中文或JSON，观察文件可自带配置回放', () => {
    const json = JSON.parse(runMerchantBacktest(['--file', file, '--account', 'profit', '--summary', '--json']));
    assert.equal(json.connectedToGame, false);
    assert.equal(json.summaries.length, 1);
    assert.equal(json.summaries[0].realizedProfit, -50);
    const replayFile = path.join(folder, 'observations.json');
    fs.writeFileSync(replayFile, JSON.stringify({ entries: readMerchantJournal(ledger('replay')), config }));
    const before = fs.readFileSync(replayFile, 'utf8');
    const result = runMerchantBacktest(['--file', replayFile]);
    assert.match(result, /未连接游戏/);
    assert.match(result, /全程策略收益未知/);
    assert.equal(fs.readFileSync(replayFile, 'utf8'), before);
  });
  console.log('海商王日志与回放验证完成：' + passed + ' 项');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
