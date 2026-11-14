// 截图对照新增模块：默认只提供配置，不替用户开启资源消费。
export const siliconFleetDefaults = id => ({ id, enabled: false, tier: 'ORANGE', emptyOnly: true,
  opponentOrder: 'powerDesc', maxPowerRatio: 100, failureLimit: 1, dailyAttackLimit: 30,
  pursuit: false, safePlayers: [], safeGuilds: [], autoRepair: false, repairSpeedUp: false,
  marchSpeedUp: false, marchTargetSeconds: 60, minDurabilityPercent: 1, maxRepairCost: 0 });
export const EXTENDED_DEFAULTS = {
  alliance: { enabled: false, recruit: false, recruitDailyLimit: 0, recruitProduction: false,
    mutual: false, mutualMode: 'custom', autoHelp: false, autoAsk: false, allowedMaterials: [], blockedMaterials: [],
    requestMaterials: [], memberKeywords: [], stockReserve: 0, helpDailyLimit: 20,
    collectGifts: false, autoTech: false, techIds: [], techDailyLimit: 20 },
  guildShip: { enabled: false, crew: false, captain: false, coinFilter: true,
    minCoinsSmall: 15, minCoinsMedium: 45, minCoinsLarge: 60, rewardFilter: false, rewardItems: [],
    disabledMaterials: [], mode: 'redFirst', produceMissing: false, redStartEnabled: false, redStartTime: '20:00' },
  guildFort: { enabled: false, materials: [], reserve: 0, dailyLimit: 0 },
  silicon: { enabled: false, dailyRewardLimit: 0, windows: [], petrolReserve: 10000, dailyPetrolLimit: 0,
    dailyDiamondLimit: 0, pursuitMinutes: 10, fleets: [1, 2, 3].map(id => siliconFleetDefaults(id + '远征船')) },
  heroRaid: { enabled: false, orders: false, rewards: true },
};
const int = (max = 1000000000, min = 0) => ({ kind: 'number', min, max });
const list = (max = 100) => ({ kind: 'list', max });
const choice = (...values) => ({ kind: 'choice', values });
export const EXTENDED_CONSTRAINTS = {
  'alliance.recruitDailyLimit': int(1000), 'alliance.mutualMode': choice('custom', 'exchange'),
  'alliance.allowedMaterials': list(), 'alliance.blockedMaterials': list(), 'alliance.requestMaterials': list(),
  'alliance.memberKeywords': list(30), 'alliance.stockReserve': int(), 'alliance.helpDailyLimit': int(1000),
  'alliance.techIds': list(), 'alliance.techDailyLimit': int(1000),
  'guildShip.minCoinsSmall': int(25), 'guildShip.minCoinsMedium': int(70), 'guildShip.minCoinsLarge': int(100),
  'guildShip.rewardItems': list(), 'guildShip.disabledMaterials': list(),
  'guildShip.mode': choice('redFirst', 'mediumLarge', 'full', 'small', 'mediumSmall'),
  'guildShip.redStartTime': { kind: 'time' }, 'guildFort.materials': list(), 'guildFort.reserve': int(), 'guildFort.dailyLimit': int(),
  'silicon.dailyRewardLimit': int(10000), 'silicon.windows': list(10), 'silicon.petrolReserve': int(),
  'silicon.dailyPetrolLimit': int(), 'silicon.dailyDiamondLimit': int(100000), 'silicon.pursuitMinutes': int(15),
  'silicon.fleets': { kind: 'siliconFleets' },
};
export const SILICON_FLEET_NUMBERS = { maxPowerRatio: int(1000, 1), failureLimit: int(100, 1),
  dailyAttackLimit: int(1000), marchTargetSeconds: int(7200), minDurabilityPercent: int(100, 1), maxRepairCost: int(10000000) };
export function validateSiliconFleets(value, errors, catalog) {
  if (!Array.isArray(value) || value.length !== 3) { errors['silicon.fleets'] = '请保留三支独立舰队配置'; return null; }
  const output = [], ids = new Set();
  for (const [index, item] of value.entries()) {
    const prefix = 'silicon.fleets.' + index, defaults = siliconFleetDefaults((index + 1) + '远征船');
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors[prefix] = '舰队配置必须是对象'; continue; }
    for (const key of Object.keys(item)) if (!Object.hasOwn(defaults, key)) errors[prefix + '.' + key] = '不支持的舰队设置';
    const row = { ...defaults, ...item };
    if (!/^[1-3]远征船$/.test(row.id) || ids.has(row.id)) errors[prefix + '.id'] = '请选择不重复的三支远征舰队';
    if (catalog?.expeditionFleets?.length && row.enabled && !catalog.expeditionFleets.some(v => v.value === row.id)) errors[prefix + '.id'] = '当前游戏配置中不存在此舰队';
    ids.add(row.id);
    for (const [key, initial] of Object.entries(defaults)) if (typeof initial === 'boolean' && typeof row[key] !== 'boolean') errors[prefix + '.' + key] = '开关值必须为 true 或 false';
    for (const [key, rule] of Object.entries(SILICON_FLEET_NUMBERS)) if (!Number.isSafeInteger(row[key]) || row[key] < rule.min || row[key] > rule.max) errors[prefix + '.' + key] = `请输入 ${rule.min}–${rule.max} 之间的整数`;
    if (!['BLUE', 'PURPLE', 'ORANGE'].includes(row.tier)) errors[prefix + '.tier'] = '请选择初等、中等或高等硅矿';
    if (!['powerAsc', 'powerDesc'].includes(row.opponentOrder)) errors[prefix + '.opponentOrder'] = '请选择有效战力顺序';
    for (const key of ['safePlayers', 'safeGuilds']) if (!Array.isArray(row[key]) || row[key].length > 100 || new Set(row[key]).size !== row[key].length || row[key].some(v => typeof v !== 'string' || !v.trim() || v !== v.trim() || v.length > 80 || /[\r\n\u0000-\u001f]/.test(v))) errors[prefix + '.' + key] = '请输入不重复的完整名称，每行一个';
    if (Array.isArray(row.safeGuilds) && row.safeGuilds.some(v => !/^[1-9]\d{0,2}$/.test(v))) errors[prefix + '.safeGuilds'] = '请输入1–999的联盟数字编号，每行一个';
    output.push(structuredClone(row));
  }
  return output;
}
