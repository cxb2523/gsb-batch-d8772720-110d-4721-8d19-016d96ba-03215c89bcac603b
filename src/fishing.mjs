import { setTimeout as pause } from 'node:timers/promises';
import { displayMaterial } from './config.mjs';
import { fishView } from './collections.mjs';
import { normalize } from './worlds.mjs';

export async function fishOnce(client, config, enabled, { dryRun = false, fishBook = false, onBookComplete } = {}) {
  const skip = reason => ({ label: '钓鱼', skipped: true, reason });
  if (!enabled()) return skip('已暂停');
  const required = config?.tables?.FishParamCfg?.data.find(row => row.paramName === '自动钓鱼')?.paramValue;
  if (!(required > 0)) return skip('缺少自动钓鱼的解锁配置');
  const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
  if (!water.building?.some(row => row.level > 0 && /^\d+钓鱼椅$/.test(row.buildingId))) return skip('尚未建成钓鱼椅');
  const level = water.fishingLevel?.level ?? 0;
  if (level < required) return skip('钓具 ' + required + ' 级开放，当前 ' + level + ' 级');

  // GameEffectId.RAW_MATERIAL_UPPER_BOUND is the server's current per-material limit.
  const effects = normalize(await client.request('GameEffectRequest', {}, 'GameEffectResponse'));
  const limit = effects.effects?.find(effect => effect.id === 16)?.value;
  if (!(limit > 0)) return skip('未能确认原料仓储上限');
  const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
  const stock = bag.items?.find(row => row.itemId === '鱼')?.num ?? 0;
  if (fishBook) {
    const book = await fishView(client, config);
    if (!book.total) return skip('图鉴目录未同步');
    if (book.names.length === book.total) {
      if (!dryRun && enabled()) onBookComplete?.();
      return skip('大鱼图鉴已集齐');
    }
  }
  if (!fishBook && stock >= limit) return skip('鱼库存已满（' + stock + '/' + limit + '）');
  if (!enabled()) return skip('已暂停');
  if (dryRun) return { planned: true, action: { kind: 'autoFish', label: '自动钓鱼一竿，鱼种与奖励以结算为准', costs: [] } };
  const cast = normalize(await client.request('StartFishingRequest', {}, 'StartFishingResponse'));
  const rewards = [...(cast.reward?.asset ?? [])];
  let catchName = '钓鱼';
  if (cast.fishId > 0) {
    // The pull meter is local to the game. Only the final landing uses a second request.
    await pause(1000);
    if (!enabled()) return skip('已暂停，未收取本竿大鱼');
    const catchResult = normalize(await client.request('GainBigFishRequest', {}, 'GainBigResponse'));
    const name = config?.tables?.FishBaseCfg?.data.find(row => row.fishId === cast.fishId)?.name;
    catchName = '钓到' + (name || '大鱼') + (catchResult.isNew ? '（新图鉴）' : '');
    rewards.push(...(catchResult.extReward?.asset ?? []));
    if (fishBook && catchResult.isNew && enabled()) {
      const book = await fishView(client, config);
      if (book.total && book.names.length === book.total && enabled()) onBookComplete?.();
    }
  }
  const totals = new Map();
  for (const asset of rewards) totals.set(asset.id, (totals.get(asset.id) ?? 0) + asset.num);
  const items = Array.from(totals, ([id, num]) => displayMaterial(config, id) + ' ×' + num);
  return { label: catchName + (items.length ? '，收获' + items.join('、') : '，本竿未获得材料'), ok: true };
}
