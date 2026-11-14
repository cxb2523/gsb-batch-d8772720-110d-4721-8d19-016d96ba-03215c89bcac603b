// 任务领取闭环：主线（成长任务）、支线、成就，以及每日订单的进度档位奖励。
//
// 目标值不靠猜：主线/支线从 MainTaskCfg / BranchTaskCfg 的 params 取，取法逐条对齐客户端
// TaskUtil.taskProgress()（那段 switch 是从游戏自身的 _subpackages_main_ 里读出来的）。
// 算不出目标值的任务不排进计划，只在 notes 里写明，宁可漏领也不乱发请求。
// 成就的响应自带 targetProgress，不需要配置表。
//
// 这四条领取请求在协议表里都没有配套的 *Response：成功时服务端一声不吭，被拒时只推
// PromptResponse，所以一律走 client.sendWatch()，见 docs/gameplay.md 第 11.3 节。

import { normalize } from './worlds.mjs';

// 客户端 TaskUtil.taskProgress 的第二组：目标值取 params[1]（params[0] 是物品名或类型名）。
const TARGET_FROM_PARAM1 = new Set([
  '拥有指定资源', '获取资源', '生产物品', '种植作物', '占领资源地', '击败野怪',
  '英雄升星', '英雄万能升星', '藏品万能升星', '强化装备', '分解装备', '分解海兽',
]);

// 按 taskId/字段建一张表的索引；配置表缺失时返回空表，调用方会退化成「算不出目标值」。
function indexBy(config, name, key) {
  const out = new Map();
  for (const row of config?.tables?.[name]?.data ?? []) out.set(row[key], row);
  return out;
}

function formatDesc(row) {
  if (!row?.desc) return '';
  const params = row.descParams ?? [];
  return row.desc.replace(/\{(\d+)\}/g, (all, i) => (params[Number(i)] ?? all));
}

// 任务目标值。与客户端同款规则，算不出来就返回 null（调用方据此跳过，不猜）。
export function taskTarget(row) {
  const params = row?.params;
  if (!Array.isArray(params) || params.length === 0) return null;
  // 升级建筑：params[1] 形如 "1|1"（数量|等级），客户端取 "|" 前那段。
  if (row.type === '升级建筑') {
    const n = parseInt(String(params[1] ?? '').split('|')[0], 10);
    return Number.isFinite(n) ? n : null;
  }
  // 试炼挑战：客户端把这个类型的目标值写死成 1（通过某副本的某一关）。
  if (row.type === '试炼挑战') return 1;
  const raw = TARGET_FROM_PARAM1.has(row.type) ? params[1] : params[0];
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// WorkerOrderUtil uses RewardUtil.seasonCfgList: within the season take the
// most recent group unlocked by the world's age, counting Beijing calendar days.
export function nextOrderTier(config, { orderNum = 0, rewardedNum = 0, player, now = Date.now() / 1000 } = {}) {
  let rows = config?.tables?.OrderDailyRewardCfg?.data ?? [];
  if (rows.some(row => row.season != null)) {
    const { worldId, worldOpenTime } = normalize(player ?? {});
    const season = Math.floor(worldId / 1e6) % 1000;
    const maxSeason = Math.max(...rows.map(row => row.season));
    rows = rows.filter(row => row.season === Math.min(season, maxSeason));
    const days = [...new Set(rows.map(row => row.worldOpenDays))].sort((a, b) => a - b);
    const age = worldOpenTime > 0 && now >= worldOpenTime
      ? Math.floor((now + 28800) / 86400) - Math.floor((worldOpenTime + 28800) / 86400) + 1 : null;
    const group = season > maxSeason ? days.at(-1) : days.length === 1 ? days[0]
      : age === null ? null : days.filter(day => day <= age).at(-1) ?? days[0];
    rows = rows.filter(row => row.worldOpenDays === group);
  }
  const reqNums = [...new Set(rows.map(row => row.reqNum))].filter(num => Number.isFinite(num)).sort((a, b) => a - b);
  const tier = reqNums.find((num) => num > rewardedNum) ?? null;
  if (tier === null) return { tier: null, reqNums, claimable: false };
  return { tier, reqNums, claimable: orderNum >= tier };
}

// 只读探测：把三类任务和每日订单档位都拉一遍，算出每一条能不能领。
export async function surveyTasks(client, protocol, { config = null, water = null, timeout = 8000, scheduler, player } = {}) {
  const main = normalize(await client.request('MainTaskInfoRequest', {}, 'MainTaskInfoResponse', timeout));
  const achievement = normalize(await client.request('AchievementInfoRequest', {}, 'AchievementInfoResponse', timeout));

  const mainCfg = indexBy(config, 'MainTaskCfg', 'taskId');
  const branchCfg = indexBy(config, 'BranchTaskCfg', 'taskId');

  const plan = [];
  const notes = [];

  // 主线：响应里只有一条，自带 rewardClaimed。
  let mainView = null;
  if (main.task) {
    const row = mainCfg.get(main.task.taskId) ?? null;
    const target = taskTarget(row);
    mainView = {
      taskId: main.task.taskId,
      type: row?.type ?? null,
      desc: formatDesc(row),
      progress: main.task.progress ?? 0,
      target,
      claimed: main.task.rewardClaimed === true,
    };
    if (mainView.claimed) notes.push(`主线 ${mainView.taskId} 已领过`);
    else if (target === null) notes.push(`主线 ${mainView.taskId} 目标值算不出（type=${mainView.type}），跳过`);
    else if (mainView.progress < target) notes.push(`主线 ${mainView.taskId} 进度 ${mainView.progress}/${target}，还不能领`);
    else {
      plan.push({
        kind: 'main',
        id: mainView.taskId,
        request: 'DrawMainTaskRewardRequest',
        body: { taskId: mainView.taskId },
        label: `主线 ${mainView.taskId} ${mainView.desc}`,
        reward: row?.reward ?? null,
      });
    }
  }

  // 支线：DispBranchTask 没有 rewardClaimed 字段。客户端的支线 map 在领取后本地删掉，
  // 而支线数据只在 MainTaskInfoResponse 里下发，所以 [branch] 本身就是「还没领的」。
  const branchView = [];
  for (const task of main.branch ?? []) {
    const row = branchCfg.get(task.taskId) ?? null;
    const target = taskTarget(row);
    const view = {
      taskId: task.taskId,
      type: row?.type ?? null,
      desc: formatDesc(row),
      progress: task.progress ?? 0,
      target,
    };
    if (target === null) notes.push(`支线 ${task.taskId} 目标值算不出（type=${view.type}），跳过`);
    else if (view.progress < target) notes.push(`支线 ${task.taskId} 进度 ${view.progress}/${target}，还不能领`);
    else {
      plan.push({
        kind: 'branch',
        id: task.taskId,
        request: 'GotBranchTaskRewardRequest',
        body: { taskId: task.taskId },
        label: `支线 ${task.taskId} ${view.desc}`,
        reward: row?.reward ?? null,
      });
    }
    branchView.push(view);
  }

  // 成就：响应自带 targetProgress，比配置表可靠。
  const achievementView = [];
  for (const task of achievement.task ?? []) {
    const view = {
      id: task.id,
      progress: task.progress ?? 0,
      target: task.targetProgress ?? null,
      claimed: task.rewardClaimed === true,
    };
    if (view.claimed) notes.push(`成就 ${task.id} 已领过`);
    else if (view.target === null) notes.push(`成就 ${task.id} 没有 targetProgress，跳过`);
    else if (view.progress < view.target) notes.push(`成就 ${task.id} 进度 ${view.progress}/${view.target}，还不能领`);
    else {
      plan.push({
        kind: 'achievement',
        id: task.id,
        request: 'GotAchievementRewardRequest',
        body: { id: task.id },
        label: `成就 ${task.id}`,
        reward: null,
      });
    }
    achievementView.push(view);
  }

  // 每日订单档位奖励：空体请求，服务端按 reqNum 发下一档。
  const summary = { main: mainView, branch: branchView, achievement: achievementView, orderOfTheDay: null, plan, notes };
  if (scheduler && !scheduler.due('orderDaily')) return summary;
  let order;
  try {
    const waterBody = normalize(water ?? await client.request('OnWaterRequest', {}, 'OnWaterResponse', timeout));
    order = waterBody?.orderOfTheDay;
  } catch (error) {
    summary.orderError = error.message;
    notes.push('未能查询每日订单：' + error.message);
    return summary;
  }
  if (!order) return summary;
  const now = scheduler?.now() ?? Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const tier = nextOrderTier(config, { ...order, player, now });
  const orderView = {
    orderNum: order.orderNum ?? 0,
    rewardedNum: order.rewardedNum ?? 0,
    tier: tier.tier,
    claimable: tier.claimable,
  };
  summary.orderOfTheDay = orderView;
  if (!tier.reqNums.length) notes.push('每日订单：未能确认当前赛季的奖励档位');
  else if (tier.tier === null) {
    notes.push('每日订单：已领完本日全部档位');
    scheduler?.defer('orderDaily', scheduler.nextDay());
  } else if (!tier.claimable) {
    notes.push(`每日订单：下一档要 ${tier.tier} 单，现在 ${orderView.orderNum} 单`);
    scheduler?.defer('orderDaily', Math.min(now + 180, scheduler.nextDay()));
  } else {
    plan.push({
      kind: 'orderDaily',
      id: tier.tier,
      request: 'GetNextOrderOTDRewardRequest',
      body: {},
      label: `每日订单 ${tier.tier} 单档位奖励`,
      reward: null,
    });
  }

  return summary;
}

// 逐条领取。同一条被服务端拒过就记下来，本轮之后不再重发——否则循环模式里会每轮骚扰一次。
export async function runTasks(client, protocol, survey, { allowMutate = false, window = 400, onStep, enabled = () => true, settings = null } = {}) {
  if (!allowMutate) throw new Error('领取任务奖励会改变账号状态，需要 --yes');
  const results = [];
  const rejected = new Set();
  for (const step of selectTaskSettings(survey, settings).plan) {
    if (!enabled()) break;
    const key = `${step.kind}:${step.id}`;
    if (rejected.has(key)) {
      const entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
      results.push(entry);
      onStep?.(entry);
      continue;
    }
    if (!protocol[step.request]) {
      const entry = { step, ok: false, error: `协议表里没有 ${step.request}` };
      results.push(entry);
      onStep?.(entry);
      continue;
    }
    try {
      const sent = await client.sendWatch(step.request, step.body, { window });
      const entry = { step, ok: true, sent };
      results.push(entry);
      onStep?.(entry);
    } catch (error) {
      rejected.add(key);
      const entry = { step, ok: false, error: error.message };
      results.push(entry);
      onStep?.(entry);
    }
  }
  return results;
}

export function selectTaskSettings(survey, settings) {
  if (!settings) return survey;
  const enabled = kind => kind === 'orderDaily' ? settings.loop.world && settings.resident.rewards : settings.loop.tasks &&
    (kind === 'main' ? settings.tasks.main : kind === 'branch' ? settings.tasks.branch : kind === 'achievement' ? settings.tasks.achievements : true);
  const paused = survey.plan.filter(step => !enabled(step.kind));
  return { ...survey, plan: survey.plan.filter(step => enabled(step.kind)), notes: [...survey.notes, ...paused.map(step => `${step.label}：已在设置中暂停领取`)] };
}

export function formatTaskPlan(survey) {
  const lines = [];
  const mark = (ok) => (ok ? '可领' : '  ');
  if (survey.main) {
    const m = survey.main;
    const target = m.target === null ? '?' : m.target;
    lines.push(`${mark(!m.claimed && m.progress >= (m.target ?? Infinity))} 主线 ${String(m.taskId).padEnd(6)}${m.type ?? ''} ${m.progress}/${target}${m.claimed ? ' 已领' : ''}`);
  }
  for (const b of survey.branch) {
    const target = b.target === null ? '?' : b.target;
    lines.push(`${mark(b.target !== null && b.progress >= b.target)} 支线 ${String(b.taskId).padEnd(6)}${b.type ?? ''} ${b.progress}/${target}`);
  }
  for (const a of survey.achievement) {
    lines.push(`${mark(!a.claimed && a.progress >= (a.target ?? Infinity))} 成就 ${String(a.id).padEnd(6)}${a.progress}/${a.target ?? '?'}${a.claimed ? ' 已领' : ''}`);
  }
  const o = survey.orderOfTheDay;
  if (o) lines.push(`${mark(o.claimable)} 订单 今日 ${o.orderNum} 单，已领档位 ${o.rewardedNum}，下一档 ${o.tier ?? '无'}`);
  for (const note of survey.notes) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
