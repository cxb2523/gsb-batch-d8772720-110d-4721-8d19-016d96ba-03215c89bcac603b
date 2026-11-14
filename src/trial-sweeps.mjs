// 试炼钻石/广告扫荡：发送前复查费用与权益，无权益时申请后等待。
import { exactAutomationId } from './automation-policy.mjs';
import { adWaitMs, takeAdSlot, prepareAd, coolAd, isAdNotFinished, AD_PACED_REASON, AD_NOT_FINISHED_REASON, AD_PAUSED_REASON } from './ad-shop.mjs';
const rows = (config, key) => config?.tables?.[key]?.data ?? [];
const valid = n => Number.isSafeInteger(n) && n >= 0;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const dayOf = now => Math.floor((now + 28800) / 86400);
const effectIds = { 1: 4, 2: 3, 3: 5 };
const active = new WeakSet();
function quantity(value) {
  if (valid(value)) return value;
  let n;
  if (typeof value === 'string' && /^\d+$/.test(value)) n = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value?.high)) n = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
function versionOkay(actual, minimum) {
  if (!minimum) return true;
  if (![actual, minimum].every(v => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v))) return false;
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
function adChannelReason(config, player, channel) {
  const supported = { '1400': '14021170', '1422': '14021167' }, id = String(channel?.clientInfo?.channelId ?? '');
  const app = supported[id];
  if (!app || String(channel.clientInfo.appId) !== app || channel.language !== 'zh_CN' ||
    (player.channelId && String(player.channelId) !== id) || (player.appId && String(player.appId) !== app)) return '未确认当前客户端支持国内免广告扫荡';
  const cfg = rows(config, 'AdvChannelCfg').find(r => String(r.key) === id);
  if (cfg?.isOpen !== true || !versionOkay(channel.clientInfo.originVersion, cfg.minAppVersion)) return '当前渠道或版本未开放广告功能';
  const level = rows(config, 'ModuleOpenCfg').find(r => r.moduleId === '广告')?.playerLevel;
  return Number.isInteger(level) && player.level >= level ? '' : '未满足广告功能开放等级';
}
function keyOf(state, mode) { return `trialSweep:${state.worldId}:${state.playerId}:${state.day}:${state.raidId}:${mode}:${mode === 'paid' ? state.buyUsed : state.adUsed}`; }
function pendingFor(state, records) {
  // 广告次数按天重置且不花钱，前一天的未知广告记录不阻塞当天；钻石记录仍跨日核对。
  return Object.values(records).find(r => !r.confirmed && !r.expired && r.details?.kind === 'trialSweep' && r.details.worldId === state.worldId &&
    r.details.playerId === state.playerId && r.details.raidId === state.raidId && !(r.details.mode === 'ad' && r.details.day < state.day));
}

export async function readTrialSweeps(client, protocol, config, player, settings, raidId, { channel = {}, usage = { counters: {} }, records = {}, pendingDiamonds = 0 } = {}) {
  const now = nowOf(client), name = rows(config, 'TrialRaidCfg').find(r => r.raidId === raidId)?.title;
  const state = { raidId, name, day: dayOf(now), worldId: exactAutomationId(player?.worldId), playerId: exactAutomationId(player?.playerId), passedStage: null,
    buyUsed: null, normalLimit: null, normalLeft: null, adUsed: null, adLimit: null, adLeft: null, ruby: null,
    paid: { allowed: false, cost: null, reason: '' }, ad: { allowed: false, cost: 0, reason: '' } };
  if (!name || !state.worldId || !state.playerId) { state.paid.reason = state.ad.reason = '副本、区服或角色身份未确认'; return state; }
  const pref = settings?.trials;
  try {
    const reply = await client.request('TrialRaidInfoRequest', { raidId }, 'TrialRaidInfoResponse');
    const raid = reply?.raid, stage = rows(config, 'TrialRaidStageCfg').find(r => r.raidId === raidId && r.stageId === raid?.passedStage);
    if (raid?.raidId !== raidId || !valid(raid.buySweepTimes)) throw new Error('试炼普通扫荡次数未确认');
    state.buyUsed = raid.buySweepTimes; state.passedStage = raid.passedStage;
    if (!stage || !(player.level >= stage.openLevel)) throw new Error('需要先通关该副本并满足关卡等级');
    const prices = rows(config, 'TrialRaidBuySweepCfg').slice().sort((a,b) => a.buyTimes - b.buyTimes);
    if (!prices.length || prices.some(r => !valid(r.buyTimes) || r.buyTimes < 1 || !valid(r.costRuby)) || new Set(prices.map(r => r.buyTimes)).size !== prices.length) throw new Error('扫荡价格表无效或档位重复');
    const price = prices.find(r => r.buyTimes === state.buyUsed + 1) ?? (state.buyUsed + 1 > prices.at(-1)?.buyTimes ? prices.at(-1) : null);
    if (!price || !valid(price.costRuby)) throw new Error('下一次普通扫荡费用未确认');
    state.paid.cost = price.costRuby;
    if (!price.costRuby) { state.paid.reason = state.ad.reason = '当前首轮可免费扫荡，请先使用免费次数'; return state; }
    const vip = rows(config, 'VipLevelCfg').find(r => r.level === player.vip?.vipLevel);
    try {
      const [cards, resources] = await Promise.all([client.request('MonthCardRequest', {}, 'MonthCardResponse'), client.request('AllResourceRequest', {}, 'AllResourceResponse')]);
      if (!vip || !Array.isArray(cards.cardItem) || !Array.isArray(resources.list)) throw new Error('VIP、月卡或钻石状态未确认');
      const base = rows(config, 'TrialRaidParamCfg').find(r => r.paramName === '试炼副本扫荡次数')?.paramValue;
      const bonus = vip.effects?.find(r => r[0] === '试炼扫荡次数')?.[1] ?? 0;
      if (!valid(base) || !valid(bonus)) throw new Error('普通扫荡次数上限未确认');
      let extra = 0; const cardTypes = new Set();
      for (const card of cards.cardItem) {
        if (!Number.isSafeInteger(card.endTime) || cardTypes.has(card.type)) throw new Error('月卡状态异常'); cardTypes.add(card.type);
        if (card.endTime <= now && card.endTime !== -1) continue;
        const type = card.type === protocol.MonthCardType?.MONTH_CARD_NORMAL ? '普通月卡' : card.type === protocol.MonthCardType?.MONTH_CARD_SENIOR ? '高级月卡' : null;
        const cfg = rows(config, 'MonthCardCfg').find(r => r.id === type);
        if (!cfg || !Array.isArray(cfg.effectList)) throw new Error('有效月卡效果未确认');
        const amount = cfg.effectList.find(r => r[0] === '试炼扫荡次数')?.[1] ?? 0;
        if (!valid(amount)) throw new Error('月卡扫荡次数无效'); extra += amount;
      }
      state.normalLimit = base + bonus + extra;
      if (!valid(state.normalLimit)) throw new Error('普通扫荡次数上限无效');
      state.normalLeft = Math.max(0, state.normalLimit - state.buyUsed);
      const currency = resources.list.filter(r => r.res === protocol.Resource?.RUBY);
      state.ruby = currency.length === 1 ? quantity(currency[0].amount) : null;
      const used = usage.counters ?? {}, paidCount = used['trialPaid' + raidId] ?? 0, spent = used.trialDiamonds ?? 0, allSpent = used.diamonds ?? 0;
      if (![state.ruby, paidCount, spent, allSpent, pendingDiamonds, pref?.paidPerRaidLimit, pref?.dailyDiamondBudget, pref?.maxSingleCost, settings?.resources?.diamondThreshold, settings?.resources?.diamondDailyLimit].every(valid)) throw new Error('钻石余额或本工具预算未确认');
      if (!state.normalLeft) state.paid.reason = '今日普通扫荡次数已用完';
      else if (!settings.resources.allowDiamonds) state.paid.reason = '钻石消耗总开关已关闭';
      else if (paidCount >= pref.paidPerRaidLimit) state.paid.reason = '已达本工具每副本每日钻石扫荡上限';
      else if (price.costRuby > pref.maxSingleCost) state.paid.reason = '本次费用超过单次钻石上限';
      else if (spent + price.costRuby > pref.dailyDiamondBudget || allSpent + price.costRuby > settings.resources.diamondDailyLimit) state.paid.reason = '本次费用超过试炼或全局每日钻石预算';
      else if (state.ruby - pendingDiamonds - price.costRuby < settings.resources.diamondThreshold) state.paid.reason = '钻石不足或会低于全局保留量';
      else state.paid.allowed = true;
    } catch (error) { state.paid.reason = error.message; }
    try {
      const channelReason = adChannelReason(config, player, channel);
      if (channelReason) throw new Error(channelReason);
      let skip = vip?.effects?.some(([key,value]) => key === '免广告' && Number(value) > 0);
      if (!skip) { const charge = await client.request('FirstChargeRequest', {}, 'FirstChargeResponse'); if (!Array.isArray(charge.firstCharge?.record)) throw new Error('免广告权益未确认'); skip = charge.firstCharge.record.length > 0; }
      state.adWaitMs = skip ? 0 : adWaitMs(settings);
      const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
      const id = effectIds[raidId], entries = water.adv?.filter(r => r.id === id);
      const limit = rows(config, 'AdvEffectCfg').find(r => r.id === id)?.dailyLimit;
      if (!entries || entries.length !== 1 || !valid(entries[0].gotTimes) || !valid(limit)) throw new Error('该副本广告扫荡剩余次数未确认');
      state.adUsed = entries[0].gotTimes; state.adLimit = limit; state.adLeft = Math.max(0, limit - state.adUsed); state.effectId = id;
      if (!state.adLeft) state.ad.reason = '今日该副本广告扫荡次数已用完'; else state.ad.allowed = true;
    } catch (error) { state.ad.reason = error.message; }
    if (pendingFor(state, records)) state.paid.reason = state.ad.reason = '前次试炼扫荡结果待确认，暂停该副本的新增扫荡';
    for (const mode of ['paid','ad']) {
      if (records[keyOf(state,mode)] && !state[mode].reason) state[mode].reason = '本次计数对应的扫荡已提交，等待状态更新';
      if (state[mode].reason) state[mode].allowed = false;
    }
  } catch (error) { state.paid.reason = state.ad.reason = error.message; }
  return state;
}

export async function executeTrialSweep(client, protocol, config, player, raidId, mode, { getSettings, ledger, channel = {}, enabled = () => true, expected = null, manual = false } = {}) {
  if (!['paid','ad'].includes(mode)) throw new Error('请选择钻石或免广告扫荡');
  if (!ledger?.reserve || !getSettings) throw new Error('缺少扫荡预算与确认记录');
  if (active.has(client)) return { skipped: true, reason: '试炼扫荡正在处理' };
  const permitted = () => enabled() && client.connected && (manual || getSettings()?.trials?.[mode === 'paid' ? 'paid' : 'ads']);
  if (!permitted()) return { skipped: true, reason: '对应扫荡未开启或账号已暂停' };
  active.add(client);
  const title = (rows(config,'TrialRaidCfg').find(r=>r.raidId===raidId)?.title ?? '试炼') + (mode === 'paid' ? '钻石扫荡' : '免广告扫荡');
  try {
    const read = () => readTrialSweeps(client, protocol, config, player, getSettings(), raidId, { channel, usage: ledger.snapshot(), records: ledger.keyRecords(), pendingDiamonds: ledger.pendingCounters().diamonds ?? 0 });
    let state = await read();
    let reconciled = false;
    for (const [key, record] of Object.entries(ledger.keyRecords())) {
      const d = record.details;
      if (!record.confirmed && d?.kind === 'trialSweep' && d.worldId === state.worldId && d.playerId === state.playerId && d.raidId === raidId && d.day === state.day &&
        ((d.mode === 'paid' && state.buyUsed >= d.nextCount) || (d.mode === 'ad' && state.adUsed != null && state.adUsed >= d.nextCount))) { ledger.resolveKey(key, true); reconciled = true; }
    }
    if (reconciled) state = await read();
    if (!state[mode].allowed) return { title, skipped: true, reason: state[mode].reason };
    const quote = { passedStage: state.passedStage, buyUsed: state.buyUsed, adUsed: state.adUsed, cost: state[mode].cost, day: state.day };
    if (expected && Object.keys(quote).some(k => expected[k] !== quote[k])) throw new Error('试炼进度、费用或次数已变化，请刷新后再扫荡');
    const settings = getSettings(), fresh = await read();
    if (!permitted() || settings !== getSettings() || !fresh[mode].allowed || fresh.worldId !== state.worldId || fresh.playerId !== state.playerId ||
      fresh.passedStage !== state.passedStage || fresh.day !== state.day || fresh.buyUsed !== state.buyUsed || fresh.adUsed !== state.adUsed || fresh[mode].cost !== state[mode].cost) return { title, skipped: true, reason: '发送前扫荡条件已变化，未执行' };
    const paid = mode === 'paid', cost = fresh[mode].cost, counter = 'trialPaid' + raidId;
    const access = { waitMs: paid ? 0 : fresh.adWaitMs ?? 0 }, adTarget = 'effect:' + fresh.effectId;
    if (!paid && !takeAdSlot(client, access, { manual, target: adTarget })) return { title, skipped:true, reason:AD_PACED_REASON };
    const ticket = ledger.reserve(paid ? { diamonds: cost, trialDiamonds: cost, [counter]: 1 } : {}, paid ? { diamonds: settings.resources.diamondDailyLimit, trialDiamonds: settings.trials.dailyDiamondBudget, [counter]: settings.trials.paidPerRaidLimit } : {}, {},
      { uniqueKey: keyOf(fresh,mode), details: { kind:'trialSweep', mode, raidId, worldId:fresh.worldId, playerId:fresh.playerId, day:fresh.day, nextCount:(paid?fresh.buyUsed:fresh.adUsed)+1 } });
    if (!permitted() || getSettings() !== settings || dayOf(nowOf(client)) !== fresh.day) { ledger.cancel(ticket); return { title, skipped:true, reason:'扫荡已暂停或已跨日' }; }
    try {
      if (!paid) {
        if (protocol.AdvType?.ADV_EFFECT !== 1) throw new Error('广告请求类型未确认');
        const ready = await prepareAd(client, access, { type:protocol.AdvType.ADV_EFFECT, id:fresh.effectId }, () => permitted() && settings === getSettings() && dayOf(nowOf(client)) === fresh.day);
        if (!ready) {
          if (!access.waitMs) return { title, pending:true, ok:false, error:'广告准备已提交，扫荡已暂停；保留记录等待核对' };
          ledger.cancel(ticket);
          return { title, skipped:true, reason:AD_PAUSED_REASON };
        }
      }
      await client.sendWatch('TrialRaidBuySweepRequest', { raidId, useAdvCard:!paid }, { window:access.waitMs ? 1500 : 600 });
      const after = await read();
      const confirmed = after.day === fresh.day && after.worldId === fresh.worldId && after.playerId === fresh.playerId && (paid ? after.buyUsed === fresh.buyUsed+1 : after.adUsed === fresh.adUsed+1);
      if (confirmed) { ledger.confirm(ticket); return { title, ok:true, cost, note:'服务端已确认扫荡次数增加' }; }
      return { title, ok:false, pending:true, error:'扫荡已发送，次数变化尚未确认；保留额度和记录，不重复提交' };
    } catch (error) {
      if (isAdNotFinished(error)) {
        ledger.cancel(ticket); coolAd(client, adTarget);
        return { title, skipped:true, reason:AD_NOT_FINISHED_REASON };
      }
      const rejected = error.prompt && ['WatchAdvRequest','TrialRaidBuySweepRequest'].includes(error.request);
      if (rejected) ledger.cancel(ticket);
      return { title, ok:false, pending:!rejected, error:error.message };
    }
  } finally { active.delete(client); }
}

export async function runExtraTrialSweeps(client, protocol, config, player, { getSettings, ledger, channel, enabled, report } = {}) {
  for (const mode of ['ad','paid']) {
    if (!enabled(mode)) continue;
    for (const id of getSettings().trials.raidIds) {
      if (!enabled(mode)) break;
      try { report(await executeTrialSweep(client, protocol, config, player, Number(id), mode, { getSettings, ledger, channel, enabled:()=>enabled(mode) })); }
      catch (error) { report({ title:'试炼'+(mode==='paid'?'钻石':'免广告')+'扫荡', ok:false, error:error.message }); }
    }
  }
}
