import { setTimeout as sleep } from 'node:timers/promises';
import { waitForChallenge } from './battle-pacing.mjs';

export function stageFailureLimit(value = 3) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('失败次数需要填写正整数');
  return count;
}

export async function runStages(client, player, config, {
  maxFailures = 3, maxWins = Infinity, allowMutate = false, onStep = () => {}, onBattle = () => {},
  signal, wait = sleep, beforeBattle, schedule = work => work(),
} = {}) {
  maxFailures = stageFailureLimit(maxFailures);
  let stage = player?.mainlineStage;
  if (!Number.isInteger(stage) || stage < 1 || !Number.isInteger(player?.level) || player.level < 1) {
    throw new Error('登录响应缺少有效的主线关卡或角色等级');
  }
  const rows = config?.tables?.StageCfg?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('缺少 StageCfg，无法核对关卡等级要求');
  let wins = 0;
  let failures = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (wins >= maxWins) return { wins, reachedLimit: true, reason: `本次已通过 ${wins} 关` };
    const row = rows.find((entry) => entry.stage === stage);
    if (!row || !Number.isInteger(row.playerLevel)) return { wins, reason: `配置表中没有第 ${stage} 关的等级要求` };
    if (player.level < row.playerLevel) return { wins, reason: `第 ${stage} 关需要角色等级 ${row.playerLevel}，本次登录等级 ${player.level}` };
    if (!allowMutate) return { wins, reason: `可从第 ${stage} 关开始，同一关连续失败 ${maxFailures} 次停止。预览结束` };
    signal?.throwIfAborted();
    const result = await schedule(async () => {
      signal?.throwIfAborted();
      await waitForChallenge(client, { signal, wait, beforeSend: beforeBattle ? () => beforeBattle(signal) : undefined });
      signal?.throwIfAborted();
      return client.request('ChallengeStageRequest', { stage }, 'ChallengeStageResponse');
    });
    if (result?.initialData?.mainlineStage !== stage || typeof result?.stats?.isLeftWin !== 'boolean') {
      throw new Error(`第 ${stage} 关战报缺失或关卡不符，已停止`);
    }
    if (!result.stats.isLeftWin) {
      failures++;
      onBattle({ stage, won: false, wins, failures });
      if (failures >= maxFailures) return { wins, reason: `第 ${stage} 关连续战败 ${failures} 次，已停止` };
      continue;
    }
    onStep(stage);
    wins++;
    failures = 0;
    onBattle({ stage, won: true, wins, failures });
    stage++;
  }
}

// One background run per console account. The stop signal cancels the delay;
// an already submitted battle is settled before another run can start.
export function createStageTask() {
  let controller = null;
  let state = { running: false, stopping: false, wins: 0, failures: 0, stage: null, reason: '尚未开启' };
  const view = () => ({ ...state });
  return {
    view,
    start({ maxFailures }, open, onError) {
      if (controller) throw new Error('这个账号已经开启了主线推关');
      maxFailures = stageFailureLimit(maxFailures);
      controller = new AbortController();
      const { signal } = controller;
      state = { running: true, stopping: false, maxFailures, stage: null, wins: 0, failures: 0, reason: '正在准备' };
      (async () => {
        try {
          const { client, player, config, beforeBattle, schedule } = await open();
          state.stage = player?.mainlineStage;
          state.reason = '挑战中';
          const result = await runStages(client, player, config, {
            allowMutate: true, signal, maxFailures, beforeBattle, schedule,
            onBattle({ stage, won, wins, failures }) {
              if (won) player.mainlineStage = stage + 1;
              Object.assign(state, { stage: player.mainlineStage, wins, failures, reason: won ? `第 ${stage} 关胜利` : `第 ${stage} 关战败` });
            },
          });
          state.reason = result.reason;
        } catch (error) {
          state.reason = error.message;
          if (!signal.aborted) onError?.(error);
        } finally {
          if (signal.aborted) state.reason = signal.reason.message;
          controller = null;
          state.running = state.stopping = false;
        }
      })();
      return view();
    },
    stop(reason = '已手动停止') {
      if (controller) {
        state.stopping = true;
        controller.abort(new Error(reason));
      }
      return view();
    },
  };
}
