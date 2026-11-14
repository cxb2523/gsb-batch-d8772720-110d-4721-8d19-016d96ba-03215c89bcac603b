import { readEquipmentCrafting, collectEquipmentCraft, startEquipmentCraft } from './equipment-crafting.mjs';
import { uidText } from './hero-equipment.mjs';

export const equipmentCraftGoldReserve = 10_000;
const collectKey = 'equipmentCollect';
const craftKey = 'equipmentCraft';
const keys = [collectKey, craftKey];
const names = {
  [collectKey]: '装备厂自动收取',
  [craftKey]: '装备厂自动制造（保留 10,000 金币）',
};
const types = ['武器', '防具', '饰品'];
const busy = new WeakSet();
const rows = (config, table) => config?.tables?.[table]?.data ?? [];

async function chooseRecipe(client, config, view) {
  const bases = rows(config, 'EquipCfg');
  const libraries = rows(config, 'EquipMakeLibCfg');
  const recipes = rows(config, 'BuildingEquipMakeCfg');
  if (!bases.length || !libraries.length || !recipes.length) throw new Error('缺少装备部位或制造品质配置');
  const byId = new Map(bases.map(row => [row.id, row]));
  if (byId.size !== bases.length) throw new Error('装备配置编号不唯一');
  const [inventory, roster] = await Promise.all([
    client.request('EquipsRequest', {}, 'EquipsResponse'),
    client.request('AllHeroRequest', {}, 'AllHeroResponse'),
  ]);
  const bag = inventory?.equip;
  if (!Array.isArray(bag)) throw new Error('未能读取装备仓库，无法选择制造部位');
  if (!Array.isArray(roster?.heroes)) throw new Error('未能读取英雄装备归属，无法选择制造部位');
  const worn = new Set();
  for (const hero of roster.heroes) {
    if (hero.equips != null && !Array.isArray(hero.equips)) throw new Error('无法确认英雄装备归属');
    for (const equip of hero.equips ?? []) {
      const uid = uidText(equip?.uid);
      if (!uid || worn.has(uid)) throw new Error('无法确认英雄装备归属');
      worn.add(uid);
    }
  }
  const counts = new Map(types.map(type => [type, 0]));
  const ids = new Set();
  for (const equip of bag) {
    const uid = uidText(equip?.uid);
    const base = byId.get(equip?.equipId);
    if (!uid || ids.has(uid) || !types.includes(base?.type)) throw new Error('无法确认装备仓库的编号或部位');
    ids.add(uid);
    if (!worn.has(uid)) counts.set(base.type, counts.get(base.type) + 1);
  }
  for (const uid of worn) if (!ids.has(uid)) throw new Error('英雄装备与仓库记录不一致');
  if (view.job) {
    const making = recipes.find(row => row.makeId === view.job.makeId);
    if (!types.includes(making?.type)) throw new Error('无法确认在造装备部位');
    counts.set(making.type, counts.get(making.type) + 1);
  }

  const candidates = [];
  let reserveLimited = false;
  for (const recipe of view.recipes) {
    if (!recipe.canStart) continue;
    const gold = recipe.costs.find(cost => cost.id === 'GOLD');
    if (!gold) throw new Error('无法确认装备制造的金币成本');
    if (gold.have - gold.need < equipmentCraftGoldReserve) { reserveLimited = true; continue; }
    const definitions = recipes.filter(row => row.makeId === recipe.makeId);
    const definition = definitions[0];
    if (definitions.length !== 1 || !types.includes(recipe.type) || definition.type !== recipe.type) {
      throw new Error('无法确认装备制造的配方或部位');
    }
    const outcomes = libraries.filter(row => row.libId === definition.libId);
    if (!outcomes.length) throw new Error('缺少所选配方的装备产物配置');
    const qualities = outcomes.map(outcome => {
      const base = byId.get(outcome.equipId);
      if (!(Number.isFinite(outcome.rate) && outcome.rate > 0) || base?.type !== recipe.type
        || !Number.isSafeInteger(base.qualityIndex) || base.qualityIndex < 1) {
        throw new Error('无法确认装备制造的产物品质');
      }
      return base.qualityIndex;
    });
    // Use the lowest possible quality, so a mixed reward pool is not treated as
    // a guaranteed high-quality recipe. The current game pools share one tier.
    candidates.push({ recipe, count: counts.get(recipe.type), quality: Math.min(...qualities), gold: gold.need });
  }
  candidates.sort((a, b) => a.count - b.count || b.quality - a.quality || a.gold - b.gold
    || a.recipe.makeId - b.recipe.makeId);
  return { recipe: candidates[0]?.recipe, reason: reserveLimited
    ? '制造后需保留至少 10,000 金币，当前没有符合条件的配方'
    : '当前没有材料齐备的可制造配方' };
}

export async function serviceEquipmentCrafting(client, config, {
  player, enabled = () => false, report = () => {}, scheduler,
} = {}) {
  const selected = new Set(keys.filter(key => enabled(key) && (!scheduler || scheduler.due(key))));
  if (!selected.size) return;
  const active = key => selected.has(key) && enabled(key);
  const skip = (key, reason) => { if (active(key)) report({ key, label: names[key], skipped: true, reason }); };
  if (busy.has(client)) {
    for (const key of keys) skip(key, '装备厂正在处理上一次自动操作');
    return;
  }
  busy.add(client);
  const deadlines = new Map();
  const waitForJob = view => {
    if (view.state === 'making' && view.job?.finishTime > view.serverNow) {
      for (const key of keys) if (active(key)) deadlines.set(key, view.job.finishTime);
    }
  };
  let operation = active(collectKey) ? collectKey : craftKey;
  try {
    let view = await readEquipmentCrafting(client, config, player);
    if (active(collectKey)) {
      if (view.state === 'ready' && view.job?.previewKey) {
        const result = await collectEquipmentCraft(client, config, player, {
          buildingId: view.buildingId, previewKey: view.job.previewKey, enabled: () => active(collectKey),
        });
        report({ key: collectKey, label: result.label, ok: true });
        // A successful pickup is not a manufacturing preview. Re-read stock,
        // queue, season and recipe tokens before considering the next batch.
        if (!active(craftKey)) return;
        operation = craftKey;
        view = await readEquipmentCrafting(client, config, player);
      } else {
        skip(collectKey, view.reason || '装备厂暂无待收取产物');
      }
    }
    waitForJob(view);
    if (!active(craftKey)) return;
    operation = craftKey;
    if (view.state !== 'idle' || view.reason) {
      skip(craftKey, view.reason || '装备厂未空闲');
      return;
    }
    const choice = await chooseRecipe(client, config, view);
    if (!active(craftKey)) return;
    if (!choice.recipe) { skip(craftKey, choice.reason); return; }
    const result = await startEquipmentCraft(client, config, player, {
      buildingId: view.buildingId, makeId: choice.recipe.makeId, previewKey: choice.recipe.previewKey,
      goldReserve: equipmentCraftGoldReserve, enabled: () => active(craftKey),
    });
    report({ key: craftKey, label: result.label + '（保留至少 10,000 金币）', ok: true });
    // At most one start per call. Scheduling uses confirmed server queue data.
    if (keys.some(active)) waitForJob(await readEquipmentCrafting(client, config, player));
  } catch (error) {
    // A lost pickup acknowledgement must never lead to a new manufacturing
    // request in this round; the next round starts with a fresh server read.
    if (active(operation)) report({ key: operation, label: names[operation], ok: false, error: error.message });
  } finally {
    busy.delete(client);
    // enabled may itself consult scheduler.due(), so defer only after every
    // possible write and its live setting check have finished.
    for (const [key, until] of deadlines) scheduler?.defer(key, until);
  }
}
