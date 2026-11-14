// 活动统计只读：真实条件、实际进度和领取状态分别展示，不触发领取、购买或战斗。
import {rewardData,weekActivityNames} from './missing-rewards.mjs';
import {openRankWindows} from './activity-rankings.mjs';
import {exactAutomationId,automationWireId} from './automation-policy.mjs';
import {merchantProgress, merchantJournalSummary} from './merchant-activity.mjs';
import {fishView,newbieView} from './collections.mjs';

const rows=(c,n)=>c?.tables?.[n]?.data??[];
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const text=n=>valid(n)?n.toLocaleString('zh-CN'):'未同步';
const weekTables={1:'WeekPassPeriodCfg',2:'WeekChargePeriodCfg',3:'WeekHeroStarPeriodCfg',4:'WeekLotteryPeriodCfg',5:'WeekOrderPeriodCfg',6:'WeekChipPeriodCfg',7:'WeekUniquePeriodCfg'};
const ranking=n=>valid(n)?n>0?'第 '+n+' 名':'未上榜':'未同步';
const stateAt=(start,end,time)=>valid(start)&&valid(end)&&end>start?time<start?'未开始':time<end?'进行中':'已结束':'未同步';

export function activityRewardState(tiers,isEligible,isClaimed){
 if(!tiers.length)return '未同步';
 const claimed=tiers.filter(isClaimed).length,ready=tiers.filter(t=>isEligible(t)&&!isClaimed(t)).length;
 if(claimed===tiers.length)return '全部已领（'+claimed+'/'+tiers.length+'）';
 if(ready)return '可领 '+ready+' 档 · 已领 '+claimed+'/'+tiers.length;
 if(!tiers.some(isEligible))return (claimed?'后续未达成':'尚未达成')+' · 已领 '+claimed+'/'+tiers.length+' 档';
 return '已达成已领 · '+claimed+'/'+tiers.length+' 档';
}
export function activityPeriodName(config,event){
 const cfg=rows(config,weekTables[event.type]).find(r=>r.periodId===event.period);
 return cfg?.activeName||cfg?.activityName||weekActivityNames[event.type]||'周活动 '+event.type;
}

export async function readActivityStatistics(client,config,player,ledger,settings){
 const checkedAt=Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000),items=[],notes=[],cache=new Map();
 const season=Math.floor(Number(exactAutomationId(player.worldId))/1e6)%1000;
 const ask=(name,body={})=>{
  const key=name+JSON.stringify(body);
  if(!cache.has(key))cache.set(key,client.request(name+'Request',body,name+'Response',8000).then(rewardData));
  return cache.get(key);
 };
 const add=(id,name,startTime=null,endTime=null)=>{
  const row={id,name,status:startTime===null&&endTime===null?'进行中':stateAt(startTime,endTime,checkedAt),progress:'未同步',startTime,endTime,welfare:'—',rewards:'—',rank:'—',rankKey:null};items.push(row);return row;
 };
 const capture=async(row,work)=>{try{await work();}catch(error){row.error=error.message;if(row.startTime==null&&row.endTime==null)row.status='未同步';row.progress='未同步';row.rewards='未同步';notes.push(row.name+'：'+error.message);}};
 const unlocked=module=>{const level=rows(config,'ModuleOpenCfg').find(r=>r.moduleId===module)?.playerLevel;return valid(level)&&player.level>=level;};
 let calendar=[];
 try{const data=await ask('WeekInfo');if(!Array.isArray(data.activityTime))throw Error('周活动时间未完整返回');calendar=data.activityTime;}catch(error){notes.push('周活动：'+error.message);}
 for(const event of calendar){
  const row=add('week:'+event.type,activityPeriodName(config,event),event.startTime,event.endTime);
  if(row.status!=='进行中'){row.progress='—';continue;}
  await capture(row,async()=>{
   if(event.type===1){
    const s=await ask('WeekBattlePassInfo'),tiers=rows(config,'WeekBattlePassCfg').filter(t=>t.periodId===event.period);
    if(!valid(s.score)||!Array.isArray(s.got)||!Array.isArray(s.task))throw Error('战令进度或已领记录未完整返回');
    const achieved=tiers.filter(t=>s.score>=t.reqScore);
    row.progress='第 '+Math.max(0,...achieved.map(t=>t.rwdId))+' 档 · 积分 '+text(s.score);
    const tasks=rows(config,'WeekPassTaskCfg');
    const pending=s.task.filter(t=>!t.isGot&&tasks.some(c=>c.taskId===t.taskId&&t.progress>=c.target)).length;
    row.welfare=pending?'任务积分待领 '+pending+' 项':'当前任务积分已领';
    row.rewards=activityRewardState(tiers,t=>s.score>=t.reqScore,t=>{const g=s.got.find(g=>g.stage===t.rwdId);return (!t.freeReward?.length||g?.freeGot)&&(!s.activePay||!t.payReward?.length||g?.payGot);});
   }else if(event.type===2){
    const s=await ask('WeekChargeInfo'),tiers=rows(config,'WeekChargeRewardCfg').filter(t=>t.periodId===event.period);
    if(!valid(s.rechargeAmount)||!Array.isArray(s.stage))throw Error('累计充值进度未完整返回');
    row.progress='累计充值 '+text(s.rechargeAmount);
    row.rewards=activityRewardState(tiers,t=>s.rechargeAmount>=t.rechargeAmount,t=>s.stage.includes(t.rwdId));
   }else if(event.type===3){
    const s=await ask('WeekHeroStarInfo'),heroes=(await ask('AllHero')).heroes,period=rows(config,'WeekHeroStarPeriodCfg').find(t=>t.periodId===event.period);
    if(!valid(s.gotStage)||!Array.isArray(heroes)||!period)throw Error('升星活动进度未完整返回');
    const star=id=>heroes.find(h=>h.heroId===id)?.star,first=star(period.showHero1),second=star(period.showHero2);
    row.progress=period.showHero1+' '+(first==null?'未拥有':text(first)+'星')+' · '+period.showHero2+' '+(second==null?'未拥有':text(second)+'星');
    row.rewards=activityRewardState(rows(config,'WeekHeroStarRwdCfg').filter(t=>t.periodId===event.period),t=>valid(first)&&valid(second)&&first>=t.hero1Star&&second>=t.hero2Star,t=>t.rwdId<=s.gotStage);
   }else if(event.type===4){
    const s=await ask('WeekLotteryInfo'),progress=s.gotInfo;
    if(!progress||!valid(progress.times)||!valid(progress.gotStage)||!Array.isArray(s.gift))throw Error('转盘进度未完整返回');
    row.progress='抽取 '+text(progress.times)+' 次';
    const gift=rows(config,'WeekLotteryPackCfg').find(t=>t.price===0&&t.limitedTimes>0);
    row.welfare=gift?(s.gift.find(g=>g.giftId===gift.packId)?.gotTimes??0)>=gift.limitedTimes?'免费礼包已领':'免费礼包未领':'未同步';
    row.rewards=activityRewardState(rows(config,'WeekLotteryTimesCfg').filter(t=>t.periodId===event.period),t=>progress.times>=t.reqTimes,t=>t.rwdId<=progress.gotStage);
   }else if(event.type===5){
    const s=await ask('WeekOrderInfo'),tiers=rows(config,'WeekOrderRwdCfg').filter(t=>t.periodId===event.period&&t.rwdId>0);
    if(!Array.isArray(s.gotRwdId)||!tiers.length||typeof s.isGotFinal!=='boolean')throw Error('周订单进度未完整返回');
    const count=tiers.filter(t=>s.gotRwdId.includes(t.rwdId)).length;
    row.progress=count+'/'+tiers.length+' 单';
    row.rewards=s.isGotFinal?'全部已领':count===tiers.length?'最终奖励待领':'订单奖励 '+count+'/'+tiers.length+' · 最终未达成';
   }else if(event.type===6){
    const s=await ask('WeekChipInfo');if(!valid(s.score)||!Array.isArray(s.gotTaskId)||!Array.isArray(s.gifts))throw Error('硅晶进度未完整返回');
    row.progress='第 '+text(s.round)+' 轮 · 积分 '+text(s.score);
    const gift=rows(config,'WeekChipPackCfg').find(t=>t.price===0&&t.buyLimit>0);
    row.welfare=gift?(s.gifts.find(g=>g.giftId===gift.packId)?.paidTimes??0)>=gift.buyLimit?'免费礼包已领':'免费礼包未领':'未同步';
    row.rewards=activityRewardState(rows(config,'WeekChipPointsCfg'),t=>s.score>=t.amount,t=>s.gotTaskId.includes(t.rwdId));
   }else if(event.type===7){
    const s=await ask('WeekUniqueLottery');if(!valid(s.floor)||!valid(s.gotFloor)||typeof s.gotFree!=='boolean')throw Error('翻牌进度未完整返回');
    row.progress='第 '+text(s.floor)+' 层';row.welfare=s.gotFree?'免费礼包已领':'免费礼包未领';
    row.rewards=activityRewardState(rows(config,'WeekUniqueLotteryLayerCfg').filter(t=>t.periodId===event.period),t=>s.floor>=t.layer,t=>t.rwdId<=s.gotFloor);
   }
  });
 }
 const rankNames={1:['订单冲榜','orders','OpenRankOrderTaskCfg'],2:['闯关冲榜','stages','OpenRankStageTaskCfg'],3:['剿匪冲榜','pirate','OpenRankPirateTaskCfg'],4:['杀敌冲榜','war','OpenRankWarTaskCfg']};
 if(!Array.isArray(client.openRankActivity?.activityTime))notes.push('冲榜活动开放时间尚未同步，未列出未经确认的入口');
 if(unlocked('冲榜活动'))for(const window of openRankWindows(client)){
  const def=rankNames[window.type];if(!def)continue;const [name,key,table]=def,row=add('open:'+window.type,name,window.startTime,window.endTime);row.rankKey=key;
  await capture(row,async()=>{
   const s=await ask('OpenRankInfo',{type:window.type});if(!valid(s.progress)||!Array.isArray(s.gotRewardId))throw Error('冲榜进度未完整返回');
   row.progress=text(s.progress)+(window.type===2?' 关':' 分');row.rank=ranking(s.leaderBoard?.myItem?.rank);
   const all=rows(config,table),chosen=all.some(t=>t.season===season)?season:Math.max(0,...all.map(t=>t.season??0)),tiers=all.filter(t=>t.season==null||t.season===chosen);
   row.rewards=activityRewardState(tiers,t=>t.score<=s.progress,t=>s.gotRewardId.includes(t.score));
  });
 }
 if(unlocked('周活动')){
  const row=add('cross','军备竞赛');row.rankKey='week-cross';
  await capture(row,async()=>{const s=await ask('CrossRankInfo');row.endTime=s.settleTime||null;if(s.grouping){row.status='分组中';row.progress='等待分组';row.rank='未分组';return;}
   const mine=s.rankList?.find(t=>exactAutomationId(t.playerId)===exactAutomationId(player.playerId));row.progress=mine?text(mine.score)+' 分':'未同步';row.rank=mine?ranking(mine.rank):'未返回本人名次';
   const choices=rows(config,'CrossRankDailyRwdCfg').filter(t=>t.subjectId===s.subjectId&&t.level<=s.roomLevel),level=Math.max(0,...choices.map(t=>t.level));
   const tiers=choices.filter(t=>t.level===level).sort((a,b)=>a.needScore-b.needScore).map((t,i)=>({...t,idx:i+1}));
   row.rewards=valid(mine?.score)&&valid(s.gotDailyRewardIdx)?activityRewardState(tiers,t=>t.needScore<=mine.score,t=>t.idx<=s.gotDailyRewardIdx):'未同步';
   const packs=rows(config,'LimitedPackCfg').filter(t=>t.type==='日礼包'&&t.price===0&&t.weekDay>0&&t.limitedTimes>0),shop=await ask('LimitedShop',{type:1});
   row.welfare=Array.isArray(shop.shopItem)&&packs.length?packs.every(t=>(shop.shopItem.find(i=>i.id===t.id)?.gotTimes??0)>=t.limitedTimes)?'免费补给已领':'免费补给可领':'免费补给未同步';});
 }
 if(unlocked('跨服积分赛')){
  const row=add('league','跨服积分赛');row.rankKey='league';
  await capture(row,async()=>{const s=await ask('LeagueInfo'),pass=await ask('LeagueBattlePassInfo');
   row.endTime=s.settleTime||null;row.progress='积分 '+text(s.mine?.score)+' · 战令 '+text(pass.score);row.rank=ranking(s.mine?.rank);
   row.welfare=valid(s.bonusItemNum)?s.bonusItemNum>0?'累计可领 '+text(s.bonusItemNum):'当前累计已收取':'未同步';
   row.rewards=valid(pass.score)&&Array.isArray(pass.got)?activityRewardState(rows(config,'LeaguePassCfg').filter(t=>t.dan===s.roomDan),t=>pass.score>=t.reqScore,t=>{const g=pass.got.find(g=>g.id===t.rwdId);return (!t.freeReward?.length||g?.freeGot)&&(!pass.activePay||!t.payReward?.length||g?.payGot);}):'未同步';});
 }
 if(unlocked('世界')){
  const boss=add('boss','世界Boss');boss.rankKey='world-boss';
  await capture(boss,async()=>{const s=(await ask('WorldBossInfo')).info;if(!s?.bossId){boss.status='未开放';boss.progress='—';return;}boss.progress='最高伤害 '+text(s.bestDamage);
   boss.rewards=valid(s.bestDamage)&&valid(s.gotRewardLevel)?activityRewardState(rows(config,'WorldBossDamageRewardCfg').filter(t=>t.season===season&&t.bossId===s.bossId),t=>s.bestDamage>=t.damage,t=>t.level<=s.gotRewardLevel):'未同步';
   boss.rank=ranking((await ask('WorldBossPlayerRank')).myRank?.rank);});
  const war=add('city-war','联盟城战');
  await capture(war,async()=>{const s=await ask('WarDeclaration'),guild=exactAutomationId(player.guildId);if(!Array.isArray(s.declarations))throw Error('宣战列表未完整返回');war.startTime=s.startTime;war.endTime=s.endTime;war.status=stateAt(s.startTime,s.endTime,checkedAt);war.progress='我盟宣战 '+s.declarations.filter(t=>guild&&t.attackGuildIdx===Number(BigInt(guild)%1000n)).length+' 城';war.rewards='未同步';});
 }
 if(unlocked('世界宝藏')){
  const row=add('treasure','万吨货轮');
  await capture(row,async()=>{const list=await ask('TreasureLootList'),s=await ask('TreasureLootStats'),limit=rows(config,'TreasureLootParamCfg').find(t=>t.paramName==='每日宝藏奖励次数')?.paramValue;
   if(!Array.isArray(list.treasure))throw Error('巨轮列表未完整返回');const targets=list.treasure.filter(t=>t.color===5);row.progress=targets.length?targets.map(t=>'占领 '+text(t.progress)+'%').join('；'):'当前无万吨货轮';
   row.status=targets.length?'进行中':'等待刷新';row.welfare=valid(s.todayRewardTimes)&&valid(limit)?'今日奖励 '+s.todayRewardTimes+'/'+limit+' 次':'未同步';
   row.rewards=valid(s.todayRewardTimes)&&valid(limit)?s.todayRewardTimes>=limit?'今日已领完':'今日仍可获奖':'未同步';
   const ranks=[];for(const target of targets){const rank=await ask('TreasureLootRank',{uid:target.uid});const mine=rank.items?.find(t=>exactAutomationId(t.playerId)===exactAutomationId(player.playerId));ranks.push(mine?ranking(mine.rank):'未参与');}row.rank=ranks.join('；')||'—';});
 }
 for(const event of client.festivals??[]){
  if(event.endTime<=checkedAt)continue;
  const linkage=event.type==='捞尸人联动活动'||event.subActivity?.some(s=>[27,28,29,30].includes(s.subActivityType));
  const row=add('festival:'+exactAutomationId(event.activityId),linkage?'酆都诡事':event.type||'限时活动',event.startTime,event.endTime);
  const daily=event.subActivity?.find(s=>s.subActivityType===11)?.dailyActive;
  if(daily&&linkage){
   const signed=Array.isArray(daily.checkInId)?daily.checkInId:null,signSub=event.subActivity.find(s=>s.subActivityType===11),day=value=>Math.floor((value+28800)/86400);
   const signCfg=rows(config,'LinkageLSRSignCfg').find(t=>t.signDay===day(checkedAt)-day(signSub.openTime||event.startTime)+1);
   row.progress='活跃 '+text(daily.activeScore)+' · 已签到 '+(signed?signed.length:'未同步')+' 天';
   row.rewards=valid(daily.activeScore)&&valid(daily.claimedRewardId)?activityRewardState(rows(config,'LinkageLSRActiveRewardCfg'),t=>daily.activeScore>=t.score,t=>t.rewardId<=daily.claimedRewardId):'未同步';
   const gifts=event.subActivity?.find(s=>s.subActivityType===6)?.dailyCombGift,all=rows(config,'LinkageLSRDailyDealCfg').filter(t=>t.season>0&&t.season<=season),chosen=Math.max(0,...all.map(t=>t.season)),free=all.filter(t=>t.season===chosen&&t.price===0&&!t.chargeId);
   row.welfare=(signed&&signCfg?signed.includes(signCfg.rewardId)?'今日签到已领':'今日签到未领':'签到状态未同步')+' · '+(Array.isArray(gifts?.boughtGiftId)&&free.length?free.every(t=>gifts.boughtGiftId.includes(t.packId))?'免费礼包已领':'免费礼包未领':'免费礼包未同步');
  }
  else row.progress='子活动 '+(event.subActivity?.length??0)+' 项';
  if(!linkage||row.status!=='进行中')continue;
  for(const [type,label,info,table,value,claimed,threshold,id]of [[28,'龙王罗盘','CompassWheelInfo','LinkageLSRCompassWheelScoreRewardCfg','score','claimedId','score','id'],[30,'驱邪除祟','EvilExpelInfo','LinkageLSREvilExpelTotalRewardCfg','killTotal','claimed','totalCount','totalCount']]){
   const sub=event.subActivity?.find(s=>s.subActivityType===type);if(!sub)continue;const child=add(row.id+':'+type,label,sub.openTime||event.startTime,sub.closeTime||event.endTime);if(child.status!=='进行中'){child.progress='—';continue;}
   await capture(child,async()=>{const s=await ask(info,{activityId:automationWireId(exactAutomationId(event.activityId))});if(!valid(s[value])||!valid(s[claimed]))throw Error('活动进度未完整返回');child.progress=text(s[value])+(type===28?' 分':' 个');child.rewards=activityRewardState(rows(config,table),t=>s[value]>=t[threshold],t=>t[id]<=s[claimed]);
    if(type===28){const free=rows(config,'LinkageLSRLimitPackCfg').filter(p=>p.price===0&&!p.chargeId),map=event.subActivity.find(sub=>sub.subActivityType===10)?.dailySelectGift?.boughtTimes;child.welfare=map&&free.length?free.every(p=>(map[p.packId]??0)>=p.limitCount)?'每日礼包已领':'每日礼包可领':'每日礼包未同步';child.rankKey='activity:'+exactAutomationId(event.activityId)+':7';const rank=await ask('ActivityRank',{activityId:automationWireId(exactAutomationId(event.activityId)),type:7,page:1});child.rank=ranking(rank.myItem?.rank);}});
  }
  for(const [type,label,passType,table]of [[27,'走江踏浪',10,'SnowBallBattlePassCfg'],[29,'酆都法旨',11,'LinkageLSREdictBattlePassCfg']]){
   const sub=event.subActivity?.find(s=>s.subActivityType===type);if(!sub)continue;
   const child=add(row.id+':'+type,label,sub.openTime||event.startTime,sub.closeTime||event.endTime);if(child.status!=='进行中'){child.progress='—';continue;}
   await capture(child,async()=>{const pass=await ask('BattlePass',{type:passType});if(!valid(pass.score)||!Array.isArray(pass.got))throw Error('活动战令进度未完整返回');
    const tiers=rows(config,table);child.progress='战令第 '+Math.max(0,...tiers.filter(t=>pass.score>=t.reqScore).map(t=>t.rwdId))+' 档 · 积分 '+text(pass.score);
    child.rewards=activityRewardState(tiers,t=>pass.score>=t.reqScore,t=>{const g=pass.got.find(g=>g.id===t.rwdId);return (!t.freeReward?.length||g?.freeGot)&&(!pass.activePay||!t.payReward?.length||g?.payGot);});
    if(type===27){const snow=await ask('SnowballDetail');const counts=Array.isArray(snow.giftBuy)?new Map(snow.giftBuy.map(t=>[t.packId,t.bought])):null;child.welfare=counts?rows(config,'SnowBallGiftCfg').filter(t=>t.price===0||t.price===-1).map(t=>(t.price===0?'免费':'广告')+((counts.get(t.packId)??0)>=t.limitCount?'已领':'未领')).join(' · '):'助力状态未同步';child.rewards+=' · 积分奖励 '+activityRewardState(rows(config,'SnowBallScoreRewardCfg'),t=>snow.totalScore>=t.score,t=>snow.claimedTier>=t.id);child.rankKey='activity:'+exactAutomationId(event.activityId)+':6';child.rank=ranking((await ask('ActivityRank',{activityId:automationWireId(exactAutomationId(event.activityId)),type:6,page:1})).myItem?.rank);}
   });
  }
 }
 const trade=client.tradeWindow;
 if(trade?.period&&trade.endTime>checkedAt&&unlocked('海商王')){
  const row=add('merchant','海商王',trade.startTime,trade.endTime);
  if(row.status==='进行中')await capture(row,async()=>{const st=await ask('TradeInfo');if(st.period!==trade.period||!st.player||!st.cargo)throw Error('本期商船数据未同步');
   row.progress='商会币 '+text(st.player.coins)+' · 累计利润 '+text(st.player.profit)+' · '+await merchantProgress(config,trade,st,player,checkedAt,ask,ledger,settings);
   row.merchantJournal=merchantJournalSummary(ledger,trade,{time:checkedAt});
   if(row.merchantJournal?.confirmedTrades) row.progress+=' · 工具已核实 '+row.merchantJournal.confirmedTrades+' 笔成交 · 实际净利 '+text(row.merchantJournal.realizedProfit);
   row.rewards=activityRewardState(rows(config,'TradeAchieveRewardCfg').filter(t=>t.id===st.period),t=>t.target<=st.player.profit,t=>t.rewardId<=st.gotAchieveRwdId);
   const pass=await ask('BattlePass',{type:3});row.welfare='战令 '+text(pass.score)+' 分';});
 }
 const beauty=client.beautyWindow;
 if(beauty?.period&&Math.max(beauty.showEndTime||0,beauty.endTime||0)>checkedAt&&unlocked('海上风采大赛')){
  const row=add('beauty','海上风采大赛',beauty.startTime,beauty.endTime);
  if(row.status==='进行中')await capture(row,async()=>{const st=await ask('BeautyInfo');row.progress='今日已投 '+text(st.todayVote)+'/3 票';row.welfare=st.gotVote?'每日投票礼包已领':st.todayVote>=3?'每日投票礼包可领':'每日投票礼包未达成';});
 }
 const fish=add('fish-book','钓鱼图鉴');
 await capture(fish,async()=>{const f=await fishView(client,config);fish.progress=f.names.length+'/'+f.total+' 种';fish.rewards=f.next==null?'全部已领':f.ready?'第 '+f.next+' 档可领取':'已领至第 '+f.claimed+' 档，下一档未达成';});
 const newbie=newbieView(client);if(newbie){const row=add('newbie','新手七日登录',client.newbieActivity.startTime,newbie.end);row.progress=newbie.loginDays+'/7 天';row.welfare=newbie.available.length?'可领第 '+newbie.available.join('、')+' 天':newbie.loginDays>=7?'全部已领':'当前已达成已领';}
 return {checkedAt,items,notes};
}
