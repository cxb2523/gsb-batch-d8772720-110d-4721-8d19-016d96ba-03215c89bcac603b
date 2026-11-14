import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { evaluateMerchantUpgrade, runMerchantUpgrade } from '../src/merchant-upgrade.mjs';

const protocol = loadProtocol(), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-upgrade-'));
const now = Date.UTC(2026, 10, 12, 2, 1) / 1000;
let sequence = 0, passed = 0;
function fixture() {
  const id = ++sequence, file = path.join(folder, id + '.json');
  let usageTime = now * 1000, enabled = true, mode = '', hook = () => {};
  const settings = defaultSettings();
  settings.merchant = { ...settings.merchant, autoUpgrade: true, upgradeCoinValuePerDiamond: 100,
    upgradeMinReturnPercent: 150, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300 };
  settings.resources.allowDiamonds = true;
  settings.resources.diamondDailyLimit = 2000;
  const config = { tables: {
    ActivityTradeCfg: { data: [{ key: '海商王贸易时间', value: '10-22' }, { key: '海商王行驶时间', value: '120' },
      { key: '海商王刷新时间', value: '10,12,14,16,18,20' }] },
    TradeShipCfg: { data: [{ lv: 1, capacity: 1000, profitMargin: 300, upMoney: 0, upCost: [] },
      { lv: 2, capacity: 3000, profitMargin: 600, upMoney: 10000, upCost: ['RUBY', 300] }] },
    TradeGoodsCfg: { data: [{ goodsId: 1001, capacity: 1, maxCount: 60000, unitPrice: 50, itemName: '生鱼片' }] }
  } };
  const event = { period: 1001, startTime: now - 86400, endTime: now + 3 * 86400 };
  const state = { period: 1001, cargo: { cargoLv: 1, cityId: 10, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 },
    player: { coins: 100000, profit: 10000, goods: [] } };
  const market = { cityId: 10, observedAt: now, goods: [{ goodsId: 1001, price: 10, stock: 0 }], specGoodsId: 1001, rareGoodsId: 0 };
  const radar = { radar: [{ cityId: 10, specGoodsId: 1001 }, { cityId: 20, specGoodsId: 1002 }] };
  const resources = { list: [{ res: 1, amount: 0 }, { res: 3, amount: 1000 }, { res: 4, amount: 1000 }] };
  const player = { playerId: String(980000 + id), worldId: '2002001001', guildId: '1001', level: 37 };
  const calls = [], reports = [], outcomes = [];
  let ledger = createUsageLedger('upgrade-' + id, { file, now: () => usageTime });
  let client = { connected: true, tradeWindow: event, serverClockOffsetMs: now * 1000 - Date.now(),
    async request(name, body = {}, response) {
      assert.ok(protocol[name], '真实协议缺少 ' + name); assert.ok(protocol[response], '真实协议缺少 ' + response);
      const decodedBody = protocol[name].decode(protocol[name].encode(body).finish());
      calls.push({ name, body }); await hook(name, body);
      let reply;
      if (name === 'TradeInfoRequest') reply = state;
      else if (name === 'TradeCityRequest') { assert.equal(decodedBody.cityId, 10); reply = market; }
      else if (name === 'TradeGuildRadarRequest') reply = radar;
      else if (name === 'AllResourceRequest') {
        if (mode === 'settlement-fails' && calls.some(row => row.name === 'TradeCargoUpgradeRequest')) throw Error('完整资源库存超时');
        reply = resources;
      } else {
        assert.equal(name, 'TradeCargoUpgradeRequest'); assert.deepEqual(Object.keys(decodedBody), [], '升级协议没有任何请求字段');
        if (mode === 'not-sent') throw Object.assign(Error('未发送'), { notSent: true });
        if (mode === 'reject') throw Object.assign(Error('拒绝'), { request: name, prompt: { prompt: 1 } });
        if (mode === 'unknown') throw Error('升级结果未知');
        state.cargo.cargoLv++;
        resources.list.find(row => row.res === 4).amount -= 300;
        if (mode === 'lost') throw Error('回包丢失');
        reply = { cargo: state.cargo };
      }
      return protocol[response].decode(protocol[response].encode(reply).finish());
    }
  };
  const ctx = { player, ledger, settings: () => settings, enabled: () => enabled, report: report => reports.push(report),
    onMerchantOutcome: outcome => outcomes.push(outcome) };
  return { settings, config, event, state, market, radar, resources, player, calls, reports, outcomes, ctx, file,
    get ledger() { return ledger; }, get client() { return client; },
    mode: value => { mode = value; }, hook: value => { hook = value; }, pause: () => { enabled = false; },
    evaluate: (extra = {}) => evaluateMerchantUpgrade(config, event, state, market, radar, now,
      { settings: settings.merchant, actionSeconds: 60, ...extra }),
    run: () => runMerchantUpgrade(client, config, ctx, event, structuredClone(state), { market, radar, actionSeconds: 60 }),
    sent: () => calls.filter(row => row.name === 'TradeCargoUpgradeRequest'),
    reload: (nextDay = false) => {
      if (nextDay) usageTime += 86400000;
      ledger = createUsageLedger('upgrade-' + id, { file, now: () => usageTime }); ctx.ledger = ledger;
      client = { ...client };
    }
  };
}
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }
try {
  await test('利润达限不升级，读取期间降低上限取消钻石消费', async () => {
    const f = fixture(); f.settings.merchant.profitLimit = 10000;
    assert.equal(f.evaluate().kind, 'skip'); await f.run(); assert.equal(f.sent().length, 0);
    const g = fixture(); g.hook(name => { if (name === 'AllResourceRequest') g.settings.merchant.profitLimit = 10000; });
    await g.run(); assert.equal(g.sent().length, 0); assert.equal(g.ledger.pendingCounters().diamonds ?? 0, 0);
  });
  await test('真实空请求升级、利润门槛不扣商会币，船级与完整资源回读确认', async () => {
    const f = fixture(), plan = f.evaluate();
    assert.equal(plan.kind, 'upgrade'); assert.equal(plan.diamonds, 300); assert.equal(plan.remainingRounds, 2);
    assert.equal(plan.opportunityCost, 30000); assert.equal(plan.requiredReturn, 45000);
    assert.ok(plan.projectedIncrement >= plan.requiredReturn); assert.match(plan.label, /估算假设，非兑换汇率/);
    assert.equal(await f.run(), true); assert.equal(f.sent().length, 1);
    assert.equal(f.state.cargo.cargoLv, 2); assert.equal(f.state.player.coins, 100000);
    assert.equal(f.state.player.profit, 10000); assert.equal(f.resources.list.find(row => row.res === 4).amount, 700);
    assert.equal(f.reports.at(-1).status, 'confirmed');
    assert.equal(f.ledger.snapshot().counters.diamonds, 300);
    assert.equal(f.ledger.snapshot().counters.merchantUpgradeDiamonds, 300);
    const sent = f.calls.findIndex(row => row.name === 'TradeCargoUpgradeRequest');
    assert.deepEqual(f.calls.slice(sent + 1).map(row => row.name), ['TradeInfoRequest', 'AllResourceRequest']);
    assert.equal(await f.run(), false); assert.equal(f.sent().length, 1);
  });
  await test('默认关闭、钻石总开关和全部预算不足均不阻塞后续普通交易', async () => {
    for (const edit of [f => { delete f.settings.merchant.autoUpgrade; },
      f => { f.settings.resources.allowDiamonds = false; },
      f => { f.settings.resources.diamondDailyLimit = 299; },
      f => { f.settings.merchant.upgradeDailyDiamondLimit = 299; },
      f => { f.settings.resources.diamondThreshold = 701; }]) {
      const f = fixture(); edit(f); assert.equal(await f.run(), false); assert.equal(f.sent().length, 0);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('其他玩法已用全局额度与升级独立日额度同时生效', async () => {
    const f = fixture();
    f.ledger.confirm(f.ledger.reserve({ diamonds: 1800 }, { diamonds: 2000 }));
    assert.equal(await f.run(), false); assert.equal(f.sent().length, 0);
    const g = fixture();
    g.ledger.confirm(g.ledger.reserve({ merchantUpgradeDiamonds: 1 }, { merchantUpgradeDiamonds: 300 }));
    assert.equal(await g.run(), false); assert.equal(g.sent().length, 0);
  });
  await test('解锁使用累计利润、资金不足或没有额外收益均拒绝升级', async () => {
    const f = fixture(); f.state.player.profit = 9999;
    assert.match(f.evaluate().reason, /累计利润/);
    f.state.player.profit = 10000; f.state.player.coins = 100;
    assert.equal(f.evaluate().kind, 'skip'); assert.doesNotMatch(f.evaluate().reason, /累计利润/);
    const g = fixture(); g.config.tables.TradeShipCfg.data[1].capacity = 1000;
    g.config.tables.TradeShipCfg.data[1].profitMargin = 300;
    assert.equal(g.evaluate().kind, 'skip');
  });
  await test('没有可靠新报价、来源变化和已有货舱都先继续普通跑商', async () => {
    for (const edit of [f => { f.market.observedAt = now - 301; },
      f => { f.market.goods[0].price = 0; },
      f => { f.market.goods.push({ ...f.market.goods[0] }); },
      f => { f.market.cityId = 20; },
      f => { f.radar.radar = []; },
      f => { f.state.player.goods = [{ pid: 1, goodsId: 1001, num: 1, cityId: 20, buyPrice: 10 }]; }]) {
      const f = fixture(); edit(f); assert.equal(await f.run(), false); assert.equal(f.sent().length, 0);
    }
  });
  await test('剩余时间与现有库存限制轮数，不假设明日或刷新补货', async () => {
    const f = fixture(); f.market.goods[0].stock = 57000;
    assert.equal(f.evaluate().remainingRounds, 1);
    const g = fixture(); g.event.endTime = now + 3 * 3600;
    assert.equal(g.evaluate().kind, 'skip');
    const h = fixture(); h.event.endTime = now + 1000;
    assert.equal(h.evaluate().kind, 'skip');
    const i = fixture();
    assert.equal(i.evaluate({ actionSeconds: 7200 }).kind, 'skip');
  });
  await test('钻石折算假设与回报率门槛实质约束升级', async () => {
    const f = fixture(); f.settings.merchant.upgradeCoinValuePerDiamond = 10000;
    assert.equal(f.evaluate().kind, 'skip'); assert.equal(await f.run(), false);
    const g = fixture(); g.settings.merchant.upgradeMinReturnPercent = 100000;
    assert.equal(g.evaluate().kind, 'skip'); assert.equal(await g.run(), false);
  });
  await test('发送前再次读取状态、行情、钻石并阻止设置或计划变化', async () => {
    for (const edit of [f => { f.market.goods[0].price = 11; },
      f => { f.state.player.coins = 50000; },
      f => { f.settings.resources.allowDiamonds = false; },
      f => { f.settings.merchant.upgradeDailyDiamondLimit = 1; },
      f => { f.settings.loop.everySeconds = 7200; }]) {
      const f = fixture(); let changed = false;
      f.hook(name => { if (name === 'TradeInfoRequest' && !changed) { changed = true; edit(f); } });
      assert.equal(await f.run(), false); assert.equal(f.sent().length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('预算预留后关闭升级释放两个计数，不发送请求', async () => {
    const f = fixture(), reserve = f.ledger.reserve.bind(f.ledger);
    f.ledger.reserve = (...args) => { const ticket = reserve(...args); f.settings.merchant.autoUpgrade = false; return ticket; };
    assert.equal(await f.run(), false); assert.equal(f.sent().length, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds, 0);
    assert.equal(f.ledger.snapshot().counters.merchantUpgradeDiamonds, 0);
  });
  await test('升级结果未知跨重连跨日持久防重，余额下降不证明升级成功', async () => {
    const f = fixture(); f.mode('unknown'); await f.run();
    assert.equal(f.reports.at(-1).status, 'unknown'); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.resources.list.find(row => row.res === 4).amount = 700;
    f.reload(true); assert.equal(await f.run(), true); assert.equal(f.sent().length, 1);
    assert.equal(f.ledger.snapshot().uncertain, 1);
  });
  await test('回包丢失通过本期船级加完整资源回读恢复，关闭开关也可恢复', async () => {
    const f = fixture(); f.mode('lost'); await f.run(); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.reload(); f.settings.merchant.autoUpgrade = false;
    assert.equal(await f.run(), true); assert.equal(f.sent().length, 1);
    assert.equal(f.reports.at(-1).status, 'confirmed'); assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds, 300);
  });
  await test('已升级但完整资源库存未读到仍保留预算，下一次可结算', async () => {
    const f = fixture(); f.mode('settlement-fails'); await f.run();
    assert.equal(f.state.cargo.cargoLv, 2); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.reload(); await f.run(); assert.equal(f.ledger.snapshot().uncertain, 1); assert.equal(f.sent().length, 1);
    f.mode(''); await f.run(); assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.sent().length, 1);
  });
  await test('原写明确未发送与服务端拒绝退回全局和升级预算', async () => {
    for (const mode of ['not-sent', 'reject']) {
      const f = fixture(); f.mode(mode); await f.run();
      assert.equal(f.ledger.snapshot().uncertain, 0);
      assert.equal(f.ledger.snapshot().counters.diamonds, 0);
      assert.equal(f.ledger.snapshot().counters.merchantUpgradeDiamonds, 0);
    }
  });
  await test('写入后的资源读取异常不能借notSent取消已经消费的预算', async () => {
    const f = fixture();
    f.hook(name => { if (name === 'AllResourceRequest' && f.sent().length) throw Object.assign(Error('回读未发送'), { notSent: true }); });
    await f.run(); assert.equal(f.state.cargo.cargoLv, 2); assert.equal(f.ledger.snapshot().uncertain, 1);
    assert.equal(f.ledger.snapshot().counters.diamonds, 300);
  });
  await test('升级日志保留发送前船级与钻石，恢复后复用同一个动作标识', async () => {
    const f = fixture(); f.mode('lost'); await f.run();
    assert.equal(f.outcomes[0].status, 'unknown'); assert.equal(f.outcomes[0].before.cargo.cargoLv, 1);
    assert.equal(f.outcomes[0].beforeDiamonds, 1000);
    f.reload(); f.mode(''); await f.run();
    assert.equal(f.outcomes[1].status, 'confirmed');
    assert.equal(f.outcomes[1].actionKey, f.outcomes[0].actionKey);
    assert.equal(f.outcomes[1].attemptedAt, f.outcomes[0].attemptedAt);
    assert.equal(f.outcomes[1].before.cargo.cargoLv, 1); assert.equal(f.outcomes[1].after.cargo.cargoLv, 2);
    assert.equal(f.outcomes[1].actualDiamondSpent, 300); assert.equal(f.outcomes[1].afterDiamonds, 700);
    const g = fixture(); g.mode('reject'); await g.run(); assert.equal(g.outcomes[0].status, 'rejected');
  });
  await test('日志回调失败不把确认升级改为未知或丢失预算确认', async () => {
    const f = fixture(); f.ctx.onMerchantOutcome = () => { throw Error('日志失败'); };
    await f.run(); assert.equal(f.reports.at(-1).status, 'confirmed'); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  console.log('海商王升级测试通过：' + passed + ' 项');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
