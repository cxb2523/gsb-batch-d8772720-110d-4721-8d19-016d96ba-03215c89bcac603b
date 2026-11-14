// 实时地图只读表达：时间位置推算、官方默认名称、汽油记账和城战数据。
import assert from 'node:assert/strict';import vm from 'node:vm';
import {mapMotionPosition} from '../src/world-map-geometry.mjs';
import {readWorldOverview} from '../src/world-overview.mjs';
import {commentsEighteenFixture} from './fixtures/comments-eighteen.mjs';
import {PAGE} from '../src/page.mjs';
let count=0;const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
const ledger={keyRecords:()=>({}),snapshot:()=>({day:'2026-11-04',counters:{treasurePetrol:8000,treasureRepairPetrol:4000,cityWarPetrol:5000,radarPetrol:1000,worldBossPetrol:300}}),confirmedCounters:()=>({treasurePetrol:6000,treasureRepairPetrol:2000,cityWarPetrol:5000,radarPetrol:1000,worldBossPetrol:300}),pendingCounters:()=>({treasurePetrol:2000,treasureRepairPetrol:2000})};
await test('行军中点按时间推算；开始前不倒走，到时只标待同步不假报已抵达',()=>{
 const p={x:0,y:0,motion:{start:{x:0,y:10},end:{x:100,y:30},startAt:100,endAt:290}};
 assert.deepEqual(mapMotionPosition(p,195),{x:50,y:20,estimated:true,progress:.5,remaining:95,awaitingSync:false});assert.equal(mapMotionPosition(p,50).progress,0);assert.equal(mapMotionPosition(p,300).remaining,0);assert.equal(mapMotionPosition(p,300).awaitingSync,true);
 assert.equal(mapMotionPosition({...p,motion:{...p.motion,endAt:100}},150).estimated,false);
});
await test('空联盟名按游戏出生主城取名，不再使用联盟2/4；有自定义名时保留',async()=>{
 const f=await commentsEighteenFixture();const cities=f.config.tables['1_CityCfg'].data;
 for(const id of [3,4])f.responses.WorldInfoRequest.cities.push({id:cities.find(c=>c.guildIndex===id).id,guildIdx:id,battlePoints:[],attackFleetNum:0,defenceFleetNum:0});
 f.responses.AllGuildAbstractionRequest.guilds=[{id:1001,name:'自定义联盟'},{id:1002},{id:1003,name:'青玄'},{id:1004}];
 const d=await readWorldOverview(f.client,f.config,f.player,f.settings,ledger,{mapLoader:async()=>f.map});assert.equal(d.owners.find(o=>o.id===2).name,'铁锈湾');assert.equal(d.owners.find(o=>o.id===4).name,'风栖港');assert.match(d.owners.find(o=>o.id===1).name,/自定义联盟/);
});
await test('本日已确认耗油不重复加巨轮维修，未决费用单列',async()=>{
 const f=await commentsEighteenFixture(),d=await readWorldOverview(f.client,f.config,f.player,f.settings,ledger,{mapLoader:async()=>f.map});assert.equal(d.fuelUsage.confirmed,12300);assert.equal(d.fuelUsage.pending,2000);assert.equal(d.fuelUsage.activities.length,6);assert.equal(d.fuelUsage.stock,99999);
});
await test('硅矿已确认和待确认汽油分别计入世界概览，不漏记或重复累计',async()=>{
 const f=await commentsEighteenFixture(),withSilicon={...ledger,snapshot:()=>({...ledger.snapshot(),counters:{...ledger.snapshot().counters,siliconPetrol:700}}),confirmedCounters:()=>({...ledger.confirmedCounters(),siliconPetrol:500}),pendingCounters:()=>({...ledger.pendingCounters(),siliconPetrol:200})};
 const d=await readWorldOverview(f.client,f.config,f.player,f.settings,withSilicon,{mapLoader:async()=>f.map});assert.equal(d.fuelUsage.confirmed,12800);assert.equal(d.fuelUsage.pending,2200);assert.deepEqual(d.fuelUsage.activities.find(row=>row.name==='硅矿（含维修）'),{name:'硅矿（含维修）',confirmed:500,pending:200});
});
await test('己方与其他行军都有起终点时间；静止舰队不生成虚构征程',async()=>{
 const f=await commentsEighteenFixture(),d=await readWorldOverview(f.client,f.config,f.player,f.settings,ledger,{mapLoader:async()=>f.map});assert.equal(d.fleets[0].journey,null);assert(d.fleets[1].journey.from);assert.equal(d.fleets[2].journey.to,'万吨货轮');
 const foreign=d.points.find(p=>p.layer==='traffic');assert(foreign.motion);assert.equal(foreign.motion.to,'万吨货轮');assert.equal(mapMotionPosition(foreign,foreign.motion.startAt).x,foreign.motion.start.x);
});
await test('宣战/交战/集结及攻守优先+普通排队来自独立字段',async()=>{
 const f=await commentsEighteenFixture(),d=await readWorldOverview(f.client,f.config,f.player,f.settings,ledger,{mapLoader:async()=>f.map}),city=d.points.find(p=>p.cityId===f.targetCity);assert(city.declared&&city.fighting&&city.assemble);assert.equal(city.warRole,'attack');assert.deepEqual([city.cityInfo.priorityAttack,city.cityInfo.attack,city.cityInfo.priorityDefence,city.cityInfo.defence],[2,8,3,7]);assert.equal(city.cityInfo.fighters.length,1);
});
await test('生成页面包含同一推算函数、10秒刷新和征程，所有内嵌脚本可解析',()=>{
 for(const m of PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);assert(PAGE.includes(mapMotionPosition.toString()));assert(PAGE.includes('world-map-refresh-seconds'));assert(PAGE.includes('worldMapRefreshEvery=10'));assert(PAGE.includes("'征程'"));
});
console.log('实时地图展示专项 '+count+'/'+count+' 通过');
