// 虚构账号；所有读写都使用本机真实 protobuf 编解码，不建立游戏连接。
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../../src/proto.mjs';
import { defaultSettings } from '../../src/automation-settings.mjs';
const protocol = loadProtocol(), table = data => ({ data });
let nextPlayer = 9007199254840000n;
export function siliconSettings() {
  const settings = defaultSettings();
  settings.silicon.enabled = true; settings.silicon.petrolReserve = 0;
  settings.silicon.fleets[0].enabled = true; return settings;
}
export function siliconFixture() {
  const now = Math.floor(Date.now() / 1000), playerId = String(++nextPlayer);
  const player = protocol.LoginResponse.decode(protocol.LoginResponse.encode({ playerInfo: { playerId, nickname: '硅矿测试船长', guildId: '9007199254741007', worldId: 3001001, worldOpenTime: now - 86400 * 10, level: 36 } }).finish()).playerInfo;
  const state = { fuel: 50000, ruby: 5000, fightTimes: 0, maxFightTimes: 30,
    reward: { myRewardTimes: 0, maxRewardTimes: 100, rewardResetTime: now + 86400 },
    mines: [3, 4, 5].map(color => ({ gridId: color * 1000, color, occupiedNum: 0, positionNum: color === 3 ? 999 : 3 })),
    positions: { 3000: [], 4000: [], 5000: [] }, blacklist: [], reports: [], reportDetails: {},
    merge: { worldIds: [], executeTs: 0, matchMaking: false },
    buildings: [1, 2, 3].map(n => ({ buildingId: n + '远征船', level: 1, fleet: { formation: { heroPositions: [{ heroId: '兰博', pos: { x: 0, y: 0 } }] } } })),
    fleets: [1, 2, 3].map(n => ({ buildingId: n + '远征船', state: 1, durability: 2000, maxDura: 2000, power: 1000, curGridIdx: 0, targetGridIdx: 0, treasureLootUid: 0, owner: { playerId, guildId: player.guildId } })),
    repair: { unitRepairCost: 2, unitRepairTime: 1 } };
  const config = { tables: { ModuleOpenCfg: table([{ moduleId: '世界', playerLevel: 16 }]), GameplayOpenCfg: table([{ gameplay: '芯片', openDays: [0, 0, 1, 1] }]),
    ChipMineCfg: table([['BLUE', 3, '初等硅矿'], ['PURPLE', 4, '中等硅矿'], ['ORANGE', 5, '高等硅矿']].map(([quality, qualityIndex, name]) => ({ quality, qualityIndex, name }))),
    WorldParamCfg: table([{ paramName: '采集硅矿消耗汽油', paramValue: 500 }, { paramName: '行军加速消耗', paramValue: 30 }]),
    SpeedUpRubyCfg: table([{ minute: 0, fleet: 10 }, { minute: 60, fleet: 11 }, { minute: 240, fleet: 20 }]) } };
  const client = new EventEmitter(); client.connected = true; client.reads = []; client.writes = []; client.serverClockOffsetMs = 0;
  const f = { player, protocol, state, config, client, unknown: false, reject: false, occupyImmediately: false, beforeRead: null, afterWrite: null };
  const time = () => Math.floor((Date.now() + client.serverClockOffsetMs) / 1000);
  client.request = async (name, body = {}, reply = name.replace(/Request$/, 'Response')) => {
    if (!protocol[name] || !protocol[reply]) throw Error('真实协议中不存在：' + name + '/' + reply);
    protocol[name].decode(protocol[name].encode(body).finish()); client.reads.push({ name, body: structuredClone(body) });
    const override = await f.beforeRead?.(name, body); if (override !== undefined) return override;
    let result;
    switch (name) {
      case 'ChipMineListRequest': result = { chipMines: state.mines.map(mine => ({ ...mine, occupiedNum: state.positions[mine.gridId].length })) }; break;
      case 'ChipMineRewardRequest': result = { rewardInfo: state.reward }; break;
      case 'ChipMineRequest': { const mine = state.mines.find(row => row.gridId === body.gridId); result = { occupiedNum: state.positions[mine.gridId].length, positionNum: mine.positionNum, occupiedPositions: state.positions[mine.gridId], rewardInfo: state.reward, fightTimes: state.fightTimes, maxFightTimes: state.maxFightTimes }; break; }
      case 'MyFleetsRequest': result = { fleets: state.fleets }; break;
      case 'OnWaterRequest': result = { building: state.buildings }; break;
      case 'AllItemRequest': result = { items: [{ itemId: '汽油', num: state.fuel }] }; break;
      case 'AllResourceRequest': result = { list: [{ res: 4, amount: state.ruby }] }; break;
      case 'UniteWorldsPlanRequest': result = state.merge; break;
      case 'FleetRepairParamRequest': result = state.repair; break;
      case 'BlackListRequest': result = { list: state.blacklist }; break;
      case 'CampaignReportsRequest': result = { reports: body.pageNo === 0 ? state.reports : [], total: state.reports.length }; break;
      case 'CampaignReportDetailRequest': result = state.reportDetails[String(body.campaignId.low >>> 0)] ?? { battles: [] }; break;
      default: throw Error('隔离硅矿夹具禁止未声明读取：' + name);
    }
    return protocol[reply].decode(protocol[reply].encode(result).finish());
  };
  client.sendWatch = async (name, body) => {
    protocol[name].decode(protocol[name].encode(body).finish()); client.writes.push({ name, body: structuredClone(body) });
    if (f.reject) throw Object.assign(Error('模拟明确拒绝'), { prompt: {}, request: name });
    if (f.unknown) return;
    const fleet = state.fleets.find(row => row.buildingId === (body.fleetId ?? body.buildingId));
    if (name === 'ChipMineSendFleetRequest') {
      if (state.positions[body.gridId].some(row => row.index === body.index && row.player)) state.fightTimes++;
      Object.assign(fleet, { state: 2, targetGridIdx: body.gridId, moveStartTs: time(), moveEndTs: time() + 600 }); state.fuel -= 500;
      if (f.occupyImmediately) f.occupy(body.fleetId, body.gridId, body.index);
    } else if (name === 'ChipMineRetreatRequest') f.returnFleet(body.fleetId);
    else if (name === 'RepairFleetRequest') { state.fuel -= (fleet.maxDura - fleet.durability) * state.repair.unitRepairCost; Object.assign(fleet, { state: 4, repairing: { startTs: time(), endTs: time() + (fleet.maxDura - fleet.durability) * state.repair.unitRepairTime, endDura: fleet.maxDura } }); }
    else if (name === 'SpeedUpRepairRequest') { state.ruby -= 100; fleet.durability = fleet.maxDura; fleet.state = 1; fleet.repairing = null; }
    else if (name === 'SpeedUpFleetRequest') { state.ruby -= 30; fleet.moveEndTs = time() + Math.floor((fleet.moveEndTs - time()) / 2); }
    else throw Error('隔离硅矿夹具禁止未声明写入：' + name);
    await f.afterWrite?.(name, body);
  };
  f.occupy = (id, gridId = 5000, index = 0, rewardTimes = 0) => {
    const fleet = state.fleets.find(row => row.buildingId === id); Object.assign(fleet, { state: 5, curGridIdx: gridId, targetGridIdx: 0, chipWar: { rewardTs: time() + 900 } });
    state.positions[gridId] = state.positions[gridId].filter(row => row.index !== index); state.positions[gridId].push({ index, player: { nickname: player.nickname, avatar: {}, guildIdx: 7, fleetId: id, power: fleet.power, rewardTimes } });
  };
  f.returnFleet = id => { Object.assign(state.fleets.find(row => row.buildingId === id), { state: 1, curGridIdx: 0, targetGridIdx: 0, chipWar: null, repairing: null }); for (const grid of Object.keys(state.positions)) state.positions[grid] = state.positions[grid].filter(row => row.player?.fleetId !== id); };
  f.enemy = (index, nickname = '敌方船长', power = 900, guildIdx = 8, gridId = 5000) => state.positions[gridId].push({ index, player: { nickname, avatar: {}, guildIdx, power, rewardTimes: 1 } });
  return f;
}
