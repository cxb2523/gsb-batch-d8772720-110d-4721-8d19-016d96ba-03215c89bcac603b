import { fleetRecordReason, dispatchReservationReason } from './fleet-availability.mjs';
import { resourceReserve } from './automation-policy.mjs';

export const pendingPetrol = ledger => ['radarPetrol','piratePetrol','treasurePetrol','cityWarPetrol','worldBossPetrol','siliconPetrol'].reduce((n,k)=>n+(ledger.pendingCounters()[k]??0),0);
export function planRadarPreview(snapshot, settings, ledger, client, {cityReservedFleetIds=null}={}) {
 const p=settings.radar, notes=[],actions=[];
 let fuel=snapshot.fuel-pendingPetrol(ledger),used=ledger.snapshot().counters.radarPetrol??0;
 const stock=new Map(snapshot.stock);
 const fleets=snapshot.fleets.map(f=>({...f,reason:fleetRecordReason(ledger.keyRecords(),f.buildingId,snapshot.world)||(cityReservedFleetIds?.includes(f.buildingId)?'城战时段预留':dispatchReservationReason(client,settings,'radar',f.buildingId,{ignoreOwners:cityReservedFleetIds===null?[]:['cityWar']}))||
  (!p.fleetIds.includes(f.buildingId)?'未选择':f.state!==1||f.curGridIdx||f.treasureLootUid||f.chipWar?.rewardTs?'舰队已有任务':!Number.isSafeInteger(f.maxDura)||f.maxDura<=0||f.durability<=0||f.durability<f.maxDura*p.minDurabilityPercent/100?'耐久不足或未同步':!snapshot.buildings.some(b=>b.buildingId===f.buildingId&&b.level>0&&b.fleet?.formation?.heroPositions?.some(x=>x.heroId))?'缺少编队':'')}));
 if(!p.enabled)notes.push('联盟情报自动处理未开启');
 const idle=fleets.filter(f=>!f.reason);
 for(const e of snapshot.events){
  if(e.state===4&&p.enabled)actions.push({kind:'radarClaim',label:'领取已完成情报 '+e.eventId,costs:[]});
  if(e.state!==1||!p.enabled||!p.types.includes(e.fixed?'fixed':e.pirate?'pirate':e.refugee?'refugee':e.collectRes?'collect':'spy'))continue;
  const key='radar-send:'+snapshot.world+':'+(e.fixed?'fixed-'+e.eventId+'-'+e.createTime:e.uid);
  let reason=ledger.hasKey(key)?'前次请求已记录，等待核对':!idle.length?'没有空闲且符合条件的舰队':fuel-snapshot.cost<p.petrolReserve?'汽油库存低于保留量':p.dailyPetrolLimit>0&&used+snapshot.cost>p.dailyPetrolLimit?'每日情报预算不足':'';
  const materials=e.refugee?.requirements??[];
  if(materials.length&&(!p.allowMaterials||materials.some(x=>x.id==='RUBY'||!Number.isSafeInteger(x.num)||x.num<0||(stock.get(x.id)??0)-x.num<resourceReserve(settings,x.id))))reason||='未允许交付或材料不足';
  if(reason){notes.push('情报 '+e.eventId+'：'+reason);continue;}
  const fleet=idle.shift();fuel-=snapshot.cost;used+=snapshot.cost;
  for(const item of materials)stock.set(item.id,(stock.get(item.id)??0)-item.num);
  actions.push({kind:'radarSend',label:fleet.buildingId+' → 情报 '+e.eventId,costs:[{id:'汽油',num:snapshot.cost},...materials]});
 }
 if(!actions.length&&!notes.length)notes.push('当前没有可执行的情报');
 return{actions,notes,fleets};
}
