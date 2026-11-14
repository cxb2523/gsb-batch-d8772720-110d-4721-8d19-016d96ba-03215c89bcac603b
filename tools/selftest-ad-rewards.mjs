// 广告奖励专项：假服务器按真实协议编解码，并模拟“申请后等待不足会拒绝”的规则。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ad-rewards-'));
process.env.CW_DATA_DIR = dir;
const { loadProtocol } = await import('../src/proto.mjs');
const { claimAfkAd, claimAdSpeedUps } = await import('../src/ad-rewards.mjs');
const { claimAdShop, beginAdRound, takeAdSlot, AD_PACED_REASON, AD_NOT_FINISHED_REASON, AD_PAUSED_REASON } = await import('../src/ad-shop.mjs');
const { recruitWithSkipAds } = await import('../src/extra-free-rewards.mjs');
const { executeTrialSweep } = await import('../src/trial-sweeps.mjs');
const { compassActivity, riverActivity } = await import('../src/seasonal-activities.mjs');
const { createUsageLedger, defaultSettings, validateSettings, importAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { automationControlView } = await import('../src/automation-controls.mjs');
const { nativePreferenceEnabled } = await import('../src/automation-policy.mjs');
const { describeLogError } = await import('../src/log-errors.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { trialModesFixture } = await import('./fixtures/trial-modes.mjs');
const { seasonalFixture } = await import('./fixtures/seasonal-suite.mjs');

const p = loadProtocol();
const WAIT_SECONDS = 0.04, WAIT_MS = WAIT_SECONDS * 1000;
const HOUR = 3600;
let serial = 0, total = 0;
const ledger = () => createUsageLedger('qa', { file: path.join(dir, 'ledger-' + (++serial) + '.json') });
const nowS = () => Math.floor(Date.now() / 1000);
const test = async (name, work) => { await work(); total++; console.log('通过：' + name); };
const rejectWith = (name, text) => Object.assign(new Error('server prompt: ' + text), { prompt: { prompt: 5, args: [text], style: 1 }, request: name });
const ledgerEntries = l => Object.entries(l.keyRecords());

const config = {
  materialName: id => id,
  nextAfkRewardLevel: () => null,
  tables: {
    AdvChannelCfg: { data: [{ key: '1400', isOpen: true, minAppVersion: '' }] },
    ModuleOpenCfg: { data: [{ moduleId: '广告', playerLevel: 9 }] },
    VipLevelCfg: { data: [{ level: 0, effects: [] }, { level: 3, effects: [['免广告', 1]] }] },
    AdvEffectCfg: { data: [[1, 1], [2, 3], [3, 1], [4, 1], [5, 1], [6, 3], [7, 3], [8, 3]].map(([id, dailyLimit]) => ({ id, dailyLimit })) },
    BuildingUnlockCfg: { data: [{ buildingType: '博物馆', buildingId: '1博物馆' }] },
  },
};

function server() {
  const now = nowS();
  const state = {
    adv: new Map(config.tables.AdvEffectCfg.data.map(row => [row.id, 0])),
    watched: new Map(),
    minWaitMs: 0,
    building: [],
    cases: [],
    afk: { level: 1, afkStartTime: now - 5, afkFinishTime: now + 8 * HOUR, rewardedLevel: 0 },
    shop: [{ id: 1001, gotTimes: 0, max: 2, reward: false, asset: { type: 0, id: '木材', num: 5 } }],
    recruit: { hero: 80, antique: 50 },
    writes: [],
    timeout: null,
    onWatch: null,
  };
  const claim = (name, key, effect) => {
    const at = state.watched.get(key);
    if (at === undefined || Date.now() - at < state.minWaitMs) throw rejectWith(name, 'adv not finished');
    state.watched.delete(key);
    if (effect) state.adv.set(effect, state.adv.get(effect) + 1);
  };
  const speedUp = (name, body, effect) => {
    assert.deepEqual({ type: body.speedUp.type, useNum: body.speedUp.useNum }, { type: 3, useNum: 0 }, name + ' 必须走广告分支');
    claim(name, '1:' + effect, effect);
  };
  const handlers = {
    FirstChargeRequest: () => ({ firstCharge: { record: [] } }),
    OnWaterRequest: () => ({ building: state.building, adv: [...state.adv].map(([id, gotTimes]) => ({ id, gotTimes, reward: false })) }),
    AfkInfoRequest: () => ({ afkInfo: state.afk }),
    WatchAdvRequest: body => {
      state.watched.set(body.type + ':' + body.id, Date.now());
      state.onWatch?.(body);
      return {};
    },
    DrawAfkRewardRequest: body => {
      if (body.useAdvCard) claim('DrawAfkRewardRequest', '1:1', 1);
      state.afk.afkStartTime = nowS();
      state.afk.afkFinishTime = nowS() + 8 * HOUR;
      return { afkStartTime: state.afk.afkStartTime, afkFinishTime: state.afk.afkFinishTime, reward: { assetPackage: { asset: [{ type: 1, id: 'GOLD', num: 367 }] } } };
    },
    AdvShopInfoRequest: () => ({ product: state.shop }),
    GotAdvRewardRequest: body => {
      claim('GotAdvRewardRequest', (body.type ?? 2) + ':' + body.id);
      state.shop.find(row => row.id === body.id).gotTimes++;
      return { reward: { asset: [{ type: 0, id: '木材', num: 5 }] } };
    },
    RecruitInfoRequest: () => ({ hero: { recruitTimes: state.recruit.hero }, antique: { recruitTimes: state.recruit.antique } }),
    RecruitStartRequest: body => {
      assert.equal(body.way, 5);
      claim('RecruitStartRequest', '1:2', 2);
      state.recruit.hero++;
      return { recruitData: { recruitTimes: state.recruit.hero } };
    },
    AntiqueRecruitRequest: body => {
      assert.deepEqual([body.type, body.way], [1, 5]);
      claim('AntiqueRecruitRequest', '1:7', 7);
      state.recruit.antique++;
      return { recruitData: { recruitTimes: state.recruit.antique } };
    },
    SpeedUpFactoryProduceRequest: body => {
      const job = state.building.find(b => b.buildingId === body.buildingId).factory.factoryQ.find(row => (row.idx ?? 0) === body.index);
      assert(job, '必须使用真实 queue.idx');
      if (body.speedUp.type === 2) {
        job.finishTime -= body.speedUp.useNum * 60;
        return {};
      }
      speedUp('SpeedUpFactoryProduceRequest', body, 6);
      job.finishTime -= 1800;
      return {};
    },
    SpeedUpUpgradeBuildingRequest: body => {
      speedUp('SpeedUpUpgradeBuildingRequest', body, 8);
      state.building.find(b => b.buildingId === body.buildingId).buildFinishTime -= 1800;
      return {};
    },
    AllItemRequest: () => ({ items: [{ itemId: '加速器', num: 999 }] }),
    MuseumInfoRequest: () => ({ popularity: 1, topPopularity: 1, uncollectedRevenue: 0, revenueLastSettleTime: 1,
      exhibitions: [{ exhibitionId: 1, level: 1, cases: state.cases }] }),
    MuseumSpeedUpCaseRequest: body => {
      speedUp('MuseumSpeedUpCaseRequest', body, 8);
      state.cases.find(row => row.caseIndex === body.caseIndex).upgradeFinishTime -= 1800;
      return {};
    },
    MuseumFinishCaseUpgradeRequest: body => {
      const row = state.cases.find(item => item.caseIndex === body.caseIndex);
      row.upgradeFinishTime = 0;
      row.level++;
      return {};
    },
  };
  const client = new EventEmitter();
  client.connected = true;
  client.serverClockOffsetMs = 0;
  const dispatch = (name, body, response) => {
    assert(p[name], '真实协议缺少请求 ' + name);
    const sent = p[name].decode(p[name].encode(body).finish());
    assert(handlers[name], '假服务器未实现 ' + name);
    if (!/^(OnWater|AfkInfo|FirstCharge|AdvShopInfo|RecruitInfo|MuseumInfo|AllItem)Request$/.test(name)) state.writes.push({ name, body: structuredClone(body), at: Date.now() });
    if (state.timeout === name) throw new Error('timeout waiting for reply (sent ' + name + ')');
    const value = handlers[name](sent);
    if (!response) return value;
    assert(p[response], '真实协议缺少回包 ' + response);
    return p[response].decode(p[response].encode(value).finish());
  };
  client.request = async (name, body = {}, response = name.replace(/Request$/, 'Response')) => dispatch(name, body, response);
  client.sendWatch = async (name, body) => { dispatch(name, body, null); return { sent: 1, name }; };
  return { state, client, names: () => state.writes.map(row => row.name) };
}

function context(f, { keys = [], privileged = false, opted = true, l = ledger() } = {}) {
  const settings = defaultSettings();
  settings.ads = { noPrivilege: opted, waitSeconds: WAIT_SECONDS };
  const deferred = new Map(), log = [];
  let allowed = true;
  const ctx = {
    player: { playerId: '9007199254740993', worldId: '1001001', level: 20, vip: { vipLevel: privileged ? 3 : 0 } },
    clientInfo: { appId: '14021170', channelId: '1400', originVersion: '76' },
    language: 'zh_CN',
    getSettings: () => settings,
    ledger: l,
    enabled: key => allowed && keys.includes(key) && !(deferred.get(key) > nowS()),
    report: entry => log.push(entry),
    scheduler: { now: nowS, nextDay: () => nowS() + 86400, defer: (key, until) => deferred.set(key, until), clear: key => deferred.delete(key) },
  };
  return { ctx, log, settings, deferred, ledger: l, pause: () => { allowed = false; }, resume: () => { allowed = true; } };
}

const factory = (buildingId, jobs) => ({ buildingId, level: 3, factory: { factoryQ: jobs } });
const job = (idx, seconds) => ({ ...(idx ? { idx } : {}), productId: '木板', finishTime: nowS() + seconds });

await test('协议目录与文档枚举、字段一致', () => {
  for (const name of ['WatchAdvRequest', 'GotAdvRewardRequest', 'DrawAfkRewardRequest', 'RecruitStartRequest', 'AntiqueRecruitRequest', 'TrialRaidBuySweepRequest',
    'SpeedUpFactoryProduceRequest', 'SpeedUpUpgradeBuildingRequest', 'MuseumSpeedUpCaseRequest', 'MuseumFinishCaseUpgradeRequest',
    'OkResponse', 'GotRewardResponse', 'DrawAfkRewardResponse', 'RecruitStartResponse', 'AntiqueRecruitResponse', 'AfkInfoResponse', 'MuseumInfoResponse', 'AdvShopInfoResponse']) assert(p[name], name);
  assert.deepEqual([p.AdvType.ADV_EFFECT, p.AdvType.ADV_SHOP, p.AdvType.ADV_FESTIVAL_GIFT, p.AdvType.ADV_SNOWBALL_GIFT], [1, 2, 3, 4]);
  assert.equal(p.RecruitWay.RECRUIT_ADV, 5);
  assert.equal(p.SpeedUpCost.SPEED_UP_ADV, 3);
  for (const name of ['TrialRaidBuySweepResponse', 'SpeedUpUpgradeBuildingResponse', 'MuseumSpeedUpCaseResponse']) assert(!p[name], name + ' 不存在，不能按名称拼接回包');
});

await test('广告任务仍独立开关，无权益策略默认开启且兼容旧关闭值', () => {
  const defaults = defaultSettings();
  assert.deepEqual(defaults.ads, { noPrivilege: true, waitSeconds: 15 });
  for (const key of ['afkAd', 'compassAdGift', 'adSpeedUpProduce', 'adSpeedUpBuilding', 'adSpeedUpMuseum']) assert.equal(automationTasks.find(task => task.key === key)?.initial, false, key);
  const old = validateSettings(defaultSettings());
  delete old.ads;
  const file = path.join(dir, 'old-settings.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { qa: { settings: old, revision: 3 } } }));
  assert.equal(loadAutomationSettings('qa', { file }).settings.ads.noPrivilege, true);
  assert.equal(importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: old }).ads.noPrivilege, true);
  old.ads = { noPrivilege: false, waitSeconds: 21 };
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { qa: { settings: old, revision: 3 } } }));
  const bytes = fs.readFileSync(file);
  assert.deepEqual(loadAutomationSettings('qa', { file }).settings.ads, { noPrivilege: true, waitSeconds: 21 });
  assert.deepEqual(importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: old }).ads, { noPrivilege: true, waitSeconds: 21 });
  assert.deepEqual(fs.readFileSync(file), bytes, '读取迁移不改写磁盘与版本');
  for (const bad of [4, 121, 1.5]) assert.throws(() => validateSettings({ ...defaultSettings(), ads: { noPrivilege: true, waitSeconds: bad } }), /5–120/);
  const closed = defaultSettings();
  closed.loop.world = false;
  for (const key of ['adSpeedUpProduce', 'adSpeedUpBuilding', 'adSpeedUpMuseum']) assert.equal(nativePreferenceEnabled(closed, key), false, key);
  const open = defaultSettings();
  open.factory.enabled = false;
  assert.equal(nativePreferenceEnabled(open, 'adSpeedUpProduce'), false);
  assert.deepEqual(automationControlView(open).find(c => c.key === 'schedule.adSpeedUpProduce').blockedBy, ['工厂总开关']);
  const ui = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
  assert(!ui.includes("configField('ads.noPrivilege'"));
  assert(!ui.includes('when:d=>d.ads.noPrivilege'));
  for (const key of ['ads.waitSeconds', 'schedule.afkAd', 'schedule.compassAdGift', 'schedule.adSpeedUpProduce', 'schedule.adSpeedUpBuilding', 'schedule.adSpeedUpMuseum']) assert(ui.includes("'" + key + "'"), key);
});

await test('旧无权益开关为false不再阻止已开启的广告入口', async () => {
  const f = server(), c = context(f, { opted: false, keys: ['afkAd', 'adSpeedUpProduce', 'adSpeedUpBuilding', 'adSpeedUpMuseum', 'heroAdRecruit', 'antiqueAdRecruit'] });
  f.state.building = [factory('1木工厂', [job(1, HOUR)])];
  await claimAfkAd(f.client, config, c.ctx);
  await claimAdSpeedUps(f.client, config, c.ctx);
  await recruitWithSkipAds(f.client, config, { ...c.ctx, enabled: key => ['heroAdRecruit', 'antiqueAdRecruit'].includes(key) });
  const schedule = { due: () => true, now: nowS, nextDay: () => nowS() + 86400, defer() {} };
  await claimAdShop(f.client, config, { ...c.ctx, enabled: () => true, schedule });
  for (const name of ['DrawAfkRewardRequest', 'SpeedUpFactoryProduceRequest', 'RecruitStartRequest', 'AntiqueRecruitRequest', 'GotAdvRewardRequest']) assert(f.names().includes(name), name);
  assert(!c.log.some(row => row.reason === '当前账号没有免广告权益'));
});

await test('无权益默认策略不绕过各广告任务的关闭开关', async () => {
  const f = server(), c = context(f);
  await claimAfkAd(f.client, config, c.ctx);
  await claimAdSpeedUps(f.client, config, c.ctx);
  await recruitWithSkipAds(f.client, config, c.ctx);
  await claimAdShop(f.client, config, { ...c.ctx, enabled: () => false, schedule: { due: () => true } });
  assert.deepEqual(f.state.writes, []);
});

await test('挂机收益：60 秒窗口内申请、等待后领取，次数用完即停', async () => {
  const f = server(), c = context(f, { keys: ['afkAd'] });
  f.state.minWaitMs = WAIT_MS;
  await claimAfkAd(f.client, config, c.ctx);
  assert.deepEqual(f.state.writes.map(row => [row.name, row.body]), [['WatchAdvRequest', { type: 1, id: 1 }], ['DrawAfkRewardRequest', { useAdvCard: true }]]);
  assert(f.state.writes[1].at - f.state.writes[0].at >= WAIT_MS, '必须等够设定秒数');
  assert.equal(c.log.at(-1).ok, true);
  assert.match(c.log.at(-1).note, /GOLD ×367/);
  assert(ledgerEntries(c.ledger).every(([, record]) => record.confirmed));
  await claimAfkAd(f.client, config, c.ctx);
  assert.equal(f.state.writes.length, 2);
  assert(c.deferred.get('afkAd') > nowS());
});

await test('挂机收益：超过窗口不发送，有权益时无需等待', async () => {
  const f = server(), c = context(f, { keys: ['afkAd'] });
  f.state.afk.afkStartTime = nowS() - HOUR;
  await claimAfkAd(f.client, config, c.ctx);
  assert.deepEqual(f.state.writes, []);
  assert.match(c.log[0].reason, /60 秒/);
  const g = server(), d = context(g, { keys: ['afkAd'], privileged: true, opted: false });
  await claimAfkAd(g.client, config, d.ctx);
  assert.deepEqual(g.names(), ['WatchAdvRequest', 'DrawAfkRewardRequest']);
  assert(g.state.writes[1].at - g.state.writes[0].at < WAIT_MS);
});

await test('工厂加速：选真实队列中剩余最长项，排除未开工、将完工和禁用工厂', async () => {
  const f = server(), c = context(f, { keys: ['adSpeedUpProduce'], privileged: true });
  c.settings.factory.disabledTypes = ['9禁用厂'];
  f.state.building = [
    factory('1木工厂', [{ productId: '木板', finishTime: nowS() + 3 * HOUR }, { idx: 1, productId: '木板', finishTime: 0 }]),
    factory('2石工厂', [job(3, 60)]),
    factory('9禁用厂', [job(1, 9 * HOUR)]),
  ];
  await claimAdSpeedUps(f.client, config, c.ctx);
  const sends = f.state.writes.filter(row => row.name === 'SpeedUpFactoryProduceRequest');
  assert.equal(sends.length, 3, '每天 3 次');
  for (const row of sends) assert.deepEqual(row.body, { buildingId: '1木工厂', index: 0, speedUp: { type: 3, useNum: 0 } });
  assert(c.deferred.get('adSpeedUpProduce') > nowS());
  const left = server(), e = context(left, { keys: ['adSpeedUpProduce'], privileged: true });
  left.state.building = [factory('2石工厂', [job(3, 60)]), factory('3空工厂', [])];
  await claimAdSpeedUps(left.client, config, e.ctx);
  assert.deepEqual(left.state.writes, [], '只加速进行中的目标');
});

await test('建筑与博物馆共用次数，优先剩余最长目标，到期后补发展柜完工一次', async () => {
  const f = server(), c = context(f, { keys: ['adSpeedUpBuilding', 'adSpeedUpMuseum'], privileged: true });
  c.settings.building.disabledTypes = ['9禁用楼'];
  f.state.building = [
    { buildingId: '1博物馆', level: 1 },
    { buildingId: '2码头', level: 2, buildStartTime: 1, buildFinishTime: nowS() + 2 * HOUR },
    { buildingId: '9禁用楼', level: 2, buildStartTime: 1, buildFinishTime: nowS() + 9 * HOUR },
  ];
  f.state.cases = [
    { caseIndex: 4, level: 1, unlocked: true, antiqueId: '', upgradeFinishTime: nowS() + 4 * HOUR },
    { caseIndex: 5, level: 1, unlocked: true, antiqueId: '', upgradeFinishTime: nowS() - 10 },
  ];
  await claimAdSpeedUps(f.client, config, c.ctx);
  assert.deepEqual(f.state.writes.filter(row => row.name === 'MuseumFinishCaseUpgradeRequest').map(row => row.body), [{ exhibitionId: 1, caseIndex: 5 }]);
  const spend = f.state.writes.filter(row => /SpeedUp/.test(row.name));
  assert.equal(spend.length, 3, '共用 3 次');
  for (const row of spend) assert.deepEqual(row.body, { exhibitionId: 1, caseIndex: 4, speedUp: { type: 3, useNum: 0 } });
  assert.equal(f.state.adv.get(8), 3);
  await claimAdSpeedUps(f.client, config, c.ctx);
  assert.equal(f.state.writes.filter(row => row.name === 'MuseumFinishCaseUpgradeRequest').length, 1);
  const before = server(), d = context(before, { keys: ['adSpeedUpMuseum'], privileged: true });
  before.state.building = [{ buildingId: '1博物馆', level: 0 }];
  await claimAdSpeedUps(before.client, config, d.ctx);
  assert.deepEqual(before.state.writes, [], '博物馆未建成不读写');
});

await test('等待中暂停：不发领奖、释放记录，恢复后可重新领取', async () => {
  const f = server(), c = context(f, { keys: ['adSpeedUpProduce'] });
  f.state.building = [factory('1木工厂', [job(1, 3 * HOUR)])];
  f.state.onWatch = () => setTimeout(c.pause, 5);
  await claimAdSpeedUps(f.client, config, c.ctx);
  assert.deepEqual(f.names(), ['WatchAdvRequest']);
  assert.equal(c.log.at(-1).reason, AD_PAUSED_REASON);
  assert.deepEqual(ledgerEntries(c.ledger), []);
  c.resume();
  f.state.onWatch = null;
  await claimAdSpeedUps(f.client, config, c.ctx);
  assert(f.names().includes('SpeedUpFactoryProduceRequest'));
  const g = server(), d = context(g, { keys: ['afkAd'] });
  g.state.onWatch = () => setTimeout(() => { g.client.connected = false; }, 5);
  await claimAfkAd(g.client, config, d.ctx);
  assert.deepEqual(g.names(), ['WatchAdvRequest'], '断线后不发送');
});

await test('服务器判未完成：释放记录、报跳过并冷却该入口，不反复尝试', async () => {
  const f = server(), c = context(f, { keys: ['adSpeedUpProduce'] });
  f.state.minWaitMs = 60_000;
  f.state.building = [factory('1木工厂', [job(1, 3 * HOUR)])];
  await claimAdSpeedUps(f.client, config, c.ctx);
  assert.deepEqual(f.names(), ['WatchAdvRequest', 'SpeedUpFactoryProduceRequest']);
  assert.equal(c.log.at(-1).skipped, true);
  assert.equal(c.log.at(-1).reason, AD_NOT_FINISHED_REASON);
  assert.deepEqual(ledgerEntries(c.ledger), []);
  await claimAdSpeedUps(f.client, config, c.ctx);
  assert.equal(f.state.writes.length, 2, '冷却期内不再申请广告');
  assert.equal(c.log.at(-1).reason, AD_PACED_REASON);
  assert.match(describeLogError('server prompt: adv not finished').message, /广告未完成/);
});

await test('结果未知：保留记录不重发，次数增加后解除；前一天记录不阻塞当天', async () => {
  const f = server(), c = context(f, { keys: ['afkAd'] });
  f.state.timeout = 'DrawAfkRewardRequest';
  await claimAfkAd(f.client, config, c.ctx);
  assert.equal(c.log.at(-1).status, 'unknown');
  assert.equal(ledgerEntries(c.ledger).length, 1);
  f.state.timeout = null;
  await claimAfkAd(f.client, config, c.ctx);
  assert.deepEqual(f.names(), ['WatchAdvRequest', 'DrawAfkRewardRequest'], '未知结果不重发');
  assert.match(c.log.at(-1).reason, /待核对/);
  f.state.adv.set(1, 1);
  await claimAfkAd(f.client, config, c.ctx);
  assert.equal(c.log.at(-1).reason, '今日广告次数已用完');
  const g = server(), d = context(g, { keys: ['afkAd'] });
  const yesterday = Math.floor((nowS() + 28800) / 86400) - 1;
  d.ledger.reserve({}, {}, {}, { uniqueKey: 'ad-effect:' + yesterday + ':1:0', details: { kind: 'adEffect', effectId: 1, day: yesterday, used: 0 } });
  await claimAfkAd(g.client, config, d.ctx);
  assert.equal(d.log.at(-1).ok, true);
});

await test('整轮挂机限速：每轮一次等待式广告，手动入口和有权益账号不受限', async () => {
  const f = server(), base = { waitMs: 1000 };
  beginAdRound(f.client);
  assert.equal(takeAdSlot(f.client, base), true);
  assert.equal(takeAdSlot(f.client, base), false);
  assert.equal(takeAdSlot(f.client, base, { manual: true }), true);
  assert.equal(takeAdSlot(f.client, { waitMs: 0 }), true);
  beginAdRound(f.client);
  assert.equal(takeAdSlot(f.client, base), true);

  const g = server(), c = context(g);
  g.state.shop = [{ id: 1001, gotTimes: 0, max: 2, reward: false, asset: { type: 0, id: '木材', num: 5 } }, { id: 1002, gotTimes: 0, max: 1, reward: false, asset: { type: 0, id: '石料', num: 5 } }];
  c.settings.ads.noPrivilege = true;
  for (const key of Object.keys(c.settings.schedule)) c.settings.schedule[key] = false;
  Object.assign(c.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
  c.settings.dailies.enabled = false;
  c.settings.resident.rewards = false;
  c.settings.schedule.adShop = true;
  const loopOptions = { config, player: c.ctx.player, adChannel: { clientInfo: c.ctx.clientInfo, language: c.ctx.language }, allowMutate: true, rounds: 1, everyMs: 0,
    getSettings: () => c.settings, isEnabled: key => key === 'adShop', usageLedger: c.ledger };
  for (let round = 1; round <= 3; round++) {
    await runLoop(g.client, p, loopOptions);
    assert.equal(g.state.writes.filter(row => row.name === 'WatchAdvRequest').length, round, '第 ' + round + ' 轮');
    const { rewardSchedule } = await import('../src/reward-schedule.mjs');
    rewardSchedule(g.client).clearTask('adShop');
  }
  assert.deepEqual(g.state.shop.map(row => row.gotTimes), [2, 1]);
});

await test('普通挂机领取后在同一轮接上广告领取', async () => {
  const f = server(), c = context(f);
  f.state.afk.afkStartTime = nowS() - 8 * HOUR;
  f.state.afk.afkFinishTime = nowS() - 1;
  for (const key of Object.keys(c.settings.schedule)) c.settings.schedule[key] = false;
  Object.assign(c.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
  c.settings.dailies.enabled = false;
  c.settings.resident.rewards = false;
  Object.assign(c.settings.schedule, { afk: true, afkAd: true });
  await runLoop(f.client, p, { config, player: c.ctx.player, adChannel: { clientInfo: c.ctx.clientInfo, language: c.ctx.language }, allowMutate: true, rounds: 1, everyMs: 0,
    getSettings: () => c.settings, isEnabled: key => ['afk', 'afkAd'].includes(key), usageLedger: c.ledger });
  assert.deepEqual(f.state.writes.map(row => [row.name, row.body]), [['DrawAfkRewardRequest', {}], ['WatchAdvRequest', { type: 1, id: 1 }], ['DrawAfkRewardRequest', { useAdvCard: true }]]);
});

await test('基地阶段先执行广告加速，同轮加速器计划按缩短后的时间计算', async () => {
  const f = server(), c = context(f);
  f.state.building = [factory('1木工厂', [job(1, 3 * HOUR)])];
  const remaining = () => f.state.building[0].factory.factoryQ[0].finishTime - nowS();
  for (const key of Object.keys(c.settings.schedule)) c.settings.schedule[key] = false;
  Object.assign(c.settings.loop, { world: true, tasks: false, dailies: false, heroes: false });
  c.settings.dailies.enabled = false;
  c.settings.resident.rewards = false;
  Object.assign(c.settings.schedule, { adSpeedUpProduce: true, speedUp: true });
  c.settings.factory.speedUp = true;
  await runLoop(f.client, p, { config, player: c.ctx.player, adChannel: { clientInfo: c.ctx.clientInfo, language: c.ctx.language }, allowMutate: true, rounds: 1, everyMs: 0,
    getSettings: () => c.settings, isEnabled: key => ['adSpeedUpProduce', 'speedUp'].includes(key), usageLedger: c.ledger });
  const speedUps = f.state.writes.filter(row => row.name === 'SpeedUpFactoryProduceRequest');
  assert.deepEqual(speedUps.map(row => row.body.speedUp.type), [3, 2], '广告先于加速器');
  assert.equal(f.names().filter(name => name === 'WatchAdvRequest').length, 1, '每轮只处理一次广告');
  assert.equal(f.state.adv.get(6), 1);
  assert.equal(speedUps[1].body.speedUp.useNum, 150, '3 小时扣除广告 30 分钟后只花 150 个加速器');
  assert(remaining() <= 0);
});

await test('英雄与藏品招募按等待策略领取，暂停和未完成都不占记录', async () => {
  const enabled = key => ['heroAdRecruit', 'antiqueAdRecruit'].includes(key);
  const f = server(), c = context(f);
  f.state.minWaitMs = WAIT_MS;
  await recruitWithSkipAds(f.client, config, { ...c.ctx, enabled });
  assert.deepEqual(f.state.recruit, { hero: 83, antique: 53 });
  assert(f.state.writes.every(row => row.name === 'WatchAdvRequest' || row.at - f.state.writes[f.state.writes.indexOf(row) - 1].at >= WAIT_MS));
  const g = server(), d = context(g);
  g.state.minWaitMs = 60_000;
  await recruitWithSkipAds(g.client, config, { ...d.ctx, enabled });
  assert.deepEqual(ledgerEntries(d.ledger), []);
  assert(d.log.every(row => row.skipped && row.reason === AD_NOT_FINISHED_REASON));
  const h = server(), e = context(h);
  let on = true;
  h.state.onWatch = () => setTimeout(() => { on = false; }, 5);
  await recruitWithSkipAds(h.client, config, { ...e.ctx, enabled: key => on && enabled(key) });
  assert.deepEqual(h.names(), ['WatchAdvRequest']);
  assert.deepEqual(ledgerEntries(e.ledger), []);
});

await test('招募：前一天未知记录不再永久阻塞，当天未知仍阻塞', async () => {
  const enabled = key => key === 'heroAdRecruit';
  const f = server(), c = context(f);
  const today = Math.floor((nowS() + 28800) / 86400);
  c.ledger.reserve({}, {}, {}, { uniqueKey: 'ad-recruit:' + (today - 1) + ':2:0', details: { kind: 'adRecruit', id: 2, used: 0, recruitTimes: 1, taskTimes: null } });
  await recruitWithSkipAds(f.client, config, { ...c.ctx, enabled });
  assert.equal(f.state.recruit.hero, 83);
  const g = server(), d = context(g);
  d.ledger.reserve({}, {}, {}, { uniqueKey: 'ad-recruit:' + today + ':2:0', details: { kind: 'adRecruit', id: 2, used: 0, recruitTimes: 80, taskTimes: null } });
  await recruitWithSkipAds(g.client, config, { ...d.ctx, enabled });
  assert.deepEqual(g.state.writes, []);
  assert.match(d.log.at(-1).reason, /未确认/);
});

const trialRun = (f, l, options = {}) => executeTrialSweep(f.client, f.protocol, f.config, f.player, 1, 'ad', { getSettings: () => f.settings, ledger: l, channel: f.channel, ...options });
await test('试炼广告扫荡：旧无权益关闭值也等待领取，暂停释放记录', async () => {
  const closed = trialModesFixture();
  closed.player.vip.vipLevel = 1;
  closed.settings.ads = { noPrivilege: false, waitSeconds: WAIT_SECONDS };
  const none = await trialRun(closed, ledger());
  assert.equal(none.ok, true);
  assert.deepEqual(closed.state.writes.map(row => row.name), ['WatchAdvRequest', 'TrialRaidBuySweepRequest']);

  const f = trialModesFixture(), l = ledger();
  f.player.vip.vipLevel = 1;
  f.settings.ads = { noPrivilege: true, waitSeconds: WAIT_SECONDS };
  const started = Date.now();
  const done = await trialRun(f, l);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert(Date.now() - started >= WAIT_MS);
  assert.deepEqual(f.state.writes.map(row => row.name), ['WatchAdvRequest', 'TrialRaidBuySweepRequest']);
  assert.deepEqual(f.state.writes[0].body, { type: 1, id: 4 });
  assert.equal(f.state.writes[1].body.useAdvCard, true);

  const g = trialModesFixture(), m = ledger();
  g.player.vip.vipLevel = 1;
  g.settings.ads = { noPrivilege: true, waitSeconds: WAIT_SECONDS };
  let on = true;
  g.state.onWatch = () => { setTimeout(() => { on = false; }, 5); };
  const paused = await trialRun(g, m, { enabled: () => on });
  assert.equal(paused.skipped, true);
  assert.equal(paused.reason, AD_PAUSED_REASON);
  assert.deepEqual(g.state.writes.map(row => row.name), ['WatchAdvRequest']);
  assert.deepEqual(ledgerEntries(m), []);
  on = true;
  g.state.onWatch = null;
  assert.equal((await trialRun(g, m)).ok, true);
});

await test('试炼广告扫荡：未完成提示释放记录，前一天未知广告记录不阻塞当天', async () => {
  const f = trialModesFixture(), l = ledger();
  f.player.vip.vipLevel = 1;
  f.settings.ads = { noPrivilege: true, waitSeconds: WAIT_SECONDS };
  const send = f.client.sendWatch;
  f.client.sendWatch = async name => { throw rejectWith(name, 'adv not finished'); };
  const result = await trialRun(f, l);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, AD_NOT_FINISHED_REASON);
  assert.deepEqual(ledgerEntries(l), []);
  f.client.sendWatch = send;
  const cooling = await trialRun(f, l);
  assert.equal(cooling.reason, AD_PACED_REASON);
  assert.equal((await trialRun(f, l, { manual: true })).ok, true, '手动入口不受冷却限制');

  const g = trialModesFixture(), m = ledger();
  g.player.vip.vipLevel = 1;
  g.settings.ads = { noPrivilege: true, waitSeconds: WAIT_SECONDS };
  const today = Math.floor((nowS() + 28800) / 86400);
  m.reserve({}, {}, {}, { uniqueKey: 'trialSweep:old', details: { kind: 'trialSweep', mode: 'ad', raidId: 1, worldId: '1001001', playerId: '9007199254740993', day: today - 1, nextCount: 1 } });
  assert.equal((await trialRun(g, m)).ok, true);
});

function seasonal({ opted = true } = {}) {
  const f = seasonalFixture(), l = ledger(), log = [];
  f.player.vip.vipLevel = 0;
  f.settings.ads = { noPrivilege: opted, waitSeconds: WAIT_SECONDS };
  let on = true;
  const run = (service, key, extra = {}) => service(f.client, f.config, { player: f.player, clientInfo: { appId: '14021170', channelId: '1400', originVersion: '76' }, language: 'zh_CN',
    key, label: key, ledger: l, settings: () => f.settings, enabled: () => on, report: entry => log.push(entry), ...extra });
  return { ...f, l, log, run, sent: name => f.state.writes.filter(row => row.name === name), set: value => { on = value; } };
}

await test('走江广告礼包：旧无权益关闭值仍领取，回包有奖励即确认', async () => {
  const closed = seasonal({ opted: false });
  await closed.run(riverActivity, 'riverHelp');
  assert.equal(closed.sent('WatchAdvRequest').length, 1);
  assert.equal(closed.sent('GotAdvRewardRequest').length, 1);
  assert.equal(closed.sent('SnowballClaimGiftRequest').length, 1);

  const f = seasonal();
  await f.run(riverActivity, 'riverHelp');
  assert.deepEqual(f.sent('WatchAdvRequest').map(row => row.body), [{ type: 4, id: 1001 }]);
  assert.deepEqual(f.sent('GotAdvRewardRequest').map(row => row.body), [{ type: 4, id: 1001 }]);
  assert(f.log.some(row => row.ok && row.status === 'confirmed' && /免广告/.test(row.label)));
  await f.run(riverActivity, 'riverHelp');
  assert.equal(f.sent('GotAdvRewardRequest').length, 1);

  const g = seasonal();
  g.state.snow.giftBuy.push({ packId: 1000, bought: 1 });
  const read = g.client.request;
  let frozen = false;
  g.client.request = async (name, body, response) => {
    const reply = await read(name, body, response);
    if (name === 'GotAdvRewardRequest') { g.state.snow.giftBuy = g.state.snow.giftBuy.filter(row => row.packId !== 1001); frozen = true; }
    return reply;
  };
  await g.run(riverActivity, 'riverHelp');
  assert.equal(frozen, true);
  assert(g.log.some(row => row.ok && row.status === 'confirmed'), '服务端计数未更新时以回包奖励确认');
  beginAdRound(g.client);
  await g.run(riverActivity, 'riverHelp');
  assert.equal(g.sent('WatchAdvRequest').length, 1, '已确认的礼包不再申请广告');
  assert.equal(takeAdSlot(g.client, { waitMs: 1 }), true, '未真正发送时不占用本轮额度');
});

await test('龙王罗盘广告礼包：type=3 仅领广告档，次日可再领，无权益默认领取', async () => {
  const closed = seasonal({ opted: false });
  await closed.run(compassActivity, 'compassAdGift');
  assert.equal(closed.sent('WatchAdvRequest').length, 1);
  assert.equal(closed.sent('GotAdvRewardRequest').length, 1);

  const f = seasonal();
  await f.run(compassActivity, 'compassAdGift');
  assert.deepEqual(f.sent('WatchAdvRequest').map(row => row.body), [{ type: 3, id: 1001 }]);
  assert.deepEqual(f.sent('GotAdvRewardRequest').map(row => row.body), [{ type: 3, id: 1001 }]);
  assert.equal(f.sent('ClaimFreeSelectGiftRequest').length, 0);
  await f.run(compassActivity, 'compassAdGift');
  assert.equal(f.sent('WatchAdvRequest').length, 1, '当天不重复');
  f.client.seriesSnapshotDay = Math.floor((Math.floor((Date.now() + f.client.serverClockOffsetMs) / 1000) + 28800) / 86400);
  f.client.serverClockOffsetMs += 86400_000;
  await f.run(compassActivity, 'compassAdGift');
  assert.equal(f.sent('GotAdvRewardRequest').length, 2, '次日重新可领');

  const g = seasonal();
  const read = g.client.request;
  g.client.request = async (name, body, response) => {
    if (name === 'GotAdvRewardRequest') {
      g.state.writes.push({ name, body });
      throw rejectWith(name, 'already claimed');
    }
    return read(name, body, response);
  };
  await g.run(compassActivity, 'compassAdGift');
  await g.run(compassActivity, 'compassAdGift');
  assert.equal(g.sent('WatchAdvRequest').length, 1, '被其他端领过后不反复申请广告');
  assert.equal(g.log[0].status, 'rejected');

  const h = seasonal();
  const late = h.client.request;
  h.client.request = async (name, body, response) => {
    if (name === 'WatchAdvRequest') setTimeout(() => h.set(false), 5);
    return late(name, body, response);
  };
  await h.run(compassActivity, 'compassAdGift');
  assert.equal(h.sent('GotAdvRewardRequest').length, 0, '等待中暂停不发领奖');
  assert.deepEqual(ledgerEntries(h.l), []);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log('广告奖励专项 ' + total + '/' + total + ' 通过');
