// 挂机收益与工厂/建筑/博物馆加速的广告入口，广告次数读 OnWaterResponse.adv。
import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';
import { adAccess, takeAdSlot, prepareAd, coolAd, isAdNotFinished, AD_PACED_REASON, AD_NOT_FINISHED_REASON, AD_PAUSED_REASON } from './ad-shop.mjs';

const EFFECT_AFK = 1, EFFECT_PRODUCTION = 6, EFFECT_BUILDING = 8;
const AD_SPEED_UP = { type: 3, useNum: 0 };
// OfflineRewardView 只在本段挂机开始 60 秒内显示广告按钮，超过后走普通领取。
const AFK_AD_WINDOW = 60;
// 每次广告固定加速 30 分钟，快完工的目标不值得占用当天次数和等待时间。
const MIN_REMAINING = 120;
const RETRY_UNAVAILABLE = 1800;
const UNCONFIRMED_WINDOW_MS = 1500;
const SPEED_UP_KEYS = ['adSpeedUpProduce', 'adSpeedUpBuilding', 'adSpeedUpMuseum'];

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const dayOf = time => Math.floor((time + 28800) / 86400);
const natural = n => Number.isSafeInteger(n) && n >= 0;
const readWater = async client => normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
const blockedBy = (list, building) => !!list?.some(id => id === building.type || id === building.buildingId);

function effectTimes(config, water, effectId) {
  const limit = rows(config, 'AdvEffectCfg').find(row => row.id === effectId)?.dailyLimit;
  const entries = water.adv?.filter(row => row.id === effectId);
  if (!natural(limit) || entries?.length !== 1 || !natural(entries[0].gotTimes)) throw new Error('广告次数未完整返回');
  return { used: entries[0].gotTimes, limit };
}

// 次数已增加说明前次已生效；前一天的未知记录不占用当天次数。
function hasUnresolved(ledger, effectId, day, used) {
  let unresolved = false;
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    const details = record.details;
    if (record.confirmed || record.expired || details?.kind !== 'adEffect' || details.effectId !== effectId || details.day !== day) continue;
    if (used > details.used) ledger.resolveKey(key, true);
    else unresolved = true;
  }
  return unresolved;
}

async function spendEffect(client, config, ctx, access, { key, label, effectId, used, urgent = false, stillValid = () => true, recheck, request, send, confirmed }) {
  const { ledger } = ctx;
  const day = dayOf(clock(client));
  const target = 'effect:' + effectId;
  const allowed = () => ctx.enabled(key) && dayOf(clock(client)) === day && stillValid();
  const report = entry => ctx.report({ label, taskKey: key, ...entry });
  const skip = reason => { report({ skipped: true, reason }); return false; };
  if (hasUnresolved(ledger, effectId, day, used)) return skip('前次广告领取结果待核对，未重复提交');
  const uniqueKey = 'ad-effect:' + day + ':' + effectId + ':' + used;
  if (ledger.hasKey(uniqueKey)) return skip('本次计数对应的广告已领取，等待状态更新');
  if (!takeAdSlot(client, access, { manual: urgent, target })) return skip(AD_PACED_REASON);
  try {
    if (!await prepareAd(client, access, { type: 1, id: effectId }, allowed)) return skip(AD_PAUSED_REASON);
  } catch (error) {
    coolAd(client, target);
    report({ ok: false, error: error.message });
    return false;
  }
  const water = await readWater(client);
  if (effectTimes(config, water, effectId).used !== used || !await recheck(water)) return skip(AD_PAUSED_REASON);
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey, details: { kind: 'adEffect', effectId, day, used } });
  if (!allowed()) { ledger.cancel(ticket); return skip(AD_PAUSED_REASON); }
  try {
    const reply = await send();
    const after = await readWater(client);
    if (effectTimes(config, after, effectId).used <= used) throw new Error('服务端未确认广告次数增加');
    const note = await confirmed(reply, after);
    if (note === false) throw new Error('广告次数已增加，但目标状态尚未确认');
    ledger.confirm(ticket);
    report({ ok: true, status: 'confirmed', ...(typeof note === 'string' ? { note } : {}) });
    return true;
  } catch (error) {
    if (isAdNotFinished(error)) {
      ledger.cancel(ticket);
      coolAd(client, target);
      return skip(AD_NOT_FINISHED_REASON);
    }
    const rejected = !!error.prompt && error.request === request;
    if (rejected) { ledger.cancel(ticket); coolAd(client, target); }
    report({ ok: false, status: rejected ? 'rejected' : 'unknown', error: error.message });
    return false;
  }
}

function deferUnavailable(ctx, keys) {
  for (const key of keys) ctx.scheduler?.defer?.(key, ctx.scheduler.now() + RETRY_UNAVAILABLE);
}

function rewardText(config, reply) {
  const assets = normalize(reply?.reward)?.assetPackage?.asset ?? [];
  return assets.filter(asset => asset.num > 0).map(asset => displayMaterial(config, asset.id) + ' ×' + asset.num).join('、');
}

// 在普通领取重置计时后立刻调用才能赶上 60 秒窗口，所以这里不受每轮限速影响。
export async function claimAfkAd(client, config, ctx) {
  const key = 'afkAd', label = '闯关挂机广告收益';
  if (!ctx.enabled(key)) return;
  if (!ctx.ledger) return ctx.report({ label, taskKey: key, skipped: true, reason: '账号执行记录不可用' });
  const access = await adAccess(client, config.tables, { ...ctx, settings: ctx.getSettings?.() });
  if (access.reason) {
    ctx.report({ label, taskKey: key, skipped: true, reason: access.reason });
    deferUnavailable(ctx, [key]);
    return;
  }
  const { used, limit } = effectTimes(config, await readWater(client), EFFECT_AFK);
  if (used >= limit) {
    ctx.report({ label, taskKey: key, skipped: true, reason: '今日广告次数已用完' });
    ctx.scheduler?.defer?.(key, ctx.scheduler.nextDay());
    return;
  }
  const afk = normalize((await client.request('AfkInfoRequest', {}, 'AfkInfoResponse'))?.afkInfo);
  if (!afk) throw new Error('挂机收益状态未同步');
  if (!(afk.level > 0) || !natural(afk.afkStartTime)) {
    ctx.report({ label, taskKey: key, skipped: true, reason: '挂机收益尚未开放' });
    return;
  }
  if (clock(client) - afk.afkStartTime - 1 > AFK_AD_WINDOW) {
    ctx.report({ label, taskKey: key, skipped: true, reason: '只在普通挂机收益领取后的 60 秒内可用，等待下一次领取' });
    return;
  }
  await spendEffect(client, config, ctx, access, {
    key, label, effectId: EFFECT_AFK, used, urgent: true, request: 'DrawAfkRewardRequest',
    recheck: () => true,
    send: () => client.request('DrawAfkRewardRequest', { useAdvCard: true }, 'DrawAfkRewardResponse'),
    confirmed: reply => (reply?.afkStartTime >= afk.afkStartTime ? rewardText(config, reply) : false),
  });
}

function productionTarget(water, settings, now) {
  const jobs = [];
  for (const building of water.building ?? []) {
    if (!building.factory || blockedBy(settings?.factory?.disabledTypes, building)) continue;
    for (const job of building.factory.factoryQ ?? []) {
      if (job.finishTime - now > MIN_REMAINING) jobs.push({ buildingId: building.buildingId, idx: job.idx ?? 0, productId: job.productId, finishTime: job.finishTime });
    }
  }
  return jobs.sort((a, b) => b.finishTime - a.finishTime)[0] ?? null;
}

// DispFactoryJob.idx 为 optional，0 号队列可能不在线路上出现。
const findJob = (water, target) => water.building?.find(b => b.buildingId === target.buildingId)?.factory?.factoryQ?.find(job => (job.idx ?? 0) === target.idx);
const findBuilding = (water, target) => water.building?.find(b => b.buildingId === target.buildingId);

function museumReady(config, water) {
  const ids = rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === '博物馆').map(row => row.buildingId);
  return (water.building ?? []).some(b => ids.includes(b.buildingId) && b.level > 0 && !(b.buildFinishTime > 0));
}

async function readMuseumCases(client) {
  const info = normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
  return (info.exhibitions ?? []).flatMap(exhibition => (exhibition.cases ?? [])
    .filter(row => natural(row.caseIndex) && row.upgradeFinishTime > 0)
    .map(row => ({ exhibitionId: exhibition.exhibitionId, caseIndex: row.caseIndex, finishTime: row.upgradeFinishTime })));
}

const findCase = (cases, target) => cases.find(row => row.exhibitionId === target.exhibitionId && row.caseIndex === target.caseIndex);

// 客户端在展柜到期后补发完工请求；工具没有其他入口处理展柜升级，这里一并收尾。
async function finishMuseumCases(client, ctx, cases, now) {
  for (const item of cases.filter(row => row.finishTime <= now)) {
    const key = 'museum-case-finish:' + item.exhibitionId + ':' + item.caseIndex + ':' + item.finishTime;
    if (!ctx.enabled('adSpeedUpMuseum') || ctx.ledger.hasKey(key)) continue;
    const label = '博物馆展柜升级完工';
    const ticket = ctx.ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'museumCaseFinish' } });
    try {
      await client.sendWatch('MuseumFinishCaseUpgradeRequest', { exhibitionId: item.exhibitionId, caseIndex: item.caseIndex }, { window: UNCONFIRMED_WINDOW_MS });
      if (findCase(await readMuseumCases(client), item)?.finishTime === item.finishTime) throw new Error('服务端未确认展柜完工');
      ctx.ledger.confirm(ticket);
      ctx.report({ label, taskKey: 'adSpeedUpMuseum', ok: true, status: 'confirmed' });
    } catch (error) {
      const rejected = !!error.prompt && error.request === 'MuseumFinishCaseUpgradeRequest';
      if (rejected) ctx.ledger.cancel(ticket);
      ctx.report({ label, taskKey: 'adSpeedUpMuseum', ok: false, status: rejected ? 'rejected' : 'unknown', error: error.message });
    }
  }
}

function productionSpec(client, target) {
  return {
    key: 'adSpeedUpProduce', effectId: EFFECT_PRODUCTION, request: 'SpeedUpFactoryProduceRequest',
    label: '工厂生产广告加速', finishTime: target.finishTime,
    stillValid: () => target.finishTime > clock(client),
    recheck: water => findJob(water, target)?.finishTime > clock(client),
    send: () => client.request('SpeedUpFactoryProduceRequest', { buildingId: target.buildingId, index: target.idx, speedUp: AD_SPEED_UP }, 'OkResponse'),
    confirmed: (_, after) => {
      const job = findJob(after, target);
      return !job || job.productId !== target.productId || job.finishTime < target.finishTime;
    },
  };
}

function buildingSpec(client, target) {
  return {
    key: 'adSpeedUpBuilding', effectId: EFFECT_BUILDING, request: 'SpeedUpUpgradeBuildingRequest',
    label: '建筑升级广告加速', finishTime: target.finishTime,
    stillValid: () => target.finishTime > clock(client),
    recheck: water => findBuilding(water, target)?.buildFinishTime > clock(client),
    send: () => client.sendWatch('SpeedUpUpgradeBuildingRequest', { buildingId: target.buildingId, speedUp: AD_SPEED_UP }, { window: UNCONFIRMED_WINDOW_MS }),
    confirmed: (_, after) => !(findBuilding(after, target)?.buildFinishTime >= target.finishTime),
  };
}

function museumSpec(client, target) {
  return {
    key: 'adSpeedUpMuseum', effectId: EFFECT_BUILDING, request: 'MuseumSpeedUpCaseRequest',
    label: '博物馆展柜广告加速', finishTime: target.finishTime,
    stillValid: () => target.finishTime > clock(client),
    recheck: async () => findCase(await readMuseumCases(client), target)?.finishTime > clock(client),
    send: () => client.sendWatch('MuseumSpeedUpCaseRequest', { exhibitionId: target.exhibitionId, caseIndex: target.caseIndex, speedUp: AD_SPEED_UP }, { window: UNCONFIRMED_WINDOW_MS }),
    confirmed: async () => !(findCase(await readMuseumCases(client), target)?.finishTime >= target.finishTime),
  };
}

async function runSpeedUps(client, config, ctx, access, effectId, keys, pick) {
  // 有权益时无限速，按当天次数上限兜底，避免服务端计数异常时死循环。
  const limit = rows(config, 'AdvEffectCfg').find(row => row.id === effectId)?.dailyLimit ?? 0;
  for (let attempt = 0; attempt <= limit; attempt++) {
    const active = keys.filter(ctx.enabled);
    if (!active.length) return;
    const water = await readWater(client);
    const { used, limit: daily } = effectTimes(config, water, effectId);
    if (used >= daily) {
      for (const key of active) {
        ctx.report({ label: '广告加速', taskKey: key, skipped: true, reason: '今日广告次数已用完' });
        ctx.scheduler?.defer?.(key, ctx.scheduler.nextDay());
      }
      return;
    }
    const spec = await pick(water, active);
    if (!spec || !await spendEffect(client, config, ctx, access, { ...spec, used })) return;
  }
}

// 只加速进行中的目标，不会为了用次数去新开生产或升级。放在读取基地状态之前，
// 这样后续加速器计划按缩短后的剩余时间计算，不会多花加速器。
export async function claimAdSpeedUps(client, config, ctx) {
  if (!SPEED_UP_KEYS.some(ctx.enabled)) return;
  if (!ctx.ledger) return ctx.report({ label: '广告加速', skipped: true, reason: '账号执行记录不可用' });
  const settings = ctx.getSettings?.();
  const access = await adAccess(client, config.tables, { ...ctx, settings });
  if (access.reason) {
    const active = SPEED_UP_KEYS.filter(ctx.enabled);
    for (const key of active) ctx.report({ label: '广告加速', taskKey: key, skipped: true, reason: access.reason });
    deferUnavailable(ctx, active);
    return;
  }
  await runSpeedUps(client, config, ctx, access, EFFECT_PRODUCTION, ['adSpeedUpProduce'], water => {
    const target = productionTarget(water, settings, clock(client));
    return target && productionSpec(client, target);
  });
  if (ctx.enabled('adSpeedUpMuseum')) {
    const water = await readWater(client);
    if (museumReady(config, water)) await finishMuseumCases(client, ctx, await readMuseumCases(client), clock(client));
  }
  await runSpeedUps(client, config, ctx, access, EFFECT_BUILDING, ['adSpeedUpBuilding', 'adSpeedUpMuseum'], async (water, active) => {
    const now = clock(client);
    const candidates = [];
    if (active.includes('adSpeedUpBuilding')) {
      for (const building of water.building ?? []) {
        if (building.buildFinishTime - now > MIN_REMAINING && !blockedBy(settings?.building?.disabledTypes, building))
          candidates.push(buildingSpec(client, { buildingId: building.buildingId, finishTime: building.buildFinishTime }));
      }
    }
    if (active.includes('adSpeedUpMuseum') && museumReady(config, water)) {
      for (const item of await readMuseumCases(client)) {
        if (item.finishTime - now > MIN_REMAINING) candidates.push(museumSpec(client, item));
      }
    }
    return candidates.sort((a, b) => b.finishTime - a.finishTime)[0] ?? null;
  });
}
