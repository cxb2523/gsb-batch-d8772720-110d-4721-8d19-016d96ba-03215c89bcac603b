import { toNumber } from './client.mjs';
import { uidText } from './hero-equipment.mjs';
import { reconcileGold, reserveGold, rejectGold, cancelUnsentGold, confirmGoldOperation, refreshGoldSpend } from './gold-reservations.mjs';

export const petBreedGoldReserve = 10_000;
const keys = ['petCollect', 'petBreed'];
const labels = { petCollect: '领取成熟海兽', petBreed: '海兽培育（最高橙色，保留 10,000 金币）' };
const busy = new Set();
// Requests contain no operation ID. Keep unknown outcomes across connections,
// scoped to the exact role and world, until server state proves what happened.
const pending = new Map();
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const qualityRank = { BLUE: 1, PURPLE: 2, ORANGE: 3 };
const qualityText = { BLUE: '蓝', PURPLE: '紫', ORANGE: '橙' };

function number(raw, title, minimum = 0) {
  const n = raw == null ? NaN : toNumber(raw);
  if (!Number.isSafeInteger(n) || n < minimum) throw new Error('无法确认' + title);
  return n;
}

function list(raw, title) {
  if (!Array.isArray(raw)) throw new Error('未能读取' + title);
  return raw;
}

function identity(player) {
  const uid = uidText(player?.playerId);
  const world = number(player?.worldId, '账号区服', 1);
  if (!uid) throw new Error('无法确认海兽培育账号');
  return JSON.stringify([uid, world]);
}

function petKind(pet) {
  if (typeof pet?.petId !== 'string' || !pet.petId) throw new Error('无法确认海兽品种');
  return JSON.stringify([pet.petId, number(pet.star, '海兽星级')]);
}

function counts(pets) {
  const result = new Map();
  for (const pet of pets) {
    const kind = petKind(pet);
    result.set(kind, (result.get(kind) ?? 0) + 1);
  }
  return result;
}

function jobKey(job) { return JSON.stringify([job.idx, job.petId, job.startTime, job.finishTime]); }
// Feeding/speed-ups may change finishTime without creating a new queue entry.
function jobIdentity(job) { return JSON.stringify([job.idx, job.petId, job.startTime]); }

async function read(client, protocol, name, active) {
  if (!active()) throw new Error('账号已暂停或连接已更换');
  const response = name.replace(/Request$/, 'Response');
  if (!protocol?.[name] || !protocol[response]) throw new Error('本地协议缺少海兽查询：' + name);
  const result = await client.request(name, {}, response);
  if (!active()) throw new Error('账号已暂停或连接已更换');
  return result;
}

async function roomState(client, protocol, buildingId, active) {
  const water = await read(client, protocol, 'OnWaterRequest', active);
  const buildings = list(water?.building, '海面建筑').filter(row => row.buildingId === buildingId);
  if (buildings.length > 1) throw new Error('海兽培育室地块不唯一');
  const building = buildings[0];
  const result = { jobs: [], mature: [], maxQ: 0, reason: '', buildingId };
  if (!building || !number(building.level, '培育室等级')) return { ...result, reason: '海兽培育室尚未建成' };
  if (building.buildStartTime > 0 || building.buildFinishTime > 0) return { ...result, reason: '海兽培育室正在施工或等待竣工' };
  if (building.auto) return { ...result, reason: '海兽培育室已开启游戏内自动培育' };
  const info = building.petBreed;
  if (!info) throw new Error('未能读取海兽培育队列');
  result.maxQ = number(info.maxQLength, '培育队列容量');
  const indices = new Set();
  result.jobs = list(info.breedQ, '培育队列').map(job => {
    const idx = number(job.idx, '培育队列编号');
    const startTime = number(job.startTime, '培育开始时间');
    const finishTime = number(job.finishTime, '培育完成时间', 1);
    if (indices.has(idx) || finishTime < startTime || typeof job.petId !== 'string' || !job.petId) {
      throw new Error('海兽培育队列数据异常');
    }
    indices.add(idx);
    return { idx, petId: job.petId, startTime, finishTime, star: number(job.star, '培育海兽星级') };
  });
  result.mature = list(info.maturePets, '成熟海兽').map(pet => {
    petKind(pet);
    return { petId: pet.petId, star: pet.star };
  });
  if (result.jobs.length > result.maxQ) throw new Error('培育队列数量超过服务端容量');
  if (!result.maxQ) result.reason = '海兽培育队列尚未开放';
  else if (result.jobs.some(job => job.finishTime <= now(client))) result.reason = '培育已到点，等待服务端将海兽移入成熟列表';
  return result;
}

function roomKey(room) {
  return JSON.stringify([room.buildingId, room.maxQ, room.reason, room.jobs.map(jobKey).sort(), room.mature.map(petKind).sort()]);
}

async function petInventory(client, protocol, active) {
  const response = await read(client, protocol, 'AllPetRequest', active);
  const result = new Map();
  for (const pet of list(response?.pets, '海兽仓库')) {
    const uid = uidText(pet.uid);
    if (!uid || result.has(uid)) throw new Error('无法确认海兽的唯一编号');
    petKind(pet);
    result.set(uid, { petId: pet.petId, star: pet.star });
  }
  return result;
}

async function stockState(client, protocol, active) {
  const bag = await read(client, protocol, 'AllItemRequest', active);
  const resources = await read(client, protocol, 'AllResourceRequest', active);
  const stock = new Map();
  for (const item of list(bag?.items, '基因库存')) {
    if (typeof item.itemId !== 'string' || !item.itemId || item.itemId === 'GOLD' || stock.has(item.itemId)) throw new Error('基因库存编号异常');
    stock.set(item.itemId, number(item.num, '基因库存数量'));
  }
  const gold = list(resources?.list, '金币余额').filter(row => row.res === 3);
  if (gold.length !== 1) throw new Error('无法确认金币余额');
  stock.set('GOLD', number(gold[0].amount, '金币余额'));
  return stock;
}

function chooseRecipe(config, season, stock) {
  const catalogue = rows(config, 'PetBreedCfg');
  const species = rows(config, 'PetSpeciesCfg');
  if (!catalogue.length || !species.length) throw new Error('缺少海兽培育配方或物种配置');
  const seen = new Set();
  const candidates = [];
  for (const row of catalogue) {
    if (!row.petId || seen.has(row.petId)) throw new Error('海兽培育配方编号异常');
    seen.add(row.petId);
    const availableSeason = number(row.season, '海兽配方赛季', 1);
    if (availableSeason > season || row.quality === 'RED') continue;
    if (!qualityRank[row.quality] || row.qualityIndex !== qualityRank[row.quality]) throw new Error('无法确认海兽配方品质');
    const spId = number(row.spId, '海兽物种编号', 1);
    const matches = species.filter(sp => sp.spId === spId);
    if (matches.length !== 1) throw new Error('无法确认海兽物种配置');
    if (number(matches[0].season, '海兽物种赛季', 1) > season) continue;
    number(row.breedTime, '培育时长', 1);
    const cost = list(row.cost, '培育材料配置');
    const gene = '宠物' + spId + qualityText[row.quality] + '基因';
    if (cost.length !== 2 || !cost.every(pair => Array.isArray(pair) && pair.length === 2)
      || cost[0][0] !== gene || cost[1][0] !== 'GOLD') throw new Error('无法确认专属基因和金币配方，暂停培育');
    const costs = new Map(cost.map(([id, amount]) => [id, number(amount, '培育材料消耗', 1)]));
    if ([...costs].every(([id, amount]) => (stock.get(id) ?? 0) >= amount + (id === 'GOLD' ? petBreedGoldReserve : 0))) {
      candidates.push({ petId: row.petId, spId, quality: qualityRank[row.quality], costs,
        name: qualityText[row.quality] + (matches[0].name || '海兽') });
    }
  }
  return candidates.sort((a, b) => b.quality - a.quality || a.spId - b.spId)[0];
}

async function businessConfirmed(client, protocol, operation, active, room) {
  if (room.reason) return false;
  if (operation.key === 'petCollect') {
    if (room.mature.length) return false;
    const pets = await petInventory(client, protocol, active);
    const gained = counts([...pets].filter(([uid]) => !operation.pets.has(uid)).map(([, pet]) => pet));
    return [...counts(operation.mature)].every(([kind, amount]) => (gained.get(kind) ?? 0) >= amount);
  }
  if (room.jobs.some(job => job.petId === operation.petId && !operation.jobs.has(jobIdentity(job)))) return true;
  // Every same-kind queue/mature pet present before this request may finish or
  // be claimed while its outcome is unknown. Only gains beyond that upper
  // bound can prove an additional pet was bred by a later operation.
  const previousMature = operation.mature.filter(pet => pet.petId === operation.petId).length;
  const previousTotal = operation.priorInFlight + previousMature;
  if (!Number.isSafeInteger(previousTotal) || previousTotal < 0) return false;
  if (room.mature.filter(pet => pet.petId === operation.petId).length > previousTotal) return true;
  const pets = await petInventory(client, protocol, active);
  return [...pets].filter(([uid, pet]) => !operation.pets.has(uid) && pet.petId === operation.petId).length > previousTotal;
}

async function confirmed(client, protocol, operation, active, room) {
  if (!await businessConfirmed(client, protocol, operation, active, room)) return false;
  if (operation.key === 'petCollect') return true;
  // Query complete balances only after the matching queue/new pet is known.
  // Production and rewards can hide the debit in the net balance.
  await stockState(client, protocol, active);
  if (!active()) return false;
  confirmGoldOperation(operation.gold);
  return refreshGoldSpend(client, operation.player, { enabled: active });
}

export async function servicePetBreeding(client, protocol, config, {
  player, enabled = () => false, report = () => {}, scheduler,
} = {}) {
  const selected = new Set(keys.filter(key => enabled(key) && (!scheduler || scheduler.due(key))));
  if (!selected.size) return;
  let account;
  let operationKey = selected.has('petCollect') ? 'petCollect' : 'petBreed';
  const deadlines = new Map();
  const same = () => {
    try { return !account || identity(player) === account; } catch { return false; }
  };
  const active = key => selected.has(key) && enabled(key) && same() && client.connected !== false;
  const anyActive = () => keys.some(active);
  const emit = (key, entry) => report({ key, label: labels[key], ...entry });
  const skip = (key, reason) => { if (active(key)) emit(key, { skipped: true, reason }); };
  const defer = seconds => { for (const key of selected) deadlines.set(key, now(client) + seconds); };
  const wait = room => {
    const finish = Math.min(...room.jobs.map(job => job.finishTime).filter(time => time > now(client)));
    if (Number.isFinite(finish)) {
      if (!room.mature.length && selected.has('petCollect')) deadlines.set('petCollect', finish);
      if (room.jobs.length >= room.maxQ && selected.has('petBreed')) deadlines.set('petBreed', finish);
    }
  };
  let locked = false;
  try {
    const rooms = rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === '宠物培育室');
    if (rooms.length !== 1 || !rooms[0].buildingId) throw new Error('缺少唯一的海兽培育室开放配置');
    const gate = number(rooms[0].playerLevel, '海兽培育室开放等级', 1);
    if (number(player?.level, '角色等级', 1) < gate) {
      for (const key of keys) skip(key, '海兽培育室在角色 ' + gate + ' 级开放');
      defer(300); return;
    }
    account = identity(player);
    if (busy.has(account)) { for (const key of keys) skip(key, '正在核对上一轮海兽培育'); return; }
    busy.add(account); locked = true;
    await refreshGoldSpend(client, player, { enabled: anyActive });
    let room = await roomState(client, protocol, rooms[0].buildingId, anyActive);
    const saved = pending.get(account);
    if (saved) {
      if (await confirmed(client, protocol, saved, anyActive, room)) {
        pending.delete(account);
        for (const key of keys) skip(key, '已核对上次海兽操作，下一轮继续');
        defer(60);
      } else {
        for (const key of keys) skip(key, '上次海兽操作结果尚未确认，暂停重复领取和培育');
        defer(180);
      }
      return;
    }
    if (room.reason) {
      for (const key of keys) skip(key, room.reason);
      defer(60); return;
    }
    wait(room);
    if (active('petCollect') && room.mature.length) {
      operationKey = 'petCollect';
      const pets = await petInventory(client, protocol, () => active('petCollect'));
      const fresh = await roomState(client, protocol, room.buildingId, () => active('petCollect'));
      if (roomKey(room) !== roomKey(fresh)) { skip('petCollect', '成熟海兽或培育队列已变化，下一轮重新核对'); return; }
      if (!protocol.GetMaturePetRequest) throw new Error('本地协议缺少海兽领取接口');
      if (!active('petCollect')) return;
      const attempt = { key: 'petCollect', pets, mature: room.mature };
      pending.set(account, attempt);
      try { await client.sendWatch('GetMaturePetRequest', {}, { window: 500 }); }
      catch (error) {
        if (error.prompt && error.request === 'GetMaturePetRequest') pending.delete(account);
        throw error;
      }
      room = await roomState(client, protocol, room.buildingId, anyActive);
      if (!await confirmed(client, protocol, attempt, anyActive, room)) throw new Error('未确认成熟列表清空且新海兽入库，暂停重复领取和培育');
      pending.delete(account);
      emit('petCollect', { ok: true, label: '已领取 ' + attempt.mature.length + ' 只成熟海兽' });
      if (!active('petBreed')) return;
      // New stock and a new server queue are required after collection.
      room = await roomState(client, protocol, room.buildingId, () => active('petBreed'));
    } else if (active('petCollect')) skip('petCollect', '暂无成熟海兽');
    if (!active('petBreed')) return;
    operationKey = 'petBreed';
    if (room.reason || room.mature.length || room.jobs.length >= room.maxQ) {
      skip('petBreed', room.reason || (room.mature.length ? '请先领取成熟海兽' : '海兽培育队列已满'));
      wait(room); return;
    }
    const season = Math.floor(number(player.worldId, '账号区服', 1) / 1e6) % 1000;
    if (!season) throw new Error('无法确认海兽培育赛季');
    let stock = await stockState(client, protocol, () => active('petBreed'));
    if (!reconcileGold(player, stock.get('GOLD'))) {
      skip('petBreed', '上次装备制造或海兽培育的金币扣款尚未同步，等待余额更新');
      return;
    }
    const recipe = chooseRecipe(config, season, stock);
    if (!recipe) { skip('petBreed', '没有材料齐备且可保留 10,000 金币的蓝色至橙色海兽配方'); return; }
    const pets = await petInventory(client, protocol, () => active('petBreed'));
    const fresh = await roomState(client, protocol, room.buildingId, () => active('petBreed'));
    if (roomKey(room) !== roomKey(fresh)) { skip('petBreed', '培育队列已变化，下一轮重新核对'); return; }
    stock = await stockState(client, protocol, () => active('petBreed'));
    const current = chooseRecipe(config, season, stock);
    if (current?.petId !== recipe.petId) { skip('petBreed', '材料或金币余额已变化，下一轮重新选择配方'); return; }
    if (!protocol.PetBreedRequest) throw new Error('本地协议缺少海兽培育接口');
    if (!active('petBreed')) return;
    const attempt = { key: 'petBreed', player: { playerId: uidText(player.playerId), worldId: number(player.worldId, '账号区服', 1) },
      pets, mature: room.mature, jobs: new Set(room.jobs.map(jobIdentity)),
      priorInFlight: room.jobs.filter(job => job.petId === current.petId).length,
      petId: current.petId, stock, costs: current.costs };
    const buildingId = room.buildingId;
    const reservation = reserveGold(player, stock.get('GOLD'), current.costs.get('GOLD'), 'PetBreedRequest', { operation: {
      async verify(connection, { enabled: allowed }) {
        const state = await roomState(connection, protocol, buildingId, allowed);
        return businessConfirmed(connection, protocol, attempt, allowed, state);
      },
    } });
    attempt.gold = reservation;
    pending.set(account, attempt);
    try { await client.sendWatch('PetBreedRequest', { petId: current.petId, universal: false }, { window: 500 }); }
    catch (error) {
      if (error.notSent === true) cancelUnsentGold(reservation); else rejectGold(reservation, error);
      if (error.notSent === true || error.prompt && error.request === 'PetBreedRequest') pending.delete(account);
      throw error;
    }
    room = await roomState(client, protocol, room.buildingId, anyActive);
    if (!await confirmed(client, protocol, attempt, anyActive, room)) throw new Error('未确认新培育队列及材料扣款，暂停重复培育');
    pending.delete(account);
    emit('petBreed', { ok: true, label: '已开始培育' + current.name + '（保留至少 10,000 金币）' });
    wait(room);
  } catch (error) {
    if (active(operationKey)) emit(operationKey, { ok: false, error: error.message });
    defer(180);
  } finally {
    if (locked) busy.delete(account);
    for (const [key, until] of deadlines) scheduler?.defer(key, until);
  }
}
