// 虚构试炼扫荡状态，所有协议请求/响应经过实际协议编解码。
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../../src/proto.mjs';
import { defaultSettings } from '../../src/automation-settings.mjs';
const p = loadProtocol(), table = data => ({ data });
export function trialModesFixture() {
  const settings = defaultSettings(); for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
  Object.assign(settings.loop,{world:false,tasks:false,dailies:false,heroes:false});settings.dailies.enabled=false;settings.resident.rewards=false;
  settings.resources.allowDiamonds=true;Object.assign(settings.trials,{paid:true,ads:true});
  const player = { playerId:'9007199254740993',worldId:'1001001',guildId:'9007199254741001',level:37,vip:{vipLevel:3},nickname:'扫荡验证' };
  const channel = {clientInfo:{appId:'14021170',channelId:'1400',originVersion:'74.0.0'},language:'zh_CN'};
  const state = {ruby:1000,cards:[],firstCharge:[],raids:new Map([1,2,3].map(id=>[id,{raidId:id,passedStage:id*1000+20,buySweepTimes:1,sweepTimes:0}])),
    adv:[{id:3,gotTimes:0,reward:false},{id:4,gotTimes:0,reward:false},{id:5,gotTimes:0,reward:false}],reads:[],writes:[],failure:'',onRead:null,onWatch:null};
  const config = {tables:{
    TrialRaidCfg:table([{raidId:1,title:'英雄经验副本'},{raidId:2,title:'强化石副本'},{raidId:3,title:'海兽经验副本'}]),
    TrialRaidStageCfg:table([1,2,3].flatMap(id=>[20,21].map(n=>({raidId:id,stageId:id*1000+n,stageLevel:n,openLevel:16,power:100,reward:[],sweepReward:[]})))),
    TrialRaidParamCfg:table([{paramName:'试炼副本扫荡次数',paramValue:3}]),TrialRaidBuySweepCfg:table([{buyTimes:1,costRuby:0},{buyTimes:2,costRuby:50},{buyTimes:3,costRuby:50}]),
    VipLevelCfg:table([{level:1,effects:[]},{level:3,effects:[['免广告',1]]},{level:4,effects:[['试炼扫荡次数',2],['免广告',1]]}]),
    MonthCardCfg:table([{id:'普通月卡',effectList:[['试炼扫荡次数',2]]},{id:'高级月卡',effectList:[]}]),
    ModuleOpenCfg:table([{moduleId:'广告',playerLevel:10}]),AdvChannelCfg:table([{key:'1400',isOpen:true,minAppVersion:'1.0.0'}]),AdvEffectCfg:table([3,4,5].map(id=>({id,dailyLimit:1}))),
  }};
  const client = new EventEmitter(); client.connected=true;client.serverClockOffsetMs=0;client.stop=()=>{client.connected=false;};client.snapshot=()=>({state:'READY',connected:client.connected});
  client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{
    if(p[name])p[name].decode(p[name].encode(body).finish());state.reads.push({name,body:structuredClone(body)});await state.onRead?.(name,body);
    let value;
    if(name==='TrialRaidInfoRequest')value={raid:state.raids.get(body.raidId)};
    else if(name==='AllResourceRequest')value={list:[{res:p.Resource.RUBY,amount:state.ruby},{res:p.Resource.GOLD,amount:100000}]};
    else if(name==='MonthCardRequest')value={cardItem:state.cards};
    else if(name==='FirstChargeRequest')value={firstCharge:{record:state.firstCharge}};
    else if(name==='OnWaterRequest')value={building:[],adv:state.adv};
    else if(name==='WatchAdvRequest') {state.writes.push({name,body});await state.onWatch?.();if(state.failure==='watchUnknown')throw new Error('模拟广告准备结果未知');if(state.failure==='watchReject')throw Object.assign(new Error('模拟拒绝'),{request:name,prompt:{}});value={};}
    else if(['WeekInfoRequest','DailyTaskInfoRequest','MainTaskInfoRequest','AchievementInfoRequest','EmailBoxRequest','AfkInfoRequest','MyResFieldsRequest'].includes(name))value={};
    else if(name==='AllHeroRequest')value={heroes:[]};
    else if(name==='AllItemRequest')value={items:[]};
    else throw new Error('夹具禁止未声明请求：'+name);
    const t=p[response];if(!t)throw new Error('缺少协议：'+response);return t.decode(t.encode(value).finish());
  };
  client.sendWatch=async(name,body)=>{
    assertRequest(name);p[name].decode(p[name].encode(body).finish());state.writes.push({name,body:structuredClone(body)});
    if(state.failure==='unknown')throw new Error('模拟扫荡结果未知');
    if(state.failure==='reject')throw Object.assign(new Error('模拟扫荡明确拒绝'),{request:name,prompt:{}});
    if(state.failure==='stale')return;
    if(body.useAdvCard){const map={1:4,2:3,3:5};state.adv.find(r=>r.id===map[body.raidId]).gotTimes++;}
    else {const r=state.raids.get(body.raidId),price=config.tables.TrialRaidBuySweepCfg.data.find(x=>x.buyTimes===r.buySweepTimes+1)??config.tables.TrialRaidBuySweepCfg.data.at(-1);r.buySweepTimes++;state.ruby-=price.costRuby;}
  };
  function assertRequest(name){if(name!=='TrialRaidBuySweepRequest')throw new Error('夹具禁止其他写入：'+name);}
  return {client,protocol:p,config,player,settings,state,channel};
}
