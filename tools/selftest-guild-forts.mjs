import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-guild-forts-'));process.env.CW_DATA_DIR=dir;
const {loadProtocol}=await import('../src/proto.mjs');
const {readGuildForts,serviceGuildForts,guildFortMaterials}=await import('../src/guild-forts.mjs');
const {createUsageLedger}=await import('../src/automation-settings.mjs');
const {guildShipFixture,config}=await import('./fixtures/guild-ships.mjs');
const {pendingOrderMaterialSpends}=await import('../src/order-reservations.mjs');
const protocol=loadProtocol();let passed=0;
const check=async(name,work)=>{await work();passed++;console.log('通过：'+name);};
const fixture=()=>guildShipFixture(protocol,dir);
const read=f=>readGuildForts(f.client,protocol,config,f.options);
const run=f=>serviceGuildForts(f.client,protocol,config,f.options);
try{
 await check('真实工事协议编码字段，默认关闭和赛季未开放无消费',async()=>{const f=fixture();const body={cityId:1,item:{itemId:'耐火砖',num:10},selectPackNum:0};assert.equal(protocol.DonateFortRequest.decode(protocol.DonateFortRequest.encode(body).finish()).selectPackNum,0);f.settings.guildFort.enabled=false;assert((await run(f)).skipped);assert.equal(f.state.calls.length,0);f.settings.guildFort.enabled=true;f.player.worldId='2000001';assert.match((await run(f)).reason,/赛季/);assert.equal(f.state.writes.length,0);});
 await check('名单为空仅沿用明确互助白名单，没有选择不任意捐材料',async()=>{const f=fixture();f.settings.guildFort.materials=[];assert.deepEqual(guildFortMaterials(f.settings),[]);assert.equal((await read(f)).candidates.length,0);f.settings.alliance.allowedMaterials=['耐火砖'];assert.deepEqual(guildFortMaterials(f.settings),['耐火砖']);assert.equal((await read(f)).candidates[0].id,'耐火砖');f.settings.guildFort.materials=['高温合金'];assert.deepEqual(guildFortMaterials(f.settings),['高温合金']);});
 await check('只捐库存选中材料，预留竞争订单和库存阈值，从不购买/兑换/建造',async()=>{const f=fixture();f.state.stock.耐火砖=30;f.settings.guildFort.reserve=5;f.state.workerOrder=[{index:1,requirements:[{type:0,id:'耐火砖',num:10}]}];assert.equal((await read(f)).candidates[0].num,15);const r=await run(f);assert.equal(r.ok,true,r.error);assert.deepEqual(f.state.writes,[{name:'DonateFortRequest',body:{cityId:1,item:{itemId:'耐火砖',num:15},selectPackNum:0}}]);assert.equal(f.state.stock.耐火砖,15);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(f.player).length,0);});
 await check('总进度上限和每日已捐数量限制，0仅表示不加额外日限',async()=>{const f=fixture();f.state.fort.process[0].num=90;f.state.dailyDonateNum=17;f.settings.guildFort.dailyLimit=20;assert.equal((await read(f)).candidates[0].num,3);assert.equal((await run(f)).ok,true);assert.equal(f.state.fort.process[0].num,93);assert((await run(f)).skipped);assert.equal(f.state.writes.length,1);const g=fixture();g.state.fort.process[0].num=99;assert.equal((await run(g)).ok,true);assert.equal(g.state.writes[0].body.item.num,1);});
 await check('工事已经建成不捐，城市身份或进度变化发送前停止',async()=>{const f=fixture();f.state.fort.state=1;assert((await run(f)).skipped);assert.equal(f.state.writes.length,0);const g=fixture();let count=0;g.state.hook=async name=>{if(name==='CityFortInfoRequest'&&++count===3)g.state.fort.process[0].num=99;};await run(g);assert.equal(g.state.writes.length,0);});
 await check('关闭开关/切换联盟/修改库存保留后不发送旧计划',async()=>{for(const mode of ['off','guild','reserve']){const f=fixture();let count=0;f.state.hook=async name=>{if(name==='CityFortInfoRequest'&&++count===3){if(mode==='off')f.settings.guildFort.enabled=false;if(mode==='guild')f.player.guildId='999';if(mode==='reserve')f.settings.guildFort.reserve=50;}};await run(f);assert.equal(f.state.writes.length,0);}});
 await check('未知超时跨重启和换日不重复，公共进度增长不能冒充本人成功',async()=>{const f=fixture();f.state.writeHook=async()=>{throw new Error('超时');};assert((await run(f)).pending);assert.equal(f.ledger.snapshot().counters.guildFortDonations,50);f.state.fort.process[0].num=50;f.advance(86400);f.options.ledger=createUsageLedger('qa',{file:f.file,now:()=>f.state.now*1000});assert((await run(f)).pending);assert.equal(f.state.writes.length,1);});
 await check('明确未发送释放次数与材料，允许新鲜状态下重新执行',async()=>{const f=fixture();f.state.writeHook=async()=>{throw Object.assign(new Error('未发送'),{notSent:true});};assert.equal((await run(f)).pending,false);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(f.player).length,0);f.state.writeHook=async()=>{};assert.equal((await run(f)).ok,true);});
 await check('回执后完整库存失败保留材料，同批补产不会导致误判重复',async()=>{const f=fixture();f.state.hook=async name=>{if(name==='AllItemRequest'&&f.state.writes.length)throw new Error('暂不可读');};assert.equal((await run(f)).ok,true);assert.equal(pendingOrderMaterialSpends(f.player).length,1);f.state.hook=async()=>{};f.state.stock.耐火砖=5;f.settings.guildFort.reserve=5;await run(f);assert.equal(pendingOrderMaterialSpends(f.player).length,0);assert.equal(f.state.writes.length,1);});
 console.log(`联盟工事 ${passed} 项测试通过。`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
