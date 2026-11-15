/**
 * tools/store-audit.js — 从闲鱼【读回真值】，和店铺档案逐项对账
 *
 * 为什么这是整套方案里最值钱的一件：
 *   配置工具只能保证"你填的进了文件"，保证不了"文件在平台上真的生效"。
 *   2026-10-08 一晚就抓到两次「看着成功了、其实没有」：
 *     · KPL 计划 run-cfgs 记 confirmed:true，平台侧却 pauseStatus=1、今日花费 ¥0
 *     · Hope 店 CLI 发的是单档规格，桌面引擎发的是三档 —— 两边档案不一致，肉眼看不出来
 *   两次都是靠"把平台的真实值读回来跟档案比"才发现的。这个脚本就是那件事的固定做法。
 *
 * 判定分三档（别把"随场次变化"当成错，那会让这个工具没人看）：
 *   ✅ 一致      —— 档案说的和平台一样
 *   ❌ 不一致    —— 【结构性】字段对不上（价格/库存/分类/规格/发货/承诺）。这是真错，退出码 1
 *   ⚠️ 随场次    —— 出价/日上限/目标/创意优化/时段本来就会按场次变，只报告不报警
 *   ⓘ 无法比对  —— 平台不存这一项（主图版式 / 文案模板 / 所在地模式）
 *
 * 只读：不发任何写请求。
 *
 * 用法:
 *   node tools/store-audit.js --store=好易美代拍
 *   node tools/store-audit.js --store=好易美代拍 --items=5
 *   node tools/store-audit.js --all                 # 所有 live 店都跑一遍
 *   node tools/store-audit.js --store=X --quiet      # 只打印 ❌ 和结论
 * 退出码: 0 = 无结构性问题   1 = 有 ❌   2 = 环境问题
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const mtop = require('../lib/mtop');
const profile = require('../lib/store-profile');
const { ROOT, STORE } = require('../lib/env');

const ARGV = process.argv.slice(2);
const argOf = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const QUIET = ARGV.indexOf('--quiet') >= 0;
const ALL = ARGV.indexOf('--all') >= 0;
const WANT = Number(argOf('items', '3'));

const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'TRUE';
function shipModeOf(post) {
  const p = post || {};
  if (!isTrue(p.supportFreight)) return 'nomail';
  return Number(p.postPriceInCent) > 0 ? 'fixed' : 'free';
}

const EDIT = 'https://www.goofish.com/publish?itemId=';
const rows = [];
const push = (level, item, file, live, note) => rows.push({ level, item, file: String(file), live: String(live), note: note || '' });
const TAG = { ok: '✅', bad: '❌', vary: '⚠️', na: 'ⓘ' };

async function auditStore(name) {
  rows.length = 0;
  let P, ap;
  try { P = profile.load(name); ap = profile.resolveAdPlan(P); }
  catch (e) { console.log('❌ 「' + name + '」档案读不了：' + e.message); return { bad: 1, name }; }

  console.log('\n════════════════ ' + name + ' ════════════════');

  // ── 取样本链接（台账里这家店最近的几条）──
  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(path.join(ROOT, '上架台账.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
  const seen = new Set();
  const ids = ledger.filter((r) => r && r.itemId && r.ok !== false && (!r.store || r.store === name))
    .reverse().filter((r) => (seen.has(String(r.itemId)) ? false : (seen.add(String(r.itemId)), true)))
    .slice(0, WANT).map((r) => String(r.itemId));

  // ── 上架：读平台真值 ──
  let items = [];
  if (ids.length) {
    try {
      await agent.evalOnStore('if(location.href.indexOf("/publish")<0){location.href=' +
        JSON.stringify(EDIT + ids[0]) + ';} "nav"', { store: name, timeout: 120000 });
      await new Promise((r) => setTimeout(r, 12000));
      const CODE = `
        var ids = ${JSON.stringify(ids)}, out = [];
        for (var i = 0; i < ids.length; i++) {
          var rec = { itemId: ids[i] };
          try {
            var r = await mtop.request({ api:'mtop.idle.pc.idleitem.editdetail', v:'1.0',
              data:{ itemId: String(ids[i]) }, type:'GET' });
            if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) { rec.err = r && r.ret; out.push(rec); continue; }
            var d = r.data || {}, sku = (d.itemSkuList||[])[0] || {};
            rec.priceCent = sku.priceInCent != null ? sku.priceInCent : Number((d.itemPriceDTO||{}).priceInCent);
            rec.quantity = sku.quantity != null ? sku.quantity : d.quantity;
            rec.specs = ((sku.propertyList||[]).map(function(p){ return p.valueText; })).filter(Boolean);
            rec.catId = String((d.itemCatDTO||{}).catId); rec.channelCatId = String((d.itemCatDTO||{}).channelCatId);
            rec.ship = d.itemPostFeeDTO || null;
            rec.rights = (d.userRightsProtocols||[]).filter(function(x){ return x && (x.enable === true || x.enable === 'true'); }).map(function(x){ return x.serviceCode; });
            rec.imgCount = (d.imageInfoDOList||[]).length;
            out.push(rec);
          } catch (e) { rec.err = String((e && e.message) || e); out.push(rec); }
        }
        return JSON.stringify(out);`;
      const got = await agent.mtop(CODE, { store: name, timeout: 300000 });
      items = (Array.isArray(got) ? got : []).filter((r) => !r.err);
    } catch (e) { console.log('  ⚠️ 链接读不回来：' + String(e.message).slice(0, 100)); }
  }
  if (!items.length) console.log('  （没有可对账的链接样本，跳过上架九项）');
  else {
    console.log('\n── 上架九项（对账 ' + items.length + ' 条链接）──');
    console.log('  判定  项目            档案说                平台实际');
    console.log('  ' + '-'.repeat(84));
    const specsStr = (P.规格.specs || []).map((s) => s.valueText + (s.price != null ? '¥' + s.price : '')).join('/');
    const filePrice = (P.规格.specs[0] && P.规格.specs[0].price != null) ? P.规格.specs[0].price : P.价格.default;
    const fileRights = JSON.stringify((P.承诺.serviceCodes || []).slice().sort());

    let first = true;
    items.forEach((it) => {
      const eq = (a, b) => String(a) === String(b);
      const add = (lvl, item, f, l, note) => push(lvl, item, f, l, note);

      add(eq(filePrice * 100, it.priceCent) ? 'ok' : 'bad', '⑥价格', '¥' + filePrice, '¥' + (it.priceCent / 100));
      add(eq(P.库存.default, it.quantity) ? 'ok' : 'bad', '⑦库存', P.库存.default, it.quantity);
      add(eq(P.分类.catId, it.catId) ? 'ok' : 'bad', '④分类catId', P.分类.catId, it.catId);
      add(eq(P.分类.channelCatId, it.channelCatId) ? 'ok' : 'bad', '④渠道类目', P.分类.channelCatId, it.channelCatId);
      const fileSpecs = (P.规格.specs || []).map((s) => s.valueText).join('/');
      add(eq(fileSpecs, it.specs.join('/')) ? 'ok' : 'bad', '⑤规格', fileSpecs || '(空)', it.specs.join('/') || '(空)');
      const fs2 = P.发货方式.shipMode, ls = shipModeOf(it.ship);
      add(eq(fs2, ls) ? 'ok' : 'bad', '⑧发货方式', fs2, ls);
      const liveRights = JSON.stringify((it.rights || []).slice().sort());
      add(eq(fileRights, liveRights) ? 'ok' : 'bad', '⑨承诺', fileRights, liveRights);
      if (P.副图.count) add(eq(P.副图.count, it.imgCount - 1) ? 'ok' : 'vary', '①副图张数', P.副图.count, it.imgCount - 1);
      first = false;
    });
    // 打印：同一项在多个样本里的判定合并
    const byItem = {};
    rows.forEach((r) => { if (!r.item) return; (byItem[r.item] = byItem[r.item] || []).push(r); });
    Object.keys(byItem).forEach((k) => {
      const rs = byItem[k];
      const worst = rs.some((r) => r.level === 'bad') ? 'bad' : (rs.some((r) => r.level === 'vary') ? 'vary' : 'ok');
      const live = [...new Set(rs.map((r) => r.live))].join(' | ');
      const file = [...new Set(rs.map((r) => r.file))].join(' | ');
      console.log('  ' + TAG[worst] + '    ' + k.padEnd(14) + file.slice(0, 22).padEnd(22) + live.slice(0, 40));
    });
    // 平台不存的那几项：不是"一致"，是"没法用平台验证" —— 明说，别让人以为验过了
    push('na', '③所在地模式', P.所在地.mode, '平台不存这个模式');
    push('na', '①主图版式', (P.主图.templates || []).join(',').slice(0, 18), '平台只存成图');
    push('na', '②文案模板', JSON.stringify(P.文案.templateIds), '平台只存最终文字');
    ['③所在地模式', '①主图版式', '②文案模板'].forEach((k) => {
      const r = rows.find((x) => x.item === k && x.level === 'na');
      if (r) console.log('  ' + TAG.na + '    ' + r.item.padEnd(14) + r.file.slice(0, 22).padEnd(22) + r.live.slice(0, 40));
    });
    console.log('       （ⓘ = 平台不存这一项，只能靠本地档案约束，无法对账）');
  }

  // ── 推广：读平台真值 ──
  let plans = [];
  try {
    await agent.enterAdConsole({ store: name, timeout: 90000 });
    const p = await mtop.adPlans({ store: name });
    plans = p.filter((x) => !x.isCollection);
  } catch (e) { console.log('  ⚠️ 计划读不回来：' + String(e.message).slice(0, 100)); }
  if (!plans.length) console.log('\n  （没有单链计划，跳过推广九项）');
  else {
    const RAW = `
      var r = await mtop.request({api:'mtop.taobao.idle.ad.campaign.search', v:'1.0', type:'GET',
        data:{requestJson: JSON.stringify({pageNum:1, pageSize:100, campaignStatus:[], statusGroup:[]})}});
      if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify([]);
      return JSON.stringify((((r.data||{}).result)||[]).map(function(c){ var it=c.infoTab||{};
        return { id:String(c.campaignId), title:String(c.title||''), target:c.bidTarget, bidType:c.bidType,
          mode:c.promotionMode, creative:c.creativeOptSwitch, cpm:Number(c.cpm), budget:Number(c.maxDayBudget),
          hours:(it.budgetScheduleDurations||[]).map(Number), n:(c.entityList||[]).length,
          pause:String(c.pauseStatus), todayCost:Number(it.todayCost||0) }; }));`;
    let raw = [];
    try { raw = await agent.mtop(RAW, { store: name, timeout: 240000 }) || []; } catch (e) {}
    const single = raw.filter((x) => x.n > 0 && !/^擦亮宝贝/.test(x.title));

    console.log('\n── 推广九项（对账 ' + single.length + ' 个单链计划）──');
    console.log('  判定  项目            档案说                平台实际（不同的值都列出来）');
    console.log('  ' + '-'.repeat(84));
    const cmp = (label, want, got, level) => {
      const set = [...new Set(got.map(String))];
      const allEq = set.length === 1 && String(set[0]) === String(want);
      const anyEq = set.indexOf(String(want)) >= 0;
      const lvl = allEq ? 'ok' : (level === 'hard' ? 'bad' : 'vary');
      console.log('  ' + TAG[lvl] + '    ' + label.padEnd(14) + String(want).padEnd(22) + set.join(' / ').slice(0, 44) +
        (allEq ? '' : (anyEq ? '   （部分计划不同）' : '   （没有一个跟档案一样）')));
      return lvl === 'bad';
    };
    let bad = 0;
    if (cmp('⑤目标', ap.目标, single.map((x) => x.target), 'soft')) { /* 目标会按场次变 */ }
    if (cmp('④出价方式', ap.出价方式, single.map((x) => x.bidType), 'hard')) bad++;
    if (cmp('③擦亮类型', ap.promotionMode, single.map((x) => x.mode), 'hard')) bad++;
    cmp('⑤预期成本', '¥' + ap.预期成本, single.map((x) => '¥' + (x.cpm / 100)), 'soft');
    cmp('⑥日上限', '¥' + ap.日上限, single.map((x) => '¥' + (x.budget / 100)), 'soft');
    cmp('⑧创意优化', String(ap.创意优化), single.map((x) => String(isTrue(x.creative))), 'soft');
    cmp('⑨时段', ap.时段.length + 'h', single.map((x) => x.hours.length + 'h'), 'soft');
    console.log('  ' + TAG.na + '    ⑦计划名称      模板 ' + String(ap.名称).padEnd(24) + single.map((x) => x.title).slice(0, 2).join(' / ').slice(0, 40));
    console.log('  ' + TAG.na + '    ②擦亮宝贝      ' + String(JSON.stringify(ap.宝贝)).padEnd(22) + single.map((x) => x.n + '条').join(' / '));

    // 计划没在投，要分情况说 —— 否则每天夜里跑都会报 8 条「异常」，这种假警报一多就没人看了。
    //   23:00 关窗、08:00 开窗，关窗时段全店暂停是【设计如此】。
    const notRunning = single.filter((x) => x.pause !== '0');
    const h = new Date().getHours();
    const inWindow = h >= 8 && h < 23;
    const paused = fs.existsSync(path.join(ROOT, 'PAUSE-ADS'));
    if (notRunning.length) {
      if (paused || !inWindow) {
        console.log('\n  ⓘ 有 ' + notRunning.length + ' 个单链计划当前是暂停的，但' +
          (paused ? '存在 PAUSE-ADS（全店停投）' : '现在是关窗时段（08:00-23:00 才投）') + ' —— 属正常，不算问题。');
      } else {
        console.log('\n  ⚠️ 有 ' + notRunning.length + ' 个单链计划没在投（现在是投放时段，这值得看一眼）：');
        notRunning.forEach((x) => console.log('     · ' + x.id + '  ' + x.title + '  pauseStatus=' + x.pause + '  今日 ¥' + (x.todayCost / 100).toFixed(2)));
      }
    }

    const badRows = rows.filter((r) => r.level === 'bad').length;
    const un = items.length ? 0 : 1;
    console.log('\n  结论：上架结构性不一致 ' + badRows + ' 项，推广结构性不一致 ' + bad + ' 项' +
      (un ? '，上架【没读到样本所以没对账】' : '') +
      ((badRows + bad + un) ? '' : ' —— ✅ 档案和平台一致'));
    return { bad: badRows + bad, unaudited: un, name };
  }
  // 没有单链计划：至少上架要读到过，否则就是"什么都没验"
  const badRows = rows.filter((r) => r.level === 'bad').length;
  const un = items.length ? 0 : 1;
  if (un) {
    // ⚠️ 这里以前会打印「✅ 档案和平台一致」—— 而实际上一条链接都没读到。
    //   「没验成」被报成「验过且没问题」是这套系统最危险的错法（本仓已踩过多次）。
    console.log('\n  结论：ⓘ 无法对账 —— 一条链接都没读到（店铺页没就绪？先跑 ' +
      'node tools/store-ready.js "' + name + '"）');
  } else {
    console.log('\n  结论：上架结构性不一致 ' + badRows + ' 项' + (badRows ? '' : ' —— ✅ 档案和平台一致'));
  }
  return { bad: badRows, unaudited: un, name };
}

(async () => {
  let names;
  if (ALL) names = profile.list().filter((n) => { try { return profile.load(n).status === 'live'; } catch (e) { return false; } });
  else names = [argOf('store', STORE)];

  let total = 0, unaudited = 0;
  const results = [];
  for (const n of names) {
    try { const r = await auditStore(n); total += r.bad; unaudited += (r.unaudited || 0); results.push(r); }
    catch (e) { console.log('❌ 「' + n + '」对账失败：' + (e && e.message)); total++; }
  }
  console.log('\n════ 总计 ════');
  results.forEach((r) => console.log('  ' + (r.bad ? '❌' : (r.unaudited ? 'ⓘ ' : '✅')) + ' ' + r.name + '  结构性问题 ' + r.bad + ' 项' +
    (r.unaudited ? '，【未对账】' : '')));
  if (total) console.log('\n❌ 有 ' + total + ' 项档案和平台对不上 —— 先修再用');
  else if (unaudited) console.log('\nⓘ 有 ' + unaudited + ' 家店没读到样本 → 没验成，不等于验过了。把店页拉起来再跑。');
  else console.log('\n✅ 全部对得上');
  process.exit(total ? 1 : (unaudited ? 1 : 0));
})().catch((e) => require('../lib/crash').crash(e, 2));
