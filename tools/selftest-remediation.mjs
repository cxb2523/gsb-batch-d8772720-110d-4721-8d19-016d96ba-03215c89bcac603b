import os from 'node:os';
// 审计修复专项：仅隔离账号、内存对象和本机HTTP，不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {defaultSettings,saveAutomationSettings} from '../src/automation-settings.mjs';
import {reserveDispatch,dispatchReservationReason} from '../src/fleet-availability.mjs';
import {factoryRecipeAvailability,planWorld,runWorld} from '../src/world.mjs';
import {pirateAdvanceFixture} from './fixtures/pirate-advance.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-remediation-test-'));
let count=0;const check=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
await check('实际HTTP草稿预览不改变运行城战预留、设置或用量',async()=>{
 process.env.CW_DATA_DIR=dir;
 const f=pirateAdvanceFixture();f.client.stop=()=>{f.client.connected=false;};f.player.guildId='1001007';f.settings.cityWar.enabled=true;f.settings.cityWar.fleetIds=['1远征船'];
 f.settings.radar.enabled=true;f.settings.radar.fleetIds=['1远征船'];
 const original=f.client.request;f.client.request=async(n,b,r)=>n==='RadarInfoRequest'?{radarInfo:{events:[]}}:original(n,b,r);
 fs.writeFileSync(path.join(dir,'accounts.json'),JSON.stringify({version:1,activeId:'audit',accounts:[{id:'audit',url:'ws://127.0.0.1:1',login:{},automation:{paused:true,enabled:false}}]}));
 saveAutomationSettings('audit',f.settings,{revision:0});
 const {createConsole}=await import('../src/server.mjs');const app=createConsole({port:0});await app.listen();
 try{
  const base='http://127.0.0.1:'+app.server.address().port;
  const saved=await fetch(base+'/api/settings?account=audit').then(r=>r.json());const session=app.sessions.get('audit');session.client=f.client;session.player=f.player;session.paused=false;
  reserveDispatch(f.client,'cityWar',['1远征船']);const before=dispatchReservationReason(f.client,saved.settings,'radar','1远征船');assert.ok(before);
  const draft=structuredClone(saved.settings);draft.cityWar.enabled=false;
  for(const category of ['radar','pirateHunt']){
   const reply=await fetch(base+'/api/settings/preview?account=audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({settings:draft,category})});const body=await reply.json();assert.equal(reply.status,200,body.error);
   assert.equal(dispatchReservationReason(f.client,saved.settings,'radar','1远征船'),before);
  }
  const after=await fetch(base+'/api/settings?account=audit').then(r=>r.json());assert.equal(after.revision,saved.revision);assert.deepEqual(after.usage,saved.usage);assert.equal(f.client.writes.length,0);
 }finally{app.server.closeAllConnections();await app.close();}
});
await check('活动配方只在真实窗口开放；未同步、未开放、已过期均无排产',()=>{
 const recipe={buildType:'活动工厂',itemId:'钩',limitType:'活动甲',unlockLevel:1,costItem:[['木材',1]],produceTime:60};
 const events=[{festivalData:{limitTimeItem:[{item:'活动甲',openTime:100,closeTime:200}]}}];
 assert.equal(factoryRecipeAvailability(recipe,null,150).allowed,false);
 for(const time of [99,201])assert.equal(factoryRecipeAvailability(recipe,events,time).allowed,false);
 assert.equal(factoryRecipeAvailability(recipe,events,150).allowed,true);
 const building={buildingId:'1活动工厂',type:'活动工厂',level:1,factory:{factoryQ:[],finishedProducts:[]},product:[]};const stock=new Map([['木材',20]]);
 const survey={now:201,serverNow:201,player:{level:30},stock,have:id=>stock.get(id)??0,buildings:[building],factories:[building],orders:[],notes:[],weekOrder:new Map(),cargoOrder:new Map(),stockCap:50,factorySlots:6,population:1,maxPopulation:10,futurePopulation:1,festivals:events,orderOfTheDay:{orderNum:0,rewardedNum:0}};
 const config={materialName:id=>id,tables:{BuildingCfg:{data:[{buildingType:'活动工厂',name:'活动工坊'}]},BuildingProduceCfg:{data:[recipe]}}};
 const plan=planWorld(survey,{config,settings:defaultSettings(),enabled:k=>k==='startProduce'});assert.equal(plan.actions.length,0);assert.match(plan.notes.join(' '),/未开放/);assert.match(plan.factoryReasons.get(building.buildingId),/活动未开放/);
});
await check('活动工坊明确拒绝跨轮不重试；开放窗口变化才允许再次尝试',async()=>{
 const now=Math.floor(Date.now()/1000),recipe={buildType:'活动工厂',itemId:'钩',limitType:'活动甲'};
 const client={festivals:[{festivalData:{limitTimeItem:[{item:'活动甲',openTime:now-100,closeTime:now+1000}]}}],sendWatch:async()=>{writes++;throw Object.assign(new Error('server prompt: limited item not available'),{prompt:true,request:'StartFactoryProduceRequest'});}};let writes=0;
 const config={tables:{BuildingProduceCfg:{data:[recipe]}}},step={kind:'startProduce',request:'StartFactoryProduceRequest',body:{buildingId:'1活动工厂',productId:'钩'},eligibilityKey:'window1'};
 const options={allowMutate:true,config,settings:defaultSettings()};
 await runWorld(client,{StartFactoryProduceRequest:true},{actions:[step,step]},options);await runWorld(client,{StartFactoryProduceRequest:true},{actions:[step]},options);assert.equal(writes,1);
 step.eligibilityKey='window2';await runWorld(client,{StartFactoryProduceRequest:true},{actions:[step]},options);assert.equal(writes,2);
 client.festivals[0].festivalData.limitTimeItem[0].closeTime=now-1;step.eligibilityKey='window3';await runWorld(client,{StartFactoryProduceRequest:true},{actions:[step]},options);assert.equal(writes,2);
});
console.log('审计修复专项 '+count+'/'+count+' 通过');
