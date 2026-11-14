// 战后维修：实际协议编解码与虚构状态，真实低汽油数值只作样本回归。
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {warForgeFixture,warForgeSettings} from './fixtures/war-forge.mjs';
import {createUsageLedger} from '../src/automation-settings.mjs';
import {readFleetMaintenance,planFleetMaintenance,runFleetMaintenance,maintenancePolicies,watchFleetMaintenance} from '../src/fleet-maintenance.mjs';
import {dispatchReservationReason} from '../src/fleet-availability.mjs';
import {runLoop} from '../src/loop.mjs';
import {runTreasureLoot} from '../src/treasure-loot.mjs';
import {runCityWar} from '../src/city-war.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-maintenance-'));let number=0,count=0;
const ledger=()=>createUsageLedger('虚构维修',{file:path.join(root,String(++number)+'.json')});
const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
function fixture(){
 const f=warForgeFixture(),s=warForgeSettings();s.forge.enabled=false;
 Object.assign(s.cityWar,{fleetIds:['1远征船','2远征船','3远征船'],maxRepairCost:0,dailyPetrolLimit:0,petrolReserve:0,checkEverySeconds:15});
 Object.assign(s.treasure,{enabled:true,autoJoin:false,follow:false,autoRepair:true,fleetIds:['1远征船','2远征船'],maxRepairCost:0,dailyRepairPetrolLimit:0});
 f.state.war.startTime=Math.floor(Date.now()/1000)-7200;f.state.war.endTime=Math.floor(Date.now()/1000)-3600;f.state.war.declarations=[];f.state.targets=[];f.state.stats.todayRewardTimes=3;
 f.state.fuel=1992;f.state.repair.unitRepairCost=6;f.state.fleets.forEach((v,i)=>Object.assign(v,{state:1,cityId:1,curGridIdx:0,treasureLootUid:0,durability:[1615,750,1610][i],maxDura:2050}));
 return Object.assign(f,{settings:s});
}
const run=(f,l,extra={})=>runFleetMaintenance(f.client,f.player,{getSettings:()=>f.settings,ledger:l,enabled:()=>true,...extra});
await test('1992汽油与三队真实耐久样本：完整报价2610/7800/2640，等待而不发请求',async()=>{
 const f=fixture(),l=ledger(),before=structuredClone(f.settings),view=await run(f,l);assert.deepEqual(view.rows.map(r=>r.cost),[2610,7800,2640]);assert(view.rows.every(r=>r.condition.includes('等待汽油')));assert.equal(view.minimumFuel,2610);assert.equal(f.client.writes.length,0);assert.deepEqual(f.settings,before);
 assert.match(dispatchReservationReason(f.client,f.settings,'treasure','1远征船'),/战后维修/);
});
await test('无目标、已领奖满额、城战结束及出征上限已满仍独立维修，不要求下次出征汽油',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=2610;const t=l.reserve({cityWarDispatches:999});l.confirm(t);const result=await run(f,l);
 assert.equal(f.client.writes.length,1);assert.equal(f.client.writes[0].name,'RepairFleetRequest');assert.equal(f.state.fuel,0);assert.equal(result.rows[0].state,'repairing');assert.equal(l.snapshot().counters.cityWarDispatches,999);assert.equal(l.snapshot().counters.cityWarPetrol,2610);
});
await test('低于满耐久但高于旧80%阈值也补满；满耐久不维修',async()=>{
 const f=fixture(),l=ledger();f.state.fleets.forEach(v=>v.durability=2050);f.state.fleets[0].durability=2000;f.state.fuel=300;await run(f,l);assert.equal(f.client.writes.length,1);assert.equal(l.snapshot().counters.cityWarPetrol,300);
 const g=fixture();g.state.fleets.forEach(v=>v.durability=2050);await run(g,ledger());assert.equal(g.client.writes.length,0);
});
await test('只修所选空闲舰队，驻守/出征/未确认任务不会被抢占',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=50000;Object.assign(f.state.fleets[0],{state:2,targetCityId:2});f.state.fleets[1].curGridIdx=5;
 l.reserve({piratePetrol:300},{},{},{uniqueKey:'pirate-first:1001001:1:1:1',details:{kind:'pirateFirst',buildingId:'3远征船',outcome:'unknown'}});
 await run(f,l);assert.equal(f.client.writes.length,0);
 f.settings.cityWar.autoRepair=false;f.settings.treasure.autoRepair=false;const calls=f.calls.length;await run(f,l);assert.equal(f.calls.length,calls);
});
await test('参数按既有优先级选取，单次/每日/保留量拦截，不能改组绕过预算',async()=>{
 const f=fixture();f.state.fuel=50000;f.settings.cityWar.maxRepairCost=2000;assert(maintenancePolicies(f.settings).every(p=>p.source==='cityWar'));await run(f,ledger());assert.equal(f.client.writes.length,0);
 for(const alter of [s=>s.cityWar.dailyPetrolLimit=2000,s=>s.cityWar.petrolReserve=49000]){const g=fixture();g.state.fuel=50000;alter(g.settings);await run(g,ledger());assert.equal(g.client.writes.length,0);}
});
await test('同轮库存未回写不超花；维修中不重复，完成后释放锁并处理其他队',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=5250;let stale=true;const read=f.client.request;f.client.request=async(...args)=>{const r=await read(...args);if(stale&&args[0]==='AllItemRequest')r.items.find(i=>i.itemId==='汽油').num=5250;return r;};await run(f,l);stale=false;assert.deepEqual(f.client.writes.map(w=>w.body.buildingId),['1远征船','3远征船']);assert.equal(f.state.fuel,0);await run(f,l);assert.equal(f.client.writes.length,2);
 for(const v of [f.state.fleets[0],f.state.fleets[2]])Object.assign(v,{state:1,durability:2050,repairing:null});f.state.fuel=7800;await run(f,l);assert.equal(f.client.writes.length,3);assert.equal(f.client.writes[2].body.buildingId,'2远征船');
});
await test('未知维修跨换日/重建仍锁定；后续维修状态确认后不重发',async()=>{
 const f=fixture();let wall=Date.now();const file=path.join(root,'reopen.json'),l=createUsageLedger('虚构维修',{file,now:()=>wall});f.state.fuel=2610;f.unknown=true;await run(f,l);assert.equal(l.snapshot().uncertain,1);await run(f,l);assert.equal(f.client.writes.length,1);
 wall+=86400000;const again=fixture(),reopened=createUsageLedger('虚构维修',{file,now:()=>wall});again.state.fuel=2610;again.client.serverClockOffsetMs=86400000;await run(again,reopened);assert.equal(again.client.writes.length,0);assert.equal(reopened.snapshot().uncertain,1);
 Object.assign(again.state.fleets[0],{state:4,repairing:{endTs:Math.floor(Date.now()/1000)+86460}});await run(again,reopened);assert.equal(reopened.snapshot().uncertain,0);assert.equal(again.client.writes.length,0);
});
await test('明确拒绝释放预算，无变化不重复；汽油变化后允许复查',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=2610;f.reject=true;await run(f,l);assert.equal(l.snapshot().uncertain,0);assert.equal(l.snapshot().counters.cityWarPetrol,0);await run(f,l);assert.equal(f.client.writes.length,1);
 f.state.fuel=2611;f.reject=false;await run(f,l);assert.equal(f.client.writes.length,2);
});
await test('报价或设置在复核期间变化取消，暂停不发送',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=50000;let quotes=0;f.beforeRead=name=>{if(name==='FleetRepairParamRequest'&&++quotes===4)f.state.repair.unitRepairCost=10;};await run(f,l);assert.equal(f.client.writes.length,0);
 const g=fixture();g.state.fuel=50000;let reads=0,enabled=true;g.beforeRead=name=>{if(name==='MyFleetsRequest'&&++reads===2)enabled=false;};await run(g,ledger(),{enabled:()=>enabled});assert.equal(g.client.writes.length,0);
});
await test('只读计划不占预算，并发维修只发送一次',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=50000;f.settings.cityWar.fleetIds=['1远征船'];f.settings.treasure.enabled=false;
 const before=l.snapshot(),plan=planFleetMaintenance(await readFleetMaintenance(f.client,f.player,f.settings,l),f.settings,f.client);assert.equal(plan.actions.length,1);assert.deepEqual(l.snapshot(),before);assert.equal(f.client.writes.length,0);
 await Promise.all([run(f,l),run(f,l)]);assert.equal(f.client.writes.length,1);
});
await test('未知战后维修阻止原巨轮与城战复用同队，不因另一模块预算充足绕过',async()=>{
 const f=fixture(),l=ledger();f.state.fuel=50000;f.settings.cityWar.fleetIds=['1远征船'];f.settings.treasure.fleetIds=['1远征船'];f.state.fleets[0].durability=2000;f.unknown=true;await run(f,l);assert.equal(f.client.writes.length,1);
 f.settings.treasure.autoJoin=true;f.settings.treasure.autoRepair=false;f.state.targets=[{uid:72,color:5,ownerGuildIdx:0,ownerFleetNum:0,progress:5,gridIdx:500,reward:{asset:[{id:'橙装材料自选包',num:15}]}}];f.state.stats.todayRewardTimes=0;
 await runTreasureLoot(f.client,f.protocol,f.config,f.player,{getSettings:()=>f.settings,ledger:l});
 const time=Math.floor(Date.now()/1000);f.state.war={startTime:time-100,endTime:time+1000,assembleCityId:2,declarations:[{attackGuildIdx:7,defenceGuildIdx:8,cityId:2}]};
 await runCityWar(f.client,f.protocol,f.config,f.player,{getSettings:()=>f.settings,ledger:l,mapLoader:f.mapLoader});assert.equal(f.client.writes.length,1);assert.equal(l.snapshot().uncertain,1);
});
await test('监控唤醒：未达完整费用不触发，达到2610后唤醒现有循环及时维修',async()=>{
 const f=fixture(),l=ledger(),stop=new AbortController();let rounds=0,trigger=0,sent=0,belowNoRead=false;f.beforeSend=()=>{sent=Date.now();};const timer=setTimeout(()=>stop.abort(),3000);
 try{await runLoop(f.client,f.protocol,{config:f.config,player:f.player,getSettings:()=>f.settings,usageLedger:l,allowMutate:true,isEnabled:()=>false,rounds:0,everyMs:60000,stop:stop.signal,
 onRound:()=>{if(++rounds===1)setTimeout(()=>{const before=f.calls.length;f.state.fuel=2490;f.client.emit('message',{name:'SCUpdateItem',body:{items:[{itemId:'汽油',num:2490}]}});setTimeout(()=>{belowNoRead=f.calls.length===before;f.state.fuel=2610;trigger=Date.now();f.client.emit('message',{name:'SCUpdateItem',body:{items:[{itemId:'汽油',num:2610}]}});},10);},10);},
 onStep:e=>{if(e.category==='战后维修'&&e.status==='confirmed')stop.abort();}});}finally{clearTimeout(timer);}
 assert(belowNoRead);assert.equal(rounds,1);assert.equal(f.client.writes.length,1);assert(sent>=trigger&&sent-trigger<1000);assert.equal(watchFleetMaintenance(f.client).held().length,0);
});
console.log('战后补满专项 '+count+'/'+count+' 通过');
