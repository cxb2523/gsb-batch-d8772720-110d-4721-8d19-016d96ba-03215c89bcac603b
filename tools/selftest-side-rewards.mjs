// 法旨战令、擂台赛每日礼包、漫剧、赛季宝箱：请求与回包都过真实协议编解码，使用隔离账本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-side-rewards-'));
process.env.CW_DATA_DIR = root;
process.env.CW_CONFIG_PACK = path.join(root, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { loadProtocol } = await import('../src/proto.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { automationControls } = await import('../src/automation-controls.mjs');
const { createUsageLedger, defaultSettings, importAutomationSettings, SETTINGS_FORMAT } = await import('../src/automation-settings.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { edictPassActivity } = await import('../src/seasonal-activities.mjs');
const { activityEntries, runActivity } = await import('../src/activities.mjs');
const { rewardSchedule } = await import('../src/reward-schedule.mjs');
const { CHEST_ROUND_LIMIT, COMIC_ROUND_LIMIT, claimComicDrama, claimTournamentDaily, openSeasonChests, rememberTournament, seasonChestAccess } = await import('../src/side-rewards.mjs');

process.on('uncaughtException', (error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

const protocol = loadProtocol();
let total = 0;
let serial = 0;
const test = async (name, fn) => {
  await fn();
  total++;
  console.log('通过：' + name);
};
const now = () => Math.floor(Date.now() / 1000);
const reward = { reward: { asset: [{ id: 'RUBY', num: 20 }] } };
const player = { level: 37, worldId: 2001001, worldOpenTime: now() - 86400 * 30 };
const prompt = (request) => Object.assign(new Error('服务器拒绝'), { prompt: { message: '服务器拒绝' }, request });

function fixture(handler, overrides = {}) {
  const client = new EventEmitter();
  client.connected = true;
  client.sent = [];
  client.request = async (name, body = {}, response) => {
    assert(protocol[name], name);
    protocol[name].decode(protocol[name].encode(body).finish());
    assert(protocol[response], '回包类型不存在：' + response);
    client.sent.push(name);
    const value = await handler(name, body, client);
    return protocol[response].decode(protocol[response].encode(value ?? {}).finish());
  };
  const output = [];
  const ledger = createUsageLedger('isolation', { file: path.join(root, ++serial + '.json') });
  const options = { player, ledger, enabled: () => true, report: (entry) => output.push(entry), scheduler: rewardSchedule(client), ...overrides };
  return { client, ledger, output, options };
}
const writes = (client, ...names) => client.sent.filter((name) => names.includes(name));

const mainTask = { taskId: 1, progress: 0, rewardClaimed: false };

await test('四项都有配置入口，免费项默认开启，消耗钥匙的赛季宝箱默认关闭', () => {
  const expected = { edictPass: true, comicDrama: true, tournamentDailyGift: true, seasonChest: false };
  const settings = defaultSettings();
  for (const [key, initial] of Object.entries(expected)) {
    assert.equal(automationTasks.find((task) => task.key === key)?.initial, initial, key);
    assert.equal(settings.schedule[key], initial, key);
    assert(automationControls.some((control) => control.key === 'schedule.' + key), key);
  }
});

await test('旧账号配置补默认值，已有的显式开关不被覆盖', () => {
  const saved = { ...defaultSettings(), schedule: { ...defaultSettings().schedule, comicDrama: false, seasonChest: true } };
  delete saved.schedule.edictPass;
  delete saved.schedule.tournamentDailyGift;
  const restored = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: saved });
  assert.equal(restored.schedule.comicDrama, false);
  assert.equal(restored.schedule.seasonChest, true);
  assert.equal(restored.schedule.edictPass, true);
  assert.equal(restored.schedule.tournamentDailyGift, true);
});

const edictConfig = { tables: { LinkageLSREdictBattlePassCfg: { data: [
  { rwdId: 1, reqScore: 10, freeReward: [['RUBY', 1]], payReward: [] },
  { rwdId: 2, reqScore: 20, freeReward: [['RUBY', 1]], payReward: [] },
  { rwdId: 3, reqScore: 999, freeReward: [['RUBY', 1]], payReward: [] }
] } } };
const edictFestival = () => [{ activityId: '9007199254740993', type: '捞尸人联动活动', startTime: now() - 100, endTime: now() + 100,
  subActivity: [{ subActivityType: 29, openTime: now() - 100, closeTime: now() + 100 }] }];

await test('法旨战令用类型 11 只领已达标档位，重复检查不重领，活动未开放不发请求', async () => {
  const got = [];
  const f = fixture((name, body) => {
    assert.equal(body.type, 11);
    if (name === 'BattlePassRequest') return { score: 25, activePay: false, endTime: now() + 100, got };
    assert.equal(name, 'BattlePassGotRewardRequest');
    got.push({ id: 1, freeGot: true, payGot: false }, { id: 2, freeGot: true, payGot: false });
    return reward;
  });
  const ctx = { ...f.options, key: 'edictPass', label: '法旨战令' };
  await edictPassActivity(f.client, edictConfig, ctx);
  assert.equal(writes(f.client, 'BattlePassGotRewardRequest').length, 0, '没有活动时不发请求');
  f.client.festivals = edictFestival();
  await edictPassActivity(f.client, edictConfig, ctx);
  await edictPassActivity(f.client, edictConfig, ctx);
  assert.equal(writes(f.client, 'BattlePassGotRewardRequest').length, 1);
  assert(f.output.some((entry) => entry.ok && entry.status === 'confirmed'));
});

await test('法旨战令在活动面板可手动执行', async () => {
  const got = [];
  const f = fixture((name) => {
    if (name === 'BattlePassRequest') return { score: 25, activePay: false, endTime: now() + 100, got };
    got.push({ id: 1, freeGot: true, payGot: false }, { id: 2, freeGot: true, payGot: false });
    return reward;
  });
  f.client.festivals = edictFestival();
  const entry = activityEntries(f.client, []).find((row) => row.taskKeys.includes('edictPass'));
  assert(entry, '活动面板缺少法旨战令');
  assert(entry.taskKeys.includes('edict'), '解符入口不应被替换');
  await runActivity(f.client, edictConfig, { activityId: entry.id, taskKey: 'edictPass', player, enabled: () => true, ledger: f.ledger, getSettings: () => null });
  assert.equal(writes(f.client, 'BattlePassGotRewardRequest').length, 1);
});

const tournamentConfig = { tables: { ModuleOpenCfg: { data: [{ moduleId: '巅峰擂台赛', playerLevel: 18 }] } } };
const yesterday = () => now() - 86400;

await test('擂台赛推送用真实协议解析，阶段更新生效', () => {
  const client = {};
  const open = protocol.SCTournamentOpen.decode(protocol.SCTournamentOpen.encode({ contestId: 7, state: { currentStageId: 3, nextMatchTimeId: 0, nextMatchTime: 0 }, lastClaimDailyGiftTime: 123, adjustHero: [] }).finish());
  rememberTournament(client, 'SCTournamentUpdate', { state: { currentStageId: 5 } });
  assert.equal(client.tournament, undefined, '未收到开放推送时不建立状态');
  rememberTournament(client, 'SCTournamentOpen', open);
  assert.deepEqual(client.tournament, { stageId: 3, lastClaimDailyGiftTime: 123 });
  rememberTournament(client, 'SCTournamentUpdate', { state: { currentStageId: 8 } });
  assert.equal(client.tournament.stageId, 8);
});

await test('擂台赛未开放、已结束、等级不足或今日已领时不发送', async () => {
  const f = fixture(() => reward);
  await claimTournamentDaily(f.client, tournamentConfig, f.options);
  for (const stageId of [1, 8]) {
    f.client.tournament = { stageId, lastClaimDailyGiftTime: yesterday() };
    await claimTournamentDaily(f.client, tournamentConfig, f.options);
  }
  f.client.tournament = { stageId: 3, lastClaimDailyGiftTime: now() };
  await claimTournamentDaily(f.client, tournamentConfig, f.options);
  f.client.tournament = { stageId: 3, lastClaimDailyGiftTime: yesterday() };
  await claimTournamentDaily(f.client, tournamentConfig, { ...f.options, player: { ...player, level: 17 } });
  assert.equal(f.client.sent.length, 0);
  assert.equal(f.output.length, 5);
});

await test('擂台赛每日礼包只领一次，领取后写回时间，发送前关闭不发送', async () => {
  const f = fixture((name) => {
    assert.equal(name, 'TournamentClaimDailyGiftRequest');
    return reward;
  });
  f.client.tournament = { stageId: 3, lastClaimDailyGiftTime: yesterday() };
  await claimTournamentDaily(f.client, tournamentConfig, { ...f.options, enabled: () => false });
  assert.equal(f.client.sent.length, 0);
  assert.equal(f.ledger.hasKey('tournament-daily:' + Math.floor((now() + 28800) / 86400)), false);
  await claimTournamentDaily(f.client, tournamentConfig, f.options);
  await claimTournamentDaily(f.client, tournamentConfig, f.options);
  assert.equal(f.client.sent.length, 1);
  assert.equal(Math.floor((f.client.tournament.lastClaimDailyGiftTime + 28800) / 86400), Math.floor((now() + 28800) / 86400));
  assert(rewardSchedule(f.client).nextCheck('tournamentDailyGift') > now());
});

await test('擂台赛结果未知保留记录不重发，明确被拒释放记录', async () => {
  let fail = new Error('timeout');
  const f = fixture(() => {
    if (fail) throw fail;
    return reward;
  });
  f.client.tournament = { stageId: 3, lastClaimDailyGiftTime: yesterday() };
  const key = 'tournament-daily:' + Math.floor((now() + 28800) / 86400);
  await claimTournamentDaily(f.client, tournamentConfig, f.options);
  assert.equal(f.ledger.keyRecords()[key].confirmed, false);
  assert.equal(f.output.at(-1).status, 'unknown');
  await claimTournamentDaily(f.client, tournamentConfig, f.options);
  assert.equal(f.client.sent.length, 1, '未知结果不能重发');

  fail = prompt('TournamentClaimDailyGiftRequest');
  const g = fixture(() => {
    throw fail;
  });
  g.client.tournament = { stageId: 3, lastClaimDailyGiftTime: yesterday() };
  await claimTournamentDaily(g.client, tournamentConfig, g.options);
  assert.equal(g.ledger.hasKey(key), false);
  assert.equal(g.output.at(-1).status, 'rejected');
});

const unlockAt = (offset) => {
  const shifted = new Date((now() + offset + 28800) * 1000).toISOString();
  return { unlockTime: shifted.slice(0, 10), unlockHours: shifted.slice(11, 19) };
};
const episode = (id, offset = -3600, unlockLevel = 1) => ({ id, partId: 1, unlockLevel, title: '第' + id + '集', reward: ['RUBY', 1], ...unlockAt(offset) });
const comicConfig = (rows) => ({ tables: { ModuleOpenCfg: { data: [{ moduleId: '漫剧', playerLevel: 12 }] }, ComicDramaCfg: { data: rows } } });

function comicServer(initial = {}) {
  const state = { comics: [], gotDaily: false, isRead: false, ...initial };
  return {
    state,
    handler(name, body) {
      if (name === 'MainTaskInfoRequest') return { task: mainTask, comicDrama: state };
      if (name === 'ComicDramaReadRequest') {
        if (!state.comics.some((row) => row.comicId === body.comicId)) state.comics.push({ comicId: body.comicId, state: false });
        state.isRead = true;
        return {};
      }
      if (name === 'ComicDramaGotRewardRequest') {
        const row = state.comics.find((item) => item.comicId === body.comicId);
        assert(row, '必须先观看再领奖');
        assert.equal(row.state, false, '不能重复领奖');
        row.state = true;
        return reward;
      }
      if (name === 'ComicDramaGotDailyRequest') {
        assert.equal(state.isRead, true, '当天观看后才能领每日奖励');
        assert.equal(state.gotDaily, false);
        state.gotDaily = true;
        return reward;
      }
      throw Error('意外请求 ' + name);
    }
  };
}

await test('漫剧新集先看后领，已看未领只领奖，未解锁不处理，每日奖励领一次', async () => {
  const server = comicServer({ comics: [{ comicId: 2, state: false }, { comicId: 3, state: true }] });
  const f = fixture(server.handler);
  const config = comicConfig([episode(1), episode(2), episode(3), episode(4, 3600), episode(5, -3600, 99)]);
  await claimComicDrama(f.client, config, f.options);
  assert.deepEqual(server.state.comics.filter((row) => row.state).map((row) => row.comicId).sort(), [1, 2, 3]);
  assert.equal(server.state.comics.some((row) => row.comicId === 4 || row.comicId === 5), false);
  assert.deepEqual(writes(f.client, 'ComicDramaReadRequest'), ['ComicDramaReadRequest'], '已看过的集不重复观看');
  assert.equal(server.state.gotDaily, true);
  const before = f.client.sent.length;
  await claimComicDrama(f.client, config, f.options);
  assert.equal(f.client.sent.length, before + 1, '第二次只读取状态');
  assert(rewardSchedule(f.client).nextCheck('comicDrama') > now());
});

await test('漫剧没有新集时重看最后一集领取每日奖励，已领时不再观看', async () => {
  const server = comicServer({ comics: [{ comicId: 1, state: true }, { comicId: 2, state: true }] });
  const f = fixture(server.handler);
  const config = comicConfig([episode(1), episode(2)]);
  await claimComicDrama(f.client, config, f.options);
  assert.equal(writes(f.client, 'ComicDramaReadRequest').length, 1);
  assert.equal(server.state.gotDaily, true);
  assert.equal(server.state.comics.find((row) => row.comicId === 2).state, true);
  const done = comicServer({ comics: [{ comicId: 1, state: true }], gotDaily: true });
  const g = fixture(done.handler);
  await claimComicDrama(g.client, comicConfig([episode(1)]), g.options);
  assert.deepEqual(g.client.sent, ['MainTaskInfoRequest']);
});

await test('漫剧每轮限量，下一轮继续，全部完成才延后检查', async () => {
  const rows = Array.from({ length: COMIC_ROUND_LIMIT + 3 }, (_, index) => episode(index + 1));
  const server = comicServer();
  const f = fixture(server.handler);
  await claimComicDrama(f.client, comicConfig(rows), f.options);
  assert.equal(writes(f.client, 'ComicDramaGotRewardRequest').length, COMIC_ROUND_LIMIT);
  assert.equal(rewardSchedule(f.client).due('comicDrama'), true, '还有未处理集时下一轮继续');
  await claimComicDrama(f.client, comicConfig(rows), f.options);
  assert.equal(writes(f.client, 'ComicDramaGotRewardRequest').length, rows.length);
  assert.equal(rewardSchedule(f.client).due('comicDrama'), false);
});

await test('漫剧领奖结果未知当天不重发，其他集继续，次日按服务器状态重试', async () => {
  const server = comicServer({ comics: [{ comicId: 1, state: false }, { comicId: 2, state: false }] });
  let failOnce = true;
  const f = fixture((name, body) => {
    if (name === 'ComicDramaGotRewardRequest' && body.comicId === 1 && failOnce) {
      failOnce = false;
      throw new Error('timeout');
    }
    return server.handler(name, body);
  });
  const config = comicConfig([episode(1), episode(2)]);
  await claimComicDrama(f.client, config, f.options);
  assert.equal(f.output.at(-1).status, 'unknown');
  rewardSchedule(f.client).clear('comicDrama');
  await claimComicDrama(f.client, config, f.options);
  assert.equal(writes(f.client, 'ComicDramaGotRewardRequest').length, 2, '未知集不重发，另一集照常领取');
  assert.equal(server.state.comics.find((row) => row.comicId === 2).state, true);
  const today = Math.floor((now() + 28800) / 86400);
  assert.equal(f.ledger.keyRecords()['comic-drama:1:' + today].confirmed, false);
  f.client.serverClockOffsetMs = 86400 * 1000;
  await claimComicDrama(f.client, config, f.options);
  assert.equal(server.state.comics.find((row) => row.comicId === 1).state, true, '次日服务器仍未领取时重试');
});

await test('漫剧观看没等到回包时以回读为准，被拒或未生效则停止领奖', async () => {
  const server = comicServer();
  const f = fixture((name, body) => {
    const value = server.handler(name, body);
    if (name === 'ComicDramaReadRequest') throw new Error('timeout');
    return value;
  });
  await claimComicDrama(f.client, comicConfig([episode(1)]), f.options);
  assert.equal(server.state.comics[0].state, true, '回读确认已观看后继续领奖');

  const refused = comicServer();
  const g = fixture((name, body) => {
    if (name === 'ComicDramaReadRequest') throw prompt(name);
    return refused.handler(name, body);
  });
  await claimComicDrama(g.client, comicConfig([episode(1)]), g.options);
  assert.equal(writes(g.client, 'ComicDramaGotRewardRequest').length, 0);
  assert.equal(g.output.at(-1).status, 'rejected');

  const lost = comicServer();
  const h = fixture((name, body) => {
    if (name === 'ComicDramaReadRequest') throw new Error('timeout');
    return lost.handler(name, body);
  });
  await claimComicDrama(h.client, comicConfig([episode(1)]), h.options);
  assert.equal(writes(h.client, 'ComicDramaGotRewardRequest').length, 0);
  assert.equal(h.output.at(-1).status, 'unknown');
});

await test('漫剧关闭开关后不再发送，等级不足不读取状态', async () => {
  const server = comicServer();
  let open = true;
  const f = fixture((name, body) => {
    const value = server.handler(name, body);
    if (name === 'ComicDramaGotRewardRequest') open = false;
    return value;
  });
  await claimComicDrama(f.client, comicConfig([episode(1), episode(2)]), { ...f.options, enabled: () => open });
  assert.equal(writes(f.client, 'ComicDramaGotRewardRequest').length, 1);
  assert.equal(writes(f.client, 'ComicDramaGotDailyRequest').length, 0);
  const g = fixture(() => assert.fail('不应发送'));
  await claimComicDrama(g.client, comicConfig([episode(1)]), { ...g.options, player: { ...player, level: 11 } });
  assert.equal(g.client.sent.length, 0);
});

const chestConfig = { tables: {
  GameplayOpenCfg: { data: [{ gameplay: '赛季交换宝箱', openDays: [0, 1, 1, 1] }] },
  SeasonChestKeyLibCfg: { data: ['赛季宝箱钥匙1', '赛季宝箱钥匙2', '赛季宝箱钥匙3'].map((key) => ({ libId: 1001, key })) },
  SeasonExchangeChestCfg: { data: [1, 2, 3, 4, 5].map((stage) => ({ chestId: 100 + stage, stage, name: '第' + stage + '箱' })) },
  ItemCfg: { data: [{ id: '赛季宝箱钥匙1', show_name: '水下藏品箱钥匙' }] }
} };

function chestServer({ stage = 1, cost = ['赛季宝箱钥匙1', '赛季宝箱钥匙1', '赛季宝箱钥匙2'], items = { 赛季宝箱钥匙1: 4, 赛季宝箱钥匙2: 2 } } = {}) {
  const server = {
    stage,
    cost,
    items: { ...items },
    opened: 0,
    handler(name) {
      if (name === 'SeasonChestInfoRequest') return { flow: { stage: server.stage, costItemId: server.cost } };
      if (name === 'AllItemRequest') return { items: Object.entries(server.items).map(([itemId, num]) => ({ itemId, num })) };
      if (name === 'SeasonChestOpenRequest') {
        for (const id of server.cost) {
          assert(server.items[id] > 0, '钥匙不足时不应发送');
          server.items[id]--;
        }
        server.opened++;
        server.stage = server.stage % 5 + 1;
        return { ...reward, flow: { stage: server.stage, costItemId: server.cost } };
      }
      throw Error('意外请求 ' + name);
    }
  };
  return server;
}
const chestCtx = (f) => ({ ...f.options, key: 'seasonChest', label: '赛季宝箱' });

await test('赛季宝箱开放条件来自配置：第一赛季关闭，开服时间缺失不开', () => {
  const time = now();
  assert.equal(seasonChestAccess(chestConfig, { ...player, worldId: 1001001 }, time).reason, '当前赛季未开放赛季宝箱');
  assert.equal(seasonChestAccess(chestConfig, { worldId: 2001001 }, time).reason, '无法确认开服时间');
  assert.equal(seasonChestAccess(chestConfig, { worldId: 0 }, time).reason, '无法确认当前赛季');
  assert.equal(seasonChestAccess(chestConfig, player, time).season, 2);
  assert.equal(seasonChestAccess(chestConfig, { ...player, worldId: 9001001 }, time).season, 9, '超过配置长度取最后一档');
});

await test('赛季宝箱重复钥匙按数量核对，钥匙够几箱开几箱，不足时不发送', async () => {
  const server = chestServer();
  const f = fixture(server.handler);
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, 2, '4 把钥匙1 和 2 把钥匙2 只够 2 箱');
  assert.deepEqual(server.items, { 赛季宝箱钥匙1: 0, 赛季宝箱钥匙2: 0 });
  assert.equal(server.stage, 3);
  assert.match(f.output.at(-1).reason, /钥匙不足：水下藏品箱钥匙 需要 2 现有 0/);
  assert(rewardSchedule(f.client).nextCheck('seasonChest') > now());
});

await test('赛季宝箱每轮限量，按阶段循环继续开启', async () => {
  const server = chestServer({ stage: 4, cost: ['赛季宝箱钥匙1', '赛季宝箱钥匙2', '赛季宝箱钥匙3'], items: { 赛季宝箱钥匙1: 8, 赛季宝箱钥匙2: 8, 赛季宝箱钥匙3: 8 } });
  const f = fixture(server.handler);
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, CHEST_ROUND_LIMIT);
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, 8, '钥匙用完为止，循环回到相同阶段也能继续');
});

await test('赛季宝箱消耗包含钥匙以外的道具时拒绝发送', async () => {
  const server = chestServer({ cost: ['赛季宝箱钥匙1', '钻石', '赛季宝箱钥匙2'], items: { 赛季宝箱钥匙1: 9, 赛季宝箱钥匙2: 9, 钻石: 9 } });
  const f = fixture(server.handler);
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, 0);
  assert.match(f.output.at(-1).reason, /钥匙以外/);
});

await test('赛季宝箱未开放赛季或发送前关闭不发送，并释放预留', async () => {
  const server = chestServer();
  const f = fixture(server.handler);
  await openSeasonChests(f.client, chestConfig, { ...chestCtx(f), player: { ...player, worldId: 1001001 } });
  assert.equal(f.client.sent.length, 0);
  let calls = 0;
  const g = fixture(server.handler);
  await openSeasonChests(g.client, chestConfig, { ...chestCtx(g), enabled: () => ++calls < 3 });
  assert.equal(server.opened, 0);
  assert.equal(writes(g.client, 'SeasonChestOpenRequest').length, 0);
  assert.equal(Object.values(g.ledger.keyRecords()).length, 0);
});

await test('赛季宝箱结果未知时静默期内不重发', async () => {
  const server = chestServer({ items: { 赛季宝箱钥匙1: 9, 赛季宝箱钥匙2: 9 } });
  const f = fixture((name) => {
    if (name === 'SeasonChestOpenRequest') throw new Error('timeout');
    return server.handler(name);
  });
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(f.output.at(-1).status, 'unknown');
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(writes(f.client, 'SeasonChestOpenRequest').length, 1);
  assert.match(f.output.at(-1).reason, /前次操作结果待确认/);
});

await test('赛季宝箱回包丢失但服务器已进入下一阶段：确认前次并继续开启', async () => {
  const server = chestServer({ items: { 赛季宝箱钥匙1: 9, 赛季宝箱钥匙2: 9 } });
  let lost = true;
  const f = fixture((name) => {
    const value = server.handler(name);
    if (name === 'SeasonChestOpenRequest' && lost) {
      lost = false;
      throw new Error('timeout');
    }
    return value;
  });
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, 1);
  assert.equal(f.output.at(-1).status, 'unknown');
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert(f.output.some((entry) => entry.reason === '已回读确认前次操作'));
  assert.equal(server.opened, 4, '已生效的一箱不重复计算，确认后用剩余钥匙继续');
  assert.equal(Object.values(f.ledger.keyRecords()).some((record) => !record.confirmed), false);
});

await test('赛季宝箱结果未知且静默期后阶段未变，释放记录重新开启', async () => {
  const server = chestServer({ items: { 赛季宝箱钥匙1: 2, 赛季宝箱钥匙2: 1 } });
  let block = true;
  const f = fixture((name) => {
    if (name === 'SeasonChestOpenRequest' && block) throw new Error('timeout');
    return server.handler(name);
  });
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, 0);
  block = false;
  f.client.serverClockOffsetMs = 10 * 60 * 1000 + 1000;
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(server.opened, 1);
  assert.equal(Object.values(f.ledger.keyRecords()).some((record) => !record.confirmed), false);
});

await test('赛季宝箱明确被拒释放记录并停止本轮', async () => {
  const server = chestServer();
  const f = fixture((name) => {
    if (name === 'SeasonChestOpenRequest') throw prompt(name);
    return server.handler(name);
  });
  await openSeasonChests(f.client, chestConfig, chestCtx(f));
  assert.equal(writes(f.client, 'SeasonChestOpenRequest').length, 1);
  assert.equal(f.output.at(-1).status, 'rejected');
  assert.equal(Object.values(f.ledger.keyRecords()).length, 0);
});

await test('四项经过真实整轮入口；赛季宝箱默认关闭时不读取也不开箱', async () => {
  const comic = comicServer();
  const chest = chestServer();
  const got = [];
  const f = fixture((name, body) => {
    if (name.startsWith('Comic') || name === 'MainTaskInfoRequest') return comic.handler(name, body);
    if (name === 'TournamentClaimDailyGiftRequest') return reward;
    if (name === 'BattlePassRequest') return { score: 25, activePay: false, endTime: now() + 100, got };
    if (name === 'BattlePassGotRewardRequest') {
      got.push({ id: 1, freeGot: true, payGot: false }, { id: 2, freeGot: true, payGot: false });
      return reward;
    }
    return chest.handler(name);
  });
  f.client.festivals = edictFestival();
  f.client.tournament = { stageId: 3, lastClaimDailyGiftTime: yesterday() };
  const config = { tables: { ...tournamentConfig.tables, ...comicConfig([episode(1)]).tables, ...edictConfig.tables, ...chestConfig.tables,
    ModuleOpenCfg: { data: [{ moduleId: '巅峰擂台赛', playerLevel: 18 }, { moduleId: '漫剧', playerLevel: 12 }] } } };
  const settings = defaultSettings();
  settings.loop.world = settings.loop.dailies = settings.loop.tasks = false;
  const entries = [];
  const run = (keys) => runLoop(f.client, protocol, { config, player, rounds: 1, allowMutate: true, isEnabled: (key) => keys.includes(key) && settings.schedule[key] === true, getSettings: () => settings, usageLedger: f.ledger, onStep: (entry) => entries.push(entry) });
  await run(['edictPass', 'comicDrama', 'tournamentDailyGift', 'seasonChest']);
  for (const key of ['edictPass', 'comicDrama', 'tournamentDailyGift']) assert(entries.some((entry) => entry.taskKey === key && entry.ok), key);
  assert.equal(writes(f.client, 'SeasonChestInfoRequest', 'SeasonChestOpenRequest').length, 0, '默认关闭不应触碰赛季宝箱');
  settings.schedule.seasonChest = true;
  await run(['seasonChest']);
  assert.equal(chest.opened, 2);
  assert(entries.some((entry) => entry.taskKey === 'seasonChest' && entry.ok));
});

await test('控制台在登录时记住擂台赛推送', async () => {
  const { GameClient } = await import('../src/client.mjs');
  const { saveStore } = await import('../src/accounts.mjs');
  const { createConsole } = await import('../src/server.mjs');
  const live = new Set();
  const push = protocol.SCTournamentOpen.decode(protocol.SCTournamentOpen.encode({ contestId: 7, state: { currentStageId: 4, nextMatchTimeId: 0, nextMatchTime: 0 }, lastClaimDailyGiftTime: 456, adjustHero: [] }).finish());
  Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
  GameClient.prototype.connect = async function () {
    live.add(this);
    this.emit('message', { name: 'SCTournamentOpen', body: push });
    return { playerInfo: { nickname: '测试', level: 20 } };
  };
  GameClient.prototype.send = () => {};
  GameClient.prototype.request = async () => ({});
  GameClient.prototype.sendWatch = async () => ({});
  GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); };
  saveStore({ activeId: 'a', accounts: [{ id: 'a', url: 'ws://invalid.invalid', login: {}, automation: {
    enabled: false, everySeconds: 3600, tasks: Object.fromEntries(automationTasks.map((task) => [task.key, false])) } }] });
  const app = createConsole({ port: 0 });
  try {
    await app.listen();
    await fetch('http://127.0.0.1:' + app.server.address().port + '/api/overview?account=a', { signal: AbortSignal.timeout(5000) }).then((reply) => reply.text());
    const client = app.sessions.get('a')?.client;
    assert(client?.connected, '未建立连接');
    assert.deepEqual(client.tournament, { stageId: 4, lastClaimDailyGiftTime: 456 });
    client.emit('message', { name: 'SCTournamentUpdate', body: { state: { currentStageId: 8 } } });
    assert.equal(client.tournament.stageId, 8);
  } finally {
    await app.close();
  }
});

fs.rmSync(root, { recursive: true, force: true });
console.log('漫剧、擂台赛、赛季宝箱与法旨战令专项 ' + total + '/' + total + ' 通过');
