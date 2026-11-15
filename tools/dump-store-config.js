/**
 * tools/dump-store-config.js — 把某个店铺在 goofish 页里【完整】的配置读出来（只读，不写）
 *
 * 为什么需要它：
 *   桌面发布台的「店铺配置」面板（publish_dashboard.js L3046-3095）只读 6 个字段
 *   （titleMode/price/stock/category/shipMode/subImg），而 localStorage 里实际躺着
 *   specs / commitment / locationMode / fixedCity / kun_tpl_<店> / kun_captured_sku。
 *   看不到的那几个恰恰是最容易出事的地方 —— 2026-10-07 就是这么发现
 *   「桌面引擎在代拍店用的是三档规格（¥50/¥500/¥800），而 CLI 是单档标准 ¥50」的。
 *
 *   另外它还单独把 kun_captured_sku 里的【规格 / 服务承诺 / 类目】解出来 ——
 *   那是闲鱼网页 UI 自己发的真实请求，是这些字段最权威的参照物
 *   （桌面引擎自己写的 serviceCode 映射与它对不上）。
 *
 * 用法:
 *   node tools/dump-store-config.js "好易美代拍"
 *   node tools/dump-store-config.js "好易美代拍" --raw      # 把每个键的原始值也打全（默认截断 800 字）
 *
 * 前置：店铺页必须已就绪，否则回「店铺未就绪」——
 *   node tools/store-ready.js "<店铺名>"
 */
const { post } = require('../lib/http');

const RAW = process.argv.indexOf('--raw') >= 0;
const STORE = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!STORE) { console.log('用法: node tools/dump-store-config.js "<店铺名>" [--raw]'); process.exit(2); }

const LIMIT = RAW ? 200000 : 800;

const CODE = `(function(){
  var out = { href: location.href, 键: [] };
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (/^kun_/.test(k)) out.键.push({ k: k, v: (localStorage.getItem(k) || '').slice(0, ${LIMIT}) });
  }
  // 单独解 kun_captured_sku 里与"发布字段"有关的部分（闲鱼自己的 UI 发的请求，最权威）
  out.发布字段参照 = null;
  try {
    var arr = JSON.parse(localStorage.getItem('kun_captured_sku') || '[]');
    out.发布字段参照 = arr.map(function (x) {
      var d = (x && x.data) || {};
      return {
        api: x.api, at: x.at,
        itemProperties: d.itemProperties || null,
        itemSkuList: d.itemSkuList || null,
        itemPriceDTO: d.itemPriceDTO === undefined ? '(缺)' : d.itemPriceDTO,
        quantity: d.quantity,
        userRightsProtocols: d.userRightsProtocols || null,
        itemPostFeeDTO: d.itemPostFeeDTO || null,
        itemCatDTO: d.itemCatDTO || null
      };
    });
  } catch (e) { out.发布字段参照 = '解析失败: ' + e.message; }
  return JSON.stringify(out);
})()`;

(async () => {
  const r = await post('/api/agent/eval-on-store', { store: STORE, code: CODE }, { timeout: 90000 });
  if (!r || r.ok !== true) {
    console.log('❌ 店铺页没就绪：' + String((r && r.error) || '').slice(0, 120));
    console.log('   → node tools/store-ready.js "' + STORE + '"');
    process.exit(1);
  }
  const d = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
  console.log('店铺: ' + STORE + '\n页面: ' + d.href + '\n');

  console.log('── localStorage 里的 kun_* 键（' + d.键.length + ' 个）──');
  for (const it of d.键) {
    console.log('\n● ' + it.k);
    // 单行、不换行太长时截到 LIMIT
    console.log('  ' + (it.v.length > 400 ? it.v.slice(0, 400) + ' …(+' + (it.v.length - 400) + '字，--raw 看全)' : it.v));
  }

  console.log('\n── 发布字段参照（从 kun_captured_sku 解出来，闲鱼 UI 自己发的请求）──');
  const ref = d.发布字段参照;
  if (!ref || !ref.length) console.log('  （没有抓包记录）');
  else for (const x of ref) {
    console.log('\n● ' + x.api + '  @' + x.at);
    console.log('  规格 itemProperties : ' + JSON.stringify(x.itemProperties));
    console.log('  规格 itemSkuList    : ' + JSON.stringify(x.itemSkuList));
    console.log('  itemPriceDTO       : ' + JSON.stringify(x.itemPriceDTO) + '   顶层 quantity: ' + JSON.stringify(x.quantity));
    console.log('  服务承诺            : ' + JSON.stringify(x.userRightsProtocols));
    console.log('  发货 itemPostFeeDTO : ' + JSON.stringify(x.itemPostFeeDTO));
    console.log('  类目 itemCatDTO     : ' + JSON.stringify(x.itemCatDTO));
  }
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
