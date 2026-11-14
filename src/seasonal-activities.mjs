import { claimOnce } from './extra-free-rewards.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { adAccess, takeAdSlot, prepareAd, coolAd, isAdNotFinished, AD_PACED_REASON, AD_NOT_FINISHED_REASON, AD_PAUSED_REASON } from './ad-shop.mjs';
import {
  checkedAction,
  clock,
  dayOf,
  digest,
  hasReward,
  itemBalance,
  liveSeries,
  moduleOpen,
  natural,
  positive,
  read,
  table,
  waiting,
  windowOpen
} from './activity-actions.mjs';

function rankWindow(client, config, player) {
  if (!moduleOpen(config, player, '每日跨服比拼')) return false;
  const world = exactAutomationId(player.worldId);
  const season = world ? Number((BigInt(world) / 1000000n) % 1000n) : 0;
  const minimumDay = table(config, 'CrossRankParamCfg').find(
    (c) => c.paramName === '每日跨服比拼开启'
  )?.paramValue;
  return (
    season > 1 ||
    (positive(player.worldOpenTime) &&
      positive(minimumDay) &&
      dayOf(clock(client)) - dayOf(player.worldOpenTime) + 1 >= minimumDay)
  );
}

export async function militaryRewards(client, config, ctx) {
  if (!rankWindow(client, config, ctx.player)) return waiting(ctx, '军备竞赛尚未开放');
  const state = await read(client, 'CrossRankInfo');
  if (
    state.grouping ||
    !positive(state.subjectId) ||
    !positive(state.roomLevel) ||
    clock(client) >= state.settleTime
  )
    return waiting(ctx, '等待军备竞赛分组或下一场');
  const today = dayOf(clock(client));
  const allowed = () => ctx.enabled() && dayOf(clock(client)) === today && clock(client) < state.settleTime;
  const levels = table(config, 'CrossRankDailyRwdCfg').filter(
    (t) => t.subjectId === state.subjectId && t.level <= state.roomLevel
  );
  const room = Math.max(0, ...levels.map((t) => t.level));
  const tiers = levels.filter((t) => t.level === room).sort((a, b) => a.needScore - b.needScore);
  const mine = state.rankList?.find(
    (t) => exactAutomationId(t.playerId) === exactAutomationId(ctx.player.playerId)
  );
  const eligible = tiers.filter((t) => natural(mine?.score) && mine.score >= t.needScore).length;
  if (natural(state.gotDailyRewardIdx) && eligible > state.gotDailyRewardIdx) {
    await claimOnce(client, {
      ledger: ctx.ledger,
      enabled: allowed,
      report: ctx.report,
      key: 'arms-score:' + state.settleTime + ':' + state.gotDailyRewardIdx,
      title: '军备竞赛 · 达成积分奖励',
      request: 'GetDailyRewardRequest',
      verify: async (reply) =>
        hasReward(reply) && (await read(client, 'CrossRankInfo')).gotDailyRewardIdx > state.gotDailyRewardIdx
    });
  }
  // 原客户端军备礼包页显示所有 weekDay>0 的零元日礼包，付费条目的星期规则另算。
  const packs = table(config, 'LimitedPackCfg').filter(
    (r) => r.type === '日礼包' && r.price === 0 && r.weekDay > 0 && positive(r.limitedTimes)
  );
  for (const pack of packs) {
    if (!allowed()) return;
    const getCount = async () => {
      const shop = await read(client, 'LimitedShop', { type: 1 });
      if (!Array.isArray(shop.shopItem)) throw Error('军备补给领取状态未同步');
      return shop.shopItem.find((r) => r.id === pack.id)?.gotTimes ?? 0;
    };
    const count = await getCount();
    if (!natural(count) || count >= pack.limitedTimes) continue;
    await claimOnce(client, {
      ledger: ctx.ledger,
      enabled: allowed,
      report: ctx.report,
      key: 'arms-supply:' + today + ':' + pack.id + ':' + count,
      title: '军备竞赛 · 免费补给礼包',
      request: 'LimitedShopGotFreeRequest',
      body: { type: 1, id: pack.id },
      verify: async (reply) => hasReward(reply) && (await getCount()) > count
    });
  }
}

export async function claimPass(client, ctx, { type, tiers, scope, allowed }) {
  const view = () => read(client, 'BattlePass', { type });
  const state = await view();
  if (
    !Array.isArray(state.got) ||
    !natural(state.score) ||
    !tiers.length ||
    !positive(state.endTime) ||
    state.endTime <= clock(client)
  )
    return waiting(ctx, '战令未开放或已结束');
  const entitled = tiers
    .filter((t) => t.reqScore <= state.score)
    .map((t) => {
      const found = state.got.find((g) => g.id === t.rwdId);
      return {
        id: t.rwdId,
        free: !!t.freeReward?.length && !found?.freeGot,
        paid: state.activePay === true && !!t.payReward?.length && !found?.payGot
      };
    })
    .filter((t) => t.free || t.paid);
  if (!entitled.length) return waiting(ctx, '当前战令达成档位均已领取');
  await claimOnce(client, {
    key: 'event-pass:' + scope + ':' + type + ':' + digest(entitled),
    ledger: ctx.ledger,
    report: ctx.report,
    title: ctx.label,
    enabled: () => ctx.enabled() && allowed() && clock(client) < state.endTime,
    request: 'BattlePassGotRewardRequest',
    response: 'BattlePassGotRewardResponse',
    body: { type },
    verify: async (reply) => {
      if (!hasReward(reply)) return false;
      const after = await view();
      return (
        after.endTime === state.endTime &&
        entitled.every((t) => {
          const g = after.got.find((r) => r.id === t.id);
          return g && (!t.free || g.freeGot) && (!t.paid || g.payGot);
        })
      );
    }
  });
}

async function snowGift(client, config, ctx, event, allowed) {
  const today = dayOf(clock(client));
  const getCount = async (id) => {
    const detail = await read(client, 'SnowballDetail');
    if (!Array.isArray(detail.giftBuy)) throw Error('走江助力领取记录未同步');
    return detail.giftBuy.find((r) => r.packId === id)?.bought ?? 0;
  };
  for (const pack of table(config, 'SnowBallGiftCfg').filter(
    (r) => !r.chargeId && (r.price === 0 || r.price === -1 && !ctx.freeOnly)
  )) {
    const count = await getCount(pack.packId);
    if (!natural(count) || count >= pack.limitCount || !allowed()) continue;
    const stillAllowed = () => allowed() && dayOf(clock(client)) === today;
    if (pack.price === 0) {
      await claimOnce(client, {
        key: 'river-gift:' + event.id + ':' + today + ':' + pack.packId,
        ledger: ctx.ledger,
        enabled: stillAllowed,
        report: ctx.report,
        title: '走江助力 · 免费礼包',
        request: 'SnowballClaimGiftRequest',
        body: { packId: pack.packId },
        verify: async (reply) => hasReward(reply) && (await getCount(pack.packId)) > count
      });
      continue;
    }
    const access = await adAccess(client, config.tables, { ...ctx, settings: ctx.settings?.() });
    if (access.reason) {
      waiting(ctx, access.reason);
      continue;
    }
    const adTarget = 'pack:4:' + pack.packId;
    let rewarded = false;
    await checkedAction(ctx, {
      scope: 'river-ad:' + event.id + ':' + today + ':' + pack.packId,
      before: count,
      expected: { request: 'GotAdvRewardRequest', count },
      label: '走江助力 · 免广告权益礼包',
      allowed: stillAllowed,
      send: async () => {
        if (!takeAdSlot(client, access, { manual: ctx.manual, target: adTarget }))
          throw Object.assign(new Error(AD_PACED_REASON), { released: true });
        const ready = await prepareAd(client, access, { type: 4, id: pack.packId }, () => ctx.enabled() && stillAllowed());
        if (!ready) throw Object.assign(new Error(AD_PAUSED_REASON), { released: true });
        try {
          const reply = await client.request('GotAdvRewardRequest', { type: 4, id: pack.packId }, 'GotRewardResponse');
          rewarded = hasReward(reply);
          return reply;
        } catch (error) {
          if (!isAdNotFinished(error)) throw error;
          coolAd(client, adTarget);
          throw Object.assign(new Error(AD_NOT_FINISHED_REASON), { released: true });
        }
      },
      inspect: async () => (rewarded ? count + 1 : getCount(pack.packId)),
      matches: (e, after) => after > e.count,
      accept: () => true
    });
  }
}

export async function edictPassActivity(client, config, ctx) {
  const event = liveSeries(client, 29);
  if (!event) return waiting(ctx, '酆都法旨当前未开放');
  const allowed = () => ctx.enabled() && liveSeries(client, 29)?.id === event.id;
  await claimPass(client, ctx, {
    type: 11,
    tiers: table(config, 'LinkageLSREdictBattlePassCfg'),
    scope: event.id,
    allowed
  });
  ctx.scheduler?.defer(ctx.key, clock(client) + 1800);
}

export async function riverActivity(client, config, ctx) {
  const event = liveSeries(client, 27);
  if (!event) return waiting(ctx, '走江踏浪当前未开放');
  const allowed = () => ctx.enabled() && liveSeries(client, 27)?.id === event.id;
  if (ctx.key === 'riverHelp') return snowGift(client, config, ctx, event, allowed);
  if (ctx.key === 'riverPass')
    return claimPass(client, ctx, {
      type: 10,
      tiers: table(config, 'SnowBallBattlePassCfg'),
      scope: event.id,
      allowed
    });
  const state = await read(client, 'SnowballDetail');
  const next = table(config, 'SnowBallScoreRewardCfg').filter(
    (t) => t.id > state.claimedTier && t.score <= state.totalScore
  );
  if (!natural(state.claimedTier) || !natural(state.totalScore) || !next.length)
    return waiting(ctx, '当前积分没有新的可领档位');
  await claimOnce(client, {
    ledger: ctx.ledger,
    enabled: allowed,
    report: ctx.report,
    key: 'river-score:' + event.id + ':' + state.claimedTier,
    title: ctx.label,
    request: 'SnowballClaimRewardRequest',
    response: 'SnowballClaimRewardResponse',
    verify: async (reply) =>
      hasReward(reply) &&
      reply.claimedTier > state.claimedTier &&
      (await read(client, 'SnowballDetail')).claimedTier >= reply.claimedTier
  });
}

// 客户端按 price<0 走 ADV_FESTIVAL_GIFT，领取状态与免费档同在 DAILY_SELECT_GIFT 子活动。
async function compassAdGift(client, config, ctx, event, allowed) {
  const packEvent = liveSeries(client, 10);
  if (packEvent?.id !== event.id || !packEvent.sub.dailySelectGift?.boughtTimes)
    return waiting(ctx, '每日礼包领取状态未同步');
  const today = dayOf(clock(client));
  if (natural(client.seriesSnapshotDay) && client.seriesSnapshotDay < today) {
    packEvent.sub.dailySelectGift.boughtTimes = {};
    client.seriesSnapshotDay = today;
  }
  const stillAllowed = () => allowed() && dayOf(clock(client)) === today && liveSeries(client, 10)?.id === event.id;
  for (const pack of table(config, 'LinkageLSRLimitPackCfg').filter((p) => p.price < 0 && !p.chargeId)) {
    const map = packEvent.sub.dailySelectGift.boughtTimes;
    const count = map[pack.packId] ?? 0;
    const key = 'compass-ad-gift:' + event.id + ':' + today + ':' + pack.packId;
    if (!natural(count) || count >= pack.limitCount || ctx.ledger?.hasKey(key)) continue;
    const access = await adAccess(client, config.tables, { ...ctx, settings: ctx.settings?.() });
    if (access.reason) return waiting(ctx, access.reason);
    const target = 'pack:3:' + pack.packId;
    if (!takeAdSlot(client, access, { manual: ctx.manual, target })) return waiting(ctx, AD_PACED_REASON);
    if (!(await prepareAd(client, access, { type: 3, id: pack.packId }, stillAllowed))) return waiting(ctx, AD_PAUSED_REASON);
    let rejected = false, notFinished = false;
    const reply = await claimOnce(client, {
      ledger: ctx.ledger,
      key,
      report: (entry) => {
        rejected = entry.status === 'rejected';
        notFinished = rejected && /adv not finished/.test(entry.error ?? '');
        ctx.report(notFinished ? { label: ctx.label, skipped: true, reason: AD_NOT_FINISHED_REASON } : entry);
      },
      title: '龙王罗盘 · 广告礼包',
      request: 'GotAdvRewardRequest',
      body: { type: 3, id: pack.packId },
      enabled: stillAllowed,
      verify: hasReward
    });
    // 该状态只在登录快照同步：其他拒绝说明今日已在游戏内领过，不再反复申请广告。
    if (reply || (rejected && !notFinished)) map[pack.packId] = count + 1;
    if (notFinished) coolAd(client, target);
  }
}

export async function compassActivity(client, config, ctx) {
  const event = liveSeries(client, 28);
  if (!event) return waiting(ctx, '龙王罗盘当前未开放');
  const allowed = () => ctx.enabled() && liveSeries(client, 28)?.id === event.id;
  if (ctx.key === 'compassReward') {
    const view = () => read(client, 'CompassWheelInfo', event.body);
    const state = await view();
    const eligible = table(config, 'LinkageLSRCompassWheelScoreRewardCfg').filter(
      (t) => t.id > state.claimedId && t.score <= state.score
    );
    if (!natural(state.score) || !natural(state.claimedId)) throw Error('罗盘积分或已领记录未同步');
    if (!eligible.length)
      return waiting(ctx, '当前 ' + state.score + ' 分，已领至第 ' + state.claimedId + ' 档');
    return claimOnce(client, {
      ledger: ctx.ledger,
      key: 'compass-score:' + event.id + ':' + state.claimedId,
      enabled: allowed,
      report: ctx.report,
      title: ctx.label,
      request: 'ClaimCompassWheelRewardRequest',
      response: 'ClaimCompassWheelRewardResponse',
      body: event.body,
      verify: async (reply) =>
        hasReward(reply) && reply.claimedId > state.claimedId && (await view()).claimedId >= reply.claimedId
    });
  }
  if (ctx.key === 'compassAdGift') return compassAdGift(client, config, ctx, event, allowed);
  if (ctx.key === 'compassDaily') {
    const packEvent = liveSeries(client, 10);
    if (packEvent?.id !== event.id || !packEvent.sub.dailySelectGift?.boughtTimes)
      return waiting(ctx, '每日礼包领取状态未同步');
    const today = dayOf(clock(client));
    if (natural(client.seriesSnapshotDay) && client.seriesSnapshotDay < today) {
      packEvent.sub.dailySelectGift.boughtTimes = {};
      client.seriesSnapshotDay = today;
    }
    for (const pack of table(config, 'LinkageLSRLimitPackCfg').filter((p) => p.price === 0 && !p.chargeId)) {
      const map = packEvent.sub.dailySelectGift.boughtTimes;
      const count = map[pack.packId] ?? 0;
      if (!natural(count) || count >= pack.limitCount) continue;
      const reply = await claimOnce(client, {
        ledger: ctx.ledger,
        key: 'compass-gift:' + event.id + ':' + today + ':' + pack.packId,
        report: ctx.report,
        title: '龙王罗盘 · 每日免费礼包',
        request: 'ClaimFreeSelectGiftRequest',
        body: { ...event.body, giftId: pack.packId },
        enabled: () => allowed() && dayOf(clock(client)) === today && liveSeries(client, 10)?.id === event.id,
        verify: hasReward
      });
      if (reply && allowed())
        packEvent.sub.dailySelectGift.boughtTimes = { ...map, [pack.packId]: count + 1 };
    }
    return;
  }
  const view = () => read(client, 'CompassWheelInfo', event.body);
  const state = await view();
  const coin = '活动26捞尸人_抽奖券';
  if (state.cost?.id !== coin || !positive(state.cost.num) || !natural(state.times))
    return waiting(ctx, '铜钱单价或抽取次数未确认');
  const stock = await itemBalance(client, coin);
  const threshold = ctx.settings()?.eventActions?.compassThreshold;
  if (!positive(threshold) || stock < threshold)
    return waiting(ctx, '铜钱 ' + stock + ' 枚，等待达到 ' + threshold + ' 枚');
  const batch = ctx.settings()?.eventActions?.compassDrawCount;
  if (![1, 5, 10, 50].includes(batch)) return waiting(ctx, '单批抽取次数未确认');
  const num = [50, 10, 5, 1].find((n) => n <= batch && n * state.cost.num <= stock);
  if (!num) return waiting(ctx, '铜钱不足一次抽取');
  const fresh = await view();
  if (fresh.times !== state.times || fresh.cost?.id !== coin || fresh.cost?.num !== state.cost.num)
    return waiting(ctx, '罗盘报价已变化，重新核对');
  const balance = await itemBalance(client, coin);
  if (balance < threshold || balance < num * state.cost.num) return waiting(ctx, '铜钱数量已变化');
  await checkedAction(ctx, {
    scope: 'compass-spin:' + event.id,
    before: { times: fresh.times },
    expected: { request: 'SpinCompassWheelRequest', times: fresh.times + num },
    label: '龙王罗盘 · 使用 ' + num * state.cost.num + ' 枚铜钱抽 ' + num + ' 次',
    allowed: () =>
      allowed() &&
      ctx.settings()?.eventActions?.compassThreshold === threshold &&
      ctx.settings()?.eventActions?.compassDrawCount === batch,
    send: () => client.request('SpinCompassWheelRequest', { ...event.body, num }, 'SpinCompassWheelResponse'),
    inspect: async () => ({ times: (await view()).times }),
    matches: (expected, after) => after.times >= expected.times,
    accept: (r) => Array.isArray(r.spin) && r.spin.length === num
  });
}

export function leadingCandidate(state, config) {
  if (
    !Array.isArray(state?.player) ||
    !state.player.length ||
    state.player.some((p) => !positive(p.no) || !natural(p.vote))
  )
    return null;
  const displayed = new Set(table(config, 'BeautyPlayerCfg').map((candidate) => candidate.no));
  const candidates = state.player.filter((candidate) => displayed.has(candidate.no));
  return candidates.sort((a, b) => b.vote - a.vote || a.no - b.no)[0] ?? null;
}

export async function beautyActivity(client, config, ctx) {
  const event = client.beautyWindow;
  const active = () =>
    moduleOpen(config, ctx.player, '海上风采大赛') &&
    client.beautyWindow?.startTime === event?.startTime &&
    client.beautyWindow?.period === event?.period &&
    windowOpen(client.beautyWindow, clock(client));
  if (!event?.period || !active()) return waiting(ctx, '当前不在风采大赛投票时段');
  const today = dayOf(clock(client)),
    allowed = () => ctx.enabled() && active() && dayOf(clock(client)) === today;
  const readVote = () => read(client, 'BeautyInfo');
  const state = await readVote();
  if (!natural(state.todayVote) || typeof state.gotVote !== 'boolean') throw Error('当日投票状态未同步');
  if (ctx.key === 'beautyGift') {
    if (state.todayVote < 3 || state.gotVote)
      return waiting(ctx, state.gotVote ? '今日礼包已领' : '每日礼包需要累计投3票');
    return claimOnce(client, {
      key: 'beauty-gift:' + event.startTime + ':' + today,
      ledger: ctx.ledger,
      enabled: allowed,
      title: ctx.label,
      report: ctx.report,
      request: 'GotBeautyVoteRequest',
      response: 'GotBeautyVoteResponse',
      verify: async (r) => hasReward(r) && (await readVote()).gotVote === true
    });
  }
  if (state.todayVote >= 3) return waiting(ctx, '今日已投 ' + state.todayVote + ' 票，目标已完成');
  const ticket = table(config, 'BeautyParamCfg').find((r) => r.period === event.period)?.itemid;
  if (!ticket) return waiting(ctx, '本期投票券配置未确认');
  const stock = await itemBalance(client, ticket);
  const fresh = await readVote(),
    leader = leadingCandidate(fresh, config);
  const count = Math.min(stock, Math.max(0, 3 - fresh.todayVote));
  if (!leader || !positive(count))
    return waiting(ctx, stock ? '今日目标已完成或候选名单未同步' : '等待投票券');
  const mine = fresh.ownVote?.find((r) => r.no === leader.no)?.vote ?? 0;
  if (!natural(fresh.todayVote) || !natural(mine)) return waiting(ctx, '投票进度未同步');
  await checkedAction(ctx, {
    scope: 'beauty-vote:' + event.startTime + ':' + today,
    before: { today: fresh.todayVote, own: fresh.ownVote },
    expected: {
      request: 'BeautyVoteRequest',
      no: leader.no,
      mine: mine + count,
      today: fresh.todayVote + count
    },
    label: '风采大赛 · 给最高票的 ' + leader.no + ' 号投 ' + count + ' 票',
    allowed,
    send: () => client.request('BeautyVoteRequest', { no: leader.no, count }, 'BeautyVoteResponse'),
    inspect: async () => {
      const r = await readVote();
      return { today: r.todayVote, own: r.ownVote };
    },
    matches: (e, r) => r.today >= e.today && (r.own?.find((v) => v.no === e.no)?.vote ?? 0) >= e.mine,
    accept: (r) => r.player?.no === leader.no && r.ownVote?.no === leader.no && r.ownVote.vote >= mine + count
  });
}
