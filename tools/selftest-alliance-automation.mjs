import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-alliance-auto-'));
process.env.CW_DATA_DIR = root;
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { runAllianceAutomation, allianceRecruitDemand, readAllianceRecruitDemand, allianceExchangeMaterial } = await import('../src/alliance-automation.mjs');
const { guildMutualFixture } = await import('./fixtures/guild-mutual.mjs');
const { loadConfig } = await import('../src/config.mjs');
let serial = 0, passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
const settings = () => ({ alliance: { enabled: true, recruit: false, recruitDailyLimit: 0, recruitProduction: false, mutual: true,
  mutualMode: 'custom', autoHelp: false, autoAsk: false, allowedMaterials: [], blockedMaterials: [], requestMaterials: [], memberKeywords: [],
  stockReserve: 0, helpDailyLimit: 20, collectGifts: false, autoTech: false, techIds: [], techDailyLimit: 20 } });
function fixture() {
  const f = guildMutualFixture(), id = ++serial;
  f.player.playerId = String(9007199260000000n + BigInt(id));
  f.state.members[0].playerId = f.player.playerId;
  f.config.tables.CargoUnlockCfg = { data: [{ index: 1, playerLevel: 9 }] };
  f.state.workerOrder = []; f.state.before = null;
  const request = f.client.request;
  f.client.request = async (name, body, response) => {
    await f.state.before?.(name, body);
    if (name === 'OnWaterRequest') return { workerOrder: structuredClone(f.state.workerOrder), buildings: [] };
    if (name === 'WeekInfoRequest') return { activityTime: [] };
    if (name === 'CargoShipsRequest') return { ship: [] };
    return request(name, body, response);
  };
  f.settings = settings(); f.reports = []; f.file = path.join(root, id + '.json');
  f.ledger = createUsageLedger('fixture-' + id, { file: f.file });
  f.run = () => runAllianceAutomation(f.client, f.protocol, f.config, f.player, { getSettings: () => f.settings, ledger: f.ledger, enabled: () => true, report: row => f.reports.push(row) });
  f.gifts = () => f.state.writes.filter(row => row.name === 'GuildAidHelpRequest');
  f.asks = () => f.state.writes.filter(row => row.name === 'GuildAidAskRequest');
  return f;
}

try {
  await test('总开关关闭无游戏读取，分项关闭仍领取已有援助', async () => {
    const f = fixture(); f.settings.alliance.enabled = false; await f.run(); assert.equal(f.state.reads.length, 0);
    f.settings.alliance.enabled = true;
    f.state.own = [{ reqId: '123', reqItemId: '橡胶圈', endTime: Math.floor(Date.now() / 1000) + 30, helper: { playerId: f.friend, nickname: '盟友' } }];
    await f.run(); assert.equal(f.state.stock.橡胶圈, 2); assert.equal(f.gifts().length + f.asks().length, 0);
  });
  await test('实际协议大整数ID、大小写昵称、允许/禁止材料与库存保留共同筛选', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.settings.alliance.memberKeywords = ['ALICE'];
    f.state.members[1].nickname = 'Alice-盟友'; f.settings.alliance.allowedMaterials = ['橡胶圈'];
    f.settings.alliance.stockReserve = 1; await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.stockReserve = 0; f.settings.alliance.blockedMaterials = ['橡胶圈']; await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.blockedMaterials = []; await f.run(); assert.equal(f.gifts().length, 1);
    assert.equal(f.gifts()[0].id, '9007199254750000'); assert.equal(f.ledger.snapshot().counters.guildAidGifts, 1);
  });
  await test('居民订单的同材料需求优先保留，不挪用帮助盟友', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true;
    f.state.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '橡胶圈', num: 1 }] }];
    await f.run(); assert.equal(f.gifts().length, 0); assert.match(f.reports.at(-1).reason, /订单预留/);
  });
  await test('人工互助与自动互助共享当日上限，切换模式不重置', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.settings.alliance.helpDailyLimit = 1;
    f.ledger.confirm(f.ledger.reserve({ guildAidGifts: 1 })); await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.mutualMode = 'exchange'; await f.run(); assert.equal(f.gifts().length, 0);
  });
  await test('求助先发一条，确认同材料收取后才用完剩余全局次数', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; f.settings.alliance.requestMaterials = ['橡胶圈'];
    f.state.askUsed = 17; await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.state.askUsed, 18);
    await f.run(); assert.equal(f.asks().length, 1, '未收回前不追加');
    f.state.own[0].helper = { playerId: f.friend, nickname: '盟友' };
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file });
    await f.run(); assert.equal(f.asks().length, 3); assert.equal(f.state.askUsed, 20);
    await f.run(); assert.equal(f.asks().length, 3);
  });
  await test('未选择求助材料只请求当前缺料，关闭赠送不影响求助', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; await f.run(); assert.equal(f.asks().length, 0);
    f.state.stock.橡胶圈 = 0; f.state.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '橡胶圈', num: 1 }] }];
    await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.gifts().length, 0);
  });
  await test('贡献模式固定当前赛季材料，未开放时不回退；材料自定义原值保留', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; f.settings.alliance.mutualMode = 'exchange'; f.settings.alliance.requestMaterials = ['木材'];
    assert.equal(allianceExchangeMaterial(f.player), '橡胶圈'); await f.run(); assert.equal(f.asks()[0].body.reqItemId, '橡胶圈');
    const g = fixture(); g.settings.alliance.autoAsk = true; g.settings.alliance.mutualMode = 'exchange'; g.player.worldId = '3002001';
    assert.equal(allianceExchangeMaterial(g.player), '珍珠胸针'); await g.run(); assert.equal(g.asks().length, 0);
    assert.deepEqual(f.settings.alliance.requestMaterials, ['木材']);
  });
  await test('主动求助不受赠送白黑名单限制，贡献帮助忽略隐藏白名单但仍守禁用和昵称', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, autoHelp: true, allowedMaterials: ['木材'], blockedMaterials: ['橡胶圈'], requestMaterials: ['橡胶圈'] });
    await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.gifts().length, 0);
    const g = fixture(); Object.assign(g.settings.alliance, { mutualMode: 'exchange', autoAsk: true, autoHelp: true, allowedMaterials: ['木材'], requestMaterials: ['木材'], blockedMaterials: ['橡胶圈'] });
    await g.run(); assert.equal(g.asks()[0].body.reqItemId, '橡胶圈'); assert.equal(g.gifts().length, 0);
    g.settings.alliance.blockedMaterials = []; g.settings.alliance.memberKeywords = ['不存在']; await g.run(); assert.equal(g.gifts().length, 0);
    g.settings.alliance.memberKeywords = []; await g.run(); assert.equal(g.gifts().length, 1);
    assert.deepEqual(g.settings.alliance.allowedMaterials, ['木材']); assert.deepEqual(g.settings.alliance.requestMaterials, ['木材']);
  });
  await test('求助未知跨重启阻断，实际计数与新增请求到达后恢复', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; f.settings.alliance.requestMaterials = ['橡胶圈']; f.state.failure = 'askUnknown';
    await f.run(); assert.equal(f.asks().length, 1); f.state.failure = ''; f.ledger = createUsageLedger('fixture-' + serial, { file: f.file });
    await f.run(); assert.equal(f.asks().length, 1);
    f.state.askUsed = 1; f.state.own.push({ reqId: '1001', reqItemId: '橡胶圈', endTime: Math.floor(Date.now() / 1000) + 60 });
    await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('赠送未知与明确拒绝分别保留/释放持久预算', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.state.failure = 'giftUnknown'; await f.run();
    assert.equal(f.gifts().length, 1); assert.equal(f.ledger.snapshot().counters.guildAidGifts, 1);
    f.state.failure = ''; f.ledger = createUsageLedger('fixture-' + serial, { file: f.file }); await f.run(); assert.equal(f.gifts().length, 1);
    const g = fixture(); g.settings.alliance.autoHelp = true; g.state.failure = 'giftReject'; await g.run(); assert.equal(g.ledger.snapshot().counters.guildAidGifts, 0);
    g.state.failure = ''; await g.run(); assert.equal(g.gifts().length, 2);
  });
  await test('读取期间改变参数或退出联盟时不继续发送', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true;
    f.state.before = name => { if (name === 'CounterInfoRequest') f.settings.alliance.stockReserve = 100; };
    await f.run(); assert.equal(f.gifts().length, 0);
    const g = fixture(); g.settings.alliance.autoAsk = true; g.settings.alliance.requestMaterials = ['橡胶圈'];
    g.state.before = name => { if (name === 'CounterInfoRequest') g.player.guildId = '999'; }; await g.run(); assert.equal(g.asks().length, 0);
  });
  await test('23:40后补齐剩余帮助次数，仍不放宽材料、昵称和保留库存', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.settings.alliance.helpDailyLimit = 3;
    const midnight = Math.floor((Date.now() + 28800000) / 86400000) * 86400000 - 28800000;
    const late = midnight + (23 * 3600 + 45 * 60) * 1000;
    f.client.serverClockOffsetMs = late - Date.now();
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file, now: () => Date.now() + f.client.serverClockOffsetMs });
    for (const row of f.state.requests) row.endTime = Math.floor(late / 1000) + 3600;
    f.state.stock.橡胶圈 = 5; f.settings.alliance.stockReserve = 2;
    f.settings.alliance.memberKeywords = ['不匹配']; await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.memberKeywords = []; await f.run(); assert.equal(f.gifts().length, 3); assert.equal(f.state.stock.橡胶圈, 2);
  });
  await test('募兵需求到用户上限或游戏上限即停止，缺料补产只准备当前订单', async () => {
    const s = settings(); Object.assign(s.alliance, { recruit: true, recruitProduction: true, recruitDailyLimit: 2 });
    const view = { doneToday: 1, day: 1, cityId: 1, maxNum: 10, nextRefreshTime: 200, checkedAt: 100, requirements: [{ id: '木材', need: 3, reserved: 2 }] };
    assert.deepEqual(allianceRecruitDemand(view, s), [{ source: 'guildRecruit', requirements: [{ id: '木材', num: 3 }], reserved: [{ id: '木材', num: 2 }] }]);
    assert.deepEqual(allianceRecruitDemand({ ...view, doneToday: 2 }, s), []);
    assert.deepEqual(allianceRecruitDemand({ ...view, maxNum: 1 }, s), []);
    assert.deepEqual(allianceRecruitDemand(view, s, { counters: { guildRecruit: 2 } }), []);
    s.alliance.recruitDailyLimit = 0; assert.equal(allianceRecruitDemand(view, s).length, 1);
    assert.deepEqual(allianceRecruitDemand({ ...view, nextRefreshTime: 50 }, s), []);
  });
  await test('联盟募兵未知请求在重建账本后阻止写入和备料，服务端计数可核销', async () => {
    const f = fixture(), now = Math.floor(Date.now() / 1000);
    Object.assign(f.settings.alliance, { recruit: true, recruitProduction: true, mutual: false });
    Object.assign(f.config.tables, { GuildOrderNumCfg: { data: [{ season: 2, playerLevel: 1, maxNum: 10 }] }, GuildOrderCfg: { data: [{ itemId: '木材' }] } });
    let count = 0, writes = 0, unknown = true;
    const request = f.client.request;
    f.client.request = async (name, body, response) => {
      if (name === 'GuildOrderRequest') return { order: { requirements: [{ type: 0, id: '木材', num: 2 }], nextRefreshTime: now + 86400 } };
      if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1, recommended: true }] };
      if (name === 'CounterInfoRequest') return { counters: [{ type: 'DAILY_FINISH_GUILD_ORDER', num: count }] };
      if (name === 'FinishGuildOrderRequest') { f.protocol[name].decode(f.protocol[name].encode(body).finish()); writes++; if (unknown) throw Error('回包未知'); count++; return { reward: { asset: [{ type: 1, id: '功勋', num: 10 }] } }; }
      return request(name, body, response);
    };
    await f.run(); assert.equal(writes, 1); assert.equal(f.ledger.snapshot().counters.guildRecruit, 1);
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file }); await f.run(); assert.equal(writes, 1);
    assert.deepEqual(await readAllianceRecruitDemand(f.client, f.protocol, f.config, f.player, f.settings, { ledger: f.ledger }), []);
    count = 1; unknown = false; await f.run(); await f.run(); assert.equal(writes, 2);
  });
  await test('科技自动升级遵守选择、单级回执、持久日上限与未发送释放', async () => {
    const f = fixture(), actual = loadConfig(); f.settings.alliance.mutual = false; f.settings.alliance.autoTech = true;
    f.settings.alliance.techIds = ['2010102']; f.settings.alliance.techDailyLimit = 1;
    for (const name of ['GuildTechCfg', 'TechUnlockCfg', 'AdditionAttrOverviewCfg']) f.config.tables[name] = actual.tables[name];
    let level = 0, writes = 0;
    const request = f.client.request;
    f.client.request = async (name, body, response) => {
      if (name === 'GuildTechInfoRequest') return { tech: [{ techId: 2010101, level: 10 }, { techId: 2010102, level }] };
      if (name === 'SeasonTaskStageRequest') return { stage: 0 };
      if (name === 'AllItemRequest') return { items: [{ itemId: '公会科技点', num: 1000000 }, { itemId: '联盟职级科技点', num: 1000000 }] };
      if (name === 'UpgradeGuildTechRequest') { f.protocol[name].decode(f.protocol[name].encode(body).finish()); writes++; level++; return { tech: { techId: body.techId, level } }; }
      return request(name, body, response);
    };
    await f.run(); assert.equal(writes, 1); await f.run(); assert.equal(writes, 1); assert.equal(f.ledger.snapshot().counters.allianceTech, 1);
    f.settings.alliance.techDailyLimit = 2;
    const connected = f.client.request;
    f.client.request = async (name, ...args) => { if (name === 'UpgradeGuildTechRequest') throw Object.assign(Error('尚未发送'), { notSent: true }); return connected(name, ...args); };
    await f.run(); assert.equal(f.ledger.snapshot().counters.allianceTech, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  console.log(`${passed}/${passed} 联盟自动化测试通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
