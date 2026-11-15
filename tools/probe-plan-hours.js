// 只读：逐条打印计划的 暂停态 / 时段原始数组 / 状态文案 / 今日花费
const http = require('http');
const { STORE, SVC } = require('../lib/env');
const code = `
(async function(){
  try{
    var mtop=window.lib.mtop;
    var r=await mtop.request({api:'mtop.taobao.idle.ad.campaign.search',v:'1.0',type:'GET',
      data:{requestJson:JSON.stringify({pageNum:1,pageSize:100,campaignStatus:[],statusGroup:[]})}});
    if(!(r&&r.ret&&String(r.ret[0]).indexOf('SUCCESS')===0)) return JSON.stringify({err:r&&r.ret});
    var all=((r.data||{}).result)||[];
    return JSON.stringify(all.map(function(c){
      var it=c.infoTab||{}, d=c.adDataDetailVO||{};
      return { id:String(c.campaignId), name:String(c.title||'').slice(0,30),
        pause:String(c.pauseStatus), group:String(c.statusGroup), desc:String(c.statusDescTitle),
        cpm:String(c.cpm), budget:Number(c.maxDayBudget||0)/100,
        items:((c.entityList)||[]).map(function(e){ return String(e.entityId); }),
        durations:(it.budgetScheduleDurations||[]),
        windows:(it.budgetScheduleDurationList||[]),
        todayCost:Number(d.cost||0)/100, shows:String(d.showPv||'0'), chats:String(d.chatPv||'0') };
    }));
  }catch(e){return JSON.stringify({error:e.message});}
})()
`;
const payload = JSON.stringify({ store: STORE, code });
const req = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': SVC.apiKey }, timeout: 180000 },
  (res) => { let b=''; res.on('data',(c)=>b+=c); res.on('end',()=>{
    let j; try { j=JSON.parse(b); } catch(e){ console.log('RAW',b.slice(0,400)); return; }
    let d=j.result; if(typeof d==='string'){ try{d=JSON.parse(d);}catch(e){} }
    if(!Array.isArray(d)){ console.log('❌ '+JSON.stringify(d||j).slice(0,300)); return; }
    d.forEach(c=>{
      console.log('---');
      console.log(c.id+'  '+(c.pause==='0'?'投放中':'已暂停')+'  '+c.desc+'  '+c.name);
      console.log('  出价分='+c.cpm+'  日预算=¥'+c.budget+'  今日花费=¥'+c.todayCost+'  曝光='+c.shows+'  咨询='+c.chats);
      console.log('  绑定商品='+JSON.stringify(c.items));
      console.log('  时段小时='+JSON.stringify(c.durations));
      console.log('  时段窗口='+JSON.stringify(c.windows));
    });
  }); });
req.on('timeout',()=>{console.log('TIMEOUT');req.destroy();});
req.on('error',(e)=>console.log('ERR',e.message));
req.write(payload); req.end();
