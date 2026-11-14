// 仅供离线检查与隔离界面验证。所有角色、舰队和货轮均为虚构，不连接游戏。
import { EventEmitter } from 'node:events';
import { defaultSettings } from '../../src/automation-settings.mjs';

const table = data => ({ data });
export const treasureConfig = { tables: {
  ModuleOpenCfg: table([{ moduleId: '世界宝藏', playerLevel: 19 }]),
  GameplayOpenCfg: table([{ gameplay: '世界宝藏', openDays: [3, 1] }]),
  WorldParamCfg: table([{ paramName: '进攻宝藏消耗汽油', paramValue: 500 }]),
  TreasureLootParamCfg: table([{ paramName: '每日宝藏奖励次数', paramValue: 3 }]),
  TreasureLootCfg: table([
    { quality: 'BLUE', name: '小型货轮' },
    { quality: 'PURPLE', name: '中型货轮' },
    { quality: 'ORANGE', name: '万吨货轮' },
  ]),
  GuildTitleCfg: table([{ title: 1, treasureLoot: 0 }, { title: 2, treasureLoot: 1 }]),
  BuildingUnlockCfg: table([1, 2, 3].map(n => ({ buildingId: n + '远征船', buildingType: '远征船' }))),
} };

export function treasureSettings() {
  const settings = defaultSettings();
  for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
  Object.assign(settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
  settings.resident.rewards = settings.dailies.enabled = false;
  Object.assign(settings.treasure, { enabled: true, autoJoin: true, fleetIds: ['1远征船', '2远征船'] });
  return settings;
}

export function treasureFixture() {
  const now = Math.floor(Date.now() / 1000);
  const player = { playerId: '9007199254740993', nickname: '验证船长', guildId: '9007199254741007',
    worldId: 1001001, worldOpenTime: now - 30 * 86400, level: 36 };
  const state = {
    guild: { guild: { guildId: player.guildId, name: '验证联盟' }, myTitle: 2 },
    stats: { stats: [{ color: 5, count: 2 }], todayRewardTimes: 0, totalRewardTimes: 0, nextRefreshTime: now + 1800 },
    merge: { worldIds: [], matchMaking: false, executeTs: 0 },
    fuel: 3000,
    buildings: [1, 2, 3].map(n => ({ buildingId: n + '远征船', level: 1, fleet: { formation: { heroPositions: [{ heroId: '兰博', pos: { x: 0, y: 0 } }] } } })),
    fleets: [1, 2, 3].map(n => ({ buildingId: n + '远征船', state: 1, durability: 100, maxDura: 100,
      treasureLootUid: 0, curGridIdx: 0, owner: { playerId: player.playerId, guildId: player.guildId } })),
    targets: [
      { uid: 71, color: 5, ownerGuildIdx: 7, ownerFleetNum: 1, progress: 20, gridIdx: 400,
        reward: { asset: [{ id: '紫芯片宝箱', num: 1 }] } },
      { uid: 72, color: 5, ownerGuildIdx: 0, ownerFleetNum: 0, progress: 5, gridIdx: 500,
        reward: { asset: [{ id: '橙装材料自选包', num: 15 }] } },
    ],
    defenders: { 71: [{ name: '同行者甲', guildIdx: 7, isNpc: false }], 72: [{ name: '守卫', guildIdx: 0, isNpc: true }] },
    ranks: { 71: [{ playerId: '9007199254740995', nickname: '同行者甲', guildIdx: 7 }], 72: [] },
  };
  const protocol = { Color: { BLUE: 3, PURPLE: 4, ORANGE: 5 }, TreasureLootSendFleetsRequest: {} };
  for (const stem of ['TreasureLootStats', 'TreasureLootList', 'MyFleets', 'OnWater', 'AllItem', 'GuildInfo', 'UniteWorldsPlan', 'TreasureLootDefence', 'TreasureLootRank', 'WorldInfo']) {
    protocol[stem + 'Request'] = {}; protocol[stem + 'Response'] = {};
  }
  const client = new EventEmitter();
  client.connected = true; client.reads = []; client.writes = []; client.onRequest = null; client.onSend = null;
  client.request = async (name, body = {}) => {
    client.reads.push({ name, body: structuredClone(body) });
    const override = await client.onRequest?.(name, body);
    if (override !== undefined) return override;
    let response;
    switch (name) {
      case 'TreasureLootStatsRequest': response = state.stats; break;
      case 'TreasureLootListRequest': response = { treasure: state.targets }; break;
      case 'MyFleetsRequest': response = { fleets: state.fleets }; break;
      case 'OnWaterRequest': response = { building: state.buildings }; break;
      case 'AllItemRequest': response = { items: [{ itemId: '汽油', num: state.fuel }] }; break;
      case 'GuildInfoRequest': response = state.guild; break;
      case 'UniteWorldsPlanRequest': response = state.merge; break;
      case 'TreasureLootDefenceRequest': response = { fleets: state.defenders[body.uid] ?? [] }; break;
      case 'TreasureLootRankRequest': response = { items: state.ranks[body.uid] ?? [] }; break;
      case 'WorldInfoRequest': response = { fleets: state.fleets, cities: [], myGuildTitle: 2 }; break;
      default: throw new Error('隔离验证不允许请求：' + name);
    }
    return structuredClone(response);
  };
  client.sendWatch = async (name, body) => {
    if (name !== 'TreasureLootSendFleetsRequest') throw new Error('隔离验证不允许发送：' + name);
    client.writes.push({ name, body: structuredClone(body) });
    if (client.onSend) return client.onSend(name, body);
    for (const id of body.fleetBuildingIds) {
      const fleet = state.fleets.find(row => row.buildingId === id);
      fleet.treasureLootUid = body.uid; fleet.state = 2; state.fuel -= 500;
    }
    return { sent: client.writes.length };
  };
  client.stop = () => { client.connected = false; };
  return { client, protocol, player, state, config: structuredClone(treasureConfig) };
}
