/**
 * tools/probe-mtop-apis.js — 抓某个页面上闲鱼实际调用了哪些 mtop 接口（只读）
 *
 * 为什么需要它：
 *   想知道"闲鱼的规格/类目/编辑接口叫什么、要什么参数"，靠猜、靠翻别人文章都不靠谱。
 *   最可靠的办法是【让闲鱼自己的页面去调一遍，然后看它调了什么】。
 *   服务端本来就有请求抓包（GET /api/agent/api-capture，数据落在 API_CAPTURE_FILE），
 *   这个工具把「清空 → 导航到目标页 → 等 → 列出接口名+字段+样例」这条流程固化下来。
 *
 * 用法:
 *   node tools/probe-mtop-apis.js --store="好易美代拍" --url="https://www.goofish.com/item?id=1085400873025"
 *   node tools/probe-mtop-apis.js --store="好易美票务Hope" --url="https://www.goofish.com/item?id=1088881826804" --wait=12000
 *   node tools/probe-mtop-apis.js --store="好易美代拍" --url=".../publish" --only=property
 *   node tools/probe-mtop-apis.js --store="好易美代拍" --dump          # 不导航，直接看当前抓包里有什么
 *
 * 前置：店铺页要已就绪（node tools/store-ready.js "<店铺名>"）
 */
const { post, get } = require('../lib/http');
const args = require('../lib/args');

const A = args.parse();
const STORE = A.store || A._[0] || '';
const URL_ = A.url || '';
const WAIT = Number(A.wait || 10000);
const ONLY = A.only || '';
const DUMP = A.on('dump');

if (!STORE) {
  console.log('用法: node tools/probe-mtop-apis.js --store="<店铺名>" --url="<要访问的页面>" [--wait=10000] [--only=子串]');
  console.log('      node tools/probe-mtop-apis.js --store="<店铺名>" --dump');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!DUMP) {
    // ① 清空抓包（判 ok，别看返回值就当清干净了）
    const c = await post('/api/agent/api-capture-clear', {}, { timeout: 30000 });
    if (!c || c.ok !== true) { console.log('❌ 清空抓包失败：' + JSON.stringify(c)); process.exit(1); }
    const before = await get('/api/agent/api-capture?limit=1', { timeout: 30000 });
    console.log('抓包已清空（清空前 ' + ((before && before.total) || 0) + ' 条）');

    // ② 导航（走店页的 eval，不能用 /api/agent/navigate —— 那个只动 agent.page=dayu）
    console.log('导航到 ' + URL_ + ' ...');
    const nav = await post('/api/agent/eval-on-store',
      { store: STORE, code: 'location.href=' + JSON.stringify(URL_) + '; "nav"' }, { timeout: 60000 });
    if (!nav || nav.ok !== true) {
      console.log('❌ 导航失败：' + JSON.stringify(nav || {}).slice(0, 200));
      console.log('   店页没就绪? → node tools/store-ready.js "' + STORE + '"');
      process.exit(1);
    }
    console.log('等 ' + WAIT + 'ms 让页面把接口都调完 ...');
    await sleep(WAIT);
  }

  // ③ 读抓包
  const cap = await get('/api/agent/api-capture?limit=500' + (ONLY ? '&only=' + encodeURIComponent(ONLY) : ''), { timeout: 60000 });
  const items = (cap && cap.items) || [];
  console.log('\n抓到 ' + ((cap && cap.total) || 0) + ' 条请求' + (ONLY ? '（已按「' + ONLY + '」过滤）' : '') + '，本次展示 ' + items.length + ' 条');

  // ④ 按接口名归并：次数 + 字段并集 + 样例
  const map = {};
  for (const it of items) {
    const api = it.api || '(无 api 字段)';
    if (!map[api]) map[api] = { n: 0, keys: {}, sample: null, url: it.url };
    map[api].n++;
    const d = it.data !== undefined ? it.data : it.body;
    if (d && typeof d === 'object') {
      for (const k of Object.keys(d)) map[api].keys[k] = 1;
      if (!map[api].sample) map[api].sample = d;
    } else if (d !== undefined && !map[api].sample) map[api].sample = d;
  }
  const rows = Object.keys(map).sort((a, b) => map[b].n - map[a].n);
  if (!rows.length) {
    console.log('\n⚠️ 一条都没抓到。可能原因：');
    console.log('   ① 页面是 SPA，改 location.href 不会真的重新加载（试试先 location.reload()）');
    console.log('   ② 服务端抓包没挂上 — POST /api/agent/inject-monitor 重新注入');
    console.log('   ③ 该页面本来就不调 mtop（比如纯静态页）');
    process.exit(0);
  }
  for (const api of rows) {
    const m = map[api];
    console.log('\n● ' + api + '   ×' + m.n);
    const ks = Object.keys(m.keys);
    if (ks.length) console.log('   字段: ' + ks.join(', '));
    if (m.sample !== null && m.sample !== undefined) {
      const s = typeof m.sample === 'string' ? m.sample : JSON.stringify(m.sample);
      console.log('   样例: ' + (s.length > 700 ? s.slice(0, 700) + ' …(' + s.length + '字)' : s));
    }
  }
  console.log('\n提示：--only=<子串> 过滤接口名；--dump 复用当前抓包不重新导航。');
})().catch((e) => require('../lib/crash').crash(e, 1));
