/**
 * tools/list-onsale.js —— 拉全店【在售】清单，可按关键词筛
 *
 * 为什么需要它（2026-10-13）：
 *   老板说「下架 贵阳王力宏 / 南京华晨宇 / 北京IEM / 香港Desire4 / 南宁许嵩」。
 *   要下架就得先知道**哪些还在售** —— 台账里的 `状态` 字段大多是空的/过期的
 *   （有的标着"已下架重发"其实早下过，有的是重发后的新链）。
 *   唯一的真值是平台的在售清单，也就是闲鱼商品管理页用的那个接口：
 *     `mtop.idle.web.xyh.item.list`（userId=2507674944、分组「综合」）
 *   `find-new-group.js` 用的也是它，但那边把关键词写死成"南京/wuuhaa"了。
 *   这里做成可传关键词的通用版，省得每次下架都重写一遍探针。
 *
 * 用法:
 *   node tools/list-onsale.js                      # 只看总数
 *   node tools/list-onsale.js 许嵩 王力宏           # 按关键词筛（多个 = 任一命中）
 *   node tools/list-onsale.js --all                # 打印全部在售（含 id + 标题）
 *
 * ⚠️ 它只读。下架是另一个工具：`node do-offshelf.js <itemId>...`（只点「下架」，绝不删除）
 */
const agent = require('../lib/agent');

// ⚠️【2026-11-12 修】userId 原来写死成 '2507674944'（好易美代拍）。
//   多店场景下这个数是错的：设了 XY_STORE=超能水手代拍 再跑，拉回来的还是好易美的 51 条。
//   现在按优先级取：--user-id > XY_USER_ID > 店铺档案的「闲鱼userId」。
//   档案里没配就【报错并给出怎么补】，而不是默默查错店。
const _args = process.argv.slice(2);
const _opt = (k) => { const h = _args.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : ''; };
const USER_ID = (() => {
  const fromArg = _opt('user-id');
  if (fromArg) return String(fromArg);
  if (process.env.XY_USER_ID) return String(process.env.XY_USER_ID);
  try {
    const profile = require('../lib/store-profile');
    const storeName = process.env.XY_STORE || require('../lib/env').STORE;
    const p = profile.load(storeName);
    if (p && p.闲鱼userId) return String(p.闲鱼userId);
    console.log('❌ 店铺「' + storeName + '」的档案里没有「闲鱼userId」。');
    console.log('   它是闲鱼账号的数字 id（好易美代拍的是 2507674944），在登录后的店铺页里能抓到。');
    console.log('   补法：在 stores/' + storeName + '.json 里加一行  "闲鱼userId": "<那串数字>",');
    console.log('   或者临时跑：node tools/list-onsale.js --user-id=<数字>');
    process.exit(2);
  } catch (e) {
    console.log('❌ 读店铺档案失败：' + (e && e.message || e));
    process.exit(2);
  }
})();

const argv = process.argv.slice(2);
const SHOW_ALL = argv.includes('--all');
const KEYS = argv.filter((a) => !a.startsWith('--'));
/** --ids=a,b,c —— 只核这几个 id 的状态（下架后复核用） */
const IDS = (() => {
  const h = argv.find((a) => a.startsWith('--ids='));
  return h ? h.slice(6).split(',').map((x) => x.trim()).filter(Boolean) : [];
})();

// ⚠️ agent.mtop 已经套好 `(async()=>{const mtop=window.lib.mtop; <这里> })()`，
//    所以下面【只写函数体】、结尾 return —— 别再套一层 IIFE，
//    也别再声明 mtop（会重复声明直接语法错）。这个坑踩过一次。
const CODE = `
  const API = 'mtop.idle.web.xyh.item.list';
  const BASE = { needGroupInfo: false, userId: ${JSON.stringify(USER_ID)}, pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true };
  const out = [];
  let pages = 0;
  for (let p = 1; p <= 12; p++) {
    let r;
    try { r = await mtop.request({ api: API, v: '1.0', type: 'POST', data: Object.assign({}, BASE, { pageNumber: p }) }); }
    catch (e) { return JSON.stringify({ err: String((e && (e.ret || e.message)) || e), got: out.length }); }
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) {
      return JSON.stringify({ ret: (r && r.ret) || null, got: out.length });
    }
    const cards = ((r.data || {}).cardList) || [];
    if (!cards.length) break;
    pages++;
    cards.forEach(function(c){
      const cd = c.cardData || {};
      if (!cd.id) return;
      out.push({ id: String(cd.id), title: String(cd.title || ''), status: cd.itemStatus,
                 price: ((cd.priceInfo || {}).price) || '' });
    });
    if (cards.length < 20) break;
  }
  return JSON.stringify({ total: out.length, pages: pages, items: out });
`;

(async () => {
  const r = await agent.mtop(CODE, { timeout: 180000 });
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  if (!d || d.err || d.ret) {
    console.log('❌ 拉在售失败: ' + JSON.stringify(d || r).slice(0, 300));
    console.log('   （页面可能不在 goofish 域。可先 node tools/ensure-agent.js）');
    process.exit(1);
  }
  console.log('全店商品: ' + d.total + ' 条（' + d.pages + ' 页）');
  // 【2026-10-13 修·口径错误】这个接口返回的 cardList 里**同时含已下架的**，
  //   靠 `itemStatus` 区分：0 = 在售，1 = 已下架（其余值按未知处理）。
  //   我第一版直接把总数当"在售"报出去，于是把已下架的也算进去了，
  //   还据此说过"在售 88 → 78 → 71"—— 那个口径是错的，特此更正。
  const onSale = d.items.filter((x) => Number(x.status) === 0);
  const offShelf = d.items.filter((x) => Number(x.status) === 1);
  const other = d.items.filter((x) => Number(x.status) !== 0 && Number(x.status) !== 1);
  console.log('  ├ 在售(status=0): ' + onSale.length + ' 条');
  console.log('  ├ 已下架(status=1): ' + offShelf.length + ' 条');
  if (other.length) {
    // 【2026-10-14 修·标签撒谎】原来关键词分支里写的是 `status===0 ? '在售' : '已下架'`
    //   —— 于是 status=-9（实测是【已删除/审核未过】那一档）被显示成"已下架"。
    //   这与"把列表总数当在售"是同一类错：字段语义没弄清就贴标签。
    const byStatus = {};
    other.forEach((x) => { byStatus[x.status] = (byStatus[x.status] || 0) + 1; });
    console.log('  └ 其它状态: ' + other.length + ' 条（' +
      Object.keys(byStatus).map((k) => k + '×' + byStatus[k]).join(', ') +
      '）—— 实测 -9 = 已删除/审核未过，**不是在售也不是已下架**');
  }
  console.log('');

  if (IDS.length) {
    // 只核指定 id —— 下架/上架后的复核用（比看总数字可靠：总数字口径容易弄错）
    const byId = new Map(d.items.map((x) => [x.id, x]));
    let on = 0, off = 0, miss = 0;
    console.log('── 指定 id 的状态复核 ──');
    IDS.forEach((id) => {
      const x = byId.get(id);
      if (!x) { miss++; console.log('   ❓ 列表里找不到 ' + id + '（可能已彻底删除，或不在「综合」分组）'); return; }
      const st = Number(x.status);
      if (st === 0) { on++; console.log('   🟢 仍在售 ' + id + '  ' + x.title.slice(0, 42)); }
      else if (st === 1) { off++; console.log('   ⚪ 已下架 ' + id + '  ' + x.title.slice(0, 42)); }
      else { console.log('   ❔ status=' + x.status + ' ' + id + '  ' + x.title.slice(0, 42)); }
    });
    console.log('');
    console.log('   已下架 ' + off + ' / 仍在售 ' + on + ' / 找不到 ' + miss + '（共 ' + IDS.length + ' 个）');
    if (on) { console.log('   🔴 有 ' + on + ' 个还没下架 —— 这就是要重跑 do-offshelf.js 的清单'); process.exitCode = 1; }
    return;
  }

  if (KEYS.length) {
    KEYS.forEach((k) => {
      const hit = d.items.filter((x) => x.title.indexOf(k) >= 0);
      const inSale = hit.filter((x) => Number(x.status) === 0);
      console.log('── 含「' + k + '」: 命中 ' + hit.length + ' 条，其中**在售 ' + inSale.length + ' 条** ──');
      hit.forEach((x) => {
        const st = Number(x.status);
        // 别再写 `st===0 ? 在售 : 已下架` —— -9 会被误标成"已下架"（已踩过）
        const tag = st === 0 ? '🟢在售  ' : st === 1 ? '⚪已下架' : ('❔状态' + x.status);
        console.log('   ' + tag + ' ' + x.id + '  ' + x.title.slice(0, 44));
      });
      if (!hit.length) console.log('   （完全没有 —— 连已下架的都没有）');
    });
  } else if (SHOW_ALL) {
    onSale.forEach((x) => console.log('   ' + x.id + '  ' + x.title.slice(0, 50)));
  } else {
    console.log('（想看明细：传关键词，或加 --all 列在售）');
  }
  console.log('');
  console.log('要下架: node do-offshelf.js <itemId> <itemId> ...   （只点「下架」，可逆）');
})();
