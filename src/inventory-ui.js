let inventoryData=[],inventoryOwner=null,inventoryQuery=null;
function resetInventory(){inventoryQuery=null;inventoryData=[];inventoryOwner=current;$('inventory-query').value='';$('world-stock-panel').open=false;clear($('world-stock'));$('inventory-match-count').textContent='';}
function renderInventory(stock){
 if(inventoryOwner!==current)resetInventory();
 if(JSON.stringify(inventoryData)!==JSON.stringify(stock)||inventoryQuery===null){inventoryData=stock;paintInventory();}
 $('inventory-status').textContent='共 '+stock.length+' 种 · 更新于 '+new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'});
}
function paintInventory(){
 const root=$('world-stock'),query=$('inventory-query').value.trim().toLocaleLowerCase(),opened=new Set([...root.querySelectorAll('details[open]')].map(d=>d.dataset.category));
 const sameQuery=query===inventoryQuery,previous=new Set([...root.querySelectorAll('details')].map(e=>e.dataset.category));inventoryQuery=query;
 const filtered=inventoryData.filter(e=>!query||e.name.toLocaleLowerCase().includes(query));clear(root);
 const categories=[...new Set(filtered.map(e=>e.category||'其他'))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 for(const name of categories){
  const entries=filtered.filter(e=>(e.category||'其他')===name),group=el('details','inventory-category'),grid=el('div','icons');group.dataset.category=name;group.open=opened.has(name)||!!query&&(!sameQuery||!previous.has(name));group.append(el('summary','',name+' · '+entries.length+' 种'));
  for(const entry of entries)grid.append(cell(entry.icon,30,entry.name,fmt(entry.num)));group.append(grid);root.append(group);
 }
 if(!filtered.length)root.append(el('p','dim',query?'没有匹配的资源名称':'仓库空'));
 $('inventory-match-count').textContent=query?'匹配 '+filtered.length+' / '+inventoryData.length+' 种':categories.length+' 类';
 $('world-stock-panel').querySelector('summary').textContent='分类库存 · '+filtered.length+' 种';
 if(query&&!sameQuery)$('world-stock-panel').open=true;
}
$('inventory-query').oninput=paintInventory;
