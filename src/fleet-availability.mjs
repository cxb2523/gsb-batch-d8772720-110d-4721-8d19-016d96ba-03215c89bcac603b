import { recordsInWorld, settleFleetSnapshot } from './fleet-settlement.mjs';
import { isFleetReserved, registerFleetReservations } from './fleet-reservations.mjs';

const migrationOwner = 'dispatch-ledger';
// 两代调度器共享舰队占用证据；桥接谓词忽略自身，避免递归检查。
export function bridgeFleetReservations(client, getSettings, ledger, worldId) {
 const contains = id => Boolean(fleetRecordReason(ledger?.keyRecords() ?? {}, id, worldId) ||
  dispatchReservationReason(client, getSettings(), 'legacy', id, {ignoreLegacy:true}));
 const hasAny = () => {
  const ids = new Set(Object.values(recordsInWorld(ledger?.keyRecords() ?? {}, worldId))
   .map(record => record.details?.buildingId).filter(Boolean));
  for (const record of dispatchStates.get(client)?.values() ?? []) for (const id of record.ids) ids.add(id);
  return [...ids].some(contains);
 };
 registerFleetReservations(client, migrationOwner, contains, hasAny);
}
// 配置勾选只表示允许使用；实际占用依据舰队状态与持久化在途记录判断。
export function fleetRecordReason(records,buildingId,worldId){
 for(const [key,r]of Object.entries(recordsInWorld(records??{},worldId))){
  if(r.expired||r.details?.buildingId!==buildingId)continue;
  if(!r.confirmed)return '舰队有结果待确认的任务';
  if(r.details.kind==='worldBoss'&&r.details.active!==false)return '舰队的世界Boss首战尚未结束';
  if(r.details.kind==='siliconDispatch'&&r.details.active!==false)return '舰队的硅矿任务尚未结束';
  if(['siliconRepair','siliconRetreat','siliconSpeed'].includes(r.details.kind)&&r.details.active!==false)return '舰队的硅矿操作尚未结束';
  if(r.details.kind==='radarSend'&&r.details.active!==false)return '舰队的联盟情报尚未结束';
  if(r.details.kind==='pirateFirst'&&!['won','lost'].includes(r.details.outcome))return '舰队的首杀战果尚未确认';
  if(key.startsWith('cityWar:'))return '舰队的城战任务尚未结束';
 }
 return '';
}

// 同一连接共享城战时段预留和正在启动的手动首杀；不抢占在途任务。
const dispatchStates = new WeakMap();
export const dispatchLabels={maintenance:'战后维修',cityWar:'城战接续',pirateHunt:'海盗讨伐 / 首杀',worldBoss:'世界Boss首战',follow:'巨轮跟随',treasure:'巨轮普通参战',radar:'联盟情报',silicon:'硅矿采集'};
export function reconcileBossFleets(ledger,fleets,worldId){
 if(!Array.isArray(fleets))return;
 if(!worldId){
   const worlds=new Set(Object.keys(ledger.keyRecords()).filter(k=>k.startsWith('world-boss:')).map(k=>k.split(':')[1]));
   if(worlds.size!==1)return;
   [worldId]=worlds;
 }
 settleFleetSnapshot(ledger,{worldId,fleets,kinds:['worldBoss']});
}
export function fleetDispatchView(client,settings,ledger,fleets,worldId){
 const order=dispatchOrder(settings),time=Date.now();
 return fleets.map(f=>{
  const intents=order.filter(k=>{
   if(k==='silicon')return settings?.silicon?.enabled&&settings.silicon.fleets?.some(policy=>policy.enabled&&policy.id===f.buildingId);
   if(k==='pirateHunt')return dispatchStates.get(client)?.get(k)?.until>time&&dispatchStates.get(client).get(k).ids.includes(f.buildingId);
   const p=settings[k==='follow'?'treasure':k];
   if(!p?.enabled||k==='follow'&&!p.follow||k==='treasure'&&p.follow)return false;
   return p.fleetIds?.includes(f.buildingId)||k==='worldBoss'&&!p.fleetIds?.length;
  });
  const held=[...(dispatchStates.get(client)??[])].filter(([,r])=>r.until>time&&r.ids.includes(f.buildingId)).map(([k])=>dispatchLabels[k]);
  const reason=fleetRecordReason(ledger.keyRecords(),f.buildingId,worldId)|| (f.state!==1||f.curGridIdx||f.treasureLootUid||f.chipWar?.rewardTs?'舰队已有在途或驻守任务':'');
  return {buildingId:f.buildingId,intents:intents.map(k=>({key:k,label:dispatchLabels[k]})),reserved:held,reason,targetGrid:f.state===2?f.targetGridIdx:f.curGridIdx||null};
 });
}
export const dispatchOrder = settings => [...new Set([...(settings?.fleetDispatch?.priority ?? []),'cityWar','pirateHunt','worldBoss','follow','treasure','radar','silicon'])];
export function reserveDispatch(client, task, ids, until = Date.now()+60000) {
 const state=dispatchStates.get(client)??new Map();dispatchStates.set(client,state);
 state.set(task,{ids:[...ids],until});
}
export function legacyFleetReservationReason(client,id) {
 return isFleetReserved(client,id,migrationOwner) ? '舰队有原自动任务尚未确认结束' : '';
}
export function dispatchReservationReason(client,settings,task,id,{ignoreOwners=[],ignoreLegacy=false}={}) {
 const legacyReason=ignoreLegacy?'':legacyFleetReservationReason(client,id);
 if(legacyReason)return legacyReason;
 const order=dispatchOrder(settings);
 for(const [owner,record] of dispatchStates.get(client)??[]) {
  if(ignoreOwners.includes(owner))continue;
  if(owner==='cityWar'&&(!settings?.cityWar?.enabled||!settings.cityWar.reserveDuringWar))continue;
  if(owner==='cityWar'&&!settings.cityWar.fleetIds.includes(id))continue;
  if(owner===task || record.until<=Date.now() || !record.ids.includes(id))continue;
  if(owner==='maintenance'||owner==='cityWar' || order.indexOf(owner)<(order.includes(task)?order.indexOf(task):order.length))return '舰队预留给'+({maintenance:'战后维修',cityWar:'城战时段',pirateHunt:'正在运行的首杀',treasure:'巨轮普通参战',follow:'巨轮跟随',worldBoss:'世界Boss首战',radar:'联盟情报',silicon:'硅矿采集'}[owner]);
 }
 return '';
}
