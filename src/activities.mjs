import { createHash } from 'node:crypto';
import { usageLimits, resourceReserve, exactAutomationId } from './automation-policy.mjs';
import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';
import { claimCollection, newbieView } from './collections.mjs';
import { toNumber } from './client.mjs';
import { campaignReportState, claimOpenRanks, openRankState, openRanks } from './pirate-board.mjs';
import { claimReportRewards } from './missing-rewards.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialSpends, confirmOrderMaterialOperation, readOrderMaterialState, settleOrderMaterialState } from './order-reservations.mjs';
import { riverActivity, edictPassActivity } from './seasonal-activities.mjs';
import { claimFestivalRewards, claimWeeklyRewards, claimVipDaily, festivalRewardKeys, weeklyRewardKeys, festivalRewardState, snowballState,
  compassState, weekChargeState, weekHeroStarState, weekFreePackState, weekOrderState, vipDailyState, syncFestivalDay } from './free-rewards.mjs';

const weekNames = { 1: '勇士战令', 2: '累计充值', 3: '英雄升星', 4: '幸运转盘', 5: '周订单', 6: '芯片活动', 7: '周翻牌' };
const serverNow = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const open = (activity, now) => activity.startTime <= now && now < activity.endTime;
const linkageNames = { 28: '龙王罗盘', 29: '酆都法旨', 30: '驱邪除祟' };
const linkageTasks = { 28: 'compassReward', 29: 'edict', 30: 'evilExpel' };
// Sub-activities that only hold rewards. Packs 6 and 10 share one tab; 10 only shows without 6.
const festivalEntries = {
  11: { name: '每日签到与活跃', taskKeys: ['festivalSign', 'festivalActive'] },
  6: { name: '每日免费礼包', taskKeys: ['festivalGifts'] },
  10: { name: '每日免费礼包', taskKeys: ['festivalGifts'], unless: 6 },
  27: { name: '走江踏浪', taskKeys: ['riverScore', 'riverPass', 'riverHelp', 'snowballFree'], taskKey: 'riverScore' },
};
const weekTasks = { 1: ['weekPass'], 2: ['weekCharge'], 3: ['weekHeroStar'], 4: ['weekGift', 'weekTimes', 'weekLotterySpin'],
  5: ['weekOrderFinal', 'weekOrderSubmit'], 6: ['weekChipFree'], 7: ['weekUniqueFree'] };
const weeklyId = row => `weekly:${row.type}:${row.period ?? 0}:${row.startTime}`;
const linkageId = (row, sub) => `linkage:${toNumber(row.activityId)}:${sub.subActivityType}`;

function playable(row, sub, now) {
  return open(row, now) && (!sub.openTime || sub.openTime <= now) && (!sub.closeTime || now < sub.closeTime);
}

const rejectedEdicts = new WeakMap();
const tribute = '活动26捞尸人_入场券';

async function solveEdict(client, config, request, allowed, report) {
  const label = '酆都法旨';
  const state = normalize(await request('EdictInfo'));
  let session = state.session;
  if (!session) {
    rejectedEdicts.delete(client);
    if (state.cost?.id !== tribute || state.cost.num !== 1) throw new Error('开局消耗不是 1 份贡品，已跳过');
    const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
    if (!bag.items?.some(item => item.itemId === tribute && item.num >= 1)) {
      report({ label, skipped: true, reason: '贡品不足，等待补充' });
      return;
    }
    if (!allowed()) return;
    session = (await request('EdictStart')).session;
    report({ label: label + ' · 已使用 1 份贡品开局', ok: true });
  }
  const guess = session?.rune;
  if (!Array.isArray(guess) || guess.length !== 4 || !guess.every(Number.isSafeInteger)) {
    throw new Error('当前对局未返回四个符文，已保留对局');
  }
  const signature = guess.join(',');
  if (!allowed() || rejectedEdicts.get(client) === signature) return;
  const reply = normalize(await request('EdictGuess', { guess }));
  if (!reply.success) {
    rejectedEdicts.set(client, signature);
    throw new Error('服务端未确认解符成功，已停止重复提交本组符文');
  }
  rejectedEdicts.delete(client);
  const reward = (reply.reward?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
  report({ label: label + ' · 解符成功，剩余耐心 ' + reply.patience + '，积分 ' + reply.score + (reward ? '，获得' + reward : ''), ok: true });
}

export async function runLinkage(client, config, enabled, report, selectedId = null) {
  for (const row of client.festivals ?? []) {
    for (const sub of row.subActivity ?? []) {
      if (selectedId && linkageId(row, sub) !== selectedId) continue;
      const expel = sub.subActivityType === 30;
      const key = linkageTasks[sub.subActivityType];
      if (!key) continue;
      const allowed = () => enabled(key) && playable(row, sub, serverNow(client));
      if (!allowed()) continue;
      const label = linkageNames[sub.subActivityType];
      const request = (name, fields = {}) => client.request(name + 'Request', { activityId: row.activityId, ...fields }, name + 'Response');
      try {
        if (key === 'edict') {
          await solveEdict(client, config, request, allowed, report);
          continue;
        }
        const state = await request(expel ? 'EvilExpelInfo' : 'CompassWheelInfo');
        let score = (expel ? state.killTotal : state.score) ?? 0;
        let claimed = (expel ? state.claimed : state.claimedId) ?? 0;
        const previousClaimed = claimed;
        for (let left = expel ? state.alive : 0; left > 0 && allowed(); left--) {
          const reply = await request('EvilExpelKill');
          if (!(reply.killTotal > score)) throw new Error('服务端未确认消灭数量增加');
          score = reply.killTotal;
          report({ label: label + ' · 已累计消灭 ' + score + ' 个', ok: true });
        }
        const table = expel ? 'LinkageLSREvilExpelTotalRewardCfg' : 'LinkageLSRCompassWheelScoreRewardCfg';
        const stages = config?.tables?.[table]?.data;
        if (!stages?.length) throw new Error('缺少累计奖励配置');
        while (allowed() && stages.some(stage => (expel ? stage.totalCount : stage.id) > claimed && score >= (expel ? stage.totalCount : stage.score))) {
          const reply = await request(expel ? 'EvilExpelClaim' : 'ClaimCompassWheelReward');
          const next = expel ? reply.claimed : reply.claimedId;
          if (!(next > claimed)) throw new Error('服务端未确认领取档位');
          claimed = next;
          report({ label: expel ? label + ' · 已领取累计消灭 ' + claimed + ' 个奖励' : label + ' · 已领取至第 ' + claimed + ' 档', ok: true });
        }
        if (previousClaimed === claimed && !(expel && state.alive)) {
          report({ label, skipped: true, reason: expel
            ? '暂无邪祟，累计消灭 ' + score + ' 个，已领取至 ' + claimed + ' 个奖励'
            : '当前 ' + score + ' 积分，已领至第 ' + claimed + ' 档，暂无可领取奖励' });
        }
      } catch (error) { report({ label, ok: false, error: error.message }); }
    }
  }
}

export async function weekSchedule(client) {
  const reply = await client.request('WeekInfoRequest', {}, 'WeekInfoResponse');
  // Scalar defaults live on protobufjs prototypes and are lost by normalize().
  return (reply.activityTime ?? []).map(row => ({ ...normalize(row), type: row.type,
    startTime: row.startTime, endTime: row.endTime, period: row.period }));
}

async function weekly(client) {
  return (await weekSchedule(client)).filter(row => open(row, serverNow(client)));
}

export async function readWeekOrder(client, week, config) {
  const active = week ?? await weekly(client);
  const needed = new Map();
  if (active.filter(row => row.type === 5).length > 1) throw new Error('周订单活动期次不唯一，请刷新后再试');
  const current = active.find(row => row.type === 5);
  if (!current) return { needed, finished: false };
  const order = normalize(await client.request('WeekOrderInfoRequest', {}, 'WeekOrderInfoResponse'));
  if (order?.isGotFinal) return { needed, finished: true };
  const prizes = config?.tables?.WeekOrderRwdCfg?.data?.filter(row => row.periodId === current.period && row.rwdId > 0);
  if (prizes?.length && prizes.every(row => order?.gotRwdId?.includes(row.rwdId))) {
    return { needed, finished: true, finalReady: true };
  }
  if (!order?.order?.length) throw new Error('未能确认当前周订单的材料清单');
  for (const item of order.order) {
    if (!item?.id || !Number.isSafeInteger(item.num) || item.num <= 0) throw new Error('周订单材料或数量不完整');
    needed.set(item.id, (needed.get(item.id) ?? 0) + item.num);
  }
  const identity = [current.period, current.startTime, current.endTime, order.gotRwdId, [...needed]];
  const orderKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const evidence={period:current.period,startTime:current.startTime,endTime:current.endTime,rewards:[...(order.gotRwdId??[])]};
  return { needed, finished: false, orderKey, evidence };
}

// An order's requirements may be refreshed without completing it. Only an
// additional reward in the same weekly event proves that a submission finished.
export async function verifyWeekOrderOperation(client,evidence) {
  if(!evidence||!Array.isArray(evidence.rewards))return false;
  const active=(await weekSchedule(client)).filter(row=>row.type===5&&open(row,serverNow(client)));
  if(active.length!==1||!active.some(row=>row.period===evidence.period&&row.startTime===evidence.startTime&&row.endTime===evidence.endTime))return false;
  const after=await client.request('WeekOrderInfoRequest',{},'WeekOrderInfoResponse'),rewards=after?.gotRwdId;
  return Array.isArray(rewards)&&rewards.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(rewards).size===rewards.length&&
    evidence.rewards.every(id=>rewards.includes(id))&&rewards.some(id=>!evidence.rewards.includes(id));
}

function lotteryProgress(config, period, info) {
  const stages = config?.tables.WeekLotteryTimesCfg?.data.filter(r => r.periodId === period);
  if (!stages?.length) throw new Error('缺少本期周抽奖次数奖励配置');
  const times = info?.times ?? 0;
  const claimed = info?.gotStage ?? 0;
  const next = stages.filter(r => r.rwdId > claimed).sort((a, b) => a.rwdId - b.rwdId)[0];
  return { times, claimed, required: next?.reqTimes, ready: Boolean(next && times >= next.reqTimes) };
}

export function activityEntries(client, week = [], festivals = client.festivals ?? []) {
  const time = serverNow(client);
  const activities = week.filter(row => open(row, time)).map(row => ({
    id: weeklyId(row), kind: 'weekly', weekType: row.type, taskKeys: weekTasks[row.type] ?? [],
    name: weekNames[row.type] ?? '周活动 ' + row.type, endTime: row.endTime,
  }));
  for (const row of festivals) {
    const before = activities.length;
    const linkage = (row.subActivity ?? []).filter(sub => linkageNames[sub.subActivityType]);
    if (linkage.length) {
      for (const sub of linkage) {
        if (playable(row, sub, time)) activities.push({
          id: linkageId(row, sub), kind: 'limited', group: '捞尸人联动',
          taskKeys: sub.subActivityType === 28 ? ['compassReward', 'compassSpin'] : sub.subActivityType === 29 ? ['edict', 'edictPass'] : [linkageTasks[sub.subActivityType]],
          name: linkageNames[sub.subActivityType], taskKey: linkageTasks[sub.subActivityType],
          endTime: Math.min(sub.closeTime || row.endTime, row.endTime),
        });
      }
    }
    const subs = row.subActivity ?? [];
    for (const sub of subs) {
      const entry = festivalEntries[sub.subActivityType];
      if (!entry || !playable(row, sub, time)) continue;
      if (!linkage.length && row.type !== '捞尸人联动活动' && sub.subActivityType !== 27) continue;
      if (entry.unless && subs.some(other => other.subActivityType === entry.unless && playable(row, other, time))) continue;
      activities.push({ id: linkageId(row, sub), kind: 'limited', group: '捞尸人联动', name: entry.name,
        taskKeys: entry.taskKeys, ...(entry.taskKey ? { taskKey: entry.taskKey } : {}),
        endTime: Math.min(sub.closeTime || row.endTime, row.endTime) });
    }
    if (open(row, time) && activities.length === before) activities.push({
      id: 'festival:' + row.activityId, kind: 'limited', taskKeys: [],
      name: linkage.length || row.type === '捞尸人联动活动' ? '酆都诡事（捞尸人联动）'
        : row.type || ({ 1: '五一活动', 2: '端午活动', 3: '人鱼活动' })[row.festival] || '节日活动 ' + row.activityId,
      endTime: row.endTime,
    });
  }
  const newbie = newbieView(client);
  if (newbie) activities.push({
    id: 'newbie:' + client.newbieActivity.startTime, kind: 'limited', name: '新手七日登录',
    taskKeys: ['newbieLogin'], taskKey: 'newbieLogin', endTime: newbie.end,
  });
  return activities;
}

// A manual run uses the same routines as the idle loop, but never changes its settings.
// Bind it to the selected occurrence so a repeated event cannot run another activity.
export async function runActivity(client, config, { activityId, taskKey, enabled = () => true, playerLevel, player = null,
  spinCount, orderKey, getSettings = () => null, ledger = null, channel = {}, report = () => {} }) {
  if (typeof activityId !== 'string' || typeof taskKey !== 'string') throw new Error('请选择活动和操作');
  if (!enabled()) throw new Error('账号连接已变化，请刷新后再试');
  const week = activityId.startsWith('weekly:') ? await weekly(client) : [];
  const activity = activityId === 'fish' ? { id: 'fish', name: '钓鱼图鉴', taskKeys: ['fishBook'] }
    : activityId === 'vip' ? { id: 'vip', name: 'VIP 每日奖励', taskKeys: ['vipDaily'] }
    : activityId === 'pirates' ? { id: 'pirates', name: '海盗首杀', taskKeys: ['campaignReports', 'openRankRewards'] }
    : activityId === 'openrank' ? { id: 'openrank', name: '开服冲榜', taskKeys: ['openRankRewards'] }
    : activityEntries(client, week).find(row => row.id === activityId);
  if (!activity) throw new Error('活动已结束或尚未开放，请刷新活动');
  if (!activity.taskKeys.includes(taskKey)) throw new Error('该活动不支持所选操作');
  if (activity.kind === 'weekly' && week.filter(row => row.type === activity.weekType).length !== 1) {
    throw new Error('当前周活动期次不唯一，请刷新后再试');
  }
  const allowed = key => key === taskKey && enabled() && (['fish', 'vip', 'pirates', 'openrank'].includes(activityId)
    || activityEntries(client, week).some(row => row.id === activityId));
  const results = [];
  const collect = entry => { results.push(entry); report(entry); };
  if (taskKey === 'weekOrderSubmit' && ledger && getSettings()) {
    const view = await readWeekOrder(client, week, config);
    const result = await runWeekOrder(client, config, getSettings(), ledger,
      () => allowed(taskKey), 'submit', { orderKey: orderKey ?? view.orderKey }, { player });
    collect({ label: '周订单提交', ok: true, note: result.message });
  } else if (['riverScore', 'riverPass', 'riverHelp'].includes(taskKey)) {
    await riverActivity(client, config, { ...channel, player, key: taskKey, label: activity.name, ledger, manual: true,
      settings: getSettings, enabled: () => allowed(taskKey), report: collect });
  } else if (taskKey === 'edictPass') {
    await edictPassActivity(client, config, { ...channel, player, key: taskKey, label: activity.name + '战令', ledger, manual: true,
      settings: getSettings, enabled: () => allowed(taskKey), report: collect });
  } else if (taskKey === 'vipDaily') await claimVipDaily(client, config, player, allowed, collect);
  else if (taskKey === 'campaignReports') await claimReportRewards(client, config, {
    enabled: () => allowed(taskKey), ledger, report: collect });
  else if (taskKey === 'openRankRewards') await claimOpenRanks(client, config, player, allowed, collect);
  else if (festivalRewardKeys.includes(taskKey)) {
    await claimFestivalRewards(client, config, allowed, collect, null, (row, type) => activityId.startsWith('linkage:' + toNumber(row.activityId) + ':')
      && (activity.taskKeys.includes(taskKey) && (taskKey === 'festivalGifts' || activityId.endsWith(':' + type))), { spinCount });
  } else if (weeklyRewardKeys.includes(taskKey)) {
    await claimWeeklyRewards(client, config, week.filter(row => weeklyId(row) === activityId), allowed, collect, { readOrder: readWeekOrder, player });
  } else if (activityId.startsWith('linkage:')) await runLinkage(client, config, allowed, collect, activityId);
  else if (activityId.startsWith('weekly:')) await claimWeekly(client, config, allowed, collect, playerLevel, null, activityId);
  else await claimCollection(client, config, taskKey, allowed, collect);
  if (!results.length) collect({ label: activity.name, skipped: true,
    reason: allowed(taskKey) ? '当前暂无可执行操作或可领取奖励' : '活动已结束或操作已停止' });
  return { activityId, taskKey, results };
}

const text = (config, rows = []) => rows.map(([id, num]) => displayMaterial(config, id) + ' ×' + num).join('、');

// One line per reward so each tab says what can be collected before anything is clicked.
async function rewardStatus(client, config, activities, week, player) {
  const status = {};
  const put = (id, lines, ready, badge = '可领') => { status[id] = { lines, ready, badge }; };
  const safely = async (id, work) => {
    try { await work(); } catch (error) { put(id, ['状态读取失败：' + error.message], false); }
  };
  syncFestivalDay(client);
  for (const row of client.festivals ?? []) {
    const state = festivalRewardState(client, row, config);
    const id = type => 'linkage:' + toNumber(row.activityId) + ':' + type;
    if (state.sign) {
      const { sign, active } = state;
      put(id(11), [
        !sign.cfg ? '无法确认今天的签到日，自动签到已跳过' : '活动第 ' + sign.day + ' 天 · ' + (sign.done ? '今日已签到' : '今日可签到：' + text(config, sign.cfg.rewards)),
        '活跃 ' + active.score + ' 分 · 已领至第 ' + active.claimed + ' 档' + (active.next ? ' · 下一档 ' + active.next.score + ' 分' + (active.ready ? '（可领取）' : '') : ' · 全部领完'),
      ], Boolean((sign.cfg && !sign.done) || active.ready));
    }
    if (state.gifts?.length) {
      const entry = activities.find(item => item.id === id(6) || item.id === id(10));
      if (entry) put(entry.id, state.gifts.map(gift => gift.cfg.name + '：' + (gift.done ? '今日已领' : '可领 ' + text(config, gift.cfg.rewards ?? gift.cfg.fixedRewards))), state.gifts.some(gift => !gift.done));
    }
    if (state.snowball) await safely(id(27), async () => {
      const view = await snowballState(client, config);
      put(id(27), [
        ...view.packs.map(pack => pack.cfg.name + '：' + (pack.done ? '已领' : '可领 ' + text(config, pack.cfg.fixedRewards))),
        '累计 ' + view.score + ' 分 · 通行证已领至第 ' + view.claimed + ' 档' + (view.next ? ' · 下一档 ' + view.next.reqScore + ' 分' + (view.ready ? '（可领取）' : '') : ' · 全部领完'),
      ], view.ready || view.packs.some(pack => !pack.done));
    });
    if (state.compass) await safely(id(28), async () => {
      const view = await compassState(client, row);
      put(id(28), [view.usable ? '抽奖券 ' + view.tickets + ' 张 · 每次消耗 ' + view.cost.num + ' 张 · 当前积分 ' + (view.info.score ?? 0) : '抽奖消耗不是抽奖券，不会自动抽奖'], view.spins > 0, '可抽');
    });
  }
  for (const row of week) {
    const id = weeklyId(row);
    if (row.type === 2) await safely(id, async () => {
      const view = await weekChargeState(client, config, row);
      put(id, ['本期已累充 ' + view.amount + ' · 已领 ' + view.got.length + '/' + view.stages.length + ' 档' + (view.ready.length ? ' · 可领 ' + view.ready.length + ' 档' : '') + '。本工具不充值，只领取已达标档位。'], view.ready.length > 0);
    });
    if (row.type === 3) await safely(id, async () => {
      const view = await weekHeroStarState(client, config, row);
      put(id, [view.period ? view.period.showHero1 + ' ' + view.stars[0] + ' 星 · ' + view.period.showHero2 + ' ' + view.stars[1] + ' 星 · 已领至第 ' + view.gotStage + ' 档'
        + (view.next ? ' · 下一档需 ' + view.next.hero1Star + ' / ' + view.next.hero2Star + ' 星' + (view.ready ? '（可领取）' : '') : ' · 全部领完') : '缺少本期配置'], view.ready);
    });
    if (row.type === 4) await safely(id, async () => {
      const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
      const coins = (bag.items ?? []).filter(item => item.itemId === '周转盘币').reduce((sum, item) => sum + item.num, 0);
      put(id, ['周转盘币 ' + coins + ' 个，开启「使用周转盘币」后才会抽奖'], coins > 0, '可抽');
    });
    if (row.type === 5) await safely(id, async () => {
      const view = await weekOrderState(client, config, row, readWeekOrder);
      put(id, [view.finalDone ? '最终奖励已领取' : view.finalReady ? '最终奖励可领取' : '完成全部档位后可领最终奖励'], view.finalReady);
    });
    if (row.type === 6 || row.type === 7) await safely(id, async () => {
      const view = await weekFreePackState(client, config, row.type);
      put(id, [(view.name ?? '免费礼包') + '：' + (view.done ? '已领' : '可领 ' + text(config, view.reward))], !view.done);
    });
  }
  const vip = vipDailyState(player, config, Math.floor((serverNow(client) + 8 * 3600) / 86400));
  await safely('pirates', async () => {
    const reports = await campaignReportState(client, config, player);
    const rank = await openRankState(client, config, player, openRanks[2]);
    put('pirates', [
      reports.pending ? '战报奖励 ' + reports.pending + ' 份待领：' + reports.rewards : '战报奖励已领完',
      rank.open ? '剿匪冲榜 ' + rank.progress + ' 分' + (rank.me?.rank ? ' · 排名第 ' + rank.me.rank + ' 名' : ' · 未上榜') + ' · 已领 ' + rank.got + '/' + rank.total + ' 档' + (rank.next ? ' · 下一档 ' + rank.next.score + ' 分' : '') + (rank.ready.length ? '（可领 ' + rank.ready.length + ' 档）' : '') : '剿匪冲榜已结束',
    ], reports.pending > 0 || (rank.open && rank.ready.length > 0));
    status.pirates.rankOpen = rank.open;
  });
  await safely('openrank', async () => {
    const ranks = [];
    for (const rank of openRanks) ranks.push(await openRankState(client, config, player, rank));
    const open = ranks.filter(rank => rank.open);
    if (!open.length) return;
    activities.push({ id: 'openrank', kind: 'limited', name: '开服冲榜', taskKeys: ['openRankRewards'], endTime: Math.max(...open.map(rank => rank.endTime)) });
    put('openrank', open.map(rank => rank.name + ' ' + rank.progress + ' 分' + (rank.me?.rank ? ' · 第 ' + rank.me.rank + ' 名' : '') + ' · 已领 ' + rank.got + '/' + rank.total + ' 档' + (rank.ready.length ? '（可领 ' + rank.ready.length + ' 档）' : '')), open.some(rank => rank.ready.length > 0));
  });
  if (vip.level > 0) put('vip', ['VIP ' + vip.level + ' · ' + (vip.available.length ? '可领 ' + vip.available.map(row => 'VIP ' + row.level + '：' + text(config, row.reward)).join('；') : '今日已领完')], vip.available.length > 0);
  return status;
}

export async function activityView(client, festivals = [], config = null, player = null) {
  const week = await weekly(client);
  const activities = activityEntries(client, week, festivals);
  const status = await rewardStatus(client, config, activities, week, player);
  return { status, ...(await activityDetails(client, config, week, activities)) };
}

async function activityDetails(client, config, week, activities) {
  const lotteryRow = week.find(r => r.type === 4);
  let lottery, lotteryError;
  if (lotteryRow) {
    try {
      const info = await client.request('WeekLotteryInfoRequest', {}, 'WeekLotteryInfoResponse');
      lottery = lotteryProgress(config, lotteryRow.period, info.gotInfo);
    } catch (error) { lotteryError = error.message; }
  }
  if (!week.some(row => row.type === 5)) return { activities, lottery, lotteryError, order: null };
  try {
    const { needed, finished, finalReady, orderKey, evidence } = await readWeekOrder(client, week, config);
    if (finished) return { activities, lottery, lotteryError, order: { materials: [], finished, finalReady } };
    const bag = normalize(await client.request('AllItemRequest', {}, 'AllItemResponse'));
    if (!Array.isArray(bag?.items)) throw new Error('未能确认仓库库存');
    const stock = new Map();
    for (const item of bag.items ?? []) stock.set(item.itemId, (stock.get(item.itemId) ?? 0) + item.num);

    const materials = Array.from(needed, ([id, required]) => {
      const owned = stock.get(id) ?? 0;
      const crop = config?.tables.FarmlandPlantCfg?.data.find(r => r.id === id);
      const seed = crop ? { name: displayMaterial(config, crop.material[0]), count: stock.get(crop.material[0]) ?? 0 } : null;
      const price = config?.tables.ItemPriceCfg?.data.find(row => row.itemId === id)?.rubyPrice;
      return { id, seed, price: Number.isSafeInteger(price) && price > 0 ? price : null,
        sources: config?.materialSources?.(id) ?? [], name: displayMaterial(config, id), required, owned,
        missing: Math.max(0, required - owned) };
    });
    return { activities, lottery, lotteryError, order: { materials, finished, orderKey, evidence, ready: materials.every(m => m.missing === 0) } };
  } catch (error) {
    return { activities, lottery, lotteryError, order: null, orderError: error.message };
  }
}

const passLocks = new WeakMap();

export async function claimWeekly(client, config, enabled, report, playerLevel, scheduler, selectedId = null) {
  const due = key => enabled(key) && (!scheduler || scheduler.due(key));
  if (!['weekPass', 'weekTimes', 'weekGift'].some(due)) return;
  const midnight = scheduler?.nextDay();
  const schedule = await weekSchedule(client);
  const time = serverNow(client);
  const week = schedule.filter(row => open(row, time) && (!selectedId || weeklyId(row) === selectedId));
  if (selectedId && !week.length) throw new Error('活动已结束或已换期，请刷新活动');
  if (selectedId && schedule.filter(row => open(row, time) && row.type === week[0].type).length !== 1) {
    throw new Error('当前周活动期次不唯一，请刷新后再试');
  }
  if (scheduler) {
    for (const [key, type] of [['weekPass', 1], ['weekGift', 4], ['weekTimes', 4]]) {
      if (!due(key) || week.some(row => row.type === type)) continue;
      const starts = schedule.filter(row => row.type === type && row.startTime > time).map(row => row.startTime);
      scheduler.defer(key, Math.min(starts.length ? Math.min(...starts) : time + 600, midnight));
    }
  }
  for (const row of week) {
    let lotteryInfo;
    const readLottery = () => client.request('WeekLotteryInfoRequest', {}, 'WeekLotteryInfoResponse');
    if (row.type === 4 && due('weekTimes')) {
      try {
        lotteryInfo = await readLottery();
        let state = lotteryProgress(config, row.period, lotteryInfo.gotInfo);
        while (state.ready && enabled('weekTimes') && open(row, serverNow(client))) {
          const reply = await client.request('WeekLotteryTimesRewardRequest', {}, 'WeekLotteryTimesRewardResponse');
          const after = lotteryProgress(config, row.period, reply.gotInfo);
          if (after.claimed <= state.claimed) throw new Error('服务端未确认周抽奖次数奖励档位');
          report({ label: '周抽奖次数奖励 · 已领至第 ' + after.claimed + ' 档（累计 ' + after.times + ' 次）', ok: true });
          state = after;
        }
        if (scheduler && enabled('weekTimes') && !state.ready) {
          scheduler.defer('weekTimes', Math.min(row.endTime, state.required == null ? midnight : scheduler.now() + 180));
        }
      } catch (error) { report({ label: '周抽奖次数奖励', ok: false, error: error.message }); }
    }
    const key = row.type === 1 ? 'weekPass' : row.type === 4 ? 'weekGift' : null;
    if (!key || !due(key)) continue;
    const allowed = () => enabled(key) && open(row, serverNow(client));
    const tables = config?.tables;
    try {
      if (key === 'weekPass') {
        const lock = passLocks.get(client);
        if (lock?.endTime === row.endTime && lock.level === playerLevel && serverNow(client) < lock.retryAt) continue;
        const state = normalize(await client.request('WeekBattlePassInfoRequest', {}, 'WeekBattlePassInfoResponse'));
        if (!tables?.WeekPassTaskCfg || !tables?.WeekBattlePassCfg) throw new Error('缺少周战令配置');
        let score = state.score ?? 0;
        for (const task of state.task ?? []) {
          const cfg = tables.WeekPassTaskCfg.data.find(t => t.taskId === task.taskId);
          if (!allowed()) break;
          if (!cfg || task.isGot || !(task.progress >= cfg.target)) continue;
          const result = await client.request('WeekBattlePassFinishTaskRequest', { taskId: task.taskId }, 'WeekBattlePassFinishTaskResponse');
          if (!Number.isSafeInteger(result.score) || result.score < score) throw new Error('战令任务积分尚未确认');
          const refreshed = await client.request('WeekBattlePassInfoRequest', {}, 'WeekBattlePassInfoResponse');
          if (!refreshed.task?.some(item => item.taskId === task.taskId && item.isGot)) throw new Error('战令任务领取状态尚未确认');
          score = result.score;
          report({ label: '周战令积分 · ' + cfg.desc, ok: true });
        }
        const ready = tables.WeekBattlePassCfg.data.some(cfg => {
          if (cfg.periodId !== row.period || !(score >= cfg.reqScore)) return false;
          const got = state.got?.find(item => item.stage === cfg.rwdId);
          return (cfg.freeReward?.length && !got?.freeGot) || (state.activePay && cfg.payReward?.length && !got?.payGot);
        });
        if (ready && allowed()) {
          const reward = await client.request('WeekBattlePassGotRewardRequest', {}, 'WeekBattlePassGotRewardResponse');
          const refreshed = await client.request('WeekBattlePassInfoRequest', {}, 'WeekBattlePassInfoResponse');
          if (!Array.isArray(reward.got) || !refreshed.got?.some(got => {
            const before = state.got?.find(item => item.stage === got.stage);
            return (got.freeGot && !before?.freeGot) || (got.payGot && !before?.payGot);
          })) throw new Error('战令档位领取状态尚未确认');
          report({ label: '周战令档位奖励', ok: true });
        }
      } else {
        const cfg = tables?.WeekLotteryPackCfg?.data.find(pack => pack.price === 0 && pack.limitedTimes > 0);
        if (!cfg) throw new Error('缺少周抽奖免费礼包配置');
        const claimed = info => info.gift?.find(item => item.giftId === cfg.packId)?.gotTimes ?? 0;
        // Recheck a claimed pack at rollover or when this event ends, whichever is first.
        const recheck = scheduler && Math.min(row.endTime, midnight);
        const before = claimed(lotteryInfo ?? await readLottery());
        if (before >= cfg.limitedTimes) {
          scheduler?.defer(key, recheck);
          continue;
        }
        if (!allowed()) continue;
        await client.sendWatch('WeekLotteryFreePackRequest', {});
        const after = claimed(await readLottery());
        if (after <= before) throw new Error('服务端尚未确认礼包领取');
        if (after >= cfg.limitedTimes) scheduler?.defer(key, recheck);
        report({ label: '周抽奖免费礼包', ok: true });
      }
    } catch (error) {
      if (key === 'weekPass' && error.message === 'server prompt: feature locked') {
        const threshold = tables?.ModuleOpenCfg?.data.find(entry => entry.moduleId === '周活动')?.playerLevel;
        const levelHint = playerLevel > 0 && playerLevel < threshold
          ? `（当前 ${playerLevel} 级，周活动 ${threshold} 级开放）` : '';
        const retryAt = Math.min(row.endTime, serverNow(client) + 1800);
        passLocks.set(client, { endTime: row.endTime, level: playerLevel, retryAt });
        scheduler?.defer('weekPass', retryAt);
        report({ label: weekNames[row.type], skipped: true, reason: '账号尚未解锁' + levelHint + '，稍后自动复查' });
      } else {
        report({ label: weekNames[row.type], ok: false, error: error.message });
      }
    }
  }
}

function weekOrderActor(player) {
  const playerId=exactAutomationId(player?.playerId),worldId=exactAutomationId(player?.worldId);
  if(!playerId||!worldId||playerId==='0'||worldId==='0')throw Error('无法确认材料消费账号');
  return {playerId,worldId};
}

export async function readWeekOrderStock(client,player,enabled=()=>true) {
  const stamp=JSON.stringify(weekOrderActor(player));
  const check=()=>{if(!enabled()||client.connected===false||JSON.stringify(weekOrderActor(player))!==stamp)throw Error('账号连接已变化');};
  check();
  const snapshot=await readOrderMaterialState(client,player,{enabled});
  const bag=await client.request('AllItemRequest',{},'AllItemResponse'),stock=new Map();
  check();
  if(!Array.isArray(bag?.items))throw Error('未能确认仓库库存');
  for(const row of bag.items){
    const count=row?.num==null?NaN:toNumber(row.num);
    if(typeof row?.itemId!=='string'||!row.itemId||stock.has(row.itemId)||!Number.isSafeInteger(count)||count<0)throw Error('仓库材料库存异常');
    stock.set(row.itemId,count);
  }
  settleOrderMaterialState(player,snapshot,stock);
  return stock;
}

async function readWeekPurchaseBalances(client,check) {
  check();
  const bag=await client.request('AllItemRequest',{},'AllItemResponse');
  check();
  const resources=await client.request('AllResourceRequest',{},'AllResourceResponse');
  check();
  if(!Array.isArray(bag?.items)||!Array.isArray(resources?.list))throw Error('购买后完整库存或资源尚未确认');
  const items=new Set(),ids=new Set();
  for(const row of bag.items){
    const count=row?.num==null?NaN:toNumber(row.num);
    if(typeof row.itemId!=='string'||!row.itemId||items.has(row.itemId)||!Number.isSafeInteger(count)||count<0)throw Error('购买后完整库存尚未确认');
    items.add(row.itemId);
  }
  for(const row of resources.list){
    const count=row?.amount==null?NaN:toNumber(row.amount);
    if(!Number.isSafeInteger(row.res)||ids.has(row.res)||!Number.isSafeInteger(count)||count<0)throw Error('购买后完整资源尚未确认');
    ids.add(row.res);
  }
  if(!ids.has(4))throw Error('购买后钻石余额尚未确认');
}

export async function runWeekOrder(client,config,settings,ledger,enabled,action,payload,{player=null}={}){
  const actor=weekOrderActor(player),stamp=JSON.stringify(actor);
  const check=()=>{if(!enabled()||client.connected===false||JSON.stringify(weekOrderActor(player))!==stamp)throw Error('账号连接已变化');};
  check();
  const requestedKey='week-order:'+createHash('sha256').update(JSON.stringify([action,payload?.orderKey,action==='buy'?payload?.itemId:null])).digest('hex');
  for(const [savedKey,record] of Object.entries(ledger.keyRecords())){
    const details=record.details;
    if(record.confirmed||!['weekOrderBuy','weekOrderSubmit'].includes(details?.kind)||details.playerId!==actor.playerId||details.worldId!==actor.worldId)continue;
    if(details.kind==='weekOrderBuy'){
      if(!details.acknowledged){if(action==='buy')throw Error('上次周订单购买结果待确认，暂不重复购买');continue;}
      await readWeekPurchaseBalances(client,check);
    }else{
      if(!details.acknowledged&&!await verifyWeekOrderOperation(client,details.evidence)){
        if(action==='submit')throw Error('该操作已提交，结果待确认，请核对订单记录');
        continue;
      }
      check();
      await readWeekOrderStock(client,player,()=>{check();return true;});
    }
    check();
    ledger.resolveKey(savedKey,true);
    if(savedKey===requestedKey)return {message:details.kind==='weekOrderBuy'?'已核对上次周订单材料购买及最新库存':'已核对上次周订单提交及最新库存'};
  }
  const state=await activityDetails(client,config,await weekly(client),[]),view=state.order;
  if(state.orderError)throw Error(state.orderError);
  if(!view?.orderKey || view.orderKey!==payload?.orderKey)throw Error('订单已变化，请刷新');
  const buy=action==='buy',item=view.materials.find(row=>row.id===payload.itemId);
  let cost=0, rubyBefore;
  if(buy){
    if(!item?.price || !Number.isSafeInteger(item.missing) || item.missing<=0)throw Error('材料已齐或暂无钻石售价');
    cost=item.price*item.missing;
    if(!Number.isSafeInteger(cost)||cost!==payload.cost||item.missing!==payload.quantity)throw Error('缺口或报价已变化，请刷新');
    if(!settings.resources.allowDiamonds)throw Error('钻石消耗开关已关闭');
    const resources=normalize(await client.request('AllResourceRequest',{},'AllResourceResponse'));
    rubyBefore=resources.list?.find(r=>r.res===4)?.amount;
    if(!Number.isSafeInteger(rubyBefore)||rubyBefore-cost<resourceReserve(settings,'RUBY'))throw Error('钻石不足或低于保留量');
  }else if(action!=='submit'||!view.ready)throw Error('材料未齐，请先补齐');
  check();
  const key='week-order:'+createHash('sha256').update(JSON.stringify([action,view.orderKey,buy?item.id:null])).digest('hex');
  if(ledger.hasKey(key))throw Error('该操作已提交，请核对订单记录');
  let costs;
  if(!buy){
    const stock=await readWeekOrderStock(client,player,()=>{check();return true;});
    confirmOrderMaterialSpends(player,stock,view.materials.map(row=>row.id));
    costs=view.materials.map(row=>({id:row.id,have:stock.get(row.id)??0,need:row.required}));
    if(costs.some(row=>row.have<row.need))throw Error('材料未齐，请刷新库存');
    check();
  }
  const ticket=ledger.reserve(buy?{diamonds:cost}:{},usageLimits(settings),{},{uniqueKey:key,
    details:buy?{kind:'weekOrderBuy',...actor,itemId:item.id,quantity:item.missing,cost,acknowledged:false}:
      {kind:'weekOrderSubmit',...actor,evidence:view.evidence,acknowledged:false}});
  let materialSpend;
  try{
    if(!buy)materialSpend=beginOrderMaterialSpend(player,costs,'周订单提交',{operation:{verify:(next)=>verifyWeekOrderOperation(next,view.evidence)}});
  }catch(error){ledger.cancel(ticket);throw error;}
  const name=buy?'CommonBuyGoods':'FinishWeekOrder';
  let responseReceived=false;
  try{
    const result=await client.request(name+'Request',buy?{goods:[{itemId:item.id,num:item.missing}]}:{},name+'Response');
    responseReceived=true;
    if(buy){
      if(!Array.isArray(result?.reward?.asset)||!result.reward.asset.some(row=>row.id===item.id&&toNumber(row.num)===item.missing))throw Error('购买奖励回执尚未确认，保留预算和防重记录');
      ledger.updateKeyDetails(key,{...ledger.keyRecords()[key].details,acknowledged:true});
      await readWeekPurchaseBalances(client,check);
    }else{
      if(!Number.isSafeInteger(result?.randomRwdId)||result.randomRwdId<=0||view.evidence.rewards.includes(result.randomRwdId))throw Error('提交奖励回执未确认');
      ledger.updateKeyDetails(key,{...ledger.keyRecords()[key].details,acknowledged:true,rewardId:result.randomRwdId});
      confirmOrderMaterialOperation(materialSpend);
      const after=await client.request('WeekOrderInfoRequest',{},'WeekOrderInfoResponse');
      if(!after.gotRwdId?.includes(result.randomRwdId))throw Error('提交结果未确认');
      check();
      await readWeekOrderStock(client,player,()=>{check();return true;});
    }
    ledger.confirm(ticket);
    return {message:buy?'已购买 '+item.name+' ×'+item.missing+'，花费 '+cost+' 钻石':'整单已提交'};
  }catch(error){
    if((!responseReceived&&error.notSent===true)||error.prompt&&error.request===name+'Request'){
      ledger.cancel(ticket);
      cancelOrderMaterialSpend(materialSpend);
    }
    throw error;
  }
}
