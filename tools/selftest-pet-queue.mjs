import os from 'node:os';
import path from 'node:path';
// 海兽队列回归：实际协议编解码的受控数据，不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { getConfig } from '../src/config.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { defaultSettings } from '../src/automation-settings.mjs';
import { planBaseAutomation, runBaseAutomation } from '../src/base-automation.mjs';
import { describeLogError } from '../src/log-errors.mjs';
const config = getConfig(), protocol = loadProtocol(), results = [];
function fixture() {
  const settings = defaultSettings(); settings.loop.world = true; settings.loop.dailies = false; settings.events.enabled = false;
  Object.assign(settings.pet, { enabled: true, claim: true, breed: true, species: ['1'], quality: 'BLUE', universal: false, feed: false, advance: false });
  const recipe = config.tables.PetBreedCfg.data.find(r => r.spId === 1 && r.quality === 'BLUE');
  const stock = new Map(recipe.cost.map(([id]) => [id, 1000000]));
  const room = { buildingId: '1宠物培育室', type: '宠物培育室', level: 3, petBreed: { maxQLength: 3, breedQ: [], maturePets: [] } };
  const noise = { buildingId: '5农田', type: '农田', level: 1, petBreed: { maxQLength: 3, breedQ: [], maturePets: [] } };
  const buildings = [noise, room], client = new EventEmitter(); client.connected = true; client.writes = [];
  client.request = async (name, body = {}) => {
    await client.beforeRead?.(name);
    let value;
    if (name === 'OnWaterRequest') value = { building: buildings.map(b => ({ ...b, petBreed: { ...b.petBreed,
      breedQ: b.petBreed.breedQ.map(job => ({ petId: '蓝宠物1', startTime: 1, finishTime: 999999999, ...job })),
      maturePets: b.petBreed.maturePets.map(pet => typeof pet === 'string' ? { petId: pet, star: 1 } : pet) } })) };
    else if (name === 'AllItemRequest') value = { items: [...stock].filter(([id]) => id !== 'GOLD').map(([itemId, num]) => ({ itemId, num })) };
    else if (name === 'AllResourceRequest') value = { list: [{ res: 3, amount: stock.get('GOLD') || 1000000 }] };
    else throw new Error('夹具禁止请求：' + name);
    const type = protocol[name.replace(/Request$/, 'Response')]; return type.decode(type.encode(value).finish());
  };
  client.sendWatch = async (name, body) => {
    protocol[name].decode(protocol[name].encode(body).finish()); client.writes.push(name);
    if (client.onSend) return client.onSend(name, body);
    if (name === 'GetMaturePetRequest') room.petBreed.maturePets = [];
    else if (name === 'PetBreedRequest') room.petBreed.breedQ.push({ idx: 1, petId: body.petId, finishTime: Math.floor(Date.now()/1000) + 3600, feedRequirements: [] });
    else throw new Error('夹具禁止发送：' + name);
  };
  const plan = () => planBaseAutomation({ now: Math.floor(Date.now()/1000), player: { worldId: 1002001, level: 36 }, world: { buildings, stock, factories: [], stockCap: 1000000 }, notes: [], choices: [], pets: [], raids: [] }, config, settings);
  const run = (p = plan(), options = {}) => runBaseAutomation(client, protocol, config, p, { getSettings: () => settings, ...options });
  return { settings, stock, room, noise, buildings, client, plan, run };
}
async function check(name, fn) { try { await fn(); results.push({ name, passed: true }); console.log('通过：'+name); } catch(e) { results.push({ name, passed: false, error: e.stack }); console.error('失败：'+name+'\n'+e.stack); } }
await check('民居农田空字段不冒充培育空位，真实3/3满队列只等待', async()=>{
  const f=fixture(); f.room.petBreed.breedQ=[{idx:1},{idx:2},{idx:3}]; assert.equal(f.plan().actions.length,0); assert.match(f.plan().notes.join(' '),/队列已满（3\/3）/); await f.run(); assert.equal(f.client.writes.length,0);
  f.buildings.splice(1,1); assert.equal(f.plan().actions.length,0);
});
await check('最大长度不越过等级已解锁容量，状态不全不培育',()=>{
  const f=fixture(); f.room.level=1; f.room.petBreed.breedQ=[{idx:1}]; assert.equal(f.plan().actions.length,0);
  f.room.petBreed.breedQ=[]; delete f.room.petBreed.maxQLength; assert.equal(f.plan().actions.length,0);
});
await check('已到时间但仍占队列时等待，服务端转为待领取后先领再续',async()=>{
  const f=fixture(); f.room.petBreed.breedQ=[1,2,3].map(idx=>({idx,finishTime:1})); assert.equal(f.plan().actions.length,0);
  f.room.petBreed.breedQ=[]; f.room.petBreed.maturePets=['蓝宠物1']; assert.deepEqual(f.plan().actions.map(a=>a.kind),['petClaim']);
  const claim=await f.run(); assert.equal(claim[0].ok,true,JSON.stringify(claim)); assert.deepEqual(f.plan().actions.map(a=>a.kind),['petBreed']);
  assert.equal((await f.run())[0].ok,true); assert.deepEqual(f.client.writes,['GetMaturePetRequest','PetBreedRequest']);
});
await check('关闭自动领取时保留待领海兽，不继续下单',async()=>{
  const f=fixture(); f.settings.pet.claim=false; f.room.petBreed.maturePets=['蓝宠物1']; await f.run(); assert.equal(f.client.writes.length,0); assert.match(f.plan().notes.join(' '),/自动领取已关闭/);
});
await check('发送前队列已满或出现待领时拦截旧计划',async()=>{
  for(const mature of [false,true]){const f=fixture(),p=f.plan(); if(mature) f.room.petBreed.maturePets=['蓝宠物1']; else f.room.petBreed.breedQ=[{idx:1},{idx:2},{idx:3}]; const r=await f.run(p); assert.equal(f.client.writes.length,0); assert.equal(r[0].skipped,true,JSON.stringify(r));}
});
await check('领取没有确认时不续单，普通建筑伪变化不能当操作成功',async()=>{
  const f=fixture(); f.room.petBreed.maturePets=['蓝宠物1']; f.client.onSend=()=>{}; assert.equal((await f.run())[0].ok,false); assert(!f.plan().actions.some(a=>a.kind==='petBreed'));
  const g=fixture(); g.client.onSend=()=>{g.noise.petBreed.breedQ=[{idx:1}];}; assert.equal((await g.run())[0].ok,false);
});
await check('复核期间暂停或关闭开关时不发请求',async()=>{
  const f=fixture(); f.client.beforeRead=name=>{if(name==='OnWaterRequest')f.settings.pet.breed=false;}; await f.run(); assert.equal(f.client.writes.length,0);
  const g=fixture(); await g.run(g.plan(),{enabled:()=>false}); assert.equal(g.client.writes.length,0);
});
await check('培育队列满提示明确且不改原始错误',()=>{
  const raw='server prompt: breed queue full'; assert.match(describeLogError(raw).message,/海兽培育队列已满/); assert.equal(raw,'server prompt: breed queue full');
});
const report={at:new Date().toISOString(),kind:'实际协议的受控海兽队列回归，无真实游戏操作',total:results.length,passed:results.filter(r=>r.passed).length,results};
fs.writeFileSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cw-pet-queue-')),'result.json'),JSON.stringify(report,null,2));
console.log(`${report.passed}/${report.total}通过`); if(report.passed!==report.total) process.exitCode=1;
