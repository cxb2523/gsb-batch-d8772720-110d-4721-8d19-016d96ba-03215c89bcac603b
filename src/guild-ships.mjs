import { createHash } from 'node:crypto';
import { exactAutomationId, resourceReserve } from './automation-policy.mjs';
import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend,
  confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const activityByClient = new WeakMap(), busy = new WeakSet();
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const valid = value => Number.isSafeInteger(value) && value >= 0;
const dayOf = seconds => Math.floor((seconds + 28800) / 86400);
const identity = player => [exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), exactAutomationId(player?.guildId)].join(':');
const defaults = { enabled:false, crew:false, captain:false, coinFilter:true, minCoinsSmall:15, minCoinsMedium:45,
  minCoinsLarge:60, rewardFilter:false, rewardItems:[], disabledMaterials:[], mode:'redFirst', produceMissing:false,
  redStartEnabled:false, redStartTime:'20:00' };
const prefOf = settings => ({ ...defaults, ...settings?.guildShip });
const quantity = (value, label) => { const n = toNumber(value); if (!valid(n)) throw new Error(label + '未完整确认'); return n; };
const array = (value, label) => { if (!Array.isArray(value)) throw new Error(label + '未完整返回'); return value; };
const isSelf = (ship, playerId) => ship.leaderId === playerId || ship.cabin.some(cabin => cabin.playerId === playerId);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

// 必须在登录前注册，活动终止时刻只来自服务器推送，不能由活动期数猜测。
export function watchGuildShipPushes(client, scheduler) {
  let state = activityByClient.get(client);
  if (state) { if (scheduler) state.scheduler = scheduler; return state; }
  state = { period:null, scheduler }; activityByClient.set(client, state);
  const clear = () => { state.period = null; state.scheduler?.clearTask?.('guildShip'); };
  client.on?.('login', clear); client.on?.('close', clear);
  client.on?.('message', ({name,body}) => {
    if (name === 'SCGuildShipActivity') state.period = body?.period ? { ...body.period } : null;
    if (name.startsWith('SCGuildShip') || ['SCJoinGuild','SCLeaveGuild'].includes(name)) state.scheduler?.clearTask?.('guildShip');
  });
  return state;
}

function shipParameters(config, player) {
  const world = exactAutomationId(player?.worldId), season = world ? Number(BigInt(world) / 1000000n % 1000n) : 0;
  const param = rows(config,'GuildShipParamCfg').filter(row => row.season <= season).sort((a,b) => b.season-a.season)[0];
  if (!season || !param || !valid(param.shipNum) || param.shipNum < 1 || !valid(param.duration)
    || !Array.isArray(param.time) || !param.time.length || param.time.some(h => !valid(Number(h)) || Number(h) > 23)) throw new Error('当前赛季的商船队列或刷新配置未确认');
  return { ...param, time:[...new Set(param.time.map(Number))].sort((a,b)=>a-b) };
}

export function guildShipBatch(now, hours) {
  const midnight = dayOf(now) * 86400 - 28800;
  const points = [-1,0,1].flatMap(d => hours.map(hour => midnight + d * 86400 + hour * 3600)).sort((a,b)=>a-b);
  return { start:points.filter(time=>time<=now).at(-1), next:points.find(time=>time>now) };
}

function assets(raw, label) {
  const costs = new Map();
  for (const row of array(raw,label)) {
    if (row?.type !== 0 || typeof row.id !== 'string' || !row.id) throw new Error(label + '包含未支持的材料类型');
    const n = quantity(row.num,label + '数量'); if (n < 1) throw new Error(label+'数量异常');
    costs.set(row.id, quantity((costs.get(row.id) ?? 0)+n,label+'合计'));
  }
  return [...costs].map(([id,need])=>({id,need}));
}

function normalizeShip(raw, config) {
  if (!valid(raw?.shipId) || raw.shipId < 1 || ![1,2,3].includes(raw.type) || ![1,2].includes(raw.state)) throw new Error('联盟商船标识或状态无效');
  const cfg = rows(config,'GuildShipCfg').find(row => row.shipId === raw.type);
  if (!cfg || !valid(cfg.time) || cfg.time < 1 || !valid(cfg.num) || cfg.num < 1) throw new Error('商船航程或船舱配置未确认');
  const cabin = array(raw.cabin,'商船船舱').map(row => {
    if (!valid(row?.crewId) || row.crewId < 1) throw new Error('船舱编号无效');
    const playerId = row.player ? exactAutomationId(row.player.playerId) : null;
    if (row.player && !playerId) throw new Error('船员身份无法精确确认');
    return { crewId:row.crewId, playerId, costs:assets(row.order,'船舱材料') };
  });
  if (cabin.length !== cfg.num || new Set(cabin.map(row=>row.crewId)).size !== cabin.length) throw new Error('船舱列表不完整或重复');
  const leaderId = raw.leader ? exactAutomationId(raw.leader.playerId) : null;
  if (raw.leader && !leaderId) throw new Error('船长身份无法精确确认');
  const reward = array(raw.reward?.asset,'商船奖励').map(row=>({id:row.id,num:quantity(row.num,'商船奖励数量')}));
  if (reward.some(row=>typeof row.id!=='string'||!row.id)) throw new Error('商船奖励编号无效');
  return { shipId:raw.shipId, type:raw.type, state:raw.state, cabin, leaderId, leaderCond:array(raw.leaderCond,'船长条件'), reward,
    preparedEndTime:quantity(raw.preparedEndTime ?? 0,'准备结束时间'), mvEndTime:quantity(raw.mvEndTime ?? 0,'抵港时间'),
    voyageSeconds:cfg.time * 60, coins:reward.filter(row=>row.id==='水姆币').reduce((sum,row)=>sum+row.num,0) };
}

function candidateList(view, settings) {
  const pref = prefOf(settings), now = view.now;
  const final = pref.mode === 'full' && view.activityEndTime > now && dayOf(view.activityEndTime-1) === dayOf(now)
    && ((now+28800)%86400) >= 23*3600+25*60;
  const fallback = pref.mode === 'full' && now >= view.batch.start+20*60;
  const relaxed = fallback || final;
  const kinds = final ? [3,2,1] : pref.mode==='small' ? [1] : pref.mode==='mediumSmall' ? [2,1] : pref.mode==='mediumLarge' ? [3,2] : [3,2,1];
  const result=[];
  if (view.own.length >= view.maxShipNum) return result;
  const selected = [...view.ships].sort((a,b)=>kinds.indexOf(a.type)-kinds.indexOf(b.type)||a.shipId-b.shipId);
  for (const ship of selected) {
    if (!kinds.includes(ship.type) || ship.state!==1 || isSelf(ship,view.playerId)) continue;
    const threshold = ({1:pref.minCoinsSmall,2:pref.minCoinsMedium,3:pref.minCoinsLarge})[ship.type];
    if (!final && pref.coinFilter && ship.coins < threshold) continue;
    if (!relaxed && pref.rewardFilter && pref.rewardItems.length && !ship.reward.some(row=>pref.rewardItems.includes(row.id))) continue;
    const arrival = (ship.leaderId ? ship.preparedEndTime : now+view.prepareSeconds) + ship.voyageSeconds;
    // 在下一批刷新时保留至少一个可用队列；到港预测只用于保留，不覆盖服务端实际占用。
    if (!relaxed && ['redFirst','full'].includes(pref.mode) && ship.type<3 && arrival>view.batch.next
      && view.own.filter(row=>row.arrival>view.batch.next).length+1 >= view.maxShipNum) continue;
    if (ship.leaderId && ship.preparedEndTime>now && (pref.crew || relaxed)) {
      for (const cabin of ship.cabin) if (!cabin.playerId && cabin.costs.length && !cabin.costs.some(row=>pref.disabledMaterials.includes(row.id)))
        result.push({ kind:'crew', shipId:ship.shipId, crewId:cabin.crewId, type:ship.type, costs:cabin.costs, finalFallback:final,
          preparedEndTime:ship.preparedEndTime, stamp:digest([ship, cabin]), arrival });
    }
    if (!ship.leaderId && (pref.captain || relaxed)) {
      if (ship.type===3 && pref.redStartEnabled && !final) {
        if (!/^\d{2}:\d{2}$/.test(pref.redStartTime)) continue;
        const [h,m]=pref.redStartTime.split(':').map(Number);
        if (h>23 || m>59 || (now+28800)%86400<h*3600+m*60) continue;
      }
      if (ship.leaderCond.every(cond => {
        const hero=view.heroes.find(row=>row.heroId===cond.heroId);
        return hero && valid(hero.star) && valid(hero.exclusive?.star ?? 0) && valid(cond.star) && valid(cond.exStar)
          && hero.star+(hero.exclusive?.star ?? 0)>=cond.star+cond.exStar;
      })) result.push({kind:'captain',shipId:ship.shipId,type:ship.type,costs:[],finalFallback:final,preparedEndTime:0,stamp:digest(ship),arrival});
    }
  }
  // 全程兜底按图示先做船员，再申请船长；普通模式维持红→中→小。
  return relaxed ? result.sort((a,b)=>(a.kind==='crew'?0:1)-(b.kind==='crew'?0:1)) : result;
}

export async function readGuildShips(client, protocol, config, {player,getSettings=()=>({}),enabled=()=>true,inventory=true}={}) {
  const view={state:'blocked',reason:'',ships:[],own:[],candidates:[],requirements:[],now:nowOf(client)};
  const stamp=identity(player), playerId=exactAutomationId(player?.playerId), guildId=exactAutomationId(player?.guildId);
  const gate=rows(config,'ModuleOpenCfg').find(row=>row.moduleId==='联盟商船')?.playerLevel;
  if (!enabled()) return {...view,reason:'已暂停'};
  if (!valid(gate)||!valid(player?.level)) return {...view,reason:'商船开放条件未确认'};
  if(player.level<gate) return {...view,reason:`联盟商船在角色 ${gate} 级开放`};
  if(!playerId||!guildId||!exactAutomationId(player?.worldId)) return {...view,reason:'当前没有可确认的联盟身份'};
  const param=shipParameters(config,player);
  for(const name of ['GuildInfoRequest','GuildInfoResponse','GuildShipRequest','GuildShipResponse','AllHeroRequest','AllHeroResponse']) if(!protocol?.[name]) throw new Error('缺少真实协议 '+name);
  const guild=await client.request('GuildInfoRequest',{},'GuildInfoResponse');
  if(exactAutomationId(guild?.guild?.guildId)!==guildId||stamp!==identity(player)||!enabled()) throw new Error('联盟身份已变化');
  const reply=await client.request('GuildShipRequest',{},'GuildShipResponse');
  if(!valid(reply?.period)) throw new Error('商船活动期数未确认');
  if(reply.period===0)return {...view,reason:'联盟商船活动未开放'};
  const ships=array(reply.ship,'联盟商船列表').map(row=>normalizeShip(row,config));
  const ownRun=array(reply.ownRun,'我的在途商船').map(row=>normalizeShip(row,config));
  if(new Set(ships.map(row=>row.shipId)).size!==ships.length||new Set(ownRun.map(row=>row.shipId)).size!==ownRun.length)throw new Error('商船列表重复');
  const ownMap=new Map(ownRun.filter(row=>row.mvEndTime>view.now).map(row=>[row.shipId,row]));
  for(const ship of ships)if(isSelf(ship,playerId)&&!(ship.mvEndTime>0&&ship.mvEndTime<=view.now))ownMap.set(ship.shipId,ship);
  const own=[...ownMap.values()].map(ship=>({...ship,arrival:ship.mvEndTime||ship.preparedEndTime+ship.voyageSeconds}));
  const heroes=array((await client.request('AllHeroRequest',{},'AllHeroResponse'))?.heroes,'船长英雄');
  const observed=activityByClient.get(client)?.period;
  const activityEndTime=observed?.period===reply.period&&valid(observed.endTime)?observed.endTime:0;
  if(activityEndTime&&activityEndTime<=view.now)return {...view,reason:'服务器已确认商船活动结束'};
  Object.assign(view,{state:'ready',identity:stamp,playerId,guildId,worldId:exactAutomationId(player.worldId),ships,own,heroes,
    period:reply.period,maxShipNum:param.shipNum,prepareSeconds:param.duration*60,batch:guildShipBatch(view.now,param.time),activityEndTime});
  view.candidates=candidateList(view,getSettings());
  const ids=[...new Set(view.candidates.flatMap(row=>row.costs.map(cost=>cost.id)))];
  if(inventory&&ids.length){
    const inventoryState=await readOrderReservedStock(client,protocol,config,{player,enabled,itemIds:ids});
    for(const candidate of view.candidates)candidate.costs=candidate.costs.map(cost=>{
      const have=inventoryState.stock.get(cost.id)??0,reserved=inventoryState.reserved.get(cost.id)??0;
      const reserve=resourceReserve(getSettings(),cost.id),available=Math.max(0,have-reserved-reserve);
      return {...cost,have,reserved:reserved+reserve,available,missing:Math.max(0,cost.need-available)};
    });
  }
  if(!enabled()||stamp!==identity(player))throw new Error('账号或联盟已变化');
  return view;
}

export function guildShipDemands(view,settings,ledger){
  const pref=prefOf(settings);
  if(!pref.enabled||!pref.produceMissing||view?.state!=='ready')return [];
  if(ledger&&Object.values(ledger.keyRecords()).some(record=>!record.confirmed&&sameActor(record.details,view)&&record.details.kind?.startsWith('guildShip')))return [];
  const chosen=view.candidates.find(row=>row.kind==='crew'&&row.type===3);
  return chosen?[{source:'guildShip',requirements:chosen.costs.map(row=>({id:row.id,num:row.need})),
    reserved:chosen.costs.map(row=>({id:row.id,num:row.reserved??0}))}]:[];
}

function sameActor(details,view){return details?.worldId===view.worldId&&details?.playerId===view.playerId;}
function ownEvidence(view,details){
  if(view.period!==details.period||view.guildId!==details.guildId)return false;
  const ship=[...view.own,...view.ships].find(row=>row.shipId===details.shipId);
  return !!ship&&(details.kind==='guildShipCaptain'?ship.leaderId===view.playerId:ship.cabin.some(row=>row.crewId===details.crewId&&row.playerId===view.playerId));
}

export async function serviceGuildShips(client,protocol,config,{player,getSettings=()=>({}),enabled=()=>false,ledger,report=()=>{},scheduler}={}){
  const finish=entry=>{const result={key:'guildShip',label:'联盟商船',...entry};report(result);return result;};
  const active=()=>enabled()&&prefOf(getSettings()).enabled;
  const delay=seconds=>scheduler?.defer('guildShip',scheduler.now()+seconds);
  watchGuildShipPushes(client,scheduler);
  if(!active())return finish({skipped:true,reason:'联盟商船已关闭'});
  if(scheduler&&!scheduler.due('guildShip'))return finish({skipped:true,reason:'等待下次检查'});
  if(busy.has(client))return finish({skipped:true,reason:'正在核对联盟商船'});
  busy.add(client);
  try{
    if(!ledger)throw new Error('商船持久账本不可用');
    const initial=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active,inventory:false});
    if(initial.state!=='ready'){delay(180);return finish({skipped:true,reason:initial.reason});}
    for(const[key,record]of Object.entries(ledger.keyRecords()))if(!record.confirmed&&sameActor(record.details,initial)&&record.details.kind?.startsWith('guildShip')&&ownEvidence(initial,record.details))ledger.resolveKey(key,true);
    if(Object.values(ledger.keyRecords()).some(record=>!record.confirmed&&sameActor(record.details,initial)&&record.details.kind?.startsWith('guildShip'))){delay(60);return finish({skipped:true,pending:true,reason:'上次上船结果待确认，保留队列和材料，不重复申请'});}
    await refreshOrderMaterialSpends(client,player,{enabled:active});
    const first=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active});
    const eligible=view=>view.candidates.filter(row=>row.costs.every(cost=>cost.missing===0));
    const candidate=eligible(first)[0];
    if(!candidate){delay(60);return finish({skipped:true,reason:first.own.length>=first.maxShipNum?'游戏商船队列已满':'没有符合模式、奖励、材料和船长条件的空位',demands:guildShipDemands(first,getSettings())});}
    const policy=JSON.stringify(prefOf(getSettings()));
    const current=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active});
    const chosen=eligible(current).find(row=>row.kind===candidate.kind&&row.shipId===candidate.shipId&&row.crewId===candidate.crewId&&row.stamp===candidate.stamp);
    if(!chosen||!active()||current.identity!==initial.identity||policy!==JSON.stringify(prefOf(getSettings()))||current.batch.start!==first.batch.start)return finish({skipped:true,reason:'商船、材料或配置已变化，下一轮重新核对'});
    const previousFinal=Object.values(ledger.keyRecords()).some(record=>sameActor(record.details,current)&&record.details.period===current.period&&record.details.finalFallback);
    if(chosen.finalFallback&&previousFinal){delay(60);return finish({skipped:true,reason:'活动末日宽松兜底已申请过一船'});}
    const request=chosen.kind==='crew'?'GuildShipOrderRequest':'GuildShipSeekRequest';
    if(!protocol[request])throw new Error('缺少真实协议 '+request);
    const key=`guildShip:${current.worldId}:${current.playerId}:${current.period}:${current.batch.start}:${chosen.shipId}:${chosen.preparedEndTime}`;
    if(ledger.hasKey(key)){delay(60);return finish({skipped:true,reason:'该商船本批次已有申请记录，等待服务端刷新'});}
    const details={kind:chosen.kind==='crew'?'guildShipCrew':'guildShipCaptain',worldId:current.worldId,playerId:current.playerId,guildId:current.guildId,
      period:current.period,shipId:chosen.shipId,crewId:chosen.crewId??0,finalFallback:chosen.finalFallback};
    const ticket=ledger.reserve({}, {}, {},{uniqueKey:key,details});let debit;
    try{if(chosen.costs.length)debit=beginOrderMaterialSpend(player,chosen.costs,'联盟商船',{operation:{verify:async(next,{enabled:allowed})=>{
      if(!allowed())return false;return ownEvidence(await readGuildShips(next,protocol,config,{player,getSettings,enabled:allowed,inventory:false}),details);
    }}});}catch(error){ledger.cancel(ticket);throw error;}
    if(!active()||policy!==JSON.stringify(prefOf(getSettings()))||identity(player)!==current.identity||nowOf(client)>=current.batch.next
      ||(current.activityEndTime>0&&nowOf(client)>=current.activityEndTime)
      ||(chosen.kind==='crew'&&nowOf(client)>=chosen.preparedEndTime)){ledger.cancel(ticket);cancelOrderMaterialSpend(debit);return finish({skipped:true,reason:'发送前开关、批次或船位已变化'});}
    let sent=false;
    try{
      await client.sendWatch(request,{shipId:chosen.shipId,...(chosen.kind==='crew'?{crewId:chosen.crewId}:{})},{window:400});sent=true;
      const after=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active,inventory:false});
      if(!ownEvidence(after,details))throw new Error('服务端尚未确认本人船位');
      ledger.confirm(ticket);confirmOrderMaterialOperation(debit);await refreshOrderMaterialSpends(client,player,{enabled:active});delay(30);
      return finish({ok:true,label:`联盟商船 · 已${chosen.kind==='crew'?'担任船员':'申请船长'}（${['','紫船','橙船','红船'][chosen.type]} #${chosen.shipId}）`});
    }catch(error){const rejected=(!sent&&error.notSent===true)||error.prompt&&error.request===request;if(rejected){ledger.cancel(ticket);cancelOrderMaterialSpend(debit);}delay(60);return finish({ok:false,pending:!rejected,error:(rejected?'商船申请未执行：':'商船申请结果待确认，已保留记录：')+error.message});}
  }catch(error){delay(60);return finish({ok:false,error:error.message});}finally{busy.delete(client);}
}
