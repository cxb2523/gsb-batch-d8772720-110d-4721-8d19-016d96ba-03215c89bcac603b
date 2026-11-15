/**
 * tools/set-item-addr.js —— 只改一条已有商品的「宝贝所在地」
 *
 * 为什么单独做（2026-11-13）：
 *   `tools/replace-item.js` 的设计是「换老链接只改标题/正文/主图」，所在地故意不动
 *   （换宝贝稽查看的是类目/价格/品牌/属性，乱动更容易被拒）。
 *   所以「老链接换成本地场次、但所在地还留在旧城市」需要一个只动 itemAddrDTO 的入口。
 *
 * 做法与 replace-item 完全一致（因为踩过的坑是同一套）：
 *   读 editdetail → 备份 → 结构字段原样回填 → 只替换 itemAddrDTO → mtop.idle.pc.idleitem.edit → 回读。
 *   无规格商品先补一档规格，否则编辑接口回 FAIL_BIZ_UN_CATCH_EXCEPTION::闲鱼太累啦～
 *
 * 用法:
 *   node tools/set-item-addr.js <itemId> --city=北京 [--area=朝阳区] [--store=店名] [--go]
 *   不加 --go 只预览（打印改前→改后，并写备份）。
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const storeProfile = require('../lib/store-profile');
const { ROOT, readJSON, STORE: ENV_STORE } = require('../lib/env');

const asObj = (r) => {
  if (r == null) return {};
  if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { _raw: r }; } }
  if (r.result !== undefined) return typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
  return r;
};

const argv = process.argv.slice(2);
const GET = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const GO = argv.includes('--go');
const ID = argv[0];
const CITY = GET('city', '');
const AREA = GET('area', '');
const STORE = GET('store', '') || ENV_STORE || '好易美代拍';

if (!ID || !CITY) {
  console.log('用法: node tools/set-item-addr.js <itemId> --city=北京 [--area=朝阳区] [--store=店名] [--go]');
  process.exit(2);
}

// 区池：lib/city-areas.json（901 条实测地址里挑出来的，带 divisionId + gps）
const AREAS = readJSON(path.join(ROOT, 'lib', 'city-areas.json')) || {};
const pool = AREAS[CITY] || [];
if (!pool.length) {
  console.log('❌ lib/city-areas.json 里没有「' + CITY + '」的区池。已登记的城市：' + Object.keys(AREAS).join(' / '));
  process.exit(1);
}
const hit = AREA ? pool.find((x) => x.area === AREA) : pool[0];
if (!hit) { console.log('❌ 「' + CITY + '」没有区「' + AREA + '」。可选：' + pool.map((x) => x.area).join(' / ')); process.exit(1); }

const NEW_ADDR = { area: hit.area, city: hit.city, divisionId: hit.divisionId, gps: hit.gps, poiId: '', poiName: '', prov: hit.prov };
const PROF = (() => { try { return storeProfile.load(STORE); } catch (e) { return {}; } })();

console.log('目标商品: ' + ID + '  （' + STORE + '）');
console.log('迁往: ' + hit.prov + '/' + hit.city + '/' + hit.area + '/' + hit.divisionId + '  gps=' + hit.gps);

(async () => {
  await agent.ready({ stores: [STORE], timeout: 240000 });

  const codeRead = `
    var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0', data: { itemId: ${JSON.stringify(ID)} }, type: 'GET' });
    var d = (r && r.data) || {};
    return JSON.stringify({ ret: r && r.ret, title: (d.itemTextDTO || {}).title, desc: (d.itemTextDTO || {}).desc,
      imgs: (d.imageInfoDOList || []).map(function (x) { return { extraInfo: x.extraInfo, isQrCode: x.isQrCode, url: x.url,
        h: x.heightSize, w: x.widthSize, major: String(x.major), type: x.type, status: x.status }; }),
      cat: d.itemCatDTO, addr: d.itemAddrDTO, sku: d.itemSkuList,
      carry: { itemProperties: d.itemProperties, itemSkuList: d.itemSkuList, itemAddrDTO: d.itemAddrDTO,
        itemCatDTO: d.itemCatDTO, itemLabelExtList: d.itemLabelExtList, itemPostFeeDTO: d.itemPostFeeDTO,
        userRightsProtocols: d.userRightsProtocols, quantity: d.quantity, simpleItem: d.simpleItem,
        itemTypeStr: d.itemTypeStr, freebies: d.freebies, defaultPrice: d.defaultPrice,
        itemPriceDTO: d.itemPriceDTO, properties: d.properties } });
  `;
  const cur = asObj(await agent.mtop(codeRead, { timeout: 120000 }));
  if (!cur.title) { console.log('❌ 读不到现状: ' + JSON.stringify(cur).slice(0, 300)); process.exit(1); }

  console.log('\n── 改前 ──');
  console.log('标题: ' + cur.title);
  console.log('所在地: ' + JSON.stringify(cur.addr));
  console.log('图: ' + (cur.imgs || []).length + ' 张  规格: ' + (cur.sku || []).length + ' 档  类目: ' + JSON.stringify(cur.cat));

  if (JSON.stringify(cur.addr) === JSON.stringify(NEW_ADDR)) { console.log('\n所在地已经是目标值，不用改。'); return; }

  // 备份
  const bakDir = path.join(ROOT, 'replace-backup');
  fs.mkdirSync(bakDir, { recursive: true });
  const bakFile = path.join(bakDir, ID + '-addr-' + Date.now() + '.json');
  fs.writeFileSync(bakFile, JSON.stringify(cur, null, 2), 'utf8');
  console.log('\n备份: ' + bakFile);

  const toDo = (o, isMajor) => ({
    extraInfo: o.extraInfo || { isH: 'false', isT: 'false', raw: 'false' },
    isQrCode: !!o.isQrCode, url: o.url,
    heightSize: String(o.h), widthSize: String(o.w),
    major: isMajor ? 'true' : 'false', type: String(o.type != null ? o.type : 0), status: 'done',
  });
  const imgList = (cur.imgs || []).map((x) => toDo(x, x.major === 'true'));

  // 无规格 → 补一档（同 replace-item 的教训）
  let skuAdd = null;
  if (!(Array.isArray(cur.sku) && cur.sku.length)) {
    const sp = (PROF.规格 && Array.isArray(PROF.规格.specs) && PROF.规格.specs.length) ? PROF.规格.specs : [{ valueText: '标准' }];
    const pn = (PROF.规格 && PROF.规格.propertyName) || '代拍费';
    const price = (PROF.价格 && PROF.价格.default != null) ? PROF.价格.default : 50;
    const stock = (PROF.库存 && PROF.库存.default != null) ? PROF.库存.default : 9999;
    skuAdd = {
      itemProperties: [{ propertyName: pn, supportImage: false, propertyValues: sp.map((x) => ({ propertyValue: x.valueText })) }],
      itemSkuList: sp.map((x) => ({
        priceInCent: String(Math.round(parseFloat(x.price != null ? x.price : price) * 100)),
        quantity: Number(x.quantity != null ? x.quantity : stock),
        propertyList: [{ propertyText: pn, valueText: x.valueText }],
      })),
      quantity: String(stock),
    };
    console.log('\n⚠️ 该链接无规格 → 本次会补一档：' + pn + '/' + sp[0].valueText + ' ¥' + (Number(skuAdd.itemSkuList[0].priceInCent) / 100));
  }

  const carry = {};
  for (const [k, v] of Object.entries(cur.carry || {})) if (v !== undefined && v !== null) carry[k] = v;

  console.log('\n── 改后 ──');
  console.log('所在地: ' + JSON.stringify(NEW_ADDR));
  console.log('标题/正文/图片/类目/规格: 一个字段都不动');

  if (!GO) { console.log('\n[未加 --go] 只预览，不写线上'); return; }

  const codeUpd = `
    var data = {
      itemId: ${JSON.stringify(ID)},
      freebies: false, itemTypeStr: 'b', quantity: String(${JSON.stringify(String(cur.quantity || '9999'))}), simpleItem: 'true',
      imageInfoDOList: ${JSON.stringify(imgList)},
      itemTextDTO: { desc: ${JSON.stringify(String(cur.desc || ''))}, title: ${JSON.stringify(String(cur.title || ''))}, titleDescSeparate: false },
      itemPriceDTO: {}, defaultPrice: false,
      itemCatDTO: ${JSON.stringify(cur.cat || {})},
      itemAddrDTO: ${JSON.stringify(NEW_ADDR)},
      uniqueCode: Date.now() + '_' + Math.random().toString(36).substring(2, 10),
      sourceId: 'pcMainPublish', bizcode: 'pcMainPublish', publishScene: 'pcMainPublish'
    };
    var SKU_ADD = ${JSON.stringify(skuAdd)};
    if (SKU_ADD) { data.itemProperties = SKU_ADD.itemProperties; data.itemSkuList = SKU_ADD.itemSkuList; data.quantity = SKU_ADD.quantity; }
    var CARRY = ${JSON.stringify(carry)};
    for (var k in CARRY) { if (CARRY[k] !== undefined && CARRY[k] !== null && data[k] === undefined) data[k] = CARRY[k]; }
    data.itemAddrDTO = ${JSON.stringify(NEW_ADDR)};
    var out = {};
    try {
      var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.edit', v: '1.0', data: data, type: 'POST' });
      out.ret = r && r.ret;
    } catch (e) { out.err = (e && (e.ret ? JSON.stringify(e.ret) : e.message)) || String(e); }
    return JSON.stringify(out);
  `;
  console.log('\n导航到编辑页…');
  try { await agent.evalOnStore('location.href=' + JSON.stringify('https://www.goofish.com/publish?itemId=' + ID) + '; "go"'); }
  catch (e) { console.log('  ⚠️ 导航异常（继续）: ' + e.message); }
  await new Promise((z) => setTimeout(z, 12000));

  const res = asObj(await agent.mtop(codeUpd, { timeout: 180000 }));
  console.log(JSON.stringify(res, null, 2));
  if (res.err) { console.log('❌ 改所在地失败（已备份）'); process.exit(1); }

  await new Promise((z) => setTimeout(z, 4000));
  const chk = asObj(await agent.mtop(codeRead, { timeout: 120000 }));
  // 回读的 addr 不带 poiId/poiName（空值被服务端省掉），比对时只比这五个有效字段
  const norm = (a) => {
    a = a || {};
    return JSON.stringify({ area: a.area, city: a.city, divisionId: a.divisionId, gps: a.gps, prov: a.prov });
  };
  console.log('\n回读标题: ' + chk.title);
  console.log('回读所在地: ' + JSON.stringify(chk.addr));
  console.log('所在地一致: ' + (norm(chk.addr) === norm(NEW_ADDR) ? '✅' : '❌'));
})().catch((e) => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
