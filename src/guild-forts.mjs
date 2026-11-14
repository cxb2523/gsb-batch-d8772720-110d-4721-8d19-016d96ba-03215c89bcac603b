import { createHash } from 'node:crypto';
import { exactAutomationId, resourceReserve } from './automation-policy.mjs';
import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend,
  confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const busy=new WeakSet(), watched=new WeakMap();
const rows=(config,name)=>config?.tables?.[name]?.data??[];
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const nowOf=client=>Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000);
const dayOf=time=>Math.floor((time+28800)/86400);
const identity=player=>[exactAutomationId(player?.worldId),exactAutomationId(player?.playerId),exactAutomationId(player?.guildId)].join(':');
const number=(raw,label)=>{const n=toNumber(raw);if(!valid(n))throw new Error(label+'未完整确认');return n;};
const array=(raw,label)=>{if(!Array.isArray(raw))throw new Error(label+'未完整返回');return raw;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

export function guildFortMaterials(settings){
  const explicit=settings?.guildFort?.materials??[];
  // 工事材料留空只沿用明确选中的联盟互助白名单；两个名单都空时不捐任何材料。
  return explicit.length?explicit:(settings?.alliance?.allowedMaterials??[]);
}

function preferences(settings){return {enabled:false,materials:[],reserve:0,dailyLimit:0,...settings?.guildFort};}
function watch(client,scheduler){
  if(watched.has(client)){if(scheduler)watched.get(client).scheduler=scheduler;return;}
  const state={scheduler};watched.set(client,state);
  client.on?.('message',({name})=>{if(['SCFortProcess','SCFortBuilding','SCBuildFort','SCFortRemoved','SCJoinGuild','SCLeaveGuild'].includes(name))state.scheduler?.clearTask?.('guildFort');});
}

function processOf(fort){
  const items=new Map();
  for(const row of array(fort?.process,'工事捐赠进度')){
    if(typeof row?.itemId!=='string'||!row.itemId||items.has(row.itemId))throw new Error('工事捐赠材料记录异常');
    items.set(row.itemId,number(row.num,'工事捐赠进度'));
  }
  return items;
}

export async function readGuildForts(client,protocol,config,{player,getSettings=()=>({}),enabled=()=>true,inventory=true}={}){
  const view={state:'blocked',reason:'',forts:[],candidates:[],now:nowOf(client)},stamp=identity(player);
  const worldId=exactAutomationId(player?.worldId),playerId=exactAutomationId(player?.playerId),guildId=exactAutomationId(player?.guildId);
  if(!enabled())return {...view,reason:'已暂停'};
  if(!worldId||!playerId||!guildId)return {...view,reason:'当前没有可确认的联盟身份'};
  const gate=rows(config,'ModuleOpenCfg').find(row=>row.moduleId==='联盟')?.playerLevel;
  if(!valid(gate)||!valid(player.level)||player.level<gate)return {...view,reason:'联盟尚未开放或条件未确认'};
  const season=Number(BigInt(worldId)/1000000n%1000n),unlocks=rows(config,'FortSeasonUnlockCfg').filter(row=>row.season<=season);
  if(!unlocks.length)return {...view,reason:'本赛季尚未开放联盟工事'};
  const allowedTypes=new Set(unlocks.flatMap(row=>row.fortIdList??[]));
  for(const name of ['GuildInfoRequest','GuildInfoResponse','GuildCityInfoRequest','GuildCityInfoResponse','CityFortInfoRequest','CityFortInfoResponse'])if(!protocol?.[name])throw new Error('缺少真实协议 '+name);
  const guild=(await client.request('GuildInfoRequest',{},'GuildInfoResponse'))?.guild;
  if(exactAutomationId(guild?.guildId)!==guildId||stamp!==identity(player)||!enabled())throw new Error('联盟身份已变化');
  const cities=array((await client.request('GuildCityInfoRequest',{},'GuildCityInfoResponse'))?.cities,'联盟城市');
  const ids=new Set(),forts=[];let dailyDonateNum=null;
  for(const city of cities){
    if(!valid(city.cityId)||city.cityId<1||ids.has(city.cityId))throw new Error('联盟城市编号异常');ids.add(city.cityId);
    if(!city.fort||city.fort.state!==0)continue;
    if(!enabled()||identity(player)!==stamp)throw new Error('账号或联盟已变化');
    const reply=await client.request('CityFortInfoRequest',{cityId:city.cityId},'CityFortInfoResponse');
    const fort=reply?.fort;
    if(!fort||fort.state!==0)continue;
    if(fort.cityId!==city.cityId||fort.type!==city.fort.type||!allowedTypes.has(fort.type))throw new Error('联盟工事状态已变化或类型未解锁');
    const donated=number(reply.dailyDonateNum,'今日工事捐赠数量');
    if(dailyDonateNum!==null&&dailyDonateNum!==donated)throw new Error('读取工事期间个人捐赠计数已变化');dailyDonateNum=donated;
    const cfg=rows(config,'WorldFortCfg').find(row=>row.fortId===fort.type);
    if(!cfg||!Array.isArray(cfg.donateCost)||!cfg.donateCost.length)throw new Error('工事所需材料配置未确认');
    const progress=processOf(fort),needed=cfg.donateCost.map(row=>{
      if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!valid(row[1])||row[1]<1)throw new Error('工事需求配置异常');
      if(!rows(config,'FortDonateMaterialCfg').some(item=>item.id===row[0]))throw new Error('工事材料没有真实捐赠规则');
      return {id:row[0],need:Math.max(0,row[1]-(progress.get(row[0])??0)),progress:progress.get(row[0])??0};
    });
    forts.push({cityId:city.cityId,type:fort.type,recommended:city.recommended===true,needed,progress:[...progress],stamp:digest([city.cityId,fort.type,[...progress].sort()])});
  }
  Object.assign(view,{state:'ready',identity:stamp,worldId,playerId,guildId,day:dayOf(view.now),forts,dailyDonateNum:dailyDonateNum??0});
  const materials=guildFortMaterials(getSettings()),pref=preferences(getSettings());
  if(!materials.length)return {...view,reason:'未选择工事材料，联盟互助材料白名单也为空'};
  view.candidates=forts.sort((a,b)=>Number(b.recommended)-Number(a.recommended)||a.cityId-b.cityId).flatMap(fort=>fort.needed.filter(row=>row.need>0&&materials.includes(row.id)).map(row=>({...row,cityId:fort.cityId,type:fort.type,stamp:fort.stamp})));
  if(inventory&&view.candidates.length){
    const state=await readOrderReservedStock(client,protocol,config,{player,enabled,itemIds:[...new Set(view.candidates.map(row=>row.id))]});
    for(const row of view.candidates){row.have=state.stock.get(row.id)??0;row.reserved=(state.reserved.get(row.id)??0)+Math.max(pref.reserve,resourceReserve(getSettings(),row.id));row.available=Math.max(0,row.have-row.reserved);row.num=Math.min(row.need,row.available,pref.dailyLimit>0?Math.max(0,pref.dailyLimit-view.dailyDonateNum):Number.MAX_SAFE_INTEGER);}
  }
  if(!enabled()||identity(player)!==stamp)throw new Error('账号或联盟已变化');
  return view;
}

function matching(details,view){return details?.kind==='guildFortDonate'&&details.worldId===view.worldId&&details.playerId===view.playerId;}
function evidence(view,details){
  if(!details.acknowledged||view.guildId!==details.guildId)return false;
  const fort=view.forts.find(row=>row.cityId===details.cityId&&row.type===details.type);
  // 已有明确响应后，完成建造/工事消失也不影响原捐赠回执；未回执则不能以公共进度代替本人证据。
  return !fort||((fort.needed.find(row=>row.id===details.itemId)?.progress??-1)>=details.progress+details.num);
}

export async function serviceGuildForts(client,protocol,config,{player,getSettings=()=>({}),enabled=()=>false,ledger,report=()=>{},scheduler}={}){
  const finish=entry=>{const result={key:'guildFort',label:'联盟工事捐赠',...entry};report(result);return result;};
  const active=()=>enabled()&&preferences(getSettings()).enabled;
  const delay=seconds=>scheduler?.defer('guildFort',scheduler.now()+seconds);
  watch(client,scheduler);
  if(!active())return finish({skipped:true,reason:'联盟工事捐赠已关闭'});
  if(scheduler&&!scheduler.due('guildFort'))return finish({skipped:true,reason:'等待下次检查'});
  if(busy.has(client))return finish({skipped:true,reason:'正在核对联盟工事'});
  busy.add(client);
  try{
    if(!ledger||!protocol.DonateFortRequest||!protocol.DonateFortResponse)throw new Error('工事协议或持久账本不可用');
    const initial=await readGuildForts(client,protocol,config,{player,getSettings,enabled:active,inventory:false});
    if(initial.state!=='ready'){delay(180);return finish({skipped:true,reason:initial.reason});}
    for(const[key,record]of Object.entries(ledger.keyRecords()))if(!record.confirmed&&matching(record.details,initial)&&evidence(initial,record.details))ledger.resolveKey(key,true);
    if(Object.values(ledger.keyRecords()).some(record=>!record.confirmed&&matching(record.details,initial))){delay(180);return finish({skipped:true,pending:true,reason:'上次工事捐赠结果待确认，不重复消耗材料'});}
    await refreshOrderMaterialSpends(client,player,{enabled:active});
    const first=await readGuildForts(client,protocol,config,{player,getSettings,enabled:active});
    const chosen=first.candidates.find(row=>row.num>0);
    if(!chosen){delay(180);return finish({skipped:true,reason:first.reason||'没有符合所选材料、库存保留和每日上限的待建工事'});}
    const policy=digest([preferences(getSettings()),guildFortMaterials(getSettings())]);
    const current=await readGuildForts(client,protocol,config,{player,getSettings,enabled:active});
    const candidate=current.candidates.find(row=>row.cityId===chosen.cityId&&row.id===chosen.id&&row.stamp===chosen.stamp&&row.num===chosen.num);
    if(!candidate||!active()||initial.identity!==current.identity||first.day!==current.day||policy!==digest([preferences(getSettings()),guildFortMaterials(getSettings())]))return finish({skipped:true,reason:'工事、库存或配置已变化，下一轮重新核对'});
    const pref=preferences(getSettings()),key=`guildFort:${current.worldId}:${current.playerId}:${current.day}:${current.cityId??candidate.cityId}:${current.dailyDonateNum}:${digest([candidate.type,candidate.id,candidate.stamp])}`;
    if(ledger.hasKey(key)){delay(180);return finish({skipped:true,reason:'本次工事捐赠已有记录，等待状态更新'});}
    const details={kind:'guildFortDonate',worldId:current.worldId,playerId:current.playerId,guildId:current.guildId,cityId:candidate.cityId,
      type:candidate.type,itemId:candidate.id,num:candidate.num,progress:candidate.progress,acknowledged:false};
    const ticket=ledger.reserve({guildFortDonations:candidate.num},pref.dailyLimit>0?{guildFortDonations:pref.dailyLimit}:{},{guildFortDonations:current.dailyDonateNum},{uniqueKey:key,details});
    let debit;
    try{debit=beginOrderMaterialSpend(player,[{id:candidate.id,have:candidate.have,need:candidate.num}],'联盟工事',{operation:{verify:async()=>ledger.keyRecords()[key]?.details?.acknowledged===true}});}catch(error){ledger.cancel(ticket);throw error;}
    if(!active()||identity(player)!==current.identity||dayOf(nowOf(client))!==current.day||policy!==digest([preferences(getSettings()),guildFortMaterials(getSettings())])){ledger.cancel(ticket);cancelOrderMaterialSpend(debit);return finish({skipped:true,reason:'发送前开关、账号或日期已变化'});}
    let received=false;
    try{
      const reply=await client.request('DonateFortRequest',{cityId:candidate.cityId,item:{itemId:candidate.id,num:candidate.num},selectPackNum:0},'DonateFortResponse');received=true;
      const progress=processOf(reply),reward=array(reply?.reward?.asset,'工事捐赠奖励');
      if((progress.get(candidate.id)??0)<candidate.progress+candidate.num||!reward.some(row=>typeof row.id==='string'&&number(row.num,'捐赠奖励')>0))throw new Error('服务端未返回可确认的捐赠进度及奖励');
      ledger.updateKeyDetails(key,{...details,acknowledged:true});ledger.confirm(ticket);confirmOrderMaterialOperation(debit);
      await refreshOrderMaterialSpends(client,player,{enabled:active});delay(60);
      return finish({ok:true,label:`联盟工事 · 已向 ${candidate.cityId} 城市的${candidate.type}捐赠${displayMaterial(config,candidate.id)} ×${candidate.num}`});
    }catch(error){const rejected=(!received&&error.notSent===true)||error.prompt&&error.request==='DonateFortRequest';if(rejected){ledger.cancel(ticket);cancelOrderMaterialSpend(debit);}delay(180);return finish({ok:false,pending:!rejected,error:(rejected?'捐赠未执行：':'捐赠结果待确认，已保留材料和额度：')+error.message});}
  }catch(error){delay(180);return finish({ok:false,error:error.message});}finally{busy.delete(client);}
}
