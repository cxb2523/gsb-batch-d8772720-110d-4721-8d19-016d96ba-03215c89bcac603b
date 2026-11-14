import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
process.env.CW_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'cw-gift-codes-'));
const {startGiftCodes,startGiftCodeBatch,giftCodeStatus,giftCodeSummary}=await import('../src/gift-codes.mjs');
const {initialGiftCodeCatalog}=await import('../src/gift-code-catalog.mjs');
const {loadProtocol}=await import('../src/proto.mjs');
const p=loadProtocol(), sent=[];
const fixedInitial=initialGiftCodeCatalog(Date.parse('2026-11-13T00:00:00Z'));
assert.deepEqual([fixedInitial.total,fixedInitial.unique,fixedInitial.expired,fixedInitial.tryCodes.length,fixedInitial.batches.map(batch=>batch.length)],[114,113,7,106,[100,6]]);
const client={promptNames:p.Prompt,async request(name,body,response){
  assert.equal(name,'GotGiftCodeRequest');assert.equal(response,'GotRewardResponse');
  const {giftCode}=p[name].decode(p[name].encode(body).finish());sent.push(giftCode);
  if(giftCode==='无效')throw Object.assign(Error(),{request:name,prompt:{prompt:p.Prompt.GIFT_CODE_INVALID}});
  if(giftCode==='限频')throw Object.assign(Error(),{request:name,prompt:{prompt:p.Prompt.GIFT_CODE_TOO_MANY_REQUESTS}});
  if(giftCode==='超时')throw Error('timeout');
  return p[response].decode(p[response].encode({reward:{asset:[{id:'RUBY',num:10}]}}).finish());
}};
const send=fn=>fn(client);
const first=startGiftCodes('a','成功，成功\n无效 超时 停止',send);assert.throws(()=>startGiftCodes('a','其他',send),/正在兑换/);
await first.done;
assert.deepEqual(giftCodeStatus('a').rows.map(r=>r.status),['success','rejected','unknown','skipped']);
assert.deepEqual(sent,['成功','无效','超时']);assert.match(giftCodeStatus('a').rows[0].detail,/10/);
await startGiftCodes('a','成功 超时 限频 后续',send).done;
assert.deepEqual(sent,['成功','无效','超时','限频']);assert.equal(giftCodeStatus('b').rows.length,0);
const file=path.join(process.env.CW_DATA_DIR,'gift-codes-a.json');
const rows=JSON.parse(fs.readFileSync(file));rows.push({code:'中断',status:'sending'},{code:'未发送',status:'queued'});fs.writeFileSync(file,JSON.stringify(rows));
assert.deepEqual(giftCodeStatus('a').rows.slice(-2).map(r=>r.status),['unknown','skipped']);
assert.throws(()=>startGiftCodes('b',' ',send));

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const statuses=id=>giftCodeStatus(id).rows.map(r=>r.status);
const log=[];let inFlight=0;
function fakeClient(id,outcomes={}){
  return {id,sent:[],connected:true,promptNames:p.Prompt,stop(){this.connected=false;},async request(name,body,response){
    assert.equal(name,'GotGiftCodeRequest');assert.equal(response,'GotRewardResponse');
    const {giftCode}=p[name].decode(p[name].encode(body).finish());
    this.sent.push(giftCode);log.push({id,code:giftCode,at:Date.now()});
    assert.equal(++inFlight,1,'不同账号的兑换请求不能同时在途');
    await wait(5);await this.onSend?.();inFlight--;
    if(outcomes[giftCode]==='limit')throw Object.assign(Error(),{request:name,prompt:{prompt:p.Prompt.GIFT_CODE_TOO_MANY_REQUESTS}});
    if(outcomes[giftCode]==='timeout')throw Error('timeout');
    return p[response].decode(p[response].encode({reward:{asset:[{id:'RUBY',num:1}]}}).finish());
  }};
}
const target=(client,extra={})=>({id:client.id,dispatch:fn=>fn(client,()=>true),...extra});

const ok=fakeClient('m-ok'),broken=fakeClient('m-broken'),slow=fakeClient('m-unknown',{二:'timeout'}),last=fakeClient('m-last');
log.length=0;
const independent=startGiftCodeBatch([
  target(ok),
  target(broken,{dispatch(){throw Error('登录失败');}}),
  target(slow),
  {id:'m-paused',blocked:'账号已暂停托管'},
  target(last),
],'一 二 三');
assert.deepEqual(independent.map(r=>r.accepted),[true,true,true,false,true]);
assert.equal(independent[3].error,'账号已暂停托管');
await Promise.all(independent.filter(r=>r.accepted).map(r=>r.done));
assert.deepEqual(statuses('m-ok'),['success','success','success']);
assert.deepEqual(statuses('m-broken'),['skipped','skipped','skipped'],'一个账号连不上只影响它自己');
assert.deepEqual(statuses('m-unknown'),['success','unknown','skipped'],'结果未知只停该账号余码');
assert.deepEqual(statuses('m-last'),['success','success','success']);
assert.deepEqual(statuses('m-paused'),[],'被拦下的账号不留记录');
assert.match(giftCodeStatus('m-broken').rows[0].detail,/登录失败/,'记录里能看到失败原因');
assert.deepEqual(broken.sent,[]);assert.deepEqual(slow.sent,['一','二']);
const gaps=log.slice(1).map((row,i)=>row.at-log[i].at);
assert(gaps.every(gap=>gap>=650),'跨账号发送也要保持间隔：'+gaps);

assert.deepEqual(giftCodeSummary('m-unknown'),{running:false,total:3,counts:{success:1,unknown:1,skipped:1}});
await startGiftCodeBatch([target(ok)],'四').at(0).done;
assert.deepEqual(giftCodeSummary('m-ok'),{running:false,total:1,counts:{success:1}},'汇总只算最新一批');
assert.deepEqual(giftCodeSummary('m-empty'),{running:false,total:0,counts:{}});

const limited=fakeClient('l-first',{甲:'limit'}),after=fakeClient('l-after'),nextUp=fakeClient('l-next');
const limitRun=startGiftCodeBatch([target(limited),target(after),target(nextUp)],'甲 乙');
await Promise.all(limitRun.map(r=>r.done));
assert.deepEqual(limited.sent,['甲']);assert.deepEqual(after.sent,[]);assert.deepEqual(nextUp.sent,[]);
assert.deepEqual(statuses('l-first'),['rejected','skipped']);
assert.deepEqual(statuses('l-after'),['skipped','skipped']);
assert.match(giftCodeStatus('l-after').rows[0].detail,/限频/);
await startGiftCodeBatch([target(after)],'甲 乙').at(0).done;
assert.deepEqual(after.sent,['甲','乙'],'限频未发送的码之后可以重新提交');
const unaffected=fakeClient('l-later');
await startGiftCodeBatch([target(unaffected)],'甲').at(0).done;
assert.deepEqual(unaffected.sent,['甲'],'限频状态只作用于当批');

let open=true;const holder=fakeClient('e-holder'),closing=fakeClient('e-closing');
const closingRun=startGiftCodeBatch([target(holder),target(closing,{dispatch:fn=>fn(closing,()=>open)})],'丙');
open=false;
await Promise.all(closingRun.map(r=>r.done));
assert.deepEqual(closing.sent,[],'排队等发送期间账号失效，不能再发');
assert.deepEqual(statuses('e-closing'),['skipped']);

const busy=fakeClient('r-busy'),free=fakeClient('r-free');
let release;const busyJob=startGiftCodes('r-busy','丁',fn=>new Promise(r=>{release=r;}).then(()=>fn(busy)));
const overlap=startGiftCodeBatch([target(busy),target(free)],'戊');
assert.equal(overlap[0].accepted,false);assert.match(overlap[0].error,/正在兑换/);assert.equal(overlap[1].accepted,true);
await overlap[1].done;release();await busyJob.done;assert.deepEqual(busy.sent,['丁']);
assert.throws(()=>startGiftCodeBatch([target(fakeClient('v-empty'))],'  '),/每批/);
assert(!fs.existsSync(path.join(process.env.CW_DATA_DIR,'gift-codes-v-empty.json')),'输入无效时任何账号都不开始');

const accountRow=(id,extra={})=>({id,label:'账号'+id,url:'ws://127.0.0.1:1',login:{},...extra});
fs.writeFileSync(path.join(process.env.CW_DATA_DIR,'accounts.json'),JSON.stringify({version:1,activeId:'h1',accounts:[
  accountRow('h1'),accountRow('h2',{automation:{paused:true,enabled:false}}),accountRow('h3'),accountRow('h4'),accountRow('h5'),accountRow('h6'),
]}));
const {createConsole}=await import('../src/server.mjs');
const {PAGE}=await import('../src/page.mjs');
const app=createConsole({port:0});await app.listen();
try {
  const root='http://127.0.0.1:'+app.server.address().port;
  const post=(route,body,headers={})=>fetch(root+route,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}});
  const list=async()=>(await (await fetch(root+'/api/gift-codes/accounts')).json()).accounts;
  const initial=await (await fetch(root+'/api/gift-codes/initial')).json();
  assert.deepEqual([initial.total,initial.unique,initial.codes.length],[114,113,114]);
  assert.equal(initial.codes.filter(code=>code.expiresAt).length,8);
  assert.equal(initial.tryCodes.length,initial.batches.flat().length);
  assert(initial.batches.every(batch=>batch.length<=100),'初始码批次不能超过兑换上限');
  const settled=async ids=>{for(let i=0;i<200;i++){const rows=await list();if(rows.filter(a=>ids.includes(a.id)).every(a=>!a.running))return rows;await wait(50);}throw Error('批次未结束');};
  const before=await list();
  assert.deepEqual(before.map(a=>[a.id,a.paused,a.connected,a.total]),[['h1',false,false,0],['h2',true,false,0],['h3',false,false,0],['h4',false,false,0],['h5',false,false,0],['h6',false,false,0]]);
  assert.equal(before[0].title,'账号h1');

  const c1=fakeClient('h1');
  Object.assign(app.sessions.get('h1'),{client:c1,player:{}});
  assert.equal((await post('/api/gift-codes/redeem',{confirm:true,codes:'甲',accounts:['h1']},{origin:'http://evil.example'})).status>=400,true);
  assert.equal((await post('/api/gift-codes/redeem',{codes:'甲',accounts:['h1']})).status>=400,true,'缺少确认不发送');
  assert.equal((await post('/api/gift-codes/redeem',{confirm:true,codes:'甲'})).status>=400,true,'未选账号不发送');
  assert.equal((await post('/api/gift-codes/redeem',{confirm:true,codes:'甲',accounts:[]})).status>=400,true);
  assert.equal((await post('/api/gift-codes/redeem',{confirm:true,codes:' ',accounts:['h1']})).status>=400,true);
  const allBlocked=await post('/api/gift-codes/redeem',{confirm:true,codes:'甲',accounts:['h2','nobody']});
  assert.equal(allBlocked.status>=400,true);
  assert.match((await allBlocked.json()).error,/账号h2：账号已暂停托管；nobody：账号不存在/);
  assert.deepEqual(c1.sent,[]);

  const mixed=await post('/api/gift-codes/redeem',{confirm:true,codes:'甲 乙',accounts:['h1','h2','h1','h3','nobody']});
  assert.equal(mixed.status,200);
  const reply=await mixed.json();
  assert.equal(reply.accepted,2,'重复勾选按一个账号计');
  assert.deepEqual(reply.results.map(r=>[r.id,r.accepted]),[['h1',true],['h2',false],['h3',true],['nobody',false]]);
  assert(reply.results.every(r=>!('done' in r)&&!('session' in r)&&!('dispatch' in r)),'内部对象不进响应');
  assert.equal(app.sessions.get('h2').client,null,'已暂停账号不登录');
  await settled(['h1','h3']);
  assert.deepEqual(c1.sent,['甲','乙']);
  assert.deepEqual(statuses('h1'),['success','success']);
  assert.deepEqual(statuses('h3'),['skipped','skipped'],'登录失败的账号只记未发送');
  assert.deepEqual(statuses('h2'),[]);
  const done=await list();
  assert.deepEqual(done.find(a=>a.id==='h1').counts,{success:2});
  assert.equal(done.find(a=>a.id==='h1').connected,true);
  const records=await (await fetch(root+'/api/gift-codes?account=h1')).json();
  assert.deepEqual(records.rows.map(r=>r.code),['甲','乙']);

  for(const [id,leave] of [
    ['h4',()=>post('/api/accounts/remove',{confirm:true,id:'h4'})],
    ['h5',()=>post('/api/accounts/pause?account=h5',{paused:true})],
  ]){
    const client=fakeClient(id),session=app.sessions.get(id);
    Object.assign(session,{client,player:{}});
    let open;session.queueTail=new Promise(r=>{open=r;});
    assert.equal((await post('/api/gift-codes/redeem',{confirm:true,codes:'丙',accounts:[id]})).status,200);
    assert.equal((await leave()).status,200);
    open();
    for(let i=0;i<100&&giftCodeStatus(id).running;i++)await wait(20);
    assert.deepEqual(client.sent,[],id+' 排队期间被删除或暂停后不能发送');
    assert.deepEqual(statuses(id),['skipped']);
    assert(session.client===client||session.client===null,id+' 不能被重新登录');
  }
  assert.equal(app.sessions.has('h4'),false);

  const resumed=fakeClient('h6'),resumedSession=app.sessions.get('h6');
  resumed.onSend=async()=>{
    assert.equal((await post('/api/accounts/pause?account=h6',{paused:true})).status,200);
    assert.equal((await post('/api/accounts/pause?account=h6',{paused:false})).status,200);
  };
  Object.assign(resumedSession,{client:resumed,player:{}});
  assert.equal((await post('/api/gift-codes/redeem',{confirm:true,codes:'丁 戊',accounts:['h6']})).status,200);
  await settled(['h6']);
  assert.deepEqual(resumed.sent,['丁'],'中途暂停再恢复后不继续发送余码');
  assert.deepEqual(statuses('h6'),['success','skipped']);
  assert.equal(resumedSession.client,null,'中途暂停再恢复后不重新登录');

  for(const script of PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
  for(const id of ['gift-account-list','gift-select-all','gift-select-none','gift-selected-count','gift-record-account','gift-code-start','gift-load-initial','gift-code-initial-note'])assert.equal((PAGE.match(new RegExp('id="'+id+'"','g'))??[]).length,1,id);
} finally { await app.close(); }
console.log('礼包码测试通过：真实协议编解码、逐码核验、去重、限频、超时、重启、账号隔离、多账号批量、发送前复查。');
