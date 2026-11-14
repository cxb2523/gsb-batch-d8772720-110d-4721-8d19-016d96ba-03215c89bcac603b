import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';

const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);

function rewardText(config, reward) {
  return (normalize(reward)?.asset ?? []).map(x => displayMaterial(config, x.id) + ' ×' + x.num).join('、');
}

export async function fishView(client, config) {
  const fish = await client.request('FishEncyclopediaRequest', {}, 'FishEncyclopediaResponse');
  const catalog = config?.tables.FishBaseCfg?.data;
  const stages = config?.tables.FishStageCfg?.data;
  if (!catalog || !stages) throw new Error('缺少钓鱼图鉴配置');
  if(!Array.isArray(fish.fishList))throw Error('鱼种记录未同步');
  const ids = new Set(fish.fishList);
  const collected = catalog.filter(row => ids.has(row.fishId));
  const claimed = fish.rewardId ?? 0;
  const next = stages.filter(row => row.stage > claimed).sort((a, b) => a.stage - b.stage)[0];
  const score = collected.reduce((sum, row) => sum + row.score, 0)
    - stages.filter(row => row.stage <= claimed).reduce((sum, row) => sum + row.star, 0);
  return { names: collected.map(row => row.name), total: catalog.length, claimed, score,
    next: next?.stage, required: next?.star, ready: Boolean(next && score >= next.star) };
}

export function newbieView(client) {
  const state = client.newbieActivity;
  if (!state?.startTime) return null;
  const time = now(client);
  const startDay = Math.floor((state.startTime + 28800) / 86400) * 86400 - 28800;
  const end = Math.min(startDay + 7 * 86400, state.finishTime || Infinity);
  if (time < state.startTime || time >= end) return null;
  const claimed = state.loginRewardDay ?? [];
  const available = Array.from({ length: Math.min(7, state.loginDays || 0) }, (_, i) => i + 1).filter(day => !claimed.includes(day));
  return { end, loginDays: state.loginDays || 0, available };
}

const deniedUntil = new WeakMap();
export async function collectFloaters(client, config, floaters, enabled, report, { settings = null, dryRun = false } = {}) {
  const until = deniedUntil.get(client) ?? new Map();
  deniedUntil.set(client, until);
  const types = new Set(config?.tables.GarbageProductionCfg?.data.filter(r => r.type === '拾取').map(r => r.id));
  const ids = [];
  let capacity = Infinity;
  const projected = new Map();
  if (settings && !settings.gather.continueWhenFull) {
    const effects = normalize(await client.request('GameEffectRequest', {}, 'GameEffectResponse'));
    capacity = effects.effects?.find(effect => effect.id === 16)?.value;
    if (!(capacity > 0)) { report({ label: '海面漂浮物', skipped: true, reason: '未能确认原料仓储上限' }); return; }
    const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
    if (!Array.isArray(bag.items)) { report({ label: '海面漂浮物', skipped: true, reason: '未能确认当前库存' }); return; }
    for (const item of bag.items) projected.set(item.itemId, Number(item.num ?? 0));
  }
  for (const f of floaters ?? []) {
    if (!types.has(f.floaterId) || (until.get(f.floaterId) ?? 0) > now(client)) continue;
    const production = config?.tables.GarbageProductionCfg?.data.find(row => row.id === f.floaterId)?.production;
    for (let i = 0; i < f.num && ids.length < 40; i++) {
      if (Number.isFinite(capacity)) {
        if (!production || (projected.get(production[0]) ?? 0) >= capacity) break;
        projected.set(production[0], (projected.get(production[0]) ?? 0) + Number(production[1]));
      }
      ids.push(f.floaterId);
    }
  }
  if (!ids.length || !enabled('floaters')) return;
  if (dryRun) { report({ planned: true, action: { kind: 'floaters', label: '打捞当前可拾取的 ' + ids.length + ' 个漂浮物', costs: [] } }); return; }
  const reply = await client.request('PickUpFloaterRequest', { floaterId: ids }, 'PickUpFloaterResponse');
  const denied = reply.deniedFloaterIds ?? [];
  for (const id of denied) until.set(id, now(client) + 1800);
  report({ label: '漂浮物拾取 ' + (ids.length - denied.length) + ' 个' + (denied.length ? '，跳过 ' + denied.length + ' 个' : '') + ' ' + rewardText(config, reply.reward), ok: true });
}

export async function claimCollection(client, config, key, enabled, report, scheduler) {
  if (scheduler && !scheduler.due(key)) return;
  if (key === 'fishBook') {
    let view = await fishView(client, config);
    while (view.ready && enabled(key)) {
      const reply = await client.request('DrawFishRewardRequest', {}, 'DrawFishRewardResponse');
      if (!(reply.rewardId > view.claimed)) throw new Error('服务端尚未确认图鉴档位');
      report({ label: '钓鱼图鉴第 ' + reply.rewardId + ' 档 ' + rewardText(config, reply.reward), ok: true });
      const fresh = await fishView(client, config);
      if (fresh.claimed < reply.rewardId) break;
      view = fresh;
    }
  } else {
    const midnight = scheduler?.nextDay();
    for (const day of newbieView(client)?.available ?? []) {
      if (!enabled(key) || !newbieView(client)?.available.includes(day)) break;
      const start = client.newbieActivity.startTime;
      const reply = await client.request('DrawNewbieLoginRewardRequest', { day }, 'GotRewardResponse');
      if (client.newbieActivity?.startTime === start) {
        const claimed = client.newbieActivity.loginRewardDay ??= [];
        if (!claimed.includes(day)) claimed.push(day);
      }
      report({ label: '新手登录第 ' + day + ' 天 ' + rewardText(config, reply.reward), ok: true });
    }
    const view = newbieView(client);
    if (scheduler && enabled(key) && !view?.available.length) {
      const start = client.newbieActivity?.startTime;
      scheduler.defer(key, Math.min(midnight, view?.end ?? (start > now(client) ? start : midnight)));
    }
  }
}
