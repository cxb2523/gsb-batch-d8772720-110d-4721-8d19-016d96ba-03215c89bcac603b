/**
 * tools/ab-creative.js — 「创意优化」开关 A/B（开 vs 关）
 *
 * 老板口径（2026-10-06）：
 *   以「同城市同明星的相似链接」随机对半分，控制商品差异。
 *
 * 为什么这样配对：
 *   创意优化是【计划级】开关（extraFunctions.creativeOptSwitch），
 *   同一商品开两个计划能拿到最干净的对照，但两个计划会【互相抢曝光】→ 自我竞争污染结果。
 *   所以改成：同一「城市+明星」下的相似链接，随机一半进「开」、一半进「关」，
 *   每条链接只开【1 个】计划 → 零自我竞争，商品差异靠随机化平衡。
 *
 * ⚠️ 分配只算一次并写盘（ab-creative-plan.json），--apply 读同一个文件。
 *    否则每次跑随机数不同，「你确认的方案」和「实际建的」就对不上。
 *
 * 用法:
 *   node tools/ab-creative.js --plan        # 算分配 + 打印，写 ab-creative-plan.json（不建计划）
 *   node tools/ab-creative.js --apply       # 读该文件，真建计划 + 回读验证
 *   node tools/ab-creative.js --plan --date=2026-10-06 --rate=120 --budget=50
 *
 * 【2026-10-07 改】分两批建的，所以 --apply 必须幂等：
 *   第一批（00:29）只建了 1 对试水，第二批补其余 6 个时要读【同一份】8 条方案
 *   （ab-creative-plan-full.json），靠「已建跳过」自动只建缺的。
 *   `--plan-file=`  指定方案文件，默认 ab-creative-plan.json
 *   `--hours=`      建计划时就带上时段（默认 9-17；本机现行口径是 8-23，务必显式传）
 *   已有计划读不到时**直接退出**，不赌 —— 建重复计划的代价比报错大得多。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOT, STORE, SVC } = require('../lib/env');

const KEY = SVC.apiKey;
const LEDGER = path.join(ROOT, '上架台账.json');
const LOGF = path.join(ROOT, 'ab-creative.log');
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';

const APPLY = process.argv.includes('--apply');
const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
/** A/B 计划名统一格式：¥{出价}·创意{开|关}·{城市}{明星}。已建跳过/回读校验都认这个正则。 */
const AB_TITLE = /创意(开|关)·/;
const PLANF = path.resolve(ROOT, argOf('plan-file', 'ab-creative-plan.json'));
const DATE = argOf('date', new Date().toISOString().slice(0, 10));
const RATE = (Number(argOf('rate', 120)) || 120) / 100;
const BUDGET = Number(argOf('budget', 50)) || 50;
const CAP_CENT = 400;              // 永久硬上限 ¥4.00
// 【2026-10-07 改】时段可配，默认 9-17。
// 老板点醒：建计划时本来就会设时段（startV2 的 customInfo.budgetScheduleDurations，已验证可用），
// 所以「按客服时间投放」根本不需要 campaign.edit —— 建的时候带上就行，绕开那个猜不对的改接口。
// 客服 9:00 上班 / 17:00 下班 → 默认 [9..16]（8 小时；平台要求合计 ≥4 小时）。
const HOURS_ARG = argOf('hours', '9-17');
const HOURS = (() => {
  const mm = String(HOURS_ARG).match(/^(\d{1,2})-(\d{1,2})$/);
  const a = [];
  if (mm) for (let h = Number(mm[1]); h < Number(mm[2]); h++) a.push(h);
  return a.length >= 4 ? a : [9, 10, 11, 12, 13, 14, 15, 16];
})();
const CAT_DEFAULT = 201456914;     // 代购

const log = (m) => { const l = '[' + new Date().toLocaleString('zh-CN') + '] ' + m; console.log(l); try { fs.appendFileSync(LOGF, l + '\n'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yuan = (c) => (Number(c) / 100).toFixed(2);

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

// ───────────────────────── --plan ─────────────────────────
if (!APPLY) {
  const led = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const today = led.filter((r) => String(r.时间).slice(0, 10) === DATE && r.itemId && r.ok);
  if (!today.length) { console.log('❌ 台账里没有 ' + DATE + ' 的成功记录'); process.exit(1); }

  // 按「城市+明星」分组（同城市同明星的相似链接）
  const groups = {};
  today.forEach((r) => {
    const k = r.city + '|' + r.star;
    (groups[k] = groups[k] || []).push(r);
  });

  const assign = [];
  Object.keys(groups).forEach((k) => {
    const arr = groups[k].slice();
    // 洗牌后对半分：前半「开」，后半「关」
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    const half = Math.ceil(arr.length / 2);
    arr.forEach((r, i) => {
      assign.push({
        arm: i < half ? 'on' : 'off',
        city: r.city, star: r.star, session: r.session, itemId: String(r.itemId),
        title: r.标题, 主图模板: r.主图模板, 文案模板id: r.文案模板id, area: (r.定位 || '').split('/')[2] || '',
      });
    });
  });

  const on = assign.filter((a) => a.arm === 'on');
  const off = assign.filter((a) => a.arm === 'off');
  console.log('日期 ' + DATE + '   找到 ' + today.length + ' 条链接   ' + Object.keys(groups).length + ' 个「城市+明星」组');
  console.log('口径：出价 = 系统建议价 × ' + (RATE * 100) + '%   预算 ¥' + BUDGET + '   硬上限 ¥' + (CAP_CENT / 100));
  console.log('');
  console.log('臂      城市明星          轮次      区      主图          标题模板  itemId');
  console.log('-'.repeat(112));
  assign.forEach((a) => {
    console.log((a.arm === 'on' ? '创意优化开' : '创意优化关').padEnd(8) +
      (a.city + a.star).padEnd(18) + String(a.session).padEnd(10) +
      String(a.area).padEnd(8) + String(a.主图模板).padEnd(14) + String(a.文案模板id).padEnd(10) + a.itemId);
  });
  console.log('');
  console.log('分臂结果: 开 ' + on.length + ' 条 / 关 ' + off.length + ' 条 ' +
    (Math.abs(on.length - off.length) <= 1 ? '✅ 均衡' : '⚠️ 不均衡'));
  const cities = {};
  assign.forEach((a) => { const k = a.city + a.star + '|' + a.arm; cities[k] = (cities[k] || 0) + 1; });
  console.log('每组的臂分布: ' + JSON.stringify(cities));

  fs.writeFileSync(PLANF, JSON.stringify({
    日期: DATE, 出价倍率: RATE, 预算: BUDGET, 硬上限分: CAP_CENT,
    生成时刻: new Date().toISOString(), assign,
  }, null, 2), 'utf8');
  console.log('\n✅ 分配已写 ' + PLANF + '   （--apply 会读这个文件，保证方案=执行）');
  process.exit(0);
}

// ───────────────────────── --apply ─────────────────────────
(async () => {
  const plan = JSON.parse(fs.readFileSync(PLANF, 'utf8'));
  const assign = plan.assign;
  log('=== 开始建「创意优化」A/B 计划：共 ' + assign.length + ' 个 ===');
  log('方案来自 ' + PLANF + '（生成于 ' + plan.生成时刻 + '）');

  // 先进广告后台
  await ev(`(function(){ location.href=${JSON.stringify(AD)}; return 'nav'; })()`);
  await sleep(14000);
  const up = await ev(`(function(){ return JSON.stringify({href:location.href, hasMtop:!!(window.lib&&window.lib.mtop)}); })()`);
  const u = unpack(up);
  log('页面: ' + (u && u.href) + '   mtop: ' + (u && u.hasMtop));
  if (!u || !u.hasMtop) { log('❌ 页面没就绪'); process.exit(1); }

  // ── 🛡 已建跳过（幂等）──
  // 本实验分两批建（先 1 对试水 → 再补其余 6 个），第二批读【同一份】8 条方案。
  // 不按 itemId 跳过的话，重跑会给同一商品建出第二个计划 —— 两个计划互相抢曝光，
  // 自我竞争把 A/B 结果搅浑，这正是本脚本开头要避免的事。
  const existRaw = await ev(`(async function(){ try{
    var out=[], p=1;
    while(p<=5){
      var r=await window.lib.mtop.request({api:'mtop.taobao.idle.ad.campaign.search',v:'1.0',type:'GET',
        data:{requestJson:JSON.stringify({pageNum:p,pageSize:100,campaignStatus:[],statusGroup:[]})}});
      if(!(r&&r.ret&&String(r.ret[0]).indexOf('SUCCESS')===0)) return JSON.stringify({err:r&&r.ret});
      var list=((r.data||{}).result)||[]; out=out.concat(list); if(list.length<100) break; p++;
    }
    return JSON.stringify(out.map(function(c){ return { id:String(c.campaignId), title:String(c.title||''),
      items:((c.entityList)||[]).map(function(e){ return String(e.entityId); }) }; }));
  }catch(e){ return JSON.stringify({err:e.message}); } })()`);
  const exist = unpack(existRaw);
  if (!Array.isArray(exist)) {
    log('❌ 读已有计划失败，无法保证不重复建 —— 已中止：' + JSON.stringify(exist).slice(0, 160));
    process.exit(1);
  }
  const covered = {};
  exist.filter((c) => AB_TITLE.test(c.title)).forEach((c) => c.items.forEach((id) => { covered[id] = c.title; }));
  log('已有「创意开/关」计划 ' + Object.keys(covered).length + ' 条链接被覆盖：' + JSON.stringify(covered));

  const results = [];
  let skipped = 0;
  for (const a of assign) {
    if (covered[a.itemId]) {
      skipped++;
      log('');
      log('──── ' + a.itemId + '  ' + a.city + a.star + '  ' + a.session + '  ⏭ 已有计划「' + covered[a.itemId] + '」，跳过（避免自我竞争）');
      continue;
    }
    const entities = [{ entityId: Number(a.itemId), catId: CAT_DEFAULT, price: 5000, areaTarget: false, startTime: Date.now() }];
    log('');
    log('──── ' + a.itemId + '  ' + a.city + a.star + '  ' + a.session + '  臂=' + (a.arm === 'on' ? '创意优化开' : '创意优化关'));

    // ① 问建议价
    const sg = await ev(`(async function(){
      try{
        var r = await window.lib.mtop.request({ api:'mtop.taobao.idle.ad.customize.bid.estimates', v:'1.0', type:'POST',
          data:{ requestJson: JSON.stringify({ entityType:1, entityList:${JSON.stringify(entities)}, bidTarget:'chat', bidPrice:100, noBid:false, pcFirstRequest:false }) } });
        var row = (((r.data||{}).customizeBidRecommendVOList)||[])[0] || {};
        return JSON.stringify({ ret:r&&r.ret, bidPrice:row.bidPrice, minBid:row.minBid, maxBid:row.maxBid });
      }catch(e){ return JSON.stringify({err:e.message}); }
    })()`);
    const s = unpack(sg);
    if (!s || s.err || !s.bidPrice) { log('   ❌ 取建议价失败: ' + JSON.stringify(s)); results.push({ ...a, ok: false, err: 'suggest' }); continue; }
    const bid = Math.round(Number(s.bidPrice) * RATE);
    const over = bid > CAP_CENT;
    log('   建议价 ¥' + yuan(s.bidPrice) + ' → ×' + (RATE * 100) + '% = ¥' + yuan(bid) + (over ? '  ❌ 超 ¥4 上限，不建' : '  ✅'));
    if (over) { results.push({ ...a, ok: false, err: 'over-cap', bid }); continue; }

    // ② 建计划
    const title = '¥' + yuan(bid) + '·创意' + (a.arm === 'on' ? '开' : '关') + '·' + a.city + a.star;
    const payload = {
      entityType: 1, fromScene: 'pc_campaign-manage', oldMember: true,
      entityList: entities,
      customInfo: { bidPrice: bid, maxDayBudget: Math.round(BUDGET * 100), budgetScheduleDurations: HOURS },
      baseInfo: { productId: 1, promotionMode: 'custom', bidType: 'smart_bid', bidTarget: 'chat', title },
      targetInfo: { divisionList: [] },
      clueInfo: { chatButton: true, bookButton: false, bookText: '' },
      extraFunctions: { creativeOptSwitch: a.arm === 'on' },     // ← 本实验的唯一变量
    };
    const cr = await ev(`(async function(){
      try{
        var r = await window.lib.mtop.request({ api:'mtop.taobao.idle.ad.campaign.startV2', v:'1.0', type:'POST',
          data:{ requestJson: ${JSON.stringify(JSON.stringify(payload))} } });
        return JSON.stringify({ ret:r&&r.ret, data:r&&r.data });
      }catch(e){ return JSON.stringify({err:e.message}); }
    })()`, 150000);
    const c = unpack(cr);
    const ret0 = String(((c && c.ret) || [])[0] || '');
    const okCreate = ret0.indexOf('SUCCESS') === 0;
    log('   建计划「' + title + '」→ ' + (okCreate ? '✅' : '❌ ret=' + JSON.stringify(c && c.ret).slice(0, 90)));
    results.push({ ...a, ok: okCreate, bid, title, 建议价: Number(s.bidPrice), ret: (c && c.ret) || null });
    await sleep(3000);
  }

  // ③ 回读验证：creativeOptSwitch 是不是我们要的值 + 时段是不是建的时候就带上了
  log('');
  log('=== 回读验证（关键：如果 API 忽略 creativeOptSwitch=false，这个实验就无效）===');
  const vr = await ev(`(async function(){
    try{
      var out=[]; for (var p=1;p<=5;p++){
        var r = await window.lib.mtop.request({ api:'mtop.taobao.idle.ad.campaign.search', v:'1.0', type:'GET',
          data:{ requestJson: JSON.stringify({ pageNum:p, pageSize:100, campaignStatus:[], statusGroup:[] }) } });
        if(!(r&&r.ret&&String(r.ret[0]).indexOf('SUCCESS')===0)) return JSON.stringify({err:r&&r.ret});
        var list=((r.data||{}).result)||[]; out=out.concat(list); if(list.length<100) break;
      }
      return JSON.stringify(out.map(function(c){ var it=c.infoTab||{}; return { id:String(c.campaignId), title:String(c.title||''),
        creative:String(c.creativeOptSwitch), bidTarget:c.bidTarget, cpm:c.cpm, budget:String(c.maxDayBudget),
        status:String(c.pauseStatus), hours:(it.budgetScheduleDurations||[]).map(Number),
        items:((c.entityList)||[]).map(function(e){ return String(e.entityId); }) }; }));
    }catch(e){ return JSON.stringify({err:e.message}); }
  })()`);
  const wantHours = JSON.stringify(HOURS);
  const v = unpack(vr);
  if (Array.isArray(v)) {
    const mine = v.filter((c) => AB_TITLE.test(c.title));
    console.log('  ' + (skipped ? '本轮跳过 ' + skipped + ' 条（已建）' : '本轮无跳过') +
      '；全店现有本实验计划 ' + mine.length + ' 个：');
    mine.forEach((c) => {
      const want = /创意开/.test(c.title) ? 'true' : 'false';
      const hOk = JSON.stringify(c.hours) === wantHours;
      console.log('    ' + (c.creative === want ? '✅' : '❌') + ' ' + c.title.padEnd(30) +
        ' creativeOptSwitch=' + c.creative + '(期望 ' + want + ')' +
        '  时段' + (hOk ? '✅' : '❌' + JSON.stringify(c.hours)) +
        '  cpm=' + c.cpm + '  预算分=' + c.budget + '  ' + c.status);
    });
    const bad = mine.filter((c) => c.creative !== (/创意开/.test(c.title) ? 'true' : 'false'));
    console.log('  ' + (bad.length ? '❌ 有 ' + bad.length + ' 个 creativeOptSwitch 没生效 —— 这个实验设计不成立' : '✅ creativeOptSwitch 全部按期望生效'));
    const badH = mine.filter((c) => JSON.stringify(c.hours) !== wantHours);
    console.log('  ' + (badH.length ? '❌ 有 ' + badH.length + ' 个时段不是 ' + HOURS_ARG + '：' + badH.map((c) => c.title).join('、')
      : '✅ 时段全部是 ' + HOURS_ARG));
  } else { console.log('  回读失败: ' + JSON.stringify(v).slice(0, 200)); }

  fs.writeFileSync(path.join(ROOT, 'ab-creative-result.json'),
    JSON.stringify({ plan, planFile: PLANF, hours: HOURS_ARG, skipped, results }, null, 2), 'utf8');
  log('结果已写 ab-creative-result.json（本轮跳过 ' + skipped + ' 条已建，实建 ' + results.length + ' 个）');
})().catch((e) => { log('❌ ' + (e && e.stack || e)); process.exit(1); });
