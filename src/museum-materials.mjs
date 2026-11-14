import { goldAccountKey } from './gold-reservations.mjs';
import { normalize } from './worlds.mjs';
import { pendingMuseumMaterialSpends, settleMuseumMaterialSpend } from './order-reservations.mjs';

const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const heroesValid = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id)
  && new Set(ids).size === ids.length;
const sameHeroes = (a, b) => a.length === b.length && a.every(id => b.includes(id));

export function museumStartArgs(step) {
  const { stageId, heroIds, factor } = step.body ?? {};
  if (!integer(stageId, 1) || !integer(factor, 1) || !heroesValid(heroIds) || !heroIds.length) {
    throw new Error('无法确认探宝地图、英雄或倍率');
  }
  return { stageId, heroIds: [...heroIds], factor };
}

function completeStages(museum) {
  const stages = museum?.exploreStages;
  return Array.isArray(stages) && new Set(stages.map(stage => stage?.stageId)).size === stages.length
    && stages.every(stage => {
      if (!integer(stage?.stageId, 1) || !integer(stage.progress)) return false;
      const e = stage.expedition;
      // Expedition and its zero timestamps are optional on the wire. The
      // decoder's prototype defaults disappear during normalize(), unlike the
      // required stageId/progress fields. An active trip still needs evidence.
      if (e == null) return true;
      if (typeof e !== 'object') return false;
      const start = e.startTime ?? 0, end = e.endTime ?? 0, heroes = e.heroIds ?? [];
      return integer(start) && integer(end) && heroesValid(heroes)
        && (end === 0 || (start > 0 && end > start && heroes.length > 0 && integer(e.factor, 1)));
    });
}

// Capture handles before the read: an older snapshot must not settle a later
// dispatch. Read failures retain the evidence without blocking unrelated goods.
export async function readMuseumMaterialState(client, player, { step = null, enabled = () => true } = {}) {
  const handles = pendingMuseumMaterialSpends(player);
  if (!step && !handles.length) return null;
  if (step) museumStartArgs(step);
  const account = goldAccountKey(player);
  const check = () => {
    if (!enabled()) throw new Error('操作已暂停');
    if (goldAccountKey(player) !== account) throw new Error('账号已切换，不能使用原账号探宝状态');
  };
  check();
  let museum;
  try {
    museum = normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
    if (!completeStages(museum)) throw new Error('无法完整确认博物馆探宝状态');
  } catch (error) {
    check();
    if (step) throw error;
    return { account, handles, museum: null, error: error.message };
  }
  check();
  return { account, handles, museum };
}

export function settleMuseumMaterialState(player, snapshot, stock) {
  if (!completeStages(snapshot?.museum)) return;
  if (goldAccountKey(player) !== snapshot.account) throw new Error('账号已切换，不能结算原账号探宝');
  if (!(stock instanceof Map)) throw new Error('未能确认探宝后的完整库存');
  for (const handle of snapshot.handles) {
    const before = handle.museum;
    const stage = snapshot.museum.exploreStages.find(row => row.stageId === before.stageId);
    if (!stage) continue;
    const e = stage.expedition;
    const dispatched = e && e.startTime > before.startTime && e.endTime > before.endTime
      && e.endTime > e.startTime && e.factor === before.factor && sameHeroes(e.heroIds, before.heroIds);
    // Progress is applied when the expedition reward is claimed, so this also
    // recovers a lost dispatch response after the trip has already finished.
    if (stage.progress > before.progress || (stage.progress === before.progress && dispatched)) {
      settleMuseumMaterialSpend(player, handle);
    }
  }
}

export function museumMaterialDetails(player, step, snapshot) {
  const args = museumStartArgs(step);
  if (!completeStages(snapshot?.museum) || goldAccountKey(player) !== snapshot.account) throw new Error('未能确认派遣前的探宝状态');
  const pending = pendingMuseumMaterialSpends(player).find(handle => handle.museum.stageId === args.stageId
    || handle.museum.heroIds.some(id => args.heroIds.includes(id)));
  if (pending) throw new Error((pending.label || '上次探宝') + '的队伍结果尚未确认，暂不重复派遣');
  const stages = snapshot.museum.exploreStages;
  const stage = stages.find(row => row.stageId === args.stageId);
  if (!stage || (stage.expedition?.endTime ?? 0) !== 0) throw new Error('探宝地图已占用或状态缺失，等待重新安排');
  if (stages.some(row => row.expedition?.endTime > 0 && row.expedition.heroIds.some(id => args.heroIds.includes(id)))) {
    throw new Error('探宝英雄已被其他队伍占用，等待重新安排');
  }
  const costs = stage.expedition?.cost?.asset;
  if (!Array.isArray(costs) || !costs.length) throw new Error('无法确认探宝地图的当前材料消耗');
  const expected = new Map(), planned = new Map();
  for (const row of costs) {
    if (row?.type !== 0 || typeof row.id !== 'string' || !row.id || !integer(row.num, 1)) throw new Error('探宝材料消耗不完整');
    const total = (expected.get(row.id) ?? 0) + row.num * args.factor;
    if (!integer(total, 1)) throw new Error('探宝材料消耗无法精确确认');
    expected.set(row.id, total);
  }
  for (const row of step.costs ?? []) planned.set(row.id, (planned.get(row.id) ?? 0) + row.num);
  if (planned.size !== expected.size || [...expected].some(([id, count]) => planned.get(id) !== count)) {
    throw new Error('探宝材料需求已变化，等待重新安排');
  }
  return { ...args, progress: stage.progress, startTime: stage.expedition.startTime ?? 0, endTime: stage.expedition.endTime ?? 0 };
}
