// 日常任务的自动完成：每个任务一个驱动，先只读探测前置条件，再给出可执行的动作。
//
// 只有客户端确实会发的请求才会被排进计划（request/body 与客户端调用点一致），
// 服务端是否计数以 SCDailyTaskUpdate 推送和完成后的 DailyTaskInfoRequest 为准。
//
// 有些任务天生无法协议完成：需要联盟身份、限时时段（20-21 点城战）、地图上得有野怪，
// 或者功能还没开放。这些驱动只报告原因，不会硬发请求。
//
// 除了任务本身，DailyTaskInfoResponse 还带着两样「领了才算完」的东西：
// - dailyTask[].rewardClaimed：任务达标后要点一下 DrawDailyTaskRewardRequest 才拿到奖励，
//   而奖励里带活跃度，所以顺序必须是「先跑任务 → 再领任务奖励 → 最后领活跃宝箱」。
// - dailyRewardClaimed / weeklyRewardClaimed：活跃度宝箱，各 5 档，领的是
//   DrawDailyRewardRequest / DrawWeeklyRewardRequest（都是 index 数组）。
//   两张表、两套门槛：DailyActivityRewardCfg 20/40/60/80/100，
//   WeeklyActivityRewardCfg 120/240/360/480/600。

import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';
import { FREE_DAILY_PACK_ID } from './actions.mjs';
import { arenaDailyDriver } from './arena.mjs';
import { pirateSweepProbes, planPirateSweeps, runPirateSweep } from './pirates.mjs';

const pirateDailyDriver = {
  id: 1010,
  title: '累计击败野怪',
  probes: pirateSweepProbes,
  evaluate(args) {
    if (!args.player || !args.config?.tables?.ModuleOpenCfg) {
      return { status: 'waiting', reason: '每日免费扫荡按“游戏配置 → 世界 → 海盗日常扫荡”所选种类及游戏剩余次数独立执行' };
    }
    return planPirateSweeps(args);
  },
  run: runPirateSweep,
};

export const TASK_TITLES = {
  1001: '登录游戏',
  1002: '招募英雄',
  1003: '主线战斗',
  1004: '领取挂机收益',
  1005: '竞技场战斗',
  1006: '点金次数',
  1007: '折扣商店购买',
  1008: '累计贸易次数',
  1009: '累计试炼挑战',
  1010: '累计击败海盗',
  1011: '累计联盟情报',
  1012: '累计联盟订单',
  1013: '累计联盟互助',
  1014: '累计请求帮助',
  1015: '城战获得功勋',
  1016: '博物馆探险',
  1017: '参与积分赛',
};

const RECRUIT_ITEM = '抽卡券';
const RUBY = 4;
const RESOURCE_RUBY = '钻石';

export function describeDailyTask(task, config) {
  const row = (config?.tables?.DailyTaskCfg?.data ?? []).find((r) => r.taskId === task.id);
  return { ...task, title: TASK_TITLES[task.id] ?? row?.type ?? String(task.id), desc: row?.desc ?? '' };
}

// ---- 活跃度宝箱 ---------------------------------------------------------------

// 日和周是两张不同的表，门槛差很远：日 20/40/60/80/100，周 120/240/360/480/600。
// 客户端也是分开取的（allDailyActiveRewardCfg / allWeeklyActiveRewardCfg），
// 所以判「哪几档可领」必须按 kind 选表——混用会把 85 周活跃算成能领 4 档，发出去被服务端拒。
export const CHEST_TABLE = { daily: 'DailyActivityRewardCfg', weekly: 'WeeklyActivityRewardCfg' };

// 哪几档现在能领：活跃度够了、而且服务端没记在已领列表里。
// 四个季节的门槛与档位号完全一样（只有第 5 档的奖励不同），所以领哪几档不用挑季节；
// 只有要显示「第 5 档给什么」时才需要知道季节，那一步交给界面，不在这里猜。
export function chestTiers(config, { kind = 'daily', activity = 0, claimed = [], season = null } = {}) {
  const rows = config?.tables?.[CHEST_TABLE[kind] ?? CHEST_TABLE.daily]?.data ?? [];
  const use = season == null ? rows : rows.filter((row) => row.season === season);
  const taken = new Set(claimed ?? []);
  const byId = new Map();
  for (const row of use) {
    if (taken.has(row.id) || Number(activity) < Number(row.activity)) continue;
    if (!byId.has(row.id)) byId.set(row.id, { id: row.id, activity: row.activity, reward: row.reward });
  }
  return [...byId.values()].sort((a, b) => a.activity - b.activity);
}

// 从一次 DailyTaskInfoResponse 算出要发的两个请求。两个都没有可领档位时返回空动作表。
export function planChests(daily, config) {
  const day = { activity: daily?.dailyActivity ?? 0, claimed: daily?.dailyRewardClaimed ?? [] };
  const week = { activity: daily?.weeklyActivity ?? 0, claimed: daily?.weeklyRewardClaimed ?? [] };
  const dailyTiers = chestTiers(config, { ...day, kind: 'daily' });
  const weeklyTiers = chestTiers(config, { ...week, kind: 'weekly' });
  const actions = [];
  if (dailyTiers.length > 0) {
    actions.push({
      request: 'DrawDailyRewardRequest',
      body: { index: dailyTiers.map((tier) => tier.id) },
      response: null,
      cost: '无',
      note: `领日常活跃宝箱 第 ${dailyTiers.map((tier) => tier.id).join('/')} 档（活跃度 ${day.activity}）`,
    });
  }
  if (weeklyTiers.length > 0) {
    actions.push({
      request: 'DrawWeeklyRewardRequest',
      body: { index: weeklyTiers.map((tier) => tier.id) },
      response: null,
      cost: '无',
      note: `领周活跃宝箱 第 ${weeklyTiers.map((tier) => tier.id).join('/')} 档（活跃度 ${week.activity}）`,
    });
  }
  return {
    daily: { ...day, tiers: dailyTiers, nextAt: nextThreshold(config, 'daily', day) },
    weekly: { ...week, tiers: weeklyTiers, nextAt: nextThreshold(config, 'weekly', week) },
    actions,
  };
}

// 下一档的门槛，界面上用来解释「为什么现在没得领」。
function nextThreshold(config, kind, { activity = 0, claimed = [] }) {
  const rows = config?.tables?.[CHEST_TABLE[kind] ?? CHEST_TABLE.daily]?.data ?? [];
  return rows
    .filter((row) => !claimed.includes(row.id) && Number(row.activity) > Number(activity))
    .reduce((min, row) => (min == null || row.activity < min ? row.activity : min), null);
}

// ---- 每日精选的免费礼包 -------------------------------------------------------

// 「每日精选」面板每天有一档免费赠礼，领走的是 GotFreeDailyPackRequest{packId:"赠礼"}。
// packId 是客户端硬编码的字符串，服务端状态在 DailyGiftPackResponse.drawnPack 里；
// resetTime 是次日 0 点，所以这是真正的「日奖励」，和活跃度宝箱是两回事。
//
// 面板里另外三个（礼包1/2/3）要走充值，"合并礼包" 要先买过前三个才可领，都不在本工具范围内。
export function planDailyGift(response) {
  const drawn = response?.drawnPack ?? [];
  const available = !drawn.includes(FREE_DAILY_PACK_ID);
  return {
    drawn,
    freeAvailable: available,
    resetTime: response?.resetTime ?? null,
    actions: available
      ? [{
        request: 'GotFreeDailyPackRequest',
        body: { packId: FREE_DAILY_PACK_ID },
        response: null,
        cost: '无',
        note: '领每日精选的免费赠礼',
      }]
      : [],
  };
}

// 每个驱动声明它要的只读前置请求，框架统一批量取一遍。
function recruitmentWait(water) {
  if (!water) return '暂未读取到海面建筑状态，稍后再检查广播站';
  const station = water.building?.find(row => row.buildingId === '1广播站');
  if (station?.level > 0) return null;
  if (station?.buildStartTime > 0 || station?.buildFinishTime > 0) return '广播站正在建造，等待竣工';
  return '广播站尚未建造，建成后再招募';
}

export const DAILY_DRIVERS = {
  1002: {
    id: 1002,
    title: '招募英雄',
    probes: [['OnWaterRequest', {}], ['RecruitInfoRequest', {}, probe => !recruitmentWait(probe('OnWaterRequest'))]],
    evaluate({ task, probe, items, now, config }) {
      const remaining = Math.max(0, task.targetProgress - task.progress);
      if (remaining === 0) return { status: 'done' };
      const reason = recruitmentWait(probe('OnWaterRequest'));
      if (reason) return { status: 'waiting', reason };
      const info = probe('RecruitInfoRequest')?.hero;
      const actions = [];
      // RecruitWay: 1=免费 2=单抽 3=十连 4=五十连 5=高级；单抽花 1 张抽卡券。
      if (info && info.freeEndTimeSeconds <= now) {
        actions.push({ request: 'RecruitStartRequest', body: { way: 1 }, response: 'RecruitStartResponse', cost: '免费次数', note: '英雄免费招募' });
      }
      const ticketName = displayMaterial(config, RECRUIT_ITEM);
      const tickets = items.get(RECRUIT_ITEM) ?? 0;
      const singles = Math.min(remaining - actions.length, tickets);
      for (let i = 0; i < singles; i += 1) {
        actions.push({ request: 'RecruitStartRequest', body: { way: 2 }, response: 'RecruitStartResponse', cost: `${ticketName} x1`, note: '单抽' });
      }
      if (actions.length === 0) {
        return { status: 'blocked', reason: `免费次数未好，且没有${ticketName}（需要 ${remaining} 次）` };
      }
      if (actions.length < remaining) {
        return { status: 'partial', reason: `只有 ${actions.length}/${remaining} 次可做`, actions };
      }
      return { status: 'ready', actions };
    },
  },

  1003: {
    id: 1003,
    title: '主线战斗',
    probes: [],
    evaluate({ task }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      return { status: 'waiting', reason: '请在「挂机 → 世界 → 推关与试炼」配置主线 / 闯关自动挑战，也可在挑战页手动开始' };
    },
  },

  1004: {
    id: 1004,
    title: '领取挂机收益',
    probes: [['AfkInfoRequest', {}]],
    evaluate({ task, probe, now }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const afk = probe('AfkInfoRequest')?.afkInfo;
      if (!afk) return { status: 'blocked', reason: '没有挂机信息' };
      if (!(afk.afkFinishTime > 0 && afk.afkFinishTime <= now)) {
        return { status: 'waiting', reason: `本段挂机还有 ${Math.ceil(afk.afkFinishTime - now)} 秒` };
      }
      return { status: 'ready', actions: [{ request: 'DrawAfkRewardRequest', body: {}, response: 'DrawAfkRewardResponse', cost: '无', note: '领取挂机本段收益' }] };
    },
  },

  1005: arenaDailyDriver,

  1006: {
    id: 1006,
    title: '点金次数',
    probes: [['ClickGoldInfoRequest', {}]],
    evaluate({ task, probe, config, ruby, settings }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const info = probe('ClickGoldInfoRequest')?.info;
      if (!info) return { status: 'blocked', reason: '拿不到点金信息' };
      const param = (name) => (config?.tables?.OfflineParamCfg?.data ?? []).find((row) => row.paramName === name)?.paramValue ?? 0;
      let remaining = task.targetProgress - task.progress;
      // 免费次数上限来自 OfflineParamCfg.免费点金次数，付费单价来自 点金价格（单位钻石）。
      const freeLeft = Math.max(0, param('免费点金次数') - (info.freeTimes ?? 0));
      if (freeLeft > 0) {
        // 免费点金客户端永远是 times:1 一次一发，服务端不接受免费模式下的多连。
        const count = Math.min(freeLeft, remaining);
        const actions = [];
        for (let i = 0; i < count; i += 1) {
          actions.push({ request: 'ClickGoldRequest', body: { times: 1, free: true }, response: 'ClickGoldResponse', cost: '免费次数', note: '免费点金 x1' });
        }
        return { status: 'ready', actions };
      }
      const price = param('点金价格');
      if (settings) {
        if (!settings.gold.enabled) return { status: 'blocked', reason: '付费点金已在设置中关闭' };
        remaining = Math.min(remaining, Math.max(0, settings.gold.times - (info.paidTimes ?? 0)));
        if (!remaining) return { status: 'done', reason: '已达到设置的付费点金次数' };
      }
      const paidLeft = Math.max(0, (info.maxPaidTimes ?? 0) - (info.paidTimes ?? 0));
      if (paidLeft < remaining) return { status: 'blocked', reason: `免费次数用完，付费上限只剩 ${paidLeft} 次` };
      if (price * remaining > ruby) return { status: 'blocked', reason: `付费点金要 ${price * remaining} 钻石，当前 ${ruby}` };
      // 付费点金扣的是钻石（RUBY），必须显式开 allowPaid。
      return {
        status: 'paid',
        reason: `免费次数已用完，付费 ${price} 钻石一次`,
        actions: [{ request: 'ClickGoldRequest', body: { times: remaining, free: false }, response: 'ClickGoldResponse', costs: [{ id: 'RUBY', num: price * remaining }], counters: { goldPaidTimes: remaining }, counterMinimums: { goldPaidTimes: info.paidTimes ?? 0 }, cost: `${RESOURCE_RUBY} x${price * remaining}`, note: '付费点金' }],
      };
    },
  },

  1007: {
    id: 1007,
    title: '折扣商店购买',
    probes: [['DiscountShopRequest', {}]],
    evaluate({ task, probe, ruby }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const shop = probe('DiscountShopRequest');
      const items = (shop?.shopItem ?? []).filter((item) => !item.isBuy);
      if (!items.length) return { status: 'blocked', reason: '折扣商店没有可买商品' };
      // 客户端价格 = floor(price * discount)，付的是钻石。
      const cheapest = items
        .map((item) => ({ ...item, realPrice: Math.floor(item.price * item.discount) }))
        .sort((a, b) => a.realPrice - b.realPrice)[0];
      if (cheapest.realPrice > ruby) return { status: 'blocked', reason: `最便宜的一件要 ${cheapest.realPrice} 钻石，当前 ${ruby}` };
      return {
        status: 'ready',
        actions: [{ request: 'DiscountShopBuyRequest', body: { id: cheapest.id }, response: null, costs: [{ id: 'RUBY', num: cheapest.realPrice }], cost: `${RESOURCE_RUBY} x${cheapest.realPrice}`, note: '购买折扣商品' }],
      };
    },
  },

  1008: {
    id: 1008,
    title: '累计贸易次数',
    probes: [['CargoShipsRequest', {}]],
    evaluate({ task, probe }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const ships = probe('CargoShipsRequest')?.ship ?? [];
      return { status: 'blocked', reason: ships.length ? '货轮由挂机页「贸易港交货与收货」处理' : '当前没有可用货轮' };
    },
  },

  1009: {
    id: 1009,
    title: '累计试炼挑战',
    probes: [],
    evaluate({ task }) {
      return task.progress >= task.targetProgress ? { status: 'done' }
        : { status: 'waiting', reason: '在「推关与试炼」选择自动推关副本，也可在「挑战 → 试炼副本」手动挑战下一关' };
    },
  },

  1010: pirateDailyDriver,

  1011: { id: 1011, title: '累计联盟情报', probes: [], evaluate: automationReason('联盟情报领奖与派舰') },
  1012: { id: 1012, title: '累计联盟订单', probes: [], evaluate: automationReason('提交联盟订单') },
  1013: { id: 1013, title: '累计联盟互助', probes: [['GuildAidListRequest', { type: 0 }]], evaluate: lockedReason('联盟互助') },
  1014: { id: 1014, title: '累计请求帮助', probes: [], evaluate: lockedReason('联盟求助') },
  1015: { id: 1015, title: '城战获得功勋', probes: [], evaluate: automationReason('城战接续（20:00-21:00 限时）', '世界与挑战') },
  1016: { id: 1016, title: '博物馆探险', probes: [], evaluate: automationReason('派遣博物馆探险队', '博物馆') },
  1017: { id: 1017, title: '参与积分赛', probes: [['LeagueInfoRequest', {}]], evaluate: lockedReason('跨服积分赛') },
};

function automationReason(label, group = '联盟') {
  return ({ task }) => task.progress >= task.targetProgress ? { status: 'done' }
    : { status: 'waiting', reason: `可在「挂机 → ${group} → ${label}」开启，执行条件与结果见运行日志` };
}

// 这类任务的入口请求被服务端直接拒绝（未入盟 / 未开放 / 限时），探测结果只用来确认原因。
function lockedReason(feature) {
  return ({ task }) => {
    if (task.progress >= task.targetProgress) return { status: 'done' };
    return { status: 'blocked', reason: `控制台尚未接入${feature}的执行流程，可在游戏内完成` };
  };
}

function lowPower(power) {
  if (power == null) return 0;
  if (typeof power === 'number') return power;
  return power.low ?? 0;
}

// 只读调研：跑一遍前置请求，给出每个日常任务能不能做、要发什么。
export async function surveyDailies(client, protocol, { config = null, player = null, timeout = 8000, includeTask = () => true, probeGift = true, idle = false, settings = null } = {}) {
  const daily = await client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse', timeout);
  const tasks = (daily.dailyTask ?? []).filter(task => includeTask(task.id)).map((task) => describeDailyTask(task, config));
  const unfinished = id => tasks.some(task => task.id === id && task.progress < task.targetProgress);
  const itemList = !idle || unfinished(1002) ? await client.request('AllItemRequest', {}, 'AllItemResponse', timeout) : null;
  const items = new Map();
  for (const item of itemList?.items ?? []) {
    const id = item.itemId ?? item.id;
    items.set(id, (items.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
  }
  const resourceList = !idle || unfinished(1006) || unfinished(1007) ? await client.request('AllResourceRequest', {}, 'AllResourceResponse', timeout) : null;
  const ruby = Number((resourceList?.list ?? []).find((entry) => entry.res === RUBY)?.amount ?? 0);

  const cache = new Map();
  const fetchProbe = async (name, body) => {
    const key = `${name}|${JSON.stringify(body)}`;
    if (cache.has(key)) return cache.get(key);
    const responseName = `${name.slice(0, -7)}Response`;
    let value = null;
    try {
      value = await client.request(name, body ?? {}, responseName, timeout);
    } catch {
      value = null;
    }
    cache.set(key, value);
    return value;
  };

  const probeCache = new Map();
  const independentPirateSweep = Boolean(settings);
  const probe = (name) => {
    for (const [key, value] of probeCache) if (key.startsWith(`${name}|`)) return value;
    return null;
  };
  for (const driver of Object.values(DAILY_DRIVERS)) {
    if (driver.id === 1010 && independentPirateSweep) continue;
    if (!tasks.some(task => task.id === driver.id && task.progress < task.targetProgress)) continue;
    for (const [name, body, shouldProbe] of driver.probes ?? []) {
      if (shouldProbe && !shouldProbe(probe, { config, player })) continue;
      const key = `${name}|${JSON.stringify(body)}`;
      if (probeCache.has(key)) continue;
      probeCache.set(key, await fetchProbe(name, body));
    }
  }
  const now = (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
  const evaluations = [];
  for (const task of tasks) {
    if (task.progress >= task.targetProgress) {
      evaluations.push({ task, status: 'done', actions: [] });
      continue;
    }
    if (task.id === 1010 && independentPirateSweep) {
      evaluations.push({ task, status: 'waiting', reason: '每日免费扫荡由独立服务按“游戏配置 → 世界 → 海盗日常扫荡”执行', actions: [] });
      continue;
    }
    const driver = DAILY_DRIVERS[task.id];
    if (!driver) {
      evaluations.push({ task, status: 'unknown', reason: '没有对应的驱动' });
      continue;
    }
    let verdict;
    try {
      verdict = normalize(driver.evaluate({ task, probe, items, ruby, now, config, player, settings, client, dailyResetTime: daily.dailyResetTime }));
    } catch (error) {
      verdict = { status: 'error', reason: error.message };
    }
    evaluations.push({ task, ...verdict });
  }
  let gift = null;
  if (probeGift && protocol.DailyGiftPackRequest && protocol.DailyGiftPackResponse) {
    try {
      gift = planDailyGift(await client.request('DailyGiftPackRequest', {}, 'DailyGiftPackResponse', timeout));
    } catch {
      // 这个面板取不到不影响任务本身，如实留空比编一个状态好。
      gift = null;
    }
  }
  const gold = probe('ClickGoldInfoRequest')?.info;
  const freeLimit = config?.tables?.OfflineParamCfg?.data?.find(row => row.paramName === '免费点金次数')?.paramValue;
  return { daily, tasks: evaluations, chests: planChests(daily, config), gift, ruby, config, player,
    freeRecruitAt: probe('RecruitInfoRequest')?.hero?.freeEndTimeSeconds,
    freeGoldAt: freeLimit > 0 && gold?.freeTimes >= freeLimit ? gold.resetTime : undefined,
  };
}

// 发一条动作，带 Response 的等回包，没有配套 Response 的靠 sendWatch 看有没有被 PromptResponse 打回来。
async function sendAction(client, protocol, action, timeout) {
  if (action.response && protocol[action.response]) {
    return client.request(action.request, action.body, action.response, timeout);
  }
  await client.sendWatch(action.request, action.body, { window: 400 });
  return null;
}

// 有付费动作时必须显式开 allowPaid，否则默认只做免费的部分。
//
// claimRewards 走的是「收尾」：驱动动作发完服务端才更新完成数，所以这里重新问一次
// DailyTaskInfoResponse，先把达标任务的奖励领了（奖励里的活跃度会把活跃度顶上去），
// 再领活跃度宝箱。少了这一步，任务做完了奖励还挂在服务端上。
export async function runDailies(client, protocol, survey, { allowMutate = false, allowPaid = false, claimRewards = true, config = null, timeout = 15000, onStep, allowAction = () => true, settings = null, beforeAction, afterAction, cancelAction } = {}) {
  if (!allowMutate) throw new Error('完成日常会改变账号状态，需要 --yes');
  const results = [];
  if (settings && !settings.dailies.enabled) return results;
  for (const entry of survey.tasks) {
    if (!entry.actions?.length) continue;
    if (entry.status === 'paid' && !allowPaid) {
      results.push({ id: entry.task.id, skipped: true, reason: '需要付费，未开 allowPaid' });
      onStep?.({ id: entry.task.id, title: entry.task.title, skipped: true, reason: '需要付费' });
      continue;
    }
    for (const action of entry.actions) {
      if (!allowAction(entry.task.id, action)) continue;
      if (!allowPaid && action.costs?.some(item => item.id === 'RUBY' && item.num > 0)) {
        const outcome = { id: entry.task.id, title: entry.task.title, skipped: true, reason: '本次操作未允许花钻石' };
        results.push(outcome); onStep?.(outcome); continue;
      }
      let ticket;
      let prepared = false;
      let writeAttempted = false, writeFailure;
      // Drivers include preflight and post-write reads. Cancellation evidence
      // must belong to the mutation itself, never to a later read/hook.
      const performWrite = async write => {
        writeAttempted = true;
        try { return await write(); }
        catch (error) { writeFailure = error; throw error; }
      };
      try {
        ticket = await beforeAction?.({ kind: 'daily', scope: 'daily', setting: 'dailies.enabled', label: action.note, ...action });
        prepared = true;
        if (!allowAction(entry.task.id, action)) {
          await cancelAction?.(action, ticket, { notSent: true });
          const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, note: action.note, skipped: true, reason: '日常行动已关闭或账号已暂停' };
          results.push(outcome); onStep?.(outcome); continue;
        }
        let body;
        if (entry.task.id === 1010 && typeof DAILY_DRIVERS[1010].run === 'function') {
          const sweepResult = await DAILY_DRIVERS[1010].run({ client, survey, action, timeout, allowAction, config, performWrite });
          if (sweepResult?.skipped) {
            if (!writeAttempted) await cancelAction?.(action, ticket, { notSent: true });
            const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, note: action.note, skipped: true, reason: sweepResult.reason };
            results.push(outcome); onStep?.(outcome); continue;
          }
          body = sweepResult?.body;
        } else if (action.request === 'ArenaChallengeRequest' && typeof arenaDailyDriver.run === 'function') {
          const arenaResult = await arenaDailyDriver.run({ client, protocol, action, timeout, allowAction, performWrite });
          if (arenaResult?.skipped) {
            if (!writeAttempted) await cancelAction?.(action, ticket, { notSent: true });
            const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, note: action.note, skipped: true, reason: arenaResult.reason };
            results.push(outcome); onStep?.(outcome); continue;
          }
          body = arenaResult?.body;
        } else {
          body = await performWrite(() => sendAction(client, protocol, action, timeout));
        }
        const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, note: action.note, ok: true, body };
        results.push(outcome);
        onStep?.(outcome);
        await afterAction?.(action, ticket, action.response ? outcome : { ...outcome, sent: true });
      } catch (error) {
        const notSent = !writeAttempted || (writeFailure === error && error.notSent === true);
        const rejected = writeFailure === error && error.prompt && error.request === action.request;
        if (prepared && (notSent || rejected)) {
          await cancelAction?.(action, ticket, { notSent, error });
        }
        const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, way: action.body?.way, note: action.note, ok: false,
          ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true, reason: error.message } : {}), error: error.message };
        results.push(outcome);
        onStep?.(outcome);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  if (claimRewards) {
    // 服务端的完成数是异步落库的，动作刚发完就问会读到旧值。
    await new Promise((resolve) => setTimeout(resolve, 1000));
    results.push(...await claimDailies(client, protocol, { config: config ?? survey.config, timeout, onStep, settings }));
  }
  return results;
}

// 收尾两连：先领达标任务的奖励，再领活跃度宝箱。
export async function claimDailies(client, protocol, { config = null, timeout = 15000, onStep, enabled = () => true, scheduler, settings = null } = {}) {
  const results = [];
  const selected = key => !settings || (settings.dailies.enabled && (key === 'dailyRewards' ? settings.dailies.claimTasks : key === 'gift' ? settings.dailies.claimGift : settings.dailies.claimDailyChest || settings.dailies.claimWeeklyChest));
  const ready = key => selected(key) && enabled(key) && (!scheduler || scheduler.due(key));

  const report = (outcome) => {
    results.push(outcome);
    onStep?.(outcome);
  };

  async function readDaily(title) {
    try {
      return await client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse', timeout);
    } catch (error) {
      report({ id: 'dailyInfo', title, ok: false, error: error.message });
      return null;
    }
  }
  const canReadDaily = protocol.DailyTaskInfoRequest && protocol.DailyTaskInfoResponse;
  const after = canReadDaily && (ready('dailyRewards') || ready('chests')) ? await readDaily('读取日常奖励') : null;
  const claimable = (after?.dailyTask ?? []).filter((task) => task.progress >= task.targetProgress && !task.rewardClaimed);
  for (const task of claimable) {
    if (!ready('dailyRewards')) break;
    const title = TASK_TITLES[task.id] ?? String(task.id);
    const action = { request: 'DrawDailyTaskRewardRequest', response: 'DrawDailyTaskRewardResponse', body: { id: task.id }, note: `领任务奖励（${title}）` };
    try {
      const body = await sendAction(client, protocol, action, timeout);
      report({ id: task.id, title, request: action.request, note: action.note, ok: true, body });
    } catch (error) {
      report({ id: task.id, title, request: action.request, note: action.note, ok: false, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 任务奖励刚加过活跃度，所以宝箱要按新活跃度重新算一次，否则会漏掉刚好够到的档位。
  const fresh = ready('chests') && results.some(entry => entry.ok) ? await readDaily('刷新活跃度') : after;
  const actions = (fresh ? planChests(fresh, config).actions : []).filter(action => !settings || (action.request === 'DrawWeeklyRewardRequest' ? settings.dailies.claimWeeklyChest : settings.dailies.claimDailyChest));
  if (scheduler && fresh?.dailyResetTime > scheduler.now()) {
    const recheck = Math.min(fresh.dailyResetTime, scheduler.now() + 180);
    if (ready('dailyRewards') && fresh.dailyTask?.length) {
      scheduler.observe?.('dailyRewards','已领取 '+fresh.dailyTask.filter(t=>t.rewardClaimed).length+'/'+fresh.dailyTask.length+' 项任务奖励');
      if (fresh.dailyTask.every(task => task.rewardClaimed)) scheduler.defer('dailyRewards', fresh.dailyResetTime);
      else if (fresh.dailyTask.every(task => task.rewardClaimed || task.progress < task.targetProgress)) scheduler.defer('dailyRewards', recheck);
    }
    // This switch serves both day and week tiers. Only sleep once both sets
    // are exhausted, waking at the earlier (daily) reset.
    const allCollected = kind => {
      if (settings && !(kind === 'daily' ? settings.dailies.claimDailyChest : settings.dailies.claimWeeklyChest)) return true;
      const rows = config?.tables?.[CHEST_TABLE[kind]]?.data;
      const claimed = fresh[kind + 'RewardClaimed'];
      return rows?.length && rows.every(row => claimed?.includes(row.id));
    };
    if (ready('chests') && !actions.length && Object.values(CHEST_TABLE).every(table => config?.tables?.[table]?.data?.length)) {
      scheduler.observe?.('chests',allCollected('daily')&&allCollected('weekly')?'当前可领活跃宝箱已全部领取':'活跃度尚未达到下一档');
      scheduler.defer('chests', allCollected('daily') && allCollected('weekly') ? fresh.dailyResetTime : recheck);
    }
  }
  for (const action of actions) {
    if (!ready('chests')) break;
    const title = action.request === 'DrawWeeklyRewardRequest' ? '周活跃宝箱' : '日常活跃宝箱';
    try {
      const body = await sendAction(client, protocol, action, timeout);
      report({ id: 'activityChest', title, request: action.request, note: action.note, ok: true, body });
    } catch (error) {
      report({ id: 'activityChest', title, request: action.request, note: action.note, ok: false, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 每日精选的免费赠礼。GotFreeDailyPackRequest 没有配套 Response，所以发完要重新问一次
  // DailyGiftPackResponse 确认 drawnPack 里真的多了「赠礼」——只看「没被 prompt 打回」不算成功。
  if (ready('gift') && protocol.DailyGiftPackRequest && protocol.DailyGiftPackResponse) {
    let before;
    try {
      before = await client.request('DailyGiftPackRequest', {}, 'DailyGiftPackResponse', timeout);
    } catch (error) {
      report({ id: 'freeDailyPack', title: '读取每日赠礼', ok: false, error: error.message });
      return results;
    }
    const plan = planDailyGift(before);
    scheduler?.observe?.('gift',plan.freeAvailable?'免费赠礼可领取':'今日免费赠礼已领取');
    if (!plan.freeAvailable && scheduler && plan.resetTime > scheduler.now()) scheduler.defer('gift', plan.resetTime);
    if (plan.actions.length > 0 && ready('gift')) {
      const action = plan.actions[0];
      try {
        await sendAction(client, protocol, action, timeout);
        const after = await client.request('DailyGiftPackRequest', {}, 'DailyGiftPackResponse', timeout);
        const ok = (after.drawnPack ?? []).includes(FREE_DAILY_PACK_ID);
        if (ok && scheduler && after.resetTime > scheduler.now()) scheduler.defer('gift', after.resetTime);
        report({ id: 'freeDailyPack', title: '每日免费赠礼', request: action.request, note: action.note, ok,
          error: ok ? undefined : '服务端尚未确认领取每日赠礼' });
      } catch (error) {
        report({ id: 'freeDailyPack', title: '每日免费赠礼', request: action.request, note: action.note, ok: false, error: error.message });
      }
    }
  }
  return results;
}

// 活跃奖励那两行：没得领的时候也要说清楚差多少，否则看不出是「领完了」还是「没在领」。
function chestLine(name, chest) {
  const claimed = chest.claimed.length ? chest.claimed.join('/') : '无';
  if (chest.tiers.length) {
    return `活跃奖励 ${name} ${chest.activity} 活跃 · 已领 ${claimed} · 可领 第 ${chest.tiers.map((tier) => tier.id).join('/')} 档`;
  }
  const tail = chest.nextAt == null ? '全部领完' : `还差 ${chest.nextAt - chest.activity} 点到第 ${chest.nextAt} 档`;
  return `活跃奖励 ${name} ${chest.activity} 活跃 · 已领 ${claimed} · 暂无可领（${tail}）`;
}

export function formatSurvey(survey) {
  const lines = [];
  const label = { ready: '可做', paid: '需付费', partial: '部分', waiting: '等待中', done: '已完成', blocked: '不可用', error: '出错', unknown: '未知' };
  for (const entry of survey.tasks) {
    const task = entry.task;
    const progress = `${task.progress}/${task.targetProgress}`;
    const actions = (entry.actions ?? []).length;
    const suffix = entry.reason ? ` — ${entry.reason}` : actions ? ` — ${actions} 个动作` : '';
    lines.push(`${(label[entry.status] ?? entry.status).padEnd(4)} ${String(task.id).padEnd(5)}${task.title.padEnd(8)} ${progress.padEnd(6)}${suffix}`);
  }
  if (survey.chests) {
    lines.push(chestLine('日', survey.chests.daily));
    lines.push(chestLine('周', survey.chests.weekly));
  }
  if (survey.gift) {
    lines.push(survey.gift.freeAvailable
      ? `每日赠礼 未领 · 可领（免费，${FREE_DAILY_PACK_ID}）`
      : `每日赠礼 已领（${FREE_DAILY_PACK_ID}）`);
  }
  return lines.join('\n');
}
