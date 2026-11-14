import os from 'node:os';
// 九条批注新增行为的受控验证，不读取真实账号，不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadProtocol } from '../src/proto.mjs';
import { defaultSettings, validateSettings, importAutomationSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { readWorldOnlineReward, claimWorldOnlineReward } from '../src/world-online-rewards.mjs';
import { runTrialStages, createTrialTask } from '../src/trials.mjs';
import { classifyLog } from '../src/log-categories.mjs';
import { runLoop } from '../src/loop.mjs';
import { warForgeFixture } from './fixtures/war-forge.mjs';
const protocol = loadProtocol();
const parent = path.join(os.tmpdir(),'cw-nine-comments-tests');
fs.mkdirSync(parent, { recursive: true }); const directory = fs.mkdtempSync(path.join(parent, 'run-'));
process.env.CW_DATA_DIR = directory;
let serial = 0;
const results = [];
const check = async (name, run) => { try { await run(); results.push({ name, passed: true }); console.log('通过：' + name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); } };
function onlineFixture() {
  const now = Math.floor(Date.now() / 1000), file = path.join(directory, `usage-${serial++}.json`);
  const state = { startTime: now - 120, endTime: now + 3600, num: 0, updateTime: now - 10, fail: '', duplicate: false, reads: 0, writes: 0 };
  const player = { level: 37, worldId: '1001001', playerId: '9007199254740993' };
  const config = { tables: { ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }] }, WorldOnlineRwdCfg: { data: [{ stage: 1, seconds: 1 }, { stage: 2, seconds: 60 }, { stage: 3, seconds: 120 }] } } };
  const client = { connected: true, serverClockOffsetMs: 0, onRead: null,
    async request(name) { state.reads++; await client.onRead?.(name);
      if (state.fail === 'read') throw new Error('模拟断线');
      const value = name === 'WarDeclarationRequest' ? { declarations: [], startTime: state.startTime, endTime: state.endTime } : { counters: [ { type: 'DAILY_WORLD_ONLINE_RWD', num: state.num, updateTime: state.updateTime }, ...(state.duplicate ? [{ type: 'DAILY_WORLD_ONLINE_RWD', num: 0, updateTime: 0 }] : [])] };
      const t = protocol[name.replace(/Request$/, 'Response')]; return t.decode(t.encode(value).finish());
    },
    async sendWatch(name) { assert.equal(name, 'GotWorldOnlineRwdRequest'); state.writes++;
      if (state.fail === 'unknown') throw new Error('模拟结果未知');
      if (state.fail === 'reject') throw Object.assign(new Error('模拟明确拒绝'), { prompt: {}, request: name });
      if (state.fail !== 'stale') { state.num++; state.updateTime = Math.floor((Date.now() + client.serverClockOffsetMs) / 1000); }
    },
  };
  const ledger = createUsageLedger('online-qa', { file });
  return { state, player, config, client, ledger, file, run: options => claimWorldOnlineReward(client, config, player, { ledger, ...options }) };
}
function trialFixture() {
  const player = { level: 37 }, state = { passed: 0, outcomes: [], calls: [], badReply: false, afterUnknown: false };
  const config = { tables: { TrialRaidCfg: { data: [{ raidId: 1, title: '英雄经验副本' }] }, TrialRaidStageCfg: { data: [1, 2, 3].map(n => ({ raidId: 1, stageId: 1000 + n, stageLevel: n, openLevel: 16 })) } } };
  const client = { connected: true, onRead: null, stop() { this.connected = false; }, async request(name, body) {
    await client.onRead?.(name);
    if (name === 'TrialRaidInfoRequest') { if (state.afterUnknown && state.calls.length) throw new Error('战后状态读取失败'); const value = { raid: { raidId: 1, passedStage: state.passed, buySweepTimes: 0, sweepTimes: 0 } }; return protocol.TrialRaidInfoResponse.decode(protocol.TrialRaidInfoResponse.encode(value).finish()); }
    assert.equal(name, 'TrialRaidChallengeRequest'); state.calls.push(body.stageId);
    if (state.outcomes.shift() ?? true) state.passed = body.stageId;
    const reply = { raidId: 1, stageId: state.badReply ? 999 : body.stageId };
    return protocol.TrialRaidChallengeResponse.decode(protocol.TrialRaidChallengeResponse.encode(reply).finish());
  } };
  return { player, state, config, client, run: options => runTrialStages(client, player, config, 1, { wait: async () => {}, ...options }) };
}
try {
  await check('旧设置兼容，新增在线开关默认关闭，原值保留', () => {
    const old = validateSettings(defaultSettings()); delete old.schedule.worldOnlineRewards;
    const loaded = importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: old });
    assert.equal(loaded.schedule.worldOnlineRewards, false); delete loaded.schedule.worldOnlineRewards; assert.deepEqual(loaded, old);
  });
  await check('在线奖励只读不领取，逐档计时并确认服务端计数', async () => {
    const f = onlineFixture(); assert.equal((await readWorldOnlineReward(f.client, f.config, f.player)).ready, true); assert.equal(f.state.writes, 0);
    assert.equal((await f.run()).ok, true); assert.equal(f.state.writes, 1); assert.equal((await f.run()).skipped, true);
    f.client.serverClockOffsetMs = 61000; assert.equal((await f.run()).ok, true); assert.equal(f.state.writes, 2);
  });
  await check('时段外、计时未满、档位已满、异常计数均不领取', async () => {
    for (const kind of ['early','late','waiting','full','bad','duplicate']) { const f = onlineFixture(), now = Math.floor(Date.now()/1000);
      if (kind === 'early') f.state.startTime = now + 60;
      if (kind === 'late') f.state.endTime = now - 1;
      if (kind === 'waiting') { f.state.num = 1; f.state.updateTime = now; }
      if (kind === 'full') f.state.num = 3;
      if (kind === 'bad') f.state.num = '-1';
      if (kind === 'duplicate') f.state.duplicate = true;
      assert.equal((await f.run()).skipped, true, kind); assert.equal(f.state.writes, 0);
    }
  });
  await check('在线领取前暂停、时段结束或身份变化都取消', async () => {
    for (const mode of ['paused','ended','identity']) { const f = onlineFixture(); let enabled = true, n = 0;
      f.client.onRead = name => { if (name === 'CounterInfoRequest' && ++n === 2) { if (mode === 'paused') enabled = false; if (mode === 'ended') f.state.endTime = Math.floor(Date.now()/1000)-1; if (mode === 'identity') f.player.playerId = '9007199254740995'; } };
      await f.run({ enabled: () => enabled }); assert.equal(f.state.writes, 0, mode);
    }
  });
  await check('未知在线领取跨重建不重发，后续计数可确认', async () => {
    const f = onlineFixture(); f.state.fail = 'unknown'; assert.equal((await f.run()).pending, true);
    await f.run({ ledger: createUsageLedger('online-qa', { file: f.file }) }); assert.equal(f.state.writes, 1);
    f.state.fail = ''; f.state.num = 1; f.state.updateTime = Math.floor(Date.now()/1000); await f.run();
    assert.equal(Object.values(f.ledger.keyRecords())[0].confirmed, true);
  });
  await check('空结果不报领取成功，明确拒绝才释放领取记录', async () => {
    const f = onlineFixture(); f.state.fail = 'stale'; assert.equal((await f.run()).pending, true); await f.run(); assert.equal(f.state.writes, 1);
    const g = onlineFixture(); g.state.fail = 'reject'; await g.run(); assert.equal(Object.keys(g.ledger.keyRecords()).length, 0); g.state.fail = ''; assert.equal((await g.run()).ok, true);
  });
  await check('并发领取只发送一次，关闭开关不读取或领取', async () => {
    const f = onlineFixture(); await f.run({ enabled: () => false }); assert.equal(f.state.reads, 0);
    await Promise.all([f.run(), f.run()]); assert.equal(f.state.writes, 1);
  });
  await check('在线奖励已接入真实协议的整轮挂机入口', async () => {
    const f=warForgeFixture(), s=defaultSettings(), now=Math.floor(Date.now()/1000); let claimed=0;
    for(const key of Object.keys(s.schedule))s.schedule[key]=key==='worldOnlineRewards';
    Object.assign(s.loop,{world:false,tasks:false,dailies:false,heroes:false});s.dailies.enabled=false;s.resident.rewards=false;
    f.config.tables.WorldOnlineRwdCfg={data:[{stage:1,seconds:1}]};const read=f.client.request;
    f.client.request=async(name,...args)=>name==='CounterInfoRequest'?protocol.CounterInfoResponse.decode(protocol.CounterInfoResponse.encode({counters:[{type:'DAILY_WORLD_ONLINE_RWD',num:claimed,updateTime:now-10}]}).finish()):read(name,...args);
    f.client.sendWatch=async name=>{assert.equal(name,'GotWorldOnlineRwdRequest');claimed++;};
    await runLoop(f.client,protocol,{config:f.config,player:f.player,allowMutate:true,rounds:1,everyMs:0,getSettings:()=>s,isEnabled:key=>key==='worldOnlineRewards',usageLedger:createUsageLedger('loop-qa',{file:path.join(directory,'loop-ledger.json')})});assert.equal(claimed,1);
  });
  await check('试炼连续通关，以实际进度前进至全通', async () => {
    const f = trialFixture(); const result = await f.run(); assert.equal(result.wins, 3); assert.deepEqual(f.state.calls,[1001,1002,1003]);
  });
  await check('试炼同关连续失败计数，过关后清零', async () => {
    const f = trialFixture(); f.state.outcomes = [false,true,false,false]; const r = await f.run({ maxFailures: 2 });
    assert.equal(r.wins,1); assert.equal(r.failures,2); assert.deepEqual(f.state.calls,[1001,1001,1002,1002]);
  });
  await check('试炼等级门控、异常输入、未知回包不重试', async () => {
    const f = trialFixture(); f.player.level=10; await f.run(); assert.equal(f.state.calls.length,0);
    await assert.rejects(f.run({maxFailures:0}),/失败次数/);
    for(const kind of ['badReply','afterUnknown']) {const g=trialFixture();g.state[kind]=true;await assert.rejects(g.run());assert.equal(g.state.calls.length,1);}
  });
  await check('试炼读状态期间暂停与等待期间停止不再战斗', async () => {
    const f=trialFixture();let enabled=true;f.client.onRead=()=>{enabled=false};await assert.rejects(f.run({enabled:()=>enabled}));assert.equal(f.state.calls.length,0);
    const g=trialFixture(),controller=new AbortController();await assert.rejects(g.run({signal:controller.signal,wait:async()=>controller.abort(new Error('停止'))}));assert.equal(g.state.calls.length,1);
  });
  await check('试炼任务拒绝重复开启、停止后可重新开启', async () => {
    const f=trialFixture(), task=createTrialTask(1);let release;const open=()=>new Promise(r=>{release=r});
    task.start({maxFailures:3},open);assert.throws(()=>task.start({maxFailures:3},open));task.stop();release(f);
    await new Promise(r=>setImmediate(r));assert.equal(task.view().running,false);
    task.start({maxFailures:3},async()=>({...f,wait:async()=>{}}));await new Promise(r=>setTimeout(r,20));assert.equal(task.view().wins,3);
  });
  await check('日志按实际功能分类，未知内容保留系统类别', () => {
    for(const [text,expected] of [['万吨巨轮 · 进度已满','treasure'],['联盟/城战 · 在线奖励','alliance'],['试炼 · 英雄经验副本已通关','trials'],['海面 · 农田播种','production'],['居民订单','events'],['系统连接成功','system']])assert.equal(classifyLog(text),expected);
  });
  await check('内嵌页面语法、旧页面ID和日志弹窗结构完整', async () => {
    const {PAGE}=await import('../src/page.mjs');new vm.Script(PAGE.match(/<script>([\s\S]*)<\/script>/)[1]);
    for(const id of ['tab-heroes','tab-dailies','tab-activities','journal-dialog','logs-open','log-category','resource-tabs'])assert(PAGE.includes('id="'+id+'"'));
    assert(!PAGE.includes('data-tab="heroes"')); assert(PAGE.includes('data-resource-tab="heroes"'));
  });
  await check('未连接也能预览运行安排，旧配置原值不变，不创建游戏连接', async () => {
    fs.writeFileSync(path.join(directory,'accounts.json'),JSON.stringify({version:1,activeId:'qa',accounts:[{id:'qa',label:'离线验证',url:'ws://127.0.0.1:1',login:{},automation:{paused:true,enabled:false}}]}));
    const {createConsole}=await import('../src/server.mjs');const app=createConsole({port:0});await app.listen();
    try {const root='http://127.0.0.1:'+app.server.address().port;
      const result=await fetch(root+'/api/settings/preview',{method:'POST',body:JSON.stringify({category:'runtime'}),headers:{'content-type':'application/json'}});assert.equal(result.status,200);const body=await result.json();assert.match(body.scopeLabel,/运行安排/);assert.equal(body.actions.length,0);assert.equal(app.sessions.get('qa').client,null);
      const no=await fetch(root+'/api/trials/start',{method:'POST',body:JSON.stringify({confirm:true,raidId:1,maxFailures:3})});assert.equal(no.status,400);assert.equal(app.sessions.get('qa').client,null);
      const session=app.sessions.get('qa'), f=trialFixture();session.client=f.client;session.player=f.player;session.paused=false;f.state.outcomes=[false];
      const start=await fetch(root+'/api/trials/start',{method:'POST',body:JSON.stringify({confirm:true,raidId:1,maxFailures:1})});assert.equal(start.status,200);
      await new Promise(r=>setTimeout(r,15));const tasks=await fetch(root+'/api/trials/tasks').then(r=>r.json());assert.equal(tasks['1'].running,false);assert.equal(tasks['1'].failures,1);assert.equal(f.state.calls.length,1);
      await fetch(root+'/api/trials/start',{method:'POST',body:JSON.stringify({confirm:true,raidId:1,maxFailures:10})});
      await fetch(root+'/api/accounts/pause',{method:'POST',body:JSON.stringify({paused:true})});await new Promise(r=>setTimeout(r,15));assert.equal(session.trials.get(1).view().running,false);
    }finally{app.server.closeAllConnections();await app.close();}
  });
} finally {
 const report={at:new Date().toISOString(),kind:'受控数据和真实协议编解码，不操作真实游戏',passed:results.filter(r=>r.passed).length,total:results.length,results};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(report,null,2));console.log(`${report.passed}/${report.total} 通过`);console.log(path.join(directory,'result.json'));if(report.passed!==report.total)process.exitCode=1;
}
