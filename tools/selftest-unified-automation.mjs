import assert from 'node:assert/strict';
import fs from'node:fs';import os from'node:os';import path from'node:path';
import {pirateAdvanceFixture}from'./fixtures/pirate-advance.mjs';
import {runPirateAdvance}from'../src/pirate-advance.mjs';
import {collectAntiqueFloaters}from'../src/antique-floaters.mjs';
import {createUsageLedger,defaultSettings,importAutomationSettings,SETTINGS_FORMAT}from'../src/automation-settings.mjs';
import {automationControls,setAutomationControl}from'../src/automation-controls.mjs';
import {treasureFixture,treasureSettings}from'./fixtures/treasure-loot.mjs';
import {warForgeFixture,warForgeSettings}from'./fixtures/war-forge.mjs';
import {readTreasureLoot,planTreasureLoot}from'../src/treasure-loot.mjs';
import {readCityWar,planCityWar}from'../src/city-war.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-advance-test-'));let count=0;
const ledger=()=>createUsageLedger('a',{file:path.join(dir,'ledger-'+(++count)+'.json')});
const run=(f,extra={})=>runPirateAdvance({...f,options:f.settings.pirateHunt,ledger:f.ledger??ledger(),getSettings:()=>f.settings,enabled:()=>true,sleep:async()=>{},...extra});
let tests=0;const test=async(name,fn)=>{await fn();tests++;console.log('通过：'+name);};
await test('实际协议连续首杀1→2→3，仅个人记录确认才推进',async()=>{const f=pirateAdvanceFixture();const r=await run(f);assert.equal(r.wins,3);assert.equal(r.spent,900);assert.deepEqual(f.client.writes.map(x=>x.body.uid),[201,202,203]);});
await test('战败即停止，不重复撞同一等级',async()=>{const f=pirateAdvanceFixture({mode:'lose'});const r=await run(f);assert.match(r.reason,/战败/);assert.equal(f.client.writes.length,1);});
await test('等级、预算、汽油保留量、耐久和编队门控',async()=>{
 for(const mutate of [f=>f.settings.pirateHunt.fuelBudget=1,f=>f.settings.pirateHunt.petrolReserve=2900,f=>f.fleet.durability=1,f=>f.building.fleet.formation.heroPositions=[],f=>f.state.stage=99]){const f=pirateAdvanceFixture();mutate(f);await run(f);assert.equal(f.client.writes.length,0);}
 const f=pirateAdvanceFixture();f.settings.pirateHunt.maxLevel=1;assert.equal((await run(f)).wins,1);assert.equal(f.client.writes.length,1);
});
await test('仅配置重叠不阻止首杀，实际空闲舰队允许递进',async()=>{for(const key of ['treasure','cityWar']){const f=pirateAdvanceFixture();f.settings[key].enabled=true;f.settings[key].fleetIds=['1远征船'];const r=await run(f);assert.equal(r.wins,3);assert.equal(f.client.writes.length,3);}});
await test('未知派遣跨重建和再次开启仍不重复',async()=>{const f=pirateAdvanceFixture({mode:'unknown'});f.ledger=ledger();assert.match((await run(f)).reason,/未知/);const again=pirateAdvanceFixture();again.ledger=f.ledger;assert.match((await run(again)).reason,/待确认/);assert.equal(again.client.writes.length,0);});
await test('暂停及时停止，已发出的任务不强制召回',async()=>{const f=pirateAdvanceFixture({mode:'wait'}),controller=new AbortController();await run(f,{signal:controller.signal,onState:()=>controller.abort(new Error('手动停止'))});assert.equal(f.client.writes.length,1);});
await test('发送前参数变化取消，不保留错误汽油额度',async()=>{const f=pirateAdvanceFixture();let on=true;const request=f.client.request;f.client.request=async(...a)=>{const r=await request(...a);if(a[0]==='WorldInfoRequest')on=false;return r;};const l=ledger();await run(f,{ledger:l,enabled:()=>on});assert.equal(f.client.writes.length,0);assert.equal(l.snapshot().uncertain,0);});
await test('汽油库存延迟回写时仍按已派费用扣减保留量',async()=>{const f=pirateAdvanceFixture();f.settings.pirateHunt.petrolReserve=2500;const request=f.client.request;f.client.request=async(...a)=>{const r=await request(...a);if(a[0]==='AllItemRequest')r.items.find(x=>x.itemId==='汽油').num=3000;return r;};const r=await run(f);assert.equal(f.client.writes.length,1);assert.match(r.reason,/保留量/);});
const chestConfig={tables:{GarbageProductionCfg:{data:[{id:'深海宝箱1',type:'打捞',production:['藏品蓝1碎片',1]},{id:'塑料垃圾1',type:'拾取',production:['塑料',1]}]}},materialName:id=>id};
await test('藏品独立开关、10秒等待、真实协议确认奖励且不捞原料',async()=>{const f=pirateAdvanceFixture(),l=ledger(),out=[];let t=100;const act=()=>collectAntiqueFloaters(f.client,chestConfig,{enabled:()=>true,ledger:l,now:()=>t,report:e=>out.push(e)});await act();assert.equal(f.client.writes.length,0);t=111;await act();assert.equal(f.client.writes.length,1);assert.deepEqual(f.client.writes[0].body.floaterId,['深海宝箱1']);assert(out.some(e=>e.ok));await act();assert.equal(f.client.writes.length,1);});
await test('藏品只读预览与关闭均不发送',async()=>{const f=pirateAdvanceFixture();const out=[];await collectAntiqueFloaters(f.client,chestConfig,{enabled:()=>true,dryRun:true,report:e=>out.push(e)});assert(out.some(e=>e.planned));await collectAntiqueFloaters(f.client,chestConfig,{enabled:()=>false,report:()=>assert.fail()});assert.equal(f.client.writes.length,0);});
await test('藏品拒绝等待、未知跨重建不重复',async()=>{for(const mode of ['denied','unknown']){const f=pirateAdvanceFixture(),l=ledger();f.state.pickMode=mode;const opts={enabled:()=>true,ledger:l,report:()=>{},now:()=>100};await collectAntiqueFloaters(f.client,chestConfig,opts);try{await collectAntiqueFloaters(f.client,chestConfig,{...opts,now:()=>111});}catch(e){assert.equal(mode,'unknown');}await collectAntiqueFloaters(f.client,chestConfig,{...opts,now:()=>122});assert.equal(f.client.writes.length,1);if(mode==='unknown'){const again=pirateAdvanceFixture();await collectAntiqueFloaters(again.client,chestConfig,{...opts,now:()=>1000});assert.equal(again.client.writes.length,0);}}});
await test('控制项唯一，修改建筑领取不连带改工厂领取，原始设置不变',async()=>{const all=automationControls.flatMap(c=>c.fields);assert.equal(new Set(all).size,all.length);const s=defaultSettings();s.factory.gain=false;s.building.collect=true;const old=structuredClone(s),n=setAutomationControl(s,'building.collect',false);assert.equal(n.factory.gain,false);assert.deepEqual(s,old);assert.equal(n.building.collect,false);});
await test('旧版导入只补新默认，不更改原值',async()=>{const s=defaultSettings();delete s.pirateHunt;delete s.gather.antiqueFloaters;delete s.schedule.antiqueFloaters;delete s.schedule.heroRecruitRewards;s.building.collect=false;s.factory.gain=true;const n=importAutomationSettings({format:SETTINGS_FORMAT,version:1,settings:s});assert.equal(n.building.collect,false);assert.equal(n.factory.gain,true);assert.equal(n.gather.antiqueFloaters,false);assert.deepEqual(n.pirateHunt.fleetIds,[]);});
await test('未确认首杀占用阻止巨轮与城战抢用同一舰队',async()=>{
 const f=treasureFixture(),settings=treasureSettings(),snapshot=await readTreasureLoot(f.client,f.protocol,f.config,f.player);const keys={['pirate-first:'+snapshot.worldId+':1:1:201']:{confirmed:false,details:{buildingId:'1远征船',outcome:'unknown'}}};
 const plan=planTreasureLoot(snapshot,f.config,settings,{keys});assert(!plan.actions.some(x=>x.buildingId==='1远征船'));assert(plan.notes.some(n=>/首杀结果待确认/.test(n)));
 const w=warForgeFixture(),ws=warForgeSettings(),war=await readCityWar(w.client,w.protocol,w.config,w.player,ws.cityWar,{mapLoader:w.mapLoader});war.attackDura=w.config.tables.WorldParamCfg.data.find(r=>r.paramName==='攻城战消耗耐久').paramValue;
 const wp=planCityWar(war,ws,{keys:{['pirate-first:'+war.worldId+':1:1:201']:{confirmed:true,details:{buildingId:'1远征船',outcome:'started'}}}});assert(!wp.actions.some(x=>x.buildingId==='1远征船'));assert(wp.notes.some(n=>/首杀结果待确认/.test(n)));
});
await test('隔离HTTP控制保存、旧版本拒绝、账号隔离与暂停首杀拦截',async()=>{
 process.env.CW_DATA_DIR=path.join(dir,'http');fs.mkdirSync(process.env.CW_DATA_DIR);
 fs.writeFileSync(path.join(process.env.CW_DATA_DIR,'accounts.json'),JSON.stringify({version:1,activeId:'http-a',accounts:['a','b'].map(id=>({id:'http-'+id,label:'虚构 '+id,url:'ws://127.0.0.1:1',login:{},automation:{paused:true}}))}));
 const {createConsole}=await import('../src/server.mjs');const app=createConsole({port:0});await app.listen();
 const api=async(route,body,account='http-a')=>{const r=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/'+route+'?account='+account,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
 try{const a=await api('settings'),b=await api('settings',null,'http-b');const saved=await api('loop/control',{confirm:true,key:'building.collect',enabled:false,revision:a.data.revision});assert.equal(saved.status,200);assert.equal(saved.data.controls.find(x=>x.key==='building.collect').enabled,false);assert.equal((await api('settings')).data.settings.factory.gain,a.data.settings.factory.gain);
 assert.equal((await api('loop/control',{confirm:true,key:'factory.gain',enabled:false,revision:a.data.revision})).status,400);assert.deepEqual((await api('settings',null,'http-b')).data.settings,b.data.settings);assert.equal((await api('pirates/advance/start',{confirm:true})).status,400);assert(!app.sessions.get('http-a').client);
 }finally{await app.close();delete process.env.CW_DATA_DIR;}
});
console.log('统一挂机/首杀/藏品专项 '+tests+'/'+tests+' 通过');
