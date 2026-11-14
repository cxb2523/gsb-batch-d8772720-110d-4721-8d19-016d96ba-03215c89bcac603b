import {exactAutomationId} from './automation-policy.mjs';
const rows=(c,n)=>c?.tables?.[n]?.data??[];
export function resourceFieldRows(config,player,info,guilds){
 const world=exactAutomationId(player?.worldId),season=world?Number(BigInt(world)/1000000n%1000n):null,scenario=player?.scenarioId||1;
 return(info?.fields??[]).map(field=>{
  const city=rows(config,scenario+'_CityCfg').find(r=>r.id===field.cityId);
  const guild=city?.guildIndex>0?guilds?.find(g=>{const id=exactAutomationId(g.id);return id&&Number(BigInt(id)%1000n)===city.guildIndex;}):null;
  const level=city?.guildIndex>0?guild?.level??null:city?.level??null;
  const cfg=rows(config,scenario+'_ResFieldTypeCfg').find(r=>r.season===season&&r.type===field.type&&r.level===level);
  const base=rows(config,'ResFiledBaseCfg').find(r=>r.id===cfg?.resId);
  const product=cfg?.product,item=product?.[0]==='公会科技点'?'科技点':product?.[0];
  const resourceId=product?.[0]??rows(config,scenario+'_ResFieldTypeCfg').find(r=>r.season===season&&r.type===field.type)?.product?.[0]??null;
  return{resourceId,perHour:Number.isFinite(product?.[1])?product[1]:null,grid:field.gridIdx,cityName:city?.name||'城市未同步',name:base?.name||'资源田',level,
   product:item&&Number.isFinite(product[1])?item+' '+product[1].toLocaleString('zh-CN')+'/小时':'产出未同步'};
 });
}

export function resourceFieldTotals(info,fields){
 return ['汽油','种子','公会科技点'].map(id=>{const relevant=fields.filter(f=>f.resourceId===id),unknown=!Array.isArray(info?.fields)||fields.some(f=>!f.resourceId)||relevant.some(f=>f.perHour===null);
  return{id,name:id==='公会科技点'?'科技点':id,perHour:unknown?null:relevant.reduce((n,f)=>n+f.perHour,0)};
 });
}
