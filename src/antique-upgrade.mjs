import { createHash } from 'node:crypto';
import { exactAutomationId } from './automation-policy.mjs';
import { cancelUnsentGold, reconcileGold, rejectGold, reserveGold, confirmGoldOperation, refreshGoldSpend } from './gold-reservations.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const active = new WeakSet();
const rejected = new WeakMap();
const COLOR_FIELD = { BLUE: 'consumeBlue', PURPLE: 'consumePur', ORANGE: 'consumeOra', RED: 'consumeRed' };
const idKey = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
export const antiqueEnabled = settings => settings?.antique?.enabled === true;

function quantity(value) {
  if (integer(value)) return value;
  let n;
  if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) n = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

function costsOf(raw) {
  if (!Array.isArray(raw)) return null;
  const list = raw.length === 2 && typeof raw[0] === 'string' ? [raw] : raw;
  const result = list.map(item => Array.isArray(item) ? { id: item[0], num: Number(item[1]) }
    : { id: item?.id, num: Number(item?.num) });
  return result.every(item => typeof item.id === 'string' && item.id && integer(item.num, 1)) ? result : null;
}

function colorNeed(base, cfg) {
  const field = COLOR_FIELD[base?.color];
  return field ? cfg?.[field] : null;
}

function maxStar(config) {
  return rows(config, 'AntiqueStarCfg').reduce((max, row) => integer(row.star, 1) ? Math.max(max, row.star) : max, 0);
}

function maxMasterLevel(config) {
  return rows(config, 'AntiqueMasterLvCfg').reduce((max, row) => integer(row.level, 1) ? Math.max(max, row.level) : max, 0);
}

function suitLevelCfg(config, color, target) {
  return rows(config, 'AntiqueSuitLvCfg').find(row => row.color === color && integer(row.maxLevel, 1) && row.maxLevel >= target) ?? null;
}

function lastSuitLevel(config, color) {
  return rows(config, 'AntiqueSuitLvCfg').filter(row => row.color === color && integer(row.maxLevel, 1))
    .reduce((max, row) => Math.max(max, row.maxLevel), 0);
}

function antiqueName(config, id) {
  return rows(config, 'AntiqueBaseCfg').find(row => row.antiqueId === id)?.showName || id;
}

function suitName(config, id) {
  return rows(config, 'AntiqueSuitCfg').find(row => row.suitId === id)?.suitName || ('套装' + id);
}

export async function readAntiqueUpgrade(client, protocol, config, player, { enabled = () => true } = {}) {
  const snapshot = { now: nowOf(client), worldId: exactAutomationId(player?.worldId), playerId: exactAutomationId(player?.playerId),
    antiques: [], suits: [], masterLv: null, items: new Map(), gold: null, goldSynced: false, reason: '' };
  const required = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '藏品')?.playerLevel;
  if (!integer(required, 1)) { snapshot.reason = '缺少藏品开放等级配置'; return snapshot; }
  if (!integer(player?.level, 1)) { snapshot.reason = '无法确认角色等级'; return snapshot; }
  if (player.level < required) { snapshot.reason = '角色 ' + required + ' 级开放藏品'; return snapshot; }
  if (!snapshot.worldId || !snapshot.playerId) { snapshot.reason = '无法确认角色、区服或账号标识'; return snapshot; }
  const get = async (request, response) => {
    if (!protocol?.[request] || !protocol?.[response]) throw new Error('当前协议缺少' + request);
    return client.request(request, {}, response, 8000);
  };
  try {
    await refreshGoldSpend(client, player, { enabled });
    const [antiqueReply, itemReply, resourceReply] = await Promise.all([
      get('AllAntiqueRequest', 'AllAntiqueResponse'), get('AllItemRequest', 'AllItemResponse'), get('AllResourceRequest', 'AllResourceResponse'),
    ]);
    if (exactAutomationId(player?.playerId) !== snapshot.playerId || exactAutomationId(player?.worldId) !== snapshot.worldId) throw new Error('账号已变化，不能使用原账号藏品状态');
    if (!Array.isArray(antiqueReply.antiques) || !Array.isArray(antiqueReply.suits) || !integer(antiqueReply.masterLv, 0)) throw new Error('藏品、套装或大师等级数据不完整');
    const antiqueIds = new Set();
    for (const item of antiqueReply.antiques) {
      if (typeof item?.id !== 'string' || !item.id || !integer(item.star, 0) || antiqueIds.has(item.id)) throw new Error('藏品记录含无法精确识别的标识');
      antiqueIds.add(item.id);
      snapshot.antiques.push({ id: item.id, star: item.star });
    }
    const suitIds = new Set();
    for (const item of antiqueReply.suits) {
      if (!integer(item?.id, 1) || !integer(item.level, 0) || suitIds.has(item.id)) throw new Error('藏品套装记录含无法精确识别的标识');
      suitIds.add(item.id);
      snapshot.suits.push({ id: item.id, level: item.level });
    }
    snapshot.masterLv = antiqueReply.masterLv;
    if (!Array.isArray(itemReply.items)) throw new Error('藏品碎片与材料库存未同步');
    for (const item of itemReply.items) {
      if (typeof item?.itemId !== 'string' || !item.itemId) throw new Error('藏品材料标识缺失');
      const num = quantity(item.num), sum = (snapshot.items.get(item.itemId) ?? 0) + num;
      if (num === null || !integer(sum)) throw new Error('藏品材料数量无法精确确认');
      snapshot.items.set(item.itemId, sum);
    }
    if (!Array.isArray(resourceReply.list)) throw new Error('金币余额未同步');
    const gold = resourceReply.list.filter(row => row.res === 3);
    snapshot.gold = gold.length === 1 ? quantity(gold[0].amount) : null;
    if (!integer(snapshot.gold)) throw new Error('金币余额无法精确确认');
    snapshot.goldSynced = reconcileGold(player, snapshot.gold);
  } catch (error) { snapshot.reason = '藏品状态未确认：' + error.message; }
  return snapshot;
}

function confirmed(details, snapshot) {
  if (!details || snapshot.reason) return false;
  if (details.kind === 'antiqueActivate') return snapshot.antiques.some(row => row.id === details.antiqueId);
  if (details.kind === 'antiqueStar') return (snapshot.antiques.find(row => row.id === details.antiqueId)?.star ?? -1) >= details.targetStar;
  if (details.kind === 'antiqueSuit') return (snapshot.suits.find(row => row.id === details.suitId)?.level ?? -1) >= details.targetLevel;
  if (details.kind === 'antiqueMaster') return integer(snapshot.masterLv, 0) && snapshot.masterLv >= details.targetLevel;
  return false;
}

export function planAntiqueUpgrade(snapshot, config, settings, { usage = { counters: {} }, keys = {} } = {}) {
  const p = settings?.antique;
  const plan = { actions: [], notes: [], antiques: snapshot.antiques, suits: snapshot.suits, masterLv: snapshot.masterLv,
    gold: snapshot.gold, reason: snapshot.reason };
  if (!p) return plan;
  if (!p.enabled) plan.notes.push('藏品养成未开启');
  if (snapshot.reason) plan.notes.push(snapshot.reason);
  if (!p.enabled || snapshot.reason) return plan;
  if (!p.activate && !p.star && !p.master && !p.suit) { plan.notes.push('未开启任何藏品养成动作'); return plan; }
  const balances = new Map(snapshot.items);
  let gold = snapshot.gold;
  let spent = usage.counters.antiqueGold ?? 0;
  if (!integer(spent)) { plan.notes.push('藏品当日金币用量记录异常'); return plan; }
  const owned = new Map(snapshot.antiques.map(row => [row.id, { ...row }]));
  const suits = new Map(snapshot.suits.map(row => [row.id, { ...row }]));
  let masterLv = snapshot.masterLv;
  let totalStars = snapshot.antiques.reduce((sum, row) => sum + row.star, 0);
  const maxActions = integer(p.maxActions, 1) ? p.maxActions : 20;
  const starCap = maxStar(config) || 25;
  const baseRows = rows(config, 'AntiqueBaseCfg');
  const baseOrder = new Map(baseRows.map((row, index) => [row.antiqueId, index]));
  const bases = [...baseRows].sort((a, b) => (b.colorIndex ?? 0) - (a.colorIndex ?? 0) || (baseOrder.get(a.antiqueId) ?? 0) - (baseOrder.get(b.antiqueId) ?? 0));
  const pending = (kind, field, value) => Object.entries(keys).some(([key, record]) => key.startsWith('antique:' + kind + ':') &&
    !record.confirmed && !record.expired && record.details?.[field] === value);
  const pendingKind = kind => Object.entries(keys).some(([key, record]) => key.startsWith('antique:' + kind + ':') && !record.confirmed && !record.expired);
  let count = 0;
  for (const base of bases) {
    if (count >= maxActions) break;
    const id = base?.antiqueId, fragId = id + '碎片';
    if (typeof id !== 'string' || !id) continue;
    const data = owned.get(id);
    if (!data) {
      if (!p.activate || !p.activateQualities.includes(base.color) || pending('antiqueActivate', 'antiqueId', id)) continue;
      const need = integer(base.activeFrag, 1) ? base.activeFrag : null;
      if (!need) { plan.notes.push(antiqueName(config, id) + '：激活碎片数量配置不完整'); continue; }
      const have = balances.get(fragId) ?? 0;
      if (have < need) continue;
      plan.actions.push({ kind: 'antiqueActivate', request: 'ActivateAntiqueRequest', body: { id }, antiqueId: id,
        uniqueKey: 'antique:antiqueActivate:' + snapshot.worldId + ':' + idKey(id), costs: [{ id: fragId, num: need }],
        label: '激活藏品' + antiqueName(config, id) });
      balances.set(fragId, have - need);
      owned.set(id, { id, star: 0 });
      count++;
      continue;
    }
    if (!p.star || !p.starQualities.includes(base.color) || pending('antiqueStar', 'antiqueId', id)) continue;
    const star = data.star, target = star + 1;
    if (!integer(star, 0) || target > starCap || (p.targetStar > 0 && target > p.targetStar)) continue;
    const cfg = rows(config, 'AntiqueStarCfg').find(row => row.star === target);
    const need = colorNeed(base, cfg);
    if (!integer(need, 1)) continue;
    const specific = balances.get(fragId) ?? 0;
    const universalItem = base.universalItemId;
    const universal = p.universal && typeof universalItem === 'string' ? (balances.get(universalItem) ?? 0) : 0;
    if (specific + universal < need) continue;
    const useSpecific = Math.min(specific, need), useUniversal = need - useSpecific;
    const costs = [];
    if (useSpecific) costs.push({ id: fragId, num: useSpecific });
    if (useUniversal) costs.push({ id: universalItem, num: useUniversal });
    plan.actions.push({ kind: 'antiqueStar', request: 'AntiqueStarUpRequest', body: { id, universal: p.universal === true },
      antiqueId: id, targetStar: target, uniqueKey: 'antique:antiqueStar:' + snapshot.worldId + ':' + idKey(id) + ':' + target,
      costs, label: '藏品' + antiqueName(config, id) + '升到 ' + target + ' 星' });
    if (useSpecific) balances.set(fragId, specific - useSpecific);
    if (useUniversal) balances.set(universalItem, universal - useUniversal);
    data.star = target;
    totalStars++;
    count++;
  }
  if (p.master && !pendingKind('antiqueMaster')) {
    const targetCap = integer(p.targetMasterLevel, 1) ? p.targetMasterLevel : maxMasterLevel(config);
    const masterRows = rows(config, 'AntiqueMasterLvCfg');
    while (count < maxActions && masterLv < targetCap) {
      const next = masterRows.find(row => row.level === masterLv + 1);
      if (!next) break;
      if (!integer(next.totalStarNum, 0) || totalStars < next.totalStarNum) {
        plan.notes.push('藏品大师升到 ' + (masterLv + 1) + ' 级需要总星级 ' + next.totalStarNum + '，当前 ' + totalStars);
        break;
      }
      const costs = costsOf(next.costArr);
      if (!costs) { plan.notes.push('藏品大师等级消耗配置不完整'); break; }
      if (costs.some(cost => (balances.get(cost.id) ?? 0) < cost.num)) {
        plan.notes.push('藏品大师升到 ' + (masterLv + 1) + ' 级材料不足');
        break;
      }
      plan.actions.push({ kind: 'antiqueMaster', request: 'AntiqueMasterLevelUpRequest', body: {},
        targetLevel: next.level, uniqueKey: 'antique:antiqueMaster:' + snapshot.worldId + ':' + next.level,
        costs, label: '藏品大师升到 ' + next.level + ' 级' });
      for (const cost of costs) balances.set(cost.id, (balances.get(cost.id) ?? 0) - cost.num);
      masterLv = next.level;
      count++;
    }
  }
  if (p.suit) {
    const cap = integer(rows(config, 'AntiqueMasterLvCfg').find(row => row.level === masterLv)?.maxSuitLv, 1)
      ? rows(config, 'AntiqueMasterLvCfg').find(row => row.level === masterLv).maxSuitLv : 0;
    const suitRows = rows(config, 'AntiqueSuitCfg');
    const suitOrder = new Map(suitRows.map((row, index) => [row.suitId, index]));
    const suitCfgs = [...suitRows].sort((a, b) => (b.colorIndex ?? 0) - (a.colorIndex ?? 0) || (suitOrder.get(a.suitId) ?? 0) - (suitOrder.get(b.suitId) ?? 0));
    for (const suitCfg of suitCfgs) {
      if (count >= maxActions) break;
      if (!p.suitQualities.includes(suitCfg.color)) continue;
      const suitId = suitCfg.suitId;
      let level = suits.get(suitId)?.level ?? 0;
      if (!integer(level, 0)) continue;
      const max = Math.min(cap, lastSuitLevel(config, suitCfg.color));
      // 客户端在套装等级为 0 时只检查藏品数量，不检查大师等级上限；激活后再受上限约束。
      while (count < maxActions && (level === 0 || level < max)) {
        if (pending('antiqueSuit', 'suitId', suitId)) break;
        if (level === 0) {
          const antiques = baseRows.filter(row => row.suitId === suitId);
          if (!antiques.length) break;
          const activated = antiques.filter(row => owned.has(row.antiqueId)).length;
          const need = Number(suitCfg.colorIndex) >= 4 ? 2 : antiques.length;
          if (activated < need) { plan.notes.push(suitName(config, suitId) + '：需要 ' + need + ' 件已激活藏品，当前 ' + activated + ' 件'); break; }
          plan.actions.push({ kind: 'antiqueSuit', request: 'AntiqueSuitLevelUpRequest', body: { id: suitId }, suitId,
            targetLevel: 1, goldCost: 0, costs: [], uniqueKey: 'antique:antiqueSuit:' + snapshot.worldId + ':' + idKey(suitId) + ':1',
            label: '激活藏品套装' + suitName(config, suitId) });
          suits.set(suitId, { id: suitId, level: 1 });
          level = 1;
          count++;
          continue;
        }
        const target = level + 1, cfg = suitLevelCfg(config, suitCfg.color, target);
        if (!cfg) break;
        const costs = costsOf(cfg.costArr);
        if (!costs) { plan.notes.push(suitName(config, suitId) + '：升级消耗配置不完整'); break; }
        const itemCosts = costs.filter(cost => cost.id !== 'GOLD');
        if (itemCosts.some(cost => (balances.get(cost.id) ?? 0) < cost.num)) { plan.notes.push(suitName(config, suitId) + '：升级材料不足'); break; }
        const goldCost = costs.find(cost => cost.id === 'GOLD')?.num ?? 0;
        if (!integer(gold, 0) || !snapshot.goldSynced) { plan.notes.push('金币扣款尚未同步，暂停套装升级'); break; }
        if (gold - goldCost < p.goldReserve || (p.dailyGoldLimit > 0 && spent + goldCost > p.dailyGoldLimit)) {
          plan.notes.push(suitName(config, suitId) + '：金币不足或会低于保留量/日预算');
          break;
        }
        plan.actions.push({ kind: 'antiqueSuit', request: 'AntiqueSuitLevelUpRequest', body: { id: suitId }, suitId,
          targetLevel: target, goldCost, costs, uniqueKey: 'antique:antiqueSuit:' + snapshot.worldId + ':' + idKey(suitId) + ':' + target,
          label: '藏品套装' + suitName(config, suitId) + '升到 ' + target + ' 级' });
        for (const cost of itemCosts) balances.set(cost.id, (balances.get(cost.id) ?? 0) - cost.num);
        gold -= goldCost;
        spent += goldCost;
        level = target;
        count++;
      }
    }
  }
  if (!plan.actions.length && !plan.notes.length) plan.notes.push('没有满足条件的藏品养成动作');
  return plan;
}

function detailsOf(step, now) {
  return { kind: step.kind, antiqueId: step.antiqueId, suitId: step.suitId, targetStar: step.targetStar,
    targetLevel: step.targetLevel, costs: step.costs, sentAt: now };
}

function reconcile(snapshot, ledger, onStep) {
  if (snapshot.reason) return;
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!record.details || !key.startsWith('antique:' + record.details.kind + ':' + snapshot.worldId + ':')) continue;
    if (!confirmed(record.details, snapshot)) {
      if (record.confirmed) { try { ledger.releaseCompletedKey(key); } catch { /* 等下次读取再释放 */ } }
      continue;
    }
    if (!record.confirmed) ledger.resolveKey(key, true);
    ledger.releaseCompletedKey(key);
    const label = record.details.kind === 'antiqueActivate' ? '激活藏品' + record.details.antiqueId
      : record.details.kind === 'antiqueStar' ? '藏品' + record.details.antiqueId + '升到 ' + record.details.targetStar + ' 星'
        : record.details.kind === 'antiqueSuit' ? '藏品套装 ' + record.details.suitId + ' 升到 ' + record.details.targetLevel + ' 级'
          : '藏品大师升到 ' + record.details.targetLevel + ' 级';
    onStep?.({ step: { kind: 'antiqueComplete', label }, ok: true, status: 'completed', note: '已从服务器状态确认' });
  }
}

export async function runAntiqueUpgrade(client, protocol, config, player, { getSettings, ledger, enabled = () => true, onStep } = {}) {
  if (!antiqueEnabled(getSettings?.()) || !enabled()) return { actions: [], results: [], notes: [] };
  if (active.has(client)) return { actions: [], results: [], notes: ['藏品养成检查正在进行'] };
  if (!ledger?.keyRecords || !ledger?.resolveKey || !ledger?.releaseCompletedKey) throw new Error('缺少持久藏品养成记录');
  active.add(client);
  const results = [];
  const report = entry => { results.push(entry); onStep?.(entry); };
  try {
    const read = () => readAntiqueUpgrade(client, protocol, config, player, { enabled });
    const snapshot = await read();
    const settings = getSettings();
    reconcile(snapshot, ledger, report);
    const plan = planAntiqueUpgrade(snapshot, config, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords() });
    for (const proposed of plan.actions) {
      if (!enabled() || !antiqueEnabled(getSettings()) || !client.connected) break;
      const current = getSettings();
      if (current !== settings) break;
      const fresh = await read();
      if (fresh.reason) { plan.notes.push(fresh.reason); break; }
      const reviewed = planAntiqueUpgrade(fresh, config, settings, { usage: ledger.snapshot(), keys: ledger.keyRecords() });
      const step = reviewed.actions.find(row => row.uniqueKey === proposed.uniqueKey && row.kind === proposed.kind);
      if (!step || !enabled() || settings !== getSettings() || !client.connected) continue;
      if (ledger.hasKey(step.uniqueKey)) continue;
      const failure = rejected.get(client)?.get(step.uniqueKey);
      if (failure && failure.until > Date.now() && failure.signature === JSON.stringify(step.body)) continue;
      let goldTicket;
      if (step.goldCost > 0) {
        const { suitId, targetLevel } = step;
        try { goldTicket = reserveGold(player, fresh.gold, step.goldCost, step.request, { operation: {
          async verify(current) {
            const response = await current.request('AllAntiqueRequest', {}, 'AllAntiqueResponse');
            if (!Array.isArray(response?.suits)) return false;
            const suits = response.suits.filter(row => row.id === suitId);
            return suits.length === 1 && integer(suits[0].level) && suits[0].level >= targetLevel;
          },
        } }); }
        catch (error) { report({ step, skipped: true, error: error.message }); continue; }
      }
      let ticket;
      try {
        ticket = ledger.reserve(step.goldCost > 0 ? { antiqueGold: step.goldCost } : {},
          step.goldCost > 0 && settings.antique.dailyGoldLimit > 0 ? { antiqueGold: settings.antique.dailyGoldLimit } : {},
          {}, { uniqueKey: step.uniqueKey, details: detailsOf(step, fresh.now) });
      } catch (error) {
        cancelUnsentGold(goldTicket);
        report({ step, skipped: true, error: error.message });
        if (/今日上限/.test(error.message)) break;
        continue;
      }
      if (!enabled() || settings !== getSettings() || !client.connected) {
        ledger.cancel(ticket);
        cancelUnsentGold(goldTicket);
        break;
      }
      let entry;
      try {
        if (step.kind === 'antiqueMaster') {
          const reply = await client.request(step.request, step.body, 'AntiqueMasterLevelUpResponse', 8000);
          if (!(reply?.masterLv >= step.targetLevel)) throw new Error('服务端未确认藏品大师等级');
        } else {
          await client.sendWatch(step.request, step.body, { window: 600 });
        }
        const after = await read();
        const ok = confirmed(detailsOf(step, fresh.now), after);
        if (ok) {
          if (goldTicket) {
            confirmGoldOperation(goldTicket);
            await refreshGoldSpend(client, player, { enabled });
          }
          ledger.resolveKey(step.uniqueKey, true);
          ledger.releaseCompletedKey(step.uniqueKey);
          entry = { step, ok: true, sent: true, status: 'confirmed', note: '服务器状态已确认' };
        } else {
          entry = { step, ok: false, sent: true, status: 'unknown', note: '请求已发送，结果待确认；保留记录，不重复发送' };
        }
      } catch (error) {
        if (error.notSent === true) {
          ledger.cancel(ticket);
          cancelUnsentGold(goldTicket);
          entry = { step, ok: false, skipped: true, status: 'cancelled', error: error.message };
        } else if (error.prompt && error.request === step.request) {
          ledger.cancel(ticket);
          rejectGold(goldTicket, error);
          const failures = rejected.get(client) ?? new Map();
          rejected.set(client, failures);
          failures.set(step.uniqueKey, { until: Date.now() + 300000, signature: JSON.stringify(step.body) });
          entry = { step, ok: false, status: 'rejected', error: error.message };
        } else {
          entry = { step, ok: false, status: 'unknown', error: '结果未知，保留记录：' + error.message };
        }
      }
      report(entry);
      if (entry.status === 'unknown') break;
    }
    return { ...plan, results };
  } finally { active.delete(client); }
}
