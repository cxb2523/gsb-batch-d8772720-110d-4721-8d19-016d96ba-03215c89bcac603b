import { radarEvents, radarKey, radarDispatchConfirmed, settleFleetSnapshot, recordsInWorld } from './fleet-settlement.mjs';
export { radarDispatchConfirmed } from './fleet-settlement.mjs';
import { fleetRecordReason, legacyFleetReservationReason } from './fleet-availability.mjs';
import { normalize } from './worlds.mjs';
import { exactAutomationId, automationWireId, resourceReserve } from './automation-policy.mjs';
const nowOf=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const valid=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const busy=new WeakSet();
export async function readAllianceRadar(client,config,player){
 const world=exactAutomationId(player?.worldId),guild=exactAutomationId(player?.guildId);
 const required=config.tables.ModuleOpenCfg?.data?.find(r=>r.moduleId==='联盟情报')?.playerLevel;
 if(!world||!guild||!required||player.level<required)throw Error('联盟情报尚未开放或未加入联盟');
 const [reply,own,water,rawBag,merge]=await Promise.all([
  client.request('RadarInfoRequest',{},'RadarInfoResponse'),client.request('MyFleetsRequest',{},'MyFleetsResponse'),client.request('OnWaterRequest',{},'OnWaterResponse'),client.request('AllItemRequest',{},'AllItemResponse'),client.request('UniteWorldsPlanRequest',{},'UniteWorldsPlanResponse')]);
 if(!Array.isArray(reply?.radarInfo?.events)||!Array.isArray(own.fleets)||!Array.isArray(water.building)||!Array.isArray(rawBag.items)||!Array.isArray(merge.worldIds))throw Error('情报、舰队或库存状态未完整返回');
 if(exactAutomationId(player.worldId)!==world||exactAutomationId(player.guildId)!==guild)throw Error('角色或联盟身份已变化');
 const now=nowOf(client),day=t=>Math.floor((t+28800)/86400);
 if((merge.matchMaking||merge.worldIds.length&&merge.executeTs>0)&&(now>=merge.executeTs-3600||day(now)===day(merge.executeTs)))throw Error('合服期间暂停情报派遣');
 const events=radarEvents(reply.radarInfo);
 if(!events)throw Error('情报身份或状态未确认');
 const stock=new Map(normalize(rawBag).items.map(x=>[x.itemId,x.num])),fuel=stock.get('汽油')??0;
 const cost=config.tables.WorldParamCfg?.data?.find(r=>r.paramName==='情报事件消耗汽油')?.paramValue;
 if(!valid(fuel)||!valid(cost,1))throw Error('情报派遣汽油费用未确认');
 return {world,guild,events,fleets:own.fleets.map(f=>normalize({...f,state:f.state,durability:f.durability,maxDura:f.maxDura,curGridIdx:f.curGridIdx})),buildings:water.building,stock,fuel,cost};
}
const eventKey=(_snapshot,event)=>radarKey(event);
export async function runAllianceRadar(client,config,player,{getSettings,ledger,enabled,report,canUseFleet=()=>true}){
 if(!enabled()||!getSettings()?.radar.enabled||busy.has(client))return;busy.add(client);
 const note=reason=>report({label:'联盟情报',skipped:true,reason});
 try{
  if(!ledger)throw Error('情报额度记录不可用');
  const baseline=ledger.keyRecords();
  let s=await readAllianceRadar(client,config,player);
  const changes=settleFleetSnapshot(ledger,{worldId:s.world,fleets:s.fleets,events:s.events,baseline,kinds:['radarSend']});
  for(const change of changes)report({label:change.reason==='确认情报派遣'?'已确认前次联盟情报派遣':'已释放返航舰队的情报占用',ok:true,reason:change.reason});
  for(const e of s.events.filter(e=>e.state===4)){
   if(!enabled()||!getSettings().radar.enabled)return;
   const key='radar-claim:'+s.world+':'+eventKey(s,e);if(ledger.hasKey(key))continue;
   const ticket=ledger.reserve({},{},{},{uniqueKey:key,details:{kind:'radarClaim'}});
   try{const reply=await client.request('RadarGetRewardRequest',e.fixed?{}:{uid:automationWireId(e.uid)},'GotRewardResponse');
    if(!normalize(reply?.reward)?.asset?.length)throw Error('情报奖励回执未确认');ledger.confirm(ticket);report({label:'已领取完成的联盟情报奖励',ok:true});
   }catch(error){if(error.prompt&&error.request==='RadarGetRewardRequest')ledger.cancel(ticket);report({label:'联盟情报领奖',ok:false,error:error.message});}
  }
  const settings=getSettings(),p=settings.radar;
  if(!p.fleetIds.length){note('未选择情报舰队，仅领取已完成奖励');return;}
  const events=s.events.filter(e=>e.state===1&&p.types.includes(e.fixed?'fixed':e.pirate?'pirate':e.refugee?'refugee':e.collectRes?'collect':'spy'));
  if(!events.length){note('没有允许处理的待办情报');return;}
  const usedFleets=new Set(),attempted=new Set(),sentCosts=new Map(),stockCeiling=new Map(s.stock);
  for(const r of Object.values(recordsInWorld(ledger.keyRecords(),s.world)))if(r.details?.kind==='radarSend'&&r.details.active!==false)for(const [id,cap]of Object.entries(r.details.materialCeilings??{}))if(valid(cap))stockCeiling.set(id,Math.min(stockCeiling.get(id)??0,cap));
  let fuelCeiling=s.fuel;
  // 请求逐个复核并提交，舰队在游戏内并行行动，不等待前一队完成。
  for(let slot=0;slot<p.fleetIds.length;slot++){
  s=await readAllianceRadar(client,config,player);
  if(!enabled()||settings!==getSettings())return;
  s.fuel=Math.min(s.fuel,fuelCeiling);
  for(const [id,cap]of stockCeiling)if(s.stock.has(id))s.stock.set(id,Math.min(s.stock.get(id),cap));
  const records=recordsInWorld(ledger.keyRecords(),s.world);
  const fleet=s.fleets.find(f=>p.fleetIds.includes(f.buildingId)&&canUseFleet(f.buildingId)&&!legacyFleetReservationReason(client,f.buildingId)&&!usedFleets.has(f.buildingId)&&f.state===1&&!f.curGridIdx&&!f.treasureLootUid&&!f.chipWar?.rewardTs&&valid(f.maxDura,1)&&f.durability>0&&f.durability>=Math.ceil(f.maxDura*p.minDurabilityPercent/100)&&s.buildings.some(b=>b.buildingId===f.buildingId&&b.level>0&&b.fleet?.formation?.heroPositions?.some(x=>x.heroId))&&!fleetRecordReason(records,f.buildingId));
  if(!fleet){note('所选舰队忙碌、被高优先级任务预留、缺编队、耐久不足或有待确认任务');return;}
  let chosen;
  for(const old of events){const e=s.events.find(x=>x.uid===old.uid&&x.eventId===old.eventId&&x.fixed===old.fixed&&x.state===1);if(!e)continue;
   const key='radar-send:'+s.world+':'+eventKey(s,e);if(ledger.hasKey(key)||attempted.has(key))continue;
   const requirements=e.refugee?.requirements??[];
   if(requirements.length&&(!p.allowMaterials||requirements.some(x=>x.id==='RUBY'||!valid(x.num)||!valid(s.stock.get(x.id)??0)||(s.stock.get(x.id)??0)-x.num<resourceReserve(settings,x.id))))continue;
   chosen={e,key};break;
  }
  if(!chosen){note('情报材料不足、未允许耗材或前次请求待确认');return;}
  const pending=ledger.pendingCounters(),reserved=(pending.radarPetrol??0)+(pending.piratePetrol??0)+(pending.treasurePetrol??0)+(pending.cityWarPetrol??0) + (pending.worldBossPetrol ?? 0) + (pending.siliconPetrol ?? 0);
  const ownPending=[...sentCosts].reduce((sum,[key,cost])=>sum+(!ledger.keyRecords()[key]?.confirmed?cost:0),0);
  if(s.fuel-Math.max(0,reserved-ownPending)-s.cost<p.petrolReserve){note('出征后汽油低于保留量');return;}
  if(p.dailyPetrolLimit>0&&(ledger.snapshot().counters.radarPetrol??0)+s.cost>p.dailyPetrolLimit){note('每日情报汽油预算不足，停止新增派遣');return;}
  const ticket=ledger.reserve({radarPetrol:s.cost},{radarPetrol:p.dailyPetrolLimit||undefined},{},{uniqueKey:chosen.key,details:{kind:'radarSend',buildingId:fleet.buildingId,eventKey:eventKey(s,chosen.e),active:true,materialCeilings:Object.fromEntries((chosen.e.refugee?.requirements??[]).map(item=>[item.id,(s.stock.get(item.id)??0)-item.num]))}});
  if(!enabled()||settings!==getSettings()||legacyFleetReservationReason(client,fleet.buildingId)){ledger.cancel(ticket);return;}
  const body={...(chosen.e.fixed?{}:{uid:automationWireId(chosen.e.uid)}),fleetBuildingIds:[fleet.buildingId]};
  usedFleets.add(fleet.buildingId);attempted.add(chosen.key);
  let charged=false;const charge=()=>{if(charged)return;charged=true;fuelCeiling=s.fuel-s.cost;sentCosts.set(chosen.key,s.cost);for(const item of chosen.e.refugee?.requirements??[])stockCeiling.set(item.id,(s.stock.get(item.id)??0)-item.num);};
  const fleetNote='远征舰队 '+fleet.buildingId.replace('远征船','')+' 队';
  try{await client.sendWatch('RadarSendFleetsRequest',body,{window:600});charge();const after=await readAllianceRadar(client,config,player);
   const fresh=after.events.find(e=>eventKey(after,e)===eventKey(s,chosen.e));
   if(!radarDispatchConfirmed(after,fresh,fleet.buildingId)){report({label:'联盟情报派遣',note:fleetNote,status:'pending',reason:'请求已提交，等待服务器确认；暂保留汽油与舰队记录，不重复派遣'});continue;}
   ledger.confirm(ticket);report({label:'已派遣舰队处理联盟情报',note:fleetNote,ok:true});
  }catch(error){if(error.prompt&&error.request==='RadarSendFleetsRequest'){ledger.cancel(ticket);report({label:'联盟情报派遣',ok:false,error:error.message});}else {charge();report({label:'联盟情报派遣',note:fleetNote,status:'pending',reason:'请求结果待核对，保留汽油与舰队记录：'+error.message});}}
  }
 }finally{busy.delete(client);}
}
