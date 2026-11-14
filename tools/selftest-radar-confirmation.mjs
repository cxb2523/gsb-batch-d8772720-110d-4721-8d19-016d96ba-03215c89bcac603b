import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{radarDispatchConfirmed,runAllianceRadar}from'../src/alliance-radar.mjs';import{formatLoopStep,formatLoopRound}from'../src/loop.mjs';import{createUsageLedger}from'../src/automation-settings.mjs';import{pirateAdvanceFixture}from'./fixtures/pirate-advance.mjs';
process.on('uncaughtException',e=>{console.error(e.stack);process.exitCode=1;});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-confirm-'));let n=0;
for(const mode of ['moving','wrongTarget','delayed','network','rejected']){
 const f=pirateAdvanceFixture(),s=f.settings;s.radar.enabled=true;s.radar.fleetIds=['1远征船'];s.radar.petrolReserve=0;f.player.guildId='1001007';f.config.tables.ModuleOpenCfg.data.push({moduleId:'联盟情报',playerLevel:18});f.config.tables.WorldParamCfg.data.push({paramName:'情报事件消耗汽油',paramValue:500});
 let state=1,reads=f.client.request;f.client.request=async(name,body,response)=>name==='RadarInfoRequest'?{radarInfo:{events:[{uid:'9007199254740995',eventId:10001,state,gridIdx:777,createTime:100,pirate:{type:1,level:1}}]}}:reads(name,body,response);
 f.client.sendWatch=async()=>{f.client.writes.push('sent');if(mode==='network')throw Error('连接暂未返回');if(mode==='rejected')throw Object.assign(Error('服务器拒绝'),{prompt:true,request:'RadarSendFleetsRequest'});state=2;if(mode!=='delayed'){f.fleet.state=2;f.fleet.targetGridIdx=mode==='wrongTarget'?888:777;}};
 const ledger=createUsageLedger('a',{file:path.join(dir,mode+'.json')}),reports=[],args={getSettings:()=>s,enabled:()=>true,ledger,report:e=>reports.push(e)};
 await runAllianceRadar(f.client,f.config,f.player,args);
 const last=reports.at(-1);if(mode==='moving'){assert.equal(last.ok,true);assert.equal(ledger.snapshot().uncertain,0);}else if(mode==='rejected'){assert.equal(last.ok,false);assert.equal(ledger.snapshot().uncertain,0);}else{assert.equal(last.status,'pending');assert.equal(ledger.snapshot().uncertain,1);const text=formatLoopStep({...last,category:'联盟情报'});assert(text.includes('等待确认'));assert(!text.includes('失败'));
 state=3;await runAllianceRadar(f.client,f.config,f.player,args);assert.equal(ledger.snapshot().uncertain,0);assert(reports.some(e=>e.label==='已确认前次联盟情报派遣'));assert.equal(f.client.writes.length,1);}
 n++;
}
assert.equal(radarDispatchConfirmed({fleets:[{buildingId:'2远征船',state:2,targetGridIdx:777}]},{state:2,gridIdx:777},'1远征船'),false);
const text=formatLoopRound({round:1,tasks:{results:[]},dailies:{results:[]},world:{results:[{status:'pending'}]}});assert(text.includes('待确认 1 项'));console.log('情报确认专项 '+(n+2)+'/'+(n+2)+' 通过：行军、目标不符、延迟、网络未知、明确拒绝、他队排除及汇总');
