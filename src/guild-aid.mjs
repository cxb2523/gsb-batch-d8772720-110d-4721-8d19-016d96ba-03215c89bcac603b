import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { uidText } from './hero-equipment.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, readOrderReservedStock, confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const key = 'guildAidHelp';
const label = '联盟互助';
export const maxAidHelpsPerRound = 1;
const busy = new WeakSet();
const attempts = new Map();

// 只用预留之外的余量。确认回执后读取完整库存；未知请求不能仅凭求助消失当作本人赠送成功。
export function planGuildAid(asks, available, me, now, limit = maxAidHelpsPerRound) {
  const left = new Map(available);
  const picked = [];
  const sorted = [...asks].sort((a, b) => a.endTime - b.endTime);
  for (const ask of sorted) {
    if (picked.length >= limit) break;
    if (!ask?.reqItemId || !(ask.endTime >= now) || uidText(ask.asker?.playerId) === me) continue;
    const count = left.get(ask.reqItemId) ?? 0;
    if (count < 1) continue;
    left.set(ask.reqItemId, count - 1);
    picked.push(ask);
  }
  return picked;
}

export async function serviceGuildAid(client, protocol, config, { player, enabled = () => false, report = () => {}, scheduler } = {}) {
  const finish = entry => { const result = { key, label, ...entry }; report(result); return result; };
  const skip = reason => finish({ skipped: true, reason });
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!enabled()) return skip('已暂停');
  if (!(toNumber(player?.guildId) > 0)) { later(1800); return skip('当前账号未加入联盟'); }
  const identity=()=>JSON.stringify([uidText(player?.playerId),uidText(player?.worldId),uidText(player?.guildId)]),stamp=identity();
  const active=()=>enabled()&&client.connected!==false&&identity()===stamp;
  if (busy.has(client)) return skip('正在核对联盟互助');
  busy.add(client);
  try {
    await refreshOrderMaterialSpends(client,player,{enabled:active});
    const list = await client.request('GuildAidListRequest', { type: 0 }, 'GuildAidListResponse');
    if(!active())return skip('账号已暂停或身份已变化');
    if (!Array.isArray(list?.askItems)) throw new Error('服务器未返回联盟求助列表');
    const account=JSON.stringify([uidText(player.playerId),uidText(player.worldId)]),saved=attempts.get(account)??new Map();
    const ids=new Set(list.askItems.map(row=>uidText(row.reqId)));
    if(ids.has(null)||ids.has('')||ids.size!==list.askItems.length)throw new Error('联盟求助标识无效或重复');
    for(const [id,attempt] of saved)if(attempt.confirmed&&!ids.has(id))saved.delete(id);
    attempts.set(account,saved);
    if (!list.askItems.length) { later(300); return skip('当前没有成员求助'); }
    const eligible=list.askItems.filter(row=>!saved.has(uidText(row.reqId)));
    const { stock, available } = await readOrderReservedStock(client, protocol, config, { player, enabled:active,itemIds:[...new Set(eligible.map(row=>row.reqItemId))] });
    if (!active()) return skip('账号已暂停或连接已更换');
    const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
    const picked = planGuildAid(eligible, available, uidText(player.playerId), now);
    if (!picked.length) { later(300); return skip('留足周订单、贸易港和居民订单后，没有可用于互助的材料'); }
    const counts = new Map();
    for (const ask of picked) counts.set(ask.reqItemId, (counts.get(ask.reqItemId) ?? 0) + 1);
    const debit = beginOrderMaterialSpend(player, [...counts].map(([id, need]) => ({ id, need, have: stock.get(id) ?? 0 })), label,{operation:{}});
    for(const ask of picked)saved.set(uidText(ask.reqId),{confirmed:false});
    let reply;
    try {
      reply = await client.request('GuildAidHelpRequest', { reqId: picked.map(ask => ask.reqId) }, ['GotRewardResponse', 'OkResponse']);
    } catch (error) {
      if (error.notSent === true || error.prompt && error.request === 'GuildAidHelpRequest') {cancelOrderMaterialSpend(debit);for(const ask of picked)saved.delete(uidText(ask.reqId));}
      later(300);
      return finish({ ok: false, error: error.message });
    }
    for(const ask of picked)saved.get(uidText(ask.reqId)).confirmed=true;
    confirmOrderMaterialOperation(debit);
    await refreshOrderMaterialSpends(client,player,{enabled:active});
    later(60);
    const used = [...counts].map(([id, count]) => displayMaterial(config, id) + ' ×' + count).join('、');
    const rewards = (reply?.reward?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + toNumber(item.num)).join('、');
    return finish({ ok: true, label: label + ' · 响应 ' + picked.length + ' 次，用去 ' + used + (rewards ? '，获得 ' + rewards : '') });
  } catch (error) {
    later(300);
    if (!active()) return skip('账号已暂停或连接已更换');
    if (error.code === 'ORDER_MATERIAL_SPEND_PENDING') return skip(error.message);
    if (client.promptNames?.[error.prompt?.prompt] === 'NO_GUILD') { later(1800); return skip('当前账号未加入联盟'); }
    return finish({ ok: false, error: error.message });
  } finally {
    busy.delete(client);
  }
}
