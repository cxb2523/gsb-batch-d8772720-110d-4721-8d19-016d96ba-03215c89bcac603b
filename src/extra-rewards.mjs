import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { normalize } from './worlds.mjs';

export const extraRewardKeys = ['worldOnline', 'tradeTasks', 'guildTitleReward', 'guildAidCollect', 'heroRecruitRewards',
  'seasonTasks', 'crossRankDaily', 'worldBossDamage', 'passStageRewards', 'museumRevenue', 'museumAchievements'];

const labels = {
  worldOnline: '世界在线奖励', tradeTasks: '海商王联盟任务', guildTitleReward: '联盟职级奖励', guildAidCollect: '联盟互助收取',
  heroRecruitRewards: '英雄累计招募奖励', seasonTasks: '赛季任务奖励', crossRankDaily: '跨服排行每日奖励',
  worldBossDamage: '世界 Boss 伤害奖励', passStageRewards: '闯关基金奖励', museumRevenue: '博物馆营收', museumAchievements: '博物馆人气成就',
};
const CROSS_RANK_RED_POINT = 33;
const REWARD_REPLIES = ['GotRewardResponse', 'OkResponse'];
const DAY = 86400;
const BEIJING = 8 * 3600;
const WAR_START_HOUR = 20;
const WAR_END_HOUR = 21;
const MAX_PASS_CLAIMS = 10;

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const startOfDay = time => Math.floor((time + BEIJING) / DAY) * DAY - BEIJING;
const configAssets = (config, list = []) => list.map(([id, num]) => displayMaterial(config, id) + ' ×' + num).join('、');
const replyAssets = (config, reward) => (normalize(reward)?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
const withReward = (label, text) => (text ? label + ' · 获得 ' + text : label);
const moduleLevel = (config, id) => rows(config, 'ModuleOpenCfg').find(row => row.moduleId === id)?.playerLevel;

export function seasonOf(player) {
  const world = normalize(player?.worldId);
  return Number.isSafeInteger(world) && world > 0 ? Math.floor(world / 1e6) % 1000 : 0;
}

// 与客户端 seasonCfgList 一致：使用不超过当前赛季的最新配置。
export function seasonRows(config, table, player) {
  const season = seasonOf(player);
  const eligible = rows(config, table).filter(row => row.season > 0 && row.season <= season);
  const applicable = Math.max(0, ...eligible.map(row => row.season));
  return eligible.filter(row => row.season === applicable);
}

export function gameplayOpenDay(config, player, gameplay) {
  const days = rows(config, 'GameplayOpenCfg').find(row => row.gameplay === gameplay)?.openDays;
  if (!Array.isArray(days) || !days.length) return 0;
  const season = Math.max(seasonOf(player), 1);
  return days[Math.min(season, days.length) - 1] ?? 0;
}

export function worldOpenDays(player, now) {
  const opened = toNumber(player?.worldOpenTime);
  if (!(opened > 0)) return null;
  return Math.floor((now - startOfDay(opened)) / DAY) + 1;
}

// 规则与客户端 WarPop、WarOnlineReward 相同：当天 20:00 开放，已在 21:00 后领过则今天结束，
// 每档按上次领取时间计时。
export function worldOnlineState(config, player, counter, now) {
  const tiers = [...rows(config, 'WorldOnlineRwdCfg')].sort((a, b) => a.stage - b.stage);
  const stage = counter ? toNumber(counter.num) : 0;
  const last = counter ? toNumber(counter.updateTime) : 0;
  const today = startOfDay(now);
  const tomorrow = today + DAY + WAR_START_HOUR * 3600 + 1;
  const next = tiers.find(tier => tier.stage === stage + 1);
  if (!tiers.length) return { status: 'waiting', at: now + 3600, reason: '缺少世界在线奖励配置' };
  if (!next) return { status: 'waiting', at: tomorrow, reason: '今日 ' + stage + ' 档已全部领完' };
  const warDay = gameplayOpenDay(config, player, '国战');
  const days = worldOpenDays(player, now);
  let opensAt = today + WAR_START_HOUR * 3600;
  if (days !== null && days < warDay) opensAt = today + (warDay - days) * DAY + WAR_START_HOUR * 3600;
  if (now <= opensAt) return { status: 'waiting', at: opensAt + 1, reason: '每天 20:00 开放（北京时间）' };
  if (last >= today + WAR_END_HOUR * 3600) return { status: 'waiting', at: tomorrow, reason: '今天的开放时段已结束' };
  if (now < last + next.seconds) return { status: 'waiting', at: last + next.seconds, reason: '第 ' + next.stage + ' 档计时中' };
  return { status: 'ready', next, stage };
}

async function readOnlineCounter(client) {
  const reply = await client.request('CounterInfoRequest', {}, 'CounterInfoResponse');
  return reply?.counters?.find(row => row.type === 'DAILY_WORLD_ONLINE_RWD') ?? null;
}

async function claimWorldOnline(ctx) {
  const { client, config, player, scheduler, report } = ctx;
  const required = moduleLevel(config, '世界');
  if (!(player?.level >= required)) {
    scheduler?.defer('worldOnline', scheduler.now() + 3600);
    return report(skip('worldOnline', '世界玩法 ' + required + ' 级开放'));
  }
  const before = worldOnlineState(config, player, await readOnlineCounter(client), clock(client));
  if (before.status !== 'ready') {
    scheduler?.defer('worldOnline', before.at);
    return report(skip('worldOnline', before.reason));
  }
  let reply = null;
  try {
    reply = await client.request('GotWorldOnlineRwdRequest', {}, REWARD_REPLIES);
  } catch (error) {
    // 回包类型未在协议中声明，超时不代表失败，以重新读取的计数为准。
    if (error.prompt || !client.connected) throw error;
  }
  const counter = await readOnlineCounter(client);
  if (!(counter && toNumber(counter.num) > before.stage)) throw new Error('服务端未确认第 ' + before.next.stage + ' 档已领取');
  const after = worldOnlineState(config, player, counter, clock(client));
  scheduler?.defer('worldOnline', after.at);
  report({ key: 'worldOnline', label: withReward('世界在线奖励 · 第 ' + before.next.stage + ' 档',
    replyAssets(config, reply?.reward) || configAssets(config, before.next.reward)), ok: true });
}

async function claimTradeTasks({ client, config, player, scheduler, report, allowed }) {
  const key = 'tradeTasks';
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  const required = moduleLevel(config, '海商王');
  const activity = client.tradeActivity;
  const now = clock(client);
  if (!(player?.level >= required)) { later(3600); return report(skip(key, '海商王 ' + required + ' 级开放')); }
  if (!(activity?.startTime <= now && now < activity?.endTime)) { later(3600); return report(skip(key, '海商王活动未开放')); }
  const task = (await client.request('TradeTaskRequest', {}, 'TradeTaskResponse'))?.guildTask;
  if (!task) throw new Error('未能读取海商王联盟任务');
  const got = new Set(task.gotTaskId ?? []);
  const activityDay = Math.floor((now - startOfDay(activity.startTime)) / DAY) + 1;
  const ready = rows(config, 'TradeGuildTaskCfg').filter(row => row.day <= activityDay && !got.has(row.id)
    && (row.taskType === 0 ? task.profit : task.tradeTimes) >= row.tragetCount);
  for (const day of [...new Set(ready.map(row => row.day))].sort((a, b) => a - b)) {
    if (!allowed(key)) return;
    const reply = await client.request('TradeGotTaskRequest', { day }, 'TradeGotTaskResponse');
    const confirmed = new Set(reply?.gotTaskId ?? []);
    if (!ready.filter(row => row.day === day).some(row => confirmed.has(row.id))) throw new Error('服务端未确认第 ' + day + ' 天任务奖励');
    report({ key, label: withReward('海商王联盟任务 · 第 ' + day + ' 天', replyAssets(config, reply.reward)), ok: true });
  }
  later(600);
  if (!ready.length) report(skip(key, '当前没有可领取的任务'));
}

function isMember(player) {
  return toNumber(player?.guildId) > 0;
}

async function claimGuildTitle({ client, config, player, scheduler, report }) {
  const key = 'guildTitleReward';
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!isMember(player)) { later(1800); return report(skip(key, '当前账号未加入联盟')); }
  const info = await client.request('GuildInfoRequest', {}, 'GuildInfoResponse');
  const now = clock(client);
  const nextDay = startOfDay(now) + DAY;
  if (!info?.gotTitle) { scheduler?.defer(key, nextDay); return report(skip(key, '今天没有可领取的职级奖励')); }
  if (info.gotTitleTime >= startOfDay(now)) { scheduler?.defer(key, nextDay); return report(skip(key, '今天已领取')); }
  const reply = await client.request('GotGuildTitleRewardRequest', {}, REWARD_REPLIES);
  scheduler?.defer(key, nextDay);
  report({ key, label: withReward('联盟职级奖励', replyAssets(config, reply?.reward)), ok: true });
}

async function collectGuildAid({ client, config, player, scheduler, report }) {
  const key = 'guildAidCollect';
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!isMember(player)) { later(1800); return report(skip(key, '当前账号未加入联盟')); }
  const aids = normalize(await client.request('MyGuildAidRequest', {}, 'MyGuildAidResponse'))?.aids;
  if (!Array.isArray(aids)) throw new Error('未能读取我的求助');
  later(900);
  if (!aids.some(aid => aid.helper?.playerId > 0)) return report(skip(key, '暂时没有成员响应求助'));
  const reply = await client.request('GotMyGuildAidRequest', {}, REWARD_REPLIES);
  report({ key, label: withReward('已收取联盟互助', replyAssets(config, reply?.reward)), ok: true });
}

async function claimHeroRecruit({ client, config, player, scheduler, report, allowed }) {
  const key = 'heroRecruitRewards';
  const tiers = [...seasonRows(config, 'HeroRecruitTaskCfg', player)].sort((a, b) => a.id - b.id);
  scheduler?.defer(key, scheduler.now() + 1800);
  if (!tiers.length) return report(skip(key, '未找到当前赛季的招募奖励配置'));
  let task = (await client.request('RecruitInfoRequest', {}, 'RecruitInfoResponse'))?.hero?.task;
  while (allowed(key)) {
    if (!Number.isSafeInteger(task?.times) || !Number.isSafeInteger(task?.gotId)) return report(skip(key, '无法确认累计招募次数'));
    const tier = tiers.find(row => row.id > task.gotId);
    if (!tier) return report(skip(key, '本赛季奖励已领完'));
    if (task.times < tier.times) return report(skip(key, '累计招募 ' + task.times + '/' + tier.times + ' 次'));
    const reply = await client.request('GotHeroRecruitTaskRequest', {}, 'GotRecruitTaskResponse');
    if (reply?.gotId !== tier.id) throw new Error('服务端未确认第 ' + tier.id + ' 档招募奖励');
    report({ key, label: withReward('英雄累计招募 · 第 ' + tier.id + ' 档', replyAssets(config, reply.reward)), ok: true });
    task = { ...task, gotId: reply.gotId };
  }
}

export function seasonTaskReady(tasks, got, tiers) {
  return tiers.filter(tier => {
    const task = tasks.find(row => row.stage === tier.stage);
    const claimed = got.find(row => row.stage === tier.stage);
    if (!task) return false;
    return (task.personProgress >= tier.personTarget && !claimed?.gotPerson)
      || (task.teamProgress >= tier.teamTarget && !claimed?.gotTeam);
  });
}

async function claimSeasonTasks({ client, config, player, scheduler, report }) {
  const key = 'seasonTasks';
  scheduler?.defer(key, scheduler.now() + 1800);
  const required = moduleLevel(config, '世界');
  if (!(player?.level >= required)) return report(skip(key, '世界玩法 ' + required + ' 级开放'));
  const info = await client.request('SeasonTaskRequest', {}, 'SeasonTaskResponse');
  const ready = seasonTaskReady(info?.task ?? [], info?.got ?? [], seasonRows(config, 'SeasonTaskCfg', player));
  if (!ready.length) return report(skip(key, '当前没有可领取的赛季任务'));
  const reply = await client.request('GotSeasonTaskRequest', {}, 'GotSeasonTaskResponse');
  if (!reply?.got?.length) throw new Error('服务端未确认赛季任务奖励');
  report({ key, label: withReward('赛季任务奖励', replyAssets(config, reply.reward)), ok: true });
}

async function claimCrossRank({ client, config, scheduler, report }) {
  const key = 'crossRankDaily';
  const pending = scheduler?.redPoint?.(CROSS_RANK_RED_POINT) > 0;
  scheduler?.defer(key, scheduler.now() + 3600);
  if (!pending) return report(skip(key, '当前没有可领取的奖励'));
  const reply = await client.request('GetDailyRewardRequest', {}, REWARD_REPLIES);
  scheduler.clearRedPoint?.(CROSS_RANK_RED_POINT);
  report({ key, label: withReward('跨服排行每日奖励', replyAssets(config, reply?.reward)), ok: true });
}

export function worldBossRewardLevel(info, tiers) {
  const done = info?.gotRewardLevel ?? 0;
  return tiers.filter(row => row.level > done && info?.bestDamage >= row.damage).reduce((max, row) => Math.max(max, row.level), 0);
}

async function claimWorldBoss({ client, config, player, scheduler, report }) {
  const key = 'worldBossDamage';
  scheduler?.defer(key, scheduler.now() + 1800);
  const info = normalize(await client.request('WorldBossInfoRequest', {}, 'WorldBossInfoResponse'))?.info;
  if (!(info?.bossId > 0)) return report(skip(key, '世界 Boss 未开放'));
  const tiers = seasonRows(config, 'WorldBossDamageRewardCfg', player).filter(row => row.bossId === info.bossId);
  const level = worldBossRewardLevel(info, tiers);
  if (!level) return report(skip(key, '伤害未达到下一档'));
  const reply = await client.request('WorldBossGetDamageRewardRequest', {}, REWARD_REPLIES);
  report({ key, label: withReward('世界 Boss 伤害奖励 · 第 ' + level + ' 档', replyAssets(config, reply?.reward)), ok: true });
}

async function claimPassStage({ client, config, scheduler, report, allowed }) {
  const key = 'passStageRewards';
  scheduler?.defer(key, scheduler.now() + 1800);
  const state = await client.request('PassStageStateRequest', {}, 'PassStageStateResponse');
  if (state?.isOver || !(state?.maxOpenStage > 0)) return report(skip(key, '闯关基金未开放'));
  const pending = (await client.request('PassStageRequest', { stage: state.maxOpenStage }, 'PassStageResponse'))?.rwdStage ?? [];
  if (!pending.length) return report(skip(key, '当前没有可领取的奖励'));
  for (const stage of pending.slice(0, MAX_PASS_CLAIMS)) {
    if (!allowed(key)) return;
    const reply = await client.request('PassStageGotRewardRequest', { stage }, 'PassStageGotRewardResponse');
    report({ key, label: withReward('闯关基金 · 第 ' + stage + ' 期', replyAssets(config, reply?.reward)), ok: true });
  }
}

async function readMuseum({ client, config, scheduler, report, keys }) {
  const later = seconds => { for (const key of keys) scheduler?.defer(key, scheduler.now() + seconds); };
  const allowedBuildings = new Set(rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === '博物馆').map(row => row.buildingId));
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const built = (water?.building ?? []).some(row => allowedBuildings.has(row.buildingId) && row.level > 0);
  later(1800);
  if (!built) {
    for (const key of keys) report(skip(key, '博物馆尚未建成'));
    return null;
  }
  return normalize(await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse'));
}

async function claimMuseum(ctx) {
  const { client, config, report, allowed } = ctx;
  const info = await readMuseum(ctx);
  if (!info) return;
  if (ctx.keys.includes('museumRevenue')) {
    if (info.uncollectedRevenue > 0) {
      const reply = normalize(await client.request('MuseumCollectRevenueRequest', {}, 'MuseumCollectRevenueResponse'));
      report({ key: 'museumRevenue', label: '博物馆营收 · 人气 +' + (reply?.collected ?? info.uncollectedRevenue), ok: true });
    } else report(skip('museumRevenue', '暂无营收'));
  }
  if (!ctx.keys.includes('museumAchievements')) return;
  const claimed = new Set(info.claimedAchievements ?? []);
  const ready = rows(config, 'MuseumAchievementCfg').filter(row => row.score <= info.topPopularity && !claimed.has(row.score))
    .sort((a, b) => a.score - b.score);
  if (!ready.length) return report(skip('museumAchievements', '暂无可领取的成就'));
  for (const row of ready.slice(0, MAX_PASS_CLAIMS)) {
    if (!allowed('museumAchievements')) return;
    const reply = await client.request('MuseumClaimAchievementRequest', { popularityThreshold: row.score }, REWARD_REPLIES);
    report({ key: 'museumAchievements', label: withReward('博物馆人气成就 · ' + row.score,
      replyAssets(config, reply?.reward) || configAssets(config, row.rewards)), ok: true });
  }
}

const skip = (key, reason) => ({ key, label: labels[key], skipped: true, reason });

// 一项失败不影响其他项，失败后 30 分钟再试，避免反复请求已被拒绝的接口。
export async function claimExtraRewards(client, config, player, allowed, report, scheduler = null, active = allowed) {
  const ctx = { client, config, player, scheduler, report, allowed: active };
  const steps = [
    ['worldOnline', claimWorldOnline],
    ['tradeTasks', claimTradeTasks],
    ['guildTitleReward', claimGuildTitle],
    ['guildAidCollect', collectGuildAid],
    ['heroRecruitRewards', claimHeroRecruit],
    ['seasonTasks', claimSeasonTasks],
    ['crossRankDaily', claimCrossRank],
    ['worldBossDamage', claimWorldBoss],
    ['passStageRewards', claimPassStage],
  ];
  const run = async (key, work) => {
    try { await work(); }
    catch (error) {
      scheduler?.defer(key, scheduler.now() + (key === 'worldOnline' ? 300 : 1800));
      report({ key, label: labels[key], ok: false, error: error.message });
    }
  };
  for (const [key, claim] of steps) {
    if (allowed(key)) await run(key, () => claim(ctx));
  }
  const museumKeys = ['museumRevenue', 'museumAchievements'].filter(allowed);
  if (museumKeys.length) await run(museumKeys[0], () => claimMuseum({ ...ctx, keys: museumKeys }));
}
