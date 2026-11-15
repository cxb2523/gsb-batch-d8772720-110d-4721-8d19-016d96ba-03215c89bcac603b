const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
// tools/probe-event-dup.js —— 发布前查重：这个活动店里是不是已经有链接了
//
// 为什么必须有这一步：2026-10-11 深圳王者荣耀就是两个会话各发一组、在售变成 4 条，
// 平台判「重复铺货」并连坐判其中一条「擦亮类目与商品内容不符」→ 那条永远投不了推广。
// 从此「发布前先扫在售池」写进了 协作-待办.md 的教训栏。
//
// 用法（会用到店铺页，属导航型，按 §5.1 先接浏览器锁）：
//   node lib/browser-lock.js acquire 工程 "发布前查重 <活动名>"
//   node run-eval-store.js tools/probe-event-dup.js 好易美代拍          # 用默认关键词
//   PROBE_KW="珠海|航展|莲洲" node run-eval-store.js ...                 # 自定义（环境变量传不进浏览器，见下）
//
// ⚠️ 注入到浏览器里的脚本读不到本机的环境变量，所以关键词写在下面这个常量里；
//    要换关键词就改这一行（或在外面生成一个临时副本）。
(async () => {
  const m = window.lib.mtop;
  const KEY = /珠海|航展|莲洲|无人装备/i;   // ← 改这里

  // A. 本店全部商品（含已下架）
  const API = 'mtop.idle.web.xyh.item.list';
  const BASE = { needGroupInfo: false, userId: USER_ID, pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true };
  const items = {};
  for (let p = 1; p <= 12; p++) {
    let r;
    try { r = await m.request({ api: API, v: '1.0', type: 'POST', data: Object.assign({}, BASE, { pageNumber: p }) }); } catch (e) { break; }
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) break;
    const cards = (r.data && r.data.cardList) || [];
    if (!cards.length) break;
    let added = 0;
    cards.forEach((c) => {
      const cd = c.cardData || {};
      const id = String(cd.id || '');
      if (!id || items[id]) return;
      added++;
      items[id] = { itemId: id, 标题: String(cd.title || ''), 价格: cd.priceInfo ? Number(cd.priceInfo.price) : null, 状态: cd.itemStatus };
    });
    if (!added) break;
  }

  // B. 可投放池（= 在售且支持广告）
  const ir = await m.request({
    api: 'mtop.taobao.idle.ad.item.searchV2', v: '1.0', type: 'POST',
    data: { requestJson: JSON.stringify({ pageNum: 1, pageSize: 200, tab: 'all', needTabs: true }) },
  });
  const adv = (((ir || {}).data || {}).result || {}).itemList || [];
  const advMap = {}; adv.forEach((it) => { advMap[String(it.itemId)] = it; });

  const all = Object.values(items);
  const hit = all.filter((x) => KEY.test(x.标题));
  const recent = all.filter((x) => /24小时内发布/.test(String(x.标题)));

  return JSON.stringify({
    时刻: new Date().toLocaleString('zh-CN'),
    关键词: String(KEY),
    商品总数: all.length,
    可投放总数: adv.length,
    命中: hit.map((x) => ({
      itemId: x.itemId, 标题: x.标题.slice(0, 54), 价格: x.价格, 状态: x.状态,
      在售: !!advMap[x.itemId], supportAd: advMap[x.itemId] ? advMap[x.itemId].supportAd : null,
    })),
    结论: hit.length ? ('⚠️ 已经有 ' + hit.length + ' 条命中 → 可能就是重复铺货，先跟老板/运营对齐') : '✅ 一条都没有 → 不是重复铺货',
  }, null, 1);
})()
