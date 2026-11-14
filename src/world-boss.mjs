import { rewardData } from './missing-rewards.mjs';
import { claimOnce } from './extra-free-rewards.mjs';
import { fleetRecordReason, dispatchReservationReason, reserveDispatch, reconcileBossFleets } from './fleet-availability.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';
import { exactAutomationId } from './automation-policy.mjs';

const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const day=t=>Math.floor((t+28800)/86400);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const read=(c,n)=>c.request(n+'Request',{},n+'Response').then(rewardData);
function dailyCount(counters,time){
 if(!Array.isArray(counters))throw Error('世界Boss每日计数未同步');
 const matches=counters.filter(r=>r.type==='DAILY_WORLD_BOSS_TIMES');
 if(matches.length>1)throw Error('世界Boss每日计数重复');
 if(!matches.length)return 0;
 const r=matches[0];if(!integer(r.num)||!integer(r.updateTime)||r.updateTime>time)throw Error('世界Boss每日计数无效');
 if(r.num>0&&r.updateTime===0)throw Error('世界Boss计数日期未确认');
 return day(r.updateTime)===day(time)?r.num:0;
}
export async function readWorldBoss(client,config,player,settings,ledger,{cityReservedFleetIds=null}={}){
 const snapshot={checkedAt:now(client),boss:null,count:null,fleets:[],fuel:null,cost:null,reason:''};
 const required=config?.tables?.ModuleOpenCfg?.data?.find(r=>r.moduleId==='世界')?.playerLevel;
 if(!required||!(player?.level>=required))return {...snapshot,reason:'尚未确认世界玩法开放'};
 const [boss,counters,own,water,bag]=await Promise.all(['WorldBossInfo','CounterInfo','MyFleets','OnWater','AllItem'].map(n=>read(client,n)));
 snapshot.boss=boss.info;snapshot.count=dailyCount(counters.counters,snapshot.checkedAt);
 if(!boss.info||!integer(boss.info.bossId)||boss.info.bossId<1||!integer(boss.info.gridIdx)||boss.info.gridIdx<1)snapshot.reason='当前没有开放的世界Boss';
 if(![own.fleets,water.building,bag.items].every(Array.isArray))throw Error('世界Boss派遣所需舰队、建筑或库存未同步');
 const fuel=bag.items.filter(r=>r.itemId==='汽油');
 snapshot.fuel=fuel.every(r=>integer(r.num))?fuel.reduce((n,r)=>n+r.num,0):null;
 snapshot.cost=config?.tables?.WorldParamCfg?.data?.find(r=>r.paramName==='进攻首领消耗汽油')?.paramValue;
 if(!integer(snapshot.fuel)||!integer(snapshot.cost))snapshot.reason||='世界Boss汽油消耗未确认';
 const p=settings.worldBoss;
 snapshot.fleets=own.fleets.map(f=>({...f,reason:
  (p.fleetIds.length&&!p.fleetIds.includes(f.buildingId)?'未选择此舰队':'')||
  fleetRecordReason(ledger.keyRecords(),f.buildingId,exactAutomationId(player.worldId))||(cityReservedFleetIds?.includes(f.buildingId)?'城战时段预留':dispatchReservationReason(client,settings,'worldBoss',f.buildingId,{ignoreOwners:cityReservedFleetIds===null?[]:['cityWar']}))||
  (!/^\d+远征船$/.test(f.buildingId)?'舰队编号未确认':f.state!==1||f.curGridIdx||f.treasureLootUid||f.chipWar?.rewardTs?'舰队正在执行其他任务':
   !integer(f.maxDura)||f.maxDura<1||!integer(f.durability)||f.durability<=0||f.durability<f.maxDura*p.minDurabilityPercent/100?'耐久不足或未同步':
   !water.building.some(b=>b.buildingId===f.buildingId&&b.level>0&&b.fleet?.formation?.heroPositions?.some(h=>h.heroId))?'缺少已保存的编队':'')}));
 if(snapshot.count===0&&ledger.hasKey('world-boss:'+exactAutomationId(player.worldId)+':'+day(snapshot.checkedAt)))snapshot.reason||='今日首战已提交，结果待核对，未重复派遣';
 if(snapshot.count>0)snapshot.reason||='今日世界Boss首战已完成派遣';
 if(!snapshot.reason&&snapshot.fuel-pendingPetrol(ledger)-snapshot.cost<p.petrolReserve)snapshot.reason='出征后汽油不足保留量';
 if(!snapshot.reason&&!snapshot.fleets.some(f=>!f.reason))snapshot.reason='没有空闲且符合条件的舰队';
 return snapshot;
}
export async function runWorldBoss(client,config,player,{getSettings,ledger,enabled,report}){
 const label='世界Boss每日首战';
 if(!enabled()||!getSettings().worldBoss.enabled)return;
 const settings=getSettings(),state=await readWorldBoss(client,config,player,settings,ledger);
 reconcileBossFleets(ledger,state.fleets,exactAutomationId(player.worldId));
 const key='world-boss:'+exactAutomationId(player.worldId)+':'+day(state.checkedAt);
 if(state.count>0&&ledger.hasKey(key)&&!ledger.keyRecords()[key].confirmed)ledger.resolveKey(key,true);
 if(state.reason){report({label,skipped:true,reason:state.reason});return state;}
 if(ledger.hasKey(key)){report({label,skipped:true,status:ledger.keyRecords()[key].confirmed?'confirmed':'pending',reason:'今日首战已提交，等待每日计数或战报确认，未重复派遣'});return state;}
 const id=state.fleets.find(f=>!f.reason).buildingId;
 reserveDispatch(client,'worldBoss',[id]);
 try{
  const fresh=await readWorldBoss(client,config,player,getSettings(),ledger);
  if(!enabled()||settings!==getSettings()||day(now(client))!==day(state.checkedAt))return state;
  if(fresh.reason||fresh.boss.bossId!==state.boss.bossId||fresh.boss.gridIdx!==state.boss.gridIdx||!fresh.fleets.some(f=>f.buildingId===id&&!f.reason)){report({label,skipped:true,reason:fresh.reason||'出征前Boss或舰队状态已变化'});return fresh;}
  const ticket=ledger.reserve({worldBossPetrol:fresh.cost},{},{},{uniqueKey:key,details:{kind:'worldBoss',buildingId:id,bossId:fresh.boss.bossId,grid:fresh.boss.gridIdx,day:day(state.checkedAt),sentAt:fresh.checkedAt,active:true}});
  try{
   const held=dispatchReservationReason(client,getSettings(),'worldBoss',id);
   if(!enabled()||client.connected===false||settings!==getSettings()||!getSettings().worldBoss.enabled||day(now(client))!==day(state.checkedAt)||held){
    ledger.cancel(ticket);report({label,skipped:true,reason:held||'发送前账号、设置或日期已变化，出征已取消'});return fresh;
   }
   await client.request('ChallengeWorldBossRequest',{bossId:fresh.boss.bossId,fleetBuildingIds:[id]},'OkResponse');
   const [counter,own]=await Promise.all([read(client,'CounterInfo'),read(client,'MyFleets')]);
   const fleet=own.fleets?.find(f=>f.buildingId===id);
   const confirmed=dailyCount(counter.counters,now(client))>0||fleet&&([2,3].includes(fleet.state))&&(fleet.targetGridIdx===fresh.boss.gridIdx||fleet.curGridIdx===fresh.boss.gridIdx);
   if(!confirmed)throw Error('首战请求已发送，但每日计数或舰队目标尚未确认');
   ledger.confirm(ticket);reconcileBossFleets(ledger,own.fleets,exactAutomationId(player.worldId));report({label:label+' · '+id,ok:true,status:'confirmed',reason:'服务器已确认首战派遣；战果和奖励后续核对'});
  }catch(error){if(error.prompt&&error.request==='ChallengeWorldBossRequest')ledger.cancel(ticket);report({label,ok:false,status:error.prompt?'rejected':'unknown',error:error.message});}
  return fresh;
 }finally{reserveDispatch(client,'worldBoss',[]);}
}
export async function claimWorldBossDamage(client,config,{player,enabled,ledger,report}){
 const label='世界Boss伤害达标奖励',state=(await read(client,'WorldBossInfo')).info;
 if(!state||!integer(state.bossId)||state.bossId===0){report({label,skipped:true,reason:'当前没有开放的世界Boss'});return;}
 if(!integer(state.bestDamage)||!integer(state.gotRewardLevel))throw Error('世界Boss伤害及已领档位未确认');
 const season=Math.floor(Number(exactAutomationId(player.worldId))/1e6)%1000;
 const tiers=config?.tables?.WorldBossDamageRewardCfg?.data?.filter(r=>r.season===season&&r.bossId===state.bossId&&r.damage<=state.bestDamage&&r.level>state.gotRewardLevel)??[];
 if(!tiers.length){report({label,skipped:true,reason:'最高伤害 '+state.bestDamage+'，已领至第 '+state.gotRewardLevel+' 档'});return;}
 const target=Math.max(...tiers.map(r=>r.level)),today=day(now(client));
 await claimOnce(client,{ledger,key:'world-boss-damage:'+today+':'+state.bossId+':'+target,title:label,request:'WorldBossGetDamageRewardRequest',enabled:()=>enabled()&&day(now(client))===today,report,verify:async r=>{
  const after=(await read(client,'WorldBossInfo')).info;return r.reward?.asset?.some(a=>Number(a.num)>0)&&after?.bossId===state.bossId&&after.gotRewardLevel>=target;
 }});
}
