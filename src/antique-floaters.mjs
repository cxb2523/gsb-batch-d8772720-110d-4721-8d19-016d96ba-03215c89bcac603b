import { createHash } from 'node:crypto';
import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';

const states=new WeakMap();
const nowOf=client=>Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000);
// 客户端打捞动作持续10秒，发现后至少等待同样时长再交回宝箱。
export async function collectAntiqueFloaters(client,config,{enabled,report,ledger,dryRun=false,now=()=>nowOf(client)}={}) {
 if(!enabled())return;
 const state=states.get(client)??{seen:new Map(),denied:new Map(),busy:false};states.set(client,state);
 if(state.busy)return;
 state.busy=true;
 const label='海面藏品宝箱打捞', skip=reason=>report({label,skipped:true,reason});
 try {
  const rows=(config?.tables?.GarbageProductionCfg?.data??[]).filter(r=>r.type==='打捞' && typeof r.production?.[0]==='string' && r.production[0].startsWith('藏品') && r.production[0].endsWith('碎片'));
  const read=async()=>{
   const reply=await client.request('OnWaterRequest',{},'OnWaterResponse');
   if(!Array.isArray(reply?.floater))throw Error('未能确认海面漂浮物');
   const result=[];
   for(const f of reply.floater){const cfg=rows.find(r=>r.id===f.floaterId);if(!cfg)continue;if(!Number.isSafeInteger(f.num)||f.num<0)throw Error('藏品宝箱数量未确认');if(f.num>0)result.push({id:f.floaterId,num:f.num,cfg});}
   return result;
  };
  const items=await read();
  if(!items.length){if(!dryRun)state.seen.clear();return;}
  if(dryRun){report({planned:true,action:{kind:'antiqueFloaters',label:'打捞海面藏品宝箱（当前 '+items.reduce((sum,x)=>sum+x.num,0)+' 个，每轮最多1个）',costs:[]}});return;}
  if(!ledger) {skip('未能读取打捞确认记录');return;}
  for(const id of state.seen.keys())if(!items.some(x=>x.id===id))state.seen.delete(id);
  const item=items.find(x=>(state.denied.get(x.id)??0)<=now());if(!item)return;
  const key='antique-floater:'+createHash('sha256').update(item.id).digest('hex').slice(0,20);
  const record=ledger.keyRecords()[key];
  if(record && !record.confirmed){skip('前次藏品宝箱打捞结果待确认，暂停此类宝箱重试');return;}
  if(record?.confirmed)ledger.releaseCompletedKey(key);
  if(!state.seen.has(item.id))state.seen.set(item.id,now());
  if(now()-state.seen.get(item.id)<10){skip('已发现藏品宝箱，等待打捞完成后交回');return;}
  const fresh=(await read()).find(x=>x.id===item.id);
  if(!fresh || !enabled()){state.seen.delete(item.id);return;}
  const ticket=ledger.reserve({}, {}, {}, {uniqueKey:key,details:{kind:'antiqueFloater',floaterId:item.id,countBefore:fresh.num}});
  if(!enabled()){ledger.cancel(ticket);return;}
  try {
   const reply=await client.request('PickUpFloaterRequest',{floaterId:[item.id]},'PickUpFloaterResponse');
   if(reply?.deniedFloaterIds?.includes(item.id)){ledger.cancel(ticket);state.denied.set(item.id,now()+1800);state.seen.delete(item.id);skip('游戏拒绝打捞此宝箱，稍后再检查');return;}
   const assets=normalize(reply?.reward)?.asset;
   if(!Array.isArray(assets)||!assets.some(x=>x.id===item.cfg.production[0] && x.num>=item.cfg.production[1]))throw Error('未收到藏品碎片奖励确认，已阻止重复打捞');
   ledger.confirm(ticket);state.seen.delete(item.id);
   report({label:'已打捞海面藏品宝箱，获得'+assets.map(x=>displayMaterial(config,x.id)+' ×'+x.num).join('、'),ok:true});
  } catch(error){if(error.prompt && error.request==='PickUpFloaterRequest'){ledger.cancel(ticket);state.denied.set(item.id,now()+1800);}throw error;}
 } finally {state.busy=false;}
}
