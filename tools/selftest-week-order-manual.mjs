import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { commentsEighteenFixture } from './fixtures/comments-eighteen.mjs';
import { activityEntries,activityView,runActivity,runWeekOrder } from '../src/activities.mjs';
import { createUsageLedger,defaultSettings } from '../src/automation-settings.mjs';
import { readOrderReservedStock } from '../src/order-reservations.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-week-order-'));
const f=await commentsEighteenFixture(),cfg=f.config,p=f.protocol,original=f.client.request;
const bag=f.responses.AllItemRequest.items,order=f.responses.WeekOrderInfoRequest;order.order=[{id:'冲浪板',num:1}];
const settings=defaultSettings();settings.resources.allowDiamonds=true;let ruby=2000,mode='normal';const writes=[];
f.client.request=async(n,b={},resp=n.replace(/Request$/,'Response'))=>{
 if(n==='AllResourceRequest')return {list:[{res:4,amount:ruby}]};
 if(n==='CargoShipsRequest')return {ship:[]};
 if(!['CommonBuyGoodsRequest','FinishWeekOrderRequest'].includes(n))return original(n,b,resp);
 const body=p[n].decode(p[n].encode(b).finish());writes.push(n);
 if(mode==='lost')throw Error('timeout');if(mode==='reject')throw Object.assign(Error('rejected'),{prompt:{prompt:5},request:n});
 if(n==='CommonBuyGoodsRequest'){assert.equal(body.goods[0].itemId,'冲浪板');assert.equal(body.goods[0].num,1);ruby-=320;bag.push({itemId:'冲浪板',num:1});return p[resp].decode(p[resp].encode({reward:{asset:[{id:'冲浪板',num:1}]}}).finish());}
 const id=cfg.tables.WeekOrderRwdCfg.data.find(x=>!order.gotRwdId.includes(x.rwdId)&&x.rwdId>0).rwdId;order.gotRwdId.push(id);order.order=[{id:'木材',num:2}];
 return p[resp].decode(p[resp].encode({randomRwdId:id,newOrder:order.order}).finish());
};
const ledger=createUsageLedger('week-test',{file:path.join(dir,'usage.json')});
const current=async()=>(await activityView(f.client,f.client.festivals,cfg)).order;
const call=(action,payload)=>runWeekOrder(f.client,cfg,settings,ledger,()=>true,action,payload,{player:f.player});
const reserved=(client=f.client,player=f.player)=>readOrderReservedStock(client,p,cfg,{player});
const initial=await current(),quote={orderKey:initial.orderKey,itemId:'冲浪板',quantity:1,cost:320};
assert.equal(initial.materials[0].price,320);
await assert.rejects(call('submit',quote),/未齐/);
await assert.rejects(call('buy',{...quote,cost:1}),/报价/);
settings.resources.allowDiamonds=false;await assert.rejects(call('buy',quote),/关闭/);settings.resources.allowDiamonds=true;
settings.resources.diamondThreshold=1900;await assert.rejects(call('buy',quote),/保留/);settings.resources.diamondThreshold=0;
assert.equal(writes.length,0);mode='reject';await assert.rejects(call('buy',quote));mode='normal';
await call('buy',quote);assert.equal(ledger.snapshot().counters.diamonds,320);await assert.rejects(call('buy',quote));
await call('submit',quote);await assert.rejects(call('submit',quote),/订单已变化/);
assert.equal((await reserved()).stock.get('冲浪板'),1,'整单档位已回读并重新读取完整库存，不依赖旧余额下降');
const next=await current();
bag.find(row=>row.itemId==='冲浪板').num=0;
assert.equal((await reserved()).stock.get('冲浪板'),0,'完整库存确认扣款后解除预留');
mode='lost';await assert.rejects(call('submit',{orderKey:next.orderKey}));await assert.rejects(call('submit',{orderKey:next.orderKey}),/已提交/);
await assert.rejects(reserved({...f.client}),{code:'ORDER_MATERIAL_SPEND_PENDING'},'超时后的预留跨连接保留');
await reserved(f.client,{...f.player,playerId:'9007199254740995'});
await assert.rejects(reserved(),{code:'ORDER_MATERIAL_SPEND_PENDING'},'其他账号的完整库存不能解除本账号预留');
const activity=activityEntries(f.client,f.responses.WeekInfoRequest.activityTime).find(row=>row.weekType===5);
await assert.rejects(runActivity(f.client,cfg,{activityId:activity.id,taskKey:'weekOrderSubmit',getSettings:()=>settings,ledger,player:f.player}),/已提交/);
assert.equal(writes.length,4);

// A definite server rejection releases both ledgers; a local failure before
// sending must not create a persistent operation record either.
const rejected=await commentsEighteenFixture(),rejectedLedger=createUsageLedger('reject',{file:path.join(dir,'reject.json')});
rejected.player.playerId='9007199254740997';let rejectedWrites=0,reject=true;
const rejectedRequest=rejected.client.request;
rejected.client.request=async(n,b={},resp=n.replace(/Request$/,'Response'))=>{
 if(n!=='FinishWeekOrderRequest')return rejectedRequest(n,b,resp);
 rejectedWrites++;
 if(reject)throw Object.assign(Error('rejected'),reject==='notSent'?{notSent:true}:{prompt:{prompt:5},request:n});
 const row=rejected.responses.WeekOrderInfoRequest,id=cfg.tables.WeekOrderRwdCfg.data.find(x=>!row.gotRwdId.includes(x.rwdId)&&x.rwdId>0).rwdId;
 row.gotRwdId.push(id);return {randomRwdId:id};
};
const rejectedOrder=(await activityView(rejected.client,rejected.client.festivals,cfg)).order;
const rejectedCall=player=>runWeekOrder(rejected.client,cfg,settings,rejectedLedger,()=>true,'submit',{orderKey:rejectedOrder.orderKey},{player});
await assert.rejects(rejectedCall(null),/材料消费账号/);assert.equal(rejectedWrites,0);assert.deepEqual(rejectedLedger.keyRecords(),{});
await assert.rejects(rejectedCall(rejected.player),/rejected/);assert.deepEqual(rejectedLedger.keyRecords(),{});
reject='notSent';await assert.rejects(rejectedCall(rejected.player));assert.deepEqual(rejectedLedger.keyRecords(),{});assert.equal(rejectedLedger.snapshot().uncertain,0);
reject=false;await rejectedCall(rejected.player);assert.equal(rejectedWrites,3);

let purchaseSerial=0;
async function purchaseScenario(){
 const f=await commentsEighteenFixture(),player={...f.player,playerId:String(9010000+purchaseSerial++)},original=f.client.request;
 f.responses.WeekOrderInfoRequest.order=[{id:'冲浪板',num:1}];
 f.responses.AllItemRequest.items=f.responses.AllItemRequest.items.filter(r=>r.itemId!=='冲浪板');
 const state={ruby:2000,writes:0,income:0,readFailure:false,malformed:false,lost:false,notSent:false,paused:false,dayOffset:0};
 const file=path.join(dir,'purchase-'+purchaseSerial+'.json');let ledger=createUsageLedger('purchase',{file,now:()=>Date.now()+state.dayOffset});
 f.client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{
  if(name==='AllItemRequest'&&state.writes){if(state.readFailure)throw Object.assign(Error('库存读取失败'),state.readFailure==='notSent'?{notSent:true,request:name}:{});if(state.malformed)return {items:[{itemId:'冲浪板',num:1},{itemId:'冲浪板',num:1}]};}
  if(name==='AllResourceRequest')return {list:[{res:4,amount:state.ruby}]};
  if(name==='CommonBuyGoodsRequest'){
   state.writes++;if(state.notSent)throw Object.assign(Error('购买未发送'),{notSent:true});state.ruby+=state.income-320;f.responses.AllItemRequest.items.push({itemId:'冲浪板',num:1});
   if(state.lost)throw Error('购买回包丢失');
   return {reward:{asset:[{type:0,id:'冲浪板',num:1}]}};
  }
  return original(name,body,response);
 };
 const view=(await activityView(f.client,f.client.festivals,cfg)).order,quote={orderKey:view.orderKey,itemId:'冲浪板',quantity:1,cost:320};
 return {f,player,state,quote,get ledger(){return ledger;},reload(){ledger=createUsageLedger('purchase',{file,now:()=>Date.now()+state.dayOffset});},
  run:()=>runWeekOrder(f.client,cfg,settings,ledger,()=>!state.paused,'buy',quote,{player})};
}
{
 const s=await purchaseScenario();s.state.income=500;await s.run();assert.equal(s.state.ruby,2180);assert.equal(s.ledger.snapshot().uncertain,0);assert.equal(s.state.writes,1);
}
{
 const s=await purchaseScenario();s.state.notSent=true;await assert.rejects(s.run());assert.deepEqual(s.ledger.keyRecords(),{});assert.equal(s.ledger.snapshot().uncertain,0);assert.equal(s.ledger.snapshot().counters.diamonds,0);
 s.state.notSent=false;await s.run();assert.equal(s.state.writes,2);assert.equal(s.ledger.snapshot().counters.diamonds,320);
}
{
 const s=await purchaseScenario();s.state.readFailure='notSent';await assert.rejects(s.run());assert.equal(s.ledger.snapshot().uncertain,1,'后续库存读取未发送不等于购买未发送，仍保留记录');
 s.state.readFailure=false;await s.run();assert.equal(s.state.writes,1);assert.equal(s.ledger.snapshot().uncertain,0);
}
for(const failure of ['readFailure','malformed']){
 const s=await purchaseScenario();s.state[failure]=true;await assert.rejects(s.run());assert.equal(s.ledger.snapshot().uncertain,1);
 s.state[failure]=false;s.state.income=1000;s.reload();await s.run();assert.equal(s.ledger.snapshot().uncertain,0);assert.equal(s.state.writes,1,'已有购买回执，重建后仅核库存不再购买');
}
{
 const s=await purchaseScenario();s.state.readFailure=true;await assert.rejects(s.run());s.state.readFailure=false;s.state.paused=true;
 await assert.rejects(s.run(),/连接已变化/);assert.equal(s.ledger.snapshot().uncertain,1);s.state.paused=false;s.state.dayOffset=86400000;s.reload();
 await s.run();assert.equal(s.ledger.snapshot().uncertain,0);assert.equal(s.ledger.snapshot().counters.diamonds,undefined);assert.equal(s.state.writes,1);
}
{
 const s=await purchaseScenario();s.state.lost=true;await assert.rejects(s.run(),/丢失/);s.state.lost=false;s.reload();await assert.rejects(s.run(),/结果待确认/);
 assert.equal(s.ledger.snapshot().uncertain,1);assert.equal(s.state.writes,1,'库存增加不能冒充丢失的购买回执');
}
for(const mode of ['lost','readFailure','unknown']){
 const f=await commentsEighteenFixture(),actor={...f.player,playerId:String(9020000+purchaseSerial++)},original=f.client.request;
 f.responses.WeekOrderInfoRequest.order=[{id:'木材',num:2}];
 const wood=f.responses.AllItemRequest.items.find(r=>r.itemId==='木材');if(wood)wood.num=100;else f.responses.AllItemRequest.items.push({itemId:'木材',num:100});
 let writes=0,broken=mode==='readFailure';
 const file=path.join(dir,'submit-'+purchaseSerial+'.json');let l=createUsageLedger('submit',{file});
 f.client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{
  if(name==='AllItemRequest'&&writes&&broken)throw Error('提交后库存读取失败');
  if(name!=='FinishWeekOrderRequest')return original(name,body,response);
  writes++;
  if(mode==='unknown')throw Error('提交未确认');
  const order=f.responses.WeekOrderInfoRequest,id=cfg.tables.WeekOrderRwdCfg.data.find(r=>r.rwdId>0&&!order.gotRwdId.includes(r.rwdId)).rwdId;
  order.gotRwdId.push(id);order.order=[{id:'木材',num:3}];f.responses.AllItemRequest.items.find(r=>r.itemId==='木材').num+=20;
  if(mode==='lost')throw Error('提交成功但回包丢失');return {randomRwdId:id};
 };
 const view=(await activityView(f.client,f.client.festivals,cfg)).order;
 const call=()=>runWeekOrder(f.client,cfg,settings,l,()=>true,'submit',{orderKey:view.orderKey},{player:actor});
 await assert.rejects(call());assert.equal(l.snapshot().uncertain,1);broken=false;l=createUsageLedger('submit',{file});
 if(mode==='unknown'){await assert.rejects(call(),/已提交/);assert.equal(l.snapshot().uncertain,1);}
 else{await call();assert.equal(l.snapshot().uncertain,0);}
 assert.equal(writes,1,'未知提交依据新奖励档位恢复，不能重发原单');
}
console.log('周订单专项通过：价格与资源保护、拒绝释放、整单回读、未知结果防重、库存同步前材料预留及跨连接/账号隔离。');
