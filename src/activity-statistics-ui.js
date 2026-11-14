let activityStatsOwner=null,activityStatsAt=0,activityStatsBusy=false,activityStatsSerial=0;
function resetActivityStatistics(){activityStatsOwner=null;activityStatsAt=0;activityStatsBusy=false;activityStatsSerial++;clear($('activity-stats-table'));$('activity-stats-status').textContent='连接后读取';}
function renderActivityStatistics(data){
 const root=$('activity-stats-table'),signature=JSON.stringify([activityStatsOwner,data.items]);
 if(!root.childElementCount||root.statsSignature!==signature){
 const y=root.scrollTop,x=root.scrollLeft,innerX=root.firstElementChild?.scrollLeft||0;clear(root);
 const day=value=>Number.isSafeInteger(value)&&value>0?new Date(value*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}).replaceAll('/','-'):null;
 root.append(table(['活动','状态','进度','日期','福利','达标奖励','排名'],(data.items??[]).map(row=>{
  let rank=row.rank||'—';
  if(row.rankKey&&rank!=='—'&&rank!=='未同步'){
   const link=el('button','inline-link',rank);link.type='button';link.setAttribute('aria-label',row.name+'排行：'+rank);
   link.onclick=async()=>{await refreshActivityRanks(true);if(rankTabs.some(t=>t.key===row.rankKey)){rankKey=row.rankKey;rankPage=1;rankPaintTabs();await loadActivityRank();$('activity-rank-tabs').scrollIntoView({block:'nearest'});}else $('activity-stats-status').textContent='该活动当前没有开放的榜单';};rank=link;
  }
  const start=day(row.startTime),end=day(row.endTime),range=start&&end?start+'～'+end:end?'至 '+end:start?'始于 '+start:'—';
  const progress=(row.progress||'—').replace('当前累计可收集数量为','可收集 ').replaceAll('当前商品：','持货 ').replaceAll('本程商品：','本程 ').replaceAll('目标城池：','目标 ').replaceAll('所在城池：','所在 ').replaceAll('，等待联盟商情更新','，等商情');
  return[row.name,row.status,progress,range,row.welfare,(row.rewards||'—').replaceAll('尚未达成 · 已领 ','未达 · ').replaceAll('已达成已领 · ','已领 '),rank];
 })));
 if(!data.items?.length)root.append(el('p','dim','当前没有已同步的活动。'));
 root.scrollTop=y;root.scrollLeft=x;if(root.firstElementChild)root.firstElementChild.scrollLeft=innerX;root.statsSignature=signature;
 }
 const failed=(data.items??[]).filter(r=>r.error).map(r=>r.name);
 $('activity-stats-status').textContent='更新 '+new Date(data.checkedAt*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})+(failed.length?' · 未同步：'+failed.join('、'):data.notes?.length?' · 部分活动开放状态未同步':'');
}
async function refreshActivityStatistics(force=false){
 if(document.hidden||$('tab-overview').classList.contains('hidden'))return;
 if(!current||snapshot.paused||disconnected.has(current)){resetActivityStatistics();return;}
 if(activityStatsOwner!==current)resetActivityStatistics();
 if(activityStatsBusy||!force&&Date.now()-activityStatsAt<60000)return;
 const owner=current,serial=++activityStatsSerial;activityStatsOwner=owner;activityStatsBusy=true;activityStatsAt=Date.now();$('activity-stats-refresh').disabled=true;$('activity-stats-status').textContent='正在读取活动统计…';
 try{const data=await call('/api/activity-statistics'+(force?'?refresh=1':''));if(current===owner&&serial===activityStatsSerial)renderActivityStatistics(data);}
 catch{if(current===owner&&serial===activityStatsSerial)$('activity-stats-status').textContent='活动统计读取失败，请稍后刷新';}
 finally{if(serial===activityStatsSerial){activityStatsBusy=false;$('activity-stats-refresh').disabled=false;}}
}
$('activity-stats-refresh').onclick=()=>refreshActivityStatistics(true);
