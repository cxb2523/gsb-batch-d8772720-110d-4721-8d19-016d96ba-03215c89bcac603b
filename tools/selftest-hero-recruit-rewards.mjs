import assert from 'node:assert/strict';
import { serviceHeroRecruitRewards } from '../src/hero-recruit-rewards.mjs';
import { runLoop } from '../src/loop.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';
const protocol=loadProtocol();
const config={tables:{HeroRecruitTaskCfg:{data:[{season:1,id:1,times:200},{season:1,id:2,times:400},{season:2,id:1,times:600}]}},materialName:id=>id};
async function run({times=400,gotId=0,worldId=1000001,enabled=true,badReply=false,stale=false,timeout=false,missing=false}={}){
 const writes=[],entries=[];let task={times,gotId};
 const client={async request(name,body,response){
  if(name==='RecruitInfoRequest')return missing?{}:{hero:{task:{...task}}};
  assert.equal(name,'GotHeroRecruitTaskRequest');assert.equal(response,'GotRecruitTaskResponse');assert.deepEqual(body,{});
  protocol[name].decode(protocol[name].encode(body).finish());writes.push(name);
  if(!stale)task.gotId++;if(timeout)throw Error('超时');
  return protocol[response].decode(protocol[response].encode({gotId:badReply?99:task.gotId,reward:{asset:[]}}).finish());
 }};
 await serviceHeroRecruitRewards(client,config,{player:{worldId},enabled:()=>enabled,report:x=>entries.push(x),scheduler:rewardSchedule(client)});
 return{writes,entries,task};
}
assert.equal((await run()).writes.length,2);
assert.equal((await run({times:199})).writes.length,0);
assert.equal((await run({enabled:false})).writes.length,0);
assert.equal((await run({gotId:2})).writes.length,0);
assert.equal((await run({worldId:2000001})).writes.length,0);
assert.equal((await run({worldId:0})).writes.length,0);
assert.equal((await run({missing:true})).writes.length,0);
assert.equal((await run({gotId:9})).writes.length,0);
for(const option of [{badReply:true},{stale:true},{timeout:true}]){const r=await run(option);assert.equal(r.writes.length,1);assert(r.entries.some(e=>e.ok===false));}
let loopGot=0,loopWrites=0;
const loopClient={connected:true,async request(name){
 if(name==='RecruitInfoRequest')return{hero:{task:{times:200,gotId:loopGot}}};
 assert.equal(name,'GotHeroRecruitTaskRequest');loopWrites++;return{gotId:++loopGot};
}};
await runLoop(loopClient,protocol,{config,player:{worldId:1000001},allowMutate:true,rounds:2,everyMs:1,sleep:async()=>{},isEnabled:key=>key==='heroRecruitRewards'});
assert.equal(loopWrites,1);
console.log('英雄累计招募奖励专项 12/12 通过（真实协议、虚构业务数据，含挂机链路）');
