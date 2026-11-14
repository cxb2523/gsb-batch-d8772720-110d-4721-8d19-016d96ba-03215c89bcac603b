import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDailies, surveyDailies } from '../src/dailies.mjs';
import { runLoop } from '../src/loop.mjs';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';

const boundaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-daily-boundary-'));
let boundarySequence = 0;
function boundaryGuard(client) {
  const settings = defaultSettings();
  settings.dailies.enabled = true;
  settings.resources.allowDiamonds = true;
  settings.resources.diamondDailyLimit = 100;
  settings.resources.diamondThreshold = 0;
  settings.gold.times = 10;
  const ledger = createUsageLedger('模拟日常边界账号', { file: path.join(boundaryDirectory, 'usage-' + (++boundarySequence) + '.json') });
  const guard = createActionGuard(client, () => settings, ledger);
  return { ledger, beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel };
}

const player = { playerId: 900, level: 17, worldId: 2004001001, vip: { vipLevel: 1 } };
const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }] },
  WorldPirateCfg: { data: [1, 2].flatMap(type => [1, 2, 3].map(level => ({
    season: '4', type, level, showName: '海盗' + type,
  }))) },
  PirateParamCfg: { data: [{ paramName: '每日野怪扫荡次数', paramValue: 10 }] },
  VipLevelCfg: { data: [{ level: 1, effects: [['野怪扫荡次数', 2]] }] },
  MonthCardCfg: { data: [{ id: '普通月卡', effectList: [] }, { id: '高级月卡', effectList: [] }] },
} };
const protocol = { ArenaChallengeRequest: true, ArenaChallengeResponse: true, PirateSweepRequest: true };
const bigId = { low: 1, high: 2097152, unsigned: false };
const exactId = id => typeof id === 'object' ? String((BigInt(id.high) << 32n) + BigInt(id.low >>> 0)) : String(id);
const opponent = (rankNo, id, power) => ({ rankNo, id, power, nickname: '对手' + rankNo });
const pirate = (uid, type, level, cityId = 80) => ({ uid, type, level, cityId, gridIdx: 500 + uid });

function fixture(id) {
  const task = { id, progress: 0, targetProgress: 2, rewardClaimed: false };
  const f = {
    task, tickets: 3, connected: true, writes: [],
    reset: Math.floor(Date.now() / 1000) + 10_000,
    arena: { myself: opponent(120, player.playerId, 100),
      top3: [1, 2, 3].map(rank => opponent(rank, rank, 1)), arenaPoint: 3, dailyChallengeTimes: 0,
      challenges: [opponent(80, bigId, 500), opponent(90, 112, 800), opponent(130, 113, 1)] },
    map: { sweepTimes: 0, pirates: [pirate(31, 2, 1), pirate(32, 1, 3), pirate(33, 1, 2), pirate(34, 1, 1)] },
    records: [{ type: 1, maxKilledLevel: 2 }],
    preview(idle = false) {
      return surveyDailies(this, protocol, { config, player, probeGift: false, idle });
    },
    run(survey) {
      return runDailies(this, protocol, survey, { allowMutate: true, config, claimRewards: false });
    },
    async challenge(body) {
      const target = this.arena.challenges.find(row => row.rankNo === body.rank && exactId(row.id) === exactId(body.challengeId));
      assert.ok(target, '竞技场仅挑战刷新后的对手');
      this.task.progress++;
      this.arena.dailyChallengeTimes++;
      return { reportId: 901, isChange: false, oldRankNo: 120, rankNo: target.rankNo, isWin: true };
    },
    sweep(body) {
      const target = this.map.pirates.find(row => row.uid === body.uid && row.cityId === body.cityId);
      assert.ok(this.records.some(r => r.type === target.type && target.level <= r.maxKilledLevel));
      this.task.progress++;
      this.map.sweepTimes++;
    },
    async request(name, body) {
      switch (name) {
        case 'DailyTaskInfoRequest': return { dailyTask: [structuredClone(this.task)], dailyResetTime: this.reset };
        case 'AllResourceRequest': return { list: [{ res: 5, amount: this.tickets }] };
        case 'AllItemRequest': return { items: [] };
        case 'ArenaInfoRequest': return structuredClone(this.arena);
        case 'ArenaChallengeRequest':
          this.writes.push([name, structuredClone(body)]);
          return this.challenge(body);
        case 'AllPirateRequest': return structuredClone(this.map);
        case 'PirateKillRecordRequest': return { records: structuredClone(this.records) };
        case 'MonthCardRequest': return { cardItem: [] };
        default: assert.fail('意外请求 ' + name);
      }
    },
    async sendWatch(name, body) {
      assert.equal(name, 'PirateSweepRequest');
      this.writes.push([name, structuredClone(body)]);
      await this.sweep(body);
    },
  };
  return f;
}

for (const idle of [false, true]) {
  const f = fixture(1005);
  const survey = await f.preview(idle);
  assert.equal(survey.tasks[0].actions?.length, 1, '每轮只列一个可挑战对手，后续需重新读榜');
  assert.equal(survey.tasks[0].actions[0].body.challengeId, '9007199254740993');
  const results = await f.run(survey);
  assert.ok(results.some(row => row.ok));
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0][1], { rank: 80, challengeId: bigId });
}

{
  const legacy = fixture(1010);
  const survey = await surveyDailies(legacy, { ...protocol, GotRewardResponse: true }, { config, player, probeGift: false });
  assert.ok(survey.tasks[0].actions?.length, '完整协议定义不能让未提供新设置的旧日常扫荡失效');
  assert.ok((await legacy.run(survey)).some(row => row.ok));

  const configured = fixture(1010);
  const reads = [];
  const request = configured.request.bind(configured);
  configured.request = async (name, body) => { reads.push(name); return request(name, body); };
  const independent = await surveyDailies(configured, protocol, { config, player, probeGift: false, settings: defaultSettings() });
  assert.equal(independent.tasks[0].status, 'waiting');
  assert.equal(independent.tasks[0].actions.length, 0, '新设置统一交给有持久账本的独立扫荡服务');
  assert(!reads.some(name => ['PirateKillRecordRequest', 'AllPirateRequest', 'MonthCardRequest'].includes(name)));
}

{
  let enabled = true, sent = 0;
  const action = { request: 'RecruitStartRequest', response: 'RecruitStartResponse', body: { way: 2 }, note: '单抽' };
  const ticket = { id: 'reserved' }, cancelled = [];
  const results = await runDailies({ request: async () => { sent++; } }, { RecruitStartResponse: true }, {
    tasks: [{ task: { id: 1002, title: '英雄招募' }, status: 'ready', actions: [action] }],
  }, { allowMutate: true, claimRewards: false, allowAction: () => enabled,
    beforeAction: async () => { await Promise.resolve(); enabled = false; return ticket; },
    cancelAction: (step, reserved) => cancelled.push([step, reserved]),
  });
  assert.equal(sent, 0, '预算预检期间关闭功能，恢复执行前必须重查');
  assert.deepEqual(cancelled, [[action, ticket]], '未发送的预算必须释放');
  assert(results[0].skipped);
}

for (const taskId of [1005, 1010]) {
  const f = fixture(taskId), survey = await f.preview();
  let enabled = true;
  const request = f.request.bind(f), ticket = { id: String(taskId) }, cancelled = [];
  f.request = async (name, body) => {
    const result = await request(name, body);
    if (name === (taskId === 1005 ? 'ArenaInfoRequest' : 'AllPirateRequest')) enabled = false;
    return result;
  };
  const results = await runDailies(f, protocol, survey, { allowMutate: true, claimRewards: false, config,
    allowAction: () => enabled, beforeAction: () => ticket,
    cancelAction: (step, reserved) => cancelled.push([step, reserved]),
  });
  assert.deepEqual(f.writes, [], '驱动复查期间关闭功能，竞技场与海盗都不得发送');
  assert.deepEqual(cancelled, [[survey.tasks[0].actions[0], ticket]]);
  assert(results[0].skipped);
}

for (const mode of ['stale', 'unknown']) {
  const f = fixture(1005), survey = await f.preview();
  const ticket = { id: mode }, cancelled = [];
  if (mode === 'stale') f.task.progress = f.task.targetProgress;
  else f.challenge = async () => { throw new Error('请求已发送，但回包未知'); };
  const results = await runDailies(f, protocol, survey, { allowMutate: true, claimRewards: false, config,
    beforeAction: () => ticket, cancelAction: (step, reserved) => cancelled.push([step, reserved]),
  });
  assert.equal(cancelled.length, mode === 'stale' ? 1 : 0, '明确跳过释放预算，已发送未知结果保留预算');
  assert.equal(f.writes.length, mode === 'unknown' ? 1 : 0);
  assert(!results.some(row => row.ok));
}

// A later read can be explicitly unsent without saying anything about the
// already-sent mutation. Keep the real guard's usage ticket in that case.
for (const delivery of ['response', 'silent']) for (const fault of [
  { notSent: true, request: 'AllResourceRequest' },
  { code: 'AUTOMATION_SKIP' },
  { prompt: {}, request: 'ClickGoldRequest' },
]) {
  const action = { request: delivery === 'response' ? 'ClickGoldRequest' : 'DiscountShopBuyRequest',
    response: delivery === 'response' ? 'ClickGoldResponse' : null, body: delivery === 'response' ? { free: false, times: 1 } : { id: 1 },
    note: '日常钻石消费', costs: [{ id: 'RUBY', num: 5 }], counters: { goldPaidTimes: 1 } };
  let writes = 0;
  const client = { request: async name => {
    if (name === 'AllResourceRequest') return { list: [{ res: 4, amount: 100 }] };
    assert.equal(name, action.request); writes++; return {};
  }, sendWatch: async name => { assert.equal(name, action.request); writes++; } };
  const hooks = boundaryGuard(client);
  await runDailies(client, { ClickGoldResponse: true }, {
    tasks: [{ task: { id: 1006, title: '点金' }, status: 'paid', actions: [action] }],
  }, { ...hooks, allowMutate: true, allowPaid: true, claimRewards: false,
    afterAction: async () => { throw Object.assign(new Error('写后核对失败'), fault); },
  });
  assert.equal(writes, 1);
  assert.equal(hooks.ledger.snapshot().counters.diamonds, 5, 'afterAction errors cannot refund an already-sent diamond debit');
  assert.equal(hooks.ledger.snapshot().counters.goldPaidTimes, 1, 'afterAction errors cannot refund an already-sent daily quota');
}

for (const [fault, cancelled] of [
  [{ notSent: true }, true],
  [{ prompt: {}, request: 'ClickGoldRequest' }, true],
  [{ code: 'AUTOMATION_SKIP' }, false],
  [{ prompt: {}, request: 'AllResourceRequest' }, false],
  [{}, false],
]) {
  const action = { request: 'ClickGoldRequest', response: 'ClickGoldResponse', body: { free: false, times: 1 },
    note: '付费点金', costs: [{ id: 'RUBY', num: 5 }], counters: { goldPaidTimes: 1 } };
  const client = { request: async name => {
    if (name === 'AllResourceRequest') return { list: [{ res: 4, amount: 100 }] };
    assert.equal(name, action.request); throw Object.assign(new Error('写调用失败'), fault);
  } };
  const hooks = boundaryGuard(client);
  await runDailies(client, { ClickGoldResponse: true }, {
    tasks: [{ task: { id: 1006, title: '点金' }, status: 'paid', actions: [action] }],
  }, { ...hooks, allowMutate: true, allowPaid: true, claimRewards: false });
  assert.equal(hooks.ledger.snapshot().counters.diamonds ?? 0, cancelled ? 0 : 5, 'only the mutation itself can supply cancellation evidence');
}

for (const taskId of [1005, 1010]) {
  for (const phase of ['before', 'after']) {
    for (const fault of [{ notSent: true }, { code: 'AUTOMATION_SKIP' }]) {
      const f = fixture(taskId), survey = await f.preview();
      survey.tasks[0].actions[0].counters = { dailyBoundary: 1 };
      const request = f.request.bind(f), targetRead = taskId === 1005 ? 'ArenaInfoRequest' : 'AllPirateRequest';
      const challenge = f.challenge.bind(f);
      f.challenge = async body => { await challenge(body); return {}; };
      f.request = async (name, body) => {
        if (name === targetRead && (phase === 'before' || f.writes.length)) throw Object.assign(new Error('驱动读取失败'), { request: name, ...fault });
        return request(name, body);
      };
      const hooks = boundaryGuard(f);
      await runDailies(f, protocol, survey, { ...hooks, allowMutate: true, claimRewards: false, config });
      assert.equal(f.writes.length, phase === 'before' ? 0 : 1);
      assert.equal(hooks.ledger.snapshot().counters.dailyBoundary ?? 0, phase === 'before' ? 0 : 1,
        'driver preflight failures release their ticket; post-write read failures retain it');
    }
  }
}

{
  const f = fixture(1005), survey = await f.preview();
  survey.tasks[0].actions[0].counters = { dailyBoundary: 1 };
  f.challenge = async () => ({ isChange: true });
  const hooks = boundaryGuard(f);
  await runDailies(f, protocol, survey, { ...hooks, allowMutate: true, claimRewards: false, config });
  assert.equal(f.writes.length, 1);
  assert.equal(hooks.ledger.snapshot().counters.dailyBoundary, 1, 'a driver skip after sending is not proof that no request was sent');
}

for (const change of [
  f => { f.tickets = 0; },
  f => { f.task.progress = f.task.targetProgress; },
  f => { f.arena.challenges = [opponent(130, 113, 1), f.arena.myself]; },
  f => { f.arena.challenges[0].id = { ...bigId, low: 0 }; },
]) {
  const f = fixture(1005);
  const survey = await f.preview();
  change(f);
  await f.run(survey);
  assert.deepEqual(f.writes, [], '旧名单、票不足、任务完成均不能发挑战');
}

{
  const f = fixture(1005);
  f.arena.challenges = [opponent(1, 1, 1), f.arena.myself, opponent(130, 113, 1)];
  const survey = await f.preview(true);
  assert.ok(!survey.tasks[0].actions?.length, '展示位、本人和低于自己排名的扫荡位不进入挑战计划');
  await f.run(survey);
  assert.deepEqual(f.writes, []);
}

for (const rejection of ['prompt', 'changed', 'unconfirmed']) {
  const f = fixture(1005);
  const challengeNormally = f.challenge;
  f.arena.challenges = [opponent(80, bigId, 500)];
  f.challenge = async () => {
    if (rejection === 'prompt') throw new Error('server prompt: not in challenge list');
    return rejection === 'changed' ? { isChange: true } : {};
  };
  const first = await f.run(await f.preview());
  assert.ok(!first.some(row => row.ok));
  await f.run(await f.preview(true));
  assert.equal(f.writes.length, 1, '未变化的无效对手不重复挑战');
  f.arena.challenges = [opponent(88, 345, 1)];
  f.challenge = challengeNormally;
  assert.ok((await f.run(await f.preview(true))).some(row => row.ok));
  assert.equal(f.writes.at(-1)[1].rank, 88, '新名单可以继续完成当天竞技场任务');
}

{
  const f = fixture(1010);
  f.task.targetProgress = 1;
  const survey = await f.preview();
  const results = await f.run(survey);
  assert.ok(results.some(row => row.ok));
  assert.deepEqual(f.writes, [['PirateSweepRequest', { uid: 33, cityId: 80 }]],
    '同类已首杀的最高等级优先，忽略其他类型或高于首杀的海盗');
}

{
  const f = fixture(1010);
  f.records = [];
  const survey = await f.preview(true);
  assert.ok(!survey.tasks[0].actions?.length, '地图有目标但个人首杀记录为空时不能扫荡');
  await f.run(survey);
  assert.deepEqual(f.writes, []);
}

{
  const f = fixture(1010);
  f.map.pirates = [pirate(33, 1, 2)];
  const old = await f.preview();
  assert.ok((await f.run(old)).some(row => row.ok));
  await f.run(old);
  assert.equal(f.writes.length, 1, '同一份计划即使扫荡成功也不能重放');
  assert.ok((await f.run(await f.preview(true))).some(row => row.ok),
    '实际次数及任务进度均已增加，刷新后可继续扫荡该目标');
  assert.equal(f.task.progress, 2);
}

for (const change of [
  f => { f.records = []; },
  f => { f.map.sweepTimes = 12; },
  f => { f.task.progress = f.task.targetProgress; },
  f => { f.map.pirates = []; },
  f => { f.map.pirates = [pirate(33, 1, 2, 99)]; },
]) {
  const f = fixture(1010);
  f.task.targetProgress = 1;
  const survey = await f.preview();
  change(f);
  await f.run(survey);
  assert.deepEqual(f.writes, [], '执行前重查首杀、次数、目标位置和任务进度');
}

for (const failure of ['prompt', 'unconfirmed']) {
  const f = fixture(1010);
  const sweepNormally = f.sweep;
  f.map.pirates = [pirate(33, 1, 2)];
  f.sweep = () => { if (failure === 'prompt') throw new Error('server prompt: cannot sweep'); };
  const first = await f.run(await f.preview());
  assert.ok(!first.some(row => row.ok), '扫荡未得到次数确认不能记作完成');
  await f.run(await f.preview(true));
  assert.equal(f.writes.length, 1, '同一天不重发已拒绝或未确认的海盗 UID');
  f.reset += 86400;
  f.sweep = sweepNormally;
  const nextDay = await f.run(await f.preview(true));
  assert.ok(nextDay.some(row => row.ok), '新的每日周期重新验证目标');
  assert.equal(f.writes.length, 2);
}

for (const [taskId, key] of [[1005, 'arena'], [1010, 'pirate']]) {
  const f = fixture(taskId);
  f.arena.challenges = [opponent(80, bigId, 500)];
  f.map.pirates = [pirate(33, 1, 2)];
  f.challenge = () => { throw new Error('server prompt: not in challenge list'); };
  f.sweep = () => { throw new Error('server prompt: cannot sweep'); };
  await runLoop(f, protocol, { config, player, rounds: 2, everyMs: 0, sleep: async () => {},
    allowMutate: true, isEnabled: name => name === key });
  assert.equal(f.writes.length, 1, '挂机下一轮不能向同一无效目标重发');

  const blocked = fixture(taskId);
  blocked.tickets = 0;
  blocked.records = [];
  const logs = [];
  await runLoop(blocked, protocol, { config, player, rounds: 2, everyMs: 0, sleep: async () => {},
    allowMutate: true, isEnabled: name => name === key, onStep: entry => logs.push(entry) });
  assert.deepEqual(blocked.writes, []);
  assert.equal(logs.filter(entry => entry.phase === 'dailies' && entry.skipped && entry.reason).length, 1,
    '连续两轮的同一阻塞原因只记录一次');
}

console.log('daily combat ok: arena roster, exact IDs and tickets, pirate first kills and quotas, stale and rejected targets across manual and idle runs');
