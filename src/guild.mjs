import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

const task = 'guildWelfare';
const title = '联盟福利礼包';
const claiming = new WeakSet();
const lastClaims = new WeakMap();
const aidClaims = new WeakMap();
const skipped = reason => ({ label: title, skipped: true, reason });

// Guild/player IDs are int64, so don't identify accounts by a rounded double.
function idText(value) {
  if (value && typeof value.low === 'number' && typeof value.high === 'number') {
    return ((BigInt(value.high) << 32n) + BigInt(value.low >>> 0)).toString();
  }
  if (typeof value === 'bigint' || Number.isSafeInteger(value) || (typeof value === 'string' && /^\d+$/.test(value))) return String(value);
  return null;
}

function notJoined() { return { state: 'notJoined', reason: '当前账号未加入联盟' }; }
function isNoGuild(client, error) { return client.promptNames?.[error.prompt?.prompt] === 'NO_GUILD'; }

async function guildStatus(client, config, player) {
  const required = config?.tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '联盟')?.playerLevel;
  if (!(required > 0 && player?.level > 0)) return { state: 'unknown', reason: '无法确认联盟开放条件' };
  if (player.level < required) return { state: 'locked', reason: '联盟在角色 ' + required + ' 级开放，当前 ' + player.level + ' 级' };
  const id = idText(player.guildId);
  if (id === '0') return notJoined();
  if (id === null) return { state: 'unknown', reason: '无法确认当前账号的联盟身份' };
  let response;
  try {
    response = await client.request('GuildInfoRequest', {}, 'GuildInfoResponse');
  } catch (error) {
    if (isNoGuild(client, error)) return notJoined();
    throw error;
  }
  const guild = response?.guild;
  if (idText(guild?.guildId) !== id || idText(player.guildId) !== id) {
    return { state: 'unknown', reason: '联盟信息已变化，请稍后重新查看' };
  }
  const recorded = lastClaims.get(client);
  const times = Array.isArray(guild.welfarePack) ? guild.welfarePack.map(pack => pack.createTime) : null;
  const pending = Number.isSafeInteger(guild.gotWelfareTime) && guild.gotWelfareTime >= 0 && times?.every(t => Number.isSafeInteger(t) && t > 0)
    ? times.filter(t => t > Math.max(guild.gotWelfareTime, recorded?.id === id ? recorded.time : 0)) : null;
  return { state: 'member', id, name: guild.name || '当前联盟', level: guild.level ?? null, memberCount: guild.memberCount ?? null,
    welfareCount: pending?.length ?? null, pending };
}

export async function readGuild(client, config, player) {
  const { pending, ...status } = await guildStatus(client, config, player);
  const view = { ...status, requests: [], myRequests: [], myAidCount: null };
  if (status.state !== 'member') return view;
  try {
    const reply = await client.request('GuildAidListRequest', { type: 0 }, 'GuildAidListResponse');
    if (idText(player.guildId) !== status.id) return { state: 'unknown', reason: '联盟信息已变化，请重新查看', requests: [] };
    if (!Array.isArray(reply?.askItems)) throw new Error('服务器未返回联盟求助列表');
    const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
    // GuildHelpPop budgets one unit of reqItemId per request (including "help all").
    for (const row of reply.askItems) {
      if (!row.reqItemId || !(row.endTime >= now) || idText(row.asker?.playerId) === idText(player.playerId)) continue;
      view.requests.push({ requester: row.asker?.nickname || '联盟成员', material: displayMaterial(config, row.reqItemId),
        quantity: 1, endTime: row.endTime });
    }
  } catch (error) {
    if (isNoGuild(client, error)) return { ...notJoined(), requests: [] };
    view.aidError = error.message;
  }
  try {
    view.myRequests = await readMyGuildAid(client, config, player, status.id);
    view.myAidCount = view.myRequests.filter(row => row.ready).length;
    view.myAidPending = view.myRequests.some(row => row.ready && aidClaims.get(client)?.has(row.id));
  } catch (error) {
    view.myAidError = error.message;
  }
  return view;
}

// 用于配置页的真实盟友选择；只读取成员，不修改原有名单或触发联盟操作。
export async function readGuildMembers(client, config, player) {
  const status = await guildStatus(client, config, player);
  if (status.state !== 'member') return { state: status.state, reason: status.reason, members: [] };
  const ownId = idText(player.playerId), response = await client.request('GuildMemberRequest', {}, 'GuildMemberResponse');
  if (idText(player.guildId) !== status.id || idText(player.playerId) !== ownId) throw new Error('角色或联盟已变化，请重新读取盟友名单');
  if (!Array.isArray(response?.titleList) || !Number.isSafeInteger(response.total) || response.total < 0) throw new Error('服务器未返回完整盟友名单');
  const members = new Map();
  for (const group of response.titleList) {
    if (!Array.isArray(group.members)) throw new Error('盟友分组数据不完整');
    // BLACK为黑名单，不属于可跟随的本盟成员。
    if (![2, 3, 4, 5].includes(group.guildTitle)) continue;
    for (const member of group.members) {
      const id = idText(member.playerId);
      if (!id || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > (1n << 63n) - 1n || typeof member.nickname !== 'string' || !member.nickname.trim()) throw new Error('盟友身份未能精确读取，请稍后重试');
      if (id === ownId) continue;
      if (members.has(id) && members.get(id).name !== member.nickname) throw new Error('盟友身份重复且昵称冲突，请重新读取');
      members.set(id, { id, name: member.nickname, online: member.online === true, title: group.guildTitle });
    }
  }
  return { state: 'member', guildName: status.name, total: response.total, checkedAt: new Date().toISOString(),
    members: [...members.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)) };
}

async function readMyGuildAid(client, config, player, guildId) {
  const reply = await client.request('MyGuildAidRequest', { type: 0 }, 'MyGuildAidResponse');
  if (idText(player.guildId) !== guildId) throw new Error('联盟信息已变化，请重新查看');
  if (!Array.isArray(reply?.aids)) throw new Error('服务器未返回我的求助列表');
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const rows = reply.aids.map(row => {
    const id = idText(row.reqId);
    if (!id || !/^[1-9]\d*$/.test(id) || !row.reqItemId) throw new Error('无法完整确认个人求助记录');
    const ready = !!row.helper && idText(row.helper.playerId) !== '0';
    if (ready && !idText(row.helper.playerId)) throw new Error('无法确认个人求助的协助者');
    return { id, itemId: row.reqItemId, material: displayMaterial(config, row.reqItemId), quantity: 1, endTime: row.endTime,
      helper: ready ? row.helper.nickname || '联盟成员' : '', ready,
      status: ready ? '待领取' : row.endTime > now ? '等待援助' : '已过期' };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('个人求助记录重复，请刷新后再试');
  const pending = aidClaims.get(client);
  if (pending) for (const id of pending) if (!rows.some(row => row.id === id && row.ready)) pending.delete(id);
  return rows;
}

export async function claimMyGuildAid(client, config, { player, enabled = () => true, beforeSend } = {}) {
  if (!enabled()) throw new Error('账号已暂停');
  const status = await guildStatus(client, config, player);
  if (status.state !== 'member') throw new Error(status.reason);
  const before = await readMyGuildAid(client, config, player, status.id);
  const ready = before.filter(row => row.ready);
  if (!ready.length) return { ok: true, count: 0, label: '目前没有待领取的求助物资' };
  const pending = aidClaims.get(client) ?? new Set();
  aidClaims.set(client, pending);
  if (ready.some(row => pending.has(row.id))) throw new Error('上次领取结果仍待确认，请稍后刷新，暂不重复领取');
  if (!enabled() || idText(player.guildId) !== status.id) throw new Error('账号或联盟状态已变化');
  beforeSend?.(ready.map(row => row.id), ready);
  ready.forEach(row => pending.add(row.id));
  try {
    // 此协议仅有援助类型，没有单条reqId；一次领取当前全部个人求助物资。
    await client.sendWatch('GotMyGuildAidRequest', { type: 0 }, { window: 400 });
  } catch (error) {
    if (error.notSent === true || error.prompt && error.request === 'GotMyGuildAidRequest') ready.forEach(row => pending.delete(row.id));
    // Let callers cancel their own budget only for this write's unsent error,
    // never for a later readMyGuildAid request that could not be sent.
    if (error.notSent === true) error.guildAidClaimNotSent = true;
    throw error;
  }
  if (!enabled()) throw new Error('领取请求已发送，账号状态已变化，请重新连接后核对结果');
  const after = await readMyGuildAid(client, config, player, status.id);
  const count = ready.filter(row => !after.some(item => item.id === row.id)).length;
  return { ok: count === ready.length, count, label: count === ready.length
    ? '已领取 ' + count + ' 份求助物资' : '已确认领取 ' + count + ' 份，其余结果待确认，请稍后刷新' };
}

export async function claimGuildWelfare(client, config, { player, enabled = () => true, scheduler } = {}) {
  if (!enabled()) return skipped('已暂停');
  if (scheduler && !scheduler.due(task)) return skipped('等待下次检查');
  if (claiming.has(client)) return skipped('正在核对联盟福利');
  const recheck = seconds => scheduler?.defer(task, scheduler.now() + seconds);
  claiming.add(client);
  try {
    const status = await guildStatus(client, config, player);
    if (status.state !== 'member') {
      recheck(status.state === 'unknown' ? 180 : 1800);
      return skipped(status.reason);
    }
    if (status.welfareCount === null) throw new Error('无法确认联盟福利的领取记录');
    if (!status.welfareCount) { recheck(300); return skipped('当前没有新的联盟福利礼包'); }
    if (!enabled() || idText(player.guildId) !== status.id) return skipped('账号或联盟状态已变化');
    const result = normalize(await client.request('GotGuildWelfarePackRequest', {}, 'GotGuildWelfarePackResponse'));
    const confirmed = Number.isSafeInteger(result?.lastGotTime) && status.pending.filter(t => t <= result.lastGotTime).length;
    if (!confirmed || !result?.reward?.asset?.length) throw new Error('服务端未确认联盟福利的领取时间和奖励');
    lastClaims.set(client, { id: status.id, time: result.lastGotTime });
    const rewards = result.reward.asset.map(item => displayMaterial(config, item.id) + ' ×' + item.num);
    if (confirmed === status.welfareCount) recheck(300);
    return { label: title + ' · 已领取，获得' + rewards.join('、'), ok: true };
  } catch (error) {
    if (isNoGuild(client, error)) { recheck(1800); return skipped(notJoined().reason); }
    recheck(180);
    throw error;
  } finally {
    claiming.delete(client);
  }
}
