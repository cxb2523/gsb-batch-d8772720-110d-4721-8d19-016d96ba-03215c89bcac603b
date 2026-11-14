import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {EventEmitter} from 'node:events';
import {loadProtocol} from '../src/proto.mjs';import {getConfig} from '../src/config.mjs';
import {createUsageLedger,defaultSettings,validateSettings} from '../src/automation-settings.mjs';
import {automationWireId,exactAutomationId} from '../src/automation-policy.mjs';
import {claimGuildTitleReward} from '../src/guild-title-rewards.mjs';
import {claimLimitedFree,limitedFreeCandidates} from '../src/extra-free-rewards.mjs';
import {watchTreasureTravel,matchesFollowDeparture} from '../src/treasure-follow.mjs';
import {readTreasureLoot,planTreasureLoot,runTreasureLoot} from '../src/treasure-loot.mjs';
import {runLoop} from '../src/loop.mjs';
import {treasureCycleFixture,treasureCycleSettings} from './fixtures/treasure-cycle.mjs';
const p=loadProtocol(),config=getConfig(),folder=fs.mkdtempSync(path.join(os.tmpdir(),'cw-rewards-follow-'));let serial=0,count=0;
const ledger=()=>createUsageLedger('虚构',{file:path.join(folder,String(++serial)+'.json')});
const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const reward={reward:{asset:[{id:'汽油',num:100}]}};
function giftFixture(){
 const client=new EventEmitter();client.connected=true;client.serverClockOffsetMs=0;
 const player={guildId:'9007199254741007',worldId:2002001001,vip:{vipLevel:3},level:37},state={gotTitle:1,myTitle:3,gotTitleTime:0,got:new Map(),unknown:false,refuse:false,emptyReward:false,afterReadFail:false,reset:Math.floor(Date.now()/1000)+3600,reads:[],writes:[],onRead:null};
 client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{
  if(p[name])p[name].decode(p[name].encode(body).finish());state.reads.push({name,body});await state.onRead?.(name,body);
  let value;
  if(name==='GuildInfoRequest'){if(state.afterReadFail&&state.writes.length)throw Error('回读失败');value={guild:{guildId:automationWireId(player.guildId),name:'测试联盟'},myTitle:state.myTitle,gotTitle:state.gotTitle,gotTitleTime:state.gotTitleTime};}
  else if(name==='LimitedShopRequest'){if(state.afterReadFail&&state.writes.length)throw Error('回读失败');value={shopItem:[...state.got].filter(([key])=>key.startsWith(body.type+':')).map(([key,gotTimes])=>({id:Number(key.split(':')[1]),gotTimes,charge:0})),resetTime:state.reset};}
  else if(['GotGuildTitleRewardRequest','LimitedShopGotFreeRequest'].includes(name)){
   state.writes.push({name,body});if(state.refuse)throw Object.assign(Error('明确拒绝'),{prompt:{prompt:1},request:name});if(state.unknown)throw Error('结果未知');
   if(name==='GotGuildTitleRewardRequest')state.gotTitleTime=now(client);else state.got.set(body.type+':'+body.id,1);value=state.emptyReward?{}:reward;
  }else throw Error('禁止未声明请求：'+name);
  return p[response].decode(p[response].encode(value).finish());
 };return {client,player,state};
}
await test('职级和限购默认开启，既有手动关闭值仍能正常保存',()=>{const s=defaultSettings();assert.equal(s.schedule.guildTitleReward,true);assert.equal(s.schedule.limitedFreeGifts,true);s.schedule.guildTitleReward=false;s.schedule.limitedFreeGifts=false;const saved=validateSettings(s);assert.equal(saved.schedule.guildTitleReward,false);assert.equal(saved.schedule.limitedFreeGifts,false);});
await test('职级按服务器gotTitle领取并回读当日时间，当前myTitle不同不越级，每天一次',async()=>{
 const f=giftFixture(),l=ledger(),out=[],options={player:f.player,enabled:()=>true,ledger:l,report:e=>out.push(e)};
 await claimGuildTitleReward(f.client,config,options);await claimGuildTitleReward(f.client,config,options);assert.equal(f.state.writes.length,1);assert(out.some(e=>e.ok));assert.equal(Object.values(l.keyRecords())[0].details.title,1);
 f.client.serverClockOffsetMs=86400000;await claimGuildTitleReward(f.client,config,options);assert.equal(f.state.writes.length,2);
});
await test('职级未知结果跨日仍阻断，确认拒绝释放，资格变化不发送',async()=>{
 const f=giftFixture(),l=ledger(),out=[];f.state.unknown=true;const options={player:f.player,enabled:()=>true,ledger:l,report:e=>out.push(e)};
 await claimGuildTitleReward(f.client,config,options);f.client.serverClockOffsetMs=86400000;await claimGuildTitleReward(f.client,config,options);assert.equal(f.state.writes.length,1);assert(out.some(e=>e.status==='pending'));
 const g=giftFixture(),gLedger=ledger();g.state.refuse=true;await claimGuildTitleReward(g.client,config,{player:g.player,enabled:()=>true,ledger:gLedger,report:()=>{}});assert.equal(gLedger.snapshot().uncertain,0);
 const h=giftFixture();let reads=0;h.state.onRead=n=>{if(n==='GuildInfoRequest'&&++reads===2)h.state.gotTitle=2;};await claimGuildTitleReward(h.client,config,{player:h.player,enabled:()=>true,ledger:ledger(),report:()=>{}});assert.equal(h.state.writes.length,0);
});
await test('职级无回执不报成功，后续同日回读确认不重领，关闭不查询',async()=>{
 const f=giftFixture(),l=ledger(),out=[];f.state.emptyReward=true;const opts={player:f.player,enabled:()=>true,ledger:l,report:e=>out.push(e)};await claimGuildTitleReward(f.client,config,opts);assert(!out.some(e=>e.ok));await claimGuildTitleReward(f.client,config,opts);assert.equal(f.state.writes.length,1);assert(Object.values(l.keyRecords()).every(r=>r.confirmed));
 const g=giftFixture();await claimGuildTitleReward(g.client,config,{player:g.player,enabled:()=>false,ledger:ledger(),report:()=>{}});assert.equal(g.state.reads.length,0);
});
await test('限购补齐服务器省略的未领条目，只领当前VIP/赛季常规免费包',async()=>{
 const f=giftFixture(),l=ledger(),out=[],opts={player:f.player,enabled:()=>true,ledger:l,report:e=>out.push(e)};
 assert.deepEqual(limitedFreeCandidates(config,f.player,4).map(r=>r.id),[3200]);
 await claimLimitedFree(f.client,config,opts);assert.deepEqual(f.state.writes.map(r=>r.body.id),[1000,2000,3200]);assert.equal(out.filter(e=>e.ok).length,3);
 await claimLimitedFree(f.client,config,opts);assert.equal(f.state.writes.length,3);assert(!f.state.writes.some(r=>r.body.id===90000));
});
await test('限购未知结果跨重置不重发，空回执不报成功，回读确认可解除在途',async()=>{
 const f=giftFixture(),l=ledger();f.state.unknown=true;const opts={player:f.player,enabled:()=>true,ledger:l,report:()=>{}};await claimLimitedFree(f.client,config,opts);f.state.reset+=86400;await claimLimitedFree(f.client,config,opts);assert.equal(f.state.writes.length,3);
 const g=giftFixture(),gLedger=ledger(),out=[];g.state.afterReadFail=true;await claimLimitedFree(g.client,config,{player:g.player,enabled:()=>true,ledger:gLedger,report:e=>out.push(e)});assert(out.some(e=>e.status==='unknown'));assert(!out.some(e=>e.ok));g.state.afterReadFail=false;
 await claimLimitedFree(g.client,config,{player:g.player,enabled:()=>true,ledger:gLedger,report:()=>{}});assert.equal(g.state.writes.filter(r=>r.body.id===1000).length,1);assert(Object.values(gLedger.keyRecords()).every(r=>r.confirmed));
});
function followFixture(){
 const f=treasureCycleFixture(),settings=treasureCycleSettings(),leadId='9007199254740999',time=now(f.client);
 Object.assign(settings.treasure,{follow:true,followPlayerIds:[leadId],followNames:[],autoRepair:false,checkEverySeconds:60});
 f.travelers=[];f.lead={buildingId:'1远征船',owner:{playerId:automationWireId(leadId),nickname:'海上的风',guildId:f.player.guildId},state:2,durability:2000,maxDura:2000,treasureLootUid:72,startGridIdx:100,targetGridIdx:500,moveStartTs:time-1,moveEndTs:time+180};
 const read=f.client.request;f.client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{const value=await read(name,body,response);if(name!=='WorldInfoRequest')return value;return p.WorldInfoResponse.decode(p.WorldInfoResponse.encode({...value,fleets:[...value.fleets,...f.travelers]}).finish());};
 const emit=rows=>f.client.emit('message',{name:'SCFleet',body:p.SCFleet.decode(p.SCFleet.encode({fleets:rows}).finish())});
 return Object.assign(f,{settings,leadId,emit});
}
await test('同一目标玩家出发即可匹配，无需成为守军；精确ID与目标格必须一致',async()=>{
 const f=followFixture();f.travelers=[f.lead];const snap=await readTreasureLoot(f.client,f.protocol,f.config,f.player,{preferences:f.settings.treasure}),plan=planTreasureLoot(snap,f.config,f.settings);
 assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].followPhase,'departing');assert.equal(plan.actions[0].followPlayerId,f.leadId);assert.match(plan.actions[0].label,/已出发/);
 f.lead.targetGridIdx=100;const wrong=await readTreasureLoot(f.client,f.protocol,f.config,f.player,{preferences:f.settings.treasure});assert.equal(planTreasureLoot(wrong,f.config,f.settings).actions.length,0);
});
await test('过期行军、返航和同名歧义不能触发；重复推送只唤醒一次',()=>{
 const c=new EventEmitter();c.serverClockOffsetMs=0;const watch=watchTreasureTravel(c),time=now(c),row={buildingId:'1远征船',owner:{playerId:automationWireId('9007199254740999'),nickname:'同名'},state:2,moveStartTs:time-1,moveEndTs:time+100,targetGridIdx:500,treasureLootUid:72};let wakes=0;const off=watch.subscribe(()=>wakes++);
 c.emit('message',{name:'SCFleet',body:{fleets:[row]}});c.emit('message',{name:'SCFleet',body:{fleets:[row]}});assert.equal(wakes,1);
 c.emit('message',{name:'SCFleet',body:{fleets:[{...row,owner:{...row.owner,playerId:automationWireId('9007199254740997')}}]}});assert(!matchesFollowDeparture(watch.current()[0],{follow:true,followNames:['同名'],followPlayerIds:[]},'1',watch.current()));
 c.serverClockOffsetMs=46000;assert.equal(watch.current().length,0);c.serverClockOffsetMs=0;c.emit('message',{name:'SCFleet',body:{fleets:[{...row,state:1}]}});c.emit('message',{name:'SCFleet',body:{fleets:[row]}});assert(!watch.current().some(f=>f.playerId==='9007199254740999'));off();c.emit('close');assert.equal(watch.current().length,0);
});
await test('发送前目标已返航则取消；未知派遣保持锁，预算及避战仍生效',async()=>{
 const f=followFixture();f.travelers=[f.lead];let readCount=0;f.beforeRead=name=>{if(name==='WorldInfoRequest'&&++readCount===2){f.travelers=[];f.emit([{...f.lead,state:1}]);}};
 await runTreasureLoot(f.client,f.protocol,f.config,f.player,{getSettings:()=>f.settings,ledger:ledger()});assert.equal(f.client.writes.length,0);
 const g=followFixture();g.travelers=[g.lead];g.settings.treasure.petrolReserve=g.state.fuel;const snap=await readTreasureLoot(g.client,g.protocol,g.config,g.player,{preferences:g.settings.treasure});assert.equal(planTreasureLoot(snap,g.config,g.settings).actions.length,0);
 const h=followFixture();h.travelers=[h.lead];h.settings.treasure.allowHostile=true;h.settings.treasure.avoidNames=['避战玩家'];h.state.targets[0].ownerGuildIdx=7;h.state.targets[0].ownerFleetNum=1;h.state.defenders[72]=[{name:'避战玩家',guildIdx:7,isNpc:false}];const blocked=planTreasureLoot(await readTreasureLoot(h.client,h.protocol,h.config,h.player,{preferences:h.settings.treasure}),h.config,h.settings);assert.equal(blocked.actions.length,0);assert(blocked.notes.some(n=>n.includes('避战')));
 g.settings.treasure.petrolReserve=0;g.unknown=true;const l=ledger();await runTreasureLoot(g.client,g.protocol,g.config,g.player,{getSettings:()=>g.settings,ledger:l});await runTreasureLoot(g.client,g.protocol,g.config,g.player,{getSettings:()=>g.settings,ledger:l});assert.equal(g.client.writes.length,1);assert.equal(l.snapshot().uncertain,1);
});
await test('受控循环等待阶段由出发推送唤醒，不等待60秒轮间或检查间隔',async()=>{
 const f=followFixture(),stop=new AbortController(),l=ledger();let sentAt=0,signalAt=0,rounds=0;f.beforeSend=()=>{sentAt=Date.now();};
 const timeout=setTimeout(()=>stop.abort(),2500);
 try{await runLoop(f.client,f.protocol,{config:f.config,player:f.player,getSettings:()=>f.settings,usageLedger:l,allowMutate:true,isEnabled:()=>false,rounds:0,everyMs:60000,stop:stop.signal,onRound:()=>{rounds++;if(rounds===1)setTimeout(()=>{signalAt=Date.now();f.travelers=[f.lead];f.emit(f.travelers);},10);},onStep:e=>{if(e.step?.kind==='treasureDispatch'&&e.status==='confirmed')stop.abort();}});}finally{clearTimeout(timeout);}
 assert.equal(rounds,1);assert.equal(f.client.writes.length,1);assert(sentAt>=signalAt&&sentAt-signalAt<1000);assert.equal(Object.values(l.keyRecords()).find(r=>r.details.kind==='treasureDispatch').details.followPhase,'departing');
});
console.log('礼包与出发跟随专项 '+count+'/'+count+' 通过');
