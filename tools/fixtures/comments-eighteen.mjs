// 十八项批注的受控数据；请求与响应经过实际协议编解码，禁止游戏写操作。
import {trialModesFixture} from './trial-modes.mjs';
import {getConfig} from '../../src/config.mjs';
import {loadMapAsset} from '../../src/world.mjs';
export async function commentsEighteenFixture(){
 const f=trialModesFixture(),config=getConfig(),map=await loadMapAsset(1),p=f.protocol,now=Math.floor(Date.now()/1000);
 Object.assign(f.player,{worldId:'2002001001',guildId:'9007199254741001',scenarioId:1,mainlineStage:150,worldOpenTime:now-45*86400,nickname:'界面验证（虚构）'});
 f.config=config;f.map=map;f.reads=[];f.fail=new Set();
 const cityCfg=config.tables['1_CityCfg'].data,home=cityCfg.find(c=>c.guildIndex===1),target=cityCfg.find(c=>c.guildIndex===2),homeGrid=map.cityInfo[home.id].gridIdx,targetGrid=map.cityInfo[target.id].gridIdx;
 const seaGrid=map.cityInfo[cityCfg.find(c=>c.id!==home.id&&c.id!==target.id).id].gridIdx;
 const owner={playerId:{low:1,high:2097152},nickname:f.player.nickname,guildId:{low:1001,high:2097152},title:0};
 const fleets=[{buildingId:'1远征船',state:1,durability:2050,maxDura:2050,curGridIdx:0,cityId:home.id,owner},
  {buildingId:'2远征船',state:2,durability:1800,maxDura:2050,curGridIdx:0,cityId:home.id,startGridIdx:homeGrid,targetGridIdx:targetGrid,targetCityId:target.id,moveStartTs:now-30,moveEndTs:now+120,owner},
  {buildingId:'3远征船',state:2,durability:1700,maxDura:2050,curGridIdx:0,cityId:home.id,startGridIdx:homeGrid,targetGridIdx:seaGrid,treasureLootUid:101,moveStartTs:now-20,moveEndTs:now+80,owner}];
 const foreign={...fleets[2],buildingId:'1远征船',owner:{playerId:555,nickname:'已出发盟友（虚构）',guildId:2002,title:0}};
 const fighter={name:'城战玩家（虚构）',isNpc:false,guildIdx:1,avatar:{image:1,frame:0},skinId:'',petId:''};
 const rank={rank:1,playerId:owner.playerId,nickname:f.player.nickname,avatar:{image:1,frame:0},power:15000000,value:9545,score:900,damage:3429469,guildIdx:1,playerLevel:37,title:0};
 const periods={1:2011,2:2001,3:2001,4:102001,5:2001,6:3001,7:20001};
 const calendar=Object.entries(periods).map(([type,period])=>({type:Number(type),period,startTime:now-86400,endTime:now+3*86400}));
 const pass=config.tables.WeekBattlePassCfg.data.filter(r=>r.periodId===2011),order=config.tables.WeekOrderRwdCfg.data.filter(r=>r.periodId===2001&&r.rwdId>0);
 f.client.openRankActivity={activityTime:[{type:1,startTime:now-5*86400,endTime:now-10},{type:2,startTime:now+86400,endTime:now+2*86400},{type:3,startTime:now-86400,endTime:now+86400},{type:4,startTime:now-86400,endTime:now+86400}],redDot:[]};
 f.client.festivals=[{activityId:'20261001',type:'捞尸人联动活动',startTime:now-86400,endTime:now+3*86400,subActivity:[{subActivityType:11,openTime:now-86400,closeTime:now+3*86400,dailyActive:{checkInId:[1,2],activeScore:160,claimedRewardId:1}},{subActivityType:6,dailyCombGift:{boughtGiftId:[]}},{subActivityType:28},{subActivityType:29},{subActivityType:30}]}];
 const data={
  WorldInfoRequest:{fleets:[...fleets,foreign],cities:[{id:home.id,guildIdx:1,attackFleetNum:0,defenceFleetNum:5,priorityAtkFleetNum:0,priorityDefFleetNum:0,battlePoints:[]},{id:target.id,guildIdx:2,attackFleetNum:8,defenceFleetNum:7,priorityAtkFleetNum:2,priorityDefFleetNum:3,battlePoints:[{index:0,leftFighter:fighter,rightFighter:{...fighter,guildIdx:2,name:'守军（虚构）'}}]}]},
  WarDeclarationRequest:{declarations:[{attackGuildIdx:1,defenceGuildIdx:2,cityId:target.id}],startTime:now-60,endTime:now+3600,assembleCityId:target.id},
  MyFleetsRequest:{fleets},AllGuildAbstractionRequest:{guilds:[]},MyResFieldsRequest:{info:{fields:[]}},
  OnWaterRequest:{building:fleets.map(f=>({buildingId:f.buildingId,level:1,fleet:{formation:{presetId:1,heroPositions:[]}}})),adv:f.state.adv},EquipsRequest:{equip:[]},
  TreasureLootListRequest:{treasure:[{uid:101,color:5,ownerGuildIdx:2,ownerFleetNum:3,progress:65,gridIdx:seaGrid,reward:{asset:[{id:'木材',num:10}]},battlePoint:{leftFighter:fighter,rightFighter:{...fighter,guildIdx:2}}}]},
  TreasureLootStatsRequest:{stats:[],todayRewardTimes:2,totalRewardTimes:8,nextRefreshTime:now+3600},
  TreasureLootRankRequest:{items:[{playerId:owner.playerId,nickname:f.player.nickname,power:15000000,progress:15,estProgress:20,rank:2,guildIdx:1,avatar:{image:1,frame:0},rewardTimes:2}]},
  AllPirateRequest:{pirates:[],sweepTimes:15},PirateKillRecordRequest:{records:[{type:1,maxKilledLevel:15}]},RadarInfoRequest:{radarInfo:{events:[]}},
  WorldBossInfoRequest:{info:{bossId:3,gridIdx:seaGrid,bestDamage:3429469,gotRewardLevel:4}},WorldBossPlayerRankRequest:{rankList:[rank],myRank:rank},
  WeekInfoRequest:{activityTime:calendar},WeekBattlePassInfoRequest:{score:pass[9].reqScore,activePay:false,got:pass.slice(0,9).map(t=>({stage:t.rwdId,freeGot:true,payGot:false})),task:[]},
  WeekChargeInfoRequest:{rechargeAmount:0,stage:[]},WeekHeroStarInfoRequest:{gotStage:1},
  WeekLotteryInfoRequest:{gift:[{giftId:1000,gotTimes:1}],gotInfo:{times:20,gotStage:0}},
  WeekOrderInfoRequest:{gotRwdId:order.slice(0,Math.min(29,order.length-1)).map(t=>t.rwdId),order:[{id:'木材',num:10}],isGotFinal:false},
  WeekChipInfoRequest:{round:1,score:1000,gotTaskId:[],gifts:[]},WeekUniqueLotteryRequest:{gift:[],floor:5,prizePos:[],selectId:0,gotFree:true,gotFloor:1,buyTimes:0},
  OpenRankInfoRequest:{endTime:now+86400,progress:9545,gotRewardId:[1000,2000],leaderBoard:{item:[rank],myItem:rank,page:0,totalPage:15}},
  LimitedShopRequest:{shopItem:[],resetTime:now+86400},SnowballDetailRequest:{totalScore:0,claimedTier:0,giftBuy:[]},CrossRankInfoRequest:{grouping:false,settleTime:now+86400,rankList:[rank]},
  LeagueInfoRequest:{settleTime:now+86400,roomDan:1,dan:1,mine:rank,top10:[],ownFormations:[],bonusItemNum:0,maxPage:2},
  LeagueBattlePassInfoRequest:{activePay:false,score:50,got:[]},
  CompassWheelInfoRequest:{score:100,claimedId:1,times:10,cost:{id:'木材',num:1}},EvilExpelInfoRequest:{killTotal:10,claimed:5,todayKill:1,alive:0},BattlePassRequest:{score:100,activePay:false,got:[],endTime:now+86400},
  FishEncyclopediaRequest:{fishList:[],rewardId:0},AllItemRequest:{items:[{itemId:'木材',num:500},{itemId:'种子',num:200},{itemId:'英雄经验',num:10000},{itemId:'橙卡万能碎片',num:10},{itemId:'汽油',num:99999}]},
 };
 const original=f.client.request;
 f.client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{
  f.reads.push({name,body:structuredClone(body)});if(f.fail.has(name))throw Error('受控读取失败：'+name);
  if(name==='OpenRankLeaderBoardRequest')throw Error('测试禁止已知不可用的冲榜分页');
  if(name==='LeagueRankRequest'){const item={...rank,rank:body.page===1?1:11,worldId:2002001001};return p[response].decode(p[response].encode({items:[item],maxPage:2}).finish());}
  if(name==='ActivityRankRequest')return p[response].decode(p[response].encode({item:[rank],myItem:rank,page:body.page,totalPage:2}).finish());
  if(name in data){p[name].decode(p[name].encode(body).finish());return p[response].decode(p[response].encode(data[name]).finish());}
  if(/Got|Claim|Send|Buy|Start|Challenge|Upgrade|Finish|Repair|Cancel|Watch|Move/.test(name))throw Error('只读夹具禁止动作：'+name);
  return original(name,body,response);
 };
 f.responses=data;f.fleets=fleets;f.targetCity=target.id;return f;
}
