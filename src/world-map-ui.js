// 原生滑块没有已填充轨道，用变量画出 shadcn Slider 的进度。
function setMapZoomInput(value){const input=$('world-map-zoom');input.value=String(value);input.style.setProperty('--range-fill',(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min))*100+'%');}
let worldMapAutoRefresh=true;
let worldMapOwner=null,worldMapData=null,worldMapSerial=0,worldMapLoading=false,worldMapPainted=null,worldMapSelected=null;
let worldMapView={x:0,y:0,zoom:1},worldMapDrag=null,worldMapDraggedAt=0,worldMapAllNames=false;
let worldMapReceivedAt=0,worldMapLastAttempt=0,worldMapRefreshEvery=10,worldMapMovingNodes=[],worldMapJourneyNodes=[],worldMapDrawnPoints=[];
const worldLayerNames={regions:'领地',cities:'城池',cityWar:'城战',fleets:'我的舰队',traffic:'已同步行军',fields:'资源田',treasure:'货轮',pirates:'海盗',radar:'情报',boss:'Boss'};
const worldLayerColors={regions:'#69b3a5',cities:'#526f7a',cityWar:'#b5483e',fleets:'#2866cc',traffic:'#8653a0',fields:'#4b91b7',treasure:'#c18a12',pirates:'#bc4747',radar:'#b7672d',boss:'#8653a0'};
const worldLayers=new Set(['regions','cities','cityWar','fleets','traffic','treasure','radar','boss']);
const mapNode=(tag,attrs={})=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))node.setAttribute(k,String(v));return node;};
function resetWorldMap(){
 worldMapOwner=null;worldMapData=null;worldMapPainted=null;worldMapSelected=null;worldMapSerial++;worldMapLoading=false;
 worldMapReceivedAt=0;worldMapLastAttempt=0;worldMapMovingNodes=[];worldMapJourneyNodes=[];worldMapDrawnPoints=[];
 $('world-map-refresh').disabled=false;for(const id of ['world-map','world-map-fleets','world-map-wars','world-map-treasures','world-map-resources','world-map-layers','world-map-legend','world-map-state-legend','world-map-notes'])clear($(id));
 $('world-map-time').textContent='尚未读取';$('world-map-detail').hidden=true;worldMapView={x:0,y:0,zoom:1};setMapZoomInput(1);
}
const mapNumber=value=>Number.isSafeInteger(value)&&value>=0?fmt(value):'未同步';
const mapElapsed=()=>worldMapReceivedAt?(Date.now()-worldMapReceivedAt)/1000:0;
const mapStale=()=>mapElapsed()>Math.max(30,worldMapRefreshEvery*3);
const mapServerNow=()=>worldMapData?worldMapData.checkedAt+Math.min(mapElapsed(),Math.max(30,worldMapRefreshEvery*3)):Date.now()/1000;
function mapDuration(seconds){if(!Number.isFinite(seconds))return '时间未同步';seconds=Math.max(0,Math.ceil(seconds));const minutes=Math.floor(seconds/60);return minutes?minutes+'分'+seconds%60+'秒':seconds+'秒';}
function mapJourney(journey){if(!journey)return '—';const remaining=Math.max(0,Math.ceil(journey.endAt-mapServerNow()));return journey.from+' → '+journey.to+'（'+(mapStale()?'待同步':remaining?'剩余'+mapDuration(remaining):'到达待同步')+'）';}
function journeyNode(journey){const node=el('span','world-journey',mapJourney(journey));if(journey){node.title='全程 '+mapDuration(journey.endAt-journey.startAt);worldMapJourneyNodes.push({node,journey});}return node;}
function locateOwnFleet(fleet){const point=worldMapData?.points.find(p=>p.key==='fleet-'+fleet.id);if(!point)return;const position=mapMotionPosition(point,mapServerNow());worldMapView={x:position.x,y:position.y,zoom:4};setMapZoomInput(4);void showWorldMapTarget(point);}
function mapFacts(panel,entries){const list=el('dl','world-city-facts');for(const [label,value]of entries){list.append(el('dt','',label),el('dd','',value));}panel.append(list);}
function paintWorldFuel(data){
 const box=clear($('world-map-resources')),usage=data.fuelUsage,stock=usage?.stock??data.resources?.find(r=>r.id==='汽油')?.value??null,summary=el('div','world-fuel-summary');
 for(const [label,value]of [['库存',stock],['今日耗油',usage?.confirmed],['待确认',usage?.pending]]){const item=el('span','',label);item.append(el('strong','',mapNumber(value)));summary.append(item);}box.append(summary);
 if(usage?.activities)box.append(table(['活动','今日已确认','待确认'],usage.activities.map(r=>[r.name,mapNumber(r.confirmed),mapNumber(r.pending)])));
 box.append(el('p','dim','仅统计本工具自动任务；万吨用量已含维修，不重复相加。'));
}
function mapViewBox(){
 const box=$('world-map-scroll'),data=worldMapData,ratio=Math.max(.1,box.clientWidth/Math.max(1,box.clientHeight));
 const width=Math.max(data.width,data.height*ratio)/worldMapView.zoom,height=width/ratio;
 worldMapView.x=width>=data.width?data.width/2:Math.max(width/2,Math.min(data.width-width/2,worldMapView.x));
 worldMapView.y=height>=data.height?data.height/2:Math.max(height/2,Math.min(data.height-height/2,worldMapView.y));
 return {x:worldMapView.x-width/2,y:worldMapView.y-height/2,width,height};
}
function applyMapView(){if(!worldMapData)return;const v=mapViewBox();$('world-map').setAttribute('viewBox',[v.x,v.y,v.width,v.height].join(' '));}
function mapZoom(value,anchor){
 if(!worldMapData)return;const before=mapViewBox();worldMapView.zoom=Math.max(1,Math.min(8,value));setMapZoomInput(worldMapView.zoom);
 if(anchor){const after=mapViewBox();worldMapView.x=before.x+before.width*anchor.x+(0.5-anchor.x)*after.width;worldMapView.y=before.y+before.height*anchor.y+(0.5-anchor.y)*after.height;}
 drawWorldMap();
}
function mapFullView(){if(!worldMapData)return;worldMapSelected=null;$('world-map-detail').hidden=true;worldMapView={x:worldMapData.width/2,y:worldMapData.height/2,zoom:1};setMapZoomInput(1);drawWorldMap();}
async function showWorldMapTarget(point,refresh=false){
 if(!refresh&&Date.now()-worldMapDraggedAt<180)return;
 worldMapSelected=point.key;if(!refresh)drawWorldMap();
 const panel=$('world-map-detail'),nearbyWasOpen=refresh&&panel.querySelector('[data-nearby]')?.open;clear(panel);panel.hidden=false;
 panel.append(el('strong','',point.name));
 if(point.cityInfo){const c=point.cityInfo,entries=[['所属',c.owner],['城战',c.status]];
  if(c.assemble)entries.push(['集结','本盟集结城市']);
  if(c.declared.length)entries.push(['宣战',c.declared.map(d=>d.attack+' → '+d.defence).join('；')]);
  if(c.declared.length||c.fighters.length||c.attack>0||c.priorityAttack>0)entries.push(['进攻','优先 '+mapNumber(c.priorityAttack)+' + 排队 '+mapNumber(c.attack)]);
  entries.push(['驻防','优先 '+mapNumber(c.priorityDefence)+' + 普通 '+mapNumber(c.defence)]);mapFacts(panel,entries);
  if(c.fighters.length)panel.append(table(['交战位','进攻方','防守方'],c.fighters.map((f,i)=>[String(i+1),f.attack,f.defence])));
  const unit=mapViewBox().width/Math.max(1,$('world-map-scroll').clientWidth),nearby=worldMapData.points.filter(p=>['fleets','traffic'].includes(p.layer)&&Math.hypot(mapMotionPosition(p,mapServerNow()).x-point.x,mapMotionPosition(p,mapServerNow()).y-point.y)<12*unit);
  if(nearby.length){const details=el('details'),buttons=el('div','bar world-nearby-list');details.dataset.nearby='true';details.open=!!nearbyWasOpen;details.append(el('summary','','附近舰队 · '+nearby.length));for(const p of nearby){const button=smallButton(p.name);button.onclick=()=>showWorldMapTarget(p);buttons.append(button);}details.append(buttons);panel.append(details);}return;
 }
 if(point.cluster?.length>1){const actions=el('div','bar');for(const fleet of point.cluster)actions.append(smallButton(fleet.name));[...actions.children].forEach((b,i)=>b.onclick=()=>showWorldMapTarget(point.cluster[i]));panel.append(actions);}
 if(point.fleetInfo){const f=point.fleetInfo;mapFacts(panel,[['状态',f.state],['耐久',mapNumber(f.durability)+'/'+mapNumber(f.maxDura)],['任务',f.task]]);if(f.journey)panel.append(journeyNode(f.journey));return;}
 if(point.layer==='traffic'){panel.append(journeyNode(point.motion),el('p','dim',point.motion?'箭头位置按行军时间推算。':'时间未同步，仅显示已知起点。'));return;}
 panel.append(el('p','',point.detail));
 if(['treasure','radar','pirates'].includes(point.layer)){const link=el('a','','查看参数与独立预览');link.href='#config-group-'+({treasure:'treasure',radar:'radar',pirates:'pirate-hunt'})[point.layer];panel.append(link);}
 const detail=el('div','dim','正在核对目标条件…');panel.append(detail,el('p','dim','地图只读，不会派遣舰队。'));const owner=current;
 try{
  const info=await call('/api/world/target?layer='+encodeURIComponent(point.layer)+'&key='+encodeURIComponent(point.key));if(owner!==current||!detail.isConnected)return;clear(detail);
  if(info.fuel!==null&&info.fuel!==undefined)detail.append(el('p','','汽油库存 '+fmt(info.fuel)+(info.cost!==null&&info.cost!==undefined?' · 单队费用 '+fmt(info.cost):'')));
  for(const note of info.notes??[])if(note)detail.append(el('p','',note));
  if(info.fleets?.length)detail.append(table(['舰队','当前条件'],info.fleets.map(f=>[f.name||f.buildingId,f.reason||'基础条件符合，仍需核对目标与预算'])));
  for(const action of info.actions??[])detail.append(el('p','',action.label+' · '+(action.costs??[]).map(c=>(c.name||c.id)+' '+c.num).join('、')));
 }catch(error){if(detail.isConnected)detail.textContent='目标详情未同步：'+error.message;}
}
function cityBadge(group,point,x,y,unit,r){
 const kinds=point.fighting?['fight']:point.declared?[point.warRole==='defence'?'defence':'attack']:[];if(point.assemble)kinds.push('assemble');
 if(point.fighting)group.append(mapNode('circle',{cx:x,cy:y,r:r+3*unit,fill:'none',stroke:'#c05a24','stroke-width':1.5,'vector-effect':'non-scaling-stroke'}));
 const paths={attack:'M6 4 17 15 M6 4 6 8 M6 4 10 4 M5 13 11 19 M8 16 4 20 M18 4 7 15 M18 4 14 4 M18 4 18 8 M13 19 19 13 M16 16 20 20',defence:'M12 3 20 6 V12 C20 17 16 20 12 22 C8 20 4 17 4 12 V6 Z M12 7 V16 M8 12 12 16 16 12',fight:'M13 2 C14 8 21 9 20 15 A8 8 0 0 1 4 15 C3 11 6 8 8 6 C7 11 11 11 13 2 Z M12 12 C15 15 15 18 12 20 C9 19 9 16 12 12 Z',assemble:'M5 21 V3 M6 4 H19 L16 8 19 12 H6 M3 21 H9'};
 const colors={attack:'#b14538',defence:'#226b9a',fight:'#bf5924',assemble:'#8b642b'};
 kinds.forEach((kind,index)=>{const badge=mapNode('g',{transform:'translate('+(x+(index?11:-10)*unit)+' '+(y-23*unit)+') scale('+(unit*.53)+')','pointer-events':'none','data-war-icon':kind});badge.append(mapNode('rect',{x:1,y:1,width:22,height:22,rx:5,fill:'#fffdf7',stroke:colors[kind],'stroke-width':1}),mapNode('path',{d:paths[kind],fill:kind==='fight'?'#fff0d4':'none',stroke:colors[kind],'stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round'}));group.append(badge);});
}
function paintMapStateLegend(){const root=clear($('world-map-state-legend'));for(const [label,kind]of [['我盟宣战','attack'],['我盟受攻','defence'],['交战','fight'],['集结','assemble']]){const item=el('span'),svg=mapNode('svg',{viewBox:'-12 -22 26 24','aria-hidden':'true'});cityBadge(svg,{declared:kind==='attack'||kind==='defence',fighting:kind==='fight',assemble:kind==='assemble',warRole:kind},0,0,1,0);item.append(svg,el('span','',label));root.append(item);}root.append(el('span','','攻/守数字：优先 + 普通队列'));}
function drawWorldMap(){
 const data=worldMapData;if(!data||!$('world-map-scroll').clientWidth)return;const svg=$('world-map');
 if(worldMapPainted!==data){
  clear(svg);const territory=mapNode('g',{id:'world-map-regions'});
  for(const region of data.regions??[])territory.append(mapNode('path',{d:region.path,fill:region.color,stroke:'#e9f0f2','stroke-width':.6,'vector-effect':'non-scaling-stroke','fill-rule':'evenodd'}));
  svg.append(territory,mapNode('g',{id:'world-map-routes'}),mapNode('g',{id:'world-map-markers'}),mapNode('g',{id:'world-map-labels','pointer-events':'none'}));worldMapPainted=data;
 }
 const v=mapViewBox();applyMapView();const unit=v.width/Math.max(1,$('world-map-scroll').clientWidth),markers=clear($('world-map-markers')),labels=clear($('world-map-labels')),routes=clear($('world-map-routes'));
 worldMapMovingNodes=[];const movingByKey=new Map();
 $('world-map-regions').style.display=worldLayers.has('regions')?'':'none';
 for(const route of data.routes){
  const layer=route.layer||'fleets';if(!worldLayers.has(layer))continue;
  const color=route.color||worldLayerColors[layer],line=mapNode('line',{x1:route.start.x,y1:route.start.y,x2:route.end.x,y2:route.end.y,stroke:'color-mix(in srgb, '+color+' 55%, #101c28)','stroke-width':1.8,'stroke-dasharray':'4 3','vector-effect':'non-scaling-stroke'}),tip=mapNode('title');tip.textContent=route.name+(route.target?' → '+route.target:'');line.append(tip);routes.append(line);
 }
 const all=[],fleets=new Map();
 for(const p of data.points){if(!worldLayers.has(p.layer)&&!(p.layer==='cities'&&worldLayers.has('cityWar')&&(p.declared||p.fighting||p.assemble)))continue;if(p.layer==='fleets'&&!p.motion){const group=fleets.get(p.grid)??[];group.push(p);fleets.set(p.grid,group);}else all.push(p);}
 for(const cluster of fleets.values())all.push(cluster.length===1?cluster[0]:{...cluster[0],name:cluster.length+'支舰队（同位置）',cluster});
 // 城池在到达箭头之上，避免箭头终点遮住城池点击；附近舰队仍可在详情选择。
 all.sort((a,b)=>Number(a.layer==='cities')-Number(b.layer==='cities'));
 worldMapDrawnPoints=all;
 const named=[];
 for(const point of all){
  const layer=point.layer,{x,y}=mapMotionPosition(point,mapServerNow()),selected=point.key===worldMapSelected,r=(layer==='cities'?(point.capital||point.cityType===5?7:4):layer==='fleets'?7:layer==='fields'?2.7:layer==='treasure'?({1:7,2:10,3:14})[point.size]||7:5)*unit;
  const group=mapNode('g',{role:'button',tabindex:0,'aria-label':worldLayerNames[layer]+'：'+point.name+'，查看详情'}),title=mapNode('title');title.textContent=point.name+' · '+(point.motion?mapJourney(point.motion):point.detail);group.append(title);
  let shape,fill=point.routeColor||worldLayerColors[layer];
  if(point.motion){const m=point.motion,a=Math.atan2(m.end.y-m.start.y,m.end.x-m.start.x),vertices=[[r,0],[-r*.75,-r*.6],[-r*.25,0],[-r*.75,r*.6]].map(([dx,dy])=>[x+dx*Math.cos(a)-dy*Math.sin(a),y+dx*Math.sin(a)+dy*Math.cos(a)]);shape=mapNode('polygon',{points:vertices.map(p=>p.join(',')).join(' ')});}
  else if(layer==='cities'){
   fill='#f5fafb';
   if(point.capital||point.cityType===5){const star=Array.from({length:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI/5,d=i%2?r*.45:r;return[x+Math.cos(a)*d,y+Math.sin(a)*d].join(',');});shape=mapNode('polygon',{points:star.join(' ')});}
   else if(point.cityType===1)shape=mapNode('rect',{x:x-r*.8,y:y-r*.8,width:r*1.6,height:r*1.6});
   else if(point.cityType>=3)shape=mapNode('polygon',{points:[[x,y-r],[x+r,y],[x,y+r],[x-r,y]].map(p=>p.join(',')).join(' ')});
   else shape=mapNode('circle',{cx:x,cy:y,r});
  }else if(layer==='fleets')shape=mapNode('circle',{cx:x,cy:y,r});
  else if(layer==='treasure'){shape=mapNode('path',{d:'M-10 1 H10 L6 6 H-6 Z M-7 0 V-4 H-1 V0 M0 0 V-4 H5 V0 M5 -4 V-7 H8 V0',transform:'translate('+x+' '+y+') scale('+(r/10)+')','stroke-linejoin':'round','data-ship-size':point.size||1});}
  else if(layer==='boss')shape=mapNode('polygon',{points:[[x,y-r],[x+r,y],[x,y+r],[x-r,y]].map(p=>p.join(',')).join(' ')});
  else if(layer==='fields'||layer==='radar')shape=mapNode('rect',{x:x-r,y:y-r,width:r*2,height:r*2});
  else shape=mapNode('circle',{cx:x,cy:y,r});
  for(const[k,value]of Object.entries({fill,stroke:layer==='cities'?'#5e7884':'#f6fcfe','stroke-width':1.25,'vector-effect':'non-scaling-stroke',class:'map-symbol'}))shape.setAttribute(k,value);group.append(shape);
  if(layer==='cities'&&worldLayers.has('cityWar')&&(point.declared||point.fighting||point.assemble))cityBadge(group,point,x,y,unit,r);
  if(layer==='fleets'&&!point.motion){const count=mapNode('text',{x,y:y+3*unit,'text-anchor':'middle','font-size':9*unit,class:'map-fleet-count'});count.textContent=point.cluster?String(point.cluster.length):point.name.match(/\d+/)?.[0]||'舟';group.append(count);}
  if(selected)group.append(mapNode('circle',{cx:x,cy:y,r:r+4*unit,fill:'none',stroke:'#1166a7','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
  group.append(mapNode('circle',{cx:x,cy:y,r:Math.max(r,8*unit),fill:'transparent',stroke:'none'}));
  group.onclick=()=>showWorldMapTarget(point);group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showWorldMapTarget(point);}};markers.append(group);
  if(point.motion){group.setAttribute('data-motion-key',point.key);const moving={point,node:group,title,x,y,labels:[]};worldMapMovingNodes.push(moving);movingByKey.set(point.key,moving);}
  if(selected||layer==='fleets'||layer==='boss'||layer==='traffic'&&worldMapView.zoom>=2.5||layer==='cities'&&(point.capital||point.cityType===5||worldMapAllNames||worldMapView.zoom>=2.5||worldLayers.has('cityWar')&&(point.declared||point.assemble)))named.push({...point,x,y,r,priority:selected?0:layer==='fleets'?1:point.capital?2:3});
 }
 const occupied=all.filter(p=>p.layer==='cities'&&worldLayers.has('cityWar')&&(p.declared||p.fighting||p.assemble)).map(p=>({x:p.x-16*unit,y:p.y-22*unit,w:36*unit,h:25*unit}));
 for(const p of named.sort((a,b)=>a.priority-b.priority)){
  if(p.x<v.x||p.y<v.y||p.x>v.x+v.width||p.y>v.y+v.height)continue;
  const text=p.layer==='fleets'?(p.cluster?'舰队×'+p.cluster.length:p.name.replace('远征舰队 ','舰队').replace(' 队','')):p.name;
  const q=p.cityInfo,queue=q&&worldLayers.has('cityWar')&&worldMapView.zoom>=2.5&&(p.declared||p.fighting||p.key===worldMapSelected)?'攻'+(q.priorityAttack??'?')+'+'+(q.attack??'?')+' 守'+(q.priorityDefence??'?')+'+'+(q.defence??'?'):'';
  const width=t=>[...t].reduce((n,c)=>n+(c.charCodeAt(0)>255?1:.6),0);
  const w=Math.max(width(text)*11+6,width(queue)*10+6)*unit,h=(queue?29:16)*unit;
  const above=[p.x-w/2,p.y-p.r-h-3*unit],below=[p.x-w/2,p.y+p.r+3*unit];
  const choices=[...(p.declared||p.fighting||p.assemble?[below,above]:[above,below]),[p.x+p.r+4*unit,p.y-h/2],[p.x-p.r-w-4*unit,p.y-h/2]];
  const box=choices.map(([x,y])=>({x,y,w,h})).find(b=>b.x>=v.x&&b.y>=v.y&&b.x+w<=v.x+v.width&&b.y+h<=v.y+v.height&&!occupied.some(a=>b.x<a.x+a.w&&b.x+b.w>a.x&&b.y<a.y+a.h&&b.y+b.h>a.y));if(!box)continue;occupied.push(box);
  const background=mapNode('rect',{x:box.x,y:box.y,width:w,height:h,rx:2*unit,fill:'#f4fafc','fill-opacity':.9});labels.append(background);const label=mapNode('text',{x:box.x+3*unit,y:box.y+11.5*unit,'font-size':11*unit,'font-weight':p.capital||p.layer==='fleets'?600:400});label.textContent=text;labels.append(label);movingByKey.get(p.key)?.labels.push(background,label);
  if(queue){const counts=mapNode('text',{x:box.x+3*unit,y:box.y+24*unit,'font-size':10*unit,fill:'#9b4138'});counts.textContent=queue;labels.append(counts);}
 }
}
async function refreshWorldMap(){
 if(!current||snapshot.paused||disconnected.has(current)||worldMapLoading)return;const account=current,serial=++worldMapSerial;worldMapLoading=true;worldMapLastAttempt=Date.now();$('world-map-refresh').disabled=true;$('world-map-time').textContent='正在同步…';
 try{
  const data=await call('/api/world/overview');if(current!==account||serial!==worldMapSerial)return;
  const fresh=worldMapOwner!==account||worldMapData?.scenario!==data.scenario;worldMapOwner=account;worldMapData=data;worldMapReceivedAt=Date.now();worldMapJourneyNodes=[];
  if(fresh){worldMapView={x:data.width/2,y:data.height/2,zoom:1};setMapZoomInput(1);worldMapSelected=null;$('world-map-detail').hidden=true;}
  $('world-map-time').textContent='更新 '+new Date(data.checkedAt*1000).toLocaleTimeString('zh-CN');
  paintWorldFuel(data);
  const number=value=>Number.isSafeInteger(value)?String(value):'未同步';
  clear($('world-map-fleets')).append(table(['舰队','耐久','状态','征程'],data.fleets.map(f=>{const name=f.name.replace('远征舰队 ','舰队').replace(' 队',''),button=el('button','inline-link',name);button.type='button';button.setAttribute('aria-label','定位'+name);button.onclick=()=>locateOwnFleet(f);return[button,number(f.durability)+'/'+number(f.maxDura),f.state,journeyNode(f.journey)];})));
  const wars=clear($('world-map-wars'));wars.append(el('strong','','城战'));
  if(data.cityWars?.length)wars.append(table(['城市 / 状态','宣战','进攻队列','防守队列','交战 / 行军'],data.cityWars.map(w=>[w.name+' · '+w.status,w.declared.map(d=>d.attack+' → '+d.defence).join('；')||'未同步',number(w.attack)+' + 优先'+number(w.priorityAttack),number(w.defence)+' + 优先'+number(w.priorityDefence),number(w.battles)+' 点 / '+number(w.inbound)+' 队'])));
  else wars.append(el('p','dim',data.layers.cityWar==='未同步'?'宣战状态未同步':'当前没有已同步的宣战或交战城市'));
  const treasures=clear($('world-map-treasures'));treasures.append(el('strong','','货轮'));
  if(data.treasures?.length)treasures.append(table(['货轮','归属 / 进度','守军 / 已出发','正在交战'],data.treasures.map(t=>[t.name,t.owner+' · '+number(t.progress)+'%',number(t.defenders)+' / '+number(t.inbound)+' 队',t.fighters.join(' / ')||'—'])));
  else treasures.append(el('p','dim',data.layers.treasure==='未同步'?'货轮状态未同步':'当前没有已同步的货轮'));
  const layers=$('world-map-layers');
  const layerKey=JSON.stringify([worldMapOwner,data.layers,[...worldLayers],worldMapAllNames]);
  if(layers.layerKey!==layerKey||!layers.childElementCount){
  layers.layerKey=layerKey;clear(layers);
  for(const [key,name]of Object.entries(worldLayerNames)){
   const label=el('label'),check=el('input'),swatch=el('i','map-swatch');swatch.style.background=worldLayerColors[key];check.type='checkbox';check.checked=worldLayers.has(key);check.setAttribute('aria-label',name+'图层');label.title=key==='regions'?'真实城池区域与已同步归属':data.layers[key]||'未同步';check.onchange=()=>{if(check.checked)worldLayers.add(key);else worldLayers.delete(key);drawWorldMap();};label.append(check,swatch,el('span','',name+(data.layers[key]==='未同步'?'（未同步）':'')));layers.append(label);
  }
  const label=el('label'),names=el('input');names.type='checkbox';names.checked=worldMapAllNames;names.setAttribute('aria-label','全部城名');names.onchange=()=>{worldMapAllNames=names.checked;drawWorldMap();};label.append(names,el('span','','全部城名'));layers.append(label);
  }
  const legend=clear($('world-map-legend'));for(const owner of [{name:'未占领',color:'#c4d7df'},...((data.regions??[]).some(r=>r.owner===null)?[{name:'归属未同步',color:'#e1e7e8'}]:[]),...(data.owners??[])]){const item=el('span'),color=el('i','map-swatch');color.style.background=owner.color;if(owner.defaultName)item.title='当前按游戏主城默认名显示';item.append(color,el('span','',owner.name));legend.append(item);}
  paintMapStateLegend();$('world-map-notes').textContent=data.notes.join(' ');drawWorldMap();
  if(worldMapSelected){const selected=worldMapDrawnPoints.find(p=>p.key===worldMapSelected)||data.points.find(p=>p.key===worldMapSelected);if(selected)void showWorldMapTarget(selected,true);else{$('world-map-detail').hidden=true;worldMapSelected=null;}}
 }catch(error){if(current===account&&serial===worldMapSerial)$('world-map-time').textContent='未同步：'+error.message;}
 finally{if(serial===worldMapSerial){worldMapLoading=false;worldMapLastAttempt=Date.now();$('world-map-refresh').disabled=false;}}
}
function maybeRefreshWorldMap(){
 if(!worldMapAutoRefresh||document.hidden||$('tab-overview').classList.contains('hidden'))return;
 if(!current||snapshot.paused||disconnected.has(current)){if(worldMapData)resetWorldMap();return;}
 if(worldMapOwner&&worldMapOwner!==current)resetWorldMap();
 if(!worldMapLoading&&Date.now()-worldMapLastAttempt>=worldMapRefreshEvery*1000)void refreshWorldMap();
}
function updateWorldMapMotion(){
 if(!worldMapData||document.hidden||$('tab-overview').classList.contains('hidden'))return;
 if(!worldMapDrag&&!mapStale())for(const record of worldMapMovingNodes){
  const p=mapMotionPosition(record.point,mapServerNow()),transform='translate('+(p.x-record.x)+' '+(p.y-record.y)+')';record.node.setAttribute('transform',transform);for(const label of record.labels)label.setAttribute('transform',transform);record.title.textContent=record.point.name+' · '+mapJourney(record.point.motion);
 }
 worldMapJourneyNodes=worldMapJourneyNodes.filter(r=>r.node.isConnected);for(const r of worldMapJourneyNodes){const text=mapJourney(r.journey);if(r.node.textContent!==text)r.node.textContent=text;}
}
setInterval(maybeRefreshWorldMap,1000);setInterval(updateWorldMapMotion,250);
$('world-map-refresh-seconds').onchange=()=>{const input=$('world-map-refresh-seconds'),value=Number(input.value);if(!Number.isInteger(value)||value<5||value>300){input.setCustomValidity('请填写5到300之间的整数');input.reportValidity();return;}input.setCustomValidity('');worldMapRefreshEvery=value;worldMapLastAttempt=0;maybeRefreshWorldMap();};
$('world-map-auto-refresh').onclick=()=>{worldMapAutoRefresh=!worldMapAutoRefresh;const button=$('world-map-auto-refresh');button.setAttribute('aria-pressed',String(worldMapAutoRefresh));button.textContent='自动刷新：'+(worldMapAutoRefresh?'开':'关');if(worldMapAutoRefresh){worldMapLastAttempt=0;maybeRefreshWorldMap();}};
$('world-map-refresh').onclick=refreshWorldMap;$('world-map-reset').onclick=mapFullView;
$('world-map-zoom').oninput=()=>mapZoom(Number($('world-map-zoom').value));
setMapZoomInput(1);
$('world-map-home').onclick=()=>{const p=worldMapData?.points.find(p=>p.layer==='fleets')||worldMapData?.home;if(!p)return;const position=mapMotionPosition(p,mapServerNow());worldMapSelected=p.key;$('world-map-detail').hidden=true;worldMapView={x:position.x,y:position.y,zoom:4};setMapZoomInput(4);drawWorldMap();};
let worldMapTouchPan=false;
$('world-map-pan').onclick=()=>{worldMapTouchPan=!worldMapTouchPan;const button=$('world-map-pan');button.setAttribute('aria-pressed',String(worldMapTouchPan));button.textContent=worldMapTouchPan?'完成移动':'移动地图';$('world-map').classList.toggle('touch-pan',worldMapTouchPan);};
$('world-map').addEventListener('pointerdown',e=>{if(e.button!==0||!worldMapData)return;if(e.pointerType==='touch'&&!worldMapTouchPan)return;worldMapDrag={id:e.pointerId,x:e.clientX,y:e.clientY,cx:worldMapView.x,cy:worldMapView.y,view:mapViewBox(),moved:false};});
$('world-map').addEventListener('pointermove',e=>{const d=worldMapDrag;if(!d||d.id!==e.pointerId)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;if(!d.moved&&Math.hypot(dx,dy)<4)return;d.moved=true;$('world-map').setPointerCapture(e.pointerId);$('world-map').classList.add('is-dragging');worldMapView.x=d.cx-dx*d.view.width/$('world-map-scroll').clientWidth;worldMapView.y=d.cy-dy*d.view.height/$('world-map-scroll').clientHeight;applyMapView();});
const endMapDrag=e=>{if(!worldMapDrag||worldMapDrag.id!==e.pointerId)return;const moved=worldMapDrag.moved;if(moved)worldMapDraggedAt=Date.now();worldMapDrag=null;$('world-map').classList.remove('is-dragging');if($('world-map').hasPointerCapture(e.pointerId))$('world-map').releasePointerCapture(e.pointerId);if(moved)drawWorldMap();};
$('world-map').addEventListener('pointerup',endMapDrag);$('world-map').addEventListener('pointercancel',endMapDrag);
$('world-map').addEventListener('wheel',e=>{if(!e.ctrlKey||!worldMapData)return;e.preventDefault();const rect=$('world-map').getBoundingClientRect();mapZoom(worldMapView.zoom*(e.deltaY<0?1.15:1/1.15),{x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height});},{passive:false});
new ResizeObserver(()=>{if(worldMapData)drawWorldMap();}).observe($('world-map-scroll'));
