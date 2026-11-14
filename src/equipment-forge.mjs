import { cleanupAfterClaim } from './claim-cleanup.mjs';
// 正常装备锻造：读取配方和库存后下单，确认工厂状态，产出入库后才安排下一件。
import { exactAutomationId } from './automation-policy.mjs';
import { displayMaterial } from './config.mjs';
import { reconcileGold, reserveGold, rejectGold, cancelUnsentGold, confirmGoldOperation, refreshGoldSpend } from './gold-reservations.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialSpends, confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const universalItems = { BLUE: '蓝装材料自选包', PURPLE: '紫装材料自选包', ORANGE: '橙装材料自选包', RED: '红装材料自选包' };
const active = new WeakSet(), rejected = new WeakMap();
const keyOf = (world, buildingId) => 'forge:' + world + ':' + /^([1-9]\d*)装备厂$/.exec(buildingId)?.[1];
const claimKeyOf = (world, buildingId) => 'forgeClaim:' + world + ':' + /^([1-9]\d*)装备厂$/.exec(buildingId)?.[1];
export const forgeEnabled = settings => settings?.forge?.enabled === true;

function quantity(value) {
  if (integer(value)) return value;
  let n;
  if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) n = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

export async function readEquipmentForge(client, protocol, config, player, { enabled = () => true } = {}) {
  const worldId = exactAutomationId(player?.worldId);
  const snapshot = { now: nowOf(client), worldId, season: worldId ? Number(BigInt(worldId) / 1000000n % 1000n) : null,
    playerId: exactAutomationId(player?.playerId), forgeLevel: player?.forgeLevel ?? null, buildings: [], equipment: [], stock: new Map(), gold: null, reason: '' };
  if (!worldId || !snapshot.playerId || !integer(snapshot.season, 1)) { snapshot.reason = '无法确认当前角色和锻造赛季'; return snapshot; }
  const get = (name, response) => {
    if (!protocol?.[name] || !protocol?.[response]) throw new Error('当前协议缺少' + name);
    return client.request(name, {}, response, 8000);
  };
  try {
    await refreshGoldSpend(client, player, { enabled });
    await refreshOrderMaterialSpends(client, player, { enabled });
    const [water, items, resources, equips] = await Promise.all([
      get('OnWaterRequest', 'OnWaterResponse'), get('AllItemRequest', 'AllItemResponse'),
      get('AllResourceRequest', 'AllResourceResponse'), get('EquipsRequest', 'EquipsResponse'),
    ]);
    if (exactAutomationId(player?.playerId) !== snapshot.playerId || exactAutomationId(player?.worldId) !== snapshot.worldId) throw new Error('账号已变化，不能使用原账号锻造库存');
    if (![water.building, items.items, resources.list, equips.equip].every(Array.isArray)) throw new Error('工厂、材料、金币或装备数据不完整');
    const allowed = new Set(rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === '装备厂' && row.playerLevel <= player.level).map(row => row.buildingId));
    snapshot.buildings = water.building.filter(row => allowed.has(row.buildingId) && row.level > 0);
    for (const item of items.items) {
      if (typeof item.itemId !== 'string') throw new Error('材料标识缺失');
      const n = quantity(item.num), sum = (snapshot.stock.get(item.itemId) ?? 0) + n;
      if (n === null || !integer(sum)) throw new Error('材料数量无法精确确认');
      snapshot.stock.set(item.itemId, sum);
    }
    const gold = resources.list.find(row => row.res === 3);
    snapshot.gold = gold ? quantity(gold.amount) : null;
    if (!integer(snapshot.gold)) throw new Error('金币余额无法精确确认');
    reconcileGold(player, snapshot.gold);
    snapshot.stock.set('GOLD', snapshot.gold);
    try { confirmOrderMaterialSpends(player, snapshot.stock); }
    catch (error) { if (error.code !== 'ORDER_MATERIAL_SPEND_PENDING') throw error; }
    snapshot.equipment = equips.equip.map(row => ({ uid: exactAutomationId(row.uid), equipId: row.equipId, star: row.star }));
    if (snapshot.equipment.some(row => !row.uid || typeof row.equipId !== 'string' || !integer(row.star))) throw new Error('装备仓库含无法精确识别的记录');
    if (new Set(snapshot.equipment.map(row => row.uid)).size !== snapshot.equipment.length) throw new Error('装备仓库存在重复标识');
  } catch (error) { snapshot.reason = '锻造状态未确认：' + error.message; }
  return snapshot;
}

function observedProduct(d, snapshot) {
  if (!integer(d?.finishTime, 1) || d.finishTime > snapshot.now || !Array.isArray(d.beforeUids)) return null;
  if (d.equipId != null && typeof d.equipId !== 'string') return null;
  const making = snapshot.buildings.find(row => row.buildingId === d.buildingId)?.equipMaking;
  if (making?.makeId === d.makeId && making.finishTime === d.finishTime) return null;
  const before = new Set(d.beforeUids);
  const equipId = d.equipId || null;
  const candidates = snapshot.equipment.filter(row => !before.has(row.uid)
    && (!equipId || row.equipId === equipId)
    && (!integer(d.star) || row.star === d.star));
  // With a known product type, the type/UID pair is sufficient. If the server
  // never exposed the random product type, only a single new matching UID is
  // safe evidence; unrelated concurrent rewards must not clear the lock.
  return equipId ? candidates[0] ?? null : candidates.length === 1 ? candidates[0] : null;
}
const completedProduct = (record, snapshot) => record?.confirmed ? observedProduct(record.details, snapshot) : null;

// Explicit recovery for a confirmed start whose product was handled outside
// this tool. It is intentionally never automatic: clearing a record without
// user confirmation could permit a genuinely unknown MakeEquipRequest to be
// sent a second time. The caller must first show the idle, freshly-read state.
export function releaseStaleEquipmentForge(snapshot, ledger, buildingId) {
  if (!snapshot || snapshot.reason) throw new Error(snapshot?.reason || '锻造状态未确认，不能解除记录');
  if (typeof buildingId !== 'string' || !/^([1-9]\d*)装备厂$/.test(buildingId)) throw new Error('工厂标识无法识别');
  const building = snapshot.buildings.find(row => row.buildingId === buildingId);
  if (!building) throw new Error('装备工厂尚未建成或未解锁');
  if (building.equipMaking) throw new Error('工厂仍有锻造批次，不能解除记录');
  const key = keyOf(snapshot.worldId, buildingId), record = ledger.keyRecords()[key];
  if (!record) return { status: 'absent', key };
  if (record.details?.kind !== 'forgeStart' || !record.confirmed) throw new Error('该记录尚未确认，不能手动解除');
  if (ledger.hasKey(claimKeyOf(snapshot.worldId, buildingId))) throw new Error('领取结果仍待确认，不能解除开工记录');
  if (completedProduct(record, snapshot)) throw new Error('已观察到新装备，请刷新后由系统自动核销');
  ledger.releaseCompletedKey(key);
  return { status: 'released', key, details: record.details };
}

export function planEquipmentForge(snapshot, config, settings, { usage = { counters: {} }, keys = {} } = {}) {
  const p = settings?.forge;
  const plan = { actions: [], notes: [], factories: [], forgeLevel: snapshot.forgeLevel, gold: snapshot.gold, season: snapshot.season };
  if (!p) return plan;
  const balances = new Map(snapshot.stock);
  for (const [key, record] of Object.entries(keys)) {
    if (!key.startsWith('forge:') || record.confirmed) continue;
    if (!Array.isArray(record.details?.costs)) { plan.notes.push('存在不完整的未决锻造预算，暂不下单'); return plan; }
    for (const cost of record.details.costs) {
      if (!cost?.id || !integer(cost.num)) { plan.notes.push('未决锻造消耗记录异常'); return plan; }
      balances.set(cost.id, (balances.get(cost.id) ?? 0) - cost.num);
    }
  }
  const used = usage.counters ?? {};
  let count = used.forgeStarts ?? 0, goldSpent = used.forgeGold ?? 0;
  if (!integer(count) || !integer(goldSpent)) { plan.notes.push('锻造当日用量记录异常'); return plan; }
  if (!p.enabled) plan.notes.push('装备自动锻造未开启');
  if (snapshot.reason) plan.notes.push(snapshot.reason);
  for (const id of p.buildingIds) {
    const building = snapshot.buildings.find(row => row.buildingId === id), making = building?.equipMaking;
    const record = keys[keyOf(snapshot.worldId, id)];
    const claim = keys[claimKeyOf(snapshot.worldId, id)];
    const view = { buildingId: id, state: !building ? '未建成或未解锁' : making?.finishTime > snapshot.now ? '锻造中' : making ? '待领取' : '空闲',
      makeId: making?.makeId ?? null, finishTime: making?.finishTime ?? null, nativeAuto: building?.auto === true, recoverable: false, reason: '' };
    plan.factories.push(view);
    let reason = snapshot.reason || (!building ? '装备工厂尚未建成或未解锁' : !/^([1-9]\d*)装备厂$/.test(id) ? '工厂标识无法识别'
      : building.auto ? '游戏原生自动锻造已开启，工具不另操作' : making?.finishTime > snapshot.now ? '等待当前锻造完成'
      : claim && !observedProduct(claim.details, snapshot) ? '领取结果待确认，暂不重复领取或下单' : '');
    if (reason) { view.reason = reason; plan.notes.push(id + '：' + reason); continue; }
    if (!p.enabled || snapshot.reason) continue;
    if (making) {
      if (!integer(making.makeId, 1) || !integer(making.finishTime, 1)) reason = '当前锻造批次信息不完整';
      else if (making.finishTime >= snapshot.now) reason = '等待服务器确认制作到期';
      else if (record && (!record.confirmed || record.details?.makeId !== making.makeId || record.details?.finishTime !== making.finishTime)) reason = '当前锻造批次与待确认记录不一致';
      if (reason) { view.reason = reason; plan.notes.push(id + '：' + reason); continue; }
      plan.actions.push({ kind: 'forgeClaim', request: 'PickMadeEquipRequest', body: { buildingId: id },
        buildingId: id, uniqueKey: claimKeyOf(snapshot.worldId, id), parentKey: keyOf(snapshot.worldId, id),
        makeId: making.makeId, finishTime: making.finishTime, equipId: making.equipId || '',
        star: Object.hasOwn(making, 'star') && integer(making.star) ? making.star : null,
        costs: [], label: id + '领取已完成装备' });
      view.reason = '制作已完成，可领取'; continue;
    }
    if (record && !completedProduct(record, snapshot)) {
      reason = record.confirmed ? '等待确认上一件装备产出入库' : '上次下单结果待确认，暂不重复';
      view.recoverable = record.confirmed && !claim;
    }
    if (!reason && count >= p.dailyLimit) reason = '已达今日锻造次数上限';
    if (reason) { view.reason = reason; plan.notes.push(id + '：' + reason); continue; }
    if (!p.enabled || snapshot.reason) continue;
    const failures = [];
    for (const recipeId of p.recipeIds) {
      const recipe = rows(config, 'BuildingEquipMakeCfg').find(row => row.makeId === Number(recipeId));
      if (!recipe || !integer(recipe.season, 1) || !integer(recipe.seconds, 1) || recipe.season > snapshot.season) { failures.push('配方' + recipeId + '尚未在当前赛季开放'); continue; }
      if (!Array.isArray(recipe.costItem) || recipe.costItem.length !== 2) { failures.push('配方成本格式未确认'); continue; }
      const material = recipe.costItem.find(row => row[0] !== 'GOLD'), gold = recipe.costItem.find(row => row[0] === 'GOLD');
      if (!material || !gold || !integer(material[1], 1) || !integer(gold[1], 1)) { failures.push('配方材料或金币成本未确认'); continue; }
      const available = balances.get(material[0]) ?? 0;
      const normal = Math.min(material[1], Math.max(0, available)), shortage = material[1] - normal;
      const quality = rows(config, 'ItemCfg').find(row => row.id === material[0])?.quality;
      const universal = universalItems[quality];
      // 游戏先消耗实际持有的普通材料；不能利用万能材料开关绕过普通材料保留量。
      if (available - normal < p.materialReserve || (shortage && (!p.universal || !universal || (balances.get(universal) ?? 0) - shortage < p.universalReserve))) {
        failures.push(recipe.type + '材料不足或会低于保留量'); continue;
      }
      if ((balances.get('GOLD') ?? 0) - gold[1] < p.goldReserve) { failures.push('金币不足或会低于保留量'); continue; }
      if (goldSpent + gold[1] > p.dailyGoldLimit) { failures.push('会超过今日锻造金币预算'); continue; }
      const costs = [{ id: 'GOLD', num: gold[1] }, ...(normal ? [{ id: material[0], num: normal }] : []), ...(shortage ? [{ id: universal, num: shortage }] : [])];
      const action = { kind: 'forgeStart', request: 'MakeEquipRequest', body: { buildingId: id, makeId: recipe.makeId, universal: shortage > 0 },
        uniqueKey: keyOf(snapshot.worldId, id), buildingId: id, recipeId: recipe.makeId, costs, gold: gold[1],
        beforeFinishTime: making?.finishTime ?? 0, label: id + '锻造' + recipe.type + '（' + displayMaterial(config, material[0]) + '）' };
      plan.actions.push(action); view.reason = '可安排所选配方';
      for (const cost of costs) balances.set(cost.id, (balances.get(cost.id) ?? 0) - cost.num);
      goldSpent += gold[1]; count++; break;
    }
    if (!plan.actions.some(action => action.buildingId === id)) { view.reason = [...new Set(failures)].join('；') || '未选择可用配方'; plan.notes.push(id + '：' + view.reason); }
  }
  return plan;
}

function reconcile(snapshot, ledger, onStep) {
  if (snapshot.reason) return;
  // 领取记录先核对。明确看到工厂批次结束且出现新UID，才释放领取与制作的记录。
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!key.startsWith('forgeClaim:' + snapshot.worldId + ':') || record.details?.kind !== 'forgeClaim') continue;
    const product = observedProduct(record.details, snapshot);
    if (!product) continue;
    const parent = keyOf(snapshot.worldId, record.details.buildingId);
    if (ledger.hasKey(parent)) { ledger.resolveKey(parent, true); ledger.releaseCompletedKey(parent); }
    ledger.resolveKey(key, true); ledger.releaseCompletedKey(key);
    onStep?.({ step: { kind: 'forgeComplete', label: record.details.buildingId + '锻造产出已领取入库' }, ok: true, status: 'completed', note: product.equipId + ' · ' + product.star + '星' });
  }
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!key.startsWith('forge:' + snapshot.worldId + ':')) continue;
    let data = record.details;
    if (data?.kind !== 'forgeStart' || !integer(data.makeId, 1) || !integer(data.beforeFinishTime) || !Array.isArray(data.beforeUids)) continue;
    const building = snapshot.buildings.find(row => row.buildingId === data.buildingId), making = building?.equipMaking;
    if (making?.makeId === data.makeId && making.finishTime > data.beforeFinishTime && making.finishTime >= data.sentAt
      && (!record.confirmed || !data.equipId || !integer(data.star))) {
      data = { ...data, finishTime: making.finishTime };
      if (typeof making.equipId === 'string' && making.equipId) data.equipId = making.equipId;
      if (integer(making.star)) data.star = making.star;
      else if (!integer(data.star)) delete data.star;
      ledger.updateKeyDetails(key, data);
      if (!record.confirmed) ledger.resolveKey(key, true);
    }
    const product = completedProduct(ledger.keyRecords()[key], snapshot);
    if (product && !ledger.hasKey(claimKeyOf(snapshot.worldId, data.buildingId))) {
      ledger.releaseCompletedKey(key);
      onStep?.({ step: { kind: 'forgeComplete', label: data.buildingId + '锻造产出已入库' }, ok: true, status: 'completed', note: product.equipId + ' · ' + product.star + '星' });
    }
  }
}

export async function runEquipmentForge(client, protocol, config, player, { getSettings, ledger, enabled = () => true, onStep } = {}) {
  if (!forgeEnabled(getSettings?.()) || !enabled() || active.has(client)) return { actions: [], results: [], notes: [] };
  if (!ledger?.updateKeyDetails || !ledger?.releaseCompletedKey) throw new Error('缺少持久锻造任务记录');
  active.add(client);
  const results = [], report = entry => { results.push(entry); onStep?.(entry); };
  try {
    const read = () => readEquipmentForge(client, protocol, config, player, { enabled });
    const snapshot = await read(); reconcile(snapshot, ledger, report);
    const plan = planEquipmentForge(snapshot, config, getSettings(), { usage: ledger.snapshot(), keys: ledger.keyRecords() });
    const balances = new Map(snapshot.stock);
    for (const proposed of plan.actions) {
      if (!enabled() || !forgeEnabled(getSettings()) || !client.connected) break;
      const settings = getSettings(), fresh = await read(), actualStock = new Map(fresh.stock);
      for (const [id, amount] of balances) fresh.stock.set(id, Math.min(fresh.stock.get(id) ?? 0, amount));
      const reviewed = planEquipmentForge(fresh, config, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords() });
      const step = reviewed.actions.find(action => action.uniqueKey === proposed.uniqueKey && action.kind === proposed.kind &&
        (action.kind !== 'forgeClaim' || (action.makeId === proposed.makeId && action.finishTime === proposed.finishTime)) &&
        JSON.stringify(action.body) === JSON.stringify(proposed.body) && JSON.stringify(action.costs) === JSON.stringify(proposed.costs));
      if (!step || settings !== getSettings() || !enabled() || exactAutomationId(player.playerId) !== fresh.playerId || exactAutomationId(player.worldId) !== fresh.worldId) continue;
      if ((rejected.get(client)?.get(step.uniqueKey) ?? 0) > Date.now()) continue;
      if (step.kind === 'forgeClaim') {
        if (!protocol.PickMadeEquipRequest || !protocol.PickMadeEquipResponse) throw new Error('当前协议缺少装备领取能力');
        const details = { kind: 'forgeClaim', buildingId: step.buildingId, makeId: step.makeId, finishTime: step.finishTime,
          equipId: step.equipId, star: step.star, beforeUids: fresh.equipment.map(row => row.uid), sentAt: fresh.now };
        const ticket = ledger.reserve({}, {}, {}, { uniqueKey: step.uniqueKey, details });
        if (!enabled() || settings !== getSettings() || !client.connected) { ledger.cancel(ticket); break; }
        let entry, after;
        try {
          const reply = await client.request('PickMadeEquipRequest', step.body, 'PickMadeEquipResponse', 15000);
          if (typeof reply?.equipId === 'string' && reply.equipId) ledger.updateKeyDetails(step.uniqueKey, { ...details, equipId: reply.equipId, star: null });
          after = await read(); reconcile(after, ledger);
          const confirmed = !ledger.hasKey(step.uniqueKey);
          entry = { step, ok: confirmed, sent: true, status: confirmed ? 'confirmed' : 'unknown',
            note: confirmed ? '服务器已确认装备领取入库' : '领取请求已发送，工厂或新装备尚未确认；停止重复领取和下单' };
        } catch (error) {
          if (error.prompt && error.request === 'PickMadeEquipRequest') {
            ledger.cancel(ticket);
            const failures = rejected.get(client) ?? new Map(); rejected.set(client, failures); failures.set(step.uniqueKey, Date.now() + 300000);
            entry = { step, ok: false, status: 'rejected', error: error.message };
          } else entry = { step, ok: false, status: 'unknown', error: '领取结果未知，保留任务锁定：' + error.message };
        }
        report(entry);
        if (entry.status === 'unknown') break;
        if (entry.status === 'confirmed' && after && enabled() && settings === getSettings()) {
          const cleanup=await cleanupAfterClaim(client,config,settings,ledger,'forge',()=>enabled()&&client.connected&&settings===getSettings());
          if(cleanup)report({...cleanup,step:{kind:'forgeDecompose',label:cleanup.label}});
          const next = planEquipmentForge(after, config, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords() }).actions.find(row => row.kind === 'forgeStart' && row.buildingId === step.buildingId);
          if (next) plan.actions.push(next);
        }
        continue;
      }
      const details = { kind: 'forgeStart', buildingId: step.buildingId, makeId: step.recipeId, costs: step.costs,
        beforeFinishTime: step.beforeFinishTime, beforeUids: fresh.equipment.map(row => row.uid), sentAt: fresh.now };
      const ticket = ledger.reserve({ forgeStarts: 1, forgeGold: step.gold }, { forgeStarts: settings.forge.dailyLimit, forgeGold: settings.forge.dailyGoldLimit }, {}, { uniqueKey: step.uniqueKey, details });
      if (!enabled() || settings !== getSettings() || !client.connected) { ledger.cancel(ticket); break; }
      let goldReservation, materialReservation;
      const { buildingId, makeId, beforeFinishTime, sentAt } = details;
      const operation = { async verify(current) {
        const water = await current.request('OnWaterRequest', {}, 'OnWaterResponse');
        if (!Array.isArray(water?.building)) return false;
        const matches = water.building.filter(row => row.buildingId === buildingId);
        const making = matches.length === 1 ? matches[0].equipMaking : null;
        return making?.makeId === makeId && integer(making.finishTime, 1)
          && making.finishTime > beforeFinishTime && making.finishTime >= sentAt;
      } };
      try {
        confirmOrderMaterialSpends(player, actualStock);
        materialReservation = beginOrderMaterialSpend(player, step.costs.filter(cost => cost.id !== 'GOLD').map(cost => ({ id: cost.id, have: actualStock.get(cost.id) ?? 0, need: cost.num })), step.label, { operation });
        goldReservation = reserveGold(player, fresh.gold, step.gold, 'MakeEquipRequest', { operation });
      } catch (error) { cancelOrderMaterialSpend(materialReservation); cancelUnsentGold(goldReservation); ledger.cancel(ticket); report({ step, ok: false, skipped: true, error: error.message }); continue; }
      if (!enabled() || settings !== getSettings() || !client.connected) { cancelOrderMaterialSpend(materialReservation); cancelUnsentGold(goldReservation); ledger.cancel(ticket); break; }
      let entry;
      try {
        await client.sendWatch('MakeEquipRequest', step.body, { window: 600 });
        const after = await read(); reconcile(after, ledger, report);
        const record = ledger.keyRecords()[step.uniqueKey];
        const confirmed = !record || record.confirmed;
        if (confirmed && !after.reason) {
          confirmGoldOperation(goldReservation);
          confirmOrderMaterialOperation(materialReservation);
          await refreshGoldSpend(client, player, { enabled });
          await refreshOrderMaterialSpends(client, player, { enabled });
        }
        entry = { step, ok: confirmed, sent: true, status: confirmed ? 'confirmed' : 'unknown',
          note: confirmed ? '服务器已确认新的锻造任务' : '下单结果待确认，保留材料/金币预算并停止重复下单' };
      } catch (error) {
        if (error.notSent === true) {
          cancelOrderMaterialSpend(materialReservation);
          cancelUnsentGold(goldReservation);
          ledger.cancel(ticket);
          entry = { step, ok: false, skipped: true, status: 'cancelled', error: error.message };
        } else if (error.prompt && error.request === 'MakeEquipRequest') {
          cancelOrderMaterialSpend(materialReservation);
          rejectGold(goldReservation, error);
          ledger.cancel(ticket);
          const failures = rejected.get(client) ?? new Map(); rejected.set(client, failures); failures.set(step.uniqueKey, Date.now() + 300000);
          entry = { step, ok: false, status: 'rejected', error: error.message };
        } else entry = { step, ok: false, status: 'unknown', error: '锻造结果未知，保留预算：' + error.message };
      }
      report(entry);
      if (entry.status !== 'rejected') for (const cost of step.costs) balances.set(cost.id, (balances.get(cost.id) ?? 0) - cost.num);
      if (entry.status === 'unknown') break;
    }
    return { ...plan, results };
  } finally { active.delete(client); }
}
