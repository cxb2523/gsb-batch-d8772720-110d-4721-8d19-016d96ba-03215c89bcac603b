// Issue #17: incomplete snapshots must not prove an unknown write succeeded.
// Every fixture is encoded and decoded by the locally installed real protocol.
import assert from 'node:assert/strict';
import { loadProtocol } from '../src/proto.mjs';
import { captureSpendOperation } from '../src/spend-evidence.mjs';

const protocol=loadProtocol();
let passed=0;
const test=async(name,work)=>{await work();passed++;console.log('通过：'+name);};
function reader(name,value){
  const request=name+'Request',response=name+'Response';
  assert.equal(typeof protocol[request]?.encode,'function');
  assert.equal(typeof protocol[response]?.decode,'function');
  return {connected:true,async request(actual,body,reply){
    assert.equal(actual,request,'证据检查只允许对应的只读请求');
    assert.deepEqual(body,{});assert.equal(reply,response);
    return protocol[response].decode(protocol[response].encode(value).finish());
  }};
}
async function proves(step,name,before,after){
  const operation=await captureSpendOperation(reader(name,before),step);
  return typeof operation.verify==='function' ? await operation.verify(reader(name,after),{enabled:()=>true}) : false;
}
const asset={type:0,id:'fish',num:3};
const ship=slot=>({ship:[{index:1,orderItem:[slot]}]});
const building=queue=>({building:[{buildingId:'factory',level:1,factory:{factoryQ:queue}}]});

await test('装货前后均缺少asset消息，filled变化不能确认未知交货',async()=>{
  const step={request:'FillCargoShipRequest',body:{shipIndex:1,cargoIndex:[1]}};
  assert.equal(await proves(step,'CargoShips',ship({}),ship({filled:true})),false);
  assert.equal(await proves(step,'CargoShips',ship({asset}),ship({asset,filled:true})),true,
    '合法省略filled=false时，完整材料身份与完成状态仍能确认');
});

await test('原有工厂队列缺少完成时间，后来补全字段不能冒充新排产',async()=>{
  const step={request:'StartFactoryProduceRequest',body:{buildingId:'factory',productId:'fish'}};
  assert.equal(await proves(step,'OnWater',building([{productId:'fish'}]),building([{productId:'fish',finishTime:100}])),false);
  assert.equal(await proves(step,'OnWater',building([]),building([{productId:'fish',finishTime:100}])),true,
    '有效的新排产仍允许协议省略零号idx');
  assert.equal(await proves(step,'OnWater',building([{productId:'fish',finishTime:100}]),
    building([{productId:'fish',finishTime:100},{idx:1,productId:'fish',finishTime:200}])),true);
  assert.equal(await proves(step,'OnWater',building([{idx:2,productId:'fish',finishTime:100},{idx:3,productId:'fish'}]),
    building([{idx:2,productId:'fish',finishTime:100},{idx:3,productId:'fish'},{idx:4,productId:'fish',finishTime:200}])),true,
    '服务端省略其他排队槽位的完成时间时，新增带编号任务仍可确认');
  assert.equal(await proves(step,'OnWater',building([{idx:2,productId:'fish'},{idx:3,productId:'fish'}]),
    building([{idx:2,productId:'fish',finishTime:200},{idx:3,productId:'fish'}])),true,
    '服务端为稳定队列槽位补齐完成时间时可确认本次排产');
});

await test('工厂加速前后缺少productId，时间缩短不能确认未知加速',async()=>{
  const step={request:'SpeedUpFactoryProduceRequest',body:{buildingId:'factory',index:0}};
  assert.equal(await proves(step,'OnWater',building([{finishTime:100}]),building([{finishTime:90}])),false);
  assert.equal(await proves(step,'OnWater',building([{productId:'fish',finishTime:100}]),building([{productId:'fish',finishTime:90}])),true,
    '同一个完整任务的完成时间缩短可以确认加速');
});

await test('居民槽位缺少有效原需求时，其他订单计数增长不能确认本次交付', async()=>{
  const step={request:'FinishWorkerOrderRequest',body:{index:0}};
  const water=(order,count)=>({building:[],workerOrder:[order],orderOfTheDay:{orderNum:count}});
  const after=water({index:0,workerId:2,requirements:[asset]},1);
  assert.equal(await proves(step,'OnWater',water({index:0},0),after),false);
  assert.equal(await proves(step,'OnWater',water({index:0,workerId:1,requirements:[asset]},0),after),true);
});

for(const kind of ['level','star','skill'])await test('英雄'+kind+'目标发送前已达成时，不把旧状态冒充本次成功',async()=>{
  const request={level:'HeroLevelUpRequest',star:'HeroStarUpRequest',skill:'HeroSkillLevelUpRequest'}[kind];
  const target=kind==='level'?5:1;
  const step={request,body:{heroId:'A',...(kind==='skill'?{skillIdx:1}:{})},...(kind==='level'?{targetLevel:target}:{to:target})};
  const hero=value=>({heroes:[{heroId:'A',...(kind==='skill'?{skillLevels:[value]}:{[kind]:value})}]});
  assert.equal(await proves(step,'AllHero',hero(target),hero(target)),false);
  assert.equal(await proves(step,'AllHero',hero(target-1),hero(target)),true,
    '有效目标增长可以确认，含协议默认零星级');
});

console.log('消费证明基线专项 '+passed+'/'+passed+' 通过');
