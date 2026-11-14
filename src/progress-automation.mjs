import { setTimeout as sleep } from 'node:timers/promises';
import { toNumber } from './client.mjs';
import { planHeroes, runHeroPlan } from './heroes.mjs';
import { runStages } from './stages.mjs';

export const maxHeroStepsPerRound = 5;
export const maxStagesPerRound = 3;
const MAINLINE_MODULE = 1;
const RETRY_POWER_RATIO = 1.03;
const RETRY_AFTER_SECONDS = 6 * 3600;

const heroLabel = '主力英雄养成';
const stageLabel = '主线自动推图';
const stageLosses = new WeakMap();

// 请求数受限时只保留前面的步骤。升级步骤按次数展开，所以要拆开计数。
export function limitHeroSteps(steps, limit = maxHeroStepsPerRound) {
  const result = [];
  let left = limit;
  for (const step of steps) {
    if (left <= 0) break;
    if (step.kind === 'level' && step.count > left) {
      result.push({ ...step, count: left, to: step.from + left });
      left = 0;
    } else {
      result.push(step);
      left -= step.kind === 'level' ? step.count : 1;
    }
  }
  return result;
}

function describeHeroStep(entry) {
  const { step } = entry;
  if (step.kind === 'level') return step.heroId + ' 升到 ' + entry.targetLevel + ' 级';
  if (step.kind === 'star') return step.heroId + ' 升到 ' + step.to + ' 星';
  return step.heroId + ' 技能 ' + (step.slot + 1) + ' 升到 ' + step.to + ' 级';
}

// 只养成主线阵容，并且不动万能碎片，避免把稀缺材料花在不上阵的英雄身上。
export async function serviceHeroGrowth(client, protocol, config, { player, enabled = () => false, report = () => {}, scheduler } = {}) {
  const key = 'heroGrowth';
  const finish = entry => { report({ key, label: heroLabel, ...entry }); };
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return;
  try {
    const formation = (await client.request('GetFormationRequest', { module: MAINLINE_MODULE }, 'GetFormationResponse'))?.formation;
    const heroIds = (formation?.heroPositions ?? []).map(slot => slot.heroId).filter(Boolean);
    if (!heroIds.length) { later(1800); return finish({ skipped: true, reason: '无法确认主线阵容' }); }
    const heroes = (await client.request('AllHeroRequest', {}, 'AllHeroResponse'))?.heroes ?? [];
    const items = (await client.request('AllItemRequest', {}, 'AllItemResponse'))?.items ?? [];
    const counts = new Map();
    for (const item of items) counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + toNumber(item.num));
    const plan = planHeroes({ config, heroes, itemNum: id => counts.get(id) ?? 0, playerLevel: player?.level ?? 1,
      allowUniversal: false, heroIds });
    const steps = limitHeroSteps(plan.steps);
    if (!steps.length) { later(1800); return finish({ skipped: true, reason: '主线阵容暂无可用的养成材料' }); }
    if (!enabled()) return;
    const results = await runHeroPlan(client, protocol, { steps }, { allowMutate: true });
    const done = results.filter(entry => entry.ok);
    const failed = results.find(entry => !entry.ok && !entry.skipped);
    if (done.length) finish({ ok: true, label: heroLabel + ' · ' + done.map(describeHeroStep).join('、') });
    if (failed) { later(1800); return finish({ ok: false, error: describeHeroStep(failed) + '：' + failed.error }); }
    later(60);
  } catch (error) {
    later(600);
    finish({ ok: false, error: error.message });
  }
}

export function stageRetryWait(loss, player, now) {
  if (!loss || loss.stage !== player?.mainlineStage) return null;
  const power = toNumber(player?.power);
  if (loss.power > 0 && Number.isFinite(power) && power >= loss.power * RETRY_POWER_RATIO) return null;
  if (now >= loss.at + RETRY_AFTER_SECONDS) return null;
  return loss.at + RETRY_AFTER_SECONDS;
}

export async function serviceStageAuto(client, config, { player, enabled = () => false, report = () => {}, scheduler, isBusy = () => false, wait = sleep } = {}) {
  const key = 'stageAuto';
  const finish = entry => { report({ key, label: stageLabel, ...entry }); };
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return;
  if (isBusy()) { later(60); return finish({ skipped: true, reason: '手动推关进行中' }); }
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const retryAt = stageRetryWait(stageLosses.get(client), player, now);
  if (retryAt) {
    later(300);
    return finish({ skipped: true, reason: '第 ' + player.mainlineStage + ' 关上次战败，等待战力上涨 3% 或 6 小时后重试' });
  }
  const passed = [];
  try {
    const result = await runStages(client, player, config, {
      allowMutate: true, maxFailures: 1, maxWins: maxStagesPerRound, wait,
      onBattle({ stage, won }) {
        if (won) {
          player.mainlineStage = stage + 1;
          passed.push(stage);
          stageLosses.delete(client);
        } else stageLosses.set(client, { stage, power: toNumber(player.power) || 0, at: now });
      },
    });
    const lost = stageLosses.get(client);
    if (passed.length) finish({ ok: true, label: stageLabel + ' · 通过第 ' + passed.join('、') + ' 关' });
    if (lost) {
      later(300);
      return finish({ ok: true, label: stageLabel + ' · 第 ' + lost.stage + ' 关战败，等待战力上涨后重试' });
    }
    if (passed.length && result.reachedLimit) { later(30); return; }
    later(600);
    finish({ skipped: true, reason: result.reason });
  } catch (error) {
    later(600);
    finish({ ok: false, error: error.message });
  }
}
