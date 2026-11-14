import {recordsInWorld} from './fleet-settlement.mjs';
import { fleetRecordReason, reserveDispatch, dispatchReservationReason } from './fleet-availability.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectHunt, startPirateHunt } from './pirates.mjs';
import { normalize } from './worlds.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';

// 汽油确认与终态在同一次账本写入中完成。迟到的行军消息不能覆盖已确认的战果。
export function savePirateOutcome(ledger, key, event) {
 const record = ledger.keyRecords()[key];
 if (!record || record.expired || ['won','lost'].includes(record.details?.outcome)) return;
 const details = { ...record.details, outcome:event.status };
 if (event.arrivalAt) details.arrivalAt = event.arrivalAt;
 if (event.ownBattle) details.ownBattle = true;
 if (event.battleAt) details.battleAt = event.battleAt;
 if (['started','won','lost'].includes(event.status)) ledger.resolveKey(key, true, details);
 else ledger.updateKeyDetails(key, details);
}

// 单次手动首杀与连续推进共用持久记录，防止回包延迟时其他玩法抢用同一队。
export async function runSinglePirateHunt(client,config,player,{targetKey,fleetKey,enabled,getSettings,ledger,report}) {
 let ticket,key;
 const update=event=>{
  if(key) savePirateOutcome(ledger,key,event);
  report?.(event);
 };
 try{
  const result=await startPirateHunt(client,config,player,{targetKey,fleetKey,enabled,report:update,
   reservationReason:fleet=>dispatchReservationReason(client,getSettings(),'pirateHunt',fleet.buildingId),beforeSend({view,target,fleet}){
   const settings=getSettings(),p=settings.pirateHunt;
   const reason=fleetRecordReason(ledger.keyRecords(),fleet.buildingId,String(normalize(player.worldId)))||dispatchReservationReason(client,settings,'pirateHunt',fleet.buildingId);
   if(reason)throw Error(reason);
   if(view.fuel-pendingPetrol(ledger)-view.fuelPerFleet<p.petrolReserve)throw Error('出征后汽油不足保留量');
   if(p.fuelBudget>0&&view.fuelPerFleet>p.fuelBudget)throw Error('本次首杀汽油预算不足');
   if(!Number.isSafeInteger(fleet.maxDura)||fleet.maxDura<=0||fleet.durability<fleet.maxDura*p.minDurabilityPercent/100)throw Error('舰队耐久低于首杀设置');
   const world=String(normalize(player.worldId));key='pirate-first:'+world+':'+target.type+':'+target.level+':'+target.uid;
   const prior=ledger.keyRecords()[key];if(prior?.confirmed&&prior.details?.outcome==='lost')ledger.releaseCompletedKey(key);
   ticket=ledger.reserve({piratePetrol:view.fuelPerFleet},{},{},{uniqueKey:key,details:{kind:'pirateFirst',world,type:target.type,level:target.level,uid:target.uid,grid:target.gridIdx,scenarioId:player.scenarioId||1,sentAt:Date.now()+(client.serverClockOffsetMs||0),buildingId:fleet.buildingId,outcome:'sent'}});
  }});
  update(result);return result;
 }catch(error){if(ticket&&(error.prompt&&error.request==='ChallengePirateRequest'||error.notSent===true))ledger.cancel(ticket);throw error;}
}

const sameOptions=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function selectPirateAdvance(snapshot,options,{spent=0,pendingFuel=0}={}) {
 const view=snapshot.view;
 if(view.locked || view.reason) return{reason:view.reason||'世界尚未开放'};
 const targets=view.targets.filter(t=>!options.types.length || options.types.includes(String(t.type)));
 const within=targets.filter(t=>!options.maxLevel || t.level<=options.maxLevel);
 if(!within.length)return{reason:targets.length?'已达到设置的首杀等级上限':'当前没有所选类型的下一等级海盗'};
 const target=[...within].filter(t=>!t.reason).sort((a,b)=>a.level-b.level || a.type-b.type)[0];
 if(!target)return{reason:within[0].reason||'没有可派遣目标'};
 const candidates=view.fleets.filter(f=>options.fleetIds.includes(f.buildingId));
 const fleet=candidates.find(f=>!f.reason && Number.isSafeInteger(f.maxDura) && f.maxDura>0 && f.durability>=Math.ceil(f.maxDura*options.minDurabilityPercent/100));
 if(!fleet)return{reason:candidates.find(f=>f.reason)?.reason||'所选舰队未就绪或耐久低于设置阈值'};
 if(!Number.isSafeInteger(pendingFuel)||pendingFuel<0)return{reason:'未确认出征的汽油占用异常'};
 if(view.fuel-pendingFuel-view.fuelPerFleet<options.petrolReserve)return{reason:'出征后汽油不足设置的保留量'};
 if(options.fuelBudget>0&&spent+view.fuelPerFleet>options.fuelBudget)return{reason:'本次首杀汽油预算已不足'};
 return{target,fleet,cost:view.fuelPerFleet};
}
export async function runPirateAdvance({client,config,player,options,ledger,getSettings,enabled,schedule=fn=>fn(),signal,onState=()=>{},sleep=ms=>delay(ms,undefined,{signal}),now=Date.now,prepareDispatch=async()=>{},checkpoint={},oneCheck=false,maxFailures=options.maxFailures??1}) {
 const world=String(normalize(player?.worldId));
 if(!/^[1-9]\d*$/.test(world) || !options.fleetIds.length)throw Error('请先设置参与海盗首杀的舰队');
 if(!ledger?.reserve)throw Error('未取得首杀出征确认记录');
 const prefix='pirate-first:'+world+':';
 const state=checkpoint.state??={wins:0,failures:0,spent:0,target:null,reason:'正在检查首杀目标'};
 let active=checkpoint.active??null, fuelCeiling=checkpoint.fuelCeiling??null;
 if(!Number.isSafeInteger(maxFailures)||maxFailures<1||maxFailures>100)throw Error('海盗失败停止次数必须为1–100的整数');
 const live=()=>!signal?.aborted && enabled() && sameOptions(options,getSettings().pirateHunt);
 const publish=()=>onState({...state});
 const update=(key,event)=>{
  if(active?.key===key)active.result=event.status;
  try {
   savePirateOutcome(ledger,key,event);
  } catch(error){state.reason='首杀记录保存失败：'+error.message;}
 };
 try {
 if(!state.halted&&state.failures>=maxFailures){state.halted=true;state.reason='本次首杀连续战败 '+state.failures+' 次，达到失败停止次数，已停止推进';}
 if(state.halted){publish();return state;}
 while(!signal?.aborted) {
  reserveDispatch(client,'pirateHunt',options.fleetIds,Date.now()+Math.max(60000,options.checkEverySeconds*3000));
  if(!enabled()){state.reason='账号已暂停或断开';break;}
  if(!sameOptions(options,getSettings().pirateHunt)){state.reason='首杀参数已修改，请重新开启推进';break;}
  const result=await schedule(async()=>{
   if(!live())return{stop:'执行条件已变化，停止推进'};
   await prepareDispatch();
   const snap=await inspectHunt(client,config,player);
   if(!live())return{stop:'执行条件已变化，停止推进'};
   if(!Array.isArray(snap.records)||!Array.isArray(snap.ownFleets))return{stop:snap.view.reason||'首杀记录或舰队信息不完整'};
   for(const [key,record]of Object.entries(ledger.keyRecords()).filter(([key])=>key.startsWith(prefix))) {
    const d=record.details;
    if(d && snap.records.some(r=>r.type===d.type && r.maxKilledLevel>=d.level))update(key,{status:'won'});
   }
   if(active) {
    const record=ledger.keyRecords()[active.key];const outcome=record?.details?.outcome??active.result;
    if(outcome==='unknown'){state.halted=true;return{stop:'出征或战果未确认，已停止并保留派遣记录'};}
    const fleet=snap.ownFleets.find(f=>f.buildingId===active.buildingId);
    if(outcome==='won'||outcome==='lost') {
     if(!active.counted){if(outcome==='won'){state.wins++;state.failures=0;}else state.failures++;active.counted=true;}
     if(outcome==='lost'&&state.failures>=maxFailures){state.halted=true;return{stop:'本次首杀连续战败 '+state.failures+' 次，达到失败停止次数，已停止推进'};}
     if(fleet?.state===1 && !fleet.curGridIdx && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs){active=null;}
     else {state.reason=outcome==='won'?'已确认首杀，等待舰队回城':'战败 '+state.failures+'/'+maxFailures+' 次，等待舰队回城后重试';return{wait:true};}
    } else {
     if(now()-active.sentAt>900000){state.halted=true;return{stop:'等待战果超时，已停止并保留派遣记录'};}
     state.reason=outcome==='started'||outcome==='ended'?'等待个人首杀记录更新':'等待服务器确认出征';return{wait:true};
    }
   }
   const unresolved=Object.values(ledger.keyRecords()).find(r=>r.details?.kind==='pirateFirst' && String(r.details.world)===world && !['won','lost'].includes(r.details.outcome));
   if(unresolved)return{stop:'前次首杀出征结果仍待确认，禁止重复派遣'};
   const pending=ledger.pendingCounters();
   if(fuelCeiling!==null && Number.isSafeInteger(snap.view.fuel))snap.view.fuel=Math.min(snap.view.fuel,fuelCeiling);
   for(const f of snap.view.fleets)f.reason ||= fleetRecordReason(ledger.keyRecords(),f.buildingId,world) || dispatchReservationReason(client,getSettings(),'pirateHunt',f.buildingId);
   const picked=selectPirateAdvance(snap,options,{spent:state.spent,pendingFuel:(pending.piratePetrol??0)+(pending.treasurePetrol??0)+(pending.cityWarPetrol??0)+(pending.radarPetrol??0)+(pending.worldBossPetrol??0)+(pending.siliconPetrol??0)});
   if(picked.reason)return{stop:picked.reason};
   const {target,fleet}=picked;
   const key=prefix+target.type+':'+target.level+':'+target.uid;
   const prior=ledger.keyRecords()[key];if(prior?.confirmed && prior.details?.outcome==='lost')ledger.releaseCompletedKey(key);
   let ticket,quotedFuel;
   const label=fleet.name+' → '+target.name+' '+target.level+'级';state.target=label;
   try {
    const reply=await startPirateHunt(client,config,player,{targetKey:target.targetKey,fleetKey:fleet.key,enabled:live,
     reservationReason:raw=>dispatchReservationReason(client,getSettings(),'pirateHunt',raw.buildingId),
     beforeSend({view,target:reviewed,fleet:raw}) {
      for(const f of view.fleets)f.reason ||= fleetRecordReason(ledger.keyRecords(),f.buildingId,world) || dispatchReservationReason(client,getSettings(),'pirateHunt',f.buildingId);
      if(fuelCeiling!==null && Number.isSafeInteger(view.fuel))view.fuel=Math.min(view.fuel,fuelCeiling);
      const check=selectPirateAdvance({view},options,{spent:state.spent,pendingFuel:(ledger.pendingCounters().piratePetrol??0)+(ledger.pendingCounters().treasurePetrol??0)+(ledger.pendingCounters().cityWarPetrol??0)+(ledger.pendingCounters().radarPetrol??0)+(ledger.pendingCounters().worldBossPetrol??0)+(ledger.pendingCounters().siliconPetrol??0)});
      if(check.reason || check.target?.uid!==reviewed.uid || check.fleet?.buildingId!==raw.buildingId || !live())throw Error(check.reason||'首杀目标或舰队已变化');
      if(Object.values(recordsInWorld(ledger.keyRecords(),world)).some(r=>!r.expired && r.details?.buildingId===raw.buildingId && (!r.confirmed||r.details?.kind==='radarSend'&&r.details.active!==false)))throw Error('舰队还有待确认任务');
      quotedFuel=view.fuel;
      ticket=ledger.reserve({piratePetrol:view.fuelPerFleet},{},{},{uniqueKey:key,details:{kind:'pirateFirst',world,type:target.type,level:target.level,uid:target.uid,grid:reviewed.gridIdx,scenarioId:player.scenarioId||1,sentAt:Date.now()+(client.serverClockOffsetMs||0),buildingId:raw.buildingId,outcome:'sent'}});
      active={key,buildingId:raw.buildingId,sentAt:now(),result:'sent',counted:false};
     },report:event=>update(key,event)});
    state.spent+=picked.cost;fuelCeiling=quotedFuel-picked.cost;update(key,reply);
    if(reply.status==='unknown')return{stop:reply.label};
    state.reason=reply.label;return{wait:true};
   } catch(error){if(ticket && (error.prompt&&error.request==='ChallengePirateRequest' || error.notSent===true))ledger.cancel(ticket);return{stop:error.message};}
  });
  if(result.stop){state.reason=result.stop;publish();break;}
  publish();if(oneCheck)break;await sleep(options.checkEverySeconds*1000);
 }
 if(signal?.aborted)state.reason=signal.reason?.message||'已停止首杀推进';
 publish();return state;
 } finally { checkpoint.active=active;checkpoint.fuelCeiling=fuelCeiling;reserveDispatch(client,'pirateHunt',[]); }
}
export function createPirateAdvanceTask() {
 let controller=null;let state={running:false,stopping:false,wins:0,spent:0,target:null,reason:'尚未开启'};
 const view=()=>({...state});
 return{view,start(options,open,report,maxFailures=1){
  if(controller)throw Error('当前账号已在推进海盗首杀');
  if(!options.fleetIds.length)throw Error('请先在游戏配置中选择首杀舰队');
  if(!Number.isSafeInteger(maxFailures)||maxFailures<1||maxFailures>100)throw Error('海盗失败停止次数必须为1–100的整数');
  controller=new AbortController();const signal=controller.signal;
  state={running:true,stopping:false,wins:0,spent:0,target:null,maxFailures,reason:'正在检查首杀条件'};
  (async()=>{try{const context=await open();await runPirateAdvance({...context,options:structuredClone(options),maxFailures,signal,onState:update=>{Object.assign(state,update);report?.(view());}});}catch(error){state.reason=signal.aborted?signal.reason.message:error.message;}finally{state.running=state.stopping=false;controller=null;report?.(view());}})();return view();
 },stop(reason='已手动停止首杀推进'){if(controller){state.stopping=true;controller.abort(new Error(reason));}return view();}};
}
