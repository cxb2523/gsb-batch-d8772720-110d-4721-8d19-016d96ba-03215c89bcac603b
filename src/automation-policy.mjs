import { normalize } from './worlds.mjs';
import { goldAccountKey, reserveGold, rejectGold, cancelUnsentGold, confirmGoldOperation, readGoldSpendState, settleGoldSpendState, refreshGoldSpend } from './gold-reservations.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialSpends, pendingFarmMaterialSpends, pendingMuseumMaterialSpends,
  confirmOrderMaterialOperation, readOrderMaterialState, settleOrderMaterialState, refreshOrderMaterialSpends } from './order-reservations.mjs';
import { assertFarmPlantingReady, farmInventory, farmPlantArgs, readFarmMaterialState, settleFarmMaterialState } from './farm-planting.mjs';
import { museumMaterialDetails, readMuseumMaterialState, settleMuseumMaterialState } from './museum-materials.mjs';
import { captureSpendOperation } from './spend-evidence.mjs';

export class AutomationSkip extends Error {
  constructor(message) { super(message); this.code = 'AUTOMATION_SKIP'; }
}

export function exactAutomationId(value) {
  let number;
  if (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)) number = BigInt(value);
  else if (Number.isSafeInteger(value)) number = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) number = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return number > 0n && number <= (1n << 63n) - 1n ? number.toString() : null;
}

export function automationWireId(value) {
  const id = exactAutomationId(value);
  if (!id) throw new AutomationSkip('无法精确确认目标标识，已跳过');
  const number = BigInt(id);
  return { low: Number(BigInt.asIntN(32, number)), high: Number(number >> 32n), unsigned: false };
}

const gatherTasks = new Set(['autoFish', 'autoDive', 'autoSalvage', 'floaters', 'antiqueFloaters', 'fishEnhance', 'diveEnhance', 'salvageEnhance', 'diveKey']);

export function worldPreferenceEnabled(settings, kind) {
  if (!settings) return true;
  if (gatherTasks.has(kind) && (!settings.loop.world || settings.gather.enabled === false)) return false;
  if (['gainFactory', 'collectProduct', 'finishUpgrade', 'build', 'buildSupply', 'upgrade', 'weekFactory', 'finishOrder', 'denyOrder', 'startProduce', 'farm', 'speedUpUpgrade', 'speedUpProduce'].includes(kind) && !settings.loop.world) return false;
  const b = settings.building, f = settings.factory, r = settings.resident;
  switch (kind) {
    case 'gainFactory': return f.enabled && f.gain;
    case 'collectProduct': return b.enabled && b.collect;
    case 'finishUpgrade': return b.enabled && b.finish;
    case 'build': return b.enabled && b.build;
    case 'buildSupply': return b.enabled && b.supply && (b.build || b.upgrade) && f.enabled && f.produce;
    case 'upgrade': case 'weekFactory': return b.enabled && b.upgrade;
    case 'finishOrder': return r.enabled;
    case 'denyOrder': return r.enabled && r.reroll;
    case 'startProduce': return f.enabled && (f.produce || f.cooperateNative);
    case 'farm': return settings.farm.enabled;
    case 'speedUpUpgrade': return b.enabled && b.speedUp;
    case 'speedUpProduce': return f.enabled && (f.speedUp || f.speedUpSources.length > 0);
    default: return true;
  }
}

export function needsCargoDemand(settings) {
  return !!settings && settings.loop.world && settings.factory.enabled && settings.factory.demandPriority.includes('cargo')
    && (((settings.factory.produce || settings.factory.cooperateNative) && settings.factory.demandFirst) || settings.factory.speedUpSources.includes('cargo'));
}

export function nativePreferenceEnabled(settings, key) {
  if (!settings) return true;
  if (settings.alliance?.enabled && ['guildOrders', 'guildAidHelp', 'guildWelfare'].includes(key)) return false;
  if (settings.alliance?.enabled && settings.alliance.mutual && key === 'guildAidCollect') return false;
  if (gatherTasks.has(key) && settings.gather.enabled === false) return false;
  const map = {
    stageAuto: () => settings.progression?.enabled !== false && (settings.progression?.mainline ?? settings.schedule?.stageAuto) === true,
    trialPaidSweep: () => settings.trials?.paid === true,
    trialAdSweep: () => settings.trials?.ads === true,
    collect: () => settings.loop.world && ((settings.building.enabled && settings.building.collect) || (settings.factory.enabled && settings.factory.gain)),
    cargo: () => settings.loop.world && settings.cargo.enabled,
    farm: () => settings.loop.world && settings.farm.enabled,
    floaters: () => settings.loop.world && settings.gather.floaters,
    antiqueFloaters: () => settings.loop.world && settings.gather.antiqueFloaters,
    autoFish: () => settings.loop.world && settings.gather.fishing,
    autoDive: () => settings.loop.world && settings.gather.diving,
    autoSalvage: () => settings.loop.world && settings.gather.salvage,
    fishEnhance: () => settings.loop.world && settings.gather.upgradeFishing,
    diveEnhance: () => settings.loop.world && settings.gather.upgradeDiving,
    salvageEnhance: () => settings.loop.world && settings.gather.upgradeSalvage,
    dailyRewards: () => settings.dailies.enabled && settings.dailies.claimTasks,
    chests: () => settings.dailies.enabled && (settings.dailies.claimDailyChest || settings.dailies.claimWeeklyChest),
    gift: () => settings.dailies.enabled && settings.dailies.claimGift,
    tasks: () => settings.loop.tasks || (settings.loop.world && settings.resident.rewards),
    adSpeedUpProduce: () => settings.loop.world && settings.factory.enabled,
    adSpeedUpBuilding: () => settings.loop.world && settings.building.enabled,
    adSpeedUpMuseum: () => settings.loop.world,
    speedUp: () => settings.loop.world && ((settings.building.enabled && settings.building.speedUp) || (settings.factory.enabled && (settings.factory.speedUp || settings.factory.speedUpSources.length)) || (settings.farm.enabled && settings.farm.speedUp)),
    paidGold: () => settings.loop.dailies && settings.gold.enabled,
    freeGold: () => settings.loop.dailies && settings.dailies.enabled,
    freeRecruit: () => settings.loop.dailies && settings.dailies.enabled,
    ticketRecruit: () => settings.loop.dailies && settings.dailies.enabled,
    arena: () => settings.loop.dailies && settings.dailies.enabled,
    pirate: () => settings.loop.dailies && settings.dailies.enabled,
    shop: () => settings.loop.dailies && settings.dailies.enabled,
  };
  if (map[key]) return !!map[key]();
  return worldPreferenceEnabled(settings, key);
}

export function resourceReserve(settings, id) {
  if (!settings) return 0;
  if (id === '建筑蓝图') return settings.building.keepBlueprints;
  if (id === '加速器') return settings.resources.keepAccelerators;
  if (id === '英雄经验') return settings.heroes.keepExp;
  if (id === 'RUBY') return settings.resources.diamondThreshold;
  return 0;
}

export function worldActionAllowed(settings, step, config) {
  if (!settings) return true;
  if (!worldPreferenceEnabled(settings, step.kind)) return false;
  const id = step.body?.buildingId;
  const type = typeof id === 'string' ? (config?.tables?.BuildingCfg?.data ?? []).map(row => row.buildingType).sort((a, b) => b.length - a.length).find(t => id.endsWith(t)) : null;
  if (['build', 'upgrade', 'weekFactory'].includes(step.kind) && settings.building.disabledTypes.some(value => value === id || value === type)) return false;
  if (['startProduce', 'speedUpProduce'].includes(step.kind) && settings.factory.disabledTypes.some(value => value === id || value === type)) return false;
  if (step.request === 'SetFactoryAutoProduceRequest' && !settings.factory.cooperateNative) return false;
  if (step.request === 'StartFactoryProduceRequest' && !settings.factory.produce) return false;
  if (step.request === 'FarmHarvestRequest') return settings.farm.enabled && settings.farm.harvest;
  if (step.request === 'FarmPlantRequest') return settings.farm.enabled && (settings.farm.autoPlant || settings.farm.customPlant);
  if (step.request === 'FarmSpeedUpRequest') return settings.farm.enabled && settings.farm.speedUp;
  return true;
}

export function residentFilter(order, survey, settings, usage = {}) {
  if (!settings) return null;
  const r = settings.resident;
  if (!r.enabled) return '居民需求总开关已关闭';
  const count = Math.max(Number(survey.orderOfTheDay?.orderNum ?? 0), Number(usage.counters?.residentOrders ?? 0));
  if (r.dailyCap > 0 && count >= r.dailyCap) return `今日满足次数 ${count}，已达上限 ${r.dailyCap}`;
  if (r.blockedMaterials.some(id => order.requirements.some(item => item.id === id))) return '包含不准消耗的材料';
  if (r.skipCrops && order.requirements.some(item => survey.cropIds?.has(item.id))) return '已设置跳过农作物订单';
  const available = survey.available ?? (id => survey.have(id) - resourceReserve(settings, id));
  if (r.skipProduction && order.requirements.some(item => available(item.id) < item.num)) return '可用库存不足，已设置跳过需生产的订单';
  if (r.minExp > 0 && (order.rewardExp == null || order.rewardExp < r.minExp)) return `经验奖励未达到 ${r.minExp}`;
  if (r.minGold > 0 && (order.rewardGold == null || order.rewardGold < r.minGold)) return `金币奖励未达到 ${r.minGold}`;
  return null;
}

export function usageLimits(settings) {
  return {
    diamonds: settings.resources.allowDiamonds ? settings.resources.diamondDailyLimit : 0,
    ...(settings.resident.dailyCap > 0 ? { residentOrders: settings.resident.dailyCap } : {}),
    ...(settings.cargo.dailyLoadLimit > 0 ? { cargoLoads: settings.cargo.dailyLoadLimit } : {}),
    museumGuides: settings.museum.dailyGuideLimit,
    goldPaidTimes: settings.gold.times,
  };
}

function actionCosts(step) {
  const costs = new Map();
  for (const item of step.costs ?? []) {
    if (!item?.id || !Number.isSafeInteger(item.num) || item.num < 0) throw new AutomationSkip('动作消耗数据不完整，本轮跳过');
    if (item.num === 0) continue;
    costs.set(item.id, (costs.get(item.id) ?? 0) + item.num);
  }
  return costs;
}

export function actionCounters(step) {
  const result = { ...step.counters };
  const diamonds = actionCosts(step).get('RUBY') ?? 0;
  if (diamonds) result.diamonds = diamonds;
  return result;
}

// 同一计划中的成本按发送顺序扣减。读取失败、额度文件损坏或金额不明均不发送消费动作。
export function createActionGuard(client, getSettings, ledger, { enabled = () => true, player = null } = {}) {
  const remaining = new Map();
  const reservations = new Map();
  // Even actions without daily counters need a distinct generation. Identical
  // request bodies may be retried after an earlier unknown action is settled.
  const forget = record => reservations.delete(record.token);
  return {
    async before(step, { waterSnapshot } = {}) {
      let settings = getSettings?.();
      const planting = step.request === 'FarmPlantRequest';
      const exploring = step.request === 'MuseumStartExploreRequest';
      if (planting && !player) throw new AutomationSkip('无法确认播种账号');
      if (exploring && !player) throw new AutomationSkip('无法确认探宝账号');
      if (!settings && !player) return null;
      const costs = actionCosts(step);
      if (planting && !costs.size) throw new AutomationSkip('无法确认播种种子消耗');
      if (exploring && !costs.size) throw new AutomationSkip('无法确认探宝材料消耗');
      // Legacy callers without detailed settings still share resource barriers.
      if (!settings && !costs.size) return null;
      if (!enabled()) throw new AutomationSkip('操作已暂停');
      if (!worldPreferenceEnabled(settings, step.kind)) throw new AutomationSkip('对应设置已关闭');
      if (settings && step.setting) {
        const [group, key] = step.setting.split('.');
        if (!settings[group]?.[key] || (step.scope === 'base' && !settings.loop.world)) throw new AutomationSkip('对应设置已关闭');
      }
      const account = player && costs.size ? goldAccountKey(player) : null;
      let actualGold, materialStock, museumDetails;
      const nextBalances = new Map();
      if (costs.size) {
        const itemIds = [...costs.keys()].filter(id => !['GOLD', 'RUBY', 'EXP', 'ARENA_POINT', 'LEAGUE_POINT'].includes(id));
        if (planting && itemIds.length !== costs.size) throw new AutomationSkip('播种成本必须是种子道具');
        const resourceIds = [...costs.keys()].filter(id => !itemIds.includes(id));
        const balances = new Map();
        if (itemIds.length) {
          let farmState, museumState, materialState;
          if (account) {
            try {
              farmState = await readFarmMaterialState(client, player, { step: planting ? step : null, enabled });
              museumState = await readMuseumMaterialState(client, player, { step: exploring ? step : null, enabled });
              materialState = await readOrderMaterialState(client, player, { enabled });
            }
            catch (error) { throw new AutomationSkip(error.message); }
          }
          const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
          try { materialStock = farmInventory(bag); }
          catch (error) { throw new AutomationSkip(error.message); }
          if (account) {
            if (goldAccountKey(player) !== account) throw new AutomationSkip('账号已切换，不能使用原账号库存');
            if (!enabled()) throw new AutomationSkip('操作已暂停');
            try {
              settleFarmMaterialState(player, farmState, materialStock);
              settleMuseumMaterialState(player, museumState, materialStock);
              settleOrderMaterialState(player, materialState, materialStock);
              if (planting) assertFarmPlantingReady(player, step, farmState);
              if (exploring) museumDetails = museumMaterialDetails(player, step, museumState);
              confirmOrderMaterialSpends(player, materialStock, itemIds);
            }
            catch (error) { throw new AutomationSkip(error.message); }
          }
          for (const id of itemIds) balances.set(id, materialStock.get(id) ?? 0);
        }
        if (resourceIds.length) {
          const goldState = account && resourceIds.includes('GOLD') ? await readGoldSpendState(client, player, { enabled }) : null;
          const resources = normalize(await client.request('AllResourceRequest', {}, 'AllResourceResponse'));
          if (!enabled() || (account && goldAccountKey(player) !== account)) throw new AutomationSkip('操作已暂停或账号已切换');
          if (!Array.isArray(resources.list) || new Set(resources.list.map(row => row.res)).size !== resources.list.length
            || resources.list.some(row => !Number.isSafeInteger(row.res) || !Number.isSafeInteger(row.amount) || row.amount < 0)) throw new AutomationSkip('无法完整确认当前资源余额');
          const ids = { EXP: 1, GOLD: 3, RUBY: 4, ARENA_POINT: 5, LEAGUE_POINT: 6 };
          for (const id of resourceIds) {
            const row = resources.list?.find(r => r.res === ids[id]);
            if (!row || !Number.isSafeInteger(row.amount)) throw new AutomationSkip('无法确认当前资源余额');
            balances.set(id, row.amount);
            if (id === 'GOLD') actualGold = row.amount;
          }
          if (goldState) settleGoldSpendState(player, goldState, actualGold);
        }
        settings = getSettings?.() ?? settings;
        if (!worldPreferenceEnabled(settings, step.kind)) throw new AutomationSkip('对应设置已关闭');
        if (settings && step.setting) {
          const [group, key] = step.setting.split('.');
          if (!settings[group]?.[key] || (step.scope === 'base' && !settings.loop.world)) throw new AutomationSkip('对应设置已关闭');
        }
        for (const [id, cost] of costs) {
          const actual = balances.get(id);
          const balance = Math.min(actual, remaining.get(id) ?? actual);
          if (!Number.isSafeInteger(balance) || balance < 0 || balance - cost < resourceReserve(settings, id)) throw new AutomationSkip(`${({ GOLD: '金币', RUBY: '钻石', EXP: '经验' })[id] ?? id}不足或会低于保留数量`);
          if (id === 'RUBY' && settings && !settings.resources.allowDiamonds) throw new AutomationSkip('钻石消耗总开关已关闭');
          balances.set(id, balance);
        }
        if (!enabled()) throw new AutomationSkip('操作已暂停');
        for (const [id, cost] of costs) nextBalances.set(id, balances.get(id) - cost);
      }
      const counters = actionCounters(step);
      let ticket = null;
      if (settings && Object.values(counters).some(Boolean)) {
        if (!ledger) throw new AutomationSkip('无法记录当日用量，已跳过本次消费');
        try { ticket = ledger.reserve(counters, usageLimits(settings), step.counterMinimums); }
        catch (error) { throw new AutomationSkip(error.message); }
      }
      let materials, gold, operation;
      if (account) {
        try {
          if (!enabled() || goldAccountKey(player) !== account) throw new AutomationSkip('操作已暂停或账号已切换');
          operation = !planting && !exploring ? await captureSpendOperation(client, step, { waterSnapshot }).catch(() => ({ confirmed: false })) : null;
          if (!enabled() || goldAccountKey(player) !== account) throw new AutomationSkip('操作已暂停或账号已切换');
          if (operation && ticket) operation.onConfirmed = () => ledger.confirm(ticket);
          if (materialStock) materials = beginOrderMaterialSpend(player, [...costs].filter(([id]) => !['GOLD', 'RUBY', 'EXP', 'ARENA_POINT', 'LEAGUE_POINT'].includes(id)).map(([id, need]) => ({ id, need, have: materialStock.get(id) ?? 0 })), step.label || step.request,
            planting ? { farm: { args: farmPlantArgs(step) } } : exploring ? { museum: museumDetails } : { operation });
          if (costs.has('GOLD')) gold = reserveGold(player, actualGold, costs.get('GOLD'), step.request, { operation });
        } catch (error) {
          cancelOrderMaterialSpend(materials); cancelUnsentGold(gold);
          if (ticket) ledger.cancel(ticket);
          throw new AutomationSkip(error.message);
        }
      }
      for (const [id, balance] of nextBalances) remaining.set(id, balance);
      const token = ticket ?? Object.freeze({});
      reservations.set(token, { token, ticket, gold, materials, operation, account, request: step.request, costs });
      return token;
    },
    async after(step, ticket, outcome) {
      const record = reservations.get(ticket);
      if (!record) return;
      if (record?.operation && enabled() && client.connected !== false && goldAccountKey(player) === record.account) {
        if (outcome?.ok && !('sent' in outcome)) {
          confirmOrderMaterialOperation(record.materials);
          confirmGoldOperation(record.gold);
        }
        if (record.materials) await refreshOrderMaterialSpends(client, player, { enabled });
        if (record.gold) await refreshGoldSpend(client, player, { enabled });
        if (record.operation.confirmed && outcome) {
          outcome.ok = true;
          outcome.status = 'confirmed';
          delete outcome.sent;
        }
      }
      if (record?.materials?.farm) {
        try {
          if (goldAccountKey(player) !== record.account) throw new Error('账号已切换，保留原账号播种记录');
          const farmState = await readFarmMaterialState(client, player, { enabled });
          if (!farmState?.water) throw new Error(farmState?.error || '未能确认播种后的农田状态');
          const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
          if (!enabled()) throw new Error('操作已暂停');
          settleFarmMaterialState(player, farmState, stock);
          if (pendingFarmMaterialSpends(player).includes(record.materials)) throw new Error('尚未读到目标地块的新作物，保留种子和地块记录');
          outcome.ok = true;
          outcome.status = 'confirmed';
          delete outcome.sent;
          delete outcome.error;
          delete outcome.reason;
        } catch (error) {
          outcome.ok = false;
          outcome.status = 'unknown';
          outcome.reason = '播种结果待确认：' + error.message;
        }
      }
      if (record?.materials?.museum) {
        try {
          if (goldAccountKey(player) !== record.account) throw new Error('账号已切换，保留原账号探宝记录');
          const state = await readMuseumMaterialState(client, player, { enabled });
          if (!state?.museum) throw new Error(state?.error || '未能确认派遣后的探宝状态');
          const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
          if (!enabled()) throw new Error('操作已暂停');
          settleMuseumMaterialState(player, state, stock);
          if (pendingMuseumMaterialSpends(player).includes(record.materials)) throw new Error('尚未读到目标地图的新队伍，保留材料和队伍记录');
        } catch (error) {
          // The dispatch response can be confirmed while inventory settlement
          // is still pending. Later readers continue this same reconciliation.
          outcome.materialsPending = true;
          outcome.reason = '探宝材料待确认：' + error.message;
        }
      }
      if (record.ticket && outcome?.ok && !('sent' in outcome)) ledger.confirm(record.ticket);
      // Shared records outlive this guard and retain their business probe if a
      // receipt or complete inventory is unavailable until a later connection.
      forget(record);
    },
    async cancel(step, ticket, { notSent = false, error } = {}) {
      const record = reservations.get(ticket);
      if (!record) return;
      if (record.operation?.confirmed) { forget(record); return; }
      if (notSent) { cancelUnsentGold(record.gold); cancelOrderMaterialSpend(record.materials); }
      else if (error?.prompt && error.request === record.request) { rejectGold(record.gold, error); cancelOrderMaterialSpend(record.materials); }
      else return;
      forget(record);
      if (record.ticket) ledger.cancel(record.ticket);
      for (const [id, amount] of record.costs) if (remaining.has(id)) remaining.set(id, remaining.get(id) + amount);
    },
  };
}

export function budgetPreview(actions, stock, settings, usage = {}) {
  if (!settings) return { actions, notes: [] };
  const balances = new Map(stock);
  const used = { ...usage.counters };
  const limits = usageLimits(settings);
  const kept = [], notes = [];
  for (const step of actions) {
    const costs = actionCosts(step);
    const counters = actionCounters(step);
    let reason;
    for (const [id, cost] of costs) {
      if (id === 'RUBY' && !settings.resources.allowDiamonds) reason = '钻石消耗总开关已关闭';
      else if ((balances.get(id) ?? 0) - cost < resourceReserve(settings, id)) reason = `${id}不足或会低于保留数量`;
    }
    for (const [key, amount] of Object.entries(counters)) if (limits[key] != null && Math.max(used[key] ?? 0, step.counterMinimums?.[key] ?? 0) + amount > limits[key]) reason = '会超过今日使用上限';
    if (reason) { notes.push(`${step.label}：${reason}`); continue; }
    for (const [id, cost] of costs) balances.set(id, (balances.get(id) ?? 0) - cost);
    for (const [key, amount] of Object.entries(counters)) used[key] = Math.max(used[key] ?? 0, step.counterMinimums?.[key] ?? 0) + amount;
    kept.push(step);
  }
  return { actions: kept, notes };
}
