import {exactAutomationId} from './automation-policy.mjs';
import {claimOnce} from './extra-free-rewards.mjs';
import {normalize} from './worlds.mjs';
const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const day=t=>Math.floor((t+28800)/86400);
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const active=new WeakSet();
const label='联盟每日职级礼包';
export async function readGuildTitleReward(client,config,player){
 const guildId=exactAutomationId(player?.guildId),time=now(client);
 if(!guildId||BigInt(guildId)%1000n===0n)return {available:false,reason:'当前未加入联盟',checkedAt:time};
 const state=await client.request('GuildInfoRequest',{},'GuildInfoResponse');
 if(exactAutomationId(state.guild?.guildId)!==guildId)return {available:false,reason:'联盟身份已变化',checkedAt:time};
 const title=state.gotTitle,claimedAt=state.gotTitleTime;
 if(!valid(title)||!valid(claimedAt))return {available:false,reason:'可领取职级或每日领取时间未同步',checkedAt:time};
 const cfg=config?.tables?.GuildDailyRewardCfg?.data?.find(r=>r.title===title);
 if(!title||!cfg?.reward?.length)return {available:false,reason:'服务器尚未提供可领取的职级礼包',checkedAt:time,guildId,title,claimedAt};
 const already=claimedAt>0&&day(claimedAt)>=day(time);
 return {guildId,title,claimedAt,checkedAt:time,available:!already,reason:already?'今日职级礼包已领取':'今日职级礼包可领取'};
}
export async function claimGuildTitleReward(client,config,{player,enabled,ledger,report}){
 if(!enabled()||active.has(client))return;active.add(client);
 try{
  const state=await readGuildTitleReward(client,config,player),today=day(state.checkedAt);
  if(!ledger){report({label,skipped:true,status:'pending',reason:'领取记录不可用'});return;}
  for(const[key,record]of Object.entries(ledger.keyRecords())){
   if(!key.startsWith('guild-title:')||record.confirmed||record.details?.guildId!==state.guildId)continue;
   if(state.claimedAt>0&&day(state.claimedAt)===record.details.day&&state.claimedAt>record.details.beforeTime)ledger.resolveKey(key,true);
   else{report({label,skipped:true,status:'pending',reason:'前次职级礼包结果待确认，未重复领取'});return;}
  }
  if(!state.available){report({label,skipped:true,reason:state.reason});return;}
  const fresh=await readGuildTitleReward(client,config,player);
  if(!enabled()||day(now(client))!==today||!fresh.available||fresh.guildId!==state.guildId||fresh.title!==state.title){report({label,skipped:true,reason:'领取前职级、联盟或当日状态变化，等待重新检查'});return;}
  await claimOnce(client,{ledger,key:'guild-title:'+state.guildId+':'+today,title:label,request:'GotGuildTitleRewardRequest',enabled:()=>enabled()&&day(now(client))===today,report,
   details:{guildId:state.guildId,day:today,title:state.title,beforeTime:fresh.claimedAt},
   verify:async reply=>{if(!normalize(reply?.reward)?.asset?.some(a=>Number.isSafeInteger(a.num)&&a.num>0))return false;const after=await readGuildTitleReward(client,config,player);return after.guildId===state.guildId&&after.claimedAt>fresh.claimedAt&&day(after.claimedAt)===today;}});
 }finally{active.delete(client);}
}
