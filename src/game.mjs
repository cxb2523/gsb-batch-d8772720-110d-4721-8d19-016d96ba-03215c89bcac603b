import { normalize } from './worlds.mjs';

// The read-only state queries the real client fires immediately after login, in the
// order it sends them. Taken verbatim from a capture of the game entering its main UI.
// Every one of these is a pure query: none of them mutates account state.
export const ENTRY_QUERIES = [
  { name: 'AllItemRequest' },
  { name: 'AllResourceRequest' },
  { name: 'AllHeroRequest' },
  { name: 'GetFormationRequest', body: { module: 1 } },
  { name: 'EmailBoxRequest', body: { pageNo: 0 } },
  { name: 'EquipsRequest' },
  { name: 'BadgesRequest' },
  { name: 'RecruitInfoRequest' },
  { name: 'AchievementInfoRequest' },
  { name: 'DailyTaskInfoRequest' },
  { name: 'DailyGiftPackRequest' },
  { name: 'MainTaskInfoRequest' },
  { name: 'GuideInfoRequest' },
  { name: 'AfkInfoRequest' },
  { name: 'MonthCardRequest' },
  { name: 'AllAntiqueRequest' },
  { name: 'OnWaterRequest' },
  { name: 'FishEncyclopediaRequest' },
  { name: 'CargoShipsRequest' },
  { name: 'AppointInfoRequest' },
  { name: 'ChatRecordRequest', body: { channel: 1 } },
  { name: 'GameEffectRequest' },
  { name: 'AllGuildAbstractionRequest' },
  { name: 'MyFleetsRequest' },
  { name: 'PirateKillRecordRequest' },
  { name: 'MyResFieldsRequest' },
  { name: 'GuildTechInfoRequest' },
  { name: 'GuildOrderRequest' },
  { name: 'MyFormationPresetRequest' },
  { name: 'SeasonTaskStageRequest' },
  { name: 'WorldBossInfoRequest' },
  { name: 'LimitedBossOpenRequest' },
  { name: 'AllPetRequest' },
  { name: 'SeasonRankInfoRequest' },
  { name: 'WeekInfoRequest' },
  { name: 'PassStageStateRequest' },
  { name: 'WeekOrderInfoRequest' },
  { name: 'CounterInfoRequest' },
  { name: 'RadarInfoRequest' },
  { name: 'EnvSkinListRequest' },
  { name: 'ChannelRewardInfoRequest' },
  { name: 'LimitTicketRequest' },
  { name: 'SeasonCardRequest' },
  { name: 'AllPirateRequest' },
  { name: 'PlayerFrameRequest' },
  { name: 'ChurnInfoRequest' },
  { name: 'UltraOpenRequest' },
  { name: 'BlackListRequest' },
];

// These two have no matching `*Response` type in the protocol table: the server answers
// with a push instead (`SCRedPoint`) or a generic `OkResponse`. Sending them with the
// request/response helper would just burn a timeout, so they go out fire-and-forget.
export const ENTRY_SIGNALS = [{ name: 'ExitWorldMapRequest' }, { name: 'RedPointRequest' }];

function responseNameOf(name) {
  return `${name.slice(0, -'Request'.length)}Response`;
}

// Fires the whole entry set in one burst, exactly as the client does, then waits for the
// responses. Nothing is sent sequentially: the server tolerates the burst and answering
// one at a time would take a minute of wall clock.
export async function collectState(client, protocol, { timeout = 15000, onResult = null, queries = ENTRY_QUERIES, signals = ENTRY_SIGNALS } = {}) {
  const ok = {};
  const failed = {};
  const waiting = [];

  for (const signal of signals) {
    if (protocol[signal.name]) client.send(signal.name, signal.body || {});
  }

  for (const query of queries) {
    const response = responseNameOf(query.name);
    if (!protocol[query.name] || !protocol[response]) {
      failed[query.name] = `no protocol type for ${protocol[query.name] ? response : query.name}`;
      continue;
    }
    waiting.push(
      client
        .request(query.name, query.body || {}, response, timeout)
        .then((body) => {
          ok[query.name] = normalize(body);
          if (onResult) onResult(query.name, body, null);
        })
        .catch((error) => {
          failed[query.name] = error.message;
          if (onResult) onResult(query.name, null, error);
        }),
    );
  }

  await Promise.all(waiting);
  return { ok, failed };
}

const asArray = (value) => (Array.isArray(value) ? value : []);

// Turns the raw response bodies into the picture a player would describe. Every number
// here is straight from the server; nothing is inferred except the obvious sums.
export function summarize(state, { now = Date.now() / 1000, config = null } = {}) {
  const q = state.ok || {};
  const water = q.OnWaterRequest || {};
  const afk = q.AfkInfoRequest?.afkInfo;
  const daily = q.DailyTaskInfoRequest;
  const achievement = q.AchievementInfoRequest;
  const email = q.EmailBoxRequest;
  const resFields = q.MyResFieldsRequest?.info;
  const items = asArray(q.AllItemRequest?.items);
  const heroes = asArray(q.AllHeroRequest?.heroes);
  const buildings = asArray(water.building);
  const monthCard = asArray(q.MonthCardRequest?.cardItem);

  const tasksDone = (list) => asArray(list).filter((task) => task.progress >= task.targetProgress);
  const claimable = (list) =>
    tasksDone(list).filter((task) => !task.rewardClaimed).length;

  return {
    resources: asArray(q.AllResourceRequest?.list).map((entry) => ({
      res: entry.res,
      amount: entry.amount,
      name: config ? config.resourceName(entry.res) : undefined,
    })),
    items: {
      kinds: items.length,
      total: items.reduce((sum, item) => sum + item.num, 0),
      top: [...items].sort((a, b) => b.num - a.num).slice(0, 12),
    },
    heroes: {
      count: heroes.length,
      power: heroes.reduce((sum, hero) => sum + hero.power, 0),
      list: heroes
        .map((hero) => ({ heroId: hero.heroId, level: hero.level, star: hero.star, power: hero.power, skinId: hero.skinId }))
        .sort((a, b) => b.power - a.power),
      formation: asArray(q.GetFormationRequest?.formation?.heroPositions).map((slot) => ({ heroId: slot.heroId, x: slot.pos?.x, y: slot.pos?.y })),
      appointed: asArray(q.AppointInfoRequest?.heroes).map((slot) => ({ heroId: slot.heroId, posId: slot.posId })),
    },
    afk: afk
      ? {
          level: afk.level,
          startTime: afk.afkStartTime,
          finishTime: afk.afkFinishTime,
          rewardedLevel: afk.rewardedLevel,
          capped: afk.afkFinishTime > 0 && now >= afk.afkFinishTime,
          pendingLevels: Math.max((afk.level ?? 0) - (afk.rewardedLevel ?? 0), 0),
        }
      : null,
    clickGold: q.AfkInfoRequest?.clickGoldInfo ?? null,
    daily: daily
      ? {
          tasks: asArray(daily.dailyTask).length,
          done: tasksDone(daily.dailyTask).length,
          claimable: claimable(daily.dailyTask),
          dailyActivity: daily.dailyActivity,
          weeklyActivity: daily.weeklyActivity,
          dailyRewardClaimed: asArray(daily.dailyRewardClaimed),
          resetTime: daily.dailyResetTime,
        }
      : null,
    achievements: achievement
      ? {
          total: asArray(achievement.task).length,
          done: tasksDone(achievement.task).length,
          claimable: claimable(achievement.task),
        }
      : null,
    mainTask: q.MainTaskInfoRequest?.task ? { taskId: q.MainTaskInfoRequest.task.taskId, progress: q.MainTaskInfoRequest.task.progress } : null,
    email: email ? { total: email.total, unclaimed: asArray(email.email).filter((mail) => !mail.got).length } : null,
    buildings: buildings.map((building) => ({
      buildingId: building.buildingId,
      level: building.level,
      auto: building.auto,
      building: building.buildFinishTime ? { start: building.buildStartTime, finish: building.buildFinishTime } : null,
      factory: building.factory ? { autoProductId: building.factory.autoProductId, finished: asArray(building.factory.finishedProducts) } : null,
      product: asArray(building.product?.asset),
    })),
    water: {
      autoProduceEndTime: water.autoProduceEndTime,
      autoProduceForever: water.autoProduceForever,
      autoFarming: water.autoFarming,
      fishingLevel: water.fishingLevel?.level,
      salvageLevel: water.salvageLevel?.level,
      divingLevel: water.divingLevel?.level,
      orderOfTheDay: water.orderOfTheDay ?? null,
    },
    resFields: resFields ? { count: asArray(resFields.fields).length, max: resFields.maxNum } : null,
    fleets: asArray(q.MyFleetsRequest?.fleets).length,
    guild: asArray(q.AllGuildAbstractionRequest?.guilds).map((entry) => ({ id: entry.id, level: entry.level })),
    counters: asArray(q.CounterInfoRequest?.counters),
    recruit: q.RecruitInfoRequest ?? null,
    antiques: q.AllAntiqueRequest ? { count: asArray(q.AllAntiqueRequest.antiques).length, masterLv: q.AllAntiqueRequest.masterLv, suits: asArray(q.AllAntiqueRequest.suits).length } : null,
    pets: asArray(q.AllPetRequest?.pets).length,
    equips: asArray(q.EquipsRequest?.equip).length,
    pirates: q.AllPirateRequest ? { count: asArray(q.AllPirateRequest.pirates).length, sweepTimes: q.AllPirateRequest.sweepTimes } : null,
    worldBoss: q.WorldBossInfoRequest?.info ?? null,
    season: q.SeasonRankInfoRequest ?? null,
    week: asArray(q.WeekInfoRequest?.activityTime),
    monthCard: monthCard.map((card) => ({ type: card.type, active: card.endTime > now, endTime: card.endTime, gotDailyReward: card.gotDailyReward })),
    guide: q.GuideInfoRequest?.guide ?? null,
    cargo: asArray(q.CargoShipsRequest?.ship).length,
    fish: q.FishEncyclopediaRequest ?? null,
  };
}

const clock = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString() : '-');

// One renderer, shared by the CLI and the console, so both always agree.
export function formatState(view) {
  const lines = [];
  lines.push(`资源:`);
  for (const entry of view.resources) lines.push(`  ${entry.name ? `${entry.name} ` : ''}res=${entry.res} amount=${entry.amount}`);
  lines.push(`道具: ${view.items.kinds} 种 / ${view.items.total} 个`);
  for (const item of view.items.top) lines.push(`  ${item.itemId} x${item.num}`);
  lines.push(`英雄: ${view.heroes.count} 个, 总战力 ${view.heroes.power}`);
  for (const hero of view.heroes.list) lines.push(`  ${hero.heroId} lv${hero.level} ${hero.star}星 战力${hero.power}`);
  lines.push(`  上阵: ${view.heroes.formation.map((slot) => `${slot.heroId}(${slot.x},${slot.y})`).join(' ')}`);
  if (view.afk) {
    lines.push(`挂机: 等级${view.afk.level} 开始${clock(view.afk.startTime)} 封顶${clock(view.afk.finishTime)}`);
    lines.push(`  已封顶=${view.afk.capped} 已领等级=${view.afk.rewardedLevel} 待领等级=${view.afk.pendingLevels}`);
  }
  if (view.daily) {
    lines.push(`每日任务: ${view.daily.done}/${view.daily.tasks} 完成, ${view.daily.claimable} 个可领奖, 活跃度 ${view.daily.dailyActivity}`);
    lines.push(`  重置 ${clock(view.daily.resetTime)}`);
  }
  if (view.achievements) lines.push(`成就: ${view.achievements.done}/${view.achievements.total} 完成, ${view.achievements.claimable} 个可领奖`);
  if (view.email) lines.push(`邮件: ${view.email.total} 封, ${view.email.unclaimed} 封未领附件`);
  lines.push(`水上建筑 ${view.buildings.length} 座:`);
  for (const building of view.buildings) {
    const bits = [
      building.level ? `lv${building.level}` : '未建',
      building.auto ? '自动' : '',
      building.building ? `建造中至 ${clock(building.building.finish)}` : '',
      building.factory ? `工厂产出 ${JSON.stringify(building.factory.finished)}` : '',
    ].filter(Boolean);
    lines.push(`  ${building.buildingId} ${bits.join(' ')}`);
  }
  lines.push(`世界: 资源田 ${view.resFields?.count ?? 0}/${view.resFields?.max ?? 0} 舰队 ${view.fleets} 货船 ${view.cargo} 海盗 ${view.pirates?.count ?? 0}(扫荡${view.pirates?.sweepTimes ?? 0})`);
  lines.push(`  自动生产至 ${clock(view.water.autoProduceEndTime)} 永久=${view.water.autoProduceForever} 自动种植=${view.water.autoFarming}`);
  lines.push(`  钓鱼lv${view.water.fishingLevel ?? '-'} 打捞lv${view.water.salvageLevel ?? '-'} 潜水lv${view.water.divingLevel ?? '-'}`);
  if (view.worldBoss) lines.push(`  世界Boss bossId=${view.worldBoss.bossId} 最高伤害=${view.worldBoss.bestDamage} 已领档位=${view.worldBoss.gotRewardLevel}`);
  lines.push(`公会候选: ${JSON.stringify(view.guild.map((entry) => entry.id))}`);
  lines.push(`每日计数: ${view.counters.map((counter) => `${counter.type}=${counter.num}`).join(' ')}`);
  lines.push(`招募: 英雄${view.recruit?.hero?.recruitTimes ?? '-'}次 下次保底${view.recruit?.hero?.nextLuck ?? '-'} | 藏品${view.recruit?.antique?.recruitTimes ?? '-'}次`);
  lines.push(`藏品 ${view.antiques?.count ?? 0} 件 大师lv${view.antiques?.masterLv ?? '-'} | 宠物 ${view.pets} | 装备 ${view.equips} | 月卡 ${JSON.stringify(view.monthCard)}`);
  lines.push(`新手引导: ${JSON.stringify(view.guide)} | 主线 ${JSON.stringify(view.mainTask)}`);
  if (view.fish) lines.push(`鱼类图鉴: ${JSON.stringify(view.fish)}`);
  return lines.join('\n');
}

