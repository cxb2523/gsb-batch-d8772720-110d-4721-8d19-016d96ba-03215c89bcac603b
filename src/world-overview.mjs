import {recordsInWorld} from './fleet-settlement.mjs';
import {mapDimensions,mapPosition,mapRegions} from './world-map-geometry.mjs';
import { loadMapAsset } from './world.mjs';
import { normalize } from './worlds.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { fleetRecordReason, dispatchReservationReason, fleetDispatchView } from './fleet-availability.mjs';

// 只读概览：静态资源只提供位置，归属和状态仅取本次服务器返回。
export async function readWorldOverview(client,config,player,settings,ledger,{mapLoader=loadMapAsset,pirateSpent=0}={}) {
 const scenario=player.scenarioId||1,notes=[],layers={};
 const get=async(name,body={})=>{try{return await client.request(name,body,name.replace(/Request$/,'Response'),8000);}catch{notes.push(({WorldInfoRequest:'城池',MyFleetsRequest:'舰队',AllItemRequest:'资源库存',MyResFieldsRequest:'本人资源田',TreasureLootListRequest:'巨轮',AllPirateRequest:'海盗',RadarInfoRequest:'情报',WorldBossInfoRequest:'世界Boss',AllGuildAbstractionRequest:'联盟名称',WarDeclarationRequest:'城战宣战'})[name]+'未同步');return null;}};
 const [map,world,own,bag,fields,treasure,pirates,radar,boss,guildList,war]=await Promise.all([
  mapLoader(scenario,config?.resources??null).catch(()=>null),get('WorldInfoRequest',{screenCenter:{x:0,y:0}}),get('MyFleetsRequest'),get('AllItemRequest'),get('MyResFieldsRequest'),get('TreasureLootListRequest'),get('AllPirateRequest'),get('RadarInfoRequest'),get('WorldBossInfoRequest'),get('AllGuildAbstractionRequest'),get('WarDeclarationRequest')]);
 const now=Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000),points=[],routes=[];
 const pos=grid=>mapPosition(map,grid);
 const add=(layer,key,name,grid,detail,extra={})=>{const at=pos(grid);if(at && (['cities','fields'].includes(layer)||grid>0))points.push({layer,key,name,grid,...at,detail,...extra});};

 const cityCfg=config.tables[scenario+'_CityCfg']?.data??[];
 const defaultGuildNames=new Map(cityCfg.filter(c=>c.guildIndex>0).map(c=>[c.guildIndex,c.name]));
 const cityNameAt=(id,grid,fallback='位置未同步')=>cityCfg.find(c=>c.id===(id||map?.cityAt?.(grid)))?.name||fallback;
 const treasureName=t=>config.tables.TreasureLootCfg?.data?.find(c=>c.quality===({3:'BLUE',4:'PURPLE',5:'ORANGE'})[t.color])?.name||'货轮';
 const makeMotion=raw=>{
  if(raw.state!==2||!(raw.startGridIdx>0)||!(raw.targetGridIdx>0))return null;
  const start=pos(raw.startGridIdx),end=pos(raw.targetGridIdx);if(!start||!end||!Number.isSafeInteger(raw.moveStartTs)||!Number.isSafeInteger(raw.moveEndTs)||raw.moveEndTs<=raw.moveStartTs)return null;
  const ship=(treasure?.treasure??[]).find(t=>String(t.uid)===String(raw.treasureLootUid)||!raw.targetCityId&&t.gridIdx===raw.targetGridIdx);
  const from=cityNameAt(raw.startCityId||raw.cityId,raw.startGridIdx,'出发地未同步'),to=raw.targetCityId?cityNameAt(raw.targetCityId,raw.targetGridIdx):ship?treasureName(ship):cityNameAt(0,raw.targetGridIdx,'目标海域');
  return {start,end,startAt:raw.moveStartTs,endAt:raw.moveEndTs,from,to};
 };
 layers.cities=map&&Array.isArray(world?.cities)?'已同步':'未同步';
 layers.regions=map?.cityAt?(Array.isArray(world?.cities)?'已同步':'边界已读取，归属未同步'):'未同步';
 const ownGuildId=exactAutomationId(player.guildId),ownGuildIdx=ownGuildId?Number(BigInt(ownGuildId)%1000n):null;
 const guildNames=new Map((guildList?.guilds??[]).map(g=>{const id=exactAutomationId(g.id);return[id?Number(BigInt(id)%1000n):null,g.name];}));
 const ownerIds=[...new Set((world?.cities??[]).map(c=>c.guildIdx).filter(id=>Number.isSafeInteger(id)&&id>0))].sort((a,b)=>a-b);
 const palette=['#d5bf53','#bb806b','#a18bbb','#779fc0','#c18fab','#91a86f'];
 const owners=ownerIds.map((id,i)=>({id,name:(guildNames.get(id)||defaultGuildNames.get(id)||'阵营 '+id)+(id===ownGuildIdx?'（我盟）':''),defaultName:!guildNames.get(id),color:id===ownGuildIdx?'#69b3a5':palette[i%palette.length]}));
 const ownerColor=id=>owners.find(o=>o.id===id)?.color??(id===0?'#c4d7df':'#e1e7e8');
 const guildName=id=>id===0?'未占领':guildNames.get(id)||defaultGuildNames.get(id)||'阵营 '+id;
 const quantity=value=>Number.isSafeInteger(value)&&value>=0?String(value):'未同步';
 const declarations=war?.declarations??[],warOpen=war&&war.startTime<=now&&now<war.endTime;
 const marchFleets=Array.isArray(world?.fleets)?world.fleets:[];
 const cityWars=[];
 const regions=mapRegions(map).map(r=>{const city=world?.cities?.find(c=>c.id===r.cityId),owner=Number.isSafeInteger(city?.guildIdx)?city.guildIdx:null;return{...r,owner,color:ownerColor(owner)};});
 for(const city of world?.cities??[]){
  const cfg=cityCfg.find(c=>c.id===city.id),declared=declarations.filter(d=>d.cityId===city.id),fights=(city.battlePoints??[]).filter(b=>b.leftFighter&&b.rightFighter),inbound=marchFleets.filter(f=>f.state===2&&f.targetCityId===city.id&&!f.treasureLootUid);
  const queue='进攻队列 '+quantity(city.attackFleetNum)+'（优先 '+quantity(city.priorityAtkFleetNum)+'） · 防守队列 '+quantity(city.defenceFleetNum)+'（优先 '+quantity(city.priorityDefFleetNum)+'）';
  const warDetail=declared.length?'宣战：'+declared.map(d=>guildName(d.attackGuildIdx)+' → '+guildName(d.defenceGuildIdx)).join('；')+' · '+(warOpen?'城战时段':'非城战时段')+' · '+queue+' · 交战点 '+fights.length+' · 已同步行军 '+(Array.isArray(world?.fleets)?inbound.length:'未同步')+' 队':'';
  const declarationNames=declared.map(d=>({attack:guildName(d.attackGuildIdx),defence:guildName(d.defenceGuildIdx)}));
  const status=fights.length?'交战中':declared.length?(warOpen?'已宣战':'已宣战 · 非城战时段'):warOpen?'当前无宣战':'非城战时段';
  const cityInfo={name:cfg?.name||'城池 '+city.id,owner:guildName(city.guildIdx),status,declared:declarationNames,assemble:war?.assembleCityId===city.id,attack:city.attackFleetNum,priorityAttack:city.priorityAtkFleetNum,defence:city.defenceFleetNum,priorityDefence:city.priorityDefFleetNum,
   fighters:fights.map(b=>({index:b.index,attack:b.leftFighter.name||(b.leftFighter.isNpc?'守卫':'未同步'),defence:b.rightFighter.name||(b.rightFighter.isNpc?'守卫':'未同步')}))};
  const point={cityId:city.id,cityType:cfg?.type??1,capital:cfg?.guildIndex>0,owner:city.guildIdx,color:ownerColor(city.guildIdx),declared:declared.length>0,fighting:fights.length>0,warDetail,cityInfo,assemble:cityInfo.assemble,warRole:declared.some(d=>d.attackGuildIdx===ownGuildIdx)?'attack':declared.some(d=>d.defenceGuildIdx===ownGuildIdx)?'defence':'other'};
  add('cities','city-'+city.id,cfg?.name||'城池 '+city.id,map?.cityInfo?.[city.id]?.gridIdx,'所属：'+guildName(city.guildIdx)+' · '+(warDetail||queue),point);
  if(declared.length||fights.length)cityWars.push({cityId:city.id,name:cfg?.name||'城池 '+city.id,declared:declared.map(d=>({attack:guildName(d.attackGuildIdx),defence:guildName(d.defenceGuildIdx)})),attack:city.attackFleetNum,priorityAttack:city.priorityAtkFleetNum,defence:city.defenceFleetNum,priorityDefence:city.priorityDefFleetNum,battles:fights.length,inbound:Array.isArray(world?.fleets)?inbound.length:null,status:fights.length?'交战中':warOpen?'已宣战':'已宣战 · 非城战时段'});
 }
 layers.cityWar=Array.isArray(war?.declarations)&&Array.isArray(world?.cities)?'已同步':'未同步';

 const owned=fields?.info?.fields;
 layers.fields=map?'位置已读取；'+(Array.isArray(owned)?'仅本人占田归属已同步':'归属未同步'):'未同步';
 if(!Array.isArray(owned))notes.push('本人资源田归属未同步');
 const resourceTypes=config.tables[scenario+'_ResFieldTypeCfg']?.data??[];
 if(map)for(let grid=0;grid<map.width*map.height;grid++){const f=map.fieldAt(grid);if(f){const item=resourceTypes.find(row=>row.type===f.resType)?.product?.[0],name=item?(item==='公会科技点'?'科技点':item)+'资源田':'资源田';add('fields','field-'+grid,name,grid,(owned?.some(o=>o.gridIdx===grid)?'本人已占领':'归属未同步')+' · '+(cityCfg.find(c=>c.id===f.cityId)?.name||'所在城 '+f.cityId));}}
 const dispatch=fleetDispatchView(client,settings,ledger,own?.fleets??[],exactAutomationId(player.worldId));
 const records=recordsInWorld(ledger.keyRecords(),exactAutomationId(player.worldId)),guild=exactAutomationId(player.guildId);
 const home=cityCfg.find(c=>guild&&c.guildIndex===Number(BigInt(guild)%1000n));
 const fleets=(own?.fleets??[]).map(raw=>{
  const f=normalize({...raw,state:raw.state,durability:raw.durability,maxDura:raw.maxDura,curGridIdx:raw.curGridIdx,cityId:raw.cityId,startGridIdx:raw.startGridIdx,targetGridIdx:raw.targetGridIdx,moveStartTs:raw.moveStartTs,moveEndTs:raw.moveEndTs,startCityId:raw.startCityId,targetCityId:raw.targetCityId}),reason=fleetRecordReason(records,f.buildingId),state=({1:f.curGridIdx>0?'驻守在外':reason?'待确认 / 任务占用':'主城空闲',2:'行军',3:'战斗',4:'维修',5:'排队'})[f.state]||'未同步';
  const reservation=dispatchReservationReason(client,settings,'overview',f.buildingId);
  const grid=f.state===2?f.startGridIdx:f.curGridIdx>0?f.curGridIdx:map?.cityInfo?.[f.cityId||home?.id]?.gridIdx;
  const name='远征舰队 '+f.buildingId.replace('远征船','')+' 队';
  const assignment=dispatch.find(d=>d.buildingId===f.buildingId);
  const detail=state+' · 耐久 '+(f.durability??'未同步')+'/'+(f.maxDura??'未同步')+(f.state===2?' · 预计到达 '+(Number.isSafeInteger(f.moveEndTs)&&f.moveEndTs>0?new Date(f.moveEndTs*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'未同步'):'')+' · '+(reason||reservation||(f.state===1&&!f.curGridIdx&&!f.treasureLootUid&&!f.chipWar?.rewardTs&&f.durability>0?'可接任务，派遣前另核对编队与阈值':'暂不能接新任务'));
  const taskDetail=' · 当前目标格 '+(f.state===2?f.targetGridIdx:f.curGridIdx||'主城')+' · 允许任务顺序 '+(assignment?.intents.map(i=>i.label).join(' → ')||'无');
  const motion=makeMotion(f);
  add('fleets','fleet-'+f.buildingId,name,grid,detail+taskDetail,{motion});
  const start=pos(f.startGridIdx),end=pos(f.targetGridIdx);
  if(f.state===2&&f.startGridIdx>0&&f.targetGridIdx>0&&start&&end)routes.push({start,end,name,key:'fleet-'+f.buildingId,color:'#2866cc'});
  return {id:f.buildingId,name,state,detail:detail+taskDetail,grid,durability:f.durability,maxDura:f.maxDura,arriveAt:f.state===2?f.moveEndTs:null,journey:motion,task:'未同步',target:'未同步'};
 });
 layers.fleets=Array.isArray(own?.fleets)?'已同步':'未同步';
 layers.treasure=Array.isArray(treasure?.treasure)?'已同步':'未同步';
 const treasures=[];
 for(const t of treasure?.treasure??[]){
  const inbound=marchFleets.filter(f=>f.state===2&&(String(f.treasureLootUid)===String(t.uid)||f.targetGridIdx===t.gridIdx)),fighters=[t.battlePoint?.leftFighter,t.battlePoint?.rightFighter].filter(Boolean);
  const name=treasureName(t),detail='占领进度 '+quantity(t.progress)+'% · 所属 '+guildName(t.ownerGuildIdx)+' · 守军 '+quantity(t.ownerFleetNum)+' 队 · 已同步出发 '+(Array.isArray(world?.fleets)?inbound.length:'未同步')+' 队'+(fighters.length?' · 交战 '+fighters.map(f=>f.name||'未知玩家').join(' / '):'')+' · 奖励 '+(t.reward?.asset??[]).map(r=>r.id+' ×'+r.num).join('、');
  add('treasure','treasure-'+String(t.uid),name,t.gridIdx,detail,{size:({3:1,4:2,5:3})[t.color]??1,inbound:Array.isArray(world?.fleets)?inbound.length:null,fighting:fighters.length>0});
  treasures.push({uid:String(t.uid),name,progress:t.progress,owner:guildName(t.ownerGuildIdx),defenders:t.ownerFleetNum,inbound:Array.isArray(world?.fleets)?inbound.length:null,fighters:fighters.map(f=>f.name||'未知玩家')});
 }
 layers.pirates=Array.isArray(pirates?.pirates)?'已同步':'未同步';
 for(const p of pirates?.pirates??[])add('pirates','pirate-'+String(p.uid),'海盗 '+p.level+'级',p.gridIdx,'类型 '+p.type+' · 所在城 '+p.cityId+' · 首杀资格请到独立预览核对');
 layers.radar=Array.isArray(radar?.radarInfo?.events)?'已同步':'未同步';
 for(const e of [...(radar?.radarInfo?.events??[]),...(radar?.radarInfo?.fixedEvent?.eventId?[radar.radarInfo.fixedEvent]:[])])add('radar','radar-'+String(e.uid??e.eventId),'情报 '+e.eventId,e.gridIdx,'状态 '+({1:'待处理',2:'已派遣',3:'处理中',4:'可领奖'}[e.state]||'未同步')+' · 奖励 '+(e.reward?.asset??[]).map(r=>r.id+' ×'+r.num).join('、'));
 layers.boss=boss?.info?'已同步':'未同步';if(boss?.info?.bossId>0)add('boss','boss-'+boss.info.bossId,'世界Boss '+boss.info.bossId,boss.info.gridIdx,'伤害达标奖励与每日首战独立检查');
 const inventory=bag?normalize(bag).items:null;
 const resources=['汽油','种子','公会科技点'].map(id=>({id,name:id==='公会科技点'?'科技点':id,value:Array.isArray(inventory)&&inventory.filter(i=>i.itemId===id).every(i=>Number.isSafeInteger(i.num)&&i.num>=0)?inventory.filter(i=>i.itemId===id).reduce((n,i)=>n+i.num,0):null}));
 const usage=ledger.snapshot(),counters=usage.counters,pending=ledger.pendingCounters(),confirmed=ledger.confirmedCounters?.();
 const fuelActivities=[['万吨（含维修）','treasurePetrol'],['城战（含维修）','cityWarPetrol'],['联盟情报','radarPetrol'],['海盗首杀','piratePetrol'],['世界Boss','worldBossPetrol'],['硅矿（含维修）','siliconPetrol']].map(([name,key])=>({name,confirmed:confirmed&&Number.isSafeInteger(confirmed[key]??0)?confirmed[key]??0:null,pending:Number.isSafeInteger(pending[key]??0)?pending[key]??0:null}));
 const sum=key=>fuelActivities.every(r=>r[key]!==null)?fuelActivities.reduce((n,r)=>n+r[key],0):null;
 const fuelUsage={day:usage.day,stock:resources.find(r=>r.id==='汽油')?.value??null,confirmed:sum('confirmed'),pending:sum('pending'),activities:fuelActivities};
 const budgets=[['情报','radarPetrol',settings.radar.dailyPetrolLimit],['城战','cityWarPetrol',settings.cityWar.dailyPetrolLimit],['巨轮维修','treasureRepairPetrol',settings.treasure.dailyRepairPetrolLimit]].map(([name,key,limit])=>({name,limit,used:counters[key]??0,pending:pending[key]??0,remaining:limit?Math.max(0,limit-(counters[key]??0)):null}));
 const firstLimit=settings.pirateHunt.fuelBudget;
 budgets.push({name:'首杀本次',limit:firstLimit,used:pirateSpent,pending:pending.piratePetrol??0,remaining:firstLimit?Math.max(0,firstLimit-pirateSpent):null});
 budgets.push({name:'Boss首战今日',limit:0,used:counters.worldBossPetrol??0,pending:pending.worldBossPetrol??0,remaining:null});
 if(settings.silicon)budgets.push({name:'硅矿（含维修）',limit:settings.silicon.dailyPetrolLimit,used:counters.siliconPetrol??0,pending:pending.siliconPetrol??0,remaining:settings.silicon.dailyPetrolLimit?Math.max(0,settings.silicon.dailyPetrolLimit-(counters.siliconPetrol??0)):null});
 const targetPoint=(grid,uid,preferred)=>{
  if(uid){const ship=points.find(p=>p.layer==='treasure'&&p.key==='treasure-'+String(uid));if(ship)return ship;}
  for(const layer of [preferred,'boss','radar','treasure','pirates','cities','fields'].filter(Boolean)){const point=points.find(p=>p.layer===layer&&p.grid===grid);if(point)return point;}
  return null;
 };
 for(const f of fleets){const raw=own?.fleets.find(r=>r.buildingId===f.id),grid=raw?.state===2?raw.targetGridIdx:raw?.curGridIdx;
  const held=Object.entries(records).find(([key,r])=>r.details?.buildingId===f.id && fleetRecordReason({[key]:r},f.id));
  const kind=held?.[1].details.kind;
  const waitingAtHome=!!held && raw?.state===1 && !raw.curGridIdx;
  const waitingLabel=({'radarSend':'情报占用待核对','pirateFirst':'首杀战果待确认','worldBoss':'首战占用待核对','cityDispatch':'城战占用待核对','citySlot':'城战占用待核对','cityRepair':'维修待核对','treasureRepair':'维修待核对','treasureDispatch':'货轮派遣待核对'})[kind];
  const heldTask=waitingAtHome?waitingLabel:({'radarSend':'情报','pirateFirst':'海盗首杀','worldBoss':'世界Boss'})[kind];
  if(waitingAtHome && waitingLabel)f.state=waitingLabel;
  const preferred=({'radarSend':'radar','pirateFirst':'pirates','worldBoss':'boss'})[held?.[1].details.kind];
  const target=grid>0?targetPoint(grid,raw?.treasureLootUid,preferred):null;
  const ship=(treasure?.treasure??[]).find(t=>String(t.uid)===String(raw?.treasureLootUid));
  const city=cityCfg.find(c=>c.id===(raw?.state===2?raw.targetCityId:raw?.cityId));
  const homeIdle=raw?.state===1&&!raw.curGridIdx&&!raw.treasureLootUid&&!held;
  const targetCity=raw?.state===2?raw.targetCityId:raw?.cityId;
  // 城战排队/战斗回包可只给cityId而省略格子；行军阶段仍核对实际目标格。
  const cityWar=!heldTask&&(kind==='cityDispatch'||(!raw?.treasureLootUid&&targetCity>0&&declarations.some(d=>d.cityId===targetCity)&&([3,5].includes(raw?.state)||raw?.state===2&&grid===map?.cityInfo?.[targetCity]?.gridIdx)));
  f.task=homeIdle?'空闲':raw?.state===4?'维修':raw?.treasureLootUid?'万吨/货轮':heldTask|| (cityWar?'城战':({'radar':'情报','pirates':'海盗目标','boss':'世界Boss'})[target?.layer]||(raw?.chipWar?.rewardTs?'芯片争夺':raw?.state===1?'驻守':raw?.state===2&&raw?.targetCityId>0?'城市行军':'未同步'));
  f.target=homeIdle?'—':ship?treasureName(ship):target?.name||city?.name||(grid>0?'目标格 '+grid:'未同步');
  if(cityWar)f.state='城战 · '+f.state;
  if(target)f.detail+=' · 目标 '+target.name;
  const point=points.find(p=>p.key==='fleet-'+f.id);if(point){point.detail+=' · 当前任务 '+f.task+' · 当前目标 '+f.target;point.fleetInfo={state:f.state,durability:f.durability,maxDura:f.maxDura,task:f.task,journey:f.journey};}
 }
 const seen=new Set((own?.fleets??[]).map(f=>exactAutomationId(f.owner?.playerId||player.playerId)+':'+f.buildingId));
 for(const raw of marchFleets){
  const owner=exactAutomationId(raw.owner?.playerId),key=owner+':'+raw.buildingId;if(!owner||seen.has(key)||raw.state!==2)continue;seen.add(key);
  const start=pos(raw.startGridIdx),end=pos(raw.targetGridIdx);if(!start||!end||!(raw.startGridIdx>0)||!(raw.targetGridIdx>0))continue;
  const target=targetPoint(raw.targetGridIdx,raw.treasureLootUid),city=cityCfg.find(c=>c.id===raw.targetCityId);
  if(!raw.treasureLootUid&&target?.layer!=='treasure'&&!(raw.targetGridIdx===map?.cityInfo?.[raw.targetCityId]?.gridIdx&&declarations.some(d=>d.cityId===raw.targetCityId)))continue;
  const name=(raw.owner.nickname||'已同步玩家')+' · 舰队'+raw.buildingId.replace('远征船',''),targetName=target?.name||city?.name||'目标格 '+raw.targetGridIdx;
  const detail='行军至 '+targetName+' · 耐久 '+quantity(raw.durability)+'/'+quantity(raw.maxDura)+' · 预计到达 '+(raw.moveEndTs>0?new Date(raw.moveEndTs*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'}):'未同步');
  const motion=makeMotion(raw),ownerGuild=exactAutomationId(raw.owner.guildId),color=ownerColor(ownerGuild?Number(BigInt(ownerGuild)%1000n):null);
  add('traffic','traffic-'+key,name,raw.startGridIdx,detail,{motion,routeColor:color});routes.push({start,end,name,layer:'traffic',target:targetName,key:'traffic-'+key,color});
 }
 layers.traffic=Array.isArray(world?.fleets)?'仅显示服务器已同步的城战/货轮行军':'未同步';
 return {checkedAt:now,scenario,...(map?mapDimensions(map):{width:1,height:1}),regions,owners,home:points.find(p=>p.layer==='fleets')??points.find(p=>p.layer==='cities'&&p.owner===ownGuildIdx),points,routes,fleets,cityWars,treasures,war:{startTime:war?.startTime??null,endTime:war?.endTime??null,inWindow:!!warOpen},layers,resources,budgets,fuelUsage,notes:[...notes,...(!map?['场景位置未读取，地图暂不可用']:[]),'行军位置按已同步起终点和时间推算，以最新同步状态为准。空联盟名称按游戏规则显示主城默认名；未同步的行军不作推测。']};
}
