/**
 * tools/set-ad-hours.js — 批量改【已有】擦亮计划的投放时段
 *
 * 为什么需要它（2026-10-06 老板定的场景，且「之后还会有这样的场景出现」）：
 *   客服 9:00 上班、17:00 下班，其他时间不推广。
 *   方案 B（每天定时暂停/重启）要两个计划任务、漏跑就破功、且每天重启会打断投放学习期。
 *   方案 A（改投放时段）平台原生支持，设定一次永久生效 —— 这个脚本就是它的实现。
 *
 * 用法:
 *   node tools/set-ad-hours.js --hours=9-17 --plan           # 预演：列出每个计划 旧时段→新时段
 *   node tools/set-ad-hours.js --hours=9-17 --apply          # 真改（默认排除「擦亮宝贝*」主/副集合）
 *   node tools/set-ad-hours.js --hours=9-17 --apply --ids=99330190   # 只改指定计划（先试一个）
 *   node tools/set-ad-hours.js --hours=9-17 --apply --include-collection  # 连集合计划一起改（默认不含）
 *
 * 护栏：
 *   ① 默认【排除】名字以「擦亮宝贝」开头的主/副集合计划（与 pause-plans.js 同一套纪律）
 *   ② 时段合计必须 ≥4 小时（平台硬要求），否则直接拒绝
 *   ③ 改完【回读校验】，不靠平台返回值当成功
 *   ④ 读-改-写：把计划原有字段原样回放，只动 budgetScheduleDurations，避免误清别的配置
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOT, STORE, SVC } = require('../lib/env');

const KEY = SVC.apiKey;
const LOGF = path.join(ROOT, 'set-ad-hours.log');
const APPLY = process.argv.includes('--apply');
const INCLUDE_COLL = process.argv.includes('--include-collection');
const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const HOURS_ARG = argOf('hours', '9-17');
const IDS = (argOf('ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';

// '9-17' → [9,10,...,16]（表示 9:00 到 17:00；h 表示 h:00-(h+1):00）
const m = String(HOURS_ARG).match(/^(\d{1,2})-(\d{1,2})$/);
if (!m) { console.log('❌ --hours 格式应为 9-17'); process.exit(2); }
const H0 = Number(m[1]), H1 = Number(m[2]);
const NEW_HOURS = [];
for (let h = H0; h < H1; h++) NEW_HOURS.push(h);
if (NEW_HOURS.length < 4) { console.log('❌ 投放时段合计不能少于 4 小时（平台要求），当前 ' + NEW_HOURS.length + ' 小时'); process.exit(2); }

const log = (s) => { const l = '[' + new Date().toLocaleString('zh-CN') + '] ' + s; console.log(l); try { fs.appendFileSync(LOGF, l + '\n'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ev(code, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ store: STORE, code });
    const req = http.request({ host: '127.0.0.1', port: SVC.port, path: '/api/agent/eval-on-store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 300) }); } }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs || 180000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}
const unpack = (r) => { let d = r && r.result; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} } return d; };
const span = (arr) => { const a = (arr || []).map(Number).sort((x, y) => x - y); return a.length ? a[0] + '-' + (a[a.length - 1] + 1) : '(无)'; };

const READ = `(async function(){try{
var mtop=window.lib.mtop, all=[], p=1;
while(p<=5){
  var r=await mtop.request({api:'mtop.taobao.idle.ad.campaign.search',v:'1.0',type:'GET',
   data:{requestJson:JSON.stringify({pageNum:p,pageSize:100,campaignStatus:[],statusGroup:[]})}});
  if(!(r&&r.ret&&String(r.ret[0]).indexOf('SUCCESS')===0)) return JSON.stringify({err:r&&r.ret});
  var list=((r.data||{}).result)||[]; all=all.concat(list); if(list.length<100) break; p++;
}
return JSON.stringify(all.map(function(c){ var it=c.infoTab||{}; return {
  id:String(c.campaignId), title:String(c.title||''), target:c.bidTarget, pause:String(c.pauseStatus),
  cpm:String(c.cpm), budget:String(c.maxDayBudget), creative:String(c.creativeOptSwitch),
  bidType:c.bidType, promotionMode:c.promotionMode,
  hours:(it.budgetScheduleDurations||[]).map(Number),
  full:c,
  entities:(c.entityList||[]).map(function(e){ return { areaTarget:String(e.areaTarget), catId:e.catId, entityId:String(e.entityId), price:String(e.price), startTime:Number(e.publishTime)||Date.now() }; })
};}));
}catch(e){return JSON.stringify({error:e.message});}})()`;

(async () => {
  console.log('目标时段: ' + HOURS_ARG + '  →  budgetScheduleDurations = [' + NEW_HOURS.join(',') + ']  (' + NEW_HOURS.length + ' 小时)');
  console.log('模式: ' + (APPLY ? '真改' : '预演') + '   集合计划: ' + (INCLUDE_COLL ? '包含' : '排除') + (IDS.length ? '   限定 id: ' + IDS.join(',') : ''));
  console.log('');

  await ev(`(function(){location.href=${JSON.stringify(AD)};return 'n'})()`);
  await sleep(14000);
  const before = unpack(await ev(READ, 240000));
  if (!Array.isArray(before)) { console.log('❌ 读取计划失败: ' + JSON.stringify(before).slice(0, 200)); process.exit(1); }

  let targets = before;
  if (IDS.length) targets = targets.filter((c) => IDS.indexOf(c.id) >= 0);
  const coll = targets.filter((c) => /^擦亮宝贝/.test(c.title));
  if (!INCLUDE_COLL) targets = targets.filter((c) => !/^擦亮宝贝/.test(c.title));

  console.log('计划总数 ' + before.length + '，本次目标 ' + targets.length + ' 个');
  if (coll.length) console.log('  (排除主/副集合 ' + coll.length + ' 个: ' + coll.map((c) => c.title).join(', ') + ')');
  if (!targets.length) { console.log('没有目标，退出'); process.exit(0); }
  console.log('');
  console.log('ID        旧时段    新时段    状态      创意   出价   计划名');
  console.log('-'.repeat(100));
  targets.forEach((c) => console.log(
    c.id.padEnd(10) + span(c.hours).padEnd(10) + (H0 + '-' + H1).padEnd(10) +
    (c.pause === '0' ? '投放中' : '已暂停').padEnd(10) + String(c.creative).padEnd(7) + String(c.cpm).padEnd(7) + c.title));

  const need = targets.filter((c) => span(c.hours) !== (H0 + '-' + H1));
  console.log('');
  console.log('需要改的: ' + need.length + ' 个   已经是目标时段的: ' + (targets.length - need.length) + ' 个');
  if (!APPLY) { console.log('\n[预演] 没改任何东西。加 --apply 真改。'); process.exit(0); }
  if (!need.length) { log('无需改动'); process.exit(0); }

  log('=== 开始改时段：' + need.length + ' 个计划 → ' + H0 + '-' + H1 + ' ===');
  const results = [];
  for (const c of need) {
    // ★ 真实结构（2026-10-07 由老板在界面上手工改一次 + mtop 钩子抓到，不是猜的）：
    //   顶层是 { itemCampaigns: [ {...} ] }，不是 startV2 那套扁平结构。
    //   对象 = search 返回的整份计划对象 + 前端额外加的 5 个字段：
    //     bid(=cpm) / entityIds / budget(=maxDayBudget) / targetInfo / budgetScheduleDurations
    //   ⚠️ budgetScheduleDurations 在【顶层】且是【字符串数组】；infoTab 里那个是旧值（数字），别搞混。
    //   之前猜成 {campaignId, entityType, entityList, customInfo, baseInfo, targetInfo, ...} → mtop 返回 {ret:null,data:null}。
    const src = c.full || {};
    const edited = Object.assign({}, src, {
      bid: Number(c.cpm),
      entityIds: (src.entityList || []).map((e) => Number(e.entityId)),
      budget: Number(c.budget),
      targetInfo: { divisionList: [], empty: true },
      budgetScheduleDurations: NEW_HOURS.map(String),
    });
    const payload = { itemCampaigns: [edited] };
    const r = unpack(await ev(`(async function(){try{
      var r=await window.lib.mtop.request({api:'mtop.taobao.idle.ad.campaign.edit',v:'1.0',type:'POST',
        data:{requestJson: ${JSON.stringify(JSON.stringify(payload))} }});
      return JSON.stringify({ret:r&&r.ret, data:r&&r.data});
    }catch(e){return JSON.stringify({err:e.message});}})()`, 150000));
    const ret0 = String(((r && r.ret) || [])[0] || '');
    const ok = ret0.indexOf('SUCCESS') === 0;
    log('  ' + (ok ? '✅' : '❌') + ' ' + c.id + '  ' + c.title + (ok ? '' :
      '  ret=' + String(JSON.stringify((r && r.ret) || null)).slice(0, 140) + '  err=' + String((r && r.err) || '—').slice(0, 140)));
    results.push({ id: c.id, title: c.title, ok, ret: (r && r.ret) || null, err: (r && r.err) || null, raw: r ? Object.keys(r) : null });
    await sleep(2500);
  }

  // 回读校验
  await sleep(6000);
  const after = unpack(await ev(READ, 240000));
  if (!Array.isArray(after)) { log('⚠️ 回读失败，无法校验'); process.exit(1); }
  log('');
  log('=== 回读校验 ===');
  let bad = 0;
  need.forEach((c) => {
    const a = after.find((x) => x.id === c.id);
    const nowSpan = a ? span(a.hours) : '(找不到)';
    const good = nowSpan === (H0 + '-' + H1);
    if (!good) bad++;
    log('  ' + (good ? '✅' : '❌') + ' ' + c.id + '  现在时段 = ' + nowSpan + '  (期望 ' + H0 + '-' + H1 + ')');
  });
  log('');
  log(bad ? ('❌ 有 ' + bad + ' 个没改成功') : '✅ 全部按目标时段生效');
  fs.writeFileSync(path.join(ROOT, 'set-ad-hours-result.json'), JSON.stringify({ hours: HOURS_ARG, need, results, afterCheck: after.map((a) => ({ id: a.id, span: span(a.hours) })) }, null, 2), 'utf8');
})().catch((e) => require('../lib/crash').crash(e, 1));
