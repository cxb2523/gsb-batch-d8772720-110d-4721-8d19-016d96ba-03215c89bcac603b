// 活动排行榜只读查询；请求白名单不包含领奖、挑战或购买。
import {rewardData} from './missing-rewards.mjs';
import {exactAutomationId,automationWireId} from './automation-policy.mjs';
const now=client=>Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000);
export function openRankWindows(client){
 const windows=client.openRankActivity?.activityTime;
 return Array.isArray(windows)?windows.filter(row=>Number.isSafeInteger(row.type)&&row.startTime<=now(client)&&now(client)<row.endTime):[];
}
const definitions=[
 {key:'pirate',label:'剿匪榜',module:'冲榜活动',kind:'open',type:3,scoreLabel:'积分'},
 {key:'war',label:'杀敌榜',module:'冲榜活动',kind:'open',type:4,scoreLabel:'积分'},
 {key:'orders',label:'订单榜',module:'冲榜活动',kind:'open',type:1,scoreLabel:'积分'},
 {key:'stages',label:'闯关榜',module:'冲榜活动',kind:'open',type:2,scoreLabel:'关卡'},
 {key:'week-cross',label:'周活动比拼',module:'周活动',kind:'cross',scoreLabel:'积分'},
 {key:'world-boss',label:'世界Boss个人榜',module:'世界',kind:'boss',scoreLabel:'伤害'},
 {key:'league',label:'积分赛',module:'跨服积分赛',kind:'league',scoreLabel:'积分'},
];
export function activityRankCatalog(client,config,player){
 const unlocked=module=>{const level=config?.tables?.ModuleOpenCfg?.data?.find(r=>r.moduleId===module)?.playerLevel;return Number.isSafeInteger(level)&&player?.level>=level;};
 const active=new Set(openRankWindows(client).map(row=>row.type));
 const result=definitions.filter(d=>unlocked(d.module)&&(d.kind!=='open'||active.has(d.type))).map(d=>({...d}));
 for(const event of client.festivals??[]){
  const id=exactAutomationId(event.activityId);if(!id||!(event.startTime<=now(client)&&now(client)<event.endTime))continue;
  for(const [subType,type,label]of [[27,6,'走江踏浪榜'],[28,7,'龙王罗盘榜']]){
   const sub=event.subActivity?.find(s=>s.subActivityType===subType);if(!sub||(sub.openTime&&now(client)<sub.openTime)||(sub.closeTime&&now(client)>=sub.closeTime))continue;
   result.push({key:'activity:'+id+':'+type,label:(event.type?event.type.replace(/活动$/,'')+' · ':'')+label,kind:'festival',activityId:id,type,scoreLabel:'积分'});
  }
 }
 return result;
}
export async function readActivityRanking(client,config,player,key,page=1){
 if(!Number.isSafeInteger(page)||page<1||page>200)throw Error('排行榜页码无效');
 const tab=activityRankCatalog(client,config,player).find(t=>t.key===key);if(!tab)throw Error('该排行榜当前未开放或暂不支持');
 const ask=(name,body={})=>client.request(name+'Request',body,name+'Response').then(rewardData);
 const output={key,label:tab.label,scoreLabel:tab.scoreLabel,page,totalPages:1,rows:[],mine:null,reason:'',checkedAt:now(client)};
 let list,mine,scoreKey;
 if(tab.kind==='open'){
  // 当前客户端只显示Info返回的首屏。真实服务器未响应独立分页请求，不提供不可用的翻页。
  if(page!==1)throw Error('冲榜暂只支持首屏及本人名次');
  const state=await ask('OpenRankInfo',{type:tab.type});
  if(!Number.isSafeInteger(state.endTime)||state.endTime<=now(client))return {...output,reason:'当前冲榜活动未开放或已结束'};
  const board=state.leaderBoard;
  if(!board)throw Error('服务器未返回排行榜');list=board.item;mine=board.myItem;scoreKey='value';output.endTime=state.endTime;
  if(board.totalPage>1)output.reason='仅展示当前返回的前 '+(board.item?.length??0)+' 名及本人名次；后续分页暂不可用。';
 }else if(tab.kind==='boss'){
  const info=(await ask('WorldBossInfo')).info;if(!info?.bossId)return {...output,reason:'当前没有开放的世界Boss'};
  if(page!==1)throw Error('世界Boss榜单没有分页');
  const state=await ask('WorldBossPlayerRank');list=state.rankList;mine=state.myRank;scoreKey='damage';
 }else if(tab.kind==='league'){
  const state=await ask('LeagueRank',{page});list=state.items;scoreKey='score';output.totalPages=Math.max(1,state.maxPage||1);
 }else if(tab.kind==='cross'){
  if(page!==1)throw Error('周活动比拼榜单没有分页');
  const state=await ask('CrossRankInfo');if(state.grouping)return {...output,reason:'活动正在分组，榜单尚未就绪'};
  list=state.rankList;scoreKey='score';output.endTime=state.settleTime;
 }else{
  const state=await ask('ActivityRank',{activityId:automationWireId(tab.activityId),type:tab.type,page});list=state.item;mine=state.myItem;scoreKey='score';output.totalPages=Math.max(1,state.totalPage||1);
 }
 if(!Array.isArray(list))throw Error('排行榜列表未完整返回');
 const own=exactAutomationId(player.playerId),row=item=>({rank:Number.isSafeInteger(item.rank)?item.rank:null,name:item.nickname||'未返回名称',playerId:exactAutomationId(item.playerId),score:Number.isSafeInteger(item[scoreKey])?item[scoreKey]:null,power:Number.isSafeInteger(item.power)?item.power:null,own:!!own&&exactAutomationId(item.playerId)===own});
 output.rows=list.map(row);output.mine=mine?row(mine):output.rows.find(r=>r.own)??null;
 if(!output.rows.length)output.reason='当前榜单暂无玩家记录';
 return output;
}
