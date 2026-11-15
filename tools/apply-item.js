/**
 * tools/apply-item.js —— 一次性把「主图 + 标题 + 正文」写到已发布商品（走真接口 edit）
 *
 * 与 replace-item.js 的区别：这个【不做模板推导，完全按给定内容写】。
 * 场景：出图脚本已经产出成品图（带版式），文案也已经定稿，只需要落线上。
 *
 * 用法:
 *   node tools/apply-item.js <itemId> --main=<图> --title="<标题>" --descFile=<正文文件> [--go]
 *   正文文件是 UTF-8 纯文本（第一行会自动被当成卡片标题，所以正文里不要重复标题）
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const { PATHS } = require('../lib/env');

const A = {};
const argv = process.argv.slice(2);
const ID = argv[0];
argv.slice(1).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});
const GO = argv.includes('--go');

if (!ID || !A.title || !A.descFile) {
  console.log('用法: node tools/apply-item.js <itemId> --main=<图> --title="<标题>" --descFile=<正文文件> [--go]');
  process.exit(2);
}

const TITLE = String(A.title);
const BODY = fs.readFileSync(A.descFile, 'utf8').replace(/\r\n/g, '\n').trim();
const FULL = TITLE + '\n\n' + BODY;

console.log('目标: ' + ID);
console.log('标题(' + TITLE.length + '): ' + TITLE);
if (TITLE.length > 30) { console.log('❌ 标题超过 30 字（闲鱼硬上限，会从尾部静默砍）'); process.exit(1); }
console.log('正文 ' + BODY.length + ' 字 / ' + BODY.split('\n').length + ' 行');
console.log('全文 ' + FULL.length + ' 字');
console.log('主图: ' + (A.main || '(不改)'));
console.log('\n--- 正文 ---\n' + BODY + '\n-----------\n');

const asObj = (r) => {
  if (r == null) return {};
  if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { _raw: r }; } }
  if (r.result !== undefined && typeof r.result === 'string') { try { return JSON.parse(r.result); } catch (e) { return r; } }
  if (r.result !== undefined && typeof r.result === 'object') return r.result;
  return r;
};

const READ = `
  var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0', data: { itemId: ${JSON.stringify(ID)} }, type: 'GET' });
  var d = (r && r.data) || {};
  return JSON.stringify({ title: (d.itemTextDTO||{}).title, desc: (d.itemTextDTO||{}).desc,
    imgs: (d.imageInfoDOList||[]), cat: d.itemCatDTO, addr: d.itemAddrDTO, sku: d.itemSkuList,
    label: d.itemLabelExtList, post: d.itemPostFeeDTO, rights: d.userRightsProtocols,
    qty: d.quantity, simple: d.simpleItem, type: d.itemTypeStr, free: d.freebies,
    dp: d.defaultPrice, price: d.itemPriceDTO, props: d.properties });
`;

(async () => {
  const cur = asObj(await agent.mtop(READ, { timeout: 120000 }));
  if (!cur.title) { console.log('❌ 读不到现状'); process.exit(1); }
  console.log('线上现标题: ' + cur.title);

  // ⛔【2026-11-12 加·血的教训】改之前必须备份。
  //   事故：apply-item 第一版没有备份，误把 1067404891764（33561 浏览 / 26 笔成交 /
  //   ¥21523.95 成交额的主力万能链接）改成了王嘉尔场次，**2480 字原正文永久丢失**。
  //   老板原话：「你改造老链接，不能拿我正在上架的链接改啊」。
  //   两条规矩一起立：
  //     ① 脚本层：动线上之前无条件写备份（下面这段）
  //     ② 业务层：只改【已过场 / 已停用】的链接，别碰正在出单的主力
  {
    const bakDir = path.join(__dirname, '..', 'replace-backup');
    fs.mkdirSync(bakDir, { recursive: true });
    const bakFile = path.join(bakDir, ID + '-' + Date.now() + '.json');
    fs.writeFileSync(bakFile, JSON.stringify(cur, null, 2), 'utf8');
    console.log('备份: ' + bakFile + '   （原标题/正文/' + ((cur.imgs || []).length) + ' 张图/地址 全部在内）');
  }

  const images = cur.imgs || [];
  const majors = images.filter(x => String(x.major) === 'true');
  const others = images.filter(x => String(x.major) !== 'true');

  const toDo = (o, isMajor) => ({
    extraInfo: o.extraInfo || { isH: 'false', isT: 'false', raw: 'false' },
    isQrCode: !!o.isQrCode, url: o.url,
    heightSize: String(o.h != null ? o.h : o.heightSize),
    widthSize: String(o.w != null ? o.w : o.widthSize),
    major: isMajor ? 'true' : 'false', type: '0', status: 'done'
  });

  let newMajor = null;
  if (A.main) {
    if (!fs.existsSync(A.main)) { console.log('❌ 主图不存在: ' + A.main); process.exit(1); }
    const sharp = require(path.join(PATHS.playwrightService, 'node_modules', 'sharp'));
    const buf = await sharp(fs.readFileSync(A.main)).jpeg({ quality: 92 }).toBuffer();
    const meta = await sharp(buf).metadata();
    const { post } = require('../lib/http');
    const u = await post('/api/agent/upload-image', { store: '好易美代拍', imageB64: buf.toString('base64') }, 180000);
    if (!u.ok || !u.url) { console.log('❌ 主图上传失败: ' + (u.error || '')); process.exit(1); }
    newMajor = { extraInfo: { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: false, url: u.url,
      heightSize: String(meta.height), widthSize: String(meta.width), major: 'true', type: '0', status: 'done' };
    console.log('主图 ✅ ' + meta.width + 'x' + meta.height + '  ' + u.url);
  }

  const imgList = (newMajor ? [newMajor] : majors.map(m => toDo(m, true)))
    .concat(others.map(o => toDo(o, false)));

  // ⚠️【2026-11-12 修】无规格商品不能传 itemSkuList / 空 itemPriceDTO
  //   事故：改造 1067404891764（长沙那条 9435 浏览的老链接）连续两次
  //   `FAIL_BIZ_UN_CATCH_EXCEPTION::闲鱼太累啦～请您稍候重试～`
  //   看着像限流，其实是字段问题：那条 SKU 数 = 0（单一口价 ¥45），
  //   而脚本照样发了 itemSkuList: [] + itemPriceDTO: {} →
  //   平台判定「声明要规格却没给规格」。
  //   判据：editdetail 的 itemSkuList.length。>0 走规格模式，=0 走一口价模式。
  const hasSku = Array.isArray(cur.sku) && cur.sku.length > 0;
  const priceDTO = hasSku ? {} : (cur.price || { priceInCent: '5000' });

  const carry = {
    itemCatDTO: cur.cat,
    itemLabelExtList: cur.label, itemPostFeeDTO: cur.post, userRightsProtocols: cur.rights,
    quantity: cur.qty, simpleItem: cur.simple, itemTypeStr: cur.type,
    freebies: cur.free, defaultPrice: cur.dp, properties: cur.props
  };
  if (hasSku) carry.itemSkuList = cur.sku;   // 只有真有规格才带
  // --addrCity=广州 ：把所在地改到该城市（改造外地老链接时必用，否则标题写广州、所在地还是长沙）
  if (A.addrCity) {
    const areas = require('../lib/city-areas.json');
    const list = areas[A.addrCity] || areas[A.addrCity.replace(/市$/, '')];
    if (!list || !list.length) {
      console.log('❌ city-areas.json 里没有「' + A.addrCity + '」的区划数据');
      process.exit(1);
    }
    // 已在目标城市的，保留原区，不无谓改动（减少变更面）
    const now = (cur.addr || {});
    const keep = now.city === A.addrCity ? list.find(x => x.divisionId === now.divisionId) : null;
    const pick = keep || list[Math.floor(Math.random() * list.length)];
    carry.itemAddrDTO = { prov: pick.prov, city: pick.city, area: pick.area, divisionId: pick.divisionId, gps: pick.gps };
    console.log('所在地: ' + (now.prov || '?') + '/' + (now.city || '?') + '/' + (now.area || '?')
      + '  →  ' + pick.prov + '/' + pick.city + '/' + pick.area + '/' + pick.divisionId);
  }
  // --useStoreCat ：把分类改成【店铺档案】里配的那个（好易美代拍现在是「演出票代拍」）
  //   为什么需要：apply-item 原则是不碰分类，但老链接常常是别的分类（代购/201456914），
  //   而留资卡要求本地服务类、广告计划 catId 也要跟商品一致 —— 改造外地老链接时必须一起改。
  if (A.useStoreCat) {
    const P = require('../lib/store-profile').load('好易美代拍');
    const c = P.分类 || {};
    carry.itemCatDTO = { catId: String(c.catId), catName: c.catName, channelCatId: String(c.channelCatId) };
    carry.itemLabelExtList = [{
      channelCateName: c.catName, channelCateId: String(c.channelCatId),
      propertyName: '分类', propertyId: '-10000', text: c.catName,
      properties: '-10000##分类:' + c.channelCatId + '##' + c.catName,
      labelType: 'common', isUserClick: '1', from: 'newPublishChoice', labelFrom: 'newPublish'
    }];
    console.log('分类: ' + JSON.stringify((cur.cat || {}).catName) + '/' + (cur.cat || {}).channelCatId
      + '  →  ' + c.catName + '/' + c.channelCatId + '（按店铺档案）');
    // 换品类时原链接的服务承诺可能不被新品类支持
    // （报 FAIL_BIZ_ITEM_CONDITION_NOT_SUPPORT_SIGN::未开通服务或当前品类不支持开通服务）。
    // 档案里本店承诺就是「全不勾」，所以一并清回基座。
    carry.userRightsProtocols = [{ serviceCode: 'SKILL_PLAY_NO_MIND', enable: 'false' }];
    console.log('承诺: ' + JSON.stringify(cur.rights || []) + '  →  基座（无需物流，全不勾）');
  }

  const finalCat = (A.useStoreCat && carry.itemCatDTO) ? carry.itemCatDTO : (cur.cat || {});
  const cleanCarry = {};
  for (const [k, v] of Object.entries(carry)) if (v !== undefined && v !== null) cleanCarry[k] = v;

  const codeUpd = `
    var data = {
      itemId: ${JSON.stringify(ID)},
      freebies: false, itemTypeStr: 'b', quantity: String(${JSON.stringify(String(cur.qty || '9999'))}), simpleItem: 'true',
      imageInfoDOList: ${JSON.stringify(imgList)},
      itemTextDTO: { desc: ${JSON.stringify(FULL)}, title: ${JSON.stringify(TITLE)}, titleDescSeparate: false },
      itemPriceDTO: ${JSON.stringify(priceDTO)}, defaultPrice: false,
      itemCatDTO: ${JSON.stringify(finalCat)},
      uniqueCode: Date.now() + '_' + Math.random().toString(36).substring(2, 10),
      sourceId: 'pcMainPublish', bizcode: 'pcMainPublish', publishScene: 'pcMainPublish'
    };
    var CARRY = ${JSON.stringify(cleanCarry)};
    for (var k in CARRY) { if (CARRY[k] !== undefined && CARRY[k] !== null && data[k] === undefined) data[k] = CARRY[k]; }
    var out = {};
    try {
      var r = await mtop.request({ api: 'mtop.idle.pc.idleitem.edit', v: '1.0', data: data, type: 'POST' });
      out.ret = r && r.ret;
    } catch (e) { out.err = (e && (e.ret ? JSON.stringify(e.ret) : e.message)) || String(e); }
    return JSON.stringify(out);
  `;

  if (!GO) { console.log('\n[未加 --go] 只预览，不写线上'); return; }

  try { await agent.evalOnStore('location.href=' + JSON.stringify('https://www.goofish.com/publish?itemId=' + ID) + '; "go"'); } catch (e) {}
  await new Promise(z => setTimeout(z, 12000));

  console.log('\n执行 edit…');
  const res = asObj(await agent.mtop(codeUpd, { timeout: 180000 }));
  console.log(JSON.stringify(res));
  if (res.err) { console.log('❌ 失败'); process.exit(1); }

  await new Promise(z => setTimeout(z, 4000));
  const chk = asObj(await agent.mtop(READ, { timeout: 120000 }));
  console.log('\n回读标题: ' + chk.title);
  console.log('标题一致: ' + (String(chk.title || '').trim() === TITLE.trim() ? '✅' : '❌'));
  console.log('回读正文首行: ' + String(chk.desc || '').split('\n')[0]);
  console.log('回读图数: ' + (chk.imgs || []).length + '  主图 ' + ((chk.imgs || [])[0] || {}).widthSize + 'x' + ((chk.imgs || [])[0] || {}).heightSize);
  console.log('分类: ' + JSON.stringify(chk.cat));
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
