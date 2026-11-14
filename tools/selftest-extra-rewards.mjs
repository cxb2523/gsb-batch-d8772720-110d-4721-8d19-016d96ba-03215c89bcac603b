// Free reward claims: rules come from the v75 client, names are checked against the real protocol.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../src/proto.mjs';
import { claimExtraRewards, extraRewardKeys, gameplayOpenDay, seasonRows, seasonTaskReady, worldBossRewardLevel, worldOnlineState } from '../src/extra-rewards.mjs';
import { redPointTasks, rewardSchedule } from '../src/reward-schedule.mjs';
import { automationTasks, taskSettings } from '../src/automation.mjs';

const protocol = loadProtocol();
for (const [type, task] of Object.entries(redPointTasks)) {
  assert(protocol.RedPointType[type], '红点类型 ' + type + ' 不在协议内');
  assert(automationTasks.some(row => row.key === task), task);
}
assert.equal(protocol.RedPointType.CROSS_RANK_REWARD, 33);
assert.equal(protocol.RedPointType.GUILD_AID_NEW, 43);
assert.equal(protocol.RedPointType.TRADE_TASK, 53);
for (const key of extraRewardKeys) assert.equal(taskSettings({})[key], true, key + ' 是免费领奖，默认开启');
for (const key of ['guildAidHelp', 'treasureLoot', 'heroGrowth', 'stageAuto']) assert.equal(taskSettings({})[key], false, key + ' 会消耗资源，必须默认关闭');

function fakeClient(handlers, connected = true) {
  const client = new EventEmitter();
  client.connected = connected;
  client.serverClockOffsetMs = 0;
  client.calls = [];
  client.request = async (name, body, response) => {
    assert(protocol[name], '协议没有 ' + name);
    for (const reply of [response].flat()) assert(protocol[reply], '协议没有 ' + reply);
    protocol[name].encode(body ?? {}).finish();
    client.calls.push([name, body]);
    const handler = handlers[name];
    if (!handler) throw new Error('未预期的请求 ' + name);
    return typeof handler === 'function' ? handler(body, client) : handler;
  };
  return client;
}
const reward = (id, num) => ({ reward: { asset: [{ type: 0, id, num }] } });
const base = { level: 30, guildId: 2004001001004, worldOpenTime: 1000 };
const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }, { moduleId: '海商王', playerLevel: 17 }] },
  GameplayOpenCfg: { data: [{ gameplay: '国战', openDays: [2, 1] }] },
  WorldOnlineRwdCfg: { data: [{ stage: 1, seconds: 1, reward: [['汽油', 7000]] }, { stage: 2, seconds: 60, reward: [['RUBY', 30]] }] },
  TradeGuildTaskCfg: { data: [
    { id: 1, day: 1, taskType: 0, tragetCount: 100 }, { id: 2, day: 1, taskType: 1, tragetCount: 5 },
    { id: 3, day: 2, taskType: 0, tragetCount: 100 }, { id: 4, day: 9, taskType: 0, tragetCount: 1 },
  ] },
  HeroRecruitTaskCfg: { data: [{ season: 1, id: 1, times: 10 }, { season: 1, id: 2, times: 20 }, { season: 99, id: 1, times: 1 }] },
  SeasonTaskCfg: { data: [{ season: 1, stage: 1, personTarget: 20, teamTarget: 100 }, { season: 1, stage: 2, personTarget: 50, teamTarget: 500 }] },
  WorldBossDamageRewardCfg: { data: [{ season: 1, bossId: 1, level: 1, damage: 100 }, { season: 1, bossId: 1, level: 2, damage: 200 },
    { season: 1, bossId: 2, level: 1, damage: 1 }] },
  MuseumAchievementCfg: { data: [{ score: 100, rewards: [['藏品橙20碎片', 10]] }, { score: 200, rewards: [] }, { score: 900, rewards: [] }] },
  BuildingUnlockCfg: { data: [{ buildingType: '博物馆', buildingId: '1博物馆' }] },
} };

const seasonPlayer = { ...base, worldId: 2_001_000_000 + 7 };
assert.equal(Math.floor(seasonPlayer.worldId / 1e6) % 1000, 1);
assert.deepEqual(seasonRows(config, 'HeroRecruitTaskCfg', seasonPlayer).map(row => row.id), [1, 2], '不能用未来赛季的配置');
assert.equal(gameplayOpenDay(config, seasonPlayer, '国战'), 2);

// ---- 世界在线奖励时间窗 ----
const day = 86400 * 20000;
const beijing = hour => day - 8 * 3600 + hour * 3600;
const opened = { ...seasonPlayer, worldOpenTime: beijing(0) - 86400 * 5 };
const at = (stage, last, now, player = opened) => worldOnlineState(config, player, stage === null ? null : { num: { low: stage, high: 0 }, updateTime: last }, now);
assert.equal(at(0, 0, beijing(19)).status, 'waiting', '20 点前不开放');
assert.equal(at(0, 0, beijing(19)).at, beijing(20) + 1);
assert.equal(at(0, 0, beijing(20)).status, 'waiting', '与客户端相同：恰好 20:00 还未开放');
assert.equal(at(null, 0, beijing(20) + 5).status, 'ready', '服务端未返回计数时按 0 档处理');
assert.equal(at(0, 0, beijing(20) + 5).next.stage, 1);
assert.equal(at(1, beijing(20) + 5, beijing(20) + 30).status, 'waiting', '每档从上次领取开始计时');
assert.equal(at(1, beijing(20) + 5, beijing(20) + 30).at, beijing(20) + 65);
assert.equal(at(1, beijing(20) + 5, beijing(20) + 65).status, 'ready');
assert.equal(at(1, beijing(21), beijing(22)).status, 'waiting', '21:00 后领过则今天结束');
assert.equal(at(1, beijing(20) + 5, beijing(22)).status, 'ready', '21:00 前的计时仍可在之后领取');
assert.equal(at(2, beijing(20), beijing(20) + 500).reason, '今日 2 档已全部领完');
assert.equal(at(2, beijing(20), beijing(20) + 500).at, beijing(44) + 1);
const newWorld = { ...seasonPlayer, worldOpenTime: beijing(1) };
assert.equal(at(0, 0, beijing(21), newWorld).at, beijing(44) + 1, '国战未开放的新区要等到开放日 20:00');

// ---- 领取流程 ----
const run = async (client, player, keys, scheduler) => {
  const reports = [];
  const allowed = key => keys.includes(key);
  await claimExtraRewards(client, config, player, allowed, entry => reports.push(entry), scheduler);
  return reports;
};

const now = () => Math.floor(Date.now() / 1000);
const onlinePlayer = { ...seasonPlayer, worldOpenTime: now() - 86400 * 9 };
const onlineDue = worldOnlineState(config, onlinePlayer, { num: 0, updateTime: 0 }, now());
if (onlineDue.status === 'ready') {
  let stage = 0;
  const client = fakeClient({
    CounterInfoRequest: () => ({ counters: [{ type: 'DAILY_WORLD_ONLINE_RWD', num: { low: stage, high: 0 }, updateTime: 0 }] }),
    GotWorldOnlineRwdRequest: () => { stage = 1; return reward('汽油', 7000); },
  });
  const reports = await run(client, onlinePlayer, ['worldOnline']);
  assert(reports[0].ok, JSON.stringify(reports));
  assert.match(reports[0].label, /第 1 档/);
}
{
  // 服务端拒绝时要报告失败，不能当作已领取。
  const prompt = Object.assign(new Error('server prompt: closed'), { prompt: {} });
  const client = fakeClient({
    CounterInfoRequest: { counters: [] },
    GotWorldOnlineRwdRequest: () => { throw prompt; },
  });
  const realNow = Date.now;
  Date.now = () => beijing(20) * 1000 + 5000;
  try {
    const reports = await run(client, { ...seasonPlayer, worldOpenTime: beijing(0) - 86400 * 9 }, ['worldOnline']);
    assert.equal(reports[0].ok, false);
    assert.match(reports[0].error, /closed/);
  } finally { Date.now = realNow; }
}
{
  // 回包丢失但计数已前进，算领取成功；计数未前进算失败。
  const realNow = Date.now;
  Date.now = () => beijing(20) * 1000 + 5000;
  const player = { ...seasonPlayer, worldOpenTime: beijing(0) - 86400 * 9 };
  try {
    let stage = 0;
    const lost = fakeClient({
      CounterInfoRequest: () => ({ counters: [{ type: 'DAILY_WORLD_ONLINE_RWD', num: stage, updateTime: 0 }] }),
      GotWorldOnlineRwdRequest: () => { stage = 1; throw new Error('timeout'); },
    });
    assert.equal((await run(lost, player, ['worldOnline']))[0].ok, true);
    const stuck = fakeClient({
      CounterInfoRequest: { counters: [{ type: 'DAILY_WORLD_ONLINE_RWD', num: 0, updateTime: 0 }] },
      GotWorldOnlineRwdRequest: () => { throw new Error('timeout'); },
    });
    assert.equal((await run(stuck, player, ['worldOnline']))[0].ok, false);
  } finally { Date.now = realNow; }
}
{
  const client = fakeClient({});
  assert.match((await run(client, { ...seasonPlayer, level: 10 }, ['worldOnline']))[0].reason, /16 级开放/);
  assert.equal(client.calls.length, 0, '等级不足时不发请求');
}
{
  const client = fakeClient({
    TradeTaskRequest: { guildTask: { profit: 150, tradeTimes: 6, gotTaskId: [1] } },
    TradeGotTaskRequest: ({ day: taskDay }) => ({ ...reward('RUBY', 100), gotTaskId: taskDay === 1 ? [1, 2] : [1, 2, 3] }),
  });
  client.tradeActivity = { startTime: now() - 86400, endTime: now() + 86400 };
  const reports = await run(client, seasonPlayer, ['tradeTasks']);
  assert.deepEqual(client.calls.filter(([name]) => name === 'TradeGotTaskRequest').map(([, body]) => body.day), [1, 2], '按天领取，未到的天不领');
  assert.equal(reports.filter(entry => entry.ok).length, 2);
  const closed = fakeClient({});
  assert.match((await run(closed, seasonPlayer, ['tradeTasks']))[0].reason, /未开放/);
}
{
  const today = now();
  const client = fakeClient({ GuildInfoRequest: { gotTitle: 3, gotTitleTime: today - 86400 * 2 }, GotGuildTitleRewardRequest: reward('RUBY', 50) });
  assert.equal((await run(client, seasonPlayer, ['guildTitleReward']))[0].ok, true);
  const done = fakeClient({ GuildInfoRequest: { gotTitle: 3, gotTitleTime: today } });
  assert.match((await run(done, seasonPlayer, ['guildTitleReward']))[0].reason, /已领取/);
  assert(!done.calls.some(([name]) => name === 'GotGuildTitleRewardRequest'));
  const solo = fakeClient({});
  assert.match((await run(solo, { ...seasonPlayer, guildId: 0 }, ['guildTitleReward']))[0].reason, /未加入联盟/);
}
{
  const helper = { playerId: { low: 9, high: 0 } };
  const client = fakeClient({ MyGuildAidRequest: { aids: [{ reqId: 1, helper }] }, GotMyGuildAidRequest: reward('木材', 1) });
  assert.equal((await run(client, seasonPlayer, ['guildAidCollect']))[0].ok, true);
  const waiting = fakeClient({ MyGuildAidRequest: { aids: [{ reqId: 1 }] } });
  assert.equal((await run(waiting, seasonPlayer, ['guildAidCollect']))[0].skipped, true, '没人响应时不领取');
}
{
  let gotId = 0;
  const client = fakeClient({
    RecruitInfoRequest: { hero: { task: { times: 25, gotId: 0 } } },
    GotHeroRecruitTaskRequest: () => { gotId += 1; return { gotId, reward: reward('抽卡券', 1).reward }; },
  });
  const reports = await run(client, seasonPlayer, ['heroRecruitRewards']);
  assert.equal(reports.filter(entry => entry.ok).length, 2);
  assert.match(reports.at(-1).reason, /已领完/);
  const short = fakeClient({ RecruitInfoRequest: { hero: { task: { times: 5, gotId: 0 } } } });
  assert.match((await run(short, seasonPlayer, ['heroRecruitRewards']))[0].reason, /5\/10/);
}
{
  const tiers = config.tables.SeasonTaskCfg.data;
  assert.deepEqual(seasonTaskReady([{ stage: 1, personProgress: 20, teamProgress: 0 }], [], tiers).map(row => row.stage), [1]);
  assert.deepEqual(seasonTaskReady([{ stage: 1, personProgress: 20, teamProgress: 0 }], [{ stage: 1, gotPerson: true }], tiers), []);
  assert.deepEqual(seasonTaskReady([{ stage: 1, personProgress: 0, teamProgress: 100 }], [{ stage: 1, gotPerson: true }], tiers).map(row => row.stage), [1]);
  const client = fakeClient({
    SeasonTaskRequest: { task: [{ stage: 2, personProgress: 50, teamProgress: 0 }], got: [] },
    GotSeasonTaskRequest: { got: [{ stage: 2, gotPerson: true }], ...reward('抽卡券', 10) },
  });
  assert.equal((await run(client, seasonPlayer, ['seasonTasks']))[0].ok, true);
  const unconfirmed = fakeClient({ SeasonTaskRequest: { task: [{ stage: 2, personProgress: 50, teamProgress: 0 }], got: [] }, GotSeasonTaskRequest: { got: [] } });
  assert.equal((await run(unconfirmed, seasonPlayer, ['seasonTasks']))[0].ok, false);
}
{
  const client = fakeClient({ GetDailyRewardRequest: reward('RUBY', 10) });
  const scheduler = rewardSchedule(client);
  assert.match((await run(client, seasonPlayer, ['crossRankDaily'], scheduler))[0].reason, /没有可领取/);
  assert(scheduler.nextCheck('crossRankDaily'), '没有红点时延后检查');
  client.emit('message', { name: 'SCRedPoint', body: { redPoint: [{ type: 33, num: 1 }] } });
  assert.equal(scheduler.nextCheck('crossRankDaily'), null, '红点要立刻触发检查');
  assert.equal((await run(client, seasonPlayer, ['crossRankDaily'], scheduler))[0].ok, true);
  assert.equal(scheduler.redPoint(33), 0, '领取后清除红点，避免重复请求');
  client.emit('message', { name: 'SCRedPoint', body: { redPoint: [{ type: 33 }] } });
  assert.equal(scheduler.redPoint(33), 0, '不带 num 的红点表示已清除');
}
{
  const tiers = seasonRows(config, 'WorldBossDamageRewardCfg', seasonPlayer).filter(row => row.bossId === 1);
  assert.equal(worldBossRewardLevel({ bestDamage: 250, gotRewardLevel: 0 }, tiers), 2);
  assert.equal(worldBossRewardLevel({ bestDamage: 250, gotRewardLevel: 2 }, tiers), 0);
  assert.equal(worldBossRewardLevel({ bestDamage: 50, gotRewardLevel: 0 }, tiers), 0);
  const client = fakeClient({ WorldBossInfoRequest: { info: { bossId: 1, bestDamage: { low: 150, high: 0 }, gotRewardLevel: 0 } }, WorldBossGetDamageRewardRequest: reward('GOLD', 2000) });
  assert.match((await run(client, seasonPlayer, ['worldBossDamage']))[0].label, /第 1 档/);
  const closed = fakeClient({ WorldBossInfoRequest: { info: { bossId: 0 } } });
  assert.equal((await run(closed, seasonPlayer, ['worldBossDamage']))[0].skipped, true);
}
{
  const claimed = [];
  const client = fakeClient({
    PassStageStateRequest: { isOver: false, maxOpenStage: 3 },
    PassStageRequest: { rwdStage: [1, 3] },
    PassStageGotRewardRequest: ({ stage }) => { claimed.push(stage); return reward('RUBY', 1); },
  });
  assert.equal((await run(client, seasonPlayer, ['passStageRewards'])).filter(entry => entry.ok).length, 2);
  assert.deepEqual(claimed, [1, 3]);
  const over = fakeClient({ PassStageStateRequest: { isOver: true, maxOpenStage: 3 } });
  assert.equal((await run(over, seasonPlayer, ['passStageRewards']))[0].skipped, true);
}
{
  const client = fakeClient({
    OnWaterRequest: { building: [{ buildingId: '1博物馆', level: 1 }] },
    MuseumInfoRequest: { uncollectedRevenue: { low: 30, high: 0 }, topPopularity: { low: 250, high: 0 }, claimedAchievements: [{ low: 100, high: 0 }] },
    MuseumCollectRevenueRequest: { collected: { low: 30, high: 0 } },
    MuseumClaimAchievementRequest: reward('RUBY', 5),
  });
  const reports = await run(client, seasonPlayer, ['museumRevenue', 'museumAchievements']);
  assert.match(reports[0].label, /\+30/);
  assert.deepEqual(client.calls.filter(([name]) => name === 'MuseumClaimAchievementRequest').map(([, body]) => body.popularityThreshold), [200], '只领已达到且未领的档位');
  const unbuilt = fakeClient({ OnWaterRequest: { building: [] } });
  assert.equal((await run(unbuilt, seasonPlayer, ['museumRevenue', 'museumAchievements'])).every(entry => entry.skipped), true);
  assert(!unbuilt.calls.some(([name]) => name === 'MuseumInfoRequest'), '未建成时不读博物馆');
}
{
  // 一项失败不能挡住后面的领奖。
  const client = fakeClient({ RecruitInfoRequest: () => { throw new Error('boom'); }, SeasonTaskRequest: { task: [], got: [] } });
  const scheduler = rewardSchedule(client);
  const reports = await run(client, seasonPlayer, ['heroRecruitRewards', 'seasonTasks'], scheduler);
  assert.equal(reports[0].ok, false);
  assert.equal(reports[1].skipped, true);
  assert(scheduler.nextCheck('heroRecruitRewards'), '失败后要延后重试');
}
for (const name of ['GotRewardResponse', 'OkResponse', 'GotRecruitTaskResponse', 'TradeGotTaskResponse', 'GotSeasonTaskResponse', 'PassStageGotRewardResponse', 'MuseumCollectRevenueResponse', 'SCRedPoint', 'SCNewGuildAidAsk', 'SCTreasureLootRefresh']) {
  assert(protocol[name], name);
}
console.log('extra rewards ok: online window, red points, trade days, season tiers, unconfirmed claims, failure isolation');
