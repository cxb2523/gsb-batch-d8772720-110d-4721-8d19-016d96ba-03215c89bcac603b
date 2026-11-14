// 根据功能名和请求类型分类，不改动原始日志正文、错误详情与清空水位。
export const LOG_CATEGORIES = { radar:'联盟情报',pirate:'海盗首杀与扫荡',boss:'世界Boss',merchant:'海商王',forge:'装备锻造',fleet:'舰队与维修',codes:'礼包兑换',orders:'周订单',gather:'采集与打捞',system: '系统与连接', idle: '挂机', building: '建设', production: '生产', events: '基地事件',
  base: '基础养成', treasure: '万吨巨轮', alliance: '联盟/城战', heroes: '英雄', daily: '日常领奖', activity: '活动', trials: '试炼', stages: '主线推关' };
export const LOG_GROUPS = {
  '系统':['system','idle','codes'],
  '基地与资源':['building','production','gather','forge','events','base','orders'],
  '世界与联盟':['treasure','radar','pirate','boss','fleet','alliance'],
  '日常与活动':['heroes','daily','activity','merchant','trials','stages']
};
export function classifyLog(message, extra = {}) {
  if (String(message).startsWith('联盟互助')) return 'alliance';
  const text = String(extra?.request ?? '') + ' ' + String(message);
  if (/海商王|走商|商会币|商船从港口|Trade(?:Move|Buy|Sell)/.test(text)) return 'merchant';
  if (/联盟情报|雷达|Radar/.test(text)) return 'radar';
  if (/海盗|Pirate/.test(text)) return 'pirate';
  if (/世界[Bb]oss|WorldBoss/.test(text)) return 'boss';
  if (/锻造|MakeEquip/.test(text)) return 'forge';
  if (/战后维修|普通维修|舰队调度/.test(text)) return 'fleet';
  if (/礼包码|礼包兑换|GiftCode/.test(text)) return 'codes';
  if (/周订单|WeekOrder/.test(text)) return 'orders';
  if (/钓鱼|潜水|拾荒|打捞|漂浮物/.test(text)) return 'gather';
  if (/万吨|巨轮|TreasureLoot/.test(text)) return 'treasure';
  if (/城战|联盟|Guild|WorldOnline|MoveFleetsToCity/.test(text)) return 'alliance';
  if (/试炼|TrialRaid/.test(text)) return 'trials';
  if (/主线推关|ChallengeStage|主线.*(胜利|战败)/.test(text)) return 'stages';
  if (/英雄|Hero|装备穿戴|强化石/.test(text)) return 'heroes';
  if (/博物馆|海兽|藏品|点金|Museum|PetBreed|Antique/.test(text)) return 'base';
  if (/工厂|排产|播种|农田|锻造|采集|钓鱼|潜水|拾荒|收取.*成品|MakeEquip/.test(text)) return 'production';
  if (/居民|贸易港|随机事件|事件.*选择|Refugee|Merchant/.test(text)) return 'events';
  if (/建筑|建造|竣工|蓝图|升级.*厂/.test(text)) return 'building';
  if (/走江|罗盘|军备|海上风采|战令|酆都|活动|周抽奖|周战令|驱邪|法旨|罗盘|酆都|剿匪榜|杀敌榜|积分赛|世界Boss|WorldBoss|礼包.*周|Linkage/.test(text)) return 'activity';
  if (/领奖|领取|邮件|任务|宝箱|免费|赠礼|Reward/.test(text)) return 'daily';
  if (/挂机|自动项目/.test(text)) return 'idle';
  return 'system';
}
