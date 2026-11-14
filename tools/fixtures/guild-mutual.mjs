// 虚构联盟互助；实际协议编解码，默认只持有一个橡胶圈。
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../../src/proto.mjs';
import { exactAutomationId } from '../../src/automation-policy.mjs';
const protocol=loadProtocol(),table=data=>({data});
export function guildMutualFixture(shared=null) {
  const now=Math.floor(Date.now()/1000),player={playerId:'9007199254740993',guildId:'9007199254741001',worldId:'2002001',level:37,nickname:'互助验证者'};
  const friend='9007199254740995',other='9007199254740997';
  const state=shared??{stock:{橡胶圈:1,木材:20},peerStock:0,askUsed:0,own:[],requests:Array.from({length:20},(_,i)=>({reqId:String(9007199254750000n+BigInt(i)),reqItemId:'橡胶圈',asker:{playerId:friend,nickname:'同名盟友'},askTime:now-30+i,endTime:now+3600})),
    members:[{playerId:player.playerId,nickname:player.nickname},{playerId:friend,nickname:'同名盟友'},{playerId:other,nickname:'同名盟友'}],black:[],serverGuildId:player.guildId,autoReturn:false,writes:[],reads:[],onRead:null,onGift:null,failure:'',peak:1,serial:0};
  const config={materialName:id=>id,tables:{ModuleOpenCfg:table([{moduleId:'联盟',playerLevel:16}]),GuildHelpCfg:table([{id:'橡胶圈',season:1},{id:'木材',season:1}]),GuildParamCfg:table([{paramName:'每日求助次数上限',paramValue:20}])}};
  const client=new EventEmitter();client.connected=true;client.serverClockOffsetMs=0;client.stop=()=>{client.connected=false;};client.snapshot=()=>({state:'READY',connected:client.connected});
  const reward={reward:{asset:[{type:1,id:'联盟币',num:1}]}};
  const reject=(name,message)=>Object.assign(new Error(message),{prompt:{prompt:1},request:name});
  const encode=(name,value)=>protocol[name].decode(protocol[name].encode(value).finish());
  function peerReturn(){const pending=state.own.find(r=>r.reqItemId==='橡胶圈'&&!r.helper&&r.endTime>now);if(pending&&state.peerStock>0){state.peerStock--;pending.helper={playerId:friend,nickname:'同名盟友'};return true;}return false;}
  client.request=async(name,body={},response=name.replace(/Request$/,'Response'))=>{
    if(protocol[name])encode(name,body);state.reads.push(name);await state.onRead?.(name,body);
    let value;
    if(name==='GuildInfoRequest')value={guild:{guildId:state.serverGuildId,name:'互助验证联盟',level:7,memberCount:state.members.length,welfarePack:[],gotWelfareTime:0},myTitle:2};
    else if(name==='GuildMemberRequest')value={total:state.members.length,titleList:[{guildTitle:2,members:state.members},{guildTitle:1,members:state.black}]};
    else if(name==='GuildAidListRequest')value={askItems:state.requests.map(row=>({...row,asker:{avatar:{},...row.asker}})),lastReadAskTime:0};
    else if(name==='AllItemRequest')value={items:Object.entries(state.stock).map(([itemId,num])=>({itemId,num}))};
    else if(name==='MyGuildAidRequest')value={aids:state.own.map(row=>({...row,...(row.helper?{helper:{avatar:{},...row.helper}}:{})}))};
    else if(name==='CounterInfoRequest')value={counters:[{type:'DAILY_GUILD_AID',num:state.askUsed,updateTime:now}]};
    else if(name==='GuildAidHelpRequest'){
      const wire=encode(name,body);if(wire.type!==0||wire.reqId.length!==1)throw new Error('必须每次只赠送一条联盟求助');
      const id=exactAutomationId(wire.reqId[0]),row=state.requests.find(r=>r.reqId===id);state.writes.push({name,id,item:row?.reqItemId});await state.onGift?.(id);
      if(state.failure==='giftReject')throw reject(name,'求助已被其他盟友处理');
      if(!row||!(state.stock[row.reqItemId]>=1))throw reject(name,'求助已结束或库存不足');
      state.stock[row.reqItemId]--;state.requests=state.requests.filter(r=>r.reqId!==id);
      if(row.reqItemId==='橡胶圈'){state.peerStock++;if(state.autoReturn)peerReturn();}
      if(state.failure==='giftUnknown')throw new Error('模拟赠送回包丢失');value=state.failure==='giftEmpty'?{}:reward;
    }else throw new Error('夹具禁止未声明请求：'+name);
    return encode(response,value);
  };
  client.sendWatch=async(name,body)=>{
    encode(name,body);state.writes.push({name,body:structuredClone(body)});
    if(name==='GuildAidAskRequest'){
      if(state.failure==='askReject'||state.askUsed>=20)throw reject(name,'今日求助次数已用完');
      if(state.failure==='askUnknown')throw new Error('模拟发布结果未知');
      state.askUsed++;state.own.push({reqId:String(9007199254770000n+BigInt(++state.serial)),reqItemId:body.reqItemId,endTime:now+86400});
      if(state.failure==='askAcceptedUnknown')throw new Error('模拟已发布但回包未知');
    }else if(name==='GotMyGuildAidRequest'){
      if(state.failure==='claimUnknown')throw new Error('模拟领取结果未知');
      for(const row of state.own.filter(r=>r.helper))state.stock[row.reqItemId]=(state.stock[row.reqItemId]??0)+1;
      state.own=state.own.filter(r=>!r.helper);state.peak=Math.max(state.peak,state.stock.橡胶圈??0);
    }else throw new Error('夹具禁止未声明写入：'+name);
  };
  return {client,protocol,config,player,state,friend,other,peerReturn};
}
