// Persist only overrides in each account. Older accounts have no automatic
// schedule until they start one; new captured accounts use the defaults.
// 只限制钓具强化的金币支出，其他挂机任务不使用此预算。
export const defaultFishingGoldReserve = 10_000;
export const defaultCompassSpinCount = 10;
export const maxCompassSpinCount = 999;

export const automationTasks = [
  ['armsRaceRewards', '军备竞赛达标奖励与免费补给', '周期活动', true],
  ['riverScore', '走江踏浪积分奖励', '限时活动', true],
  ['riverPass', '走江战令已达成奖励', '限时活动', true],
  ['riverHelp', '走江助力免费及免广告礼包', '限时活动', true],
  ['edictPass', '酆都法旨战令已达成奖励', '限时活动', true],
  ['compassDaily', '龙王罗盘每日免费礼包', '限时活动', true],
  ['compassAdGift', '龙王罗盘每日广告礼包', '限时活动', false],
  ['compassSpin', '龙王罗盘自动抽取', '限时活动', false],
  ['merchantTrade', '海商王自动买入、走商与卖出', '周期活动', false],
  ['merchantRewards', '海商王战令、联盟任务与利润礼包', '周期活动', true],
  ['beautyVotes', '风采大赛每日投给最高票选手', '限时活动', false],
  ['beautyGift', '风采大赛每日投票礼包', '限时活动', true],
  ['diveEnhance', '潜水船坞强化与升级', '船只', false],
  ['autoDive', '潜水打捞原料', '船只', false],
  ['salvageEnhance', '拾荒船强化与升级', '船只', false],
  ['autoSalvage', '拾荒船自动拾荒', '船只', false],
  ['cargo', '贸易港交货与收货', '海面', true],
  ['farm', '农田种植与收获', '海面', true],
  ['guildWelfare', '领取联盟福利礼包', '联盟', false],
  ['guildTitleReward', '联盟每日职级礼包', '联盟', true],
  ['worldOnline', '世界在线奖励', '联盟', true],
  ['tradeTasks', '海商王联盟任务', '周期活动', true],
  ['guildAidCollect', '联盟互助收取', '联盟', true],
  ['seasonTasks', '赛季任务奖励', '周期活动', true],
  ['seasonChest', '赛季宝箱用钥匙开启（每轮最多 5 箱）', '周期活动', false],
  ['crossRankDaily', '跨服排行每日奖励', '周期活动', true],
  ['worldBossDamage', '世界 Boss 伤害奖励', '挑战', true],
  ['passStageRewards', '闯关基金奖励', '领奖', true],
  ['museumRevenue', '博物馆营收', '博物馆', true],
  ['museumAchievements', '博物馆人气成就', '博物馆', true],
  ['guildAidHelp', '响应联盟互助', '联盟', false],
  ['treasureLoot', '万吨巨轮派遣', '世界', false],
  ['heroGrowth', '主线英雄自动养成', '英雄', false],
  ['stageAuto', '主线自动推图', '挑战', false],
  ['guildOrders', '联盟订单自动执行', '联盟', false],
  ['radarAuto', '联盟情报自动派遣', '联盟', false],
  ['radarRepair', '联盟情报舰队维修', '联盟', false],
  ['equipmentCollect', '装备制造自动领取', '英雄', false],
  ['equipmentCraft', '装备制造自动续产', '英雄', false],
  ['museumCollect', '博物馆探险自动领取', '藏品', false],
  ['museumExplore', '博物馆自动派遣', '藏品', false],
  ['petCollect', '海兽成熟自动领取', '藏品', false],
  ['petBreed', '海兽自动培育', '藏品', false],
  ['worldOnlineRewards', '领取城战在线奖励', '联盟', false],
  ['weekHeroStar', '升星达标奖励', '周期活动', true],
  ['festivalSign', '酆都诡事每日签到（不补签）', '限时活动', true],
  ['festivalFreeGift', '酆都诡事每日免费特惠', '限时活动', false],
  ['festivalActive', '联动活动活跃档位奖励', '限时活动', true],
  ['festivalGifts', '联动活动每日免费礼包', '限时活动', true],
  ['snowballFree', '走江踏浪免费礼包与通行证奖励', '限时活动', true],
  ['weekLotterySpin', '周抽奖使用周转盘币（每轮最多 10 次）', '周期活动', false],
  ['weekCharge', '累计充值已达标奖励', '周期活动', true],
  ['weekChipFree', '芯片活动免费礼包', '周期活动', true],
  ['weekUniqueFree', '周翻牌免费礼包', '周期活动', true],
  ['weekOrderFinal', '周订单最终奖励', '周期活动', true],
  ['weekOrderSubmit', '周订单材料齐后提交', '周期活动', false],
  ['vipDaily', 'VIP 每日免费奖励', '领奖', true],
  ['campaignReports', '战报奖励（海盗战斗等）', '领奖', true],
  ['openRankRewards', '开服冲榜积分奖励', '领奖', true],
  ['pirateRankRewards', '剿匪榜达标奖励', '限时活动', true],
  ['warRankRewards', '杀敌榜达标奖励', '限时活动', true],
  ['festivalActiveRewards', '酆都诡事签到活跃奖励', '限时活动', true],
  ['worldBossRewards', '世界Boss伤害达标奖励', '挑战', true],
  ['battleReportRewards', '邮件战报一键领取', '领奖', true],
  ['weekSupplyFree', '周活动补给免费礼包', '周期活动', true],
  ['leagueCollect', '积分赛累计收集', '挑战', true],
  ['leaguePassRewards', '积分赛战令奖励', '挑战', true],
  ['limitedFreeGifts', '商城限购免费礼包', '领奖', true],
  ['vipDailyGift', 'VIP每日免费礼包', '领奖', true],
  ['heroAdRecruit', '英雄免广告招募（按今日剩余次数）', '招募', false],
  ['antiqueAdRecruit', '藏品免广告招募（按今日剩余次数）', '招募', false],
  ['weekTimes', '周抽奖次数奖励', '周期活动', true],
  ['evilExpel', '驱邪除祟与累计奖励', '限时活动', false],
  ['edict', '酆都法旨自动解符（每轮最多使用 1 份贡品）', '限时活动', false],
  ['compassReward', '龙王罗盘已达标积分奖励', '限时活动', false],
  ['floaters', '海面原料漂浮物拾取', '海面', true],
  ['antiqueFloaters', '海面藏品宝箱打捞', '海面', false],
  ['fishBook', '钓鱼图鉴奖励', '领奖', true],
  ['comicDrama', '漫剧观看与每日奖励', '领奖', true],
  ['tournamentDailyGift', '擂台赛每日礼包', '挑战', true],
  ['autoFish', '自动钓鱼（钓具 2 级，每轮一竿）', '钓鱼', false],
  ['fishEnhance', '钓具强化与升级（每轮一次）', '钓鱼', false],
  ['freeAntiqueRecruit', '藏品免费招募', '藏品', false],
  ['antiqueRecruitRewards', '藏品累计招募档位领奖', '藏品', false],
  ['newbieLogin', '新手七日登录奖励', '限时活动', true],
  ['weekPass', '勇士战令任务与档位奖励', '周期活动', false],
  ['weekGift', '幸运转盘免费好运券礼包', '周期活动', false],
  ['tasks', '任务与成就奖励', '领奖', true],
  ['dailyRewards', '每日任务奖励', '领奖', true],
  ['chests', '活跃宝箱', '领奖', true],
  ['gift', '每日免费赠礼', '领奖', true],
  ['adShop', '广告商店资源', '领奖', false],
  ['mail', '邮件附件', '领奖', true],
  ['afk', '闯关挂机收益（满额领取）', '领奖', true],
  ['afkAd', '闯关挂机广告收益', '领奖', false],
  ['freeRecruit', '英雄免费招募', '日常', true],
  ['heroRecruitRewards', '英雄累计招募档位领奖', '招募', true],
  ['freeGold', '免费点金', '日常', true],
  ['ticketRecruit', '英雄招募券单抽', '日常', false],
  ['arena', '竞技场挑战', '日常', false],
  ['trialSweep', '试炼每日首轮免费扫荡', '挑战', true],
  ['trialPaidSweep', '试炼钻石扫荡', '挑战', false],
  ['trialAdSweep', '试炼免广告扫荡', '挑战', false],
  ['pirate', '海盗日常扫荡', '日常', false],
  ['paidGold', '钻石点金', '日常', false],
  ['shop', '折扣店购买', '日常', false],
  ['collect', '收取产物', '海面', true],
  ['finishUpgrade', '建筑竣工', '海面', true],
  ['build', '空位建造', '海面', true],
  ['buildSupply', '为待建建筑补产材料', '海面', false],
  ['finishOrder', '交居民订单', '海面', true],
  ['startProduce', '工厂排产', '海面', true],
  ['weekFactory', '周订单工厂建设', '海面', true],
  ['upgrade', '余料升级建筑', '海面', false],
  ['speedUp', '使用加速器', '海面', false],
  ['adSpeedUpProduce', '工厂生产广告加速', '海面', false],
  ['adSpeedUpBuilding', '建筑升级广告加速', '海面', false],
  ['adSpeedUpMuseum', '博物馆展柜广告加速', '海面', false],
  ['denyOrder', '拒单重刷', '海面', false],
].map(([key, label, group, initial]) => ({ key, label, group, initial }));

export function taskSettings(saved = {}) {
  return Object.fromEntries(automationTasks.map(({ key, initial }) =>
    [key, typeof saved?.[key] === 'boolean' ? saved[key] : initial]));
}

export function worldTaskKey(kind) {
  if (kind === 'gainFactory' || kind === 'collectProduct') return 'collect';
  if (kind === 'speedUpUpgrade' || kind === 'speedUpProduce') return 'speedUp';
  return kind;
}

export function dailyTaskKey(id, action) {
  switch (id) {
    case 1002: return action.body.way === 1 ? 'freeRecruit' : 'ticketRecruit';
    case 1005: return 'arena';
    case 1006: return action.body.free ? 'freeGold' : 'paidGold';
    case 1007: return 'shop';
    case 1010: return 'pirate';
    default: return null;
  }
}
