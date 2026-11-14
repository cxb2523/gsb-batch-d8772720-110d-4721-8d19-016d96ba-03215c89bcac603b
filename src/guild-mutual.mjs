// 手动开启的单次互助，不接入常驻挂机；赠送额度和未知请求记录跨重启保留。
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { readGuildMembers, claimMyGuildAid } from './guild.mjs';
import { displayMaterial } from './config.mjs';
import { beijingDay } from './automation-settings.mjs';
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const valid = n => Number.isSafeInteger(n) && n >= 0;
const identity = player => ({ playerId: exactAutomationId(player?.playerId), guildId: exactAutomationId(player?.guildId), worldId: exactAutomationId(player?.worldId) });
function same(a,b) { return a.playerId === b.playerId && a.guildId === b.guildId && a.worldId === b.worldId; }
function quantity(v) {
  if (valid(v)) return v;
  let n;
  if (typeof v === 'string' && /^\d+$/.test(v)) n = BigInt(v);
  else if (Number.isInteger(v?.low) && Number.isInteger(v?.high)) n = (BigInt(v.high) << 32n) + BigInt(v.low >>> 0);
  return n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
export function mutualOptions(input = {}) {
  const target = input.target ?? 20, mode = input.mode ?? 'all', memberIds = input.memberIds ?? [];
  const askEnabled = input.askEnabled ?? false, askTarget = input.askTarget ?? 20, askItemId = input.askItemId ?? '';
  if (!Number.isSafeInteger(target) || target < 0 || target > 20) throw new Error('今日赠送目标请输入0–20；0表示不赠送');
  if (!['all','selected'].includes(mode) || !Array.isArray(memberIds) || memberIds.length > 100 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => typeof id !== 'string' || exactAutomationId(id) !== id)) throw new Error('请选择有效的盟友范围');
  if (target > 0 && mode === 'selected' && !memberIds.length) throw new Error('指定盟友模式至少选择一位盟友');
  if (typeof askEnabled !== 'boolean' || !Number.isSafeInteger(askTarget) || askTarget < 0 || askTarget > 20 || typeof askItemId !== 'string' || askItemId.length > 120 || (askEnabled && !askItemId)) throw new Error('请选择求助材料，并填写0–20之间的今日求助目标');
  return { target, mode, memberIds: mode === 'selected' ? [...memberIds] : [], askEnabled, askTarget, askItemId };
}

function helpMaterials(config,player) {
  const world=exactAutomationId(player?.worldId),season=world?Number(BigInt(world)/1000000n%1000n):0;
  const cfg=config?.tables?.GuildHelpCfg?.data;
  if (!season || !Array.isArray(cfg) || !cfg.length) throw new Error('联盟互助材料或赛季未确认');
  return cfg.filter(r=>(r.season??0)<=season).map(r=>({id:r.id,name:displayMaterial(config,r.id)}));
}
async function askCounter(client,config) {
  const limit=config?.tables?.GuildParamCfg?.data?.find(r=>r.paramName==='每日求助次数上限')?.paramValue;
  if (!valid(limit) || limit<1) return {askUsed:null,askLimit:null,askReason:'游戏每日求助上限未确认'};
  try {
    const reply=await client.request('CounterInfoRequest',{},'CounterInfoResponse');
    if (!Array.isArray(reply.counters)) throw new Error('求助计数未完整返回');
    const matches=reply.counters.filter(r=>r.type==='DAILY_GUILD_AID');
    const used=matches.length===0?0:matches.length===1?quantity(matches[0].num):null;
    if (!valid(used)) throw new Error('今日发起求助计数无效或重复');
    return {askUsed:used,askLimit:limit,askReason:''};
  } catch(error) {return {askUsed:null,askLimit:limit,askReason:error.message};}
}
export async function readMutualOptions(client,config,player) {
  const actor=identity(player),members=await readGuildMembers(client,config,player);
  if(members.state!=='member')throw new Error(members.reason||'无法读取盟友');
  const counter=await askCounter(client,config);
  if(!same(actor,identity(player)))throw new Error('联盟已变化，请重新读取');
  return {...members,materials:helpMaterials(config,player),...counter};
}

export async function readMutualAid(client, config, player, options) {
  const actor = identity(player), now = nowOf(client);
  if (Object.values(actor).some(v => !v)) throw new Error('角色、区服或联盟身份未确认');
  const members = await readGuildMembers(client, config, player);
  if (members.state !== 'member') throw new Error(members.reason || '当前无法读取盟友');
  const [asks, mine, counter] = await Promise.all([
    client.request('GuildAidListRequest', { type:0 }, 'GuildAidListResponse'),
    client.request('MyGuildAidRequest', { type:0 }, 'MyGuildAidResponse'),
    options.askEnabled ? askCounter(client,config) : Promise.resolve({askUsed:null,askLimit:null,askReason:''}),
  ]);
  // Read the complete inventory after the business state. Production or a
  // returned gift can replace an acknowledged debit before this snapshot.
  const bag = await client.request('AllItemRequest', {}, 'AllItemResponse');
  if (!same(actor, identity(player))) throw new Error('角色或联盟已变化，互助已停止');
  if (![asks.askItems,bag.items,mine.aids].every(Array.isArray)) throw new Error('求助或库存状态未完整返回');
  const roster = new Map(members.members.map(row => [row.id,row]));
  const selected = new Set(options.memberIds);
  if (options.target > 0 && options.mode === 'selected' && options.memberIds.some(id => !roster.has(id))) throw new Error('所选盟友已不在当前可互助名单，请重新选择');
  const stock = new Map();
  for (const item of bag.items) {
    if (typeof item.itemId !== 'string' || !item.itemId || stock.has(item.itemId)) throw new Error('库存道具记录无效或重复');
    const n = quantity(item.num);
    if (!valid(n)) throw new Error('库存数量未完整确认');
    stock.set(item.itemId, n);
  }
  const allowed = new Set(helpMaterials(config,player).map(r=>r.id));
  if(options.askEnabled && !allowed.has(options.askItemId))throw new Error('所选材料不在当前赛季允许的联盟求助范围内');
  const ids = new Set(), requests = [], candidates = [];
  for (const row of asks.askItems) {
    const id = exactAutomationId(row.reqId), memberId = exactAutomationId(row.asker?.playerId);
    if (!id || !memberId || ids.has(id)) throw new Error('求助标识无效或重复，停止赠送'); ids.add(id);
    if (memberId === actor.playerId || !roster.has(memberId) || !valid(row.endTime) || row.endTime <= now || !allowed.has(row.reqItemId)) continue;
    if (options.mode === 'selected' && !selected.has(memberId)) continue;
    if (options.askEnabled && row.reqItemId!==options.askItemId) continue;
    const request = { id, memberId, name:roster.get(memberId).name, itemId:row.reqItemId, material:displayMaterial(config,row.reqItemId), endTime:row.endTime, askTime:valid(row.askTime)?row.askTime:0 };
    requests.push(request);
    if (stock.get(row.reqItemId) >= 1) candidates.push({...request,stockBefore:stock.get(row.reqItemId)});
  }
  candidates.sort((a,b)=>a.askTime-b.askTime || a.id.localeCompare(b.id));
  const ready = [], ownIds = new Set(), ownRequests=[];
  for (const row of mine.aids) {
    const id=exactAutomationId(row.reqId);
    if (!id || ownIds.has(id)) throw new Error('个人求助记录无效或重复'); ownIds.add(id);
    const received=!!(row.helper && exactAutomationId(row.helper.playerId));
    if (received) ready.push(id);
    ownRequests.push({id,itemId:row.reqItemId,ready:received,endTime:row.endTime});
  }
  return { ...actor, now, day:beijingDay(now*1000), candidates, ready, ownRequests, askIds:[...ids], stock,...counter,
    reason:requests.length ? '符合范围的求助暂时缺少库存材料' : '当前没有符合盟友范围的有效求助' };
}

function matching(record, state) { return record.details?.worldId === state.worldId && record.details?.playerId === state.playerId; }
async function mutualStep(context, options, startIdentity, day, signal, exchange) {
  const {client,config,player,ledger,enabled} = context;
  const allowed = () => !signal?.aborted && enabled() && client.connected && same(startIdentity,identity(player));
  if (!allowed()) throw new Error('账号、连接或联盟已变化');
  let state = await readMutualAid(client,config,player,options);
  if (!allowed()) return { done:true,reason:'账号、连接或联盟已变化，保留待确认记录' };
  if (state.day !== day || ledger.snapshot().day !== day) return { done:true,reason:'已跨日或日期尚未对齐，本次互助结束，请重新开启' };
  let received = 0;
  for (const [key,record] of Object.entries(ledger.keyRecords())) {
    if (!record.confirmed && matching(record,state) && record.details.kind === 'guildAidGift' && record.details.acknowledged === true &&
      record.details.guildId === state.guildId && !state.askIds.includes(record.details.reqId)) ledger.resolveKey(key,true);
    if (!record.confirmed && matching(record,state) && record.details.kind === 'guildAidClaim' && !record.details.ids.some(id=>state.ready.includes(id))) ledger.resolveKey(key,true);
    if (!record.confirmed && matching(record,state) && record.details.kind === 'guildAidAsk' && record.details.day===state.day && state.askUsed>=record.details.nextCount &&
      state.ownRequests.some(row=>row.itemId===record.details.itemId && !record.details.beforeIds.includes(row.id))) ledger.resolveKey(key,true);
  }
  if (state.ready.length) {
    if (Object.values(ledger.keyRecords()).some(record=>!record.confirmed && matching(record,state) && record.details.kind==='guildAidClaim')) return {done:true,pending:true,reason:'上次领取结果待确认，暂不重复领取或赠送'};
    let ticket = null, selectedMaterialCount = 0;
    try {
      const result = await claimMyGuildAid(client,config,{player,enabled:allowed,beforeSend:(ids,records)=>{
        if (!allowed() || beijingDay(nowOf(client)*1000)!==day) throw new Error('领取前状态已变化');
        selectedMaterialCount=records.filter(row=>row.itemId===options.askItemId).length;
        const digest=createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0,32);
        ticket=ledger.reserve({}, {}, {}, {uniqueKey:`guildAidClaim:${state.worldId}:${state.playerId}:${digest}`,details:{kind:'guildAidClaim',worldId:state.worldId,playerId:state.playerId,ids}});
      }});
      received=result.count ?? 0;
      if (ticket && result.ok) {ledger.confirm(ticket);exchange.received+=selectedMaterialCount;}
      if (!result.ok) return {done:true,pending:true,received,reason:result.label};
    } catch(error) {
      const rejected=error.guildAidClaimNotSent===true || error.prompt && error.request==='GotMyGuildAidRequest';
      if (ticket && rejected) ledger.cancel(ticket);
      return {done:true,pending:!!ticket&&!rejected,received,reason:'领取未完成：'+error.message};
    }
    if (!allowed()) return {done:true,received,reason:'账号已暂停，本次互助结束'};
    state=await readMutualAid(client,config,player,options);
  }
  if(options.askEnabled){
    if(state.askReason || !valid(state.askUsed) || !valid(state.askLimit))return{done:true,received,reason:'无法确认今日求助次数：'+(state.askReason||'状态未知')};
    if(state.ownRequests.some(row=>row.itemId===options.askItemId && (row.ready || row.endTime>state.now)))exchange.seen=true;
    const limit=Math.min(options.askTarget,state.askLimit);
    if(Object.values(ledger.keyRecords()).some(record=>!record.confirmed && matching(record,state) && record.details.kind==='guildAidAsk'))return{done:true,pending:true,received,reason:'上次发起求助结果待确认，不重复发布'};
    if(state.askUsed<limit){
      if(!allowed() || state.day!==day || beijingDay(nowOf(client)*1000)!==day || ledger.snapshot().day!==day)return{done:true,received,reason:'发起求助前状态已变化'};
      const key=`guildAidAsk:${state.worldId}:${state.playerId}:${day}:${state.askUsed}`;
      if(ledger.hasKey(key))return{done:true,pending:true,received,reason:'同一次求助计数已有提交记录，等待刷新'};
      const ticket=ledger.reserve({guildAidAsks:1},{guildAidAsks:limit},{},{uniqueKey:key,details:{kind:'guildAidAsk',worldId:state.worldId,playerId:state.playerId,day,itemId:options.askItemId,nextCount:state.askUsed+1,beforeIds:state.ownRequests.map(r=>r.id)}});
      let askSent=false;
      try{
        await client.sendWatch('GuildAidAskRequest',{reqItemId:options.askItemId,type:0},{window:400});
        askSent=true;
        const after=await readMutualAid(client,config,player,options);
        if(after.day!==day || after.askUsed!==state.askUsed+1 || !after.ownRequests.some(r=>r.itemId===options.askItemId && (r.ready || r.endTime>after.now) && !state.ownRequests.some(old=>old.id===r.id)))throw new Error('计数或新求助记录尚未确认');
        ledger.confirm(ticket);exchange.seen=true;
        return{received,published:1,askUsed:after.askUsed,askLimit:state.askLimit,reason:`已发起${displayMaterial(config,options.askItemId)}求助，游戏今日${after.askUsed}/${state.askLimit}次`};
      }catch(error){const rejected=(!askSent&&error.notSent===true)||error.prompt&&error.request==='GuildAidAskRequest';if(rejected)ledger.cancel(ticket);return{done:true,pending:!rejected,received,reason:'发起求助未完成：'+error.message};}
    }
  }
  const used=ledger.snapshot().counters.guildAidGifts ?? 0;
  if (!valid(used)) throw new Error('今日赠送记录异常，未发送材料');
  if (options.target===0) return {done:true,received,reason:'本次发起/领取检查完成，赠送目标为0'};
  if (Object.values(ledger.keyRecords()).some(record=>!record.confirmed && matching(record,state) && record.details.kind==='guildAidGift')) return {done:true,pending:true,received,reason:'前次赠送结果待确认，保留次数，停止新增赠送'};
  if (used>=options.target) {
    const outstanding=options.askEnabled?state.ownRequests.filter(r=>r.itemId===options.askItemId && (r.ready || r.endTime>state.now)).length:0;
    if(outstanding && exchange.received<exchange.sent)return{received,waiting:true,reason:`赠送目标已达，不再赠送；等待领取${exchange.sent-exchange.received}份${displayMaterial(config,options.askItemId)}回赠`};
    return {done:true,received,reason:`已达到今日赠送目标${options.target}次`};
  }
  if(options.askEnabled && !exchange.seen)return{done:true,received,reason:'今日已不能再发起所选材料求助，且没有该材料的有效求助，请核对后再开启互赠'};
  if(options.askEnabled && !state.ownRequests.some(r=>r.itemId===options.askItemId && (r.ready || r.endTime>state.now)) && exchange.received<=exchange.sent)
    return{done:true,received,reason:'所选材料的求助已领完且不能继续发布，本次互赠结束；保留手头材料'};
  const chosen=state.candidates.find(row=>!ledger.hasKey(`guildAidGift:${state.worldId}:${state.playerId}:${row.id}`));
  if (!chosen) return {received,waiting:true,reason:(state.candidates.length?'可赠送的求助已有处理记录，等待列表刷新':state.reason)+'，15秒后再检查'};
  if (!allowed() || state.day!==day || beijingDay(nowOf(client)*1000)!==day || ledger.snapshot().day!==day || chosen.endTime<=nowOf(client)) return {done:true,received,reason:'赠送前状态或日期已变化，本次结束'};
  const key=`guildAidGift:${state.worldId}:${state.playerId}:${chosen.id}`;
  const ticket=ledger.reserve({guildAidGifts:1},{guildAidGifts:options.target},{},{uniqueKey:key,details:{kind:'guildAidGift',day,worldId:state.worldId,playerId:state.playerId,guildId:state.guildId,reqId:chosen.id,memberId:chosen.memberId,itemId:chosen.itemId}});
  if (!allowed()) {ledger.cancel(ticket);return{done:true,received,reason:'已停止，未发送赠送'};}
  let giftResponseReceived=false;
  try {
    const reply=await client.request('GuildAidHelpRequest',{reqId:[automationWireId(chosen.id)],type:0},'GotRewardResponse',8000);
    giftResponseReceived=true;
    if (!Array.isArray(reply?.reward?.asset) || !reply.reward.asset.some(row=>typeof row.id==='string' && quantity(row.num)>0)) throw new Error('服务端未返回可确认的互助奖励');
    // Keep the receipt across pause, disconnect and restart. A disappeared ask
    // alone cannot distinguish our lost request from another member's gift.
    ledger.updateKeyDetails(key,{...ledger.keyRecords()[key].details,acknowledged:true});
    if(!allowed())throw new Error('赠送已回执，账号状态已变化，等待下次核对库存');
    const after=await readMutualAid(client,config,player,options);
    if(!allowed() || !same(startIdentity,after))throw new Error('赠送后账号或联盟已变化');
    if(after.askIds.includes(chosen.id))throw new Error('求助完成状态尚未确认');
    ledger.confirm(ticket);
    return {received,sent:1,reason:`已赠给${chosen.name}：${chosen.material} ×1`};
  } catch(error) {
    if ((!giftResponseReceived&&error.notSent===true) || error.prompt && error.request==='GuildAidHelpRequest') {ledger.cancel(ticket);return{received,waiting:true,reason:(error.notSent===true?'本次赠送未发送：':'游戏拒绝本次赠送：')+error.message+'；稍后重新检查'};}
    return {done:true,pending:true,received,reason:'赠送结果未知，已保留1次额度并停止：'+error.message};
  }
}

export async function runGuildMutual(context, options, {signal,wait=sleep,onStep=()=>{}}={}) {
  options=mutualOptions(options);
  const actor=identity(context.player), day=beijingDay(nowOf(context.client)*1000);
  let sent=0,received=0,published=0;const exchange={seen:false,sent:0,received:0};
  for(;;){
    signal?.throwIfAborted();
    if (!context.enabled()) throw new Error('账号已暂停或连接已变化');
    const result=await (context.schedule??(work=>work()))(()=>mutualStep(context,options,actor,day,signal,exchange));
    sent+=result.sent??0;received+=result.received??0;published+=result.published??0;exchange.sent=sent;
    onStep({...result,sent,received,published,day});
    if(result.done)return{...result,sent,received,published,day};
    await wait(result.waiting?15000:1000,undefined,{signal});
  }
}

export function createGuildMutualTask() {
  let controller=null,state={running:false,stopping:false,sent:0,received:0,published:0,reason:'尚未开启',options:mutualOptions()};
  const view=()=>({...state,options:{...state.options,memberIds:[...state.options.memberIds]}});
  return {
    view,
    start(input,open,report){
      if(controller)throw new Error('当前账号已有互助任务，请先停止或等待完成');
      const options=mutualOptions(input);controller=new AbortController();const {signal}=controller;
      state={running:true,stopping:false,sent:0,received:0,published:0,reason:'正在核对盟友、求助和库存',options};
      let last='';const update=next=>{Object.assign(state,next);const signature=JSON.stringify([state.running,state.reason,state.sent,state.received,state.published,state.pending]);if(signature!==last){last=signature;report?.(view());}};
      (async()=>{try{const context=await open();signal.throwIfAborted();update(await runGuildMutual(context,options,{signal,onStep:update,wait:context.wait??sleep}));}
        catch(error){state.reason=error.message;state.failed=!signal.aborted;}
        finally{if(signal.aborted)state.reason=signal.reason.message;controller=null;update({running:false,stopping:false});}})();
      return view();
    },
    stop(reason='已手动停止'){if(controller){state.stopping=true;controller.abort(new Error(reason));}return view();},
  };
}
