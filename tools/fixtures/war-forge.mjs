// 城战/锻造隔离夹具：虚构账号与状态，所有请求和响应经过当前游戏协议编解码。
import { treasureFixture } from './treasure-loot.mjs';
import { loadProtocol } from '../../src/proto.mjs';
import { defaultSettings } from '../../src/automation-settings.mjs';
const protocol = loadProtocol();
const table = data => ({ data });
let playerSequence = 9007199254800000n;

export function warForgeSettings() {
  const s = defaultSettings();
  for (const key of Object.keys(s.schedule)) s.schedule[key] = false;
  Object.assign(s.loop, { world: false, tasks: false, dailies: false, heroes: false });
  s.resident.rewards = s.dailies.enabled = false;
  Object.assign(s.cityWar, { enabled: true, fleetIds: ['1远征船', '2远征船'], dailyPetrolLimit: 20000, dailyDispatchLimit: 10 });
  Object.assign(s.forge, { enabled: true, buildingIds: ['1装备厂'], recipeIds: ['1001'] });
  return s;
}

export function warForgeFixture() {
  const f = treasureFixture(), now = Math.floor(Date.now() / 1000), read = f.client.request;
  f.protocol = protocol;
  f.player = protocol.LoginResponse.decode(protocol.LoginResponse.encode({ playerInfo: { ...f.player, playerId: String(++playerSequence), vip: { vipLevel: 3 }, forgeLevel: 1, scenarioId: 1 } }).finish()).playerInfo;
  for (const fleet of f.state.fleets) fleet.owner.playerId = f.player.playerId;
  f.config.materialName = id => id;
  f.config.tables.ModuleOpenCfg.data.push({ moduleId: '世界', playerLevel: 16 });
  f.config.tables.GameplayOpenCfg.data.push({ gameplay: '国战', openDays: [2, 1] });
  f.config.tables.WorldParamCfg.data.push({ paramName: '攻城战消耗耐久', paramValue: 100 });
  f.config.tables.VipLevelCfg = table([{ level: 1, effects: [] }, { level: 3, effects: [['每日城战委任次数', 4]] }, { level: 4, effects: [['每日城战委任次数', 6]] }]);
  f.config.tables['1_CityCfg'] = table([{ id: 1, name: '主城', guildIndex: 7 }, { id: 2, name: '目标甲', guildIndex: 0 }, { id: 3, name: '目标乙', guildIndex: 0 }]);
  f.config.tables['1_AttackCityConsumeCfg'] = table([{ dist: 1, cost: 0.4 }, { dist: 6000, cost: 0.5 }]);
  f.config.tables.BuildingUnlockCfg.data.push({ buildingId: '1装备厂', buildingType: '装备厂', playerLevel: 17 });
  f.config.tables.BuildingEquipMakeCfg = table([
    { makeId: 1001, type: '武器', season: 1, seconds: 1800, libId: 1001, costItem: [['蓝武器材料', 40], ['GOLD', 2000]] },
    { makeId: 1002, type: '武器', season: 2, seconds: 7200, libId: 1002, costItem: [['紫武器材料', 160], ['GOLD', 10000]] },
  ]);
  f.config.tables.ItemCfg = table([{ id: '蓝武器材料', quality: 'BLUE' }, { id: '紫武器材料', quality: 'PURPLE' }, { id: '蓝装材料自选包', quality: 'BLUE' }]);
  f.state.war = { startTime: now - 60, endTime: now + 3600, declarations: [{ attackGuildIdx: 7, defenceGuildIdx: 8, cityId: 2 }], assembleCityId: 2 };
  f.state.cities = [{ id: 1, state: 1, guildIdx: 7 }, { id: 2, state: 2, guildIdx: 8 }, { id: 3, state: 2, guildIdx: 8 }];
  f.state.fuel = 50000; f.state.gold = 100000;
  f.state.materials = { 蓝武器材料: 400, 紫武器材料: 400, 蓝装材料自选包: 100 };
  f.state.equipment = [{ uid: '9007199254742993', equipId: '旧装备', star: 1, level: 0 }];
  f.state.factory = { buildingId: '1装备厂', level: 1, auto: false };
  f.state.buildings.push(f.state.factory);
  f.state.repair = { unitRepairCost: 2, unitRepairTime: 0.15 };
  for (const fleet of f.state.fleets) Object.assign(fleet, { cityId: 1, durability: 2000, maxDura: 2000, autoFight: { isOn: true, todayTimes: 4 } });
  f.map = { width: 10, height: 10, tileWidth: 100, tileHeight: 75, cityInfo: { 1: { gridIdx: 0 }, 2: { gridIdx: 1 }, 3: { gridIdx: 10 } } };
  f.mapLoader = async () => f.map;
  f.beforeRead = null; f.beforeSend = null; f.unknown = false; f.reject = false; f.claimStale = false; f.omitClaimReply = false; f.calls = [];
  f.client.request = async (name, body = {}, responseName = name.replace(/Request$/, 'Response')) => {
    f.calls.push({ name, body: structuredClone(body) });
    if (protocol[name]) protocol[name].decode(protocol[name].encode(body).finish());
    await f.beforeRead?.(name, body);
    let value;
    switch (name) {
      case 'PickMadeEquipRequest': {
        f.client.writes.push({ name, body: structuredClone(body) });
        await f.beforeSend?.(name, body);
        if (f.reject) throw Object.assign(new Error('模拟服务端明确拒绝领取'), { prompt: { prompt: 1 }, request: name });
        if (f.unknown) { value = {}; break; }
        const making = f.state.factory.equipMaking;
        if (!making || making.finishTime >= nowOf()) throw Object.assign(new Error('模拟锻造尚未完成'), { prompt: { prompt: 1 }, request: name });
        value = { equipId: making.equipId || '测试武器' };
        if (!f.claimStale) f.deliverForge();
        if (f.omitClaimReply) value = {};
        break;
      }
      case 'WarDeclarationRequest': value = f.state.war; break;
      case 'WorldInfoRequest': value = { cities: f.state.cities, fleets: f.state.fleets, myGuildTitle: 2 }; break;
      case 'FleetRepairParamRequest': value = f.state.repair; break;
      case 'AllResourceRequest': value = { list: [{ res: 3, amount: f.state.gold }, { res: 4, amount: 1000 }] }; break;
      case 'AllItemRequest': value = { items: [{ itemId: '汽油', num: f.state.fuel }, ...Object.entries(f.state.materials).map(([itemId, num]) => ({ itemId, num }))] }; break;
      case 'EquipsRequest': value = { equip: f.state.equipment }; break;
      case 'WeekInfoRequest': case 'MyResFieldsRequest': case 'DailyTaskInfoRequest': case 'MainTaskInfoRequest': case 'AchievementInfoRequest': case 'EmailBoxRequest': case 'AfkInfoRequest': case 'MonthCardRequest': value = {}; break;
      case 'AllHeroRequest': value = { heroes: [] }; break;
      default: value = await read(name, body);
    }
    if (name === 'TreasureLootRankRequest') value.items = value.items.map(row => ({ power: 100, progress: 1, estProgress: 1, rank: 1, avatar: {}, rewardTimes: 0, ...row }));
    if (name === 'TreasureLootListRequest') for (const target of value.treasure) target.reward.asset = target.reward.asset.map(row => ({ type: 1, ...row }));
    const type = protocol[responseName];
    if (!type) throw new Error('夹具缺少响应协议：' + responseName);
    return type.decode(type.encode(value).finish());
  };
  const nowOf = () => Math.floor((Date.now() + (f.client.serverClockOffsetMs || 0)) / 1000);
  f.client.sendWatch = async (name, body) => {
    protocol[name].decode(protocol[name].encode(body).finish());
    f.client.writes.push({ name, body: structuredClone(body) });
    await f.beforeSend?.(name, body);
    if (f.reject) throw Object.assign(new Error('模拟服务端明确拒绝'), { prompt: { prompt: 1 }, request: name });
    if (f.unknown) return;
    if (name === 'SetFleetAutoFightRequest') {
      if (!f.ignoreNativeOff) for (const id of body.buildingIds) {
        const fleet = f.state.fleets.find(row => row.buildingId === id);
        if (fleet) fleet.autoFight = { ...(fleet.autoFight ?? { todayTimes: 0 }), isOn: body.isOn };
      }
    } else if (name === 'MoveFleetsToCityRequest') {
      for (const id of body.buildingId) Object.assign(f.state.fleets.find(row => row.buildingId === id), { state: 2, targetCityId: body.cityId, moveStartTs: nowOf(), moveEndTs: nowOf() + 30 });
      f.state.fuel -= 40 * body.buildingId.length;
    } else if (name === 'RepairFleetRequest') {
      const fleet = f.state.fleets.find(row => row.buildingId === body.buildingId);
      f.state.fuel -= Math.ceil((fleet.maxDura - fleet.durability) * f.state.repair.unitRepairCost);
      Object.assign(fleet, { state: 4, repairing: { startTs: nowOf(), endTs: nowOf() + 10 } });
    } else if (name === 'MakeEquipRequest') {
      const recipe = f.config.tables.BuildingEquipMakeCfg.data.find(row => row.makeId === body.makeId), [material, gold] = recipe.costItem;
      const normal = Math.min(f.state.materials[material[0]] ?? 0, material[1]);
      f.state.materials[material[0]] = (f.state.materials[material[0]] ?? 0) - normal;
      if (body.universal) f.state.materials.蓝装材料自选包 -= material[1] - normal;
      f.state.gold -= gold[1];
      f.state.factory.equipMaking = { makeId: body.makeId, finishTime: nowOf() + 10, equipId: '测试武器', star: 2 };
    } else if (name === 'TreasureLootSendFleetsRequest') {
      for (const id of body.fleetBuildingIds) Object.assign(f.state.fleets.find(row => row.buildingId === id), { state: 2, treasureLootUid: body.uid });
      f.state.fuel -= 500 * body.fleetBuildingIds.length;
    } else throw new Error('夹具禁止未声明的写入：' + name);
  };
  f.client.snapshot = () => ({ state: 'READY', connected: f.client.connected });
  f.finishRepair = id => { const fleet = f.state.fleets.find(row => row.buildingId === id); fleet.state = 1; fleet.durability = fleet.maxDura; fleet.repairing = null; };
  f.returnFleet = id => { const fleet = f.state.fleets.find(row => row.buildingId === id); fleet.state = 1; fleet.cityId = 1; fleet.targetCityId = 0; fleet.durability -= 100; };
  f.finishForge = () => {
    f.client.serverClockOffsetMs = (f.client.serverClockOffsetMs || 0) + 15000;
  };
  f.deliverForge = () => {
    if (!f.client.writes.some(row => row.name === 'PickMadeEquipRequest')) throw new Error('夹具必须先收到领取请求，不能直接生成产出');
    const making = f.state.factory.equipMaking;
    if (!making) throw new Error('夹具没有待领取批次');
    f.state.equipment.push({ uid: String(9007199254743000n + BigInt(f.state.equipment.length)), equipId: making.equipId || '测试武器', star: making.star, level: 0 });
    f.state.factory.equipMaking = null;
  };
  // 控制台HTTP/UI使用真实场景1配置时，该场景不存在联盟7；改用配置中实际存在的联盟1。
  f.alignScenarioOne = () => {
    const guildId = '9007199254741001';
    f.player = protocol.PlayerInfo.decode(protocol.PlayerInfo.encode({ ...f.player, guildId }).finish());
    f.state.guild.guild.guildId = guildId;
    f.state.fleets.forEach(fleet => { fleet.owner.guildId = guildId; });
    f.state.war.declarations = [{ attackGuildIdx: 1, defenceGuildIdx: 2, cityId: 2 }];
    f.state.cities[0].guildIdx = 1; f.state.cities[1].guildIdx = 2;
    f.config.tables['1_CityCfg'].data[0].guildIndex = 1;
  };
  return f;
}
