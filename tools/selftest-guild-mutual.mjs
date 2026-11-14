import os from 'node:os';
import assert from 'node:assert/strict';import fs from'node:fs';import path from'node:path';
import { createUsageLedger, defaultSettings, saveAutomationSettings } from '../src/automation-settings.mjs';
import { readMutualAid, mutualOptions, runGuildMutual, createGuildMutualTask } from '../src/guild-mutual.mjs';
import { guildMutualFixture } from './fixtures/guild-mutual.mjs';
const base=path.join(os.tmpdir(),'cw-guild-mutual-tests');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'run-'));process.env.CW_DATA_DIR=dir;
let serial=0;const results=[];const ledger=()=>createUsageLedger('qa',{file:path.join(dir,'ledger-'+serial+++'.json')});
const context=(f,l)=>({...f,ledger:l,enabled:()=>f.client.connected,schedule:work=>work()});
const run=(f,l,options,extra={})=>runGuildMutual(context(f,l),options,{wait:async()=>{},...extra});
const check=async(name,work)=>{try{await work();results.push({name,passed:true});console.log('通过：'+name);}catch(e){results.push({name,passed:false,error:e.stack});console.error('失败：'+name+'\n'+e.stack);}};
try{
 await check('范围与0–20边界，指定盟友不能空选或用不精确ID',()=>{assert.equal(mutualOptions().target,20);for(const v of [-1,21,1.5,'20'])assert.throws(()=>mutualOptions({target:v}));assert.throws(()=>mutualOptions({mode:'selected'}));assert.throws(()=>mutualOptions({mode:'selected',memberIds:['9e16']}));assert.throws(()=>mutualOptions({askEnabled:true}));assert.equal(mutualOptions({target:0}).target,0);});
 await check('仅一个橡胶圈完成20次相互赠送，每次一条，先收再送',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.autoReturn=true;const result=await run(f,l,{target:20,mode:'selected',memberIds:[f.friend],askEnabled:true,askItemId:'橡胶圈',askTarget:20});
  assert.equal(result.sent,20);assert.equal(result.received,20);assert.equal(result.published,20);assert.equal(f.state.stock.橡胶圈,1);assert.equal(f.state.peak,1);assert.equal(l.snapshot().counters.guildAidGifts,20);
  const gifts=f.state.writes.filter(r=>r.name==='GuildAidHelpRequest');assert.equal(gifts.length,20);assert.equal(new Set(gifts.map(r=>r.id)).size,20);
  const before=f.state.writes.length;await run(f,l,{target:20});assert.equal(f.state.writes.length,before);
  const repeated=await run(f,l,{target:20,mode:'selected',memberIds:[f.friend],askEnabled:true,askItemId:'橡胶圈',askTarget:20});assert.match(repeated.reason,/已达到今日赠送目标20次/);assert.equal(f.state.writes.length,before);
 });
 await check('材料起初在盟友手上时也能循环并最后归还，不要求先备库存',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.stock.橡胶圈=0;f.state.peak=0;f.state.peerStock=1;f.state.autoReturn=true;
  const result=await run(f,l,{target:3,mode:'selected',memberIds:[f.friend],askEnabled:true,askItemId:'橡胶圈',askTarget:3},{wait:async ms=>{if(ms===15000)f.peerReturn();}});
  assert.equal(result.sent,3);assert.equal(result.received,3);assert.equal(f.state.stock.橡胶圈,0);assert.equal(f.state.peerStock,1);assert.equal(f.state.peak,1);
 });
 await check('赠送到目标后只等最后回赠，收到后结束且不多送',async()=>{
  const f=guildMutualFixture(),l=ledger();let waiting=0;
  const result=await run(f,l,{target:1,askEnabled:true,askItemId:'橡胶圈',askTarget:1},{wait:async ms=>{if(ms===15000){waiting++;f.peerReturn();}}});
  assert.equal(waiting,1);assert.equal(result.sent,1);assert.equal(result.received,1);assert.equal(f.state.stock.橡胶圈,1);
 });
 await check('旧的同材料求助未过期也不会导致收足回赠后无限等待',async()=>{
  const f=guildMutualFixture(),l=ledger(),now=Math.floor(Date.now()/1000);f.state.autoReturn=true;
  f.state.own=Array.from({length:20},(_,i)=>({reqId:String(9007199254780000n+BigInt(i)),reqItemId:'橡胶圈',endTime:now+3600}));
  const r=await run(f,l,{target:20,askEnabled:true,askItemId:'橡胶圈',askTarget:20});assert.equal(r.sent,20);assert.equal(r.received,20);assert.equal(f.state.own.length,20);assert.equal(f.state.stock.橡胶圈,1);
 });
 await check('已有手动求助计入游戏目标，只发布剩余额度；0赠送不送材料',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.askUsed=18;const result=await run(f,l,{target:0,askEnabled:true,askItemId:'橡胶圈',askTarget:20});
  assert.equal(result.published,2);assert.equal(f.state.askUsed,20);assert.equal(result.sent,0);assert.equal(f.state.stock.橡胶圈,1);
 });
 await check('游戏已求助20次不等于赠送20次，赠送按本工具当日余额停止',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.askUsed=20;f.state.stock.橡胶圈=10;const ticket=l.reserve({guildAidGifts:15},{guildAidGifts:20});l.confirm(ticket);
  const result=await run(f,l,{target:20});assert.equal(result.sent,5);assert.equal(l.snapshot().counters.guildAidGifts,20);
 });
 await check('按完整盟友ID选择，同名不误送；同材料模式不送其他库存',async()=>{
  const f=guildMutualFixture();f.state.requests[0].asker.playerId=f.other;f.state.requests[1].reqItemId='木材';
  const s=await readMutualAid(f.client,f.config,f.player,mutualOptions({mode:'selected',memberIds:[f.friend],askEnabled:true,askItemId:'橡胶圈',askTarget:1}));assert(s.candidates.every(r=>r.memberId===f.friend&&r.itemId==='橡胶圈'));assert(s.candidates.every(r=>r.id!==f.state.requests[0].reqId));
 });
 await check('自己、黑名单、过期、缺料和未开放材料都不赠送',async()=>{
  const f=guildMutualFixture();f.state.black=[{playerId:'9007199254740999',nickname:'黑名单'}];f.state.requests=f.state.requests.slice(0,5);f.state.requests[0].asker.playerId=f.player.playerId;f.state.requests[1].asker.playerId='9007199254740999';f.state.requests[2].endTime=1;f.state.requests[3].reqItemId='钻石';f.state.stock.橡胶圈=0;
  const s=await readMutualAid(f.client,f.config,f.player,mutualOptions());assert.equal(s.candidates.length,0);assert.equal(f.state.writes.length,0);
 });
 await check('赠送回包未知或空奖励不算确认，持久预占额度且重建不重复',async()=>{
  for(const failure of ['giftUnknown','giftEmpty']){const f=guildMutualFixture(),file=path.join(dir,failure+'.json');let l=createUsageLedger('qa',{file});f.state.failure=failure;const first=await run(f,l,{target:2});assert.equal(first.pending,true);assert.equal(first.sent,0);assert.equal(l.snapshot().counters.guildAidGifts,1);
   const g=guildMutualFixture(f.state);g.state.failure='';l=createUsageLedger('qa',{file});const second=await run(g,l,{target:2});assert.equal(second.pending,true);assert.equal(g.state.writes.filter(r=>r.name==='GuildAidHelpRequest').length,1);}
 });
 await check('赠送成功同时补产，完整新库存不必低于赠送前数量',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.onGift=()=>{f.state.stock.橡胶圈+=2;};
  const result=await run(f,l,{target:2});assert.equal(result.sent,2);assert.equal(result.pending,undefined);assert.equal(f.state.stock.橡胶圈,3);assert.equal(l.snapshot().uncertain,0);
 });
 await check('回执已确认但库存读取失败，重建客户端和账本后核销且不重复赠送',async()=>{
  const f=guildMutualFixture(),file=path.join(dir,'gift-ack-recovery.json');let l=createUsageLedger('qa',{file});
  f.state.onRead=name=>{if(name==='AllItemRequest'&&f.state.writes.some(r=>r.name==='GuildAidHelpRequest'))throw Object.assign(Error('完整库存暂不可读'),{notSent:true,request:name});};
  const first=await run(f,l,{target:1});assert.equal(first.pending,true);assert.equal(l.snapshot().uncertain,1);assert(Object.values(l.keyRecords()).some(r=>r.details.acknowledged));
  f.state.onRead=null;f.state.stock.橡胶圈=8;const g=guildMutualFixture(f.state);l=createUsageLedger('qa',{file});
  const recovered=await run(g,l,{target:1});assert.equal(recovered.pending,undefined);assert.equal(recovered.sent,0);assert.equal(l.snapshot().uncertain,0);assert.equal(g.state.writes.filter(r=>r.name==='GuildAidHelpRequest').length,1);
 });
 await check('回执后无关材料库存异常也不能作为完整同步，修复读数后恢复',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.onGift=()=>{f.state.stock.木材=-1;};
  assert.equal((await run(f,l,{target:1})).pending,true);assert.equal(l.snapshot().uncertain,1);
  f.state.onGift=null;f.state.stock.木材=20;assert.equal((await run(f,l,{target:1})).pending,undefined);assert.equal(l.snapshot().uncertain,0);
 });
 await check('已回执的赠送跨日核销旧额度，不计入新日且不重发',async()=>{
  const f=guildMutualFixture(),file=path.join(dir,'gift-ack-next-day.json'),l=createUsageLedger('qa',{file,now:()=>Date.now()+f.client.serverClockOffsetMs});
  f.state.onRead=name=>{if(name==='AllItemRequest'&&f.state.writes.length)throw Error('读取中断');};
  assert.equal((await run(f,l,{target:1})).pending,true);f.state.onRead=null;f.client.serverClockOffsetMs=86400000;
  const result=await run(f,l,{target:0});assert.equal(result.sent,0);assert.equal(l.snapshot().uncertain,0);assert.equal(l.snapshot().counters.guildAidGifts,undefined);assert.equal(f.state.writes.length,1);
 });
 await check('明确拒绝不消耗赠送预算，停止等待后不重发',async()=>{
  const f=guildMutualFixture(),l=ledger(),control=new AbortController();f.state.failure='giftReject';await assert.rejects(run(f,l,{target:1},{signal:control.signal,wait:async()=>control.abort(new Error('测试停止'))}));assert.equal(l.snapshot().counters.guildAidGifts,0);assert.equal(f.state.stock.橡胶圈,1);
 });
 await check('赠送明确未发送释放持久预算和防重键，重新检查后可安全重试',async()=>{
  const f=guildMutualFixture(),l=ledger(),original=f.client.request;let unsent=true,attempts=0;
  f.client.request=async(name,...args)=>{if(name==='GuildAidHelpRequest'){attempts++;if(unsent)throw Object.assign(Error('写入前断开'),{notSent:true});}return original(name,...args);};
  const result=await run(f,l,{target:1},{wait:async()=>{if(unsent){assert.equal(l.snapshot().uncertain,0);assert.equal(l.snapshot().counters.guildAidGifts,0);unsent=false;}}});
  assert.equal(result.sent,1);assert.equal(attempts,2);assert.equal(f.state.writes.filter(r=>r.name==='GuildAidHelpRequest').length,1);assert.equal(l.snapshot().uncertain,0);
 });
 await check('发布求助明确未发送释放预算，下次开启可正常发布',async()=>{
  const f=guildMutualFixture(),l=ledger(),original=f.client.sendWatch;let unsent=true;
  f.client.sendWatch=async(name,...args)=>{if(name==='GuildAidAskRequest'&&unsent)throw Object.assign(Error('未发送'),{notSent:true});return original(name,...args);};
  assert.equal((await run(f,l,{target:0,askEnabled:true,askItemId:'橡胶圈',askTarget:1})).pending,false);assert.equal(l.snapshot().uncertain,0);assert.equal(l.snapshot().counters.guildAidAsks,0);
  unsent=false;assert.equal((await run(f,l,{target:0,askEnabled:true,askItemId:'橡胶圈',askTarget:1})).published,1);
 });
 await check('领取明确未发送释放辅助模块和持久防重，后续读取未发送则保留已发记录',async()=>{
  for(const stage of ['write','read']){
   const f=guildMutualFixture(),l=ledger(),send=f.client.sendWatch,request=f.client.request;let blocked=true;
   f.state.own=[{reqId:'9007199254799901',reqItemId:'木材',endTime:Math.floor(Date.now()/1000)+100,helper:{playerId:f.friend,nickname:'同名盟友'}}];
   f.client.sendWatch=async(name,...args)=>{if(stage==='write'&&blocked&&name==='GotMyGuildAidRequest')throw Object.assign(Error('未发送领取'),{notSent:true});return send(name,...args);};
   f.client.request=async(name,...args)=>{if(stage==='read'&&blocked&&name==='MyGuildAidRequest'&&f.state.writes.length)throw Object.assign(Error('未发送回读'),{notSent:true,request:name});return request(name,...args);};
   const first=await run(f,l,{target:0});assert.equal(first.pending,stage==='read');assert.equal(l.snapshot().uncertain,stage==='read'?1:0);
   blocked=false;await run(f,l,{target:0});assert.equal(l.snapshot().uncertain,0);assert.equal(f.state.writes.filter(r=>r.name==='GotMyGuildAidRequest').length,1);
  }
 });
 await check('发布未知保留记录；后续真实计数和新请求确认后才继续',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.failure='askAcceptedUnknown';const first=await run(f,l,{target:0,askEnabled:true,askItemId:'橡胶圈',askTarget:2});assert.equal(first.pending,true);assert.equal(f.state.askUsed,1);f.state.failure='';const second=await run(f,l,{target:0,askEnabled:true,askItemId:'橡胶圈',askTarget:2});assert.equal(second.published,1);assert.equal(f.state.askUsed,2);
 });
 await check('个人领取未知跨客户端重建不重复，且不会继续赠送',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.own=[{reqId:'9007199254799999',reqItemId:'木材',endTime:Math.floor(Date.now()/1000)+100,helper:{playerId:f.friend,nickname:'同名盟友'}}];f.state.failure='claimUnknown';assert.equal((await run(f,l,{target:1})).pending,true);const g=guildMutualFixture(f.state);assert.equal((await run(g,l,{target:1})).pending,true);assert.equal(f.state.writes.filter(r=>r.name==='GotMyGuildAidRequest').length,1);assert.equal(f.state.writes.filter(r=>r.name==='GuildAidHelpRequest').length,0);
 });
 await check('领取其他材料不冒充所选材料回赠，仍等待橡胶圈回来',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.own=[{reqId:'9007199254799998',reqItemId:'木材',endTime:Math.floor(Date.now()/1000)+100,helper:{playerId:f.friend,nickname:'同名盟友'}}];let waits=0;
  const r=await run(f,l,{target:1,askEnabled:true,askItemId:'橡胶圈',askTarget:1},{wait:async ms=>{if(ms===15000){waits++;f.peerReturn();}}});assert.equal(waits,1);assert.equal(r.received,2);assert.equal(f.state.stock.橡胶圈,1);
 });
 await check('暂停、换联盟、跨日均停止后续写入',async()=>{
  const f=guildMutualFixture(),l=ledger();f.state.onRead=name=>{if(name==='AllItemRequest')f.client.connected=false;};const r=await run(f,l,{target:1});assert.equal(r.sent,0);assert.equal(f.state.writes.length,0);
  const g=guildMutualFixture();g.state.onRead=name=>{if(name==='MyGuildAidRequest')g.player.guildId='9007199254741002';};await assert.rejects(run(g,ledger(),{target:1}));assert.equal(g.state.writes.length,0);
  const h=guildMutualFixture();h.state.stock.橡胶圈=5;const end=await run(h,ledger(),{target:3},{wait:async()=>{h.client.serverClockOffsetMs=86400000;}});assert.equal(end.sent,1);assert.match(end.reason,/跨日/);
 });
 await check('重复开启拒绝，手动停止不再发送，重建任务不自动运行',async()=>{
  const f=guildMutualFixture(),task=createGuildMutualTask();let release;task.start({target:1},()=>new Promise(r=>{release=r}));assert.throws(()=>task.start({target:1},()=>{}));task.stop();release(context(f,ledger()));await new Promise(r=>setImmediate(r));assert.equal(task.view().running,false);assert.equal(f.state.writes.length,0);assert.equal(createGuildMutualTask().view().running,false);
 });
 await check('HTTP任务与盟友材料读取可用，不修改挂机/配置，暂停停止任务',async()=>{
  const f=guildMutualFixture();fs.writeFileSync(path.join(dir,'accounts.json'),JSON.stringify({version:1,activeId:'http',accounts:[{id:'http',label:'互助验证',url:'ws://127.0.0.1:1',login:{},automation:{enabled:false,paused:true}}]}));saveAutomationSettings('http',defaultSettings(),{revision:0});const {createConsole}=await import('../src/server.mjs');const app=createConsole({port:0});await app.listen();const root='http://127.0.0.1:'+app.server.address().port;
  try{await fetch(root+'/api/settings');const session=app.sessions.get('http');session.client=f.client;session.player=f.player;session.paused=false;const bytes=fs.readFileSync(path.join(dir,'automation-settings.json'));const opts=await fetch(root+'/api/guild/mutual/options').then(r=>r.json());assert(opts.members.some(m=>m.id===f.friend));assert(opts.materials.some(m=>m.id==='橡胶圈'));
   const post=(route,body)=>fetch(root+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal((await post('/api/guild/mutual/start',{confirm:true,target:1})).status,200);await new Promise(r=>setTimeout(r,1200));const state=await fetch(root+'/api/guild/mutual').then(r=>r.json());assert.equal(state.running,false);assert.equal(state.dailyUsed,1);assert.equal(session.loop.running,false);assert.deepEqual(fs.readFileSync(path.join(dir,'automation-settings.json')),bytes);
   await post('/api/guild/mutual/start',{confirm:true,target:20});await post('/api/accounts/pause',{paused:true});await new Promise(r=>setTimeout(r,20));assert.equal(session.mutualAid.view().running,false);
  }finally{app.server.closeAllConnections();await app.close();}
 });
}finally{const report={at:new Date().toISOString(),kind:'真实协议的虚构互赠，不连接或操作真实游戏',total:results.length,passed:results.filter(x=>x.passed).length,results};fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(report,null,2));console.log(`${report.passed}/${report.total} 通过`);console.log(path.join(dir,'result.json'));if(report.total!==report.passed)process.exitCode=1;}
