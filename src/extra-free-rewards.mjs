import { normalize } from './worlds.mjs';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { adAccess, takeAdSlot, prepareAd, coolAd, isAdNotFinished, AD_PACED_REASON, AD_NOT_FINISHED_REASON, AD_PAUSED_REASON } from './ad-shop.mjs';

const nowOf=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const dayOf=t=>Math.floor((t+28800)/86400);
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const clocks=new WeakMap();
export function watchFreeRewardClock(client){if(!clocks.has(client)){clocks.set(client,{vipDay:dayOf(nowOf(client)),festivalDay:dayOf(nowOf(client))});client.on?.('message',({name})=>{if(name==='SCAllActivity')clocks.get(client).festivalDay=dayOf(nowOf(client));if(name==='LoginResponse')clocks.get(client).vipDay=dayOf(nowOf(client));});}return clocks.get(client);}
const assets=reply=>normalize(reply?.reward)?.asset;
const hasReward=reply=>Array.isArray(assets(reply))&&assets(reply).some(a=>a.num>0);
const rows=(c,n)=>c?.tables?.[n]?.data??[];
export async function claimOnce(client,{ledger,key,title,request,body={},response='GotRewardResponse',enabled,verify=hasReward,report,details={}}){
 if(!enabled())return false;
 if(!ledger){report({label:title,skipped:true,reason:'领取记录不可用'});return false;}
 if(ledger.hasKey(key)){report({label:title,skipped:true,status:ledger.keyRecords()[key].confirmed?'confirmed':'pending',reason:ledger.keyRecords()[key].confirmed?'该领取记录已确认，等待服务器状态同步':'前次领取结果待确认，未重复提交'});return false;}
 const ticket=ledger.reserve({},{},{},{uniqueKey:key,details:{...details,kind:'freeReward',request}});
 if(!enabled()){ledger.cancel(ticket);return false;}
 try{const reply=await client.request(request,body,response);if(!await verify(reply))throw Error('服务器尚未确认领取成功');ledger.confirm(ticket);report({label:title,ok:true,status:'confirmed'});return reply;}
 catch(error){if(error.prompt&&error.request===request)ledger.cancel(ticket);report({label:title,ok:false,status:error.prompt&&error.request===request?'rejected':'unknown',error:error.message});return false;}
}
export async function claimVipDaily(client,config,{player,enabled,ledger,report,allLevels=false}){
 if(!enabled())return;
 const clock=watchFreeRewardClock(client),day=dayOf(nowOf(client)),vip=player?.vip;
 if(!vip||!valid(vip.vipLevel)||!Array.isArray(vip.dailyReward)){report({label:'VIP每日免费礼包',skipped:true,reason:'VIP每日领取状态未确认'});return;}
 // 原客户端跨日只重置当前VIP档位，低档首次礼包状态保留。
 if(clock.vipDay!==day){vip.dailyReward=vip.dailyReward.filter(r=>r.vipLevel!==vip.vipLevel);clock.vipDay=day;}
 const levels=allLevels?rows(config,'VipFreeCfg').filter(r=>valid(r.level)&&r.level<=vip.vipLevel).map(r=>r.level):[vip.vipLevel];
 for(const level of levels){
 const cfg=rows(config,'VipFreeCfg').find(r=>r.level===level);
 if(!cfg||vip.dailyReward.some(r=>r.vipLevel===level&&r.isGot)){report({label:'VIP每日免费礼包',skipped:true,reason:cfg?'今日礼包已领取':'当前VIP档位没有免费礼包配置'});continue;}
 const vipLevel=vip.vipLevel;
 const allowed=()=>enabled()&&dayOf(nowOf(client))===day&&player.vip.vipLevel===vipLevel;
 const reply=await claimOnce(client,{ledger,key:'vip-free:'+day+':'+level,title:'VIP '+level+' 每日免费礼包',request:'GotVipDailyRewardRequest',body:{vipLevel:level},enabled:allowed,report});
 if(reply&&allowed()){const got=vip.dailyReward.find(r=>r.vipLevel===level);if(got)got.isGot=true;else vip.dailyReward.push({vipLevel:level,isGot:true});}
 }
}
export function limitedFreeCandidates(config,player,type){
 const typeNames={1:'日礼包',2:'周礼包',3:'月礼包',4:'赛季礼包'};
 let packs=rows(config,'LimitedPackCfg').filter(r=>r.type===typeNames[type]);
 if(type===4){
  const world=exactAutomationId(player?.worldId),season=world?Math.floor(Number(world)/1e6)%1000:0;
  if(!valid(season)||season<1)return [];
  const selected=Math.max(0,...packs.filter(r=>valid(r.season)&&r.season<=season).map(r=>r.season));
  if(selected<1)return [];packs=packs.filter(r=>r.season===selected);
 }
 const vip=player?.vip?.vipLevel;
 return packs.filter(r=>r.price===0&&r.limitedTimes>0&&!(r.weekDay>0)&&valid(r.vipLevel??0)&&(r.vipLevel??0)<=(valid(vip)?vip:0));
}
export async function claimLimitedFree(client,config,{player,enabled,ledger,report}){
 const typeNames={1:'日礼包',2:'周礼包',3:'月礼包',4:'赛季礼包'};
 if(!ledger){report({label:'商城限购免费礼包',skipped:true,status:'pending',reason:'领取记录不可用'});return;}
 for(const type of [1,2,3,4]){
  if(!enabled())return;
  const candidates=limitedFreeCandidates(config,player,type);if(!candidates.length)continue;
  const read=()=>client.request('LimitedShopRequest',{type},'LimitedShopResponse');let state;
  try{state=await read();}catch(error){report({label:'限购商城 · '+typeNames[type],skipped:true,reason:error.message});continue;}
  if(!Array.isArray(state?.shopItem))throw Error('限购商城状态不完整');
  // 原客户端用配置补齐服务器省略的未领条目，缺少条目表示gotTimes=0，不是礼包未开放。
  const itemFor=(snapshot,id)=>{const found=snapshot.shopItem?.filter(item=>item.id===id);if(!Array.isArray(found)||found.length>1)throw Error('限购礼包记录未完整或重复');return found[0]??{id,gotTimes:0,charge:0};};
  const freeItems=candidates.map(cfg=>itemFor(state,cfg.id));
  if(freeItems.some(item=>!valid(item.gotTimes)))throw Error('限购领取次数未确认');
  const reset=valid(state.resetTime)&&state.resetTime>0?state.resetTime:'day'+dayOf(nowOf(client));
  for(const item of freeItems){const key='limited-free:'+type+':'+reset+':'+item.id;if(item.gotTimes>0&&ledger.keyRecords()[key]?.confirmed===false)ledger.resolveKey(key,true);}
  if(freeItems.every(item=>item.gotTimes>0)){report({label:'限购商城 · '+typeNames[type],skipped:true,reason:'当前免费礼包已领取'});continue;}
  for(const item of freeItems){
   if(item.gotTimes!==0||!enabled())continue;
   const fresh=await read();const current=itemFor(fresh,item.id);
   if(!valid(current.gotTimes)||current.gotTimes!==0||fresh.resetTime!==state.resetTime)continue;
   const prior=Object.entries(ledger.keyRecords()).filter(([key,r])=>key.startsWith('limited-free:'+type+':')&&key.endsWith(':'+item.id)&&!r.confirmed);
   if(prior.length){report({label:'限购商城 · '+typeNames[type],skipped:true,status:'pending',reason:'前次免费礼包结果未确认，重置时间变化也不重复领取'});continue;}
   const claimDay=dayOf(nowOf(client));
   await claimOnce(client,{ledger,key:'limited-free:'+type+':'+reset+':'+item.id,title:'限购商城 · '+typeNames[type]+'免费礼包',request:'LimitedShopGotFreeRequest',body:{type,id:item.id},enabled,report,
    verify:async reply=>{if(!hasReward(reply))return false;const after=await read();return dayOf(nowOf(client))===claimDay&&after.resetTime===fresh.resetTime&&itemFor(after,item.id).gotTimes>0;}});
  }
 }
}
export async function claimWeekHeroStar(client,config,{enabled,ledger,report}){
 if(!enabled())return;
 const schedule=await client.request('WeekInfoRequest',{},'WeekInfoResponse');
 const event=schedule.activityTime?.find(r=>r.type===3&&r.startTime<=nowOf(client)&&nowOf(client)<r.endTime);if(!event){report({label:'升星达标奖励',skipped:true,reason:'当前升星达标活动未开放'});return;}
 const period=rows(config,'WeekHeroStarPeriodCfg').find(r=>r.periodId===event.period);if(!period)throw Error('升星达标活动期数未确认');
 const allowed=()=>enabled()&&event.startTime<=nowOf(client)&&nowOf(client)<event.endTime;
 const read=()=>client.request('WeekHeroStarInfoRequest',{},'WeekHeroStarInfoResponse');let state=await read();
 for(let limit=0;limit<100&&allowed();limit++){
  if(!valid(state.gotStage))throw Error('升星达标已领档位未确认');
  const tier=rows(config,'WeekHeroStarRwdCfg').find(r=>r.periodId===event.period&&r.rwdId===state.gotStage+1);if(!tier){report({label:'升星达标奖励',skipped:true,reason:'本期档位奖励已全部领取'});return;}
  const heroes=(await client.request('AllHeroRequest',{},'AllHeroResponse')).heroes;if(!Array.isArray(heroes))throw Error('英雄星级状态未确认');
  const a=heroes.find(h=>h.heroId===period.showHero1),b=heroes.find(h=>h.heroId===period.showHero2);
  if(!a||!b||![a.star,b.star,tier.hero1Star,tier.hero2Star].every(valid)||a.star<tier.hero1Star||b.star<tier.hero2Star){report({label:'升星达标奖励',skipped:true,reason:'指定英雄星级尚未达到第 '+tier.rwdId+' 档要求'});return;}
  const reply=await claimOnce(client,{ledger,key:'week-star:'+event.startTime+':'+event.period+':'+tier.rwdId,title:'升星达标第 '+tier.rwdId+' 档奖励',request:'WeekHeroStarGotRewardRequest',response:'WeekHeroStarGotRewardResponse',enabled:allowed,report,
   verify:async r=>r.gotStage===tier.rwdId&&(await read()).gotStage>=tier.rwdId});
  if(!reply)return;state=await read();
 }
}
function linked(row){return row?.type==='捞尸人联动活动'||row?.subActivity?.some(s=>[28,29,30].includes(s.subActivityType));}
function liveSub(row,type,now){return row.startTime<=now&&now<row.endTime&&(row.subActivity??[]).find(s=>s.subActivityType===type&&(s.openTime||row.startTime)>0&&(s.openTime||row.startTime)<=now&&(!s.closeTime||now<s.closeTime));}
export async function claimLinkageFree(client,config,{player,enabled,ledger,report}){
 const clock=watchFreeRewardClock(client),today=dayOf(nowOf(client));
 if(clock.festivalDay!==today){for(const event of client.festivals??[])if(linked(event))for(const sub of event.subActivity??[])if(sub.dailyCombGift)sub.dailyCombGift.boughtGiftId=[];clock.festivalDay=today;}
 for(const row of client.festivals??[]){
  if(!linked(row))continue;const id=exactAutomationId(row.activityId);if(!id)continue;
  const day=dayOf(nowOf(client));const active=()=>client.festivals?.find(r=>exactAutomationId(r.activityId)===id);
  if(enabled('festivalSign')){
   const sub=liveSub(row,11,nowOf(client));const data=sub?.dailyActive;
   if(data&&Array.isArray(data.checkInId)){
    const openDay=day-dayOf(sub.openTime||row.startTime)+1;
    const cfg=rows(config,'LinkageLSRSignCfg').find(r=>r.signDay===openDay);
    // 过去日期属于补签，可能花钻石，绝不代签。
    if(cfg&&!data.checkInId.includes(cfg.rewardId)){
     const allowed=()=>enabled('festivalSign')&&dayOf(nowOf(client))===day&&!!liveSub(active()??{},11,nowOf(client));
     const reply=await claimOnce(client,{ledger,key:'lsr-sign:'+id+':'+cfg.rewardId,title:'酆都诡事 · 今日免费签到',request:'ClaimActivityDailyCheckInRewardRequest',response:'ClaimActivityDailyCheckInRewardResponse',body:{activityId:automationWireId(id),checkId:cfg.rewardId},enabled:allowed,report,verify:r=>Array.isArray(r.checkId)&&r.checkId.includes(cfg.rewardId)});
     if(reply&&allowed())liveSub(active(),11,nowOf(client)).dailyActive.checkInId=[...reply.checkId];
    }
   }
  }
  if(enabled('festivalFreeGift')){
   const sub=liveSub(row,6,nowOf(client)),data=sub?.dailyCombGift;if(!data||!Array.isArray(data.boughtGiftId))continue;
   const season=Math.floor(Number(player?.worldId?.toString?.()??player?.worldId)/1e6)%1000;
   const eligible=rows(config,'LinkageLSRDailyDealCfg').filter(r=>r.season>0&&r.season<=season),chosen=Math.max(0,...eligible.map(r=>r.season));
   for(const cfg of eligible.filter(r=>r.season===chosen&&r.price===0&&!r.chargeId)){
    if(data.boughtGiftId.includes(cfg.packId))continue;
    const allowed=()=>enabled('festivalFreeGift')&&dayOf(nowOf(client))===day&&!!liveSub(active()??{},6,nowOf(client));
    const reply=await claimOnce(client,{ledger,key:'lsr-free:'+id+':'+day+':'+cfg.packId,title:'酆都诡事 · 每日特惠免费礼包',request:'ClaimDailyCombGiftRequest',body:{activityId:automationWireId(id),giftId:cfg.packId},enabled:allowed,report});
    if(reply&&allowed())data.boughtGiftId.push(cfg.packId);
   }
  }
 }
}
export async function recruitWithSkipAds(client,config,{player,clientInfo,language,enabled,ledger,report,scheduler,getSettings}){
 for(const [key,id,kind,request,response]of [['heroAdRecruit',2,'hero','RecruitStartRequest','RecruitStartResponse'],['antiqueAdRecruit',7,'antique','AntiqueRecruitRequest','AntiqueRecruitResponse']]){
  if(!enabled(key))continue;const title=kind==='hero'?'英雄免广告招募':'藏品免广告招募';
  const access=await adAccess(client,config.tables,{player,clientInfo,language,settings:getSettings?.()});
  if(access.reason){report({label:title,skipped:true,reason:access.reason});continue;}
  const day=dayOf(nowOf(client)),limit=rows(config,'AdvEffectCfg').find(r=>r.id===id)?.dailyLimit;
  if(!valid(limit)||limit<1||limit>10)throw Error('广告招募每日次数未确认');
  const allowed=()=>enabled(key)&&dayOf(nowOf(client))===day;
  for(let n=0;n<limit&&allowed();n++){
   const water=await client.request('OnWaterRequest',{},'OnWaterResponse');
   const effects=water.adv?.filter(e=>e.id===id);if(!effects||effects.length!==1||!valid(effects[0].gotTimes)){report({label:title,skipped:true,reason:'今日广告招募次数未完整返回'});break;}
   const used=effects[0].gotTimes;if(used>=limit)break;
   const before=(await client.request('RecruitInfoRequest',{},'RecruitInfoResponse'))?.[kind];if(!valid(before?.recruitTimes))throw Error('招募次数未确认');
   const unresolved=Object.entries(ledger.keyRecords()).filter(([savedKey,r])=>!r.confirmed&&r.details?.kind==='adRecruit'&&r.details.id===id&&savedKey.startsWith('ad-recruit:'+day+':'));
   for(const [savedKey,r]of unresolved)if(used===r.details.used+1 && (before.recruitTimes===r.details.recruitTimes+1 || valid(r.details.taskTimes)&&before.task?.times===r.details.taskTimes+1))ledger.resolveKey(savedKey,true);
   if(unresolved.some(([savedKey])=>!ledger.keyRecords()[savedKey].confirmed)){report({label:title,skipped:true,reason:'前次广告准备或招募结果未确认，暂停后续次数'});break;}
   const uniqueKey='ad-recruit:'+day+':'+id+':'+used;
   if(ledger.hasKey(uniqueKey)){report({label:title,skipped:true,reason:'前次免广告招募结果待核对，未重复提交'});break;}
   if(!takeAdSlot(client,access,{target:'effect:'+id})){report({label:title,skipped:true,reason:AD_PACED_REASON});break;}
   const ticket=ledger.reserve({},{},{},{uniqueKey,details:{kind:'adRecruit',id,used,recruitTimes:before.recruitTimes,taskTimes:valid(before.task?.times)?before.task.times:null}});
   if(!allowed()){ledger.cancel(ticket);break;}
   let drawSent=false;
   try{
    if(!await prepareAd(client,access,{type:1,id},allowed)){
     if(!access.waitMs)throw Error('广告准备已完成，招募已暂停，等待核对');
     ledger.cancel(ticket);report({label:title,skipped:true,reason:AD_PAUSED_REASON});break;
    }
    drawSent=true;const reply=await client.request(request,kind==='hero'?{way:5}:{type:1,way:5},response);
    const after=(await client.request('RecruitInfoRequest',{},'RecruitInfoResponse'))?.[kind];
    const counter=(await client.request('OnWaterRequest',{},'OnWaterResponse')).adv?.find(e=>e.id===id);
    if(!reply?.recruitData||!(after?.recruitTimes===before.recruitTimes+1 || valid(before.task?.times)&&after?.task?.times===before.task.times+1)||counter?.gotTimes!==used+1)throw Error('招募或广告次数未确认，已阻止重复提交');
    ledger.confirm(ticket);scheduler?.clear(kind==='hero'?'heroRecruitRewards':'antiqueRecruitRewards');report({label:title+' · 今日 '+(used+1)+'/'+limit,ok:true});
   }catch(error){
    if(isAdNotFinished(error)){ledger.cancel(ticket);coolAd(client,'effect:'+id);report({label:title,skipped:true,reason:AD_NOT_FINISHED_REASON});break;}
    if(error.prompt&&!drawSent&&error.request==='WatchAdvRequest')ledger.cancel(ticket);
    report({label:title,ok:false,error:error.message});break;
   }
  }
 }
}
