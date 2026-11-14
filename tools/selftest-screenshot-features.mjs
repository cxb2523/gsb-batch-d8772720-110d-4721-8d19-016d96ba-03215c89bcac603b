import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { defaultSettings, validateSettings, createUsageLedger, saveAutomationSettings, loadAutomationSettings, exportAutomationSettings, importAutomationSettings, settingsCatalog } from '../src/automation-settings.mjs';
import { automationControls, setAutomationControl } from '../src/automation-controls.mjs';
import { merchantStrategyPlan } from '../src/merchant-strategy.mjs';
import { merchantSettings } from '../src/merchant-planner.mjs';
import { runMerchantSpeed, planMerchantSpeed } from '../src/merchant-speed.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadConfig } from '../src/config.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-screenshot-features-'));
const protocol = loadProtocol();
let passed = 0, serial = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
const at = Date.UTC(2026, 10, 14, 4, 2) / 1000; // 北京时间12:02，实际配置的刷新窗口。
const config = { tables: {
  ActivityTradeCfg: { data: [ ['海商王贸易时间','10-22'],['海商王行驶时间','120'],['海商王加速时长','30'],['海商王刷新时间','10,12,14,16,18,20'],['海商王加速日购买上限','50'] ].map(([key,value])=>({key,value})) },
  ItemPriceCfg: { data: [{ itemId:'海商王加速',rubyPrice:800 }] },
  TradeShipCfg: { data: [{lv:1,capacity:1000,profitMargin:300}] },
  TradeGoodsCfg: { data: [{goodsId:1001,unitPrice:50,capacity:1}] },
} };
function fixture() {
  const id = ++serial, settings = defaultSettings(), calls = [], reports = [];
  Object.assign(settings.merchant, { autoSpeedUp:true, autoBuyPointers:true, speedUpMode:'refresh', speedUpMinProfit:100, pointerDailyDiamondLimit:4000 });
  Object.assign(settings.resources, {allowDiamonds:true,diamondDailyLimit:10000});
  const event = { period:1001,startTime:at-86400,endTime:at+86400 }, file = path.join(folder, 'usage-'+id+'.json');
  const state = { period:1001,player:{coins:1000,profit:2000,buySpeedTimes:0,goods:[{pid:1,goodsId:1001,num:100,buyPrice:10,cityId:10}]},
    cargo:{cargoLv:1,cityId:10,moveToCityId:20,moveStartTime:at-60,moveEndTime:at+7140} };
  let stock=0, diamonds=10000, mode='', active=true, hook=()=>{};
  const client = new EventEmitter(); Object.assign(client,{connected:true,tradeWindow:event,serverClockOffsetMs:at*1000-Date.now(),
    async request(name,body={},response) {
      assert(protocol[name], name); assert(protocol[response], response); protocol[name].encode(body).finish();
      calls.push({name,body}); await hook(name,body);
      if(name==='TradeInfoRequest')return structuredClone(state);
      if(name==='TradeGuildRadarRequest')return {radar:[{cityId:10,specGoodsId:1001},{cityId:20,specGoodsId:1002}]};
      if(name==='AllItemRequest')return {items:stock?[{itemId:'海商王加速',num:stock}]:[]};
      if(name==='AllResourceRequest')return {list:[{res:4,amount:diamonds}]};
      if(name==='TradeBuySpeedItemRequest') {
        if(mode==='notSent')throw Object.assign(Error('未发送'),{notSent:true});
        if(mode==='unknown')throw Error('响应丢失');
        stock+=body.buyNum;diamonds-=800*body.buyNum;state.player.buySpeedTimes+=body.buyNum;
        return {buySpeedTimes:state.player.buySpeedTimes};
      }
      if(name==='TradeSpeedRequest') {stock-=body.useNum;state.cargo.moveEndTime-=body.useNum*1800;return {moveEndTime:state.cargo.moveEndTime};}
      throw Error('不允许请求 '+name);
    }
  });
  const ctx = { player:{playerId:String(91000+id),worldId:'2002001001',guildId:'1001',level:37},
    ledger:createUsageLedger('test',{file,now:()=>at*1000}),settings:()=>settings,label:'海商王',enabled:()=>active,report:r=>reports.push(r) };
  return {settings,client,state,event,ctx,calls,reports,run:()=>runMerchantSpeed(client,config,ctx,event,structuredClone(state)),
    writes:()=>calls.filter(c=>['TradeBuySpeedItemRequest','TradeSpeedRequest'].includes(c.name)),
    mode:v=>{mode=v;},hook:v=>{hook=v;},pause:()=>{active=false;},restart:()=>{ctx.ledger=createUsageLedger('test',{file,now:()=>at*1000});},stock:v=>{stock=v;} };
}
try {
  await test('新增模块消费默认关闭，真实配置目录校验和独立参数持久化',()=>{
    const settings=defaultSettings();validateSettings(settings,{catalog:settingsCatalog(loadConfig())});
    for(const key of ['alliance','guildShip','guildFort','silicon','heroRaid'])assert.equal(settings[key].enabled,false);
    settings.silicon.fleets[1].enabled=true;settings.silicon.fleets[1].safeGuilds=['23'];settings.silicon.fleets[1].safePlayers=['甲'];
    settings.silicon.windows=['22:00-02:00'];settings.alliance.allowedMaterials=['木板'];settings.merchant.speedUpMode='arrival';
    const file=path.join(folder,'settings.json');saveAutomationSettings('a',settings,{file,revision:0});
    assert.deepEqual(loadAutomationSettings('a',{file}).settings,validateSettings(settings));
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)),validateSettings(settings));
    assert.equal(loadAutomationSettings('b',{file}).settings.silicon.fleets[1].enabled,false);
  });
  await test('新增字段严格校验，无效舰队、时段、名单及未知分组不能静默保存',()=>{
    for(const change of [s=>s.silicon.windows=['25:00-26:00'],s=>s.silicon.fleets[1].id='1远征船',s=>s.silicon.fleets[0].safeGuilds=['联盟甲'],s=>s.silicon.fleets[0].extra=true,s=>s.guildShip.minCoinsLarge=101]){
      const s=defaultSettings();change(s);assert.throws(()=>validateSettings(s));
    }
    const doc=exportAutomationSettings(defaultSettings());doc.settings.heroRaid=null;assert.throws(()=>importAutomationSettings(doc));
    const catalog=settingsCatalog(loadConfig());
    for(const [group,key] of [['alliance','allowedMaterials'],['alliance','blockedMaterials'],['alliance','requestMaterials'],['alliance','techIds'],['guildShip','rewardItems'],['guildShip','disabledMaterials'],['guildFort','materials']]){
      const s=defaultSettings();s[group][key]=['不存在的配置项'];assert.throws(()=>validateSettings(s,{catalog}),group+'.'+key);
    }
  });
  await test('全部新增参数具有界面入口，模块总开关保持子项并跳到正确页签',()=>{
    const src=fs.readFileSync(new URL('../src/settings-ui.js',import.meta.url),'utf8'),groups=new Function(src.slice(0,src.indexOf('function configGet('))+'\nreturn configGroups;')();
    const fields=new Set(groups.flatMap(g=>g.fields.map(f=>f.key)));
    const s=defaultSettings();for(const group of ['alliance','guildShip','guildFort','heroRaid','silicon'])for(const key of Object.keys(s[group])){
      if(key==='fleets')for(let i=0;i<3;i++)for(const name of Object.keys(s.silicon.fleets[i]))assert(fields.has('silicon.fleets.'+i+'.'+name));
      else assert(fields.has(group+'.'+key),group+'.'+key);
    }
    s.alliance.recruit=true;const off=setAutomationControl(s,'alliance.enabled',false);assert(off.alliance.recruit);
    for(const key of ['alliance','guildShip','guildFort','silicon','heroRaid'])assert(automationControls.some(c=>c.key===key+'.enabled'&&c.configTarget));
  });
  await test('刷新模式只在真实刷新窗口加速，每日用量与每程上限共同生效',()=>{
    const f=fixture(),radar={radar:[{cityId:20,specGoodsId:1002}]},stock=new Map([['海商王加速',10]]);
    assert.equal(planMerchantSpeed(config,f.event,f.state,radar,stock,f.settings.merchant,at).useNum,4);
    assert.equal(planMerchantSpeed(config,f.event,f.state,radar,stock,f.settings.merchant,at+9*60).kind,'none');
    assert.notEqual(planMerchantSpeed(config,f.event,f.state,radar,stock,f.settings.merchant,at,{dailyUsed:27}).kind,'speed');
    f.settings.merchant.dailyPointerLimit=0;assert.notEqual(planMerchantSpeed(config,f.event,f.state,radar,stock,f.settings.merchant,at).kind,'speed');
  });
  await test('零库存没有物品条目时仍能按有效方案补购，后续使用计入持久日额',async()=>{
    const f=fixture();await f.run();assert.deepEqual(f.writes().map(c=>[c.name,c.body]),[['TradeBuySpeedItemRequest',{buyNum:4}]]);
    assert.equal(f.ctx.ledger.snapshot().counters.merchantPointerDiamonds,3200);f.restart();await f.run();
    assert.equal(f.writes().at(-1).name,'TradeSpeedRequest');assert.equal(f.ctx.ledger.snapshot().counters.merchantPointers,4);
  });
  await test('购买指针遵守总预算、模块预算、钻石保留量和游戏日购买上限',async()=>{
    for(const alter of [f=>f.settings.resources.allowDiamonds=false,f=>f.settings.merchant.pointerDailyDiamondLimit=0,
      f=>f.settings.resources.diamondDailyLimit=3000,f=>f.settings.resources.diamondThreshold=9000,f=>f.state.player.buySpeedTimes=49]){
      const f=fixture();alter(f);await f.run();assert.equal(f.writes().length,0);
    }
  });
  await test('购买响应未知跨重启不重发，明确未发送释放预算',async()=>{
    const f=fixture();f.mode('unknown');await f.run();f.restart();await f.run();assert.equal(f.writes().length,1);assert.equal(f.ctx.ledger.pendingCounters().diamonds,3200);
    const g=fixture();g.mode('notSent');await g.run();assert.equal(g.ctx.ledger.pendingCounters().diamonds??0,0);
  });
  await test('购买前关闭开关取消写入，零日用量不因购买功能绕过',async()=>{
    const f=fixture();f.hook(name=>{if(name==='AllResourceRequest')f.pause();});await f.run();assert.equal(f.writes().length,0);
    const g=fixture();g.settings.merchant.dailyPointerLimit=0;await g.run();assert.equal(g.writes().length,0);
  });
  await test('利润达限或读取期间调低上限时，不继续使用或购买指针',async()=>{
    for(const count of [0,4]){
      const f=fixture();f.stock(count);f.settings.merchant.profitLimit=2000;await f.run();assert.equal(f.writes().length,0);
      const g=fixture();g.stock(count);g.hook(name=>{if(name==='AllItemRequest')g.settings.merchant.profitLimit=2000;});
      await g.run();assert.equal(g.writes().length,0);
    }
  });
  await test('首趟指定时间、有限等待、同刷新一程与累计利润上限作用于真实计划',()=>{
    const f=fixture(),policy=merchantSettings({...f.settings.merchant,firstDepartureMode:'time',firstDepartureTime:'14:00'}),move={kind:'move',city:10,destination:20};
    assert.equal(merchantStrategyPlan(move,config,f.event,f.state,policy,at,f.ctx.ledger).kind,'wait');
    const start=Date.UTC(2026,10,14,2,1)/1000,explore={...move,exploration:true};
    assert.equal(merchantStrategyPlan(explore,config,f.event,f.state,merchantSettings(),start,f.ctx.ledger).kind,'wait');
    assert.equal(merchantStrategyPlan(explore,config,f.event,f.state,merchantSettings(),start+1800,f.ctx.ledger).kind,'move');
    const ticket=f.ctx.ledger.reserve({},{},{},{uniqueKey:'leg',details:{scope:'merchant:'+f.event.startTime+':1001',expected:{request:'TradeMoveRequest',start:at-60}}});f.ctx.ledger.confirm(ticket);
    policy.firstDepartureMode='smart';policy.speedUpMode='arrival';assert.equal(merchantStrategyPlan(move,config,f.event,f.state,policy,at,f.ctx.ledger).kind,'wait');
    assert.equal(merchantStrategyPlan(move,config,f.event,f.state,policy,at+7200,f.ctx.ledger).kind,'move');
    policy.profitLimit=2000;assert.equal(merchantStrategyPlan({kind:'buy'},config,f.event,f.state,policy,at,f.ctx.ledger).kind,'wait');
  });
} finally { fs.rmSync(folder,{recursive:true,force:true}); }
console.log('截图功能与接线专项：'+passed+'/'+passed+' 通过');
