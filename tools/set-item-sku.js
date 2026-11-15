/**
 * tools/set-item-sku.js — 改【已上架】商品的规格 / 价格 / 库存（想设几档就几档）
 *
 * 为什么需要它：
 *   档案里的 规格.specs 只管【新发布】的链接。店里的老链接要改价、改库存、加档位，
 *   以前只能进闲鱼网页手工编辑 —— 100 个店不可能这么做。
 *
 * 用到的两个接口（2026-10-07 用 tools/probe-mtop-apis.js 在编辑页抓出来的，非猜测）：
 *   mtop.idle.pc.idleitem.editdetail  → 读：返回**可编辑的整包**（含 itemSkuList 每档的
 *                                        propertyList / priceInCent / quantity）
 *   mtop.idle.pc.idleitem.edit        → 写：整包写回（闲鱼编辑页自己就是这么干的）
 *
 * 做法是标准的【读-改-写】，只动规格相关字段，其余（图片/标题/正文/类目/发货/承诺/所在地）
 * 原样写回，不碰：
 *     1. editdetail 读整包
 *     2. 用 --specs 重建 itemSkuList，并从它反推 itemProperties
 *     3. edit 写回（启用规格时 itemPriceDTO 必须置 {}，这是闲鱼抓包样本里的规矩）
 *     4. 再 editdetail 读一次，逐档比对，打印 ✅/❌
 *
 * ⚠️ 改已上架商品会触发闲鱼重新审核。默认只预览（--dry），要真写必须 --apply。
 *
 * 用法:
 *   # 预览：改成三档
 *   node tools/set-item-sku.js --store="好易美票务Hope" --ids=1088881826804 --specs="多人组团可优惠:50:9999,看台:500:9999,内场:800:9999"
 *   # 确认后真写（自动回读校验）
 *   node tools/set-item-sku.js --store="..." --ids=... --specs="..." --apply
 *   # 还原成单档
 *   node tools/set-item-sku.js --store="..." --ids=... --specs="标准:50:9999" --apply
 *
 * --specs 格式: 名称:价格[:库存]，逗号分隔；不写库存 = 9999
 * --property=<规格名>   默认「代拍费」
 */
const { post } = require('../lib/http');
const args = require('../lib/args');

const A = args.parse();
const STORE = A.store || '';
const IDS = String(A.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROPERTY = A.property || '代拍费';
const APPLY = A.on('apply');

if (!STORE || !IDS.length || !A.specs) {
  console.log('用法: node tools/set-item-sku.js --store="<店铺名>" --ids=<itemId> --specs="名称:价格[:库存],..." [--property=代拍费] [--apply]');
  console.log('例:   --specs="多人组团可优惠:50:9999,看台:500:9999,内场:800:9999"');
  process.exit(2);
}

/** 解析 --specs */
const SPECS = String(A.specs).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const p = s.split(':');
  const name = (p[0] || '').trim();
  const price = Number(p[1]);
  const stock = p[2] === undefined || p[2] === '' ? 9999 : Number(p[2]);
  if (!name) { console.log('❌ 规格名不能为空：' + s); process.exit(2); }
  if (!isFinite(price) || price <= 0) { console.log('❌ 规格「' + name + '」的价格非法：' + p[1]); process.exit(2); }
  if (!isFinite(stock) || stock < 0) { console.log('❌ 规格「' + name + '」的库存非法：' + p[2]); process.exit(2); }
  return { name: name, price: price, stock: stock };
});

const EDIT_PAGE = 'https://www.goofish.com/publish?itemId=';

/** 页面侧：读整包 → 改规格 → （可选）写回 → 再读回 */
const CODE = `
(async function(){
  var ids = ${JSON.stringify(IDS)};
  var specs = ${JSON.stringify(SPECS)};
  var propName = ${JSON.stringify(PROPERTY)};
  var doApply = ${APPLY ? 'true' : 'false'};
  function timeout(p, ms, label){
    return Promise.race([p, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('超时 ' + ms + 'ms: ' + label)); }, ms); })]);
  }
  var mtop = (window.lib && window.lib.mtop && window.lib.mtop.request) ? window.lib.mtop.request : null;
  if (!mtop) return JSON.stringify([{ err: '这个页面没有 window.lib.mtop（当前 ' + location.href + '）' }]);
  function req(api, data, type){
    return timeout(mtop({ api: api, v: '1.0', data: data, type: type || 'GET' }), 30000, api);
  }
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var rec = { itemId: ids[i] };
    try {
      // ① 读整包
      var r1 = await req('mtop.idle.pc.idleitem.editdetail', { itemId: String(ids[i]) });
      rec.readRet = r1 && r1.ret;
      var full = (r1 && r1.data) || {};
      rec.before = (full.itemSkuList || []).map(function (s) {
        var v = (s.propertyList && s.propertyList[0]) || {};
        return { name: v.valueText, property: v.propertyText, price: Number(s.priceInCent) / 100, stock: Number(s.quantity) };
      });

      // ② 重建规格
      full.itemProperties = [{ propertyName: propName, supportImage: false,
        propertyValues: specs.map(function (x) { return { propertyValue: x.name }; }) }];
      full.itemSkuList = specs.map(function (x) {
        return { priceInCent: String(Math.round(x.price * 100)), quantity: x.stock,
                 propertyList: [{ propertyText: propName, valueText: x.name }] };
      });
      full.itemPriceDTO = {};                       // 启用规格后顶层价格必须置空
      full.quantity = '1';                          // 抓包样本里顶层 quantity 是 '1'
      rec.after = specs.map(function (x) { return { name: x.name, property: propName, price: x.price, stock: x.stock }; });

      if (!doApply) { out.push(rec); continue; }

      // ③ 写回
      full.itemId = String(ids[i]);
      var r2 = await req('mtop.idle.pc.idleitem.edit', full, 'POST');
      rec.writeRet = r2 && r2.ret;
      rec.writeOk = !!(r2 && r2.ret && String(r2.ret[0]).indexOf('SUCCESS') === 0);
      if (!rec.writeOk) { rec.writeData = JSON.stringify((r2 && r2.data) || {}).slice(0, 300); out.push(rec); continue; }

      // ④ 回读
      await new Promise(function (z) { setTimeout(z, 3000); });
      var r3 = await req('mtop.idle.pc.idleitem.editdetail', { itemId: String(ids[i]) });
      var full3 = (r3 && r3.data) || {};
      rec.readBack = (full3.itemSkuList || []).map(function (s) {
        var v = (s.propertyList && s.propertyList[0]) || {};
        return { name: v.valueText, property: v.propertyText, price: Number(s.priceInCent) / 100, stock: Number(s.quantity) };
      });
      rec.match = JSON.stringify(rec.readBack) === JSON.stringify(rec.after);
    } catch (e) { rec.err = (e && (e.ret || e.message)) || String(e); }
    out.push(rec);
  }
  return JSON.stringify(out);
})()`;

function fmt(list) {
  return (list || []).map((x) => x.name + ' ¥' + x.price + ' ×' + x.stock).join('  |  ') || '（无规格）';
}

(async () => {
  const page = EDIT_PAGE + IDS[0];
  console.log('导航到编辑页 ' + page + ' ...');
  const nav = await post('/api/agent/eval-on-store',
    { store: STORE, code: 'if(location.href!==' + JSON.stringify(page) + '){location.href=' + JSON.stringify(page) + ';} "nav"' },
    { timeout: 90000 });
  if (!nav || nav.ok !== true) {
    console.log('❌ 店铺页没就绪：' + String((nav && nav.error) || '').slice(0, 140));
    console.log('   → node tools/store-ready.js "' + STORE + '"');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 12000));

  console.log('目标规格: ' + fmt(SPECS) + (APPLY ? '' : '   （预览，不写盘）'));
  const r = await post('/api/agent/eval-on-store', { store: STORE, code: CODE }, { timeout: 300000 });
  if (!r || r.ok !== true) { console.log('❌ eval 失败：' + String((r && r.error) || '').slice(0, 200)); process.exit(1); }
  const list = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;

  let bad = 0;
  for (const rec of list) {
    console.log('\n══════ ' + rec.itemId + ' ══════');
    if (rec.err) { console.log('  ❌ ' + rec.err); bad++; continue; }
    console.log('  读: ' + JSON.stringify(rec.readRet));
    console.log('  改前: ' + fmt(rec.before));
    console.log('  改后: ' + fmt(rec.after));
    if (!APPLY) continue;
    console.log('  写: ' + JSON.stringify(rec.writeRet));
    if (!rec.writeOk) { console.log('  ❌ 写入失败 ' + (rec.writeData || '')); bad++; continue; }
    console.log('  回读: ' + fmt(rec.readBack));
    if (rec.match) console.log('  ✅ 回读与目标完全一致');
    else { console.log('  ❌ 回读与目标不一致（闲鱼可能改了值，或字段没生效）'); bad++; }
  }
  if (!APPLY) console.log('\n📋 上面是【预览】，没有写任何东西。确认无误就重跑并加 --apply');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
