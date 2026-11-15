/**
 * tools/item-traffic.js —— 只读：拉在售商品的真实浏览量 / 想要数，按浏览量排序
 *
 * 数据来源两级：
 *   ① 商品详情页（goofish.com/item?id=xx）的「X浏览 / X人想要」—— 实时、准
 *   ② 商品列表 cardData —— 只有想要数，没有浏览
 * 所以这里走 ①，逐条导航抓。条数多时慢（每条约 3-5 秒），但数是真的。
 *
 * 用法:
 *   node tools/item-traffic.js              # 拉全部在售
 *   node tools/item-traffic.js --top=10     # 只看前 10 条
 */
const agent = require('../lib/agent');

const { userIdOf } = require('../lib/user-id');
const USER_ID = userIdOf();   // 在 Node 侧求值，模板里用 ${JSON.stringify(USER_ID)} 传下去
const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) A[a.slice(2, eq)] = a.slice(eq + 1);
  else A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

const LIST = `
  const API = 'mtop.idle.web.xyh.item.list';
  const BASE = { needGroupInfo: false, userId: ${JSON.stringify(USER_ID)}, pageSize: 20, groupName: '综合', groupId: 52785096, defaultGroup: true };
  const out = [];
  for (let p = 1; p <= 12; p++) {
    let r;
    try { r = await mtop.request({ api: API, v: '1.0', type: 'POST', data: Object.assign({}, BASE, { pageNumber: p }) }); }
    catch (e) { return JSON.stringify({ err: String((e && (e.ret || e.message)) || e) }); }
    if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ ret: r && r.ret });
    const cards = ((r.data || {}).cardList) || [];
    if (!cards.length) break;
    cards.forEach(function (c) {
      const cd = c.cardData || {};
      if (!cd.id || String(cd.itemStatus) !== '0') return;
      out.push({ id: String(cd.id), title: String(cd.title || '') });
    });
    if (cards.length < 20) break;
  }
  return JSON.stringify({ items: out });
`;

const num = (s) => {
  const m = String(s || '').match(/([\d,.]+)\s*(浏览|人想要)/);
  if (!m) return null;
  return Number(m[1].replace(/[,]/g, ''));
};

(async () => {
  const l = await agent.mtop(LIST, { timeout: 180000 });
  let list = (typeof l === 'string' ? JSON.parse(l) : l).items || [];

  // ⚠️【2026-11-12 加】--ids=1,2,3 只抽查指定链接。
  //   原因：每条要 2 次 eval（导航 + 读文本），而 req-gate 限额是 60 次 / 10 分钟，
  //   17 条的店一次跑不完（会等好几轮，20 分钟以上）。
  //   只想判断"哪几条值得动"时，用 --ids 抽查 5-8 条就够，不浪费限额。
  if (A.ids) {
    const want = String(A.ids).split(/[,，\s]+/).filter(Boolean);
    const before = list.length;
    list = list.filter(it => want.includes(String(it.id)));
    console.log('抽查模式：指定 ' + want.length + ' 条，命中 ' + list.length + '/' + before + ' 条');
  }
  console.log('在售: ' + list.length + ' 条，逐条抓浏览量（每条 3-5 秒）...\n');

  // ⚠️【2026-11-12 修】必须显式把【本店】的页面拉起来。
  //   agent.ready() 默认只启动 config.store.active（本机就只有「好易美代拍」），
  //   而 evalOnStore 是按 STORE（XY_STORE 可覆盖）去找页面的。
  //   于是查超能水手时：页面压根没开 → 前两条侥幸命中残留页面，之后全超时，
  //   整批数据变成 -1（实测 17 条只成 2 条）。这里显式点名要哪家店的上下文。
  try {
    await agent.ready({ stores: [agent.STORE] });
    console.log('店铺上下文：' + agent.STORE);
  } catch (e) {
    console.log('⚠️ 拉起店铺页面失败（' + (e.message || e).split('\n')[0] + '），继续试');
  }

  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    process.stdout.write('[' + (i + 1) + '/' + list.length + '] ' + it.id + ' ... ');
    try {
      await agent.evalOnStore('location.href=' + JSON.stringify('https://www.goofish.com/item?id=' + it.id) + '; "go"', { timeout: 60000 });
      await agent.sleep(3500);
      const t = String(await agent.evalOnStore('document.body.innerText', { timeout: 60000 }) || '');
      // ⚠️【2026-11-12 修】不能各抓各的：
      //   页面底部「猜你喜欢」里别人的商品也带「X人想要」（实测抓到过 28638 / 42899），
      //   旧写法 `match(/X人想要/)` 取第一个，于是把别人的数据当成本条的 ——
      //   三亚周杰伦那条真实是「8浏览 / 1人想要」，被记成「7浏览 / 11501想要」，
      //   差点把它当成爆款保护起来，重锚决策会全错。
      //   正确做法：在「X浏览」之后的一小段窗口里找「X人想要」，两者同属商品主体区。
      const pair = t.match(/([\d,.]+)\s*浏览[\s\S]{0,80}?([\d,.]+)\s*人想要/);
      let view, want;
      if (pair) {
        view = pair[1]; want = pair[2];
      } else {
        // 兜底：没有想要的（0 人想要时平台可能不显示这个字样）
        view = (t.match(/([\d,.]+)\s*浏览/) || [])[1];
        want = null;
      }
      const v = view ? Number(String(view).replace(/,/g, '')) : 0;
      const w = want ? Number(String(want).replace(/,/g, '')) : 0;
      rows.push({ id: it.id, title: it.title, view: v, want: w });
      console.log(v + ' 浏览 / ' + w + ' 想要');
    } catch (e) {
      // ⚠️【2026-11-12 加】撞到 req-gate 限额（60 次 eval / 10 分钟）时不能直接记 -1，
      //   那会让人以为「这条抓不到」，其实只是被限速。等够了自动重试一次。
      //   17 条 × 2 次 eval = 34 次，加上别的脚本用量很容易超。
      const msg = String((e && e.message) || e);
      if (/req-gate/.test(msg)) {
        const m = msg.match(/暂停\s*(\d+)\s*秒/);
        const waitSec = (m ? Number(m[1]) : 60) + 3;
        console.log('限流，等 ' + waitSec + ' 秒后重试本条…');
        await agent.sleep(waitSec * 1000);
        try {
          await agent.evalOnStore('location.href=' + JSON.stringify('https://www.goofish.com/item?id=' + it.id) + '; "go"', { timeout: 60000 });
          await agent.sleep(3500);
          const t2 = String(await agent.evalOnStore('document.body.innerText', { timeout: 60000 }) || '');
          const p2 = t2.match(/([\d,.]+)\s*浏览[\s\S]{0,80}?([\d,.]+)\s*人想要/);
          const v2 = p2 ? Number(String(p2[1]).replace(/,/g, '')) : Number((t2.match(/([\d,.]+)\s*浏览/) || [, 0])[1].replace(/,/g, ''));
          const w2 = p2 ? Number(String(p2[2]).replace(/,/g, '')) : 0;
          rows.push({ id: it.id, title: it.title, view: v2, want: w2 });
          console.log(v2 + ' 浏览 / ' + w2 + ' 想要（重试成功）');
          continue;
        } catch (e2) {
          rows.push({ id: it.id, title: it.title, view: -1, want: -1 });
          console.log('重试仍失败');
          continue;
        }
      }
      rows.push({ id: it.id, title: it.title, view: -1, want: -1 });
      console.log('抓取失败');
    }
  }

  rows.sort((a, b) => b.view - a.view);
  const top = A.top ? rows.slice(0, Number(A.top)) : rows;
  console.log('\n════ 按浏览量排序 ════');
  top.forEach((r, i) => {
    console.log(String(i + 1).padStart(2) + '. ' + String(r.view).padStart(6) + ' 浏览  ' + String(r.want).padStart(5) + ' 想要  ' + r.id + '  ' + r.title.slice(0, 40));
  });

  require('fs').writeFileSync(path.join(__dirname, '..', 'item-traffic-now.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log('\n已存 item-traffic-now.json');
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
