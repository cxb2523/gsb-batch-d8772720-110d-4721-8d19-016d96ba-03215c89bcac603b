// 只读：列出所有擦亮计划的 状态 / 竞价目标 / 时段 / 创意优化 / 日预算
const http = require('http');
const { STORE, SVC } = require('../lib/env');
const KEY = SVC.apiKey;
const code = `
(async function(){
  try{
    var mtop=window.lib.mtop, all=[], p=1;
    while(p<=5){
      var r=await mtop.request({api:'mtop.taobao.idle.ad.campaign.search',v:'1.0',type:'GET',
        data:{requestJson:JSON.stringify({pageNum:p,pageSize:100,campaignStatus:[],statusGroup:[]})}});
      if(!(r&&r.ret&&String(r.ret[0]).indexOf('SUCCESS')===0)) return JSON.stringify({err:r&&r.ret});
      var list=((r.data||{}).result)||[]; all=all.concat(list);
      if(list.length<100) break; p++;
    }
    var TGT={chat:'咨询量',order:'订单量'};
    return JSON.stringify(all.map(function(c){
      var it=c.infoTab||{};
      var dur=(it.budgetScheduleDurationList||[]);
      return { id:String(c.campaignId), name:String(c.title||'').slice(0,32),
        target:TGT[c.bidTarget]||c.bidTarget, pause:String(c.pauseStatus||''),
        creative:String(c.creativeOptSwitch), cpm:String(c.cpm),
        budgetYuan:(Number(c.maxDayBudget||0)/100).toFixed(0),
        hours:(it.budgetScheduleDurations||[]).length,
        时段: dur.length? dur[0]+'~'+dur[dur.length-1] : (it.budgetScheduleDurations||[]).join(','),
        花费:(Number((c.adDataDetailVO||{}).cost||0)/100).toFixed(2),
        咨询:((c.adDataDetailVO||{}).chatPv)||'0' };
    }));
  }catch(e){return JSON.stringify({error:e.message});}
})()
`;
const payload = JSON.stringify({ store: STORE, code });
const req = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY }, timeout: 180000 },
  (res) => { let b=''; res.on('data',(c)=>b+=c); res.on('end',()=>{
    let j; try { j=JSON.parse(b); } catch(e){ console.log('RAW',b.slice(0,400)); return; }
    let d=j.result; if(typeof d==='string'){ try{d=JSON.parse(d);}catch(e){} }
    if(!Array.isArray(d)){ console.log('❌ '+JSON.stringify(d||j).slice(0,300)); return; }
    const P={ '0':'投放中', '1':'已暂停', '2':'已结束', '6':'已结束?' };
    console.log('计划总数: '+d.length);
    console.log('');
    console.log('ID        状态      目标    创意   出价分 预算  时段            花费    咨询  计划名');
    console.log('-'.repeat(118));
    d.forEach(c=>console.log(
      c.id.padEnd(10)+ (P[c.pause]||('状态'+c.pause)).padEnd(9) + String(c.target).padEnd(7) +
      String(c.creative).padEnd(7) + String(c.cpm).padEnd(7) + ('¥'+c.budgetYuan).padEnd(6) +
      String(c.时段).padEnd(16) + ('¥'+c.花费).padEnd(8) + String(c.咨询).padEnd(6) + c.name));
    const running=d.filter(c=>c.pause==='0').length, paused=d.filter(c=>c.pause==='1').length;
    console.log('');
    console.log('投放中 '+running+' 个 / 已暂停 '+paused+' 个 / 其他 '+(d.length-running-paused)+' 个');
    const hours={}; d.forEach(c=>{hours[c.hours]=(hours[c.hours]||0)+1;});
    // 【2026-10-09 修·口径错误】原来这里写「16=8:00-23:00」—— 反了，而且正是这句话
    //   把我带偏过：budgetScheduleDurations 的元素是【整点格】，h 表示 h:00-(h+1):00，
    //   所以 8:00-23:00 是 [8..22] 共【15】格；[8..23] 共 16 格是 8:00-24:00。
    //   权威依据是平台自己渲染的那一列：ad-hours-live.js 实测 9 条 15 格的计划，
    //   平台「投放时段」列全部显示「部分时段 8:00-23:00」。
    console.log('时段小时数分布: '+JSON.stringify(hours)+'  (24=全天/默认, 15=8:00-23:00, 16=8:00-24:00)');
  }); });
req.on('timeout',()=>{console.log('TIMEOUT');req.destroy();});
req.on('error',(e)=>console.log('ERR',e.message));
req.write(payload); req.end();
