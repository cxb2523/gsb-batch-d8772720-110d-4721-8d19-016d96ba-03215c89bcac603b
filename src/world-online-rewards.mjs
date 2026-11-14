// 城战在线奖励：只读取实际档位与服务器时段，领取结果以计数变化确认。
import { exactAutomationId } from './automation-policy.mjs';
const active = new WeakSet();
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const valid = n => Number.isSafeInteger(n) && n >= 0;
export function worldOnlineRewardKey(player, state) {
  const world = exactAutomationId(player?.worldId), owner = exactAutomationId(player?.playerId);
  return world && owner && valid(state.startTime) && valid(state.stage) ? `worldOnline:${world}:${owner}:${state.startTime}:${state.stage}` : null;
}
function count(value) {
  if (valid(value)) return value;
  const text = typeof value === 'object' && value ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text); return valid(n) ? n : null;
}

export async function readWorldOnlineReward(client, config, player) {
  const state = { ready: false, claimed: null, stage: null, nextAt: null, startTime: null, endTime: null, reason: '' };
  const rows = config?.tables?.WorldOnlineRwdCfg?.data;
  const level = config?.tables?.ModuleOpenCfg?.data?.find(r => r.moduleId === '世界')?.playerLevel;
  if (!Number.isInteger(level) || !(player?.level >= level)) return { ...state, reason: '尚未满足世界玩法开放等级' };
  if (!Array.isArray(rows) || !rows.length || rows.some(r => !valid(r.stage) || r.stage < 1 || !valid(r.seconds))) return { ...state, reason: '在线奖励档位配置未确认' };
  try {
    const [war, counters] = await Promise.all([
      client.request('WarDeclarationRequest', {}, 'WarDeclarationResponse'), client.request('CounterInfoRequest', {}, 'CounterInfoResponse'),
    ]);
    state.startTime = war.startTime; state.endTime = war.endTime;
    if (!valid(war.startTime) || !valid(war.endTime) || !(war.endTime > war.startTime) || !Array.isArray(counters.counters)) throw new Error('服务器时段或在线计数不完整');
    const matches = counters.counters.filter(r => r.type === 'DAILY_WORLD_ONLINE_RWD');
    if (matches.length > 1) throw new Error('在线奖励计数重复');
    const item = matches[0], claimed = item ? count(item.num) : 0, updated = item?.updateTime ?? 0;
    if (claimed == null || !valid(updated)) throw new Error('在线奖励计数无效');
    state.claimed = claimed;
    const now = nowOf(client);
    if (now < war.startTime || now >= war.endTime) return { ...state, reason: '当前不在服务器城战在线奖励时段' };
    if (updated > now || (claimed > 0 && updated < war.startTime)) return { ...state, reason: '在线奖励计时状态尚未刷新，等待下次核对' };
    const max = Math.max(...rows.map(r => r.stage));
    if (claimed === max) return { ...state, reason: '本次城战在线奖励已全部领取' };
    const next = rows.filter(r => r.stage === claimed + 1);
    if (next.length !== 1) throw new Error('下一档在线奖励未确认');
    state.stage = next[0].stage; state.nextAt = Math.max(war.startTime, updated) + next[0].seconds;
    state.ready = now >= state.nextAt;
    state.reason = state.ready ? '' : `第 ${state.stage} 档在线奖励还需等待 ${state.nextAt - now} 秒`;
    return state;
  } catch (error) { return { ...state, ready: false, reason: '在线奖励状态未确认：' + error.message }; }
}

export async function claimWorldOnlineReward(client, config, player, { ledger, enabled = () => true, scheduler } = {}) {
  const title = '城战在线奖励';
  if (!enabled() || active.has(client)) return { title, skipped: true, reason: '领取已暂停或正在检查' };
  if (!ledger?.reserve || !ledger?.keyRecords) throw new Error('缺少在线奖励确认记录，未发送领取');
  active.add(client);
  try {
    const state = await readWorldOnlineReward(client, config, player);
    const prefix = `worldOnline:${exactAutomationId(player.worldId)}:${exactAutomationId(player.playerId)}:${state.startTime}:`;
    if (valid(state.claimed)) for (const [key, record] of Object.entries(ledger.keyRecords())) {
      if (key.startsWith(prefix) && !record.confirmed && valid(record.details?.stage) && record.details.stage <= state.claimed) ledger.resolveKey(key, true);
    }
    if (!state.ready) {
      if (state.nextAt > nowOf(client)) scheduler?.defer('worldOnlineRewards', state.nextAt);
      return { title, skipped: true, reason: state.reason };
    }
    const world = exactAutomationId(player.worldId), owner = exactAutomationId(player.playerId);
    if (!world || !owner) return { title, skipped: true, reason: '角色或区服身份未确认' };
    const key = worldOnlineRewardKey(player, state);
    if (ledger.keyRecords()[key]) return { title, skipped: true, reason: '本档已发送领取，等待服务器计数更新，不重复提交' };
    const fresh = await readWorldOnlineReward(client, config, player);
    if (!enabled() || !client.connected || !fresh.ready || fresh.stage !== state.stage || fresh.startTime !== state.startTime || nowOf(client) >= fresh.endTime || exactAutomationId(player.worldId) !== world || exactAutomationId(player.playerId) !== owner) return { title, skipped: true, reason: '领取前状态已变化，下次重新核对' };
    const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'worldOnlineReward', stage: fresh.stage, startTime: fresh.startTime } });
    if (!enabled()) { ledger.cancel(ticket); return { title, skipped: true, reason: '领取已暂停' }; }
    try {
      await client.sendWatch('GotWorldOnlineRwdRequest', {}, { window: 600 });
      const after = await readWorldOnlineReward(client, config, player);
      if (after.startTime === fresh.startTime && after.claimed >= fresh.stage) {
        ledger.confirm(ticket);
        if (after.nextAt > nowOf(client)) scheduler?.defer('worldOnlineRewards', after.nextAt);
        return { title: `城战在线奖励第 ${fresh.stage} 档已领取`, ok: true };
      }
      return { title, ok: false, pending: true, error: '请求已发送，档位变化尚未确认；保留记录，不重复领取' };
    } catch (error) {
      if (error.prompt && error.request === 'GotWorldOnlineRwdRequest') ledger.cancel(ticket);
      return { title, ok: false, pending: !(error.prompt && error.request === 'GotWorldOnlineRwdRequest'), error: error.message };
    }
  } finally { active.delete(client); }
}
