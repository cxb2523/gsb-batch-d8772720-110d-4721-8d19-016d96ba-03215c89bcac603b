// 按客户端错列菱形格和真实城池归属格生成示意底图，不用点位猜领地。
const cache=new WeakMap();
function simplifyBoundary(points,tolerance){
 const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]],limit=tolerance*tolerance;
 while(stack.length){const [first,last]=stack.pop(),a=points[first],b=points[last],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;let far=-1,best=limit;
  for(let i=first+1;i<last;i++){const p=points[i],t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0,d=(p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2;if(d>best){best=d;far=i;}}
  if(far>=0){keep.add(far);stack.push([first,far],[far,last]);}
 }
 return points.filter((_,i)=>keep.has(i));
}
export function mapDimensions(map){return {width:(map.width+.5)*(map.tileWidth||100)/100,height:(map.height+1)*(map.tileHeight||75)/200};}
export function mapPosition(map,grid){
 if(!map||!Number.isSafeInteger(grid)||grid<0||grid>=map.width*map.height)return null;
 const row=Math.floor(grid/map.width),col=grid%map.width;
 return {x:(col+.5+(row%2)*.5)*(map.tileWidth||100)/100,y:(row+2)*(map.tileHeight||75)/200};
}
// 位置是沿已同步起终点、按行军时间的推算，不把超时未更新当作已确认抵达。
export function mapMotionPosition(point,time){
 const m=point?.motion;
 if(!m||![m.start?.x,m.start?.y,m.end?.x,m.end?.y,m.startAt,m.endAt,time].every(Number.isFinite)||m.endAt<=m.startAt)return {x:point.x,y:point.y,estimated:false,remaining:null};
 const progress=Math.max(0,Math.min(1,(time-m.startAt)/(m.endAt-m.startAt)));
 return {x:m.start.x+(m.end.x-m.start.x)*progress,y:m.start.y+(m.end.y-m.start.y)*progress,estimated:true,progress,remaining:Math.max(0,Math.ceil(m.endAt-time)),awaitingSync:time>=m.endAt};
}
export function mapRegions(map){
 if(!map?.cityAt)return [];
 if(cache.has(map))return cache.get(map);
 const edges=new Map(),get=(x,y)=>x<0||y<0||x>=map.width||y>=map.height?0:map.cityAt(y*map.width+x);
 for(let row=0;row<map.height;row++)for(let col=0;col<map.width;col++){
  const id=get(col,row);if(!id)continue;
  const cx=2*col+1+row%2,cy=row+1,p=[[cx,cy-1],[cx+1,cy],[cx,cy+1],[cx-1,cy]],right=col+(row%2?1:0),left=right-1;
  const neighbors=[[right,row-1],[right,row+1],[left,row+1],[left,row-1]];
  for(let side=0;side<4;side++)if(get(...neighbors[side])!==id){
   const from=p[side].join(','),to=p[(side+1)%4].join(','),key=[from,to].sort().join('|');
   const edge=edges.get(key)??{key,a:from,b:to,owners:[]};edge.owners.push({id,from,to});edges.set(key,edge);
  }
 }
 // 同一对城市共用一条边界，只简化一次，再按相反方向用于两侧区域，避免裂缝与错位。
 const pairs=new Map();for(const edge of edges.values()){const key=edge.owners.map(o=>o.id).sort((a,b)=>a-b).join(':');const list=pairs.get(key)??[];list.push(edge);pairs.set(key,list);}
 const regions=new Map();
 for(const list of pairs.values()){
  const links=new Map();for(const edge of list)for(const key of [edge.a,edge.b]){const set=links.get(key)??new Set();set.add(edge);links.set(key,set);}
  const remaining=new Set(list);
  while(remaining.size){
   let first=remaining.values().next().value,start=first.a;
   // 开放链从交界端点走，闭合小岛才从任意节点走。
   for(const edge of remaining){const end=[edge.a,edge.b].find(k=>links.get(k).size!==2);if(end){first=edge;start=end;break;}}
   const points=[start],walk=[];let key=start,edge=first;
   while(edge&&remaining.has(edge)){remaining.delete(edge);walk.push(edge);key=edge.a===key?edge.b:edge.a;points.push(key);if(key===start)break;edge=[...links.get(key)].find(e=>remaining.has(e));}
   const raw=points.map(k=>k.split(',').map(Number));let outline=simplifyBoundary(raw,1.05);if(points[0]===points.at(-1)&&outline.length<4)outline=raw;
   for(const owner of first.owners){const ordered=owner.from===start?outline:[...outline].reverse();const graph=regions.get(owner.id)??new Map();for(let i=1;i<ordered.length;i++){const from=ordered[i-1].join(','),next=ordered[i];const ends=graph.get(from)??[];ends.push(next);graph.set(from,ends);}regions.set(owner.id,graph);}
  }
 }
 // 将简化后交界点的半格偏差统一到同一坐标，所有城市使用同一映射。
 // 只消除不超过一个原始格宽的抖动；原始归属格与行军坐标不变。
 const vertices=[...regions.values()].flatMap(graph=>[...graph].flatMap(([key,ends])=>[key.split(',').map(Number),...ends]));
 const align=axis=>{const values=[...new Set(vertices.map(p=>p[axis]))].sort((a,b)=>a-b),mapped=new Map();let group=[];const flush=()=>{if(!group.length)return;const center=group.reduce((a,b)=>a+b,0)/group.length;for(const value of group)mapped.set(value,center);group=[];};for(const value of values){if(group.length&&value-group[0]>2)flush();group.push(value);}flush();return mapped;};
 const aligned=map.width>=64&&map.height>=64?[align(0),align(1)]:null;
 const scaleX=(map.tileWidth||100)/200,scaleY=(map.tileHeight||75)/200,result=[];
 for(const[id,graph]of regions){const paths=[];while(graph.size){const start=graph.keys().next().value,points=[start.split(',').map(Number)];let key=start;for(let guard=0;guard<edges.size+1;guard++){const ends=graph.get(key);if(!ends?.length)break;const next=ends.pop();if(!ends.length)graph.delete(key);points.push(next);key=next.join(',');if(key===start)break;}if(points.length>=4)paths.push(points.map((p,i)=>(i?'L':'M')+((aligned?aligned[0].get(p[0]):p[0])*scaleX).toFixed(3)+','+((aligned?aligned[1].get(p[1]):p[1])*scaleY).toFixed(3)).join('')+'Z');}result.push({cityId:id,path:paths.join('')});}
 cache.set(map,result);return result;
}
