import {createHash} from 'node:crypto';
import { normalize } from './worlds.mjs';
import { claimOnce } from './extra-free-rewards.mjs';
import { exactAutomationId, automationWireId } from './automation-policy.mjs';

const signature=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const rows=(config,name)=>config?.tables?.[name]?.data??[];
const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const day=c=>Math.floor((now(c)+28800)/86400);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const season=p=>Math.floor(Number(exactAutomationId(p?.worldId))/1e6)%1000;
// protobuf 默认的0/false位于原型上；保留这些值，编号始终保持精确字符串。
export function rewardData(value,key=''){
 if(value==null||typeof value!=='object')return value;
 if(typeof value.low==='number'&&typeof value.high==='number')return ['uid','activityId','worldId','playerId'].includes(key)?exactAutomationId(value):normalize(value);
 if(Array.isArray(value))return value.map(v=>rewardData(v));
 const out={};for(const k in value)if(typeof value[k]!=='function')out[k]=rewardData(value[k],k);return out;
}
const read=(c,name,body={})=>c.request(name+'Request',body,name+'Response').then(rewardData);
const reward=r=>r?.reward?.asset?.some(a=>Number(a.num)>0)||['hero','antique','equipIds','badge','tickets','supply'].some(k=>r?.[k]?.length>0);
const wait=(report,label,reason)=>report({label,skipped:true,reason});
export const weekActivityNames={1:'勇士战令',2:'累计充值',3:'英雄升星',4:'幸运转盘',5:'周订单',6:'芯片活动',7:'周翻牌'};
export async function readWeekCalendar(client){
 const data=await read(client,'WeekInfo');
 if(!Array.isArray(data.activityTime))throw Error('活动日历未完整返回');
 return data.activityTime.map(r=>({...r,name:weekActivityNames[r.type]||'周活动 '+r.type,stage:now(client)<r.startTime?'即将开始':now(client)<r.endTime?'进行中':'已结束'}));
}
export async function claimOpenRank(client,config,{player,enabled,ledger,report},type){
 const ranks={1:['订单榜达标奖励','OpenRankOrderTaskCfg'],2:['闯关榜达标奖励','OpenRankStageTaskCfg'],3:['剿匪榜达标奖励','OpenRankPirateTaskCfg'],4:['杀敌榜达标奖励','OpenRankWarTaskCfg']};
 const [label,table]=ranks[type],readState=()=>read(client,'OpenRankInfo',{type});
 const state=await readState();
 if(!integer(state.progress)||!Array.isArray(state.gotRewardId)||!integer(state.endTime))throw Error(label+'状态未完整返回');
 if(now(client)>=state.endTime)return wait(report,label,'本期活动未开放或已结束');
 const all=rows(config,table),s=season(player),chosen=all.some(r=>r.season===s)?s:Math.max(0,...all.map(r=>r.season??0));
 const eligible=all.filter(r=>(r.season===undefined||r.season===chosen)&&integer(r.score)&&r.score<=state.progress&&!state.gotRewardId.includes(r.score));
 if(!eligible.length)return wait(report,label,'当前进度 '+state.progress+'，暂无未领取的达标档位');
 for(const tier of eligible){
  if(!enabled()||now(client)>=state.endTime)break;
  const fresh=await readState();if(fresh.endTime!==state.endTime||fresh.gotRewardId.includes(tier.score)||fresh.progress<tier.score)continue;
  await claimOnce(client,{ledger,key:'rank:'+type+':'+state.endTime+':'+tier.score,title:label+' · '+tier.score,request:'GotOpenRankRewardRequest',body:{type,id:tier.score},enabled:()=>enabled()&&now(client)<state.endTime,report,verify:async r=>reward(r)&&(await readState()).gotRewardId.includes(tier.score)});
 }
}
export async function claimFestivalActive(client,config,{enabled,ledger,report}){
 const label='酆都诡事签到活跃奖励';let found=false;
 for(const event of client.festivals??[]){
  if(event.type!=='捞尸人联动活动'&&!event.subActivity?.some(s=>[28,29,30].includes(s.subActivityType)))continue;
  const sub=event.subActivity?.find(s=>s.subActivityType===11),id=exactAutomationId(event.activityId),data=sub?.dailyActive;
  const allowed=()=>enabled()&&now(client)>=(sub?.openTime||event.startTime)&&now(client)<(sub?.closeTime||event.endTime);
  if(!id||!allowed())continue;found=true;
  if(!data||!integer(data.activeScore)||!integer(data.claimedRewardId))throw Error(label+'状态未同步');
  let count=0;
  while(allowed()&&count++<100){
   const tiers=rows(config,'LinkageLSRActiveRewardCfg').filter(r=>r.rewardId>data.claimedRewardId&&r.score<=data.activeScore);
   if(!tiers.length){wait(report,label,'活跃 '+data.activeScore+'，已领至第 '+data.claimedRewardId+' 档');break;}
   const before=data.claimedRewardId,tier=Math.min(...tiers.map(r=>r.rewardId));
   const result=await claimOnce(client,{ledger,key:'festival-active:'+id+':'+day(client)+':'+tier,title:label+' · 第 '+tier+' 档',request:'ClaimActivityDailyActiveRewardRequest',response:'ClaimActivityDailyActiveRewardResponse',body:{activityId:automationWireId(id)},enabled:allowed,report,verify:r=>integer(r.claimedId)&&r.claimedId>before&&r.claimedId<=Math.max(...tiers.map(t=>t.rewardId))&&reward(r)});
   if(!result)break;data.claimedRewardId=result.claimedId;
  }
 }
 if(!found)wait(report,label,'当前未同步到开放的酆都签到活动');
}
export async function claimReportRewards(client,config,{enabled,ledger,report}){
 const label='邮件战报一键领取';
 const readAll=async()=>{const all=[];let total=Infinity;
 for(let pageNo=0;pageNo<200&&all.length<total;pageNo++){
  if(!enabled())throw Error('战报领取已暂停');const page=await read(client,'CampaignReports',{pageNo});
  if(!Array.isArray(page.reports)||!integer(page.total))throw Error('战报列表未完整返回');
  total=page.total;if(!page.reports.length)break;all.push(...page.reports);
 }
 if(all.length<total)throw Error('战报列表未读取完整，未发送一键领取');
 return all;};
 const all=await readAll();
 for(const [saved,r]of Object.entries(ledger.keyRecords()))if(!r.confirmed&&r.details?.request==='QuickGotCampaignReportRequest'){
  if(r.details.claimIds?.length&&r.details.claimIds.every(id=>all.some(x=>exactAutomationId(x.uid)===id&&x.received===true)))ledger.resolveKey(saved,true);
  else return wait(report,label,'前次战报领取结果未确认，新增战报也暂不重复提交一键领取');
 }
 const pending=all.filter(r=>r.received===false&&(r.rewards?.assetPackage?.asset?.some(a=>Number(a.num)>0)||['heroes','equips','badge','antiques','supplies'].some(k=>r.rewards?.[k]?.length>0)));
 if(!pending.length)return wait(report,label,'当前战报没有待领取奖励');
 const ids=pending.map(r=>exactAutomationId(r.uid));if(ids.some(id=>!id))throw Error('战报编号未确认');
 await claimOnce(client,{ledger,key:'report-all:'+signature(ids.sort()),title:label+' · '+pending.length+' 份',request:'QuickGotCampaignReportRequest',body:{all:true},enabled,report,details:{claimIds:ids},verify:async r=>{if(!reward(r))return false;const latest=await readAll();return ids.every(id=>latest.some(x=>exactAutomationId(x.uid)===id&&x.received===true));}});
}
// 累计奖励会重新增长；金额不是一次领取的唯一标识。此锁只保护尚未完成的请求。
const leagueCollectActive=new WeakSet();
export async function claimLeagueCollect(client,config,{enabled,ledger,report}){
 const label='积分赛累计收集',request='GotLeagueBonusItemRequest',key='league-collect:current';
 const pending=reason=>report({label,skipped:true,status:'pending',reason});
 if(!enabled())return;
 if(leagueCollectActive.has(client))return pending('累计收集正在核对，未并发提交');
 if(!ledger?.reserve||!ledger?.keyRecords)return pending('领取记录不可用，未提交');
 leagueCollectActive.add(client);
 try{
  const readState=async()=>{const state=await read(client,'LeagueInfo');if(!integer(state.bonusItemNum)||!integer(state.settleTime)||state.settleTime<=0)throw Error('积分赛累计收集状态未确认');return state;};
  const state=await readState();
  // 旧版按金额生成的未确认记录也必须阻断，不能换一个金额或跨日就绕过。
  for(const [saved,record]of Object.entries(ledger.keyRecords())){
   if(record.confirmed||!(saved.startsWith('league-collect:')||record.details?.request===request))continue;
   const period=record.details?.settleTime??Number(saved.split(':')[1]);
   if(state.bonusItemNum===0&&period===state.settleTime){
    ledger.resolveKey(saved,true);
    report({label,skipped:true,status:'confirmed',reason:'已回读同一期累计数量归零，前次请求不再重发'});
   }else return pending('前次累计收集结果尚未确认，金额或日期变化也不重复提交');
  }
  if(state.bonusItemNum===0)return wait(report,label,'当前累计可收集数量为0');
  if(!enabled())return;
  if(ledger.hasKey(key))ledger.releaseCompletedKey(key);
  const ticket=ledger.reserve({},{},{},{uniqueKey:key,details:{kind:'leagueCollect',request,settleTime:state.settleTime,beforeAmount:state.bonusItemNum,sent:false}});
  let sent=false;
  try{
   // 取得请求锁以后再读一次，避免另一个检查使用领取前的旧数量发送。
   const fresh=await readState();
   if(!enabled()||fresh.settleTime!==state.settleTime||fresh.bonusItemNum===0){ledger.cancel(ticket);return wait(report,label,!enabled()?'累计收集已关闭，未发送':fresh.settleTime!==state.settleTime?'积分赛结算期已变化，等待重新检查':'当前累计可收集数量为0');}
   ledger.updateKeyDetails(key,{kind:'leagueCollect',request,settleTime:fresh.settleTime,beforeAmount:fresh.bonusItemNum,sent:true});
   sent=true;
   const reply=await client.request(request,{},'GotRewardResponse');
   const after=await readState();
   if(!reward(reply)||after.settleTime!==fresh.settleTime||after.bonusItemNum>=fresh.bonusItemNum)throw Error('奖励回执或累计数量减少尚未确认，保留记录不重复领取');
   ledger.updateKeyDetails(key,{kind:'leagueCollect',request,settleTime:fresh.settleTime,beforeAmount:fresh.bonusItemNum,afterAmount:after.bonusItemNum,sent:true});
   ledger.confirm(ticket);
   report({label,ok:true,status:'confirmed',reason:'已确认领取 '+fresh.bonusItemNum+'，回读剩余 '+after.bonusItemNum});
  }catch(error){
   const refused=error.prompt&&error.request===request;
   if(!sent||refused)ledger.cancel(ticket);
   report({label,ok:false,status:!sent?'not_sent':refused?'rejected':'unknown',error:error.message});
  }
 }finally{leagueCollectActive.delete(client);}
}
export async function claimLeaguePass(client,config,{enabled,ledger,report}){
 const label='积分赛战令奖励',league=await read(client,'LeagueInfo'),state=await read(client,'LeagueBattlePassInfo');
 if(!integer(state.score)||!Array.isArray(state.got)||!integer(league.roomDan)||!integer(league.settleTime))throw Error('积分赛战令状态未确认');
 const tiers=rows(config,'LeaguePassCfg').filter(r=>r.dan===league.roomDan&&r.reqScore<=state.score);
 const claimable=tiers.filter(t=>{const got=state.got.find(r=>r.id===t.rwdId);return t.freeReward?.length&&!got?.freeGot||state.activePay&&t.payReward?.length&&!got?.payGot;});
 if(!claimable.length)return wait(report,label,'当前积分 '+state.score+'，暂无可领取档位');
 await claimOnce(client,{ledger,key:'league-pass:'+league.settleTime+':'+league.roomDan+':'+state.activePay+':'+signature(claimable.map(t=>t.rwdId)),title:label,request:'LeagueGotPassRewardRequest',response:'LeagueGotPassRewardResponse',enabled,report,verify:async r=>{
  const after=await read(client,'LeagueBattlePassInfo');return reward(r)&&claimable.every(t=>{const got=after.got?.find(g=>g.id===t.rwdId);return (!t.freeReward?.length||got?.freeGot)&&(!state.activePay||!t.payReward?.length||got?.payGot);});
 }});
}
export async function claimWeekSupply(client,config,{enabled,ledger,report}){
 const calendar=await readWeekCalendar(client),open=calendar.filter(e=>e.stage==='进行中'&&[4,6,7].includes(e.type));
 if(!open.length)return wait(report,'周活动补给免费礼包','当前没有开放的转盘、芯片或翻牌补给');
 for(const event of open){
  if(!enabled())return;
  const [info,table,request]=event.type===4?['WeekLotteryInfo','WeekLotteryPackCfg','WeekLotteryFreePackRequest']:event.type===6?['WeekChipInfo','WeekChipPackCfg','WeekChipGotFreeRequest']:['WeekUniqueLottery','WeekUniquePackCfg','GotUniqueLotteryFreeRequest'];
  const cfg=rows(config,table).find(r=>r.price===0&&(event.type===6?(r.buyLimit??r.limitedTimes):r.limitedTimes)>0);if(!cfg)throw Error(event.name+'免费礼包配置未确认');
  const got=s=>event.type===7?s.gotFree===true:event.type===6?(s.gifts?.find(g=>g.giftId===cfg.packId)?.paidTimes??0)>=(cfg.buyLimit??cfg.limitedTimes):(s.gift?.find(g=>g.giftId===cfg.packId)?.gotTimes??0)>=cfg.limitedTimes;
  const before=await read(client,info);if(event.type===7?typeof before.gotFree!=='boolean':!Array.isArray(event.type===6?before.gifts:before.gift))throw Error('补给礼包领取状态未完整返回');
  const label=event.name+' · 补给免费礼包';if(got(before)){wait(report,label,'本期当前免费礼包已领取');continue;}
  await claimOnce(client,{ledger,key:'week-supply:'+event.type+':'+event.startTime+':'+day(client),title:label,request,enabled:()=>enabled()&&now(client)<event.endTime,report,verify:async r=>reward(r)&&got(await read(client,info))});
 }
}
