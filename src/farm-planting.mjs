import { goldAccountKey } from './gold-reservations.mjs';
import { normalize } from './worlds.mjs';
import { pendingFarmMaterialSpends, settleFarmMaterialSpend } from './order-reservations.mjs';

export function farmPlantArgs(step) {
  const args = step.body?.args;
  if (!Array.isArray(args) || !args.length || args.some(arg =>
    typeof arg?.buildingId !== 'string' || !arg.buildingId || typeof arg.productId !== 'string' || !arg.productId)
    || new Set(args.map(arg => arg.buildingId)).size !== args.length) {
    throw new Error('无法确认播种地块和作物');
  }
  return args.map(({ buildingId, productId }) => ({ buildingId, productId }));
}

export function farmInventory(bag) {
  if (!Array.isArray(bag?.items)) throw new Error('无法确认当前道具余额');
  const stock = new Map();
  for (const row of bag.items) {
    const id = row?.itemId ?? row?.id;
    if (typeof id !== 'string' || !id || stock.has(id) || !Number.isSafeInteger(row.num) || row.num < 0) {
      throw new Error('无法完整确认当前道具库存');
    }
    stock.set(id, row.num);
  }
  return stock;
}

export function captureFarmMaterialState(player) {
  const handles = pendingFarmMaterialSpends(player);
  return handles.length ? { account: goldAccountKey(player), handles } : null;
}

function completeBuildings(water) {
  return Array.isArray(water?.building)
    && water.building.every(row => typeof row?.buildingId === 'string' && row.buildingId)
    && new Set(water.building.map(row => row.buildingId)).size === water.building.length;
}

// Capture the handles before reading, so a late snapshot cannot settle a newer
// operation. A failed farm read must not stop consumers of unrelated materials.
export async function readFarmMaterialState(client, player, { step = null, enabled = () => true } = {}) {
  const handles = pendingFarmMaterialSpends(player);
  if (!step && !handles.length) return null;
  if (step) farmPlantArgs(step);
  const account = goldAccountKey(player);
  const check = () => {
    if (!enabled()) throw new Error('操作已暂停');
    if (goldAccountKey(player) !== account) throw new Error('账号已切换，不能使用原账号农田状态');
  };
  check();
  let water;
  try {
    water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    if (!completeBuildings(water)) {
      throw new Error('无法完整确认农田状态');
    }
  } catch (error) {
    check();
    if (step) throw error;
    return { account, handles, error: error.message, water: null };
  }
  check();
  return { account, handles, water };
}

// This is deliberately farm-only: first observe the crop on its previously empty
// plot, THEN read a complete inventory. That later balance may include newly made
// seeds, so it must not be compared to an old absolute debit threshold forever.
export function settleFarmMaterialState(player, snapshot, stock) {
  if (!completeBuildings(snapshot?.water)) return;
  if (goldAccountKey(player) !== snapshot.account) throw new Error('账号已切换，不能结算原账号播种');
  if (!(stock instanceof Map)) throw new Error('未能确认播种后的库存');
  for (const handle of snapshot.handles) {
    const planted = handle.farm.args.every(arg => {
      const plot = snapshot.water.building.find(row => row.buildingId === arg.buildingId);
      const farm = plot?.farm;
      return Number.isSafeInteger(plot?.level) && plot.level > 0 && farm?.productId === arg.productId
        && Number.isSafeInteger(farm.plantTime) && farm.plantTime > 0
        && Number.isSafeInteger(farm.ripeTime) && farm.ripeTime >= farm.plantTime;
    });
    if (planted) settleFarmMaterialSpend(player, handle);
  }
}

export function assertFarmPlantingReady(player, step, snapshot) {
  const args = farmPlantArgs(step);
  if (!snapshot?.water) throw new Error('未能确认播种前的农田状态');
  if (snapshot.water.autoFarming === true) throw new Error('游戏内自动种植已开启，等待重新安排');
  const pending = pendingFarmMaterialSpends(player).find(handle =>
    handle.farm.args.some(old => args.some(arg => arg.buildingId === old.buildingId)));
  if (pending) throw new Error((pending.label || '上次播种') + '的地块结果尚未确认，暂不重复播种');
  for (const arg of args) {
    const plot = snapshot.water.building.find(row => row.buildingId === arg.buildingId);
    if (!Number.isSafeInteger(plot?.level) || plot.level < 1 || plot.buildStartTime > 0 || plot.buildFinishTime > 0) {
      throw new Error('播种地块未建成、正在升级或状态缺失');
    }
    if (plot.farm != null && (typeof plot.farm !== 'object'
      || (plot.farm.productId != null && typeof plot.farm.productId !== 'string'))) {
      throw new Error('播种地块的作物状态异常');
    }
    if (plot.farm?.productId) throw new Error('播种地块已有作物，等待重新安排');
  }
}
