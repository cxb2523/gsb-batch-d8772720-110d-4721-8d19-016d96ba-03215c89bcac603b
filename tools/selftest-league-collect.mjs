// 积分赛累计收集专项：首次、重复金额、未确认请求及旧记录兼容。
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadProtocol} from '../src/proto.mjs';
import {createUsageLedger} from '../src/automation-settings.mjs';
import {claimLeagueCollect} from '../src/missing-rewards.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'league-collect-lock-')),p=loadProtocol();let total=0,serial=0;
const test=async(name,fn)=>{await fn();total++;console.log('通过：'+name);};
function fixture(){
 const file=path.join(root,++serial+'.json'),state={amount:509,settle:Math.floor(Date.now()/1000)+86400,mode:'success',writes:0,reads:0,enabled:true};
 const ledger=createUsageLedger('test',{file}),events=[];
 const makeClient=()=>({request:async(n,b,r)=>{
  assert(['LeagueInfoRequest','GotLeagueBonusItemRequest'].includes(n),'不得调用其他游戏功能');let reply;
  if(n==='LeagueInfoRequest'){
   state.reads++;if(state.reads===state.failRead)throw Error('隔离读取失败');
   await state.onRead?.(state.reads);reply={bonusItemNum:state.amount,settleTime:state.settle,nextPointTime:0};
  }else{
   state.writes++;await state.onSend?.();
   if(state.mode==='reject')throw Object.assign(Error('明确拒绝'),{prompt:true,request:n});
   if(state.mode==='timeout')throw Error('领取超时');
   if(state.mode!=='stale')state.amount=0;
   if(state.mode==='timeoutAfterApply')throw Error('回包超时');
   reply=state.mode==='empty'?{}:{reward:{asset:[{id:'积分赛货币',num:509}]}};
  }
  return p[r].decode(p[r].encode(reply).finish());
 }});
 const client=makeClient(),options={enabled:()=>state.enabled,ledger,report:e=>events.push(e)};
 return{file,state,ledger,events,makeClient,client,options,run:(c=client,o=options)=>claimLeagueCollect(c,{},o)};
}
await test('首次领取回读归零，零数量不重复发请求',async()=>{const f=fixture();await f.run();await f.run();assert.equal(f.state.writes,1);assert(f.events.some(e=>e.ok&&e.status==='confirmed'));assert.equal(f.ledger.keyRecords()['league-collect:current'].confirmed,true);});
await test('同日同nextPointTime再次累计509，可连续领取三批',async()=>{const f=fixture();for(let n=0;n<3;n++){f.state.amount=509;await f.run();}assert.equal(f.state.writes,3);assert.equal(f.events.filter(e=>e.ok).length,3);assert.equal(f.ledger.snapshot().uncertain,0);});
await test('旧版confirmed金额键保留且不再阻断同数量的新批次',async()=>{const f=fixture(),key='league-collect:'+f.state.settle+':20761:0:509',t=f.ledger.reserve({},{},{},{uniqueKey:key,details:{kind:'freeReward',request:'GotLeagueBonusItemRequest'}});f.ledger.confirm(t);await f.run();assert.equal(f.state.writes,1);assert(f.ledger.keyRecords()[key].confirmed);});
await test('超时后同数量或不同数量均不重发，重建账本与客户端仍拦截',async()=>{const f=fixture();f.state.mode='timeout';await f.run();f.state.mode='success';await f.run();f.state.amount=700;const ledger=createUsageLedger('test',{file:f.file});await f.run(f.makeClient(),{...f.options,ledger});assert.equal(f.state.writes,1);assert.equal(ledger.snapshot().uncertain,1);assert.equal(f.events.filter(e=>e.ok).length,0);assert.equal(f.events.at(-1).status,'pending');});
await test('回包超时但同一期已归零，先确认不重发，再允许下一批509',async()=>{const f=fixture();f.state.mode='timeoutAfterApply';await f.run();f.state.mode='success';await f.run(f.makeClient());assert.equal(f.state.writes,1);assert.equal(f.ledger.snapshot().uncertain,0);f.state.amount=509;await f.run();assert.equal(f.state.writes,2);assert.equal(f.events.filter(e=>e.ok).length,1);});
await test('换日或结算期变化不能绕过未确认记录',async()=>{const f=fixture();f.state.mode='timeout';await f.run();f.client.serverClockOffsetMs=86400000;f.state.amount=600;await f.run();f.state.settle+=604800;f.state.amount=0;await f.run();assert.equal(f.state.writes,1);assert.equal(f.ledger.snapshot().uncertain,1);});
await test('旧版未确认金额键阻断新键，归零之前不重复',async()=>{const f=fixture(),key='league-collect:'+f.state.settle+':20761:0:509';f.ledger.reserve({},{},{},{uniqueKey:key,details:{kind:'freeReward',request:'GotLeagueBonusItemRequest'}});f.state.amount=700;await f.run();assert.equal(f.state.writes,0);f.state.amount=0;await f.run();assert(f.ledger.keyRecords()[key].confirmed);f.state.amount=509;await f.run();assert.equal(f.state.writes,1);});
await test('明确拒绝释放锁，下次正常重试可领取',async()=>{const f=fixture();f.state.mode='reject';await f.run();assert.equal(f.ledger.snapshot().uncertain,0);f.state.mode='success';await f.run();assert.equal(f.state.writes,2);assert.equal(f.events.filter(e=>e.ok).length,1);});
await test('空回执或数量未减少不报成功，保持未确认拦截',async()=>{for(const mode of ['empty','stale']){const f=fixture();f.state.mode=mode;await f.run();assert.equal(f.events.filter(e=>e.ok).length,0);assert.equal(f.ledger.snapshot().uncertain,1);if(mode==='stale'){await f.run();assert.equal(f.state.writes,1);}}});
await test('发送前读取失败或关闭功能不占锁、不发请求',async()=>{for(const mode of ['read','disabled']){const f=fixture();if(mode==='read')f.state.failRead=2;else f.state.onRead=async count=>{if(count===2)f.state.enabled=false;};await f.run();assert.equal(f.state.writes,0);assert.equal(f.ledger.snapshot().uncertain,0);}});
await test('并发调用只发送一次；请求完成后锁释放',async()=>{const f=fixture();let release;f.state.onSend=()=>new Promise(r=>{release=r;});const first=f.run();while(!release)await new Promise(r=>setTimeout(r,1));await f.run();const other=f.run(f.makeClient());await other;assert.equal(f.state.writes,1);release();await first;assert.equal(f.ledger.snapshot().uncertain,0);});
await test('其他领奖待确认记录和消费计数完全保留',async()=>{const f=fixture();f.ledger.reserve({radarPetrol:300},{},{},{uniqueKey:'radar-test',details:{kind:'radarSend',buildingId:'1远征船'}});const before=f.ledger.keyRecords()['radar-test'];await f.run();assert.deepEqual(f.ledger.keyRecords()['radar-test'],before);assert.equal(f.ledger.pendingCounters().radarPetrol,300);assert.equal(f.ledger.snapshot().counters.radarPetrol,300);});
console.log('积分赛累计收集专项 '+total+'/'+total+' 通过');
