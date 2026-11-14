import {normalize} from './worlds.mjs';
import {exactAutomationId} from './automation-policy.mjs';

const rows=(config,name)=>config?.tables?.[name]?.data??[];
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const active=new WeakSet();
const identity=player=>[exactAutomationId(player?.playerId),exactAutomationId(player?.guildId),exactAutomationId(player?.worldId)].join(':');

function effectText(config,cfg,level){
 const sign=cfg.effectId?.startsWith('减少')?'-':'+';
 if(cfg.type==='世界'||cfg.type.startsWith('职级')&&cfg.groupId!==3){
  const value=level>0?cfg.effectInit+cfg.effectGrowth*(level-1):0;
  const percent=['提高攻城移速','减少耐久修复消耗','减少耐久修复时间','建造速度','生产速度提高'].includes(cfg.effectId);
  return cfg.effectDesc+' '+sign+(percent?Number((value*100).toFixed(2))+'%':value);
 }
 return (cfg.attrs??[]).map(([id,base],index)=>{const attr=rows(config,'AdditionAttrOverviewCfg').find(r=>r.id===id),growth=cfg.attrsGrowth?.[index];
  const value=level>0?base+(growth?.[0]===id?growth[1]:0)*(level-1):0;
  return (attr?.name||id)+' '+sign+(attr?.type==='百分比'?Number((value*100).toFixed(2))+'%':value);
 }).join('、')||'效果未配置';
}

export function guildTechView(config,{season,stage,tech,items}){
 if(!valid(season)||season<1||!valid(stage)||!Array.isArray(tech)||!Array.isArray(items))throw Error('科技等级、阶段或库存未同步，请刷新重试');
 if(tech.some(t=>!valid(t.techId)||t.techId<1||!valid(t.level))||new Set(tech.map(t=>t.techId)).size!==tech.length)throw Error('科技等级数据不完整，请刷新重试');
 const definitions=rows(config,'GuildTechCfg').filter(r=>r.season===season),levels=new Map(tech.map(t=>[t.techId,t.level]));
 if(!definitions.length)throw Error('当前赛季科技配置未找到');
 const balances=['公会科技点','联盟职级科技点'].map(id=>{const matches=items.filter(r=>r.itemId===id);return{id,name:id==='公会科技点'?'科技点':'职级科技点',value:matches.every(r=>valid(r.num))?matches.reduce((n,r)=>n+r.num,0):null};});
 const result=definitions.map(cfg=>{
  const level=levels.get(cfg.techId)??0,unlocks=rows(config,'TechUnlockCfg').filter(r=>r.techId===cfg.techId).sort((a,b)=>a.openStage-b.openStage);
  const current=stage===0?unlocks.at(-1):[...unlocks].reverse().find(r=>r.openStage<=stage)||unlocks[0];
  const itemId=cfg.type.startsWith('职级')?'联盟职级科技点':'公会科技点',balance=balances.find(r=>r.id===itemId);
  const cost=cfg.techPointCost+cfg.techPointCostGrowth*level,maxLevel=current?.maxLevel??null,totalMax=unlocks.at(-1)?.maxLevel??null;
  let reason='';
  if(!current||!valid(maxLevel)||!valid(cost)||cost<=0)reason='升级配置未确认';
  else if(level>=totalMax)reason='已满级';
  else if(level>=maxLevel)reason='等待下一赛季阶段';
  else if(stage!==0&&stage<current.openStage)reason='赛季阶段尚未开放';
  else if(current.preTech>0&&(levels.get(current.preTech)??0)<current.preTechLevel)reason='需'+(definitions.find(r=>r.techId===current.preTech)?.name||'前置科技')+' '+current.preTechLevel+'级';
  else if(balance.value===null)reason='科技点未同步';
  else if(balance.value<cost)reason=balance.name+'不足';
  return{id:cfg.techId,name:cfg.name,type:cfg.type,group:cfg.group,level,maxLevel,totalMax,effect:effectText(config,cfg,level),nextEffect:level<totalMax?effectText(config,cfg,level+1):null,cost,itemId,itemName:balance.name,reason,canUpgrade:!reason};
 });
 return{season,stage,balances,rows:result,learned:result.filter(r=>r.level>0).length,total:result.length,totalLevels:result.reduce((sum,r)=>sum+r.level,0)};
}

export async function readGuildTech(client,config,player,{ledger}={}){
 const who=identity(player),guildId=exactAutomationId(player?.guildId),worldId=exactAutomationId(player?.worldId);
 if(!guildId||BigInt(guildId)%1000n===0n)return{state:'notJoined',reason:'当前未加入联盟',rows:[]};
 if(!worldId)throw Error('赛季身份未同步');
 const guild=await client.request('GuildInfoRequest',{},'GuildInfoResponse');
 if(exactAutomationId(guild.guild?.guildId)!==guildId)throw Error('联盟身份已变化，请刷新重试');
 const tech=await client.request('GuildTechInfoRequest',{},'GuildTechInfoResponse');
 const stage=await client.request('SeasonTaskStageRequest',{},'SeasonTaskStageResponse');
 const bag=await client.request('AllItemRequest',{},'AllItemResponse');
 if(identity(player)!==who)throw Error('账号或联盟已变化，请重新读取科技');
 const view=guildTechView(config,{season:Number(BigInt(worldId)/1000000n%1000n),stage:stage.stage,tech:tech.tech,items:normalize(bag).items});
 let pending=false;
 for(const[key,record]of Object.entries(ledger?.keyRecords()??{})){
  if(record.details?.kind!=='manualGuildTech'||record.details.identity!==who)continue;
  const current=view.rows.find(r=>r.id===record.details.techId);
  if(current&&current.level>record.details.beforeLevel){if(!record.confirmed)ledger.resolveKey(key,true);ledger.releaseCompletedKey(key);}
  else if(!record.confirmed)pending=true;
 }
 if(pending)for(const row of view.rows){row.canUpgrade=false;row.reason='前次科技升级结果待确认，请稍后刷新';}
 return{state:'member',identity:who,...view,pending};
}

export async function upgradeGuildTech(client,config,player,{techId,expectedLevel,maxCost,enabled=()=>true,ledger,counters={},limits={}}={}){
 if(!valid(techId)||techId<1||!valid(expectedLevel)||!valid(maxCost)||maxCost<1)throw Error('升级参数无效，请刷新科技列表');
 if(!ledger)throw Error('升级记录不可用，未执行');
 if(!enabled()||active.has(client))throw Error('账号已暂停或科技升级正在进行');
 active.add(client);
 try{
  const who=identity(player),view=await readGuildTech(client,config,player,{ledger}),row=view.rows.find(r=>r.id===techId);
  if(!row||view.state!=='member')throw Error(view.reason||'当前赛季没有该科技');
  if(row.level!==expectedLevel)throw Error('科技等级已变化，请刷新后再升级');
  if(!row.canUpgrade)throw Error(row.reason);
  if(row.cost>maxCost)throw Error('升级费用已变化，请刷新后确认');
  if(!enabled()||identity(player)!==who)throw Error('账号状态已变化，未执行升级');
  const key='manual-tech:'+who+':'+techId+':'+expectedLevel;
  const ticket=ledger.reserve(counters,limits,{},{uniqueKey:key,details:{kind:'manualGuildTech',identity:who,techId,beforeLevel:expectedLevel,cost:row.cost,itemId:row.itemId}});
  try{
   const reply=await client.request('UpgradeGuildTechRequest',{techId},'UpgradeGuildTechResponse');
   if(reply.tech?.techId!==techId||reply.tech?.level!==expectedLevel+1)throw Error('升级结果待确认，请稍后刷新，暂不重复提交');
   ledger.confirm(ticket);
   return{ok:true,label:row.name+'已升至'+reply.tech.level+'级',level:reply.tech.level,cost:row.cost};
  }catch(error){if(error.notSent===true||error.prompt&&error.request==='UpgradeGuildTechRequest')ledger.cancel(ticket);throw error;}
 }finally{active.delete(client);}
}
