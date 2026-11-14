import assert from 'node:assert/strict';
import { claimWeekly } from '../src/activities.mjs';
import { claimCollection } from '../src/collections.mjs';
import { sweepTrials } from '../src/trials.mjs';

// Start three seconds before Beijing midnight; advance the server clock without sleeping.
function clock() {
  let time = Date.UTC(2026, 10, 2, 15, 59, 57) / 1000;
  const holds = new Map();
  return {
    now: () => time,
    advance: seconds => { time += seconds; },
    due: key => !(holds.get(key) > time),
    defer: (key, until) => holds.set(key, until),
    clear: key => holds.delete(key),
    nextDay: () => (Math.floor((time + 28800) / 86400) + 1) * 86400 - 28800,
  };
}

async function weeklyPack() {
  const schedule = clock(), calls = [], reports = [];
  const end = schedule.now() + 10, row = { type: 4, startTime: schedule.now() - 100, endTime: end };
  let claimed = 0, echoClaim = true;
  const client = {
    get serverClockOffsetMs() { return schedule.now() * 1000 - Date.now(); },
    async request(name) {
      calls.push(name);
      if (name === 'WeekInfoRequest') return { activityTime: [row] };
      assert.equal(name, 'WeekLotteryInfoRequest');
      return { gift: [{ giftId: 1000, gotTimes: claimed }] };
    },
    async sendWatch(name) { assert.equal(name, 'WeekLotteryFreePackRequest'); calls.push(name); if (echoClaim) claimed++; },
  };
  const config = { tables: { WeekLotteryPackCfg: { data: [{ packId: 1000, limitedTimes: 1, price: 0 }] } } };
  const run = () => claimWeekly(client, config, key => key === 'weekGift', e => reports.push(e), 15, schedule);
  await run();
  assert.equal(claimed, 1);
  calls.length = 0;
  await run();
  assert.deepEqual(calls, [], '礼包已领，重复普通轮次不再查询周活动');
  schedule.advance(3);
  await run();
  assert.deepEqual(calls, ['WeekInfoRequest', 'WeekLotteryInfoRequest'], '跨日重新核对；未重置的礼包不能再领');
  calls.length = 0;
  schedule.advance(7);
  row.startTime = end;
  row.endTime = end + 86400;
  claimed = 0;
  echoClaim = false;
  await run();
  assert(reports.at(-1).error.includes('未确认'));
  assert(schedule.due('weekGift'), '未确认领取，不能标为已领');
  echoClaim = true;
  await run();
  assert.equal(claimed, 1, '活动换期且服务器恢复次数后能领');
}

async function newbieLogin() {
  const schedule = clock(), claimed = [];
  const client = {
    get serverClockOffsetMs() { return schedule.now() * 1000 - Date.now(); },
    newbieActivity: { startTime: schedule.now() - 1000, loginDays: 1, loginRewardDay: [] },
    async request(name, body) { assert.equal(name, 'DrawNewbieLoginRewardRequest'); claimed.push(body.day); return {}; },
  };
  const run = () => claimCollection(client, {}, 'newbieLogin', () => true, () => {}, schedule);
  await run();
  await run();
  assert.deepEqual(claimed, [1]);
  client.newbieActivity.loginDays = 2;
  schedule.clear('newbieLogin'); // SCNewbieActivityUpdate
  await run();
  assert.deepEqual(claimed, [1, 2], '新推送带来可领天数，立即重新执行');
  schedule.advance(3);
  await run();
  assert.deepEqual(claimed, [1, 2], '跨日只按服务端已登录天数领奖');
}

async function trials() {
  const schedule = clock(), reads = [], sweeps = [];
  const raids = [{ raidId: 1, passedStage: 1001, buySweepTimes: 1 }, { raidId: 2, passedStage: 0, buySweepTimes: 0 }];
  const client = {
    async request(name, { raidId }) {
      assert.equal(name, 'TrialRaidInfoRequest');
      reads.push(raidId);
      return { raid: { ...raids.find(r => r.raidId === raidId) } };
    },
    async sendWatch(name, { raidId, useAdvCard }) {
      assert.equal(name, 'TrialRaidBuySweepRequest');
      assert.equal(useAdvCard, false);
      sweeps.push(raidId);
      raids.find(r => r.raidId === raidId).buySweepTimes++;
    },
  };
  const config = { tables: {
    TrialRaidBuySweepCfg: { data: [{ buyTimes: 1, costRuby: 0 }, { buyTimes: 2, costRuby: 50 }] },
    TrialRaidCfg: { data: raids },
    TrialRaidStageCfg: { data: raids.map(r => ({ raidId: r.raidId, stageId: r.raidId * 1000 + 1, openLevel: 14 })) },
  } };
  const run = () => sweepTrials(client, config, 15, () => true, e => assert(e.ok), schedule);
  await run();
  reads.length = 0;
  raids[1].passedStage = 2001;
  await run();
  assert.deepEqual(reads, [2, 2], '已用尽的副本不再读，刚首通的副本仍能扫荡');
  assert.deepEqual(sweeps, [2]);
  reads.length = 0;
  await run();
  assert.deepEqual(reads, []);
  raids[0].buySweepTimes = 0;
  schedule.clear('trialSweep:1'); // SCTrialRaidUpdate
  await run();
  assert.deepEqual(sweeps, [2, 1], '数量推送清除对应副本缓存');
  schedule.advance(3);
  raids[1].buySweepTimes = 0;
  await run();
  assert.deepEqual(sweeps, [2, 1, 2], '跨日重新确认次数，只消耗服务端恢复的免费次数');
}

export async function testActivitySchedule() {
  await weeklyPack();
  await newbieLogin();
  await trials();
}
