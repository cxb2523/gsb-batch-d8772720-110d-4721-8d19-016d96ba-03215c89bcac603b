// A new game connection always verifies the server again. Stopping and starting
// idle on the same connection keeps its confirmed cooldowns.
const schedules = new WeakMap();
// 红点类型与自动领奖任务的兼容映射，保留旧版事件驱动调度入口。
export const redPointTasks = {
  33: 'crossRankDaily', 41: 'treasureLoot', 42: 'guildAidCollect', 43: 'guildAidHelp', 53: 'tradeTasks',
  64: 'guildTitleReward', 65: 'museumRevenue',
};
const day = 86400;
const beijing = 8 * 3600;

export function rewardSchedule(client) {
  if (schedules.has(client)) return schedules.get(client);
  const deadlines = new Map();
  const observations = new Map();
  const expected = new Map();
  const redPoints = new Map();
  const now = () => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  function clearTask(key) {
    for (const saved of deadlines.keys()) {
      if (saved === key || saved.startsWith(key + ':')) deadlines.delete(saved);
    }
    for (const saved of expected.keys()) {
      if (saved === key || saved.startsWith(key + ':')) expected.delete(saved);
    }
  }
  const clearTasks = keys => keys.forEach(clearTask);
  const schedule = {
    now,
    observe(key, text, state='waiting') { observations.set(key,{text,state,checkedAt:now()}); },
    expect(key, until) { if(Number.isFinite(until))expected.set(key,Math.ceil(until)); },
    status: key => observations.get(key) ?? null,
    nextCheck: key => deadlines.get(key) > now() ? deadlines.get(key) : expected.get(key)>now()?expected.get(key):null,
    nextDay: () => (Math.floor((now() + beijing) / day) + 1) * day - beijing,
    due(key) {
      if (deadlines.get(key) > now()) return false;
      deadlines.delete(key);
      return true;
    },
    defer(key, until) {
      if (Number.isFinite(until) && until > now()) { deadlines.set(key, Math.ceil(until)); if (!observations.has(key)) observations.set(key,{text:"已检查，等待下次开放",checkedAt:now()}); }
    },
    clear(key) {
      const removed = deadlines.delete(key);
      expected.delete(key);
      return removed;
    },
    clearTask,
    redPoint: type => redPoints.get(type) ?? 0,
    clearRedPoint: type => redPoints.delete(type),
  };
  client.on?.('message', ({ name, body }) => {
    switch (name) {
      case 'SCServerTimeChanged':
      case 'SCDailyTaskReset':
        deadlines.clear(); observations.clear(); expected.clear();
        break;
      case 'SCDailyTaskUpdate':
        if (!body?.task || body.task.rewardClaimed || body.task.progress >= body.task.targetProgress) {
          clearTask('dailyRewards');
          clearTask('chests');
        }
        break;
      case 'SCDailyWeeklyReset':
        clearTask('chests');
        clearTask('weekGift');
        break;
      case 'SCNewEmail': clearTask('mail'); break;
      case 'SCRedPoint':
        for (const { type, num } of body?.redPoint ?? []) {
          redPoints.set(type, num ?? 0);
          if (num > 0 && redPointTasks[type]) clearTask(redPointTasks[type]);
        }
        break;
      case 'SCNewGuildAidAsk': clearTask('guildAidHelp'); break;
      case 'SCGuildAidHelp':
      case 'SCGuildAidRemove': clearTasks(['guildAidCollect', 'guildAidHelp']); break;
      case 'SCTreasureLootRefresh': clearTask('treasureLoot'); break;
      case 'SCJoinGuild':
      case 'SCLeaveGuild':
        clearTasks(['guildOrders', 'radarAuto', 'radarRepair', 'guildWelfare', 'guildAidCollect', 'guildAidHelp', 'guildTitleReward', 'treasureLoot']);
        break;
      case 'SCGuildOrder': clearTask('guildOrders'); break;
      case 'SCRadarUpdate':
      case 'SCRadarEventState': clearTasks(['radarAuto', 'radarRepair']); break;
      case 'SCMyFleetUpdate': clearTasks(['radarAuto', 'radarRepair', 'treasureLoot']); break;
      case 'SCUpdateEquip':
      case 'SCEquipDelete': clearTasks(['equipmentCollect', 'equipmentCraft']); break;
      case 'SCPetsUpdate':
      case 'SCPetDelete':
      case 'SCBreedLevelUpdate': clearTasks(['petCollect', 'petBreed']); break;
      case 'SCUpdateWaterBuilding':
        clearTasks(['equipmentCollect', 'equipmentCraft', 'petCollect', 'petBreed', 'museumCollect', 'museumExplore']);
        break;
      case 'SCMuseumPopularityChanged': clearTasks(['museumCollect', 'museumExplore', 'museumAchievements']); break;
      case 'SCMuseumRevenueUpdate': clearTask('museumRevenue'); break;
      case 'SCTradeGuildTask': clearTask('tradeTasks'); break;
      case 'SCNewGuildWelfarePack': clearTask('guildWelfare'); break;
      case 'SCOrderOfTheDay': clearTask('orderDaily'); break;
      case 'SCActivityActiveScoreUpdate': clearTask('festivalActive'); break;
      case 'SCNewCampaignReport': clearTask('campaignReports'); break;
      case 'SCOpenRankRedDot': clearTask('openRankRewards'); break;
      case 'SCAllActivity':
        clearTasks(['festivalSign', 'festivalActive', 'festivalGifts', 'snowballFree', 'compassSpin']);
        clearTask('weekGift');
        clearTask('weekTimes');
        clearTask('weekPass');
        clearTask('newbieLogin');
        break;
      case 'SCNewbieActivityUpdate': clearTask('newbieLogin'); break;
      case 'SCTrialRaidUpdate':
        schedule.clear('trialSweep');
        if (body?.raid?.raidId) schedule.clear('trialSweep:' + body.raid.raidId);
        break;
      case 'SCVipUpdate':
        clearTask('pirate');
      case 'SCActivityPaidMoneyUpdate':
        clearTask('adShop');
        break;
    }
  });
  schedules.set(client, schedule);
  return schedule;
}
