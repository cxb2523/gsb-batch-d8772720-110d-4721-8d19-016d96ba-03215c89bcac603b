import {readTreasureLoot,planTreasureLoot} from './treasure-loot.mjs';
import {readCityWar,planCityWar,cityWarReservedFleets} from './city-war.mjs';
import {readAllianceRadar} from './alliance-radar.mjs';
import {planRadarPreview,pendingPetrol} from './dispatch-preview.mjs';
import {inspectHunt} from './pirates.mjs';
import {selectPirateAdvance} from './pirate-advance.mjs';
import {fleetRecordReason,dispatchReservationReason,fleetDispatchView} from './fleet-availability.mjs';
import {readWorldBoss} from './world-boss.mjs';
import {exactAutomationId} from './automation-policy.mjs';

// 目标详情仅使用已保存设置和局部快照；不写预留、设置或用量。
export async function readWorldTarget(client,protocol,config,player,settings,ledger,{layer,key,pirateSpent=0}){
 if(!['cities','treasure','radar','pirates','boss','fleets','fields'].includes(layer)||typeof key!=='string'||key.length>100)throw Error('地图目标无效');
 const view={checkedAt:Math.floor(Date.now()/1000),actions:[],notes:[],fleets:[],fuel:null,cost:null};
 const blocked=(task,id)=>fleetRecordReason(ledger.keyRecords(),id,exactAutomationId(player.worldId))||dispatchReservationReason(client,settings,task,id);
 let reserved=[];
 if(settings.cityWar.enabled&&settings.cityWar.reserveDuringWar&&['treasure','radar','pirates','boss'].includes(layer)){
  const war=await readCityWar(client,protocol,config,player,settings.cityWar);reserved=war.reason?[...settings.cityWar.fleetIds]:cityWarReservedFleets(war,settings);
 }
 if(layer==='fields'){view.notes.push('资源田他人归属未同步；本工具当前没有资源田自动派遣入口，不推测可进攻条件。');return view;}
 if(layer==='fleets'){
  const own=await client.request('MyFleetsRequest',{},'MyFleetsResponse');
  view.fleets=fleetDispatchView(client,settings,ledger,own.fleets??[],exactAutomationId(player.worldId)).filter(f=>'fleet-'+f.buildingId===key).map(f=>({name:f.buildingId,reason:[f.reason,...f.reserved.map(r=>'预留给'+r),'允许任务顺序：'+(f.intents.map(i=>i.label).join(' → ')||'无'),'当前目标格：'+(f.targetGrid??'主城')].filter(Boolean).join('；')}));return view;
 }
 if(layer==='boss'){
  const state=await readWorldBoss(client,config,player,settings,ledger,{cityReservedFleetIds:reserved});view.fuel=state.fuel;view.cost=state.cost;view.fleets=state.fleets.map(f=>({name:f.buildingId,reason:reserved.includes(f.buildingId)?'城战时段预留':f.reason}));view.notes.push(state.reason||'今日首战尚未派遣');if(!settings.worldBoss.enabled)view.notes.push('世界Boss自动首战未开启');return view;
 }
 if(layer==='pirates'){
  const state=await inspectHunt(client,config,player),target=state.view.targets.find(t=>'pirate-'+String(t.uid)===key);
  view.fuel=state.view.fuel;view.cost=state.view.fuelPerFleet;
  for(const f of state.view.fleets)f.reason||=(!settings.pirateHunt.fleetIds.includes(f.buildingId)?'未选择此舰队':'')||blocked('pirateHunt',f.buildingId)||(reserved.includes(f.buildingId)?'城战时段预留':'');
  view.fleets=state.view.fleets;
  if(!target)view.notes.push('此目标不是当前可首杀的下一等级，或目标已变化');
  else{const picked=selectPirateAdvance({...state,view:{...state.view,targets:[target]}},settings.pirateHunt,{spent:pirateSpent,pendingFuel:pendingPetrol(ledger)});view.notes.push(picked.reason||'目标符合当前首杀条件；需单独启动首杀');if(!picked.reason)view.actions.push({label:picked.fleet.name+' → '+target.name,costs:[{id:'汽油',num:picked.cost}]});}
  return view;
 }
 if(layer==='radar'){
  const state=await readAllianceRadar(client,config,player);state.events=state.events.filter(e=>'radar-'+String(e.uid??e.eventId)===key);
  if(!state.events.length){view.notes.push('目标情报已变化或不在当前列表');return view;}
  const plan=planRadarPreview(state,settings,ledger,client,{cityReservedFleetIds:reserved});Object.assign(view,{...plan,fuel:state.fuel,cost:state.cost,fleets:plan.fleets.map(f=>({...f,name:f.buildingId}))});return view;
 }
 if(layer==='treasure'){
  const uidText=key.replace(/^treasure-/,'');const uid=Number(uidText);if(!/^[1-9]\d*$/.test(uidText)||!Number.isSafeInteger(uid)||uid>2147483647)throw Error('巨轮标识无效');
  const state=await readTreasureLoot(client,protocol,config,player,{targetUid:uid,preferences:settings.treasure});state.targets=state.targets.filter(t=>t.uid===uid);
  if(!state.targets.length&&state.allUids.includes(uid))view.notes.push(settings.treasure.onlyTenThousand!==false?'已开启只抢万吨货轮，此目标不是已确认的万吨货轮，保持等待':'此货轮类型未能由游戏协议与配置共同确认，保持等待');
  const plan=planTreasureLoot(state,config,settings,{usage:ledger.snapshot(),keys:ledger.keyRecords(),pendingFuel:pendingPetrol(ledger),reservedFleetIds:reserved});
  const task=settings.treasure.follow?'follow':'treasure';
  plan.fleets.forEach((f,i)=>f.reason||=blocked(task,settings.treasure.fleetIds[i]));
  plan.actions=plan.actions.filter(a=>!blocked(task,a.buildingId));
  return {...view,...plan,notes:[...view.notes,...plan.notes],cost:state.fuelPerFleet};
 }
 const state=await readCityWar(client,protocol,config,player,settings.cityWar),id=Number(key.replace(/^city-/,''));
 const target=state.targets.find(t=>t.id===id);
 if(!target&&!state.reason)view.notes.push('此城市不是本联盟当前有效宣战目标');
 else if(settings.cityWar.targetMode==='selected'&&!settings.cityWar.cityRefs.includes(target.ref))view.notes.push('此城市不在已保存的目标范围');
 state.targets=target?[target]:[];
 const plan=planCityWar(state,settings,{usage:ledger.snapshot(),keys:ledger.keyRecords(),pendingPetrol:pendingPetrol(ledger)});
 return {...view,...plan,notes:[...view.notes,...plan.notes],cost:target?.petrol??null};
}
