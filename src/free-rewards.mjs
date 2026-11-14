import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';
import { verifyWeekOrderOperation, readWeekOrderStock } from './activities.mjs';
import { defaultCompassSpinCount } from './automation.mjs';

export const festivalRewardKeys = ['festivalSign', 'festivalActive', 'festivalGifts', 'snowballFree', 'compassSpin'];
export const weeklyRewardKeys = ['weekLotterySpin', 'weekCharge', 'weekHeroStar', 'weekChipFree', 'weekUniqueFree', 'weekOrderFinal', 'weekOrderSubmit'];
export const freeRewardKeys = [...festivalRewardKeys, ...weeklyRewardKeys, 'vipDaily'];

const COMB = 6, SELECT = 10, ACTIVE = 11, SNOWBALL = 27, COMPASS = 28;
const WEEK_SPINS_PER_RUN = 10;
const WEEK_LOTTERY_COIN = '周转盘币';
const RECHECK = 600;

// Only tables whose fields were checked against the live game. Other festivals share the
// protocol but use their own tables, so they stay out until one opens and can be verified.
const festivalTables = {
  捞尸人联动活动: { sign: 'LinkageLSRSignCfg', active: 'LinkageLSRActiveRewardCfg', comb: 'LinkageLSRDailyDealCfg', select: 'LinkageLSRLimitPackCfg' },
};

const clock = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const beijingDay = time => Math.floor((time + 8 * 3600) / 86400);
const assets = (config, rows = []) => rows.map(([id, num]) => displayMaterial(config, id) + ' ×' + num).join('、');
const replyAssets = (config, reward) => (normalize(reward)?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
const withReward = (label, text) => text ? label + ' · 获得 ' + text : label;
const tableRows = (config, name) => config?.tables?.[name]?.data ?? [];
const playable = (row, sub, time) => row.startTime <= time && time < row.endTime
  && (!sub.openTime || sub.openTime <= time) && (!sub.closeTime || time < sub.closeTime);
const uniqueBy = (rows, key) => [...new Map(rows.map(row => [row[key], row])).values()];
const freePacks = rows => uniqueBy(rows.filter(row => row.price === 0), 'packId');

async function itemCount(client, id) {
  const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
  if (!Array.isArray(bag?.items)) throw new Error('未能确认仓库库存');
  return bag.items.filter(item => item.itemId === id).reduce((sum, item) => sum + item.num, 0);
}

// The game only pushes festival state at login and resets daily gifts locally at rollover.
export function syncFestivalDay(client) {
  const day = beijingDay(clock(client));
  if (client.festivalDay === day) return;
  const rollover = client.festivalDay !== undefined;
  client.festivalDay = day;
  if (!rollover) return;
  for (const row of client.festivals ?? []) {
    for (const sub of row.subActivity ?? []) {
      if (sub.dailyCombGift) sub.dailyCombGift.boughtGiftId = [];
      if (sub.dailySelectGift) sub.dailySelectGift.boughtTimes = {};
    }
  }
}

export function applyActiveScore(client, body) {
  const row = client.festivals?.find(item => toNumber(item.activityId) === toNumber(body.activityId));
  const sub = row?.subActivity?.find(item => item.subActivityType === ACTIVE);
  if (sub) (sub.dailyActive ??= {}).activeScore = body.activeScore;
}

export function festivalRewardState(client, row, config, time = clock(client)) {
  const tables = festivalTables[row.type];
  if (!tables) return {};
  const sub = type => row.subActivity?.find(item => item.subActivityType === type && playable(row, item, time));
  const state = {};
  const active = sub(ACTIVE);
  if (active) {
    const detail = active.dailyActive ?? {};
    // A check-in for any earlier day costs diamonds. Sign only when both open times agree on today.
    const agreed = !active.openTime || !row.openTime || beijingDay(active.openTime) === beijingDay(row.openTime);
    const day = beijingDay(time) - beijingDay(active.openTime || row.openTime) + 1;
    const cfg = agreed ? tableRows(config, tables.sign).find(item => item.signDay === day) : null;
    state.sign = { day, cfg, done: Boolean(cfg && detail.checkInId?.includes(cfg.rewardId)) };
    const claimed = detail.claimedRewardId ?? 0, score = detail.activeScore ?? 0;
    const next = [...tableRows(config, tables.active)].sort((a, b) => a.rewardId - b.rewardId).find(item => item.rewardId > claimed);
    state.active = { detail, score, claimed, next, ready: Boolean(next && score >= next.score) };
  }
  const comb = sub(COMB), select = sub(SELECT);
  state.gifts = [
    ...(comb ? freePacks(tableRows(config, tables.comb)).map(cfg => ({ request: 'ClaimDailyCombGiftRequest', cfg, sub: comb,
      done: Boolean(comb.dailyCombGift?.boughtGiftId?.includes(cfg.packId)) })) : []),
    ...(select ? freePacks(tableRows(config, tables.select)).map(cfg => ({ request: 'ClaimFreeSelectGiftRequest', cfg, sub: select,
      done: (select.dailySelectGift?.boughtTimes?.[cfg.packId] ?? 0) >= 1 })) : []),
  ];
  state.snowball = sub(SNOWBALL) ?? null;
  state.compass = sub(COMPASS) ?? null;
  return state;
}

export async function snowballState(client, config) {
  const detail = normalize(await client.request('SnowballDetailRequest', {}, 'SnowballDetailResponse'));
  const bought = id => detail.giftBuy?.find(item => item.packId === id)?.bought ?? 0;
  const packs = freePacks(tableRows(config, 'SnowBallGiftCfg')).map(cfg => ({ cfg, done: bought(cfg.packId) >= (cfg.limitCount || 1) }));
  const score = detail.totalScore ?? 0, claimed = detail.claimedTier ?? 0;
  const next = [...tableRows(config, 'SnowBallBattlePassCfg')].sort((a, b) => a.rwdId - b.rwdId).find(item => item.rwdId > claimed);
  return { packs, score, claimed, next, ready: Boolean(next && score >= next.reqScore) };
}

export async function compassState(client, row) {
  const info = normalize(await client.request('CompassWheelInfoRequest', { activityId: row.activityId }, 'CompassWheelInfoResponse'));
  const cost = info.cost;
  // Spins must be paid for with a dedicated ticket, never a currency.
  if (!cost?.id || !cost.id.includes('抽奖券') || !(cost.num > 0)) return { info, cost, usable: false, tickets: 0, spins: 0 };
  const tickets = await itemCount(client, cost.id);
  return { info, cost, usable: true, tickets, spins: Math.floor(tickets / cost.num) };
}

function section(label, report, work) {
  return work().catch(error => report({ label, ok: false, error: error.message }));
}

export async function claimFestivalRewards(client, config, allowed, report, scheduler = null, selected = () => true, { spinCount = defaultCompassSpinCount } = {}) {
  syncFestivalDay(client);
  for (const row of client.festivals ?? []) {
    const activityId = row.activityId;
    const state = festivalRewardState(client, row, config);
    if (allowed('festivalSign') && state.sign && selected(row, ACTIVE)) {
      await section('活动签到', report, async () => {
        const { cfg, done, day } = state.sign;
        if (!cfg) report({ label: '活动签到', skipped: true, reason: '无法确认今天对应的签到日，已跳过以免触发钻石补签' });
        else if (!done) {
          const reply = normalize(await client.request('ClaimActivityDailyCheckInRewardRequest', { activityId, checkId: cfg.rewardId }, 'ClaimActivityDailyCheckInRewardResponse'));
          if (!reply.checkId?.includes(cfg.rewardId)) throw new Error('服务端未确认签到');
          state.active.detail.checkInId = reply.checkId;
          report({ label: withReward('活动签到 · 第 ' + day + ' 天', assets(config, cfg.rewards)), ok: true });
        }
      });
      scheduler?.defer('festivalSign', scheduler.nextDay());
    }
    if (allowed('festivalActive') && state.active && selected(row, ACTIVE)) {
      await section('活动活跃奖励', report, async () => {
        const { detail } = state.active;
        let current = state.active;
        while (current.ready && allowed('festivalActive')) {
          const reply = await client.request('ClaimActivityDailyActiveRewardRequest', { activityId }, 'ClaimActivityDailyActiveRewardResponse');
          if (!(reply.claimedId > current.claimed)) throw new Error('服务端未确认活跃档位');
          detail.claimedRewardId = reply.claimedId;
          report({ label: withReward('活动活跃奖励 · 已领至第 ' + reply.claimedId + ' 档', replyAssets(config, reply.reward)), ok: true });
          current = festivalRewardState(client, row, config).active;
        }
      });
      scheduler?.defer('festivalActive', scheduler.now() + RECHECK);
    }
    if (allowed('festivalGifts') && state.gifts?.length) {
      for (const gift of state.gifts) {
        if (gift.done || !allowed('festivalGifts') || !selected(row, gift.sub.subActivityType)) continue;
        await section(gift.cfg.name, report, async () => {
          await client.sendWatch(gift.request, { activityId, giftId: gift.cfg.packId });
          if (gift.request === 'ClaimDailyCombGiftRequest') ((gift.sub.dailyCombGift ??= {}).boughtGiftId ??= []).push(gift.cfg.packId);
          else ((gift.sub.dailySelectGift ??= {}).boughtTimes ??= {})[gift.cfg.packId] = 1;
          report({ label: withReward(gift.cfg.name, assets(config, gift.cfg.rewards ?? gift.cfg.fixedRewards)), ok: true });
        });
      }
      scheduler?.defer('festivalGifts', scheduler.nextDay());
    }
    if (allowed('snowballFree') && state.snowball && selected(row, SNOWBALL)) {
      await section('走江踏浪', report, async () => {
        let view = await snowballState(client, config);
        for (const pack of view.packs) {
          if (pack.done || !allowed('snowballFree')) continue;
          await client.sendWatch('SnowballClaimGiftRequest', { packId: pack.cfg.packId });
          report({ label: withReward(pack.cfg.name, assets(config, pack.cfg.fixedRewards)), ok: true });
        }
        while (view.ready && allowed('snowballFree')) {
          const reply = await client.request('SnowballClaimRewardRequest', {}, 'SnowballClaimRewardResponse');
          if (!(reply.claimedTier > view.claimed)) throw new Error('服务端未确认通行证档位');
          report({ label: withReward('走江踏浪通行证 · 已领至第 ' + reply.claimedTier + ' 档', replyAssets(config, reply.reward)), ok: true });
          view = { ...view, claimed: reply.claimedTier, next: tableRows(config, 'SnowBallBattlePassCfg').filter(item => item.rwdId > reply.claimedTier).sort((a, b) => a.rwdId - b.rwdId)[0] };
          view.ready = Boolean(view.next && view.score >= view.next.reqScore);
        }
      });
      scheduler?.defer('snowballFree', scheduler.now() + RECHECK);
    }
    if (allowed('compassSpin') && state.compass && selected(row, COMPASS)) {
      await section('风水罗盘抽奖', report, async () => {
        const view = await compassState(client, row);
        if (!view.usable) { report({ label: '风水罗盘抽奖', skipped: true, reason: '抽奖消耗不是抽奖券，已跳过' }); return; }
        let score = view.info.score ?? 0;
        for (let left = Math.min(view.spins, spinCount); left > 0 && allowed('compassSpin'); left--) {
          const reply = await client.request('SpinCompassWheelRequest', { activityId, num: 1 }, 'SpinCompassWheelResponse');
          if (!(reply.score > score)) throw new Error('服务端未确认抽奖积分');
          report({ label: '风水罗盘抽奖 · 积分 ' + score + ' → ' + reply.score, ok: true });
          score = reply.score;
        }
      });
      scheduler?.defer('compassSpin', scheduler.now() + RECHECK);
    }
  }
}

async function lotterySpin(client, allowed, report) {
  const coins = await itemCount(client, WEEK_LOTTERY_COIN);
  let times = (normalize(await client.request('WeekLotteryInfoRequest', {}, 'WeekLotteryInfoResponse')).gotInfo?.times) ?? 0;
  for (let left = Math.min(coins, WEEK_SPINS_PER_RUN); left > 0 && allowed('weekLotterySpin'); left--) {
    const reply = normalize(await client.request('WeekLotteryPrizeRequest', { times: 1 }, 'WeekLotteryPrizeResponse'));
    const after = reply.gotInfo?.times ?? 0;
    if (!(after > times)) throw new Error('服务端未确认抽奖次数');
    times = after;
    report({ label: '周抽奖 · 已累计 ' + times + ' 次', ok: true });
  }
}

export async function weekChargeState(client, config, row) {
  const info = normalize(await client.request('WeekChargeInfoRequest', {}, 'WeekChargeInfoResponse'));
  const amount = info.rechargeAmount ?? 0, got = info.stage ?? [];
  const stages = tableRows(config, 'WeekChargeRewardCfg').filter(item => item.periodId === row.period).sort((a, b) => a.rwdId - b.rwdId);
  return { amount, got, stages, ready: stages.filter(item => amount >= item.rechargeAmount && !got.includes(item.rwdId)) };
}

export async function weekHeroStarState(client, config, row) {
  const info = normalize(await client.request('WeekHeroStarInfoRequest', {}, 'WeekHeroStarInfoResponse'));
  const period = tableRows(config, 'WeekHeroStarPeriodCfg').find(item => item.periodId === row.period);
  const stages = tableRows(config, 'WeekHeroStarRwdCfg').filter(item => item.periodId === row.period).sort((a, b) => a.rwdId - b.rwdId);
  const heroes = normalize(await client.request('AllHeroRequest', {}, 'AllHeroResponse')).heroes ?? [];
  const star = id => heroes.find(hero => hero.heroId === id)?.star ?? 0;
  const gotStage = info.gotStage ?? 0;
  const next = stages.find(item => item.rwdId > gotStage);
  const ready = Boolean(period && next && star(period.showHero1) >= next.hero1Star && star(period.showHero2) >= next.hero2Star);
  return { period, gotStage, next, ready, stars: period ? [star(period.showHero1), star(period.showHero2)] : [] };
}

export async function weekFreePackState(client, config, type) {
  if (type === 6) {
    const info = normalize(await client.request('WeekChipInfoRequest', {}, 'WeekChipInfoResponse'));
    const pack = freePacks(tableRows(config, 'WeekChipPackCfg'))[0];
    return { pack, name: pack?.giftName, reward: pack?.reward, done: !pack || (info.gifts?.find(item => item.giftId === pack.packId)?.paidTimes ?? 0) > 0 };
  }
  const info = normalize(await client.request('WeekUniqueLotteryRequest', {}, 'WeekUniqueLotteryResponse'));
  const pack = freePacks(tableRows(config, 'WeekUniquePackCfg'))[0];
  return { pack, name: pack?.name, reward: pack?.reward, done: !pack || Boolean(info.gotFree) };
}

export async function weekOrderState(client, config, row, readOrder) {
  const order = normalize(await client.request('WeekOrderInfoRequest', {}, 'WeekOrderInfoResponse'));
  const prizes = tableRows(config, 'WeekOrderRwdCfg').filter(item => item.periodId === row.period && item.rwdId > 0);
  const finalReady = !order.isGotFinal && prizes.length > 0 && prizes.every(item => order.gotRwdId?.includes(item.rwdId));
  const { needed, finished, evidence } = order.isGotFinal || finalReady ? { needed: new Map(), finished: true } : await readOrder(client, [row], config);
  return { finalDone: Boolean(order.isGotFinal), finalReady, needed, finished, evidence };
}

const weeklyHandlers = {
  1: {},
  2: { weekCharge: async (client, config, row, allowed, report) => {
    const { ready } = await weekChargeState(client, config, row);
    for (const stage of ready) {
      if (!allowed('weekCharge')) return;
      await client.sendWatch('WeekChargeGotRewardRequest', { stage: stage.rwdId });
      report({ label: withReward('累计充值 · 第 ' + stage.rwdId + ' 档', assets(config, stage.reward)), ok: true });
    }
  } },
  3: { weekHeroStar: async (client, config, row, allowed, report) => {
    let view = await weekHeroStarState(client, config, row);
    while (view.ready && allowed('weekHeroStar')) {
      const reply = await client.request('WeekHeroStarGotRewardRequest', {}, 'WeekHeroStarGotRewardResponse');
      if (!(reply.gotStage > view.gotStage)) throw new Error('服务端未确认升星档位');
      report({ label: withReward('英雄升星 · 已领至第 ' + reply.gotStage + ' 档', replyAssets(config, reply.reward)), ok: true });
      view = await weekHeroStarState(client, config, row);
    }
  } },
  4: { weekLotterySpin: (client, config, row, allowed, report) => lotterySpin(client, allowed, report) },
  5: {
    weekOrderFinal: async (client, config, row, allowed, report, { readOrder }) => {
      const view = await weekOrderState(client, config, row, readOrder);
      if (!view.finalReady || !allowed('weekOrderFinal')) return;
      await client.sendWatch('WeekOrderGotFinalRequest', {});
      report({ label: '周订单最终奖励', ok: true });
    },
    weekOrderSubmit: async (client, config, row, allowed, report, { readOrder, player }) => {
      const stock=await readWeekOrderStock(client,player,()=>allowed('weekOrderSubmit'));
      const view = await weekOrderState(client, config, row, readOrder);
      if (view.finished || !view.needed.size) return;
      const costs = [];
      for (const [id, need] of view.needed) {
        const have = stock.get(id)??0;
        if (have < need) { report({ label: '周订单提交', skipped: true, reason: displayMaterial(config, id) + ' ' + have + '/' + need + '，等待备料' }); return; }
        costs.push({ id, have, need });
      }
      if (!allowed('weekOrderSubmit')) return;
      const spend = beginOrderMaterialSpend(player, costs, '周订单提交',{operation:{verify:next=>verifyWeekOrderOperation(next,view.evidence)}});
      let responseReceived=false;
      try {
        const reply = await client.request('FinishWeekOrderRequest', {}, 'FinishWeekOrderResponse');
        responseReceived=true;
        if(!Number.isSafeInteger(reply?.randomRwdId)||reply.randomRwdId<=0)throw new Error('周订单奖励回执尚未确认');
        confirmOrderMaterialOperation(spend);
        await refreshOrderMaterialSpends(client,player,{enabled:()=>allowed('weekOrderSubmit')});
        report({ label: '周订单提交 · 第 ' + reply.randomRwdId + ' 档奖励', ok: true });
      } catch (error) {
        // Definite rejection/unsent writes release the debit. A later read
        // failure cannot undo the already acknowledged material consumption.
        if ((!responseReceived&&error.notSent===true) || error.prompt && error.request === 'FinishWeekOrderRequest') cancelOrderMaterialSpend(spend);
        throw error;
      }
    },
  },
  6: { weekChipFree: async (client, config, row, allowed, report) => {
    const view = await weekFreePackState(client, config, 6);
    if (view.done || !allowed('weekChipFree')) return;
    await client.sendWatch('WeekChipGotFreeRequest', {});
    report({ label: withReward('芯片活动 · ' + view.name, assets(config, view.reward)), ok: true });
  } },
  7: { weekUniqueFree: async (client, config, row, allowed, report) => {
    const view = await weekFreePackState(client, config, 7);
    if (view.done || !allowed('weekUniqueFree')) return;
    await client.sendWatch('GotUniqueLotteryFreeRequest', {});
    report({ label: withReward('周翻牌 · ' + view.name, assets(config, view.reward)), ok: true });
  } },
};

export async function claimWeeklyRewards(client, config, week, allowed, report, { scheduler = null, readOrder, player = null } = {}) {
  const time = clock(client);
  const open = week.filter(row => row.startTime <= time && time < row.endTime);
  for (const key of weeklyRewardKeys) {
    if (!allowed(key)) continue;
    const row = open.find(item => weeklyHandlers[item.type]?.[key]);
    if (row) {
      await section(key, report, () => weeklyHandlers[row.type][key](client, config, row, allowed, report, { readOrder, player }));
      scheduler?.defer(key, scheduler.now() + RECHECK);
    } else scheduler?.defer(key, Math.min(scheduler.now() + 3600, scheduler.nextDay()));
  }
}

export function vipDailyState(player, config, day) {
  const vip = player?.vip;
  if (!vip) return { level: 0, available: [] };
  // The login snapshot's flags are only valid for the day they were read.
  if (vip.dailyDay !== undefined && vip.dailyDay !== day) for (const row of vip.dailyReward ?? []) row.isGot = false;
  vip.dailyDay = day;
  const level = vip.vipLevel ?? 0;
  const got = level2 => (vip.dailyReward ?? []).some(row => row.vipLevel === level2 && row.isGot);
  const available = tableRows(config, 'VipFreeCfg').filter(row => row.level <= level && !got(row.level));
  return { level, available };
}

export async function claimVipDaily(client, config, player, allowed, report, scheduler = null) {
  const vip = player?.vip;
  for (const cfg of vipDailyState(player, config, beijingDay(clock(client))).available) {
    if (!allowed('vipDaily')) break;
    try {
      await client.sendWatch('GotVipDailyRewardRequest', { vipLevel: cfg.level });
      report({ label: withReward('VIP ' + cfg.level + ' 每日奖励', assets(config, cfg.reward)), ok: true });
    } catch (error) {
      report({ label: 'VIP ' + cfg.level + ' 每日奖励', skipped: true, reason: error.message });
    }
    const saved = (vip.dailyReward ??= []).find(row => row.vipLevel === cfg.level);
    if (saved) saved.isGot = true;
    else vip.dailyReward.push({ vipLevel: cfg.level, isGot: true });
  }
  scheduler?.defer('vipDaily', scheduler.nextDay());
}
