// 跟随只使用当前连接实际收到的舰队状态。推送是增量，不把未出现的舰队推断为返航。
import {exactAutomationId} from './automation-policy.mjs';
const watches=new WeakMap();
const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const signature=f=>[f.playerId,f.buildingId,f.startedAt,f.arriveAt,f.uid,f.targetGrid].join(':');
export function watchTreasureTravel(client){
 if(watches.has(client))return watches.get(client);
 const fleets=new Map(),listeners=new Set();
 const ingest=raw=>{
  if(!Array.isArray(raw))return;const time=now(client);
  for(const item of raw){
   const id=exactAutomationId(item.owner?.playerId);
   if(!id||!/^\d+远征船$/.test(item.buildingId??''))continue;
   const key=id+':'+item.buildingId,previous=fleets.get(key);
   const row={playerId:id,name:item.owner?.nickname||'',buildingId:item.buildingId,state:item.state,uid:item.treasureLootUid??0,targetGrid:item.targetGridIdx??0,startGrid:item.startGridIdx??0,startedAt:item.moveStartTs??0,arriveAt:item.moveEndTs??0,seenAt:time,guildId:exactAutomationId(item.owner?.guildId)};
   if(row.state===2&&(!valid(row.startedAt)||!row.startedAt||!valid(row.arriveAt)||row.arriveAt<=time||row.startedAt>time+30||!valid(row.targetGrid)||!row.targetGrid))continue;
   // 已确认结束的同一段旧行军不能被迟到快照重新激活。
   if(row.state===2&&previous&&(row.startedAt<previous.latestStart||previous.fleet.state!==2&&row.startedAt<=previous.latestStart))continue;
   const changed=row.state===2&&(!previous||signature(previous.fleet)!==signature(row));
   fleets.set(key,{fleet:row,latestStart:Math.max(previous?.latestStart??0,row.startedAt)});
   if(changed)for(const listener of listeners)listener(row);
  }
  for(const[key,entry]of fleets)if(time-entry.fleet.seenAt>300)fleets.delete(key);
 };
 const watcher={ingest,current(){const time=now(client);return [...fleets.values()].map(e=>e.fleet).filter(f=>f.state===2&&f.arriveAt>time&&time-f.seenAt<=45);},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},clear(){fleets.clear();}};
 client.on?.('message',({name,body})=>{if(['SCFleet','WorldInfoResponse'].includes(name))ingest(body?.fleets);});
 client.on?.('close',()=>watcher.clear());watches.set(client,watcher);return watcher;
}
export function matchesFollowDeparture(fleet,preferences,ownId,others=[]){
 if(!preferences?.follow||fleet.playerId===ownId||fleet.state!==2)return false;
 if((preferences.followPlayerIds??[]).includes(fleet.playerId))return true;
 if(!(preferences.followNames??[]).includes(fleet.name))return false;
 // 同名出发者无法用昵称消歧时等待，不随便跟随第一人。
 return new Set(others.filter(f=>f.name===fleet.name).map(f=>f.playerId)).size<=1;
}
