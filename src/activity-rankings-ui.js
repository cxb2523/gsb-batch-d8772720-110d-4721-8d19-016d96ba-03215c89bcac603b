let rankOwner=null,rankTabs=[],rankKey=null,rankPage=1,rankPages=1,rankSerial=0,rankCatalogAt=0,rankReadAt=0,rankCatalogBusy=false;
function resetActivityRanks(){rankOwner=null;rankKey=null;rankTabs=[];rankPage=1;rankCatalogAt=rankReadAt=0;++rankSerial;for(const id of ['activity-rank-tabs','activity-rank-table','activity-rank-mine','activity-rank-page'])clear($(id));$('activity-rank-status').textContent='等待当前账号';$('activity-rank-prev').disabled=$('activity-rank-next').disabled=true;}
function rankPaintTabs(){
 const box=$('activity-rank-tabs'),signature=JSON.stringify([rankOwner,rankTabs.map(t=>[t.key,t.label])]);
 if(box.childElementCount && box.tabKey===signature){
   for(const button of box.children){const selected=button.id==='rank-tab-'+encodeURIComponent(rankKey);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
   if(rankKey)$('activity-rank-panel').setAttribute('aria-labelledby','rank-tab-'+encodeURIComponent(rankKey));
   return;
 }
 const scroll=box.scrollLeft;box.tabKey=signature;clear(box);
 for(const tab of rankTabs){const button=el('button','',tab.label.replace(/^捞尸人联动 · /,''));button.type='button';button.id='rank-tab-'+encodeURIComponent(tab.key);button.setAttribute('role','tab');button.setAttribute('aria-selected',String(tab.key===rankKey));button.setAttribute('aria-controls','activity-rank-panel');button.tabIndex=tab.key===rankKey?0:-1;
  button.onclick=()=>{if(rankKey===tab.key)return;rankKey=tab.key;rankPage=1;rankPaintTabs();void loadActivityRank();};
  button.onkeydown=e=>{const index=rankTabs.findIndex(t=>t.key===tab.key),next=e.key==='ArrowRight'?(index+1)%rankTabs.length:e.key==='ArrowLeft'?(index+rankTabs.length-1)%rankTabs.length:e.key==='Home'?0:e.key==='End'?rankTabs.length-1:null;if(next!==null){e.preventDefault();box.children[next].click();box.children[next].focus();}};box.append(button);
 }
 box.scrollLeft=scroll;
 if(rankKey)$('activity-rank-panel').setAttribute('aria-labelledby','rank-tab-'+encodeURIComponent(rankKey));
}
async function loadActivityRank(){
 if(!current||!rankKey||snapshot.paused||disconnected.has(current))return;
 const owner=current,key=rankKey,page=rankPage,serial=++rankSerial;
 $('activity-rank-status').textContent='正在读取…';$('activity-rank-prev').disabled=$('activity-rank-next').disabled=true;const host=$('activity-rank-table'),identity=JSON.stringify([owner,key,page]);
 if(host.rankIdentity!==identity){clear(host);host.rankSignature=null;host.scrollTop=0;$('activity-rank-mine').textContent='';}
 host.rankIdentity=identity;
 try{
  const data=await call('/api/activity-ranks/view?key='+encodeURIComponent(key)+'&page='+page);
  if(owner!==current||key!==rankKey||serial!==rankSerial)return;
  if(data.key!==key)throw Error('榜单响应与当前页签不一致，请刷新');
  rankPages=data.totalPages;rankReadAt=Date.now();
  const score=value=>value==null?'未同步':fmt(value),mine=data.mine;
  $('activity-rank-mine').textContent=mine?'我：'+(mine.rank>0?'第 '+mine.rank+' 名':'未上榜')+' · '+data.scoreLabel+' '+score(mine.score):'我的排名未同步';
  if(page>rankPages){rankPage=rankPages;return loadActivityRank();}
  const signature=JSON.stringify([data.rows,data.reason,data.scoreLabel]);
  if(host.rankSignature!==signature){
  const y=host.scrollTop,x=host.scrollLeft,innerX=host.firstElementChild?.scrollLeft||0,root=clear(host);
  if(data.rows.length){const power=data.rows.some(r=>r.power!==null);root.append(table(['名次','玩家',data.scoreLabel,...(power?['战力']:[])],data.rows.map(r=>[r.rank>0?String(r.rank):'—',r.name+(r.own?'（我）':''),score(r.score),...(power?[score(r.power)]:[])])));}
  if(data.reason)root.append(el('p','dim',data.reason));
  host.scrollTop=y;host.scrollLeft=x;if(host.firstElementChild)host.firstElementChild.scrollLeft=innerX;host.rankSignature=signature;
  }
  $('activity-rank-status').textContent='更新 '+new Date(data.checkedAt*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'});
  $('activity-rank-page').textContent=page+' / '+rankPages+' 页';
  $('activity-rank-prev').disabled=page<=1;$('activity-rank-next').disabled=page>=rankPages;
 }catch(error){if(owner===current&&serial===rankSerial){$('activity-rank-status').textContent='读取失败：'+error.message;$('activity-rank-page').textContent='';}}
}
async function refreshActivityRanks(force=false){
 if(rankCatalogBusy||document.hidden||$('tab-overview').classList.contains('hidden'))return;
 if(!current||snapshot.paused||disconnected.has(current)){$('activity-rank-status').textContent='连接账号后查看';return;}
 const owner=current;
 if(rankOwner!==owner){rankOwner=owner;rankTabs=[];rankKey=null;rankPage=1;rankCatalogAt=rankReadAt=0;++rankSerial;clear($('activity-rank-tabs'));delete $('activity-rank-tabs').tabKey;clear($('activity-rank-table'));$('activity-rank-mine').textContent='';}
 if(!force&&Date.now()-rankCatalogAt<60000){if(Date.now()-rankReadAt>=60000)await loadActivityRank();return;}
 rankCatalogBusy=true;
 try{const data=await call('/api/activity-ranks');if(owner!==current)return;rankTabs=data.tabs;rankCatalogAt=Date.now();if(!rankTabs.some(t=>t.key===rankKey)){rankKey=rankTabs[0]?.key??null;rankPage=1;}rankPaintTabs();if(rankKey)await loadActivityRank();else $('activity-rank-status').textContent='当前没有可查询的榜单';}
 catch(error){if(owner===current)$('activity-rank-status').textContent='榜单目录读取失败：'+error.message;}
 finally{rankCatalogBusy=false;}
}
$('activity-rank-refresh').onclick=()=>refreshActivityRanks(true);
$('activity-rank-prev').onclick=()=>{if(rankPage>1){rankPage--;void loadActivityRank();}};
$('activity-rank-next').onclick=()=>{if(rankPage<rankPages){rankPage++;void loadActivityRank();}};
