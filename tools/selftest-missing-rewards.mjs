import {treasureCycleFixture,treasureCycleSettings} from './fixtures/treasure-cycle.mjs';
import {runLoop,formatLoopStep} from '../src/loop.mjs';
import {rewardSchedule} from '../src/reward-schedule.mjs';
import {readWorldTarget} from '../src/world-target.mjs';
process.on('uncaughtException',error=>{console.error(error.stack);process.exitCode=1;});
// 新增领奖与首战专项：协议编解码、持久防重、派遣条件均使用隔离数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {automationWireId} from '../src/automation-policy.mjs';
import {loadProtocol} from '../src/proto.mjs';
import {createUsageLedger,defaultSettings,importAutomationSettings,SETTINGS_FORMAT} from '../src/automation-settings.mjs';
import {claimOpenRank,claimFestivalActive,claimReportRewards,claimLeagueCollect,claimLeaguePass,claimWeekSupply,readWeekCalendar,rewardData} from '../src/missing-rewards.mjs';
import {runWorldBoss,claimWorldBossDamage,readWorldBoss} from '../src/world-boss.mjs';
import {reserveDispatch,fleetRecordReason,reconcileBossFleets,dispatchOrder} from '../src/fleet-availability.mjs';
const protocol=loadProtocol(),root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-missing-rewards-'));let total=0,serial=0;
const reward={reward:{asset:[{id:'RUBY',num:20}]}},now=()=>Math.floor(Date.now()/1000),player={level:37,worldId:1001001};
const test=async(name,fn)=>{await fn();total++;console.log('通过：'+name);};
function fixture(handler){const client=new EventEmitter();client.connected=true;client.writes=[];client.request=async(n,b={},r)=>{assert(protocol[n],n);protocol[n].decode(protocol[n].encode(b).finish());const value=await handler(n,b,client);return r?protocol[r].decode(protocol[r].encode(value??{}).finish()):value;};const ledger=createUsageLedger('isolation',{file:path.join(root,++serial+'.json')}),output=[];return {client,ledger,output,options:{player,ledger,enabled:()=>true,report:e=>output.push(e)}};}
await test('剿匪榜和杀敌榜逐档领取，未达标不领，重复检查不重领',async()=>{
 for(const type of [3,4]){const got=[],f=fixture((n,b,c)=>{if(n==='OpenRankInfoRequest'){assert.equal(b.type,type);return {progress:200,endTime:now()+3600,gotRewardId:got};}assert.equal(n,'GotOpenRankRewardRequest');assert.equal(b.type,type);got.push(b.id);c.writes.push(n);return reward;});
 const config={tables:{[type===3?'OpenRankPirateTaskCfg':'OpenRankWarTaskCfg']:{data:[100,200,300].map(score=>({season:1,score}))}}};await claimOpenRank(f.client,config,f.options,type);await claimOpenRank(f.client,config,f.options,type);assert.deepEqual(got,[100,200]);assert.equal(f.client.writes.length,2);}
});
await test('酆都签到活跃与签到分离，按服务器回执连续领取已达标档位',async()=>{
 let got=0;const f=fixture((n,b,c)=>{assert.equal(n,'ClaimActivityDailyActiveRewardRequest');c.writes.push(n);return {...reward,claimedId:++got};});
 f.client.festivals=[{activityId:'9007199254740993',type:'捞尸人联动活动',startTime:now()-100,endTime:now()+100,subActivity:[{subActivityType:11,dailyActive:{activeScore:160,claimedRewardId:0}}]}];
 const cfg={tables:{LinkageLSRActiveRewardCfg:{data:[{rewardId:1,score:80},{rewardId:2,score:160},{rewardId:3,score:240}]}}};await claimFestivalActive(f.client,cfg,f.options);await claimFestivalActive(f.client,cfg,f.options);assert.equal(got,2);assert(f.output.some(e=>e.skipped));
});
await test('战报独立接口一键领取，完整分页和大编号不丢精度',async()=>{
 let claimed=false;const f=fixture((n,b,c)=>{if(n==='CampaignReportsRequest')return {total:2,reports:[{uid:automationWireId(String(9007199254740993n+BigInt(b.pageNo))),received:claimed,rewards:{assetPackage:reward.reward}}]};assert.equal(n,'QuickGotCampaignReportRequest');assert.equal(b.all,true);claimed=true;c.writes.push(n);return reward;});
 await claimReportRewards(f.client,{},f.options);await claimReportRewards(f.client,{},f.options);assert.equal(f.client.writes.length,1);assert.equal(rewardData({uid:automationWireId('9007199254740993')}).uid,'9007199254740993');
});
await test('战报未知结果持久防重，不假报成功',async()=>{let sends=0;const f=fixture(n=>{if(n==='CampaignReportsRequest')return {total:1,reports:[{uid:1,received:false,rewards:{assetPackage:reward.reward}}]};sends++;throw Error('timeout');});await claimReportRewards(f.client,{},f.options);await claimReportRewards(f.client,{},f.options);assert.equal(sends,1);assert(!f.output.some(e=>e.ok));});
await test('积分赛累计收集后回读减少，零值不重复领取',async()=>{let amount=100;const f=fixture((n,b,c)=>{if(n==='LeagueInfoRequest')return {bonusItemNum:amount,settleTime:now()+3600,nextPointTime:now()+60};assert.equal(n,'GotLeagueBonusItemRequest');amount=0;c.writes.push(n);return reward;});await claimLeagueCollect(f.client,{},f.options);await claimLeagueCollect(f.client,{},f.options);assert.equal(f.client.writes.length,1);});
await test('积分赛战令按roomDan和积分领取，仅已解锁奖励，不购买战令',async()=>{let got=[];const f=fixture((n,b,c)=>{if(n==='LeagueInfoRequest')return {roomDan:2,dan:3,settleTime:now()+3600};if(n==='LeagueBattlePassInfoRequest')return {score:100,got,activePay:false};assert.equal(n,'LeagueGotPassRewardRequest');got=[{id:1,freeGot:true,payGot:false}];c.writes.push(n);return {...reward,got};});const cfg={tables:{LeaguePassCfg:{data:[{dan:2,rwdId:1,reqScore:50,freeReward:[['RUBY',1]],payReward:[['RUBY',2]]},{dan:2,rwdId:2,reqScore:200,freeReward:[['RUBY',1]]}]}}};await claimLeaguePass(f.client,cfg,f.options);await claimLeaguePass(f.client,cfg,f.options);assert.equal(f.client.writes.length,1);});
await test('日历展示当前阶段，转盘芯片翻牌三种补给仅领免费项',async()=>{for(const type of [4,6,7]){let got=false;const f=fixture((n,b,c)=>{if(n==='WeekInfoRequest')return {activityTime:[{type,startTime:now()-60,endTime:now()+3600,period:1}]};if(n==='WeekLotteryInfoRequest')return {gift:got?[{giftId:1000,gotTimes:1}]:[]};if(n==='WeekChipInfoRequest')return {gifts:got?[{giftId:1000,paidTimes:1}]:[]};if(n==='WeekUniqueLotteryRequest')return {gotFree:got};assert.equal(n,({4:'WeekLotteryFreePackRequest',6:'WeekChipGotFreeRequest',7:'GotUniqueLotteryFreeRequest'})[type]);got=true;c.writes.push(n);return reward;});const table=({4:'WeekLotteryPackCfg',6:'WeekChipPackCfg',7:'WeekUniquePackCfg'})[type],cfg={tables:{[table]:{data:[{packId:1000,price:0,limitedTimes:1},{packId:1001,price:30,limitedTimes:1}]}}};assert.equal((await readWeekCalendar(f.client))[0].stage,'进行中');await claimWeekSupply(f.client,cfg,f.options);await claimWeekSupply(f.client,cfg,f.options);assert.equal(f.client.writes.length,1);}});
function bossFixture(mode='ok'){
 let count=0,damageGot=0;const fleet={buildingId:'1远征船',state:1,curGridIdx:0,durability:100,maxDura:100},settings=defaultSettings();settings.worldBoss.enabled=true;
 const config={tables:{ModuleOpenCfg:{data:[{moduleId:'世界',playerLevel:16}]},WorldParamCfg:{data:[{paramName:'进攻首领消耗汽油',paramValue:300}]},WorldBossDamageRewardCfg:{data:[{season:1,bossId:2,level:1,damage:100},{season:1,bossId:2,level:2,damage:1000}]}}};
 const f=fixture((n,b,c)=>{if(n==='WorldBossInfoRequest')return {info:{bossId:2,gridIdx:100,bestDamage:500,gotRewardLevel:damageGot}};if(n==='CounterInfoRequest')return {counters:[{type:'DAILY_WORLD_BOSS_TIMES',num:count,updateTime:now()}]};if(n==='MyFleetsRequest')return {fleets:[fleet]};if(n==='OnWaterRequest')return {building:[{buildingId:fleet.buildingId,level:1,fleet:{formation:{heroPositions:[{heroId:'瑞文',pos:{x:1,y:1}}]}}}]};if(n==='AllItemRequest')return {items:[{itemId:'汽油',num:1000}]};if(n==='WorldBossGetDamageRewardRequest'){damageGot=1;c.writes.push(n);return reward;}assert.equal(n,'ChallengeWorldBossRequest');assert.deepEqual(b,{bossId:2,fleetBuildingIds:['1远征船']});c.writes.push(n);if(mode==='unknown')throw Error('timeout');count=1;Object.assign(fleet,{state:2,targetGridIdx:100});return {};});
 return {...f,fleet,settings,config,args:{...f.options,getSettings:()=>settings}};
}
await test('世界Boss每日仅首战一队，确认后不重派，返回主城才释放占用',async()=>{const f=bossFixture();await runWorldBoss(f.client,f.config,player,f.args);await runWorldBoss(f.client,f.config,player,f.args);assert.equal(f.client.writes.length,1);assert(f.output.some(e=>e.ok));assert(fleetRecordReason(f.ledger.keyRecords(),'1远征船'));Object.assign(f.fleet,{state:1,targetGridIdx:0});reconcileBossFleets(f.ledger,[f.fleet]);assert.equal(fleetRecordReason(f.ledger.keyRecords(),'1远征船'),'');});
await test('世界Boss只读计划不写账本；城战预留、低耐久、汽油保留分别阻断',async()=>{for(const mode of ['reserved','durability','fuel']){const f=bossFixture();if(mode==='reserved'){f.settings.cityWar.enabled=true;f.settings.cityWar.fleetIds=['1远征船'];reserveDispatch(f.client,'cityWar',['1远征船']);}if(mode==='durability')f.fleet.durability=1;if(mode==='fuel')f.settings.worldBoss.petrolReserve=900;const before=JSON.stringify(f.ledger.keyRecords());await readWorldBoss(f.client,f.config,player,f.settings,f.ledger);assert.equal(JSON.stringify(f.ledger.keyRecords()),before);await runWorldBoss(f.client,f.config,player,f.args);assert.equal(f.client.writes.length,0);assert(f.output.some(e=>e.skipped));}});
await test('世界Boss未知派遣保留汽油及舰队占用，重试不会再次发送',async()=>{const f=bossFixture('unknown');await runWorldBoss(f.client,f.config,player,f.args);await runWorldBoss(f.client,f.config,player,f.args);assert.equal(f.client.writes.length,1);assert.equal(f.ledger.pendingCounters().worldBossPetrol,300);assert(!f.output.some(e=>e.ok));});
await test('世界Boss伤害达标领取并回读确认，未达第二档不再领',async()=>{const f=bossFixture();await claimWorldBossDamage(f.client,f.config,f.options);await claimWorldBossDamage(f.client,f.config,f.options);assert.deepEqual(f.client.writes,['WorldBossGetDamageRewardRequest']);});
await test('新免费项目默认开启，原有四项调度相对顺序保留，新任务补在末尾',()=>{const s=defaultSettings();for(const key of ['pirateRankRewards','warRankRewards','festivalActiveRewards','battleReportRewards','worldBossRewards','weekSupplyFree','leagueCollect','leaguePassRewards'])assert.equal(s.schedule[key],true);s.fleetDispatch.priority=['radar','cityWar','treasure','pirateHunt'];assert.deepEqual(dispatchOrder(s),['radar','cityWar','treasure','pirateHunt','worldBoss','follow','silicon']);});
await test('开放活动与其他新项目经过整轮执行入口，等待状态和下次检查均可读取',async()=>{
 const keys=['pirateRankRewards','warRankRewards','festivalActiveRewards','battleReportRewards','worldBossRewards','weekSupplyFree','leagueCollect','leaguePassRewards'];
 const f=fixture(n=>{if(n==='OpenRankInfoRequest')return{progress:0,gotRewardId:[],endTime:now()+300};if(n==='CampaignReportsRequest')return{reports:[],total:0};if(n==='LeagueInfoRequest')return{roomDan:1,bonusItemNum:0,settleTime:now()+300};if(n==='LeagueBattlePassInfoRequest')return{score:0,got:[]};if(n==='WeekInfoRequest')return{activityTime:[]};if(n==='WorldBossInfoRequest')return{info:{bossId:0}};throw Error('意外请求 '+n);});f.client.festivals=[{activityId:99,type:'捞尸人联动活动',startTime:now()-60,endTime:now()+300,subActivity:[{subActivityType:11,dailyActive:{activeScore:0,claimedRewardId:0}}]}];
 const settings=defaultSettings();settings.loop.world=settings.loop.dailies=settings.loop.tasks=false;const entries=[];
 await runLoop(f.client,protocol,{config:{tables:{}},player,rounds:1,allowMutate:true,isEnabled:k=>keys.includes(k),getSettings:()=>settings,usageLedger:f.ledger,onStep:e=>entries.push(e)});
 for(const key of keys){assert(entries.some(e=>e.taskKey===key),key);assert(rewardSchedule(f.client).status(key)?.checkedAt,key);assert(rewardSchedule(f.client).nextCheck(key)>now(),key);}
});
await test('地图目标详情只读，无草稿或账本副作用，返回费用与逐舰队阻断',async()=>{
 const f=bossFixture(),before=JSON.stringify(f.ledger.keyRecords()),settings=JSON.stringify(f.settings);
 const view=await readWorldTarget(f.client,protocol,f.config,player,f.settings,f.ledger,{layer:'boss',key:'boss-2'});
 assert.equal(view.cost,300);assert.equal(view.fleets.length,1);assert.equal(JSON.stringify(f.ledger.keyRecords()),before);assert.equal(JSON.stringify(f.settings),settings);assert.equal(f.client.writes.length,0);
});
await test('前一版本导入补齐新项但保留已有开关、预算、文字表达与调度相对顺序',()=>{
 const old=defaultSettings();delete old.worldBoss;for(const key of ['pirateRankRewards','warRankRewards','festivalActiveRewards','worldBossRewards','battleReportRewards','weekSupplyFree','leagueCollect','leaguePassRewards'])delete old.schedule[key];old.schedule.limitedFreeGifts=false;old.trials.dailyDiamondBudget=200;old.fleetDispatch.priority=['radar','cityWar','treasure','pirateHunt'];
 const next=importAutomationSettings({format:SETTINGS_FORMAT,version:1,settings:old});assert.equal(next.schedule.limitedFreeGifts,false);assert.equal(next.trials.dailyDiamondBudget,200);assert.deepEqual(next.fleetDispatch.priority.slice(0,4),old.fleetDispatch.priority);assert.equal(next.schedule.leagueCollect,true);assert.equal(next.worldBoss.enabled,false);
});
await test('旧领奖读取失败保持错误状态，不被正常无动作说明覆盖',async()=>{
 const f=fixture(()=>{throw Error('隔离读取失败');}),settings=defaultSettings();settings.loop.world=settings.loop.dailies=settings.loop.tasks=false;
 await runLoop(f.client,protocol,{config:{tables:{}},player,rounds:1,allowMutate:true,isEnabled:k=>k==='mail',getSettings:()=>settings,usageLedger:f.ledger});
 assert.equal(rewardSchedule(f.client).status('mail').state,'error');assert.match(rewardSchedule(f.client).status('mail').text,/隔离读取失败/);
});
await test('地图巨轮字符串编号转换为协议数值，保留指定目标且不写游戏',async()=>{
 const f=treasureCycleFixture(),settings=treasureCycleSettings(),ledger=createUsageLedger('map-treasure',{file:path.join(root,++serial+'.json')});
 const target=f.state.targets[0],before=JSON.stringify(ledger.keyRecords());
 const view=await readWorldTarget(f.client,f.protocol,f.config,f.player,settings,ledger,{layer:'treasure',key:'treasure-'+target.uid});
 assert.equal(view.targets.length,1);assert(!view.notes.some(n=>n.includes('没有可读取')));assert.equal(JSON.stringify(ledger.keyRecords()),before);assert(!f.calls.some(c=>/SendFleets|MoveFleets|RepairFleet/.test(c.name)));
});
await test('确认与等待日志明确显示结果，工坊等待正文不重复两遍',()=>{
 assert.match(formatLoopStep({label:'Boss奖励',ok:true,status:'confirmed'}),/已确认/);
 const title='活动工坊：当前活动未开放此配方',text=formatLoopStep({title,reason:title,skipped:true});assert.equal(text.split(title).length-1,1);assert.match(text,/等待/);
});
console.log('新增领奖与首战专项 '+total+'/'+total+' 通过');
