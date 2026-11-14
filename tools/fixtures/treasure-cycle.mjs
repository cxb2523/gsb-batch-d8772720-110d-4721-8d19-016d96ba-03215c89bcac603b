// 巨轮再派、普通维修与盟友选择的隔离夹具。仅使用虚构数据和当前游戏协议。
import { warForgeFixture } from './war-forge.mjs';
import { treasureSettings } from './treasure-loot.mjs';

export function treasureCycleSettings() {
  const s = treasureSettings(); s.treasure.fleetIds = ['1远征船']; return s;
}

export function treasureCycleFixture() {
  const f = warForgeFixture(), read = f.client.request;
  f.config.tables.ModuleOpenCfg.data.push({ moduleId: '联盟', playerLevel: 16 });
  f.state.targets = [f.state.targets[1]];
  f.state.members = { total: 4, titleList: [
    { guildTitle: 2, members: [
      { playerId: f.player.playerId, nickname: f.player.nickname, online: true, guildTitle: 2 },
      { playerId: '9007199254740995', nickname: '同名盟友', online: true, guildTitle: 2 },
      { playerId: '9007199254740997', nickname: '同名盟友', online: false, guildTitle: 2 },
    ] },
    { guildTitle: 4, members: [{ playerId: '9007199254740999', nickname: '海上的风', online: true, guildTitle: 4 }] },
    { guildTitle: 1, members: [{ playerId: '9007199254741001', nickname: '黑名单成员', guildTitle: 1 }] },
  ] };
  f.omitIdleDefaults = false;
  f.client.request = async (name, body = {}, responseName = name.replace(/Request$/, 'Response')) => {
    if (name !== 'GuildMemberRequest') {
      const reply = await read(name, body, responseName);
      if (name !== 'MyFleetsRequest' || !f.omitIdleDefaults) return reply;
      const fleets = reply.fleets.map(fleet => {
        const wire = { ...fleet };
        if (wire.state === 1) delete wire.state;
        for (const key of ['treasureLootUid', 'curGridIdx', 'durability']) if (wire[key] === 0) delete wire[key];
        return wire;
      });
      return f.protocol.MyFleetsResponse.decode(f.protocol.MyFleetsResponse.encode({ fleets }).finish());
    }
    f.calls.push({ name, body: structuredClone(body) });
    f.protocol.GuildMemberRequest.decode(f.protocol.GuildMemberRequest.encode(body).finish());
    await f.beforeRead?.(name, body);
    return f.protocol.GuildMemberResponse.decode(f.protocol.GuildMemberResponse.encode(f.state.members).finish());
  };
  f.returnFromTreasure = (id, durability = 2000) => Object.assign(f.state.fleets.find(row => row.buildingId === id),
    { state: 1, treasureLootUid: 0, curGridIdx: 0, durability, repairing: null, targetCityId: 0, cityId: 1 });
  return f;
}
