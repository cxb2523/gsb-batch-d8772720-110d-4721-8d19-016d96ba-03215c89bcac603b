import { uidText } from './hero-equipment.mjs';
import { toNumber } from './client.mjs';
import { describeLogError } from './log-errors.mjs';
import { displayMaterial } from './config.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend } from './order-reservations.mjs';

const accounts = new Map();
const keys = ['museumCollect', 'museumExplore'];
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const num = (value, label, min = 0) => {
  const n = value == null ? NaN : toNumber(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error('无法确认' + label);
  return n;
};
const list = (value, label) => { if (!Array.isArray(value)) throw new Error('未能读取' + label); return value; };
const accountKey = player => JSON.stringify([uidText(player?.playerId), uidText(player?.worldId)]);
const identity = player => JSON.stringify([accountKey(player), player?.level]);
const sameHeroes = (a, b) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

function stateFor(key) {
  if (!accounts.has(key)) accounts.set(key, { busy: false, trips: new Map(), starts: new Map() });
  return accounts.get(key);
}

function stageOf(raw) {
  const stageId = num(raw?.stageId, '探险关卡编号', 1);
  const progress = num(raw?.progress, '探险进度');
  let expedition = null;
  if (raw.expedition) {
    const e = raw.expedition;
    const heroIds = list(e.heroIds, '探险英雄').slice();
    if (heroIds.some(id => typeof id !== 'string' || !id) || new Set(heroIds).size !== heroIds.length) throw new Error('探险英雄记录异常');
    expedition = { startTime: num(e.startTime ?? 0, '探险开始时间'), endTime: num(e.endTime ?? 0, '探险结束时间'),
      conditionId: num(e.conditionId ?? 0, '探险条件'), factor: num(e.factor ?? 0, '探险倍率'), heroIds, cost: e.cost };
    if (expedition.endTime > 0 && (!heroIds.length || expedition.startTime <= 0 || expedition.endTime <= expedition.startTime)) throw new Error('进行中的探险时间或队伍不完整');
  }
  return { stageId, progress, expedition };
}

function tripKey(stage) {
  const e = stage.expedition;
  return JSON.stringify([stage.stageId, e?.startTime ?? 0, e?.endTime ?? 0, [...(e?.heroIds ?? [])].sort()]);
}
const idle = stage => !(stage.expedition?.endTime > 0);
const finished = (stage, time) => stage.expedition?.endTime > 0 && stage.expedition.endTime <= time;

function assetRows(pkg, label, itemsOnly = false) {
  const assets = list(pkg?.asset, label);
  for (const asset of assets) {
    if (!(itemsOnly ? asset.type === 0 : [0, 1].includes(asset.type)) || typeof asset.id !== 'string' || !asset.id
      || (itemsOnly && ['RUBY', 'GOLD'].includes(asset.id))) throw new Error(label + '含有未确认的资产类型');
    num(asset.num, label + '数量', 1);
  }
  return assets;
}

function costsOf(stage) {
  const assets = assetRows(stage.expedition?.cost, '探险用料', true);
  if (!assets.length) throw new Error('服务端未提供本次探险的材料消耗');
  const costs = new Map();
  for (const asset of assets) costs.set(asset.id, num((costs.get(asset.id) ?? 0) + num(asset.num, '探险用料'), '探险总用料', 1));
  return costs;
}

function capacity(config, level) {
  const table = rows(config, 'MuseumExpeditionTeamCfg');
  if (!table.length) throw new Error('缺少博物馆探险队伍配置');
  const seen = new Set();
  let count = 0;
  for (const row of table) {
    num(row.playerLevel, '探险开放等级', 1); num(row.teamCount, '探险队伍数', 1);
    if (seen.has(row.playerLevel)) throw new Error('探险队伍配置重复');
    seen.add(row.playerLevel);
    if (row.playerLevel <= level) count = Math.max(count, row.teamCount);
  }
  return count;
}

function pickTeam(config, stage, heroes, stages, session) {
  const matches = rows(config, 'MuseumExpeditionConditionCfg').filter(r => r.conditionId === stage.expedition?.conditionId);
  if (matches.length !== 1) throw new Error('缺少服务端指定的探险英雄条件');
  const condition = matches[0];
  const count = num(condition.heroCount, '探险所需英雄数', 1);
  const star = num(condition.heroStar, '探险英雄星级');
  const quality = num(condition.heroQualityIndex, '探险英雄品质');
  if (typeof condition.careerLimit !== 'string' || typeof condition.factionLimit !== 'string') throw new Error('探险阵营或职业条件不完整');
  const occupied = new Set(stages.filter(s => !idle(s)).flatMap(s => s.expedition.heroIds));
  for (const pending of session.starts.values()) pending.heroIds.forEach(id => occupied.add(id));
  const ids = new Set();
  const candidates = [];
  for (const hero of heroes) {
    if (typeof hero?.heroId !== 'string' || !hero.heroId || ids.has(hero.heroId)) throw new Error('英雄名单含重复或缺失编号');
    ids.add(hero.heroId);
    if (occupied.has(hero.heroId)) continue;
    const configs = rows(config, 'HeroCfg').filter(row => row.id === hero.heroId);
    if (configs.length !== 1) continue;
    const cfg = configs[0];
    if (num(hero.star, '英雄星级') + num(hero.exclusive?.star ?? 0, '专武星级') < star
      || num(cfg.qualityIndex, '英雄品质') < quality || (condition.careerLimit && cfg.career !== condition.careerLimit)
      || (condition.factionLimit && cfg.faction !== condition.factionLimit)) continue;
    candidates.push({ id: hero.heroId, power: num(hero.power, '英雄战力') });
  }
  return candidates.sort((a, b) => b.power - a.power || a.id.localeCompare(b.id)).slice(0, count).map(h => h.id);
}

function reconcile(session, stages) {
  for (const [stageId, start] of session.starts) {
    const stage = stages.find(s => s.stageId === stageId);
    if (!stage) continue;
    if (stage.progress > start.progress) { session.starts.delete(stageId); continue; }
    if (!idle(stage) && stage.expedition.endTime > start.oldEnd && sameHeroes(stage.expedition.heroIds, start.heroIds)) start.observed = true;
  }
  for (const [key, trip] of session.trips) {
    const stage = stages.find(s => s.stageId === trip.stageId);
    if (stage && stage.progress > trip.progress && (idle(stage) || tripKey(stage) !== key)) {
      trip.phase = 'claimed';
      session.starts.delete(trip.stageId);
    }
  }
}

// Verified in the local client's MuseumExplorationView/MapPointPop and OverPop:
// Complete returns grade/progressGain for the result popup; OverPop._onClaim
// always sends MuseumRewardRequest. Only Reward returns reward + exploreStage
// and applies the progress / releases heroes. It is NOT a per-star reward.
export async function serviceMuseum(client, protocol, config, {
  player, enabled = () => false, report = () => {}, scheduler,
} = {}) {
  const entries = [];
  const active = Object.fromEntries(keys.map(key => [key, enabled(key) && (!scheduler || scheduler.due(key))]));
  if (!keys.some(key => active[key])) return entries;
  const emit = entry => { entries.push(entry); report(entry); };
  const skip = (key, reason) => emit({ key, label: key === 'museumCollect' ? '博物馆探险结算与领奖' : '博物馆探险派队', skipped: true, reason });
  const defer = (key, seconds) => scheduler?.defer(key, (scheduler.now?.() ?? now(client)) + seconds);
  const deferAll = seconds => keys.filter(k => active[k]).forEach(k => defer(k, seconds));
  const waitForExpedition = (key, stages) => {
    const soonest = stages.map(s => s.expedition?.endTime ?? 0).filter(t => t > now(client)).sort((a, b) => a - b)[0];
    if (soonest) scheduler?.defer(key, soonest + 5);
    else defer(key, 60);
  };
  const stamp = identity(player);
  const account = accountKey(player);
  const allowed = key => active[key] && enabled(key) && identity(player) === stamp;
  const get = async (name, body = {}, key) => {
    try {
      if (key ? !allowed(key) : !keys.some(k => allowed(k))) throw new Error('账号已暂停或连接已更换');
      if (!protocol?.[name + 'Request'] || !protocol?.[name + 'Response']) throw new Error('本地协议缺少博物馆接口');
      if (['MuseumCompleteExplore', 'MuseumReward', 'MuseumStartExplore'].includes(name)) {
        const reason = await buildingReason(key);
        if (reason) throw new Error(reason);
        if (!allowed(key)) throw new Error('账号已暂停或连接已更换');
      }
    } catch (error) { error.notSent = true; throw error; }
    return client.request(name + 'Request', body, name + 'Response');
  };
  const buildingReason = async key => {
    const allowedBuildings = rows(config, 'BuildingUnlockCfg').filter(r => r.buildingType === '博物馆').map(r => r.buildingId);
    if (!allowedBuildings.length || allowedBuildings.some(id => typeof id !== 'string' || !id)) throw new Error('缺少博物馆建筑编号配置');
    const water = await get('OnWater', {}, key);
    const buildings = list(water?.building, '博物馆建筑状态').filter(b => allowedBuildings.includes(b.buildingId));
    if (new Set(buildings.map(b => b.buildingId)).size !== buildings.length) throw new Error('博物馆建筑记录重复');
    for (const building of buildings) {
      if (num(building.level, '博物馆建筑等级') > 0 && num(building.buildStartTime ?? 0, '博物馆施工状态') === 0
        && num(building.buildFinishTime ?? 0, '博物馆竣工状态') === 0) return '';
    }
    return '博物馆尚未建成、正在施工或等待竣工';
  };
  const info = async key => {
    const reply = await get('MuseumInfo', {}, key);
    const stages = list(reply?.exploreStages, '博物馆探险关卡').map(stageOf);
    if (new Set(stages.map(s => s.stageId)).size !== stages.length) throw new Error('博物馆探险关卡重复');
    return stages;
  };
  const session = stateFor(account);
  if (session.busy) { keys.filter(k => active[k]).forEach(k => skip(k, '正在核对本账号的博物馆探险')); return entries; }
  session.busy = true;
  let workingKey = active.museumCollect ? 'museumCollect' : 'museumExplore';
  try {
    const gates = rows(config, 'BuildingUnlockCfg').filter(r => r.buildingType === '博物馆');
    const minimum = gates.length ? Math.min(...gates.map(r => num(r.playerLevel, '博物馆开放等级', 1))) : null;
    if (!uidText(player?.playerId) || !uidText(player?.worldId) || !Number.isSafeInteger(player?.level)
      || minimum === null || player.level < minimum) {
      keys.filter(k => active[k]).forEach(k => skip(k, minimum && player?.level < minimum ? `博物馆在角色 ${minimum} 级开放` : '无法确认博物馆配置或账号身份'));
      deferAll(300); return entries;
    }
    const buildingWait = await buildingReason();
    if (buildingWait) { keys.filter(k => active[k]).forEach(k => skip(k, buildingWait)); deferAll(300); return entries; }
    let stages = await info();
    for (const name of [
      ...(active.museumCollect ? ['MuseumCompleteExplore', 'MuseumReward'] : []),
      ...(active.museumExplore ? ['AllHero', 'MuseumStartExplore'] : []),
    ]) if (!protocol?.[name + 'Request'] || !protocol?.[name + 'Response']) throw new Error('本地协议缺少博物馆操作接口');
    reconcile(session, stages);
    if (!stages.length) { keys.filter(k => active[k]).forEach(k => skip(k, '博物馆尚未建成或没有已解锁探险关卡')); deferAll(300); return entries; }

    if (allowed('museumCollect')) {
      workingKey = 'museumCollect';
      for (const original of stages.filter(s => finished(s, now(client)))) {
        stages = await info('museumCollect');
        reconcile(session, stages);
        const stage = stages.find(s => s.stageId === original.stageId);
        if (!stage || !finished(stage, now(client)) || tripKey(stage) !== tripKey(original)) continue;
        const key = tripKey(stage);
        let trip = session.trips.get(key);
        if (!trip) {
          if (!allowed('museumCollect')) break;
          trip = { stageId: stage.stageId, progress: stage.progress, phase: 'completing' };
          session.trips.set(key, trip);
          let result;
          try { result = await get('MuseumCompleteExplore', { stageId: stage.stageId }, 'museumCollect'); }
          catch (error) { if ((error.prompt && error.request === 'MuseumCompleteExploreRequest') || error.notSent) session.trips.delete(key); throw error; }
          if (![1, 2, 3, 4, 5].includes(result?.grade)) throw new Error('未确认本次探险的结算评级，已暂停重复结算');
          trip.gain = num(result.progressGain, '本次探险进度收益', 1);
          const preview = [...assetRows(result.fixedReward, '探险固定收益'), ...assetRows(result.randomReward ?? { asset: [] }, '探险随机收益')];
          if (!preview.length) throw new Error('探险结算未返回收益清单，已暂停重复结算');
          trip.phase = 'prepared';
        }
        if (trip.phase !== 'prepared') {
          skip('museumCollect', trip.phase === 'claimed' ? '这趟探险已领取，等待关卡状态同步' : '上次探险结果尚未确认，暂不重复结算或领取');
          continue;
        }
        if (!allowed('museumCollect')) { skip('museumCollect', '已暂停；本次结算结果已保存，下次开启后继续领奖'); break; }
        stages = await info('museumCollect');
        const current = stages.find(s => s.stageId === stage.stageId);
        if (!current || tripKey(current) !== key || current.progress !== trip.progress || !finished(current, now(client))) {
          skip('museumCollect', '探险状态已变化，下一轮重新核对'); continue;
        }
        if (!allowed('museumCollect')) break;
        trip.phase = 'claiming';
        let reward;
        try { reward = await get('MuseumReward', { stageId: stage.stageId }, 'museumCollect'); }
        catch (error) { if ((error.prompt && error.request === 'MuseumRewardRequest') || error.notSent) trip.phase = 'prepared'; throw error; }
        const gained = assetRows(reward?.reward, '探险实际奖励');
        const updated = stageOf(reward?.exploreStage);
        if (!gained.length || updated.stageId !== stage.stageId || updated.progress < trip.progress + trip.gain || !idle(updated)) {
          throw new Error('服务端未确认探险奖励、进度及队伍释放，已暂停重复领取');
        }
        // The direct response confirms rewards; a separate snapshot must also
        // release the old expedition before this account starts another team.
        trip.ack = true;
        stages = await info('museumCollect');
        reconcile(session, stages);
        if (trip.phase !== 'claimed') throw new Error('探险奖励回包已收到，关卡状态尚未同步，暂不重复领取');
        emit({ key: 'museumCollect', label: '博物馆探险 · 已领取奖励与进度 +' + trip.gain + '，获得'
          + gained.map(a => displayMaterial(config, a.id) + ' ×' + num(a.num, '奖励数量')).join('、'), ok: true });
      }
      if (!entries.some(e => e.key === 'museumCollect')) skip('museumCollect', '当前没有到期的博物馆探险');
      if (stages.some(s => finished(s, now(client)))) defer('museumCollect', 60);
      else waitForExpedition('museumCollect', stages);
    }

    if (allowed('museumExplore')) {
      workingKey = 'museumExplore';
      stages = await info('museumExplore');
      reconcile(session, stages);
      if ([...session.trips.values()].some(t => ['completing', 'claiming'].includes(t.phase))) {
        skip('museumExplore', '上次结算或领奖结果尚未确认，等待关卡进度和英雄状态同步'); defer('museumExplore', 180); return entries;
      }
      if ([...session.starts.values()].some(s => !s.observed)) { skip('museumExplore', '上次派队结果尚未确认，暂不重复消耗材料或派出英雄'); defer('museumExplore', 180); return entries; }
      const max = capacity(config, player.level);
      if (stages.filter(s => !idle(s)).length >= max) { skip('museumExplore', '探险队伍已满或尚未解锁，请等待探险结束并领取'); waitForExpedition('museumExplore', stages); return entries; }
      if (!rows(config, 'MuseumExploreTimeFactorCfg').some(r => r.factor === 1 && Number.isSafeInteger(r.playerLevel) && r.playerLevel <= player.level)) throw new Error('缺少一倍时长探险配置');
      const candidates = stages.filter(s => idle(s) && !session.starts.has(s.stageId)).sort((a, b) => a.stageId - b.stageId);
      for (const candidate of candidates) {
        if (!allowed('museumExplore')) break;
        const cfg = rows(config, 'MuseumExpeditionStageCfg').filter(r => r.stageId === candidate.stageId);
        if (cfg.length !== 1 || !(num(cfg[0].exploreTime, '探险时长', 1) > 0)) throw new Error('缺少当前探险关卡配置');
        const reserved = await readOrderReservedStock(client, protocol, config, { player, enabled: () => allowed('museumExplore'), itemIds: [...costsOf(candidate).keys()] });
        stages = await info('museumExplore');
        const current = stages.find(s => s.stageId === candidate.stageId);
        if (!current || !idle(current) || current.progress !== candidate.progress || JSON.stringify(current.expedition) !== JSON.stringify(candidate.expedition)
          || stages.filter(s => !idle(s)).length >= max) { skip('museumExplore', '关卡、用料或队伍状态已变化，下一轮重新核对'); continue; }
        const costs = costsOf(current);
        const available = id => reserved.available.get(id) ?? 0;
        const missing = [...costs].filter(([id, count]) => available(id) < count);
        if (missing.length) { skip('museumExplore', '保留订单用料和未同步的探险扣款后还缺' + missing.map(([id, count]) => displayMaterial(config, id) + ' ×' + (count - available(id))).join('、')); continue; }
        // Refresh the hero roster last; an upgrade/removal must not validate a
        // team using an earlier hero condition snapshot.
        const freshHeroes = list((await get('AllHero', {}, 'museumExplore'))?.heroes, '英雄名单');
        const chosen = pickTeam(config, current, freshHeroes, stages, session);
        const condition = rows(config, 'MuseumExpeditionConditionCfg').find(r => r.conditionId === current.expedition?.conditionId);
        if (chosen.length !== condition.heroCount) { skip('museumExplore', '符合职业、阵营、品质和星级要求的空闲英雄不足'); continue; }
        const finalStages = await info('museumExplore');
        const finalStage = finalStages.find(s => s.stageId === current.stageId);
        if (!finalStage || JSON.stringify(finalStage) !== JSON.stringify(current) || finalStages.filter(s => !idle(s)).length >= max
          || !sameHeroes(pickTeam(config, finalStage, freshHeroes, finalStages, session), chosen)) {
          skip('museumExplore', '写入前探险队伍或英雄占用已变化，下一轮重新核对'); continue;
        }
        if (!allowed('museumExplore')) break;
        const start = { heroIds: chosen, progress: current.progress, oldEnd: current.expedition?.endTime ?? 0, observed: false };
        const debit = beginOrderMaterialSpend(player, [...costs].map(([id, need]) => ({ id, need, have: reserved.stock.get(id) ?? 0 })), '博物馆探险', {
          museum: { stageId: current.stageId, heroIds: chosen, factor: 1, progress: current.progress,
            startTime: current.expedition?.startTime ?? 0, endTime: current.expedition?.endTime ?? 0 },
        });
        session.starts.set(current.stageId, start);
        let result;
        try { result = await get('MuseumStartExplore', { stageId: current.stageId, heroIds: chosen, factor: 1 }, 'museumExplore'); }
        catch (error) {
          if ((error.prompt && error.request === 'MuseumStartExploreRequest') || error.notSent) {
            session.starts.delete(current.stageId); cancelOrderMaterialSpend(debit);
          }
          throw error;
        }
        const expedition = stageOf({ stageId: current.stageId, progress: current.progress, expedition: result?.expedition }).expedition;
        if (!expedition || expedition.endTime <= now(client) || expedition.factor !== 1 || !sameHeroes(expedition.heroIds, chosen)) throw new Error('未确认博物馆派队结果，已暂停重复派队');
        stages = await info('museumExplore');
        const observed = stages.find(s => s.stageId === current.stageId);
        if (!observed || observed.expedition?.endTime !== expedition.endTime || observed.expedition?.startTime !== expedition.startTime
          || !sameHeroes(observed.expedition?.heroIds ?? [], chosen)) throw new Error('派队回包已收到，关卡状态尚未同步，已暂停重复派队');
        reconcile(session, stages);
        // Reconcile the shared debit using the observed trip followed by a
        // complete inventory, including production received since dispatch.
        await readOrderReservedStock(client, protocol, config, { player, enabled: () => allowed('museumExplore') });
        emit({ key: 'museumExplore', label: `博物馆探险 · 已派遣 ${chosen.length} 名英雄前往「${cfg[0].name || current.stageId}」，一倍时长`, ok: true });
        break; // A single new team per call, even when more slots are open.
      }
      if (!entries.some(e => e.key === 'museumExplore')) skip('museumExplore', '当前没有可新派队的已解锁关卡');
      if (!candidates.length) waitForExpedition('museumExplore', stages);
      else defer('museumExplore', 60);
    }
  } catch (error) {
    if (!allowed(workingKey)) skip(workingKey, '账号已暂停、身份变化或连接已更换');
    else if (error.code === 'ORDER_MATERIAL_SPEND_PENDING') skip(workingKey, error.message);
    else emit({ key: workingKey, label: '博物馆探险', ok: false, error: describeLogError(error.message).message });
    deferAll(180);
  } finally { session.busy = false; }
  return entries;
}
