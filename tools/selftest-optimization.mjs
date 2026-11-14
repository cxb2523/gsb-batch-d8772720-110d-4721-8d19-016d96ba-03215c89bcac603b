import os from 'node:os';
// 本轮优化验收：受控协议、生产依赖、未知结果与预算边界；不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {defaultSettings,validateSettings,createUsageLedger,nativeTaskValues} from '../src/automation-settings.mjs';
import {planWorld,settingDemands,runWorld} from '../src/world.mjs';
import {runAllianceRadar,readAllianceRadar} from '../src/alliance-radar.mjs';
import {planRadarPreview} from '../src/dispatch-preview.mjs';
import {reserveDispatch,dispatchReservationReason} from '../src/fleet-availability.mjs';
import {readWorldOverview} from '../src/world-overview.mjs';
import {watchBasePushes} from '../src/base-automation.mjs';
import {pirateAdvanceFixture} from './fixtures/pirate-advance.mjs';
import {inspectHunt} from '../src/pirates.mjs';
import {runSinglePirateHunt} from '../src/pirate-advance.mjs';
import {PAGE} from '../src/page.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-optimization-test-'));
let passed=0;const test=async(name,fn)=>{await fn();console.log('通过：'+name);passed++;};
await test('汽油0不限额，试炼默认450，导入已有200不覆盖',()=>{
 const s=defaultSettings();assert.equal(s.trials.dailyDiamondBudget,450);
 s.radar.dailyPetrolLimit=s.cityWar.dailyPetrolLimit=s.cityWar.maxRepairCost=s.treasure.maxRepairCost=s.treasure.dailyRepairPetrolLimit=s.pirateHunt.fuelBudget=0;
 for(const group of ['radar','cityWar','treasure','pirateHunt'])assert.deepEqual(validateSettings(s)[group],s[group]);assert.equal(validateSettings({trials:{dailyDiamondBudget:200}},{partial:true}).trials.dailyDiamondBudget,200);
 assert.throws(()=>validateSettings({...s,fleetDispatch:{priority:['radar']}}),/保留全部任务/);
});
const cfg={materialName:id=>id,tables:{BuildingCfg:{data:[{buildingType:'种子厂',name:'种子厂'}]},BuildingProduceCfg:{data:[{itemId:'番茄种子',buildType:'种子厂',unlockLevel:1,costItem:[['种子',1]],produceTime:60},{itemId:'小麦种子',buildType:'种子厂',unlockLevel:1,costItem:[['种子',1]],produceTime:50}]},FarmlandPlantCfg:{data:[{id:'番茄',material:['番茄种子',1],produceNum:5,time:60}]}}};
const factory={buildingId:'1种子厂',type:'种子厂',level:1,buildStartTime:0,buildFinishTime:0,factory:{autoProductId:'小麦种子',factoryQ:[{productId:'小麦种子'}],finishedProducts:[]}};
function survey(){const stock=new Map([['种子',10]]);return{now:100,serverNow:100,player:{level:30},stock,have:id=>stock.get(id)??0,buildings:[structuredClone(factory)],factories:[],orders:[],notes:[],weekOrder:new Map(),cargoOrder:new Map([['番茄',10]]),orderOfTheDay:{orderNum:0,rewardedNum:0},stockCap:50,factorySlots:1,population:1,futurePopulation:1,maxPopulation:10,autoProduceForever:true,autoProduceEndTime:0,cropIds:new Set(['番茄']),floaters:[],fleets:[]};}
const s=defaultSettings();s.factory.cooperateNative=true;s.factory.demandPriority=['cargo'];s.building.build=s.building.upgrade=s.building.speedUp=s.factory.speedUp=false;s.resident.enabled=false;
const needs=[{source:'cargo',requirements:[{id:'番茄',num:10}]}];
await test('作物缺口换算种子，已在田作物与种子队列扣除，避免重复补料',()=>{
 const v=survey();v.factories=[...v.buildings];
 let need=settingDemands(v,cfg,needs,['cargo']);assert.equal(need.get('番茄种子').num,2);
 v.buildings.push({farm:{productId:'番茄'}});v.factories[0].factory.factoryQ.push({productId:'番茄种子'});
 need=settingDemands(v,cfg,needs,['cargo']);assert.equal(need.get('番茄').num,5);assert.equal(need.get('番茄种子').num,0);
});
await test('联盟补料与居民订单共享预留，移除订单来源仍保留一次水位',()=>{
 const v={factories:[],buildings:[],have:()=>0},config={tables:{}};
 const resident={source:'resident',requirements:[{id:'木材',num:3}]};
 const recruit={source:'guildRecruit',requirements:[{id:'木材',num:2}],reserved:[{id:'木材',num:3}]};
 for(const priority of [['resident','guildRecruit'],['guildRecruit','resident'],['guildRecruit']]){
  const need=settingDemands(v,config,[resident,recruit],priority).get('木材');
  assert.equal(need.required,5);assert.equal(need.num,5);
  assert.equal(Object.values(need.productionBySource).reduce((a,b)=>a+b,0),need.num);
 }
 const ship={source:'guildShip',requirements:[{id:'木材',num:4}],reserved:[{id:'木材',num:3}]};
 for(const priority of [['resident','guildRecruit','guildShip'],['guildShip','guildRecruit']]){
  const need=settingDemands(v,config,[resident,recruit,ship],priority).get('木材');
  assert.equal(need.required,9);assert.equal(need.num,9);
 }
 ship.reserved[0].num=5;
 assert.equal(settingDemands(v,config,[resident,recruit,ship],['guildRecruit','resident','guildShip']).get('木材').required,11);
 assert.equal(settingDemands(v,config,[resident,recruit],['resident']).get('木材').required,3);
});
await test('共享预留扣除部分已选订单与待收在产，自身缺口保留独立来源',()=>{
 const v={factories:[],buildings:[],have:()=>3},config={tables:{}};
 const records=[{source:'resident',requirements:[{id:'木材',num:2}]},{source:'cargo',requirements:[{id:'木材',num:1}]},
  {source:'guildRecruit',requirements:[{id:'木材',num:2}],reserved:[{id:'木材',num:3}]}];
 for(const priority of [['guildRecruit','resident','cargo'],['guildRecruit','resident'],['guildRecruit']]){
  const need=settingDemands(v,config,records,priority).get('木材');
  assert.equal(need.required,5);assert.equal(need.num,2);assert.deepEqual(need.productionBySource,{guildRecruit:2});
  assert(need.sources.includes('guildRecruit'));assert.equal(need.priority,0);
 }
 v.factories=[{factory:{factoryQ:[{productId:'木材'}],finishedProducts:[{id:'木材',num:1}]}}];
 const stocked=settingDemands(v,config,records,['guildRecruit','resident','cargo']).get('木材');
 assert.equal(stocked.required,5);assert.equal(stocked.unfilled,1);assert.equal(stocked.num,0);
 assert.deepEqual(stocked.productionBySource,{});
});
await test('独立补料递归原料只计真实缺口，共同预留不重复派生原料',()=>{
 const v={factories:[],buildings:[],have:id=>id==='产品'?3:0};
 const config={tables:{BuildingProduceCfg:{data:[{itemId:'产品',costItem:[['木材',2]]}]}}};
 const records=[{source:'resident',requirements:[{id:'产品',num:3}]},
  {source:'guildRecruit',requirements:[{id:'产品',num:2}],reserved:[{id:'产品',num:3}]},
  {source:'guildShip',requirements:[{id:'产品',num:4}],reserved:[{id:'产品',num:3}]}];
 const need=settingDemands(v,config,records,['guildRecruit','resident','guildShip']);
 assert.equal(need.get('产品').required,9);assert.equal(need.get('产品').num,6);
 assert.equal(need.get('木材').required,12);assert.equal(need.get('木材').num,12);
 assert.deepEqual(need.get('木材').productionBySource,{guildRecruit:4,guildShip:8});
 assert.deepEqual(need.get('木材').sources,['guildRecruit','guildShip']);
});
await test('省略作物订单来源时预留与自身需求合并计算种子批次',()=>{
 const v={factories:[],buildings:[],have:()=>0};
 const records=[{source:'resident',requirements:[{id:'番茄',num:3}]},
  {source:'guildRecruit',requirements:[{id:'番茄',num:2}],reserved:[{id:'番茄',num:3}]}];
 const need=settingDemands(v,cfg,records,['guildRecruit']);
 assert.equal(need.get('番茄').required,5);assert.equal(need.get('番茄种子').required,1);
 assert.deepEqual(need.get('番茄种子').productionBySource,{guildRecruit:1});
});
let nativeStep;
await test('永久原生自动生产可以按需求切换；满队列不取消，不反复切换当前目标',()=>{
 const v=survey();v.factories=[...v.buildings];const before=structuredClone(v.buildings);
 const plan=planWorld(v,{config:cfg,settings:s,enabled:k=>k==='startProduce'});nativeStep=plan.actions.find(a=>a.request==='SetFactoryAutoProduceRequest');
 assert.equal(nativeStep.body.productId,'番茄种子');assert.deepEqual(v.buildings,before);assert.match(plan.notes.join(' '),/缺番茄.*番茄种子/);
 v.factories[0].factory.autoProductId='番茄种子';assert.equal(planWorld(v,{config:cfg,settings:s,enabled:k=>k==='startProduce'}).actions.length,0);
 s.factory.cooperateNative=false;v.factories[0].factory.autoProductId='小麦种子';assert.equal(planWorld(v,{config:cfg,settings:s,enabled:k=>k==='startProduce'}).actions.length,0);s.factory.cooperateNative=true;
});
await test('原生协同独立开启，不启用普通生产，不给活动工坊补库存',()=>{
 const v=survey();const extra={...structuredClone(factory),buildingId:'2种子厂',factory:{factoryQ:[],finishedProducts:[]}};v.buildings.push(extra);v.factories=[...v.buildings];const settings=structuredClone(s);settings.factory.produce=false;
 const flags=nativeTaskValues(settings,{});assert.equal(flags.startProduce,true);assert.equal(settings.factory.produce,false);
 const actions=planWorld(v,{config:cfg,settings,enabled:k=>flags[k]===true}).actions;assert.equal(actions.filter(a=>a.request==='SetFactoryAutoProduceRequest').length,1);assert.equal(actions.filter(a=>a.request==='StartFactoryProduceRequest').length,0);
 v.stock.set('种子',0);const blocked=planWorld(v,{config:cfg,settings,enabled:k=>flags[k]===true});assert.equal(blocked.actions.length,0);assert.match(blocked.notes.join(' '),/原生协同等待原料.*缺1/);
});
await test('原生目标必须回读确认；未知不重复；发送前关闭协同会取消',async()=>{
 let writes=0,target='小麦种子';const client={request:async()=>({autoProduceForever:true,building:[{buildingId:'1种子厂',factory:{autoProductId:target}}]}),sendWatch:async()=>{writes++;}};
 const args={allowMutate:true,window:0,settings:s,getSettings:()=>s,config:cfg};
 let result=await runWorld(client,{SetFactoryAutoProduceRequest:true},{actions:[nativeStep]},args);assert.equal(result.results[0].status,'unknown');assert.equal(writes,1);
 await runWorld(client,{SetFactoryAutoProduceRequest:true},{actions:[nativeStep]},args);assert.equal(writes,1);
 const other={...client,sendWatch:async()=>{throw Error('不应发送');}};
 await runWorld(other,{SetFactoryAutoProduceRequest:true},{actions:[nativeStep]},{...args,beforeStep:()=>{s.factory.cooperateNative=false;}});s.factory.cooperateNative=true;
 const confirmed={...client,sendWatch:async()=>{target='番茄种子';}};result=await runWorld(confirmed,{SetFactoryAutoProduceRequest:true},{actions:[nativeStep]},args);assert.equal(result.results[0].status,'confirmed');
});
await test('城战时段与高优先级手动首杀预留，过期或释放后可共享',()=>{
 const client={},settings=defaultSettings();reserveDispatch(client,'pirateHunt',['1远征船']);assert.match(dispatchReservationReason(client,settings,'radar','1远征船'),/首杀/);
 settings.fleetDispatch.priority=['radar','pirateHunt','treasure','cityWar'];assert.equal(dispatchReservationReason(client,settings,'radar','1远征船'),'');
 settings.cityWar.enabled=true;settings.cityWar.fleetIds=['1远征船'];reserveDispatch(client,'cityWar',['1远征船']);assert.match(dispatchReservationReason(client,settings,'radar','1远征船'),/城战/);
 reserveDispatch(client,'cityWar',[]);reserveDispatch(client,'pirateHunt',['1远征船'],0);assert.equal(dispatchReservationReason(client,settings,'radar','1远征船'),'');
});
await test('情报0预算仍受实际库存、保留量和统一舰队预留限制，预览不写入',async()=>{
 const f=pirateAdvanceFixture();f.player.guildId='1001007';f.config.tables.ModuleOpenCfg.data.push({moduleId:'联盟情报',playerLevel:18});f.config.tables.WorldParamCfg.data.push({paramName:'情报事件消耗汽油',paramValue:500});
 const settings=f.settings;settings.radar={...settings.radar,enabled:true,fleetIds:['1远征船','2远征船'],dailyPetrolLimit:0,petrolReserve:0,types:['pirate']};
 const fleets=[f.fleet,{...f.fleet,buildingId:'2远征船'}],events=[1,2].map(i=>({uid:String(9000+i),eventId:10001,gridIdx:100+i,state:1,createTime:10,pirate:{type:1,level:1}}));const original=f.client.request;
 f.client.request=async(n,b,r)=>n==='RadarInfoRequest'?{radarInfo:{events}}:n==='MyFleetsRequest'?{fleets}:n==='OnWaterRequest'?{building:fleets.map(v=>({...f.building,buildingId:v.buildingId}))}:n==='AllItemRequest'?{items:[{itemId:'汽油',num:800}]}:original(n,b,r);
 const ledger=createUsageLedger('test',{file:path.join(dir,'radar.json')});const snapshot=await readAllianceRadar(f.client,f.config,f.player);let plan=planRadarPreview(snapshot,settings,ledger,f.client);assert.equal(plan.actions.filter(a=>a.kind==='radarSend').length,1);assert.equal(f.client.writes.length,0);
 let writes=0;f.client.sendWatch=async(n,b)=>{writes++;const e=events.find(e=>e.uid===String(b.uid)),fleet=fleets.find(f=>f.buildingId===b.fleetBuildingIds[0]);e.state=2;fleet.state=2;fleet.targetGridIdx=e.gridIdx;};
 await runAllianceRadar(f.client,f.config,f.player,{getSettings:()=>settings,ledger,enabled:()=>true,canUseFleet:id=>id==='2远征船',report:()=>{}});assert.equal(writes,1);assert.equal(fleets[0].state,1);assert.equal(ledger.snapshot().counters.radarPetrol,500);
});
await test('单次手动首杀也保留汽油与舰队锁，未知结果阻止重复派遣',async()=>{
 const f=pirateAdvanceFixture(),ledger=createUsageLedger('single',{file:path.join(dir,'single.json')});const snap=await inspectHunt(f.client,f.config,f.player);let sent=0;f.client.sendWatch=async()=>{sent++;throw Error('发送结果未知');};
 const args={targetKey:snap.view.targets[0].targetKey,fleetKey:snap.view.fleets[0].key,enabled:()=>true,getSettings:()=>f.settings,ledger};
 const result=await runSinglePirateHunt(f.client,f.config,f.player,args);assert.equal(result.status,'unknown');assert.equal(ledger.snapshot().counters.piratePetrol,300);assert.equal(ledger.snapshot().uncertain,1);
 await assert.rejects(()=>runSinglePirateHunt(f.client,f.config,f.player,args));assert.equal(sent,1);
});
await test('地图只发送读取请求，缺失图层标未同步，不伪造坐标和库存',async()=>{
 const calls=[],client={request:async(name)=>{calls.push(name);if(name==='WorldInfoRequest')return{cities:[{id:1,guildIdx:7,attackFleetNum:0,defenceFleetNum:0}]};if(name==='MyFleetsRequest')return{fleets:[{buildingId:'1远征船',state:1,curGridIdx:0,cityId:1,durability:100,maxDura:100}]};if(name==='AllItemRequest')throw Error('读取失败');if(name==='AllPirateRequest')return{pirates:[{uid:2,level:1,gridIdx:0},{uid:3,level:2,gridIdx:15}]};if(name==='MyResFieldsRequest')return{info:{fields:[]}};throw Error('未同步');}};
 const map={width:10,height:10,cityInfo:{1:{gridIdx:11}},fieldAt:()=>null};const ledger=createUsageLedger('map',{file:path.join(dir,'map.json')});
 const data=await readWorldOverview(client,{tables:{'1_CityCfg':{data:[{id:1,name:'测试城',guildIndex:7}]}}},{scenarioId:1,guildId:'1001007'},defaultSettings(),ledger,{mapLoader:async()=>map});
 assert.equal(data.layers.treasure,'未同步');assert.equal(data.resources[0].value,null);assert.equal(data.points.filter(p=>p.layer==='pirates').length,1);assert.equal(data.fleets[0].state,'主城空闲');assert.ok(calls.every(n=>/^(WorldInfo|MyFleets|AllItem|MyResFields|TreasureLootList|AllPirate|RadarInfo|WorldBossInfo|AllGuildAbstraction|WarDeclaration)Request$/.test(n)));
});
await test('随机事件断线重连清除旧状态，未同步与空列表可区分',()=>{
 const client=new EventEmitter(),state=watchBasePushes(client);assert.equal(state.choiceObserved,false);client.emit('message',{name:'SCChoiceEventUpdate',body:{events:[]}});assert.equal(state.choiceObserved,true);client.emit('close');assert.equal(state.choiceObserved,false);assert.equal(state.choices.size,0);
});
await test('生成页面脚本语法有效，独立预览与地图入口完整',()=>{
 for(const match of PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 assert.ok(PAGE.includes('value="radar"'));assert.ok(PAGE.includes('value="pirateHunt"'));assert.ok(PAGE.includes('world-map-refresh'));assert.ok(PAGE.includes('idle-filter'));
});
console.log('整轮优化专项 '+passed+'/'+passed+' 通过');
