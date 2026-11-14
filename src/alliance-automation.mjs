// 常驻联盟自动化。协议与客户端依据见 docs/alliance-automation.md。
import { createHash } from 'node:crypto';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { beijingDay } from './automation-settings.mjs';
import { displayMaterial } from './config.mjs';
import { readMutualAid } from './guild-mutual.mjs';
import { claimGuildWelfare, claimMyGuildAid } from './guild.mjs';
import { readGuildTech, upgradeGuildTech } from './guild-tech.mjs';
import { readGuildOrderView, serviceGuildOrders } from './guild-orders.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const valid = n => Number.isSafeInteger(n) && n >= 0;
const stamp = player => [exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), exactAutomationId(player?.guildId)].join(':');
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const rejected = (error, request, sent) => (!sent && error.notSent === true) || error.prompt && error.request === request;
const scope = (record, player) => record.details?.worldId === exactAutomationId(player.worldId) && record.details?.playerId === exactAutomationId(player.playerId);
const busy = new WeakSet();

export function allianceExchangeMaterial(player) {
  const world = exactAutomationId(player?.worldId), season = world ? Number(BigInt(world) / 1000000n % 1000n) : 0;
  return season >= 4 ? '灭火器' : season === 3 ? '珍珠胸针' : season >= 1 ? '橡胶圈' : null;
}

export function allianceMaterialAllowed(itemId, settings, player) {
  const p = settings?.alliance ?? {};
  if (p.blockedMaterials?.includes(itemId)) return false;
  if (p.mutualMode !== 'exchange' && p.allowedMaterials?.length && !p.allowedMaterials.includes(itemId)) return false;
  return p.mutualMode !== 'exchange' || itemId === allianceExchangeMaterial(player);
}

function askMaterialAllowed(itemId, config, player, settings) {
  const world = exactAutomationId(player?.worldId), season = world ? Number(BigInt(world) / 1000000n % 1000n) : 0;
  if (!season || !rows(config, 'GuildHelpCfg').some(row => row.id === itemId && (row.season ?? 0) <= season)) return false;
  // 赠送白/黑名单不限制自己请求材料；贡献模式也不读取隐藏的自定义白名单。
  return settings.alliance.mutualMode !== 'exchange' || itemId === allianceExchangeMaterial(player);
}

export function allianceRecruitDemand(view, settings, usage = {}) {
  const p = settings?.alliance;
  if (!p?.enabled || !p.recruit || !p.recruitProduction || !view || !valid(view.doneToday) || !valid(view.day) || !view.cityId) return [];
  if (p.recruitDailyLimit > 0 && Math.max(view.doneToday, usage.counters?.guildRecruit ?? 0) >= p.recruitDailyLimit) return [];
  if (view.maxNum !== -1 && (!valid(view.maxNum) || view.doneToday >= view.maxNum)) return [];
  if (!view.requirements?.length || !(view.nextRefreshTime > view.checkedAt)) return [];
  return [{ source: 'guildRecruit', requirements: view.requirements.map(row => ({ id: row.id, num: row.need })),
    reserved: view.requirements.map(row => ({ id: row.id, num: row.reserved ?? 0 })) }];
}

export async function readAllianceRecruitDemand(client, protocol, config, player, settings, { enabled = () => true, ledger } = {}) {
  const p = settings?.alliance;
  if (!p?.enabled || !p.recruit || !p.recruitProduction || !enabled()) return [];
  let view;
  try { view = await readGuildOrderView(client, protocol, config, { player, enabled }); }
  catch (error) { if (error.code === 'ORDER_MATERIAL_SPEND_PENDING') return []; throw error; }
  const roleKey = exactAutomationId(player.worldId) + ':' + exactAutomationId(player.playerId);
  if (ledger && Object.values(ledger.keyRecords()).some(record => record.details?.kind === 'allianceRecruit' && (record.details.accountKey === view.accountKey || record.details.roleKey === roleKey) &&
    (!record.confirmed || record.details.day === view.day && record.details.doneToday >= view.doneToday))) return [];
  return allianceRecruitDemand({ ...view, checkedAt: nowOf(client) }, settings, ledger?.snapshot());
}

async function aidState(client, protocol, config, player, enabled) {
  const state = await readMutualAid(client, config, player, { target: 20, mode: 'all', memberIds: [], askEnabled: false });
  const counter = await client.request('CounterInfoRequest', {}, 'CounterInfoResponse');
  const matches = counter.counters?.filter(row => row.type === 'DAILY_GUILD_AID');
  if (!Array.isArray(matches) || matches.length > 1) throw Error('今日联盟求助计数未完整返回');
  const count = matches.length ? Number(matches[0].num?.low === undefined ? matches[0].num : BigInt(matches[0].num.high) * 4294967296n + BigInt(matches[0].num.low >>> 0)) : 0;
  const limit = rows(config, 'GuildParamCfg').find(row => row.paramName === '每日求助次数上限')?.paramValue;
  if (!valid(count) || !valid(limit) || limit < 1) throw Error('今日联盟求助次数或上限未确认');
  const reserved = await readOrderReservedStock(client, protocol, config, { player, enabled, itemIds: [...new Set(state.candidates.map(row => row.itemId))] });
  if (!enabled()) throw Error('账号状态已变化');
  return { ...state, ...reserved, askUsed: count, askLimit: limit };
}

function chooseAskItem(state, config, player, settings) {
  const p = settings.alliance;
  const selected = p.mutualMode === 'exchange' ? [allianceExchangeMaterial(player)] : p.requestMaterials?.length ? p.requestMaterials :
    [...state.reserved].filter(([id, need]) => need > (state.stock.get(id) ?? 0)).map(([id]) => id).concat(state.missingItems ?? []);
  return selected.find(id => askMaterialAllowed(id, config, player, settings)) ?? null;
}

async function resolveAidRecords(state, ledger, player) {
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!scope(record, player)) continue;
    const d = record.details;
    if (!record.confirmed && d.kind === 'guildAidGift' && d.acknowledged && !state.askIds.includes(d.reqId)) ledger.resolveKey(key, true);
    if (!record.confirmed && d.kind === 'guildAidClaim' && !d.ids.some(id => state.ownRequests.some(row => row.id === id))) {
      ledger.resolveKey(key, true);
      if (d.sequenceKey && d.items?.length) {
        const seq = ledger.keyRecords()[d.sequenceKey]?.details;
        if (seq && d.items.includes(seq.itemId)) ledger.updateKeyDetails(d.sequenceKey, { ...seq, received: true });
      }
    }
    if (!record.confirmed && d.kind === 'guildAidAsk' && d.day === state.day && state.askUsed >= d.nextCount &&
      state.ownRequests.some(row => row.itemId === d.itemId && !d.beforeIds.includes(row.id))) ledger.resolveKey(key, true);
    // Completed per-request records need not accumulate indefinitely. Sequence
    // markers survive throughout the day, including after process restarts.
    if (record.confirmed && d.day && d.day !== state.day && ['guildAidGift', 'guildAidAsk', 'guildAidSequence', 'guildAidClaim'].includes(d.kind)) ledger.releaseCompletedKey(key);
  }
}

async function runMutual(client, protocol, config, player, { getSettings, ledger, enabled, report }) {
  let state = await aidState(client, protocol, config, player, enabled);
  if (ledger.snapshot().day !== state.day) throw Error('账号账本与游戏日期尚未对齐');
  await resolveAidRecords(state, ledger, player);
  const identity = stamp(player), day = state.day;
  const current = () => enabled() && stamp(player) === identity && beijingDay(nowOf(client) * 1000) === day;
  const unfinished = kind => Object.values(ledger.keyRecords()).some(record => !record.confirmed && scope(record, player) && record.details.kind === kind);
  const selection = getSettings().alliance;
  const seqKey = 'guildAidSequence:' + state.worldId + ':' + state.playerId + ':' + day + ':' + digest(JSON.stringify([selection.mutualMode, selection.requestMaterials]));
  const sequence = () => ledger.keyRecords()[seqKey]?.details;
  // Receiving is independent of help/ask switches, but still follows the
  // alliance + mutual master gates and persistent unknown-result protection.
  if (state.ready.length) {
    if (unfinished('guildAidClaim')) return report({ key: 'allianceMutual', label: '联盟互助', skipped: true, reason: '上次领取结果待确认' });
    let ticket, sent = false;
    const before = state.ownRequests.filter(row => state.ready.includes(row.id));
    try {
      const result = await claimMyGuildAid(client, config, { player, enabled: current, beforeSend(ids) {
        if (!current()) throw Error('领取前账号或日期已变化');
        ticket = ledger.reserve({}, {}, {}, { uniqueKey: 'guildAidClaim:' + state.worldId + ':' + state.playerId + ':' + digest(ids.slice().sort().join(',')),
          details: { kind: 'guildAidClaim', worldId: state.worldId, playerId: state.playerId, day, ids, sequenceKey: seqKey, items: before.map(row => row.itemId) } });
      } });
      sent = true;
      if (!result.ok) throw Error(result.label);
      ledger.confirm(ticket);
      const seq = sequence();
      if (seq && before.some(row => row.itemId === seq.itemId)) ledger.updateKeyDetails(seqKey, { ...seq, received: true });
      report({ key: 'allianceMutual', label: result.label, ok: true });
      if (!current()) return;
      state = await aidState(client, protocol, config, player, current);
    } catch (error) {
      if (ticket && (error.guildAidClaimNotSent === true || error.prompt && error.request === 'GotMyGuildAidRequest')) ledger.cancel(ticket);
      report({ key: 'allianceMutual', label: '联盟互助领取', error: error.message, pending: !!ticket && !sent }); return;
    }
  }
  let p = getSettings().alliance;
  if (p.autoAsk && current()) {
    if (p.mutualMode !== 'exchange' && !p.requestMaterials?.length && p.recruit) {
      const recruitment = await readGuildOrderView(client, protocol, config, { player, enabled: current });
      // Asking remains independent of the recruitment factory setting, but
      // does not prepare a new recruitment once either daily cap is exhausted.
      const cap = p.recruitDailyLimit;
      if ((!cap || Math.max(recruitment.doneToday ?? 0, ledger.snapshot().counters.guildRecruit ?? 0) < cap) &&
        (recruitment.maxNum === -1 || recruitment.doneToday < recruitment.maxNum)) state.missingItems = recruitment.requirements.filter(row => row.missing > 0).map(row => row.id);
    }
    const askItem = sequence()?.itemId ?? chooseAskItem(state, config, player, getSettings());
    if (!askItem) report({ key: 'allianceAsk', label: '联盟自动求助', skipped: true, reason: p.mutualMode === 'exchange' ? '本赛季贡献材料未开放，不回退其他赛季材料' : '未选择求助材料，当前也没有可求助的缺料' });
    else if (askMaterialAllowed(askItem, config, player, getSettings())) {
      if (!sequence()) {
        const token = ledger.reserve({}, {}, {}, { uniqueKey: seqKey, details: { kind: 'guildAidSequence', worldId: state.worldId, playerId: state.playerId, day, itemId: askItem, received: false } });
        ledger.confirm(token);
      }
      // First publish only one request. After an actual matching collection,
      // issue remaining daily requests for that material, rechecking each send.
      for (let count = 0; count < state.askLimit && current() && getSettings().alliance.autoAsk; count++) {
        if (unfinished('guildAidAsk')) { report({ key: 'allianceAsk', label: '联盟自动求助', skipped: true, reason: '前次求助结果待确认，不重复发布' }); break; }
        if (state.askUsed >= state.askLimit) break;
        if (!sequence()?.received && state.ownRequests.some(row => row.itemId === askItem && (row.ready || row.endTime > state.now))) break;
        if (!askMaterialAllowed(askItem, config, player, getSettings())) break;
        const key = 'guildAidAsk:' + state.worldId + ':' + state.playerId + ':' + day + ':' + state.askUsed;
        if (ledger.hasKey(key)) break;
        const token = ledger.reserve({ guildAidAsks: 1 }, { guildAidAsks: state.askLimit }, { guildAidAsks: state.askUsed }, { uniqueKey: key,
          details: { kind: 'guildAidAsk', worldId: state.worldId, playerId: state.playerId, day, itemId: askItem, nextCount: state.askUsed + 1, beforeIds: state.ownRequests.map(row => row.id) } });
        if (!current() || !getSettings().alliance.autoAsk) { ledger.cancel(token); break; }
        let sent = false;
        try {
          await client.sendWatch('GuildAidAskRequest', { reqItemId: askItem, type: 0 }, { window: 400 }); sent = true;
          const after = await aidState(client, protocol, config, player, current);
          if (after.day !== day || after.askUsed !== state.askUsed + 1 || !after.ownRequests.some(row => row.itemId === askItem && !state.ownRequests.some(old => old.id === row.id))) throw Error('求助次数与新请求尚未确认');
          ledger.confirm(token); state = after;
          report({ key: 'allianceAsk', label: '已求助 ' + displayMaterial(config, askItem) + '，今日 ' + state.askUsed + '/' + state.askLimit, ok: true });
        } catch (error) { if (rejected(error, 'GuildAidAskRequest', sent)) ledger.cancel(token); report({ key: 'allianceAsk', label: '联盟自动求助', error: error.message, pending: !rejected(error, 'GuildAidAskRequest', sent) }); break; }
        if (!sequence()?.received) break;
      }
    }
  }
  p = getSettings().alliance;
  if (!current() || !p.autoHelp || !p.helpDailyLimit) return;
  if (unfinished('guildAidGift')) return report({ key: 'allianceHelp', label: '联盟自动帮助', skipped: true, reason: '前次赠送结果待确认，保留用量' });
  if ((ledger.snapshot().counters.guildAidGifts ?? 0) >= p.helpDailyLimit) return;
  const topUp = (nowOf(client) + 28800) % 86400 >= 23 * 3600 + 40 * 60;
  const maxGifts = topUp ? Math.min(p.helpDailyLimit, 100) : 1;
  for (let gift = 0; gift < maxGifts && current(); gift++) {
  p = getSettings().alliance;
  if (!p.autoHelp || (ledger.snapshot().counters.guildAidGifts ?? 0) >= p.helpDailyLimit) return;
  // Refresh after any ask/collection and immediately before donating. All
  // modes, including late-night top-up, retain material and nickname filters.
  state = await aidState(client, protocol, config, player, current);
  p = getSettings().alliance;
  const chosen = state.candidates.find(row => allianceMaterialAllowed(row.itemId, getSettings(), player) &&
    (!p.memberKeywords?.length || p.memberKeywords.some(word => row.name.toLocaleLowerCase().includes(word.toLocaleLowerCase()))) &&
    (state.available.get(row.itemId) ?? 0) - p.stockReserve >= 1 && !ledger.hasKey('guildAidGift:' + state.worldId + ':' + state.playerId + ':' + row.id));
  if (!chosen) return report({ key: 'allianceHelp', label: '联盟自动帮助', skipped: true, reason: '没有符合材料、昵称、库存保留和订单预留的求助' });
  if (!current() || !p.autoHelp || chosen.endTime <= nowOf(client)) return;
  const key = 'guildAidGift:' + state.worldId + ':' + state.playerId + ':' + chosen.id;
  const details = { kind: 'guildAidGift', day, worldId: state.worldId, playerId: state.playerId, guildId: state.guildId, reqId: chosen.id, memberId: chosen.memberId, itemId: chosen.itemId };
  const token = ledger.reserve({ guildAidGifts: 1 }, { guildAidGifts: p.helpDailyLimit }, {}, { uniqueKey: key, details });
  let debit, sent = false;
  try {
    debit = beginOrderMaterialSpend(player, [{ id: chosen.itemId, need: 1, have: state.stock.get(chosen.itemId) ?? 0 }], '联盟自动帮助', { operation: {} });
    if (!current() || !getSettings().alliance.autoHelp) { ledger.cancel(token); cancelOrderMaterialSpend(debit); return; }
    const reply = await client.request('GuildAidHelpRequest', { reqId: [automationWireId(chosen.id)], type: 0 }, 'GotRewardResponse'); sent = true;
    if (!reply?.reward?.asset?.some(row => typeof row.id === 'string' && Number(row.num?.low === undefined ? row.num : row.num.low) > 0)) throw Error('赠送回执没有有效奖励');
    ledger.updateKeyDetails(key, { ...details, acknowledged: true });
    confirmOrderMaterialOperation(debit);
    await refreshOrderMaterialSpends(client, player, { enabled: current });
    if (!current()) throw Error('赠送已回执，等待账号恢复后核对');
    const after = await aidState(client, protocol, config, player, current);
    if (after.askIds.includes(chosen.id)) throw Error('求助完成状态尚未确认');
    ledger.confirm(token);
    report({ key: 'allianceHelp', label: '已帮助 ' + chosen.name + '：' + chosen.material + ' ×1', ok: true });
  } catch (error) {
    if (!debit || rejected(error, 'GuildAidHelpRequest', sent)) { ledger.cancel(token); cancelOrderMaterialSpend(debit); }
    report({ key: 'allianceHelp', label: '联盟自动帮助', error: error.message, pending: !!debit && !rejected(error, 'GuildAidHelpRequest', sent) });
    return;
  }
  }
}

export async function runAllianceAutomation(client, protocol, config, player, { getSettings, ledger, enabled = () => true, report = () => {} } = {}) {
  if (!getSettings?.()?.alliance?.enabled || !enabled() || busy.has(client)) return [];
  if (!ledger) throw Error('联盟自动化需要持久账本');
  const original = stamp(player), policy = JSON.stringify(getSettings().alliance), records = [];
  const active = () => enabled() && client.connected !== false && stamp(player) === original && getSettings().alliance.enabled && JSON.stringify(getSettings().alliance) === policy;
  const emit = entry => { records.push(entry); report(entry); };
  const run = async (label, work) => { try { if (active()) await work(); } catch (error) { emit({ key: 'alliance', label, error: error.message, skipped: error.code === 'ORDER_MATERIAL_SPEND_PENDING' }); } };
  busy.add(client);
  try {
    if (getSettings().alliance.recruit) await run('联盟募兵', () => serviceGuildOrders(client, protocol, config, { player, ledger,
      dailyLimit: getSettings().alliance.recruitDailyLimit, enabled: () => active() && getSettings().alliance.recruit, report: emit }));
    if (getSettings().alliance.mutual) await run('联盟互助', () => runMutual(client, protocol, config, player, { getSettings, ledger, enabled: () => active() && getSettings().alliance.mutual, report: emit }));
    if (getSettings().alliance.collectGifts) await run('联盟福利礼包', async () => emit(await claimGuildWelfare(client, config, { player, enabled: () => active() && getSettings().alliance.collectGifts })));
    if (getSettings().alliance.autoTech) await run('联盟科技自动升级', async () => {
      const p = getSettings().alliance;
      if ((ledger.snapshot().counters.allianceTech ?? 0) >= p.techDailyLimit) return;
      const view = await readGuildTech(client, config, player, { ledger });
      const chosen = view.rows.find(row => row.canUpgrade && (!p.techIds?.length || p.techIds.includes(String(row.id))));
      if (!chosen) return emit({ key: 'allianceTech', label: '联盟科技自动升级', skipped: true, reason: view.reason || '所选科技暂无可用升级或科技点不足' });
      const result = await upgradeGuildTech(client, config, player, { techId: chosen.id, expectedLevel: chosen.level, maxCost: chosen.cost, ledger,
        counters: { allianceTech: 1 }, limits: { allianceTech: p.techDailyLimit },
        enabled: () => active() && getSettings().alliance.autoTech && (!getSettings().alliance.techIds?.length || getSettings().alliance.techIds.includes(String(chosen.id))) });
      emit({ key: 'allianceTech', ...result });
    });
    return records;
  } finally { busy.delete(client); }
}
