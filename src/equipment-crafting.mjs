import { createHash, randomUUID } from 'node:crypto';
import { toNumber } from './client.mjs';
import { displayMaterial } from './config.mjs';
import { uidText } from './hero-equipment.mjs';
import { goldAccountKey, reserveGold, rejectGold, cancelUnsentGold, confirmGoldOperation, refreshGoldSpend } from './gold-reservations.mjs';

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const busy = new WeakSet();
const previews = new WeakMap();

function list(value, description) {
  if (!Array.isArray(value)) throw new Error('未能读取' + description);
  return value;
}

async function buildings(client) {
  return list((await client.request('OnWaterRequest', {}, 'OnWaterResponse'))?.building, '海面建筑');
}

function factoryAt(all, buildingId) {
  const plots = all.filter(b => b.buildingId === buildingId);
  if (plots.length > 1) throw new Error('装备厂地块不唯一，请刷新');
  return plots[0];
}

async function materialStock(client) {
  const [bag, resources] = await Promise.all([
    client.request('AllItemRequest', {}, 'AllItemResponse'),
    client.request('AllResourceRequest', {}, 'AllResourceResponse'),
  ]);
  const stock = new Map();
  function add(id, raw) {
    const amount = (stock.get(id) || 0) + toNumber(raw);
    if (!id || raw == null || !Number.isSafeInteger(amount) || amount < 0) throw new Error('无法确认装备厂材料库存');
    stock.set(id, amount);
  }
  for (const item of list(bag?.items, '道具库存')) add(item.itemId, item.num);
  for (const row of list(resources?.list, '资源库存')) if (row.res === 3) add('GOLD', row.amount);
  return stock;
}

function costs(config, entries, stock) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('缺少装备厂材料配置');
  const seen = new Set();
  return entries.map(([id, need]) => {
    if (!id || seen.has(id) || !Number.isSafeInteger(need) || need < 1) throw new Error('装备厂材料配置有误');
    seen.add(id);
    const sources = new Set(config.materialSources?.(id) ?? []);
    const recipe = rows(config, 'BuildingProduceCfg').find(row => row.itemId === id);
    if (recipe) {
      const name = rows(config, 'BuildingCfg').find(row => row.buildingType === recipe.buildType)?.name ?? recipe.buildType;
      sources.add(name + ' ' + recipe.unlockLevel + ' 级');
    }
    return { id, name: displayMaterial(config, id), need, have: stock.get(id) ?? 0, sources: [...sources] };
  });
}

function recipeName(config, recipe) {
  const materialId = recipe.costItem?.[0]?.[0];
  const material = rows(config, 'ItemCfg').find(row => row.id === materialId);
  return material?.descParams?.slice(1, 3).join('') || recipe.type + '（' + displayMaterial(config, materialId) + '）';
}

function workOrder(plot) {
  const job = plot?.equipMaking;
  if (job == null) return null;
  if (!(job.makeId || job.finishTime || job.equipId || job.star)) return null;
  const star = Object.hasOwn(job, 'star') ? job.star : null;
  if (!(Number.isSafeInteger(job.makeId) && job.makeId > 0 && Number.isSafeInteger(job.finishTime) && job.finishTime > 0
    && (star === null || (Number.isSafeInteger(star) && star >= 0)))) throw new Error('无法确认装备制作队列，请刷新');
  return { makeId: job.makeId, finishTime: job.finishTime, equipId: job.equipId || '', star };
}

// An idle factory can return to exactly the same state after a batch. Invalidate
// its displayed buttons on every attempted write, including a lost reply.
function previewToken(client, signature) {
  const saved = previews.get(client);
  if (saved?.signature === signature) return saved.token;
  const token = randomUUID();
  previews.set(client, { signature, token });
  return token;
}

function constructionReason(unlock, all, buildCosts) {
  const missing = (unlock.condition ?? []).filter(([id, level]) => !(all.find(b => b.buildingId === id)?.level >= level));
  if (missing.length) return '先建成' + missing.map(([id, level]) => id + ' ' + level + ' 级').join('、');
  const short = buildCosts.filter(c => c.have < c.need);
  return short.length ? '建厂还缺' + short.map(c => c.name + ' ×' + (c.need - c.have)).join('、')
    : '建厂材料已齐，可在海面建造装备厂';
}

export async function readEquipmentCrafting(client, config, player, { enabled = () => true } = {}) {
  const unlock = rows(config, 'BuildingUnlockCfg').find(row => row.buildingType === '装备厂');
  if (!unlock?.buildingId || !(unlock.playerLevel > 0)) throw new Error('缺少装备厂开放配置');
  const world = toNumber(player?.worldId);
  const season = Number.isSafeInteger(world) && world > 0 ? Math.floor(world / 1e6) % 1000 : 0;
  const view = { buildingId: unlock.buildingId, requiredLevel: unlock.playerLevel, season, serverNow: now(client),
    state: 'locked', reason: '', buildCosts: [], buildFinishTime: 0, job: null, recipes: [] };
  if (!Number.isSafeInteger(player?.level) || player.level < unlock.playerLevel) {
    previews.delete(client);
    view.reason = '角色 ' + unlock.playerLevel + ' 级开放装备厂';
    return view;
  }
  await refreshGoldSpend(client, player, { enabled });
  const [all, stock] = await Promise.all([buildings(client), materialStock(client)]);
  view.serverNow = now(client);
  const plot = factoryAt(all, unlock.buildingId);
  if (plot && (!Number.isSafeInteger(plot.level) || plot.level < 0)) throw new Error('无法确认装备厂等级');
  view.buildCosts = costs(config, unlock.consume, stock);
  view.buildFinishTime = plot?.buildFinishTime || 0;
  if (plot?.buildStartTime > 0 || view.buildFinishTime > 0) {
    view.state = 'building';
    view.reason = view.buildFinishTime > view.serverNow ? '装备厂施工中' : '装备厂等待竣工';
  } else if (!plot?.level) {
    view.state = 'unbuilt';
    view.reason = constructionReason(unlock, all, view.buildCosts);
  }
  if (view.state === 'building' || view.state === 'unbuilt') {
    previews.delete(client);
    return view;
  }
  const job = workOrder(plot);
  if (job) {
    view.state = job.finishTime <= view.serverNow ? 'ready' : 'making';
    view.reason = view.state === 'ready' ? '本批装备已完成' : '本批装备制作中';
  } else {
    view.state = 'idle';
  }
  if (plot?.auto) view.reason = '装备厂已开启游戏内自动锻造';
  if (view.state === 'idle' && !season && !view.reason) view.reason = '无法确认当前赛季';
  const token = previewToken(client, JSON.stringify([unlock.buildingId, view.state, Boolean(plot?.auto), season, job]));
  const recipes = rows(config, 'BuildingEquipMakeCfg');
  if (!recipes.length) throw new Error('缺少装备制造配方');
  if (job) {
    const cfg = recipes.find(r => r.makeId === job.makeId);
    view.job = { ...job, name: cfg ? recipeName(config, cfg) : '装备',
      equipName: rows(config, 'EquipCfg').find(r => r.id === job.equipId)?.name || job.equipId || '待出炉',
      previewKey: view.state === 'ready' && !plot?.auto ? token : null };
  }
  view.recipes = recipes.filter(r => r.season > 0 && r.season <= season).map(recipe => {
    if (!(Number.isSafeInteger(recipe.makeId) && recipe.makeId > 0 && Number.isSafeInteger(recipe.seconds) && recipe.seconds > 0)) {
      throw new Error('装备制作配方有误');
    }
    const materials = costs(config, recipe.costItem, stock);
    const missing = materials.filter(c => c.have < c.need);
    const reason = view.state !== 'idle' || plot?.auto ? (view.reason || '装备厂未空闲')
      : missing.length ? '还缺' + missing.map(c => c.name + ' ×' + (c.need - c.have)).join('、') : '';
    const previewKey = reason ? null : createHash('sha256').update(JSON.stringify([token, recipe.makeId, recipe.seconds, recipe.costItem])).digest('hex');
    return { makeId: recipe.makeId, name: recipeName(config, recipe), type: recipe.type,
      seconds: recipe.seconds, costs: materials, canStart: !reason, reason, previewKey };
  });
  return view;
}

export async function startEquipmentCraft(client, config, player, { buildingId, makeId, previewKey, goldReserve = 0, enabled = () => true }) {
  if (!Number.isSafeInteger(goldReserve) || goldReserve < 0) throw new Error('装备制造金币保留额无效');
  const account = goldAccountKey(player);
  if (busy.has(client)) throw new Error('装备厂正在处理上一次操作');
  busy.add(client);
  try {
    const view = await readEquipmentCrafting(client, config, player, { enabled });
    const recipe = view.recipes.find(row => row.makeId === makeId);
    if (buildingId !== view.buildingId || !recipe) throw new Error('没有找到所选装备厂或赛季配方，请刷新');
    if (!recipe.canStart) throw new Error(recipe.reason);
    const gold = recipe.costs.find(cost => cost.id === 'GOLD');
    if (goldReserve > 0 && (!gold || gold.have - gold.need < goldReserve)) {
      throw new Error('装备制造后需保留至少 ' + goldReserve.toLocaleString('zh-CN') + ' 金币');
    }
    if (!previewKey || recipe.previewKey !== previewKey) throw new Error('装备厂或配方已变化，请重新确认');
    if (!enabled() || goldAccountKey(player) !== account) throw new Error('账号已暂停或连接已更换');
    const sentAt = now(client);
    const reservation = reserveGold(player, gold?.have, gold?.need, 'MakeEquipRequest', { operation: {
      async verify(current) {
        const job = workOrder(factoryAt(await buildings(current), buildingId));
        return job?.makeId === makeId && job.finishTime >= sentAt;
      },
    } });
    previews.delete(client);
    try { await client.sendWatch('MakeEquipRequest', { buildingId, makeId, universal: false }); }
    catch (error) {
      if (error.notSent === true) cancelUnsentGold(reservation); else rejectGold(reservation, error);
      throw error;
    }
    const job = workOrder(factoryAt(await buildings(client), buildingId));
    if (!enabled() || goldAccountKey(player) !== account) throw new Error('账号已暂停或连接已更换，保留装备开工记录');
    if (job?.makeId !== makeId || job.finishTime < sentAt) throw new Error('服务端未确认本批装备开工，请刷新队列');
    confirmGoldOperation(reservation);
    await refreshGoldSpend(client, player, { enabled });
    return { label: '装备厂已开始制作' + recipe.name };
  } finally {
    busy.delete(client);
  }
}

async function equipmentInventory(client) {
  const result = new Map();
  const bag = list((await client.request('EquipsRequest', {}, 'EquipsResponse'))?.equip, '装备仓库');
  for (const equip of bag) {
    const uid = uidText(equip?.uid);
    if (!uid || result.has(uid)) throw new Error('无法确认仓库中的装备编号');
    result.set(uid, equip);
  }
  return result;
}

export async function collectEquipmentCraft(client, config, player, { buildingId, previewKey, enabled = () => true }) {
  if (busy.has(client)) throw new Error('装备厂正在处理上一次操作');
  busy.add(client);
  try {
    const view = await readEquipmentCrafting(client, config, player);
    if (buildingId !== view.buildingId || view.state !== 'ready' || !previewKey || view.job?.previewKey !== previewKey) {
      throw new Error('本批装备尚未完成或队列已变化，请刷新');
    }
    const before = await equipmentInventory(client);
    const current = factoryAt(await buildings(client), buildingId);
    const currentJob = workOrder(current);
    if (!(current?.level > 0) || current.auto || !currentJob || currentJob.finishTime > now(client)
      || Object.entries(currentJob).some(([key, value]) => view.job[key] !== value)) throw new Error('装备制作队列已变化，请重新确认');
    if (!enabled()) throw new Error('账号已暂停或连接已更换');
    previews.delete(client);
    const reply = await client.request('PickMadeEquipRequest', { buildingId }, 'PickMadeEquipResponse');
    if (!reply?.equipId || (view.job.equipId && reply.equipId !== view.job.equipId)) throw new Error('服务端未确认本批装备的产物，请刷新');
    const [all, after] = await Promise.all([buildings(client), equipmentInventory(client)]);
    const plot = factoryAt(all, buildingId);
    const gained = [...after].filter(([uid, equip]) => !before.has(uid) && equip.equipId === reply.equipId
      && (view.job.star === null || (equip.star ?? 0) === view.job.star));
    if (!(plot?.level > 0) || workOrder(plot) || gained.length !== 1) throw new Error('未能同时确认队列清空和新装备入库，请刷新');
    const name = rows(config, 'EquipCfg').find(r => r.id === reply.equipId)?.name || reply.equipId;
    return { label: '装备厂已收取' + name + '（' + (gained[0][1].star ?? 0) + ' 星）' };
  } finally {
    busy.delete(client);
  }
}
