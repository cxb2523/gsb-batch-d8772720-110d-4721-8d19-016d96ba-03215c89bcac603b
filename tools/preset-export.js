/**
 * tools/preset-export.js — 从闲鱼【读回真值】，生成一份可继承的「样板」
 *
 * 为什么需要它（老板 2026-10-08 的需求 + 我同意的三层方案第一层）：
 *   学员要配 18 项（上架 9 + 推广 9）。如果让他自己填，他填错也不会报错
 *   （今天 KPL 的 catId 就是：渠道类目写成叶子类目，接口照收，计划挂错类目）。
 *   正确做法是：经验从【老板在跑的店】里抽出来，学员只做选择题。
 *
 * 关键设计（和"让学员填默认值"的区别）：
 *   ① 读的是【平台真值】（editdetail / campaign.search），不是档案里"宣称"的值。
 *      档案可能是错的、过期的、或从来没生效的 —— 只有平台说的才算数。
 *   ② 每一项都算【一致性】。多个链接/多个计划之间如果不一致，
 *      【必须把分布打出来并标记】，不许悄悄挑一个当成"标准"。
 *      （这个仓最贵的一课就是"看着很有说服力的错答案"。）
 *   ③ 有 3 项平台根本不存（主图版式 / 文案模板 / 所在地模式），
 *      只能从现有档案继承，并在 _来源 里标明"这一项不是读回来的"。
 *
 * 用法:
 *   node tools/preset-export.js --store=好易美代拍              # 预演：打印推导结果 + 一致性
 *   node tools/preset-export.js --store=好易美代拍 --apply      # 真写 presets/<名字>.json
 *   node tools/preset-export.js --store=好易美代拍 --items=5 --name=代拍-标准 --apply
 *   node tools/preset-export.js --store=好易美代拍 --force      # 覆盖已存在的样板
 *
 * 只读：不发布、不改计划、不动钱。--apply 只新增 presets/ 下的一个文件。
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const mtop = require('../lib/mtop');
const profile = require('../lib/store-profile');
const { ROOT, STORE } = require('../lib/env');

const A = (() => {
  const out = { _: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const s = process.argv[i];
    if (s.startsWith('--')) { const eq = s.indexOf('='); if (eq > 0) out[s.slice(2, eq)] = s.slice(eq + 1); else out[s.slice(2)] = true; }
    else out._.push(s);
  }
  return out;
})();
const STORE_NAME = A.store || STORE;
const WANT_ITEMS = Number(A.items || 4);
const PRESET_NAME = A.name || '待命名';
const APPLY = !!A.apply;
const FORCE = !!A.force;

const OUT_DIR = path.join(ROOT, 'presets');
const OUT_FILE = path.join(OUT_DIR, PRESET_NAME + '.json');

/**
 * ⚠️ 闲鱼这个接口把布尔值当【字符串】返回："false" / "true"。
 *   而 JS 里 `"false"` 是 truthy —— 直接 `if (p.supportFreight)` 会把
 *   所有「不支持运费」的商品判成「包邮」。
 *   实测踩到：4 条样本全部推导成 free，而档案和台账都是 nomail。
 *   所以布尔一律过这个函数，不许直接当条件用。
 */
const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'TRUE';

/** itemPostFeeDTO → 我们的 shipMode（闲鱼不直接给这个枚举，是按字段推的） */
function shipModeOf(post) {
  const p = post || {};
  if (!isTrue(p.supportFreight)) return 'nomail';           // 不支持邮寄 = 面交/虚拟
  return Number(p.postPriceInCent) > 0 ? 'fixed' : 'free';
}

/** 众数 + 一致性，绝不隐藏分歧 */
function tally(pairs) {
  const m = new Map();
  pairs.forEach(([key, val]) => {
    if (val === undefined || val === null || val === '') return;
    if (!m.has(key)) m.set(key, { value: val, n: 0 });
    m.get(key).n++;
  });
  const list = [...m.values()].sort((a, b) => b.n - a.n);
  const total = pairs.length;
  return {
    value: list.length ? list[0].value : undefined,
    n: list.length ? list[0].n : 0,
    total,
    distinct: list,
    consistent: list.length <= 1,
  };
}
const showTally = (t, fmt) => t.total === 0 ? '(无数据)'
  : (t.consistent ? '全部一致 → ' + (fmt ? fmt(t.value) : t.value) + '  [' + t.n + '/' + t.total + ']'
    : '⚠️ 不一致 ' + t.distinct.map((d) => (fmt ? fmt(d.value) : d.value) + '×' + d.n).join('  '));

(async () => {
  // ── 0. 现有档案（平台不存的那几项要从这里继承）──
  let P;
  try { P = profile.load(STORE_NAME); }
  catch (e) { console.log('❌ 读档案失败：' + e.message); process.exit(2); }
  console.log('样板来源店铺: ' + STORE_NAME);
  console.log('输出         : ' + path.relative(ROOT, OUT_FILE).replace(/\\/g, '/') + (APPLY ? '  （将写入）' : '  （预演，不写）'));

  // ── 1. 挑要读回哪几条链接：取自台账（本地、可靠），再去平台核实 ──
  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(path.join(ROOT, '上架台账.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
  const seen = new Set();
  const candidates = ledger
    .filter((r) => r && r.ok !== false && r.itemId && (!r.store || r.store === STORE_NAME))
    .reverse()
    .filter((r) => (seen.has(String(r.itemId)) ? false : (seen.add(String(r.itemId)), true)))
    .slice(0, WANT_ITEMS)
    .map((r) => String(r.itemId));

  if (!candidates.length) {
    console.log('\n⚠️ 台账里没有「' + STORE_NAME + '」的成功记录，没法推导上架九项。');
    console.log('   换一家店：--store=<店名>；或先发一条链接。');
  } else {
    console.log('读回样本     : ' + candidates.length + ' 条链接  ' + candidates.join(', '));
  }

  // ── 2. 读平台真值 ──
  const items = [];
  if (candidates.length) {
    await agent.evalOnStore('if(location.href.indexOf("/publish")<0){location.href=' +
      JSON.stringify('https://www.goofish.com/publish?itemId=' + candidates[0]) + ';} "nav"',
      { store: STORE_NAME, timeout: 120000 });
    await new Promise((r) => setTimeout(r, 12000));

    const CODE = `
      var ids = ${JSON.stringify(candidates)};
      var out = [];
      for (var i = 0; i < ids.length; i++) {
        var rec = { itemId: ids[i] };
        try {
          var r = await mtop.request({ api:'mtop.idle.pc.idleitem.editdetail', v:'1.0',
            data:{ itemId: String(ids[i]) }, type:'GET' });
          if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) { rec.err = r && r.ret; out.push(rec); continue; }
          var d = r.data || {}, t = d.itemTextDTO || {}, sku = (d.itemSkuList||[])[0] || {};
          rec.title = t.title || null;
          rec.descLen = t.desc ? String(t.desc).length : 0;
          rec.descHead = t.desc ? String(t.desc).split('\\n').filter(Boolean).slice(1, 3).join(' / ').slice(0, 70) : null;
          rec.priceCent = sku.priceInCent != null ? sku.priceInCent : ((d.itemPriceDTO||{}).priceInCent != null ? Number((d.itemPriceDTO||{}).priceInCent) : null);
          rec.quantity = sku.quantity != null ? sku.quantity : d.quantity;
          rec.specs = ((sku.propertyList||[]).map(function(p){ return p.valueText; })).filter(Boolean);
          rec.cat = { catId: (d.itemCatDTO||{}).catId, channelCatId: (d.itemCatDTO||{}).channelCatId, catName: (d.itemCatDTO||{}).catName };
          rec.addr = d.itemAddrDTO || null;
          rec.post = d.itemPostFeeDTO || null;
          rec.rights = (d.userRightsProtocols||[]).filter(function(x){ return x && (x.enable === true || x.enable === 'true'); }).map(function(x){ return x.serviceCode; });
          rec.imgCount = (d.imageInfoDOList||[]).length;
          rec.propCount = (d.properties||[]).length;
          out.push(rec);
        } catch (e) { rec.err = String((e && (e.ret || e.message)) || e); out.push(rec); }
      }
      return JSON.stringify(out);`;

    const got = await agent.mtop(CODE, { store: STORE_NAME, timeout: 300000 });
    (Array.isArray(got) ? got : []).forEach((r) => { if (!r.err) items.push(r); else console.log('  ⚠️ ' + r.itemId + ' 读不到：' + JSON.stringify(r.err).slice(0, 80)); });
  }

  // ── 3. 读平台真值：擦亮计划 ──
  let plans = [];
  try {
    await agent.enterAdConsole({ store: STORE_NAME, timeout: 90000 });
    plans = (await mtop.adPlans({ store: STORE_NAME })).filter((p) => !p.isCollection);
  } catch (e) { console.log('  ⚠️ 计划读不到：' + e.message.slice(0, 90)); }
  // 单链计划里，还要拿原始字段（bidType / promotionMode / creativeOptSwitch / 时段）
  let rawPlans = [];
  if (plans.length) {
    const RAW = `
      var r = await mtop.request({api:'mtop.taobao.idle.ad.campaign.search', v:'1.0', type:'GET',
        data:{requestJson: JSON.stringify({pageNum:1, pageSize:100, campaignStatus:[], statusGroup:[]})}});
      if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify([]);
      var list = ((r.data||{}).result) || [];
      return JSON.stringify(list.map(function(c){ var it=c.infoTab||{};
        return { id:String(c.campaignId), title:String(c.title||''), target:c.bidTarget, bidType:c.bidType,
          mode:c.promotionMode, creative:c.creativeOptSwitch, cpm:Number(c.cpm), budget:Number(c.maxDayBudget),
          hours:(it.budgetScheduleDurations||[]).map(Number), n:(c.entityList||[]).length }; }));`;
    try { rawPlans = await agent.mtop(RAW, { store: STORE_NAME, timeout: 240000 }) || []; } catch (e) {}
  }
  const single0 = rawPlans.filter((p) => p.n > 0 && !/^擦亮宝贝/.test(p.title));

  // ── 认口径，而不是跨口径取众数 ──
  //   为什么：出价/日上限在店里"不一致"，往往不是随机波动，而是【两套并存的业务线】。
  //   实测好易美代拍：B组「城市明星-咨询120」5 个全是 ¥2.8/¥50/创意开；
  //   A组「¥2.88·创意X·城市明星」3 个是 ¥3.2~3.5、¥50~300、创意混 —— A 是桌面引擎时期的历史遗留。
  //   跨组取众数这次侥幸没出事（B 组 5 票赢了）。但要是哪天遗留计划比现行多，
  //   样板就会被带偏，而且【不会报错】—— 正是那种"看着很有说服力的错值"。
  //   所以：按结构指纹聚类，多于一组时【拒绝自己挑】，让人显式选。
  const sig = (p) => [p.bidType, p.mode, p.target, String(isTrue(p.creative)), p.budget].join('|');
  const clusters = new Map();
  single0.forEach((p) => { const k = sig(p); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(p); });
  const ordered = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);

  let single = single0;
  let clusterNote = '';
  if (single0.length && ordered.length > 1) {
    console.log('\n⚠️ 样本里有 ' + ordered.length + ' 套【结构口径】并存 —— 不能跨口径取众数：');
    ordered.forEach(([k, list], i) => {
      const parts = k.split('|');
      const bids = [...new Set(list.map((p) => '¥' + (p.cpm / 100)))].join('/');
      console.log('   [' + (i + 1) + '] ' + String(list.length) + ' 个  ' +
        '出价 ' + bids + '  预算 ' + parts[4] / 100 + '  目标 ' + parts[2] + '  创意 ' + parts[3] + '  出价方式 ' + parts[0]);
      list.slice(0, 3).forEach((p) => console.log('        · ' + p.title));
      if (list.length > 3) console.log('        · …还有 ' + (list.length - 3) + ' 个');
    });
    if (A.group) {
      const gi = Number(A.group) - 1;
      if (!(gi >= 0 && gi < ordered.length)) { console.log('\n❌ --group=' + A.group + ' 超范围（只有 ' + ordered.length + ' 套）'); process.exit(2); }
      single = ordered[gi][1];
      clusterNote = '第 ' + (gi + 1) + '/' + ordered.length + ' 套口径（' + single.length + ' 个计划）被显式选中' +
        '；没被选中的 ' + (single0.length - single.length) + ' 个计划属于别的口径（可能是另一条业务线或历史遗留）';
      console.log('\n→ 按 --group=' + A.group + ' 只用第 ' + (gi + 1) + ' 套（' + single.length + ' 个计划）推推广九项。');
    } else if (A['accept-mixed']) {
      clusterNote = '⚠️ --accept-mixed：跨 ' + ordered.length + ' 套口径混着取众数，样板可能被历史遗留带偏';
      console.log('\n→ --accept-mixed：仍然拿全部 ' + single0.length + ' 个一起取众数（不推荐，样板可能被历史遗留带偏）。');
    } else {
      console.log('\n❌ 请显式选一套口径再生成样板：');
      console.log('     node tools/preset-export.js --store=' + STORE_NAME + ' --group=<序号> --name=<样板名> --apply');
      console.log('   或者（不推荐）--accept-mixed 明确表示"我就要混着取众数"。');
      console.log('   ⚠️ 如果这几套口径对应不同业务线（比如票务 vs 代拍），那你要的其实是【多个样板】，不是选一套。');
      console.log('      拿不准就该问业务：见 学员配置体系-协同小美.md');
      process.exit(3);
    }
  }

  // ── 4. 打印推导过程 ──
  const itemsOf = (f) => items.map((i) => [f(i), f(i)]);
  const line = (label, txt, note) => console.log('  ' + label.padEnd(14) + txt + (note ? '   ← ' + note : ''));

  console.log('\n════ 上架九项（读回 ' + items.length + ' 条链接）════');
  if (!items.length) console.log('  （没读到任何链接，上架九项只能全部继承现有档案）');
  else {
    const tTitle = tally(items.map((i) => ['Len' + String(i.title || '').length, String(i.title || '').length]));
    line('②标题字数', showTally(tTitle, (v) => v + ' 字'));
    const tPrice = tally(items.map((i) => ['P' + i.priceCent, i.priceCent]));
    line('⑥价格', showTally(tPrice, (v) => '¥' + (v / 100)));
    const tQty = tally(items.map((i) => ['Q' + i.quantity, i.quantity]));
    line('⑦库存', showTally(tQty, String));
    const tSpec = tally(items.map((i) => [JSON.stringify(i.specs), i.specs.length + ' 档 ' + JSON.stringify(i.specs)]));
    line('⑤规格', showTally(tSpec, (v) => String(v).slice(0, 40)));
    const tCat = tally(items.map((i) => [JSON.stringify(i.cat), i.cat.catName + ' ' + i.cat.catId + '/' + i.cat.channelCatId]));
    line('④分类', showTally(tCat));
    const tImg = tally(items.map((i) => ['I' + i.imgCount, i.imgCount]));
    line('①图片', showTally(tImg, (v) => v + ' 张（含主图）'));
    const tShip = tally(items.map((i) => {
      const m = shipModeOf(i.post);
      const p = i.post || {};
      return [m, m + '  (supportFreight=' + p.supportFreight + ' onlyTakeSelf=' + p.onlyTakeSelf + ' 邮费=' + p.postPriceInCent + ')'];
    }));
    line('⑧发货方式', showTally(tShip, (v) => String(v).split(' ')[0]), '按 itemPostFeeDTO 推断');
    const tRights = tally(items.map((i) => [JSON.stringify(i.rights), i.rights.length ? JSON.stringify(i.rights) : '全不勾']));
    line('⑨承诺', showTally(tRights));

    // 所在地：mode=city 的店，各条链接城市【本来就该不一样】。
    //   把它报成「不一致」是假警报 —— 那正是 mode=city 在正常工作。
    const mode = (P.所在地 || {}).mode;
    const tCity = tally(items.map((i) => [(i.addr || {}).city, ((i.addr || {}).prov || '?') + '/' + ((i.addr || {}).city || '?')]));
    if (mode === 'city') {
      line('③所在地', '跟随标题城市（' + tCity.distinct.length + ' 个城市：' +
        tCity.distinct.map((d) => d.value).join(' ' ) + '）', '差异是 mode=city 的正常表现，不是不一致');
    } else {
      line('③所在地', showTally(tCity, (v) => String(v)), '观测值；mode 由现有档案决定（平台不存）');
    }

    // 副图张数：平台【数得出来】（总图数 − 主图）。只有"目录在哪"平台不存。
    const tSub = tally(items.map((i) => ['S' + Math.max(0, i.imgCount - 1), Math.max(0, i.imgCount - 1)]));
    line('①副图张数', showTally(tSub, (v) => v + ' 张'), '平台数得出来；只有目录路径要继承档案');
    console.log('    正文长度: ' + items.map((i) => i.descLen).join(' / ') + ' 字');
  }

  console.log('\n════ 推广九项（读回 ' + single.length + ' 个单链计划）════');
  if (!single.length) console.log('  （没有单链计划，推广九项继承现有档案）');
  else {
    line('①方式', '超级擦亮 (productId=1)');
    line('②擦亮宝贝', tally(single.map((p) => ['n' + p.n, p.n])).distinct.map((d) => d.value + ' 条×' + d.n).join('  '));
    line('③擦亮类型', showTally(tally(single.map((p) => [p.mode, p.mode]))));
    line('④出价方式', showTally(tally(single.map((p) => [p.bidType, p.bidType]))));
    line('⑤目标', showTally(tally(single.map((p) => [p.target, p.target]))));
    line('⑤预期成本', showTally(tally(single.map((p) => ['B' + p.cpm, p.cpm])), (v) => '¥' + (v / 100)));
    line('⑥日上限', showTally(tally(single.map((p) => ['D' + p.budget, p.budget])), (v) => '¥' + (v / 100)));
    line('⑧创意优化', showTally(tally(single.map((p) => [String(p.creative), String(p.creative)]))));
    const tHours = tally(single.map((p) => [p.hours.join(','), p.hours.length + 'h ' + p.hours[0] + '-' + (p.hours[p.hours.length - 1] + 1)]));
    line('⑨时段', showTally(tHours));
    line('⑦计划名', single.length + ' 个计划的实际名字：');
    tally(single.map((p) => [p.title, p.title])).distinct.slice(0, 8).forEach((d) => console.log('        ' + d.value + '   ×' + d.n));
  }

  // ── 5. 组装样板（平台不存的三项从档案继承）──
  // ⚠️【2026-11-12 修】原来这里从 profile.DEFAULTS（硬编码默认值）起步，
  //   只有"平台读得到的项"才被覆盖。结果：一家【没发过链接】的店导出样板时，
  //   分类留下的是 DEFAULTS 的「代购」，而不是档案里的「演出票代拍」——
  //   实测超能水手代拍就是这个问题（导出显示 分类 代购，档案却是演出票代拍）。
  //   现在先从【档案】兜底，再让平台真值覆盖：读得到就用平台，读不到就用档案，
  //   都比"硬编码默认值"更接近事实。
  const preset = JSON.parse(JSON.stringify(profile.DEFAULTS));
  try {
    const p0 = profile.load(STORE_NAME);
    for (const k of ['分类', '价格', '库存', '规格', '发货方式', '承诺']) {
      if (p0[k] !== undefined) preset[k] = JSON.parse(JSON.stringify(p0[k]));
    }
    preset._未读回项说明 = '这些项在平台侧没读到样本，值来自档案而不是平台真值：见每项的"来源"标记';
  } catch (e) { /* 档案读不到就保持 DEFAULTS */ }
  preset._schema = 'store-profile/1';
  preset._说明 = '这是从「' + STORE_NAME + '」读回生成的【样板】。学员用 tools/store-new.js --preset=<名字> 继承它。';
  preset.$preset = PRESET_NAME;

  // 平台读得到的，用平台真值
  // ⚠️ 不一致时【用众数，但必须记账】。
  //   "不许悄悄挑一个"不等于"不一致就放弃"—— 放弃会得到 ¥4 这种谁的店都不用的值。
  //   正确做法：取众数当默认，同时把完整分布写进 _一致性问题，让人一眼看到"这是个选择，不是事实"。
  const choices = [];
  const use = (label, t, fmt, apply) => {
    if (!t || !t.total) return false;
    if (t.consistent) { apply(t.value); return true; }
    apply(t.value);   // 众数
    // 众数占比太低时要说"这一项根本没有稳定口径"，不能让人以为它就是标准。
    //   实测：出价在 11 个计划里众数只占 4 个（¥2.8），时段 15h 只占 6 个 ——
    //   这种分布说明【这一项是按场次在人工调的】，样板给的只是起点。
    const share = t.n / t.total;
    const weak = share < 0.6;
    choices.push((weak ? '⚠️ 众数很弱 ' : '') + label + '：取众数 ' + (fmt ? fmt(t.value) : t.value) +
      '（' + t.n + '/' + t.total + (weak ? '，只占 ' + Math.round(share * 100) + '% → 这一项没有稳定口径，样板给的只是起点，别当标准' : '') +
      '），样本里还有 ' + t.distinct.slice(1).map((d) => (fmt ? fmt(d.value) : d.value) + '×' + d.n).join('  '));
    return true;
  };

  if (items.length) {
    use('上架·价格', tally(items.map((i) => ['P' + i.priceCent, i.priceCent])), (v) => '¥' + (v / 100), (v) => { preset.价格.default = v / 100; });
    use('上架·库存', tally(items.map((i) => ['Q' + i.quantity, i.quantity])), String, (v) => { preset.库存.default = v; });
    use('上架·分类', tally(items.map((i) => [JSON.stringify(i.cat), i.cat])), (v) => v.catName, (v) => {
      preset.分类.catName = v.catName; preset.分类.catId = String(v.catId); preset.分类.channelCatId = String(v.channelCatId);
    });
    use('上架·规格', tally(items.map((i) => [JSON.stringify(i.specs), i.specs])), (v) => JSON.stringify(v), (v) => {
      if (v && v.length) preset.规格.specs = v.map((x) => ({ valueText: x }));
    });
    use('上架·承诺', tally(items.map((i) => [JSON.stringify(i.rights), i.rights])), (v) => JSON.stringify(v), (v) => { preset.承诺.serviceCodes = v || []; });
    use('上架·发货方式', tally(items.map((i) => { const m = shipModeOf(i.post); return [m, m]; })), String, (v) => { preset.发货方式.shipMode = v; });
    use('上架·副图张数', tally(items.map((i) => ['S' + Math.max(0, i.imgCount - 1), Math.max(0, i.imgCount - 1)])), (v) => v + ' 张', (v) => {
      if (P.副图 && P.副图.dir) preset.副图.count = v;      // 只有档案里真有副图目录时才写张数
    });
    use('上架·标题字数', tally(items.map((i) => ['L' + String(i.title || '').length, String(i.title || '').length])), (v) => v + ' 字', (v) => {
      if (v >= 26) preset.文案.titleMin = v;
    });
  }
  // 推广
  if (single.length) {
    use('推广·目标', tally(single.map((p) => [p.target, p.target])), String, (v) => { preset.广告.计划.目标 = v; });
    use('推广·出价方式', tally(single.map((p) => [p.bidType, p.bidType])), String, (v) => { preset.广告.计划.出价方式 = v; });
    use('推广·擦亮类型', tally(single.map((p) => [p.mode, p.mode])), String, (v) => { preset.广告.计划.类型 = v; });
    use('推广·预期成本', tally(single.map((p) => ['B' + p.cpm, p.cpm])), (v) => '¥' + (v / 100), (v) => { preset.广告.计划.预期成本 = v / 100; });
    use('推广·日上限', tally(single.map((p) => ['D' + p.budget, p.budget])), (v) => '¥' + (v / 100), (v) => {
      preset.广告.planBudget = v / 100; preset.广告.计划.日上限 = v / 100;
    });
    // creativeOptSwitch 同样是【字符串】"true"/"false" —— `!!"false"` 会是 true，必须过 isTrue
    use('推广·创意优化', tally(single.map((p) => [String(isTrue(p.creative)), isTrue(p.creative)])), String, (v) => { preset.广告.计划.创意优化 = isTrue(v); });
    use('推广·时段', tally(single.map((p) => [p.hours.join(','), p.hours])), (v) => v.length + 'h', (v) => { preset.广告.计划.时段 = v.slice(); });
  }
  // 平台不存的三项：从现有档案继承
  preset.主图.templates = (P.主图 && P.主图.templates || []).slice();
  preset.主图.baseImg = (P.主图 && P.主图.baseImg) || '';
  preset.副图.dir = (P.副图 && P.副图.dir) || '';
  preset.副图.count = (P.副图 && P.副图.count) || 0;
  preset.文案.templateIds = (P.文案 && P.文案.templateIds) || null;
  preset.所在地.mode = (P.所在地 && P.所在地.mode) || 'city';

  preset._来源 = {
    生成时间: new Date().toISOString(),
    来源店铺: STORE_NAME,
    读回的链接: candidates,
    读回的计划: single.map((p) => p.id + ' ' + p.title),
    口径: clusterNote || ('只有一套口径，' + single.length + ' 个计划全部一致'),
    读不回来的三项: ['主图.templates（闲鱼只存成图，没有版式概念）', '文案.templateIds（闲鱼只存最终文字）', '所在地.mode（平台不存这个模式）'],
    说明: '上面三项从现有档案继承；其余全部来自平台真值。任何一项在多条链接/多个计划间不一致时，会保留档案原值并在 _一致性问题 里列出。',
  };

  // 不一致的项由 use() 记进 choices，直接落档（这就是"不许悄悄挑一个"的落点）
  if (choices.length) preset._一致性问题 = choices;

  console.log('\n════ 推导出的样板 ════');
  console.log('  上架: 价格 ¥' + preset.价格.default + '  库存 ' + preset.库存.default + '  分类 ' + preset.分类.catName +
    '  规格 ' + JSON.stringify(preset.规格.specs) + '  发货 ' + preset.发货方式.shipMode + '  承诺 ' + JSON.stringify(preset.承诺.serviceCodes));
  console.log('  推广: ' + preset.广告.计划.方式 + '  ' + preset.广告.计划.类型 + '  ' + preset.广告.计划.出价方式 +
    '  目标 ' + preset.广告.计划.目标 + '  出价 ¥' + preset.广告.计划.预期成本 +
    '  日上限 ' + (preset.广告.计划.日上限 == null ? 'null（跟随 planBudget ¥' + preset.广告.planBudget + '）' : '¥' + preset.广告.计划.日上限) +
    '  ' + preset.广告.计划.时段.length + 'h  创意' + (preset.广告.计划.创意优化 ? '开' : '关'));
  console.log('  继承(平台不存): 主图 ' + JSON.stringify(preset.主图.templates) + '  副图目录 ' + (preset.副图.dir || '(空)') +
    '（张数 ' + preset.副图.count + '，平台数得出）  文案 ' + JSON.stringify(preset.文案.templateIds) + '  所在地 ' + preset.所在地.mode);
  if (choices.length) {
    console.log('\n  ⚠️ 有 ' + choices.length + ' 项样本之间不一致 —— 已取众数当默认，并把完整分布记账：');
    choices.forEach((p) => console.log('     · ' + p));
    console.log('     （这些不是"事实"，是"这个店目前的选择"。学员要不要跟着走，是业务判断 → 见给小美的协同文档）');
  } else if (!items.length) {
    // ⚠️【2026-11-12 修】0 个样本时说"完全一致"是误导 —— 一条都没读到，谈不上一致。
    //   这时所有值都来自档案或默认值，不能当"经平台验证的样板"。
    console.log('\n  ⚠️ 一条链接都没读到（这个店还没发过，或台账里没成功记录）。');
    console.log('     上面的值【全部来自档案/默认值，不是平台真值】—— 只能当草稿，');
    console.log('     等这个店真发过链接再导出一次，才能当"有背书的样板"。');
  } else {
    console.log('\n  ✅ ' + items.length + ' 条样本，所有读回的项彼此一致，可以放心当样板。');
  }

  // ── 档案漂移检测（--diff）──────────────────────────────
  // 为什么要它（2026-11-12）：好易美代拍的档案写着「出价 ¥4 / 日上限 ¥50」，
  //   但平台上的计划实际是「¥3.5 / ¥150」—— 有人在线上的计划里手工改过，没同步回档案。
  //   档案会骗人，而所有脚本都读档案。不定期比对，就会一直按过期配置跑。
  if (A.diff) {
    console.log('\n════ 档案 vs 平台实际（漂移检测）════');
    let prof = null;
    try { prof = profile.load(STORE_NAME); } catch (e) { console.log('  档案读不到：' + e.message); }
    if (prof) {
      const rows = [];
      // ⚠️ 归一化比较：档案里常是数字、平台回来是字符串（库存 9999 vs "9999"），
      //   直接 JSON.stringify 比会误报成漂移。数值一律转 Number 再比。
      const norm = (v) => {
        if (v === null || v === undefined) return '';
        if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
        const n = Number(v);
        return (String(v).trim() !== '' && isFinite(n)) ? n : String(v);
      };
      const add = (item, a, b) => {
        const A1 = JSON.stringify(norm(a)), B1 = JSON.stringify(norm(b));
        if (A1 !== B1) rows.push({ item, profile: JSON.stringify(a), platform: JSON.stringify(b) });
      };
      add('分类', [prof.分类 && prof.分类.catName, prof.分类 && prof.分类.channelCatId],
        [preset.分类.catName, String(preset.分类.channelCatId)]);
      add('价格', prof.价格 && prof.价格.default, preset.价格.default);
      add('库存', prof.库存 && prof.库存.default, preset.库存.default);
      add('规格', prof.规格 && prof.规格.specs, preset.规格.specs);
      add('推广·预期成本', prof.广告 && prof.广告.计划 && prof.广告.计划.预期成本, preset.广告.计划.预期成本);
      add('推广·日上限', (prof.广告 && prof.广告.计划 && prof.广告.计划.日上限) ?? (prof.广告 && prof.广告.planBudget),
        preset.广告.计划.日上限 ?? preset.广告.planBudget);
      add('推广·时段', prof.广告 && prof.广告.计划 && prof.广告.计划.时段, preset.广告.计划.时段);
      add('主图池', prof.主图 && prof.主图.templates, preset.主图.templates);
      add('文案池', prof.文案 && prof.文案.templateIds, preset.文案.templateIds);
      if (!rows.length) {
        console.log('  ✅ 档案和平台实际一致，没有漂移。');
      } else {
        console.log('  ⚠️ 有 ' + rows.length + ' 项不一致 —— 脚本读的是档案，线上已经和档案不一样了：\n');
        rows.forEach(r => {
          console.log('  · ' + r.item);
          console.log('      档案   : ' + r.profile);
          console.log('      平台   : ' + r.platform);
        });
        console.log('\n  → 要么把线上改回档案，要么把档案改成线上现在的样子（改档案用 node tools/store-new.js 或直接编辑 stores/<店>.json）');
        console.log('  → 不改的话，所有脚本都会按【过期配置】跑。');
      }
    }
  }

  if (!APPLY) { console.log('\n[预演] 没写文件。加 --apply 写 ' + path.relative(ROOT, OUT_FILE).replace(/\\/g, '/')); return; }

  if (fs.existsSync(OUT_FILE) && !FORCE) {
    console.log('\n❌ ' + path.relative(ROOT, OUT_FILE).replace(/\\/g, '/') + ' 已存在。换个 --name，或加 --force 覆盖。');
    process.exit(3);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(preset, null, 2), 'utf8');
  console.log('\n✅ 已写 ' + path.relative(ROOT, OUT_FILE).replace(/\\/g, '/'));
  console.log('   验证：node -e "const s=require(\'./presets/' + PRESET_NAME + '.json\');console.log(s.价格,s.广告.计划)"');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
