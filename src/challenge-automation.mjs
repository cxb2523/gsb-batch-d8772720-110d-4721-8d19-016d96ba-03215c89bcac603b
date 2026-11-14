import { runStages } from './stages.mjs';
import { runTrialStages } from './trials.mjs';
import { runPirateAdvance } from './pirate-advance.mjs';

// 一次挂机持有同一对象；断线重连不清零，重新开始挂机时创建新计数。
export function createChallengeRun() { return { mainline: {}, trials: {}, pirate: {} }; }

export async function runChallengeRound(client, config, { player, getSettings, state, ledger,
  enabled = () => true, isStageBusy = () => false, isTrialBusy = () => false, isPirateBusy = () => false,
  report = () => {}, signal, wait, prepareDispatch = async () => {}, mode = 'all' } = {}) {
  const current = () => enabled() && !signal?.aborted && client.connected !== false;
  const prefs = getSettings()?.progression;
  const battle = async (key, label, progress, allowed, busy, run) => {
    if (!current() || !allowed()) return;
    const finish = entry => report({ key, label, ...entry });
    if (!progress.halted && (progress.failures ?? 0) >= getSettings().progression.maxFailures) {
      progress.halted = true; progress.reason = '已达到当前失败停止次数，本次挂机停止该挑战；重新开始挂机可重试';
    }
    if (progress.halted) return finish({ skipped: true, reason: progress.reason });
    if (busy()) return finish({ skipped: true, reason: '手动挑战进行中，本轮跳过' });
    let sent = false, settled = false;
    const live = () => current() && allowed() && !busy();
    const beforeBattle = () => { if (!live()) throw new Error('推关已暂停，未发送挑战'); sent = true; };
    const onBattle = ({ stage, level = stage, won }) => {
      settled = true;
      if (progress.stage !== stage) progress.failures = 0;
      progress.stage = stage;
      progress.wins = (progress.wins ?? 0) + (won ? 1 : 0);
      progress.failures = won ? 0 : (progress.failures ?? 0) + 1;
      const limit = getSettings().progression.maxFailures;
      progress.halted = progress.failures >= limit;
      progress.reason = won ? `第 ${level} 关已通关，下轮继续`
        : `第 ${level} 关连续战败 ${progress.failures}/${limit} 次` + (progress.halted ? '，已停止；重新开始挂机可重试' : '，下轮重试');
      finish({ ok: won, skipped: !won, reason: progress.reason });
    };
    try {
      const result = await run({ beforeBattle, onBattle, enabled: live });
      if (!settled) { progress.reason = result.reason; finish({ skipped: true, reason: result.reason }); }
    } catch (error) {
      const rejected = error.prompt && error.request === (key === 'stageAuto' ? 'ChallengeStageRequest' : 'TrialRaidChallengeRequest');
      if (rejected) {
        progress.reason = error.message + '；服务器明确拒绝，本次不计战败，下轮再检查';
        return finish({ skipped: true, reason: progress.reason });
      }
      // 超时和不匹配战报不能当作战败，也不能下一轮盲目重试。
      if (sent && !settled && !error.notSent) progress.halted = true;
      progress.reason = error.message + (progress.halted ? '；结果未确认，本次挂机停止该挑战' : '');
      finish({ skipped: !live(), ok: false, error: progress.reason });
    }
  };
  if (mode !== 'pirate' && prefs?.enabled) {
    await battle('stageAuto', '主线 / 闯关', state.mainline,
      () => getSettings()?.progression?.enabled && getSettings().progression.mainline, isStageBusy,
      ({ beforeBattle, onBattle }) => runStages(client, player, config, { allowMutate: true, maxFailures: 1, maxWins: 1,
        signal, wait, beforeBattle, onBattle: event => { if (event.won) player.mainlineStage = event.stage + 1; onBattle(event); } }));
    for (const id of prefs.raidIds) {
      const raidId = Number(id), name = config?.tables?.TrialRaidCfg?.data?.find(row => row.raidId === raidId)?.title ?? '试炼 ' + id;
      await battle('trialAuto:' + id, name, state.trials[id] ??= {},
        () => getSettings()?.progression?.enabled && getSettings().progression.trials && getSettings().progression.raidIds.includes(id),
        () => isTrialBusy(raidId), options => runTrialStages(client, player, config, raidId, { ...options, signal, wait, maxFailures: 1, maxWins: 1 }));
    }
  }
  if (mode !== 'progression' && current() && getSettings()?.pirateHunt?.enabled) {
    if (isPirateBusy()) { report({ key: 'pirateAuto', label: '海盗讨伐', skipped: true, reason: '手动首杀推进中，本轮跳过' }); return; }
    try {
      const spentBefore = state.pirate.state?.spent ?? 0, winsBefore = state.pirate.state?.wins ?? 0;
      const result = await runPirateAdvance({ client, config, player, ledger, checkpoint: state.pirate, oneCheck: true,
        options: structuredClone(getSettings().pirateHunt), getSettings, signal, prepareDispatch,
        enabled: () => current() && getSettings()?.pirateHunt?.enabled && !isPirateBusy() });
      const advanced = result.wins > winsBefore, dispatched = result.spent > spentBefore;
      report({ key: 'pirateAuto', label: '海盗讨伐', ok: advanced || dispatched, skipped: !advanced && !dispatched,
        reason: result.reason + `（已首杀 ${result.wins} 级，连续战败 ${result.failures ?? 0} 次，本次汽油 ${result.spent}）` });
    } catch (error) { report({ key: 'pirateAuto', label: '海盗讨伐', ok: false, error: error.message }); }
  }
}
