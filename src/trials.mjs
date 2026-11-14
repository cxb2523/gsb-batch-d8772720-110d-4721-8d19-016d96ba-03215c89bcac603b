import { displayMaterial } from './config.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { stageFailureLimit } from './stages.mjs';
import { waitForChallenge } from './battle-pacing.mjs';

async function readRaid(client, raidId) {
  const { raid } = await client.request('TrialRaidInfoRequest', { raidId });
  if (!raid || raid.raidId !== raidId) throw new Error('无法确认试炼副本进度');
  return raid;
}

function raidStages(config, raidId) {
  return config.tables.TrialRaidStageCfg.data.filter(row => row.raidId === raidId).sort((a, b) => a.stageLevel - b.stageLevel);
}

// V74 RaidItem uses buySweepTimes for the next price. sweepTimes and the
// daily sweep limit are not a second pool of free attempts. The free button
// exists only on the highest cleared stage and never crosses a paid tier.
function freeSweepState(info, stages, level, prices) {
  const passed = stages.find(stage => stage.stageId === info.passedStage);
  if (info.passedStage && !passed) throw new Error('未能匹配已通关的试炼关卡');
  const used = info.buySweepTimes ?? 0;
  if (!Number.isSafeInteger(used) || used < 0) throw new Error('未能确认已使用的试炼扫荡次数');
  const sweepable = Boolean(passed && level >= passed.openLevel);
  let left = 0;
  while (sweepable) {
    const next = prices.filter(row => row.buyTimes === used + left + 1);
    if (next.length !== 1 || next[0].costRuby !== 0) break;
    left++;
  }
  return { passed, used, left, sweepable };
}

export async function trialProgress(client, config, level) {
  if (!config?.tables?.TrialRaidCfg) throw new Error('缺少试炼副本配置');
  const rows = [];
  const prices = config.tables.TrialRaidBuySweepCfg?.data ?? [];
  for (const raid of config.tables.TrialRaidCfg.data) {
    const stages = raidStages(config, raid.raidId);
    const first = stages[0];
    if (!first) continue;
    const row = { raidId: raid.raidId, name: raid.title, openLevel: first.openLevel };
    rows.push(row);
    if (level < first.openLevel) { row.reason = '角色 ' + first.openLevel + ' 级开放'; continue; }
    try {
      const info = await readRaid(client, raid.raidId);
      const { passed, left } = freeSweepState(info, stages, level, prices);
      const next = stages.find(stage => stage.stageId > (info.passedStage ?? 0));
      row.passed = passed?.stageLevel ?? 0;
      row.freeLeft = left;
      row.sweepHint = !passed ? '首通第一关后可免费扫荡' : left ? '可扫荡已通关的第 ' + passed.stageLevel + ' 关' : '当前没有可用的免费扫荡';
      row.sweepRewards = (passed?.sweepReward ?? []).map(([id, n]) => displayMaterial(config, id) + ' ×' + n).join('、');
      if (!next) { row.reason = '已全部通关'; continue; }
      row.next = { id: next.stageId, level: next.stageLevel, power: next.power,
        rewards: next.reward.map(([id, n]) => displayMaterial(config, id) + ' ×' + n).join('、') };
      if (level < next.openLevel) row.reason = '下一关需要角色 ' + next.openLevel + ' 级';
    } catch (error) { row.reason = '读取失败：' + error.message; row.failed = true; }
  }
  return rows;
}

export async function challengeTrial(client, config, level, raidId, expectedStage, enabled = () => true) {
  const raid = config?.tables.TrialRaidCfg.data.find(row => row.raidId === raidId);
  if (!raid) throw new Error('未知试炼副本');
  const stages = raidStages(config, raidId);
  if (!stages.length) throw new Error(raid.title + '缺少关卡配置');
  if (level < stages[0].openLevel) throw new Error(raid.title + '需要角色 ' + stages[0].openLevel + ' 级');
  const info = await readRaid(client, raidId);
  const next = stages.find(row => row.stageId > (info.passedStage ?? 0));
  if (!next) return raid.title + '已全部通关';
  if (expectedStage != null && next.stageId !== expectedStage) throw new Error('试炼进度已变化，请刷新后再挑战');
  if (level < next.openLevel) throw new Error(raid.title + '第 ' + next.stageLevel + ' 关需要角色 ' + next.openLevel + ' 级');
  await waitForChallenge(client);
  if (!enabled()) throw new Error('账号状态已变化，取消挑战试炼副本');
  await client.request('TrialRaidChallengeRequest', { raidId, stageId: next.stageId });
  const after = await readRaid(client, raidId);
  return raid.title + '第 ' + next.stageLevel + ' 关' + (after.passedStage >= next.stageId ? '已通关' : '未通关');
}

export async function sweepTrials(client, config, level, enabled, log, scheduler) {
  const prices = config?.tables.TrialRaidBuySweepCfg?.data ?? [];
  for (const raid of config?.tables.TrialRaidCfg?.data ?? []) {
    const key = 'trialSweep:' + raid.raidId;
    if (scheduler && !scheduler.due(key)) continue;
    const stages = config.tables.TrialRaidStageCfg.data.filter(row => row.raidId === raid.raidId);
    if (!enabled() || !stages.some(row => row.openLevel <= level)) continue;
    try {
      const midnight = scheduler?.nextDay();
      let state = freeSweepState(await readRaid(client, raid.raidId), stages, level, prices);
      while (enabled() && state.left > 0 && (!scheduler || scheduler.now() < midnight)) {
        const next = state.used + 1;
        await client.sendWatch('TrialRaidBuySweepRequest', { raidId: raid.raidId, useAdvCard: false });
        state = freeSweepState(await readRaid(client, raid.raidId), stages, level, prices);
        if (state.used < next) throw new Error('服务端未确认扫荡次数，本轮停止');
        log({ title: raid.title + '已免费扫荡', ok: true });
      }
      if (scheduler && state.sweepable && state.left === 0 && prices.length && scheduler.now() < midnight) {
        scheduler.defer(key, midnight);
      }
    } catch (error) {
      log({ title: raid.title + '免费扫荡', ok: false, error: error.message });
    }
  }
}

export async function runTrialStages(client, player, config, raidId, { maxFailures = 3, maxWins = Infinity, beforeBattle, signal, enabled = () => true,
  schedule = work => work(), wait = sleep, onBattle = () => {} } = {}) {
  maxFailures = stageFailureLimit(maxFailures);
  const definition = config?.tables?.TrialRaidCfg?.data?.find(r => r.raidId === raidId);
  if (!definition) throw new Error('未知试炼副本');
  const stages = raidStages(config, raidId);
  let wins = 0, failures = 0, lastStage = null;
  for (;;) {
    signal?.throwIfAborted();
    if (!enabled() || !client.connected) throw new Error('账号状态已变化，试炼推关已停止');
    const result = await schedule(async () => {
      signal?.throwIfAborted();
      if (!enabled() || !client.connected) throw new Error('账号状态已变化，试炼推关已停止');
      const before = await readRaid(client, raidId);
      if (!Number.isSafeInteger(before.passedStage) || before.passedStage < 0 || (before.passedStage && !stages.some(r => r.stageId === before.passedStage))) throw new Error('试炼已通关进度无效，停止重试');
      const next = stages.find(r => r.stageId > before.passedStage);
      if (!next) return { done: true, reason: '该试炼已全部通关' };
      if (!(player?.level >= next.openLevel)) return { done: true, reason: `下一关需要角色 ${next.openLevel} 级` };
      await waitForChallenge(client, { signal, wait });
      signal?.throwIfAborted();
      if (!enabled()) throw new Error('账号已暂停，未发送试炼挑战');
      await beforeBattle?.(next.stageId);
      const reply = await client.request('TrialRaidChallengeRequest', { raidId, stageId: next.stageId }, 'TrialRaidChallengeResponse');
      if (reply?.raidId !== raidId || reply?.stageId !== next.stageId) throw new Error('试炼挑战回包不匹配，结果待核对，已停止');
      const after = await readRaid(client, raidId);
      if (!Number.isSafeInteger(after.passedStage) || after.passedStage < before.passedStage || (after.passedStage && !stages.some(r => r.stageId === after.passedStage))) throw new Error('试炼挑战后进度无法确认，已停止');
      return { stage: next.stageId, level: next.stageLevel, won: after.passedStage >= next.stageId };
    });
    if (result.done) return { wins, failures, reason: result.reason };
    if (lastStage !== result.stage) failures = 0;
    lastStage = result.stage;
    if (result.won) { wins++; failures = 0; } else failures++;
    onBattle({ ...result, wins, failures });
    if (wins >= maxWins) return { wins, failures, reason: `本轮已通过 ${wins} 关，下轮继续` };
    if (failures >= maxFailures) return { wins, failures, reason: `第 ${result.level} 关连续失败 ${failures} 次，已停止` };
  }
}

export function createTrialTask(raidId) {
  let controller = null;
  let state = { raidId, running: false, stopping: false, wins: 0, failures: 0, stage: null, reason: '尚未开启' };
  const view = () => ({ ...state });
  return {
    view,
    start(options, open, report) {
      if (controller) throw new Error('该试炼已在推关');
      const maxFailures = stageFailureLimit(options.maxFailures);
      controller = new AbortController(); const { signal } = controller;
      state = { raidId, running: true, stopping: false, wins: 0, failures: 0, stage: null, maxFailures, reason: '正在准备' };
      (async () => {
        try {
          const context = await open(); signal.throwIfAborted();
          const result = await runTrialStages(context.client, context.player, context.config, raidId, { ...context, signal, maxFailures,
            onBattle(info) { Object.assign(state, { stage: info.level, wins: info.wins, failures: info.failures, reason: `第 ${info.level} 关${info.won ? '已通关' : '未通关'}` }); report?.(view()); } });
          Object.assign(state, result);
        } catch (error) { state.reason = error.message; state.failed = !signal.aborted; }
        finally { if (signal.aborted) state.reason = signal.reason.message; controller = null; state.running = state.stopping = false; report?.(view()); }
      })();
      return view();
    },
    stop(reason = '已手动停止') { if (controller) { state.stopping = true; controller.abort(new Error(reason)); } return view(); },
  };
}
