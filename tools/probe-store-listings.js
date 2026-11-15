/**
 * tools/probe-store-listings.js — 只读：把某个店铺的在售商品全量拉出来做风格分析
 *
 * 用途（2026-10-07 接「好易美票务Hope」）：
 *   新店要接自动化，第一步是**照它现有的链接反推文案/主图模板**，而不是凭空造。
 *   这个脚本给三样东西：
 *     ① 全量在售清单（itemId / 价格 / 销量 / 发布日 / 标题）
 *     ② 标题风格统计（前缀分布、字数分布）—— 用来定 titlePattern
 *     ③ 抽样打开商品页，读**描述正文**和**图片张数**（判断有没有副图）
 *
 * 为什么用「在售可投池」而不是 `mtop.idle.web.xyh.item.list`：
 *   后者要传卖家 userId（好易美代拍是 2507674944），换店就得先查 userId；
 *   前者是按会话走的，不传 userId 也只会返回**当前店铺**的商品 —— 换店零成本。
 *
 * ⚠️ 直连 HTTP，不用 lib/agent 的 evalOnStore（后者会触发 ready() 把店铺切走）。
 *
 * 用法:
 *   node tools/probe-store-listings.js "好易美票务Hope"
 *   node tools/probe-store-listings.js "好易美票务Hope" --desc=3     # 抽样 3 条读描述+数图片
 */
const path = require('path');
const fs = require('fs');
const { post } = require('../lib/http');
const { ROOT } = require('../lib/env');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? Number(a.split('=')[1]) : d; };
const NAMES = argv.filter((a) => a && !a.startsWith('--'));
const DESC_N = argOf('desc', 0);
const IDS_ARG = (argv.find((x) => x.startsWith('--ids=')) || '').split('=')[1] || '';
const IDS = IDS_ARG ? IDS_ARG.split(',').map((s) => s.trim()).filter(Boolean) : [];
if (!NAMES.length) { console.log('用法: node tools/probe-store-listings.js "<店铺名>" [--desc=3]'); process.exit(2); }
const NAME = NAMES[0];

const LIST = `(async function(){ try{
  var r = await window.lib.mtop.request({api:'mtop.taobao.idle.ad.item.searchV2',v:'1.0',type:'POST',
    data:{requestJson:JSON.stringify({pageNum:1,pageSize:200,tab:'all',needTabs:true})}});
  if(!(r&&r.ret&&String(r.ret[0]).indexOf('SUCCESS')===0)) return JSON.stringify({err:r&&r.ret});
  var d = (r.data||{}).result || r.data || {};
  return JSON.stringify((d.itemList||[]).map(function(i){ return {
    itemId:String(i.itemId), title:String(i.title||''), price:i.price, saleCnt:i.saleCnt,
    imgUrl:String(i.imgUrl||''),
    tags:(i.tags||[]).join(','), publishTime:i.publishTime, catId:i.catId, supportAd:i.supportAd,
    notSupport:(i.notSupportAdInfo||[]).map(function(x){return x.notSupportReason;}).join(',') }; }));
}catch(e){ return JSON.stringify({err:String((e&&e.message)||e)}); } })()`;

/**
 * 打开【卖家编辑页】而不是买家页。
 * 为什么：买家页有「猜你喜欢」推荐位，别人的商品图会混进来 ——
 * 实测买家页数出 50~65 张（全是别人的），完全没法判断有没有副图。
 * 编辑页是卖家表单，只有这条商品自己的图。
 */
const DETAIL = (id) => `(async function(){
  location.href = 'https://www.goofish.com/publish?itemId=${id}';
  return 'nav';
})()`;

const READ_PAGE = `(async function(){
  for (var i=0;i<30;i++){ if ((document.body.innerText||'').length > 600) break; await new Promise(function(r){setTimeout(r,900);}); }
  await new Promise(function(r){setTimeout(r,2500);});
  var out = { href: location.href, title: document.title };
  var urls = {}, real = [];
  [].slice.call(document.querySelectorAll('img')).forEach(function(e){
    var s = String(e.currentSrc||e.src||'');
    var m = s.match(/(O1CN[^_.]+)/);
    if (!m) return;
    urls[m[1]] = (urls[m[1]]||0) + 1;
    // 真·商品图：闲鱼图床的商品图 URL 一定带这些后缀之一，UI 图标不带。
    //   -0-fleamarket / -0-xy_item 是两种上传路径（实测：本工具发的是 fleamarket，
    //   店里老链接是 xy_item），少认一个就会把老链接数成 0 张图。
    if (/(-0-fleamarket|-0-xy_item)/.test(s) && real.indexOf(m[1]) < 0) real.push(m[1]);
  });
  out.图片去重数 = Object.keys(urls).length;
  out.商品图数 = real.length;
  out.商品图 = real;
  out.图片 = Object.keys(urls).slice(0, 12);
  // 描述：编辑页里是 textarea / contenteditable
  var ta = [].slice.call(document.querySelectorAll('textarea')).map(function(e){return e.value;}).filter(function(v){return v && v.length>30;});
  var ce = [].slice.call(document.querySelectorAll('[contenteditable=true]')).map(function(e){return e.innerText;}).filter(function(v){return v && v.length>30;});
  out.描述原文 = (ta.concat(ce))[0] || null;
  var body = document.body.innerText||'';
  out.正文前900 = body.replace(/\\n{2,}/g,'\\n').slice(0,900);
  return JSON.stringify(out);
})()`;

async function ev(code, t, parse) {
  const r = await post('/api/agent/eval-on-store', { store: NAME, code }, { timeout: t || 120000 });
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'eval 失败');
  if (parse === false) return r.result;
  return typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
}

/** 导航到商品页：返回值不是 JSON，而且导航会销毁执行上下文 —— 所以不解析、不纠结报错 */
async function gotoItem(id) {
  await ev(DETAIL(id), 60000, false).catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));
}

/** 读商品页：导航刚结束时 evaluate 会撞上「Execution context was destroyed」，要重试 */
async function readItem() {
  let lastErr = null;
  for (let i = 1; i <= 4; i++) {
    try { return await ev(READ_PAGE, 120000); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 4000)); }
  }
  throw lastErr;
}

(async () => {
  await post('/api/agent/switch', { storeName: NAME }, { timeout: 180000 });
  await ev('location.href=location.href;"r"', 60000).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  const items = await ev(LIST, 180000);
  if (!Array.isArray(items)) { console.log('❌ 拉清单失败: ' + JSON.stringify(items).slice(0, 200)); process.exit(1); }

  console.log('════ ' + NAME + ' 在售 ' + items.length + ' 条 ════\n');
  console.log('itemId          价格      销量 发布日      标题');
  console.log('-'.repeat(112));
  items.forEach((it) => {
    const d = it.publishTime ? new Date(Number(it.publishTime)) : null;
    const ds = d && !isNaN(d) ? (d.getMonth() + 1) + '/' + d.getDate() : '—';
    console.log(String(it.itemId).padEnd(16) + ('¥' + (Number(it.price || 0) / 100).toFixed(2)).padEnd(10) +
      String(it.saleCnt == null ? '—' : it.saleCnt).padEnd(5) + ds.padEnd(12) + it.title);
  });

  // 标题风格统计
  const pre = {};
  let lenSum = 0;
  items.forEach((it) => {
    const m = it.title.match(/^【[^】]+】/);
    const k = m ? m[0] : '(无【】前缀)';
    pre[k] = (pre[k] || 0) + 1;
    lenSum += it.title.length;
  });
  console.log('\n标题前缀分布:');
  Object.keys(pre).sort((a, b) => pre[b] - pre[a]).forEach((k) => console.log('  ' + String(pre[k]).padStart(3) + '  ' + k));
  console.log('平均标题字数: ' + (lenSum / items.length).toFixed(1));
  const prices = {};
  items.forEach((it) => { const p = (Number(it.price || 0) / 100).toFixed(0); prices[p] = (prices[p] || 0) + 1; });
  console.log('价格分布(元): ' + JSON.stringify(prices));
  const dates = {};
  items.forEach((it) => { const d = it.publishTime ? new Date(Number(it.publishTime)) : null; if (d && !isNaN(d)) { const k = (d.getMonth() + 1) + '/' + d.getDate(); dates[k] = (dates[k] || 0) + 1; } });
  console.log('发布日分布: ' + JSON.stringify(dates));

  if (process.argv.includes('--img')) {
    console.log('\nitemId          主图URL');
    console.log('-'.repeat(112));
    items.forEach((it) => console.log(String(it.itemId).padEnd(16) + (it.imgUrl || '(无)')));
  }

  if (DESC_N > 0 || IDS.length) {
    console.log('\n════ 抽样读描述 + 数图片 ════');
    let picks;
    if (IDS.length) {
      picks = IDS.map((id) => items.find((x) => x.itemId === id) || { itemId: id, title: '(不在在售清单里)' });
    } else {
      const step = Math.max(1, Math.floor(items.length / DESC_N));
      picks = [];
      for (let i = 0; i < items.length && picks.length < DESC_N; i += step) picks.push(items[i]);
    }
    for (const it of picks) {
      console.log('\n──── ' + it.itemId + '  ' + it.title.slice(0, 40));
      try {
        await gotoItem(it.itemId);
        const d = await readItem();
        console.log('  ★商品图数(带 -0-fleamarket): ' + d.商品图数 + '   全页图去重=' + d.图片去重数);
        (d.商品图 || []).forEach((h, i) => console.log('      ' + (i === 0 ? '主图' : '副图' + i) + '  ' + h));
        console.log('  描述原文: ' + (d.描述原文 ? d.描述原文.slice(0, 500).replace(/\n/g, ' ⏎ ') : '(读不到，下面是正文片段)'));
        if (!d.描述原文) console.log('     ' + String(d.正文前900 || '').slice(0, 400).replace(/\n/g, ' | '));
      } catch (e) { console.log('  ❌ ' + e.message); }
    }
  }
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
