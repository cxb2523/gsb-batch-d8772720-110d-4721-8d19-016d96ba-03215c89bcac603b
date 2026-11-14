import { GameClient } from './client.mjs';
import { toNumber } from './client.mjs';
import { worldName } from './world-name.mjs';

// The gateway is not world-scoped: one socket serves the whole account, and the world
// is chosen by LoginRequest.worldId (0 means "wherever this account last was"). So both
// listing worlds and entering one happen on the same kind of connection.
export const CURRENT_WORLD = 0;

// protobufjs hands back int64 as { low, high, unsigned } with no Long library installed.
// Collapse those back to numbers so the output is readable and JSON-safe.
export function normalize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object') return value;
  if (typeof value.low === 'number' && typeof value.high === 'number') return toNumber(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = normalize(item);
  return out;
}

// AccountRoleInfo (world list) and PlayerInfo (login) carry the same identity fields
// under different names, so accept either.
export function describeRole(info) {
  if (!info) return null;
  const role = normalize(info);
  return {
    id: role.id ?? role.playerId,
    nickname: role.nickname,
    level: role.level,
    power: role.power,
    appId: role.appId,
    channelId: role.channelId,
    worldId: role.worldId,
    worldName: worldName(role.worldId),
    bornWorldId: role.bornWorldId,
    bornWorldName: worldName(role.bornWorldId),
    roleCreateTime: role.roleCreateTime,
    lastLoginTime: role.lastLoginTime,
    ...(role.newRole === undefined ? {} : { newRole: role.newRole }),
  };
}

// GameWorldInfo.worldId is the key the server-select screen uses, which is the world the
// role was *born* in. roleInfo.worldId is where the role actually lives now — after a
// world merge the two differ, and the server resolves the requested key to the successor.
export function describeWorld(world) {
  const value = normalize(world);
  return { worldId: value.worldId, worldName: worldName(value.worldId), tag: value.tag, role: describeRole(value.roleInfo) };
}

// Pure query. Returns the worlds this account has roles on, which is exactly what the
// game's server-select screen renders.
export async function listWorlds(client, timeout = 10000) {
  const body = normalize(await client.request('GameWorldListRequest', {}, 'GameWorldListResponse', timeout));
  return {
    latestGroupId: body.latestGroupId,
    recentWorlds: (body.recentWorlds || []).map(describeWorld),
  };
}

// All worlds inside a group, not just the ones this account has visited.
export async function listGroup(client, groupId, timeout = 10000) {
  const body = normalize(await client.request('GameWorldGroupListRequest', { groupId }, 'GameWorldGroupListResponse', timeout));
  return (body.worlds || []).map(describeWorld);
}

// Entering a world is just a login that names it. `newRole` in the returned PlayerInfo
// means the server created a fresh role there, so callers must not treat an arbitrary
// worldId as a read.
export async function enterWorld({ url, login, protocol, client = new GameClient({ url, protocol }) }, worldId, timeout = 15000) {
  try {
    const response = await client.connect({ ...login, worldId });
    return { client, player: normalize(response.playerInfo), initSeqNo: response.initSeqNo };
  } catch (error) {
    client.stop();
    throw error;
  }
}
