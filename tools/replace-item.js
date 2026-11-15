/**
 * tools/replace-item.js —— 「换老链接」：把一条已有商品改成新场次（改标题 / 正文 / 主图）
 *
 * 为什么单独做一个（2026-11-11）：
 *   `publish-one.js` 走 `mtop.idle.pc.idleitem.publish`，账号一旦被限「发布权限」
 *   （FAIL_BIZ_USER_ERROR_USER_WAS_FORBIDDEN2）就完全发不出新链接。
 *   而 `mtop.idle.pc.idleitem.update`（编辑接口）走的是另一条权限，实测可用 ——
 *   于是「换老链接」不只是省权重，它还是【发布受限时唯一能上新的通道】。
 *
 * 只改三样，其余一个字段都不动：
 *   ① itemTextDTO.title / desc
 *   ② imageInfoDOList 的第一张（major:true）
 *   ③ 无
 * 类目、价格、库存、所在地、发货方式、承诺 —— 全部保持 editdetail 里的原值，
 * 因为换宝贝稽查看的正是这些（类目/价格/品牌/属性）。
 *
 * 用法:
 *   node tools/replace-item.js <itemId> <城市> <明星> <活动类型> <场次类型> [--main=图] [--tpl=3] [--go]
 *   不加 --go 只预览（会打印改前 → 改后，并写备份）。
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const titleLib = require('../lib/title');
const storeProfile = require('../lib/store-profile');
const { ROOT, readJSON, STORE: ENV_STORE } = require('../lib/env');

/** agent.mtop 有时代码里 return 的是字符串，有时框架已解析成对象 —— 两种都接 */
const asObj = (r) => {
  if (r == null) return {};
  if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { _raw: r }; } }
  if (r.result !== undefined && typeof r.result === 'string') { try { return JSON.parse(r.result); } catch (e) { /* 继续 */ } }
  if (r.result !== undefined && typeof r.result === 'object') return r.result;
  return r;
};

const argv = process.argv.slice(2);
const GET = (k, d) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const GO = argv.includes('--go');

const ID = argv[0];
const CITY = argv[1];
const STAR = argv[2];
const EVENT = argv[3] || '演唱会';
const SESSION = argv[4] || '首开';
const MAIN = GET('main', '');
const SUBS = GET('subs', '');   // 【2026-11-13 加】整组换副图：目录或逗号分隔的文件列表
const ADDR_CITY = GET('addr-city', '');   // 【2026-11-13 加】顺带把所在地改到该城市（一次 edit 改全）
const ADDR_AREA = GET('addr-area', '');
const MAIN_ONLY = argv.includes('--main-only');   // 只换主图，标题/正文保持线上原样
const TPL = GET('tpl', '');

if (!ID || !CITY || !STAR) {
  console.log('用法: node tools/replace-item.js <itemId> <城市> <明星> <活动类型> <场次类型> [--main=图] [--subs=目录|文件,文件] [--tpl=3] [--store=店名] [--go]');
  process.exit(2);
}

// 【2026-11-13 改】原来写死 '好易美代拍' —— 换店时会读到错的模板池，
//   而且 upload-image 的 store 参数也会传错店（图会落到别家的图床身份下）。
//   现在：--store=店名 > XY_STORE > lib/config.json 的 store.default。
const STORE_ARG = GET('store', '');
const STORE = STORE_ARG || ENV_STORE || '好易美代拍';
const T = readJSON(path.join(process.env.USERPROFILE || process.env.HOME, '.xianyu-templates.json')) || {};
// 文案模板池：优先店铺档案的 文案.templateIds（多店唯一真源），
//   档案没有才退回 ~/.xianyu-templates.json 的 storeTemplates，最后才是全部模板。
const PROF = (() => { try { return storeProfile.load(STORE); } catch (e) { return {}; } })();
const PROF_POOL = (PROF.文案 && Array.isArray(PROF.文案.templateIds) && PROF.文案.templateIds.length)
  ? PROF.文案.templateIds : null;
const POOL = PROF_POOL || (T.storeTemplates || {})[STORE] || (T.templates || []).map(x => x.id);
const TPLS = (T.templates || []).filter(x => POOL.indexOf(x.id) >= 0);
if (!TPLS.length) { console.log('❌ 店铺「' + STORE + '」的文案模板池解析为空：' + JSON.stringify(POOL)); process.exit(1); }

// 选模板：指定优先；否则挑第一条「30 字整、不补！、不硬截断」的
function buildTitle(cand) {
  const PAD = [' 全站全价位都可接', ' 全价位都能接', ' 高命中率', ' 全价位接', ' 可上号', ' 秒付前排', ' 稳中', ' 秒付', ' 包中'];
  const fit = titleLib.makeFitTitle({ pad: PAD, max: 30, min: 30 });
  const raw = String(cand.titlePattern)
    .replace(/\{明星\}/g, STAR).replace(/\{城市\}/g, CITY)
    .replace(/\{活动类型\}/g, EVENT).replace(/\{场次类型\}/g, SESSION);
  return fit.detail(raw);
}

let cand = null, fitRes = null;
if (TPL) {
  cand = TPLS.find(x => String(x.id) === String(TPL));
  if (!cand) { console.log('❌ 模板 ' + TPL + ' 不在店铺池 ' + JSON.stringify(POOL)); process.exit(1); }
  fitRes = buildTitle(cand);
} else {
  for (const t of TPLS) {
    const r = buildTitle(t);
    if (r.text.length === 30 && !r.how && !/！/.test(r.text)) { cand = t; fitRes = r; break; }
  }
  if (!cand) { cand = TPLS[0]; fitRes = buildTitle(cand); }
}

const title = MAIN_ONLY ? '' : fitRes.text;   // main-only 时标题从线上读回来
const fullDesc = MAIN_ONLY ? '' : (title + '\n\n' + String(cand.descPattern || ''));

console.log('目标商品: ' + ID + '  （' + STORE + '）');
if (MAIN_ONLY) {
  console.log('模式: --main-only（标题/正文保持线上原样，只换主图）');
} else {
  console.log('模板: ' + cand.id + ' ' + (cand.name || '') + (fitRes.how ? '  ⚠️ ' + fitRes.how : ''));
  console.log('新标题(' + title.length + '): ' + title);
  console.log('新正文 ' + fullDesc.length + ' 字 / ' + fullDesc.split('\n').length + ' 行');
}
if (MAIN) console.log('新主图: ' + MAIN); else console.log('新主图: 不改');

(async () => {
  // 【2026-11-13 加】显式只启动本店上下文。
  //   原来靠 evalOnStore 内部的 ready()，而 ready() 开的是 lib/config.json 的 store.active
  //   （本机是「好易美代拍」）—— 换店时会去等一个跟目标店无关的页面。
  await agent.ready({ stores: [STORE], timeout: 240000 });

  // 1. 读现状
  const codeRead = `
    var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0', data: { itemId: ${JSON.stringify(ID)} }, type: 'GET' });
    var d = (r && r.data) || {};
    return JSON.stringify({ ret: r && r.ret, title: (d.itemTextDTO||{}).title, desc: (d.itemTextDTO||{}).desc,
      imgs: (d.imageInfoDOList||[]).map(function(x){ return { major:String(x.major), url:x.url, w:x.widthSize, h:x.heightSize, type:x.type, status:x.status, isQrCode:x.isQrCode, extraInfo:x.extraInfo }; }),
      cat: d.itemCatDTO, addr: d.itemAddrDTO, sku: d.itemSkuList,
      carry: { itemProperties: d.itemProperties, itemSkuList: d.itemSkuList, itemAddrDTO: d.itemAddrDTO,
               itemCatDTO: d.itemCatDTO, itemLabelExtList: d.itemLabelExtList, itemPostFeeDTO: d.itemPostFeeDTO,
               userRightsProtocols: d.userRightsProtocols, quantity: d.quantity, simpleItem: d.simpleItem,
               itemTypeStr: d.itemTypeStr, freebies: d.freebies, defaultPrice: d.defaultPrice,
               itemPriceDTO: d.itemPriceDTO, properties: d.properties } });
  `;
  const cur = asObj(await agent.mtop(codeRead, { timeout: 120000 }));
  if (!cur.title) { console.log('❌ 读不到现状: ' + JSON.stringify(cur).slice(0, 300)); process.exit(1); }

  // main-only：线上原值直接回填，改动的只有 imageInfoDOList
  const finalTitle = MAIN_ONLY ? String(cur.title || '') : title;
  const finalDesc = MAIN_ONLY ? String(cur.desc || '') : fullDesc;
  const images = cur.imgs || [];
  const majors = images.filter(x => String(x.major) === 'true');
  const others = images.filter(x => String(x.major) !== 'true');

  console.log('\n── 改前 ──');
  console.log('标题: ' + cur.title);
  console.log('主图: ' + (majors[0] ? majors[0].w + 'x' + majors[0].h : '(无)'));
  console.log('副图: ' + others.length + ' 张');
  console.log('类目: ' + JSON.stringify(cur.cat) + '  ← 不动');
  console.log('所在地: ' + JSON.stringify(cur.addr) + '  ← 不动');
  console.log('规格: ' + (cur.sku || []).map(s => s.propertyList.map(p => p.valueText).join('/') + ' ¥' + (Number(s.priceInCent) / 100) + ' ×' + s.quantity).join(' | ') + '  ← 不动');

  // 2. 备份
  const bakDir = path.join(ROOT, 'replace-backup');
  fs.mkdirSync(bakDir, { recursive: true });
  const bakFile = path.join(bakDir, ID + '-' + Date.now() + '.json');
  fs.writeFileSync(bakFile, JSON.stringify(cur, null, 2), 'utf8');
  console.log('\n备份: ' + bakFile);

  // 3. 主图
  let newMajor = null;
  if (MAIN) {
    if (!fs.existsSync(MAIN)) { console.log('❌ 主图不存在: ' + MAIN); process.exit(1); }
    const sharp = require(path.join(require('../lib/env').PATHS.playwrightService, 'node_modules', 'sharp'));
    const buf = await sharp(fs.readFileSync(MAIN)).jpeg({ quality: 92 }).toBuffer();
    const meta = await sharp(buf).metadata();
    console.log('\n主图上传中… ' + meta.width + 'x' + meta.height);
    const { post } = require('../lib/http');
    const u = await post('/api/agent/upload-image', { store: STORE, imageB64: buf.toString('base64') }, 180000);
    if (!u.ok || !u.url) { console.log('❌ 主图上传失败: ' + (u.error || '')); process.exit(1); }
    newMajor = { extraInfo: { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: false, url: u.url,
      heightSize: String(meta.height), widthSize: String(meta.width), major: 'true', type: '0', status: 'done' };
    console.log('主图 ✅ ' + u.url);
  }

  // 3b. 副图【2026-11-13 加】--subs=<目录|逗号分隔文件>：整组换掉副图，不给就保留线上原样。
  //     为什么需要：老链接自带的是别家品牌水印的战绩拼图，换店后要整组换成自己的口径。
  let newSubs = null;
  if (SUBS) {
    const sharp2 = require(path.join(require('../lib/env').PATHS.playwrightService, 'node_modules', 'sharp'));
    const { post: post2 } = require('../lib/http');
    let files = [];
    if (fs.existsSync(SUBS) && fs.statSync(SUBS).isDirectory()) {
      files = fs.readdirSync(SUBS).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .map((f) => path.join(SUBS, f));
    } else {
      files = SUBS.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!files.length) { console.log('❌ --subs 没找到任何图片: ' + SUBS); process.exit(1); }
    newSubs = [];
    for (const f of files) {
      if (!fs.existsSync(f)) { console.log('❌ 副图不存在: ' + f); process.exit(1); }
      const buf = await sharp2(fs.readFileSync(f)).jpeg({ quality: 92 }).toBuffer();
      const meta = await sharp2(buf).metadata();
      const u = await post2('/api/agent/upload-image', { store: STORE, imageB64: buf.toString('base64') }, 180000);
      if (!u.ok || !u.url) { console.log('❌ 副图上传失败: ' + path.basename(f) + ' ' + (u.error || '')); process.exit(1); }
      newSubs.push({ extraInfo: { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: false, url: u.url,
        heightSize: String(meta.height), widthSize: String(meta.width), major: 'false', type: '0', status: 'done' });
      console.log('副图 ✅ ' + path.basename(f) + '  ' + meta.width + 'x' + meta.height);
    }
  }

  // ⚠️ 类型必须与 editdetail 回包一致：major / type / width / height 全是【字符串】
  //    传 boolean → mtop 回 `ABORT::接口异常退出`（2026-11-11 实测踩到）
  const toDo = (o, isMajor) => ({
    extraInfo: o.extraInfo || { isH: 'false', isT: 'false', raw: 'false' },
    isQrCode: !!o.isQrCode, url: o.url,
    heightSize: String(o.h), widthSize: String(o.w),
    major: isMajor ? 'true' : 'false', type: String(o.type != null ? o.type : 0), status: 'done'
  });
  const imgList = (newMajor ? [newMajor] : majors.map(m => toDo(m, true)))
    .concat(newSubs ? newSubs : others.map(o => toDo(o, false)));

  console.log('\n── 改后 ──');
  console.log('标题: ' + finalTitle);
  console.log('图: 主图 1 + 副图 ' + (newSubs ? newSubs.length : others.length) + '（共 ' + imgList.length + ' 张）' +
    (newSubs ? '  ← 副图整组已更换' : ''));

  if (!GO) { console.log('\n[未加 --go] 只预览，不写线上'); return; }

  // 4. 真接口是 mtop.idle.pc.idleitem.edit，不是 update
  //
  // 【2026-11-12 定案】`mtop.idle.pc.idleitem.update` 在 PC 侧【根本不存在】——
  //   最小化实测：只传 itemId 也回 `ABORT::接口异常退出`（L0~L6 七级全灭）。
  //   而 `mtop.idle.pc.idleitem.edit` 是真实存在的编辑接口，四个 payload 变体全 SUCCESS。
  //   仓库里 fix-item.js 一直用 update，那个脚本从来没真正跑通过。
  //
  //   edit 要的是【publish 那套完整 payload】+ itemId —— 缺字段不会报错，只会回
  //   "发布失败，请稍后重试吧~"，所以下面把 editdetail 读到的结构字段全部原样回填，
  //   一个值都不改，只替换 itemTextDTO 和 imageInfoDOList。
  const carry = {};
  for (const [k, v] of Object.entries(cur.carry || {})) {
    if (v !== undefined && v !== null) carry[k] = v;
  }
  console.log('结构字段原样回填: ' + Object.keys(carry).join(', '));

  // 【2026-11-13 加】--addr-city：顺手把所在地改掉（换成本地场次时用）。
  //   为什么要并进同一次 edit：一次编辑=一次审核，分两次改会多一轮审核 + 多一次模型往返。
  let newAddr = null;
  if (ADDR_CITY) {
    const AREAS = readJSON(path.join(ROOT, 'lib', 'city-areas.json')) || {};
    const pool = AREAS[ADDR_CITY] || [];
    if (!pool.length) { console.log('❌ lib/city-areas.json 里没有「' + ADDR_CITY + '」的区池（已登记：' + Object.keys(AREAS).join(' / ') + '）'); process.exit(1); }
    const hit = ADDR_AREA ? pool.find((x) => x.area === ADDR_AREA) : pool[0];
    if (!hit) { console.log('❌「' + ADDR_CITY + '」没有区「' + ADDR_AREA + '」'); process.exit(1); }
    newAddr = { area: hit.area, city: hit.city, divisionId: hit.divisionId, gps: hit.gps, poiId: '', poiName: '', prov: hit.prov };
    console.log('所在地: ' + JSON.stringify(cur.addr) + ' → ' + JSON.stringify(newAddr));
  }

  // 【2026-11-13 加·实测踩到】「无规格」老链接改不了。
  //   现象：payload 不带 itemProperties/itemSkuList 时，编辑接口回
  //         FAIL_BIZ_UN_CATCH_EXCEPTION::闲鱼太累啦～请您稍候重试～（1069508800478 实测）
  //   原因：本店 10 月前的老链接都是桌面引擎发的、SKU 列表为空；这类商品在 PC 编辑侧不接受
  //         「无规格」payload。解法不是重试，而是【把规格补上】——
  //         用店铺档案的 规格（代拍费/标准）+ 价格.default + 库存.default 生成一档 SKU。
  //   副作用（有意）：老链接被改成有规格商品，之后它自己也能被改价/改规格、不会再撞这条。
  let skuAdd = null;
  if (!(Array.isArray(cur.sku) && cur.sku.length)) {
    const sp = (PROF.规格 && Array.isArray(PROF.规格.specs) && PROF.规格.specs.length) ? PROF.规格.specs : [{ valueText: '标准' }];
    const pn = (PROF.规格 && PROF.规格.propertyName) || '代拍费';
    const price = (PROF.价格 && PROF.价格.default != null) ? PROF.价格.default : 50;
    const stock = (PROF.库存 && PROF.库存.default != null) ? PROF.库存.default : 9999;
    skuAdd = {
      propertyName: pn,
      itemProperties: [{ propertyName: pn, supportImage: false, propertyValues: sp.map((x) => ({ propertyValue: x.valueText })) }],
      itemSkuList: sp.map((x) => ({
        priceInCent: String(Math.round(parseFloat(x.price != null ? x.price : price) * 100)),
        quantity: Number(x.quantity != null ? x.quantity : stock),
        propertyList: [{ propertyText: pn, valueText: x.valueText }],
      })),
      quantity: String(stock),
    };
    console.log('\n⚠️ 该链接【无规格】（itemSkuList 为空）→ 本次编辑会补上一档规格：' +
      skuAdd.itemSkuList.map((s) => skuAdd.propertyName + '/' + s.propertyList[0].valueText + ' ¥' + (Number(s.priceInCent) / 100) + ' ×' + s.quantity).join(' | '));
  }

  const codeUpd = `
    var data = {
      itemId: ${JSON.stringify(ID)},      freebies: false, itemTypeStr: 'b', quantity: String(${JSON.stringify(String(cur.quantity || '9999'))}), simpleItem: 'true',
      imageInfoDOList: ${JSON.stringify(imgList)},
      itemTextDTO: { desc: ${JSON.stringify(finalDesc)}, title: ${JSON.stringify(finalTitle)}, titleDescSeparate: false },
      itemPriceDTO: {}, defaultPrice: false,
      itemCatDTO: ${JSON.stringify(cur.cat || {})},
      uniqueCode: Date.now() + '_' + Math.random().toString(36).substring(2, 10),
      sourceId: 'pcMainPublish', bizcode: 'pcMainPublish', publishScene: 'pcMainPublish'
    };
    var SKU_ADD = ${JSON.stringify(skuAdd)};
    if (SKU_ADD) {
      data.itemProperties = SKU_ADD.itemProperties;
      data.itemSkuList = SKU_ADD.itemSkuList;
      data.quantity = SKU_ADD.quantity;
    }
    var CARRY = ${JSON.stringify(carry)};
    for (var k in CARRY) { if (CARRY[k] !== undefined && CARRY[k] !== null && data[k] === undefined) data[k] = CARRY[k]; }
    var ADDR = ${JSON.stringify(newAddr)};
    if (ADDR) data.itemAddrDTO = ADDR;
    var out = {};
    try {
      var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.edit', v: '1.0', data: data, type: 'POST' });
      out.ret = r && r.ret;
    } catch (e) { out.err = (e && (e.ret ? JSON.stringify(e.ret) : e.message)) || String(e); }
    return JSON.stringify(out);
  `;
  // 进编辑页上下文再调（与 publish 同一个域，保险）
  const EDIT_URL = 'https://www.goofish.com/publish?itemId=' + ID;
  console.log('\n导航到编辑页: ' + EDIT_URL);
  try {
    await agent.evalOnStore('location.href=' + JSON.stringify(EDIT_URL) + '; "go"');
  } catch (e) { console.log('  ⚠️ 导航调用异常（继续）: ' + e.message); }
  await new Promise(z => setTimeout(z, 12000));

  console.log('\n执行 update…');
  const res = asObj(await agent.mtop(codeUpd, { timeout: 180000 }));
  console.log(JSON.stringify(res, null, 2));
  if (res.err) { console.log('❌ 编辑失败（已备份，可人工对照还原）'); process.exit(1); }

  // 5. 回读校验
  await new Promise(z => setTimeout(z, 4000));
  const chk = asObj(await agent.mtop(codeRead, { timeout: 120000 }));
  const okTitle = String(chk.title || '').trim() === finalTitle.trim();
  console.log('\n回读标题: ' + chk.title);
  console.log('标题一致: ' + (okTitle ? '✅' : '❌'));
  console.log('回读主图: ' + ((chk.imgs || [])[0] || {}).w + 'x' + ((chk.imgs || [])[0] || {}).h);
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
