import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA_DIR } from './accounts.mjs';
import { hasReward } from './activity-actions.mjs';
import { rewardData } from './missing-rewards.mjs';

const messages = {
  GIFT_CODE_EXPIRED:'礼包码已过期', GIFT_CODE_INVALID:'礼包码无效',
  GIFT_CODE_USED:'该账号已兑换', GIFT_CODE_BATCH_USED:'已领取同批次礼包',
  GIFT_CODE_USED_BY_OTHER:'已由其他账号兑换', GIFT_CODE_EXPIRED_OR_NOT_YET:'不在兑换有效期',
  GIFT_CODE_EXCEED_LIMIT:'已达到兑换上限', GIFT_CODE_TOO_MANY_REQUESTS:'请求过于频繁'
};
const SEND_GAP_MS = 700;
const active = new Map();
// 限频范围未知，所以发送跨账号串行并保持间隔；账号各自排队，某账号忙时不会挡住其他账号。
let sendTail = Promise.resolve();
function throughSendGate(work) {
  const run = sendTail.then(work);
  sendTail = run.catch(()=>{}).then(()=>sleep(SEND_GAP_MS));
  return run;
}
function parseCodes(input) {
  if(typeof input!=='string'||input.length>12000)throw Error('请输入不超过100个礼包码');
  const codes=[...new Set(input.trim().split(/[\s,，;；]+/u).filter(Boolean))];
  if(!codes.length||codes.length>100||codes.some(c=>c.length>128))throw Error('每批1至100个不同的礼包码，每个最多128个字符');
  return codes;
}
const fileFor = id => path.join(DATA_DIR, 'gift-codes-' + encodeURIComponent(id) + '.json');
function store(id, rows) {
  fs.mkdirSync(DATA_DIR, {recursive:true});
  const file = fileFor(id), tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(rows)); fs.renameSync(tmp,file); }
  finally { fs.rmSync(tmp,{force:true}); }
}
function read(id) {
  let rows;
  try { rows=JSON.parse(fs.readFileSync(fileFor(id),'utf8')); }
  catch(error) { if(error.code==='ENOENT')return []; throw error; }
  if(!Array.isArray(rows))throw Error('兑换记录格式异常');
  // 服务被中断时，已落盘的发送意图不能被当成未兑换再发一次。
  for(const r of rows) {
    if(r.status==='sending') Object.assign(r,{status:'unknown',detail:'连接中断，未取得奖励确认'});
    if(r.status==='queued') Object.assign(r,{status:'skipped',detail:'服务已停止，尚未发送'});
  }
  return rows;
}
export function giftCodeStatus(id) {
  const job=active.get(id);
  return {running:!!job, rows:job?.rows??read(id)};
}
export function giftCodeSummary(id) {
  const {running,rows}=giftCodeStatus(id);
  const latest=rows.filter(r=>r.batch&&r.batch===rows[0].batch);
  const counts={};
  for(const r of latest)counts[r.status]=(counts[r.status]??0)+1;
  return {running,total:latest.length,counts};
}
export function startGiftCodes(id,input,dispatch,shared={stop:''}) {
  if(active.has(id))throw Error('该账号已有一批正在兑换');
  const codes=parseCodes(input);
  const history=read(id),batch=randomUUID(),time=new Date().toISOString();
  const rows=codes.map(code=>{
    const old=history.find(r=>r.code===code&&['success','unknown','used'].includes(r.status));
    return {batch, code, at:time,status:old?'skipped':'queued',detail:old?(old.status==='unknown'?'上次结果待确认，未重发':'已有兑换记录，未重发'):'等待兑换'};
  });
  const job={rows:[...rows,...history]};store(id,job.rows);active.set(id,job);
  async function run(){
    let stop='';
    for(const r of rows){
      if(r.status!=='queued')continue;
      stop||=shared.stop;
      if(stop){Object.assign(r,{status:'skipped',detail:stop});continue;}
      try {
        await dispatch((client,enabled)=>throughSendGate(async()=>{
          stop||=shared.stop;
          if(stop){Object.assign(r,{status:'skipped',detail:stop});return;}
          if(enabled?.()===false)throw Error('账号连接已变化');
          Object.assign(r,{at:new Date().toISOString(),status:'sending',detail:'等待服务器回包'});
          store(id,job.rows);
          try {
            const reply=rewardData(await client.request('GotGiftCodeRequest',{giftCode:r.code},'GotRewardResponse',8000));
            if(!hasReward(reply))throw Error('未取得可核对的奖励明细');
            const rewards=(reply.reward?.asset??[]).map(a=>a.id+' ×'+a.num);
            for(const [k,label] of Object.entries({hero:'英雄',antique:'藏品',equipIds:'装备',badge:'徽章',tickets:'券',supply:'补给'})){
              if(reply[k]?.length)rewards.push(label+' ×'+reply[k].length);
            }
            Object.assign(r,{status:'success',detail:rewards.join('、')});
          }catch(error){
            const name=client.promptNames?.[error.prompt?.prompt];
            if(error.prompt && error.request==='GotGiftCodeRequest'){
              Object.assign(r,{status:name==='GIFT_CODE_USED'?'used':'rejected',detail:messages[name]||('服务器拒绝，提示码 '+error.prompt.prompt)});
              if(name==='GIFT_CODE_TOO_MANY_REQUESTS'){stop='服务器限频，尚未发送';shared.stop='同批其他账号触发服务器限频，尚未发送';}
            }else{
              Object.assign(r,{status:'unknown',detail:'未取得可核对的奖励回包，请核对游戏内记录'});stop='前一码结果待确认，尚未发送';
            }
          }
        }));
      }catch(error){
        if(r.status==='queued')Object.assign(r,{status:'skipped',detail:'账号连接不可用（'+error.message+'），尚未发送'});
        stop='批次中断，尚未发送';
      }
      store(id,job.rows);
    }
    store(id,job.rows);
  }
  job.done=run().finally(()=>active.delete(id));
  return job;
}
// 账号连接失败或结果未知只停该账号；限频才让同批尚未发送的账号一起停手。
export function startGiftCodeBatch(targets,input) {
  parseCodes(input);
  const shared={stop:''};
  return targets.map(({id,dispatch,blocked})=>{
    try {
      if(blocked)throw Error(blocked);
      return {id,accepted:true,done:startGiftCodes(id,input,dispatch,shared).done};
    }catch(error){ return {id,accepted:false,error:error.message}; }
  });
}
