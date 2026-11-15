/**
 * publish-one.js — 出图 + 出文案 + 走 mtop API 发布（v2：改用 API 路径）
 *
 * 为什么不用网页 UI：网页发布 ① 给不了库存（恒为 1）② contenteditable 吃掉描述换行。
 * API 路径 quantity 直传、desc 原始 \n 直存，与店铺现有 76 条同路径。
 *
 * 主图上传走 /api/agent/upload-image（服务端带 cookie 直传 stream-upload.goofish.com）。
 * 发布调 mtop.idle.pc.idleitem.publish，payload 结构照 publish.js L652-694。
 *
 * 用法: node publish-one.js <城市> <明星> [--dry]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { SVC: SVC_ENV, PATHS, ROOT, STORE } = require('./lib/env');
const storeProfile = require('./lib/store-profile');
const titleLib = require('./lib/title');

const SVC = PATHS.playwrightService;
const KEY = SVC_ENV.apiKey;
const OUTDIR = path.join(ROOT, 'publish-out');

/**
 * 从 xianyu-playwright-service 的 node_modules 里 require 一个包。
 *
 * 【2026-11-14 第 162 轮】包里【不带 node_modules】（100 MB，学员自己 npm install），
 *   所以解压完直接跑 publish-one 必然走到这里。原来 5 处 require 是裸的，
 *   抛出来的是英文：
 *       ❌ Cannot find module 'C:/.../xianyu-playwright-service/node_modules/sharp'
 *   第 144 轮只包了 playwright 那一处，第 162 轮实测【带档案发】时 sharp 的四处
 *   （L413/441/488/612）照样甩英文 —— 一次修完，别再一处一处补。
 *
 * @param {string} name  包名（'sharp' / 'playwright'）
 * @param {string} [hint] 这个包是干嘛的，装好之前哪一步做不了
 */
function requireSvc(name, hint) {
  try { return require(SVC + '/node_modules/' + name); }
  catch (e) {
    console.log('');
    console.log('❌ 这台机器还没装依赖（找不到 ' + name + '）。');
    if (hint) console.log('   装好之前：' + hint);
    console.log('   处理：双击包根的 install.cmd（或跑 install.ps1），它会把三个仓的依赖装好。');
    console.log('   装一次就行，以后不用再管。');
    console.log('');
    throw new Error('依赖未安装：' + SVC + '\\node_modules\\' + name + ' 不存在');
  }
}

/**
 * 【2026-10-07 加】店铺档案 —— 一店一文件 stores/<店铺名>.json。
 *
 * 为什么：这个脚本原来把 10 个维度里的 9 个写死在代码里（分类/规格/库存/发货/承诺/所在地…
 * 全靠 `=== '好易美代拍'` 这种判断），所以每接一个新店都要改代码 + 试错，
 * 实测开一个店要花近一天。改成读档案之后，"换店铺"不再需要改任何 .js。
 *
 * 没有档案的店铺 → 用 lib/store-profile.js 的 DEFAULTS（= 本脚本改动前的行为），零行为变更。
 */
const PROFILE = storeProfile.load(STORE);

const CITY = process.argv[2] || '杭州';
const STAR = process.argv[3] || '那英';
const DRY = process.argv.indexOf('--dry') >= 0;

// 【2026-11-13 加】没有自己的档案 → 【不许真发】。
//   为什么：storeProfile.load() 遇到不存在的档案时，只往 stderr 打一段警告，
//   然后【返回 DEFAULTS 继续跑】。--dry 的时候这没问题（正好看看默认效果），
//   但真发就会用默认的主图模板 / 默认价格 / 通用文案发出去 ——
//   学员第一次配店之前如果先试了真发，平台上就多了一条风格和价格都不对的链接。
//   老店都有 stores/<店>.json，所以这条对现有店铺零影响。
//   ├ 想看默认效果：加 --dry（能出图，不会发）
//   └ 想变成自己的店：node tools\store-wizard.js "<店铺名>"，或网页点「⑤ 配置一家新店」
if (!DRY && !storeProfile.exists(STORE)) {
  console.log('');
  console.log('❌「' + STORE + '」还没有自己的档案，不能真发。');
  console.log('');
  console.log('   用默认值发出去，主图模板是随机的、价格和文案都是通用的 —— 那不是你的店。');
  console.log('');
  console.log('   ① 先看效果（能出图，不会发）：');
  console.log('        node publish-one.js ' + (process.argv[2] || '杭州') + ' ' + (process.argv[3] || '那英') + ' --dry');
  console.log('   ② 把它变成你自己的店（五步，约 3 分钟）：');
  console.log('        node tools\\store-wizard.js "' + STORE + '"');
  console.log('        （或者打开网页，点「⑤ 配置一家新店」）');
  console.log('   ③ 配好之后再回来发。');
  console.log('');
  process.exit(1);
}
// 发布成功后回读校验（用闲鱼编辑页的 editdetail 把规格/价格/库存/类目/发货/承诺读回来比对）。
// 默认开；要跳过传 --no-verify 或 KUN_NO_VERIFY=1。
const NO_VERIFY = process.argv.indexOf('--no-verify') >= 0 || process.env.KUN_NO_VERIFY === '1';
// 【2026-10-07 改】活动类型可配。原来是写死 '演唱会'，
// 导致电竞赛事（北京 IEM 大师赛）这类非演唱会场次，标题会错写成「演唱会」。
// 传参：环境变量 KUN_EVENT，或命令行 --event=大师赛；【完全没给】才回落 '演唱会'。
// 【2026-10-09 修·真实事故】原来是 `(... || '') || '演唱会'` —— 空串也被当成"没给"→ 回落。
//   后果：舞蹈年度大赏这种【没有场次类型】的活动，把 event/session 留空想得到干净标题，
//   实际却发出「杭州中国舞蹈年度大赏**演唱会首开**代拍」——多了两个错误词。
//   而 --plan 的预览是 publish-group.js 自己拼的（用原始空值），于是预览与真发不一致，
//   把 --plan「预览=执行」的意义破掉了。
//   现在的语义：显式给了（哪怕空串）就用给的；完全没给才回落。必须与 publish-group.js 一致。
const EVENT = (() => {
  const a = process.argv.find((x) => x.startsWith('--event='));
  if (a !== undefined) return a.slice('--event='.length);                 // 显式（含空串）
  if (process.env.KUN_EVENT !== undefined) return process.env.KUN_EVENT;  // 显式（含空串）
  return '演唱会';                                                        // 完全没给
})();
// 【2026-10-06 改】原来这里是 `const SESSION = '首开'` 写死，
// 导致「二开 / 三开 / 回流捡漏」的场次根本发不出去（标题全写首开）。
// 现在从命令行第 4 个参数读；【2026-10-09 修】空串曾被当成"没给"→ 回落「首开」，现在显式空串就用空串；
// 完全没给才回落，兼容所有老调用。
const SESSION = (() => {
  const a = process.argv[4];
  if (a !== undefined && a.indexOf('--') !== 0) return a;                 // 显式（含空串）
  return '首开';                                                          // 完全没给
})();
// 【2026-10-06 改】价格做成参数，不再是写死的单档 ¥50。
// 老板要用 A/B（¥50 vs ¥80）测「标价对点击率/咨询成本的影响」。
// 标价不是成交价（客服会改价成 0.01），它只决定【买家点不点进来】+筛选客户质量。
// 传参：环境变量 KUN_PRICE（元），或命令行 --price=80；不传用档案的 价格.default。
const PROFILE_PRICE = String((PROFILE.价格 && PROFILE.价格.default != null) ? PROFILE.价格.default : 50);
const PRICE = (() => {
  const a = process.argv.find((x) => x.startsWith('--price='));
  const v = a ? a.split('=')[1] : process.env.KUN_PRICE;
  return (v != null && v !== '') ? v : PROFILE_PRICE;
})();
// 【2026-10-07】原来这里是 const PRICE_CENT = ...，只给写死的单档 itemSkuList 用。
// 现在价格进了 SPEC（多档规格每档可单独定价），所以 PRICE_CENT 已并入下面的 SPEC 计算，不再单独存在。
// 【2026-10-07 改】库存原来写死 '9999'，现在读档案。
// ⚠️ 注意：单档规格下顶层 quantity 不生效，真正生效的是 itemSkuList[].quantity。
const STOCK = String((PROFILE.库存 && PROFILE.库存.default != null) ? PROFILE.库存.default : 9999);

// ── 档案里剩下那几个维度的解析（分类 / 规格 / 发货方式 / 承诺）──
// 这四个原来全是写死值：分类恒为「代购」、规格恒为「代拍费/标准」、
// 发货恒为「面交、包邮全关」、承诺恒为「不勾任何服务承诺」。
// 解析规则与桌面引擎 publish.js 的 publishOne() 保持一致（两份代码同一套语义，改一处必须改两处）。
const CAT = PROFILE.分类 || {};
const SHIP = (PROFILE.发货方式 || {}).shipMode || 'nomail';
const COMMIT = PROFILE.承诺 || {};

/**
 * 【2026-10-07 加】命令行直接指定规格，压过档案 —— "想用什么规格、定什么价、给多少库存都行"。
 *   --specs="多人组团可优惠:50:9999,看台:500:9999,内场:800:9999"
 *   --property=代拍费           （可选，默认用档案里的）
 * 不写库存 = 用档案 库存.default；不写价格 = 用档案 价格.default。
 * 临时调价 / 做 A/B 时用它，别去改档案（改了会影响这个店之后所有发布）。
 */
function parseSpecsArg(raw) {
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = s.split(':');
    const name = (p[0] || '').trim();
    if (!name) { console.log('❌ --specs 里有一档没写名字：' + JSON.stringify(s)); process.exit(1); }
    const price = (p[1] === undefined || p[1] === '') ? undefined : Number(p[1]);
    const quantity = (p[2] === undefined || p[2] === '') ? undefined : Number(p[2]);
    if (price !== undefined && (!isFinite(price) || price <= 0)) { console.log('❌ --specs「' + name + '」价格非法：' + p[1]); process.exit(1); }
    if (quantity !== undefined && (!isFinite(quantity) || quantity < 0)) { console.log('❌ --specs「' + name + '」库存非法：' + p[2]); process.exit(1); }
    return { valueText: name, price: price, quantity: quantity };
  });
}
const SPECS_ARG = (() => {
  const a = process.argv.find((x) => x.startsWith('--specs='));
  const raw = a ? a.slice(8) : (process.env.KUN_SPECS || '');
  return raw ? parseSpecsArg(raw) : null;
})();
const PROP_ARG = (() => {
  const a = process.argv.find((x) => x.startsWith('--property='));
  return a ? a.slice(11) : (process.env.KUN_PROPERTY || '');
})();

/** 规格 → itemProperties + itemSkuList（每档可单独给 price/quantity，不给就回落 价格.default / 库存.default） */
const SPEC = (() => {
  const s = PROFILE.规格 || {};
  const propertyName = PROP_ARG || s.propertyName || '代拍费';
  const specs = SPECS_ARG
    || ((Array.isArray(s.specs) && s.specs.length) ? s.specs : [{ valueText: '标准' }]);
  for (const x of specs) {
    if (!x || !x.valueText) { console.log('❌ 档案「' + STORE + '」的 规格.specs 里有一档没写 valueText'); process.exit(1); }
  }
  return {
    propertyName: propertyName,
    propertyValues: specs.map((x) => ({ propertyValue: x.valueText })),
    itemSkuList: specs.map((x) => ({
      priceInCent: String(Math.round(parseFloat(x.price != null ? x.price : PRICE) * 100)),
      quantity: Number(x.quantity != null ? x.quantity : STOCK),
      propertyList: [{ propertyText: propertyName, valueText: x.valueText }],
    })),
  };
})();

/**
 * 城市 → 闲鱼商品「所在地」（2026-09-28 加）
 *
 * 背景：原代码调 mtop.taobao.idle.local.poi.get 拿定位，但实测该接口
 *   **忽略一切入参**（传经纬度 / divisionId / city 都一样），只返回**账号绑定的定位**，
 *   也就是「好易美代拍」的 杭州/上城区/330102。结果：不管城市参数填什么，
 *   商品所在地永远是杭州（郑州侯明昊、泉州徐良两条都中招）。
 *
 * 依据：返回的 330102 正是国标【上城区】的行政区划代码（杭州=330100），
 *   说明 itemAddrDTO.divisionId 用的是 GB/T 2260 行政区划代码。
 *   而 itemAddrDTO 是本脚本自己拼的 → 在这里显式覆盖即可。
 *
 * ⚠️ 新增城市时，请到闲鱼网页发布页手动选一次该城市、抓 payload 核对 divisionId，
 *    别凭记忆填 —— 填错会静默挂到错误的城市。
 */
const CITY_ADDR = {
  '泉州': { prov: '福建', city: '泉州', area: '丰泽区', divisionId: '350503' },
  '福州': { prov: '福建', city: '福州', area: '鼓楼区', divisionId: '350102' },
  '厦门': { prov: '福建', city: '厦门', area: '思明区', divisionId: '350203' },
  '杭州': { prov: '浙江', city: '杭州', area: '上城区', divisionId: '330102' },
  '宁波': { prov: '浙江', city: '宁波', area: '海曙区', divisionId: '330203' },
  '南京': { prov: '江苏', city: '南京', area: '玄武区', divisionId: '320102' },
  '苏州': { prov: '江苏', city: '苏州', area: '姑苏区', divisionId: '320508' },
  '上海': { prov: '上海', city: '上海', area: '黄浦区', divisionId: '310101' },
  '北京': { prov: '北京', city: '北京', area: '朝阳区', divisionId: '110105' },
  '广州': { prov: '广东', city: '广州', area: '天河区', divisionId: '440106' },
  '深圳': { prov: '广东', city: '深圳', area: '福田区', divisionId: '440304' },
  '郑州': { prov: '河南', city: '郑州', area: '金水区', divisionId: '410105' },
  '武汉': { prov: '湖北', city: '武汉', area: '江汉区', divisionId: '420103' },
  '长沙': { prov: '湖南', city: '长沙', area: '岳麓区', divisionId: '430104' },
  '成都': { prov: '四川', city: '成都', area: '武侯区', divisionId: '510107' },
  '重庆': { prov: '重庆', city: '重庆', area: '渝中区', divisionId: '500103' },
  '西安': { prov: '陕西', city: '西安', area: '雁塔区', divisionId: '610113' },
  '天津': { prov: '天津', city: '天津', area: '和平区', divisionId: '120101' },
  '济南': { prov: '山东', city: '济南', area: '历下区', divisionId: '370102' },
  '青岛': { prov: '山东', city: '青岛', area: '市南区', divisionId: '370202' },
  // 【2026-09-29 补】原来缺这三个：常州/佛山 是本次要推的场次，珠海是澳门的落位目标
  '常州': { prov: '江苏', city: '常州', area: '天宁区', divisionId: '320402' },
  '佛山': { prov: '广东', city: '佛山', area: '禅城区', divisionId: '440602' },
  '珠海': { prov: '广东', city: '珠海', area: '香洲区', divisionId: '440402' },
};

// 【2026-09-29 加·老板定的规则】CITY_ADDR 里没有的城市，按就近原则落到国内城市：
//   香港 → 广州 / 深圳        澳门 → 珠海 / 广州 / 深圳
//   其它国外（新加坡、吉隆坡…）→ 随机一线城市（北京/上海/广州/深圳）
// 只影响「宝贝所在地」；标题里的城市仍用原城市（CITY 变量）。
// ⚠️ 必须与 System B（桌面 publish.js 的 resolveLocation / CITY_FALLBACK）保持同一套规则，
//    两处改一处没改就会「同一场次两个系统发出来所在地不一样」。
const CITY_FALLBACK = {
  '香港': ['广州', '深圳'],
  '澳门': ['珠海', '广州', '深圳'],
};
const TIER1_CITIES = ['北京', '上海', '广州', '深圳'];
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 【2026-10-06 加】城市 → 区池（来源 address_db.js：901 条实测地址，带 divisionId + 经纬度）
// 以前只有 CITY_ADDR「一个城市固定一个区」→ 同城多条链接辖区完全一样，
// 台账实证：广州 9 条历史链接全是「天河区/440106」。
const CITY_AREAS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'city-areas.json'), 'utf8')); }
  catch (e) { return {}; }
})();

function pickCity(city, wantArea) {
  const pool = CITY_AREAS[city] || [];
  // 指定了区就优先用它（同城不重复由调度器负责分配）
  if (wantArea) {
    const hit = pool.find((a) => a.area === wantArea);
    if (hit) return hit;
    console.log('⚠️ 指定的区「' + wantArea + '」不在「' + city + '」区池里（池内 ' + pool.length + ' 个），改为自动选');
  }
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  if (CITY_ADDR[city]) return CITY_ADDR[city];
  return null;
}

const LOC = PROFILE.所在地 || {};
const ALL_CITY_KEYS = Object.keys(CITY_AREAS);

/**
 * 所在地 —— 档案 所在地.mode 决定（2026-10-07 由写死行为变成可配）：
 *   city（默认）= 跟着标题城市走，广州的场次挂广州。这正是改动前唯一的行为。
 *   fixed        = 固定城市+区，不看标题城市。
 *   random_tier1 = 随机一线城市（北京/上海/广州/深圳）。
 *   random_any   = 随机区池里任意城市。
 * 只影响「宝贝所在地」；标题里的城市永远是 CITY。
 *
 * ⚠️ 已知与桌面引擎 publish.js 的 resolveLocation 有一处顺序差异（不是这次引入的）：
 *     publish.js 把「香港→广州/深圳、澳门→珠海/广州/深圳」摆在查地址库【之前】，
 *     publish-one.js 摆在【之后】。所以港澳门场次在地址库里存在时，两边落点会不一样。
 *     这次只做"可配化"，【故意不改那个顺序】以免静默改变已在跑的代拍店行为。
 */
function resolveAddr(city, wantArea) {
  const mode = LOC.mode || 'city';

  if (mode === 'fixed') {
    const hit = pickCity(LOC.fixedCity, LOC.fixedDistrict || '');
    if (hit) return hit;
    console.log('⚠️ 档案里固定的城市「' + LOC.fixedCity + '」不在区池/单点表里，改为随机一线');
  }
  if (mode === 'random_tier1') return pickCity(pickOne(TIER1_CITIES)) || null;
  if (mode === 'random_any') {
    return pickCity(ALL_CITY_KEYS.length ? pickOne(ALL_CITY_KEYS) : pickOne(TIER1_CITIES)) || null;
  }

  // ── mode === 'city'：跟标题城市（改动前唯一的行为，逐行等价）──
  const hit = pickCity(city, wantArea);
  if (hit) return hit;
  const near = CITY_FALLBACK[city];
  if (near && near.length) return pickCity(pickOne(near)) || null;
  // 【2026-10-07 加】标题城市不在地址库里 → 优先落档案的固定城市（默认空 = 跳过，行为不变）
  if (LOC.fixedCity) { const f = pickCity(LOC.fixedCity, LOC.fixedDistrict || ''); if (f) return f; }
  return pickCity(pickOne(TIER1_CITIES)) || null;
}

// 第 5 个参数 / 环境变量 KUN_ADDR_AREA 可指定区
const WANT_AREA = (process.argv[5] && process.argv[5].indexOf('--') !== 0)
  ? process.argv[5] : (process.env.KUN_ADDR_AREA || '');
const ADDR = resolveAddr(CITY, WANT_AREA);

function post(p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: 8093, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 300))); } }); });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 300000, () => req.destroy(new Error('请求超时')));
    req.write(payload); req.end();
  });
}

// ── fitTitle（实现见 lib/title.js，与桌面 publish.js 同源逻辑）──
// 2026-09-28 改：TITLE_MAX 30 → 40，并把「截断上限」与「补足下限」拆开。
//   为什么当时改 40：老板自己原有链接的标题看着就是 40 字
//   （如「【代拍必中】孙燕姿广州站演唱会接代拍首开代抢孙燕姿演唱会代抢 广州孙燕姿秒付必中」）。
//   ⛔ 2026-10-11 纠正：那个前提是错的 —— 闲鱼标题【硬上限就是 30 字】，
//      超出的部分平台从尾部静默砍掉。实测（editdetail 读闲鱼侧实存标题）：
//      发出 31/33/36/38 字，实存一律 30 字。所以那条"40 字"的老链接，
//      闲鱼侧真正存下来的也只有 30 字（「…代抢孙燕」），只是我们一直没读回来对过。
//      改成 40 这个动作本身就是「照着一个不存在的上限改参数」。
//   ✅ 现在：上限被 lib/title.js 的 PLATFORM_TITLE_MAX(30) 压住 —— 档案里写 40 也会回到 30；
//      超长时先「去空白 → 去掉（可看评价）尾巴」，实在收不进才截断，且保证括号闭合，
//      不再出现「名字砍一半（…代抢周诗雨）」「括号没闭合（…（可看评价）」这类残缺标题。
//   ⚠️ 桌面引擎 C:\Users\43462\Desktop\xianyu-monitor\publish.js 里有一份手抄的
//      TITLE_MAX = 40 + fitTitle，是【工程】领地，本仓库改不到 —— 两边必须同改
//      （已写进 协作-待办.md 点名【工程】；校验脚本 test-publishjs-fittitle.js / verify-fittitle.js）。
//   为什么补足只补到 30（不是补到 40）：模板1/2/3 只有 22~23 字，补到 40 会变成
//   「…（可看评价） 全站全价位都可接！！！！！！」一串感叹号，难看且不符老板风格。
//   补到 30 的理由不变：卡片标题 = (标题+"\n\n"+正文) 的前 30 字，
//   标题不足 30 会让正文渗进卡片标题。
const TITLE_MAX = Math.min(Number((PROFILE.文案 || {}).titleMax) || titleLib.PLATFORM_TITLE_MAX, titleLib.PLATFORM_TITLE_MAX);
// 【2026-10-07 改】标题最少字数改成读店铺档案（原来这里是 TITLE_MIN_BY_STORE = { '好易美票务Hope': 26 }）。
//   代拍店 30（那是为"卡片标题=前30字、正文不渗进卡片"定的）；
//   hope 店 26（老板 2026-10-07 定：该店现有链接标题平均 26 字，硬补到 30 会塞进「 全站全价位都可接」这类填充词）。
//   新增店铺只需在 stores/<店名>.json 里写 文案.titleMin，不用动这个文件。
const TITLE_MIN = Math.min(Number((PROFILE.文案 || {}).titleMin) || 30, TITLE_MAX);
const TITLE_PAD = [' 全站全价位都可接', ' 全价位都能接', ' 高命中率', ' 全价位接', ' 可上号', ' 秒付前排', ' 稳中', ' 秒付', ' 包中'];
const fitTitle = titleLib.makeFitTitle({ pad: TITLE_PAD, max: TITLE_MAX, min: TITLE_MIN });

function extractFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('找不到: ' + header);
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; } }
  return src.slice(i, k + 1);
}
const dash = fs.readFileSync(path.join(PATHS.xianyuMonitor, 'publish_dashboard.js'), 'utf8');
const SRC_NORM = extractFn(dash, 'function _normLayer(l)');
const SRC_APPLY = extractFn(dash, 'function _iwApplyText(callback, overrides, srcUrl, layersOverride)');
const LIB = eval('(' + (() => { const i = dash.indexOf('var _LAYER_TPL_LIB = {'); let j = dash.indexOf('{', i), d = 0, k = j; for (; k < dash.length; k++) { const c = dash[k]; if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; } } return dash.slice(j, k + 1); })() + ')');
const SHOUKAI = LIB['⑨ 刘宪华首开样式（紫块白字+红字三行·居中）'];

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });

  // 【第 235 轮·提前到最前面】文案模板库必须先有 ——
  //   原来这个检查在 section 3（图都出完了才读），文件不在时学员白等 10 秒
  //   然后看到英文 ENOENT（第235 轮实测）。现在开跑就查，省时间也早点给中文提示。
  //   下面 section 3 读的时候仍带 try/catch（防 TOCTOU 和别处调用）。
  {
    const _tf = path.join(os.homedir(), '.xianyu-templates.json');
    if (!fs.existsSync(_tf)) {
      console.log('❌ 文案模板库还没生成：' + _tf);
      console.log('   没有它就不知道该用哪套文案，所以发链接会停在这一步。');
      console.log('   怎么办：重跑一次 install.cmd（它会生成这个文件），或找管理员要一份 .xianyu-templates.json。');
      process.exit(1);
    }
  }

  // ── 1. 主图模板：从【店铺档案】的 主图.templates 池里随机抽；KUN_MAIN_TPL 指定时用指定的 ──
  // 【2026-10-07 改】原来这里是一个硬编码的 TPLS 数组，装着两个店的全部版式，
  //   于是 ① hope 店会随机抽到代拍店的版式 ② 在服务端版式库里加了新版式但忘了在这里加一行，
  //   指定 KUN_MAIN_TPL 会【静默回落到随机模板】（当天实际踩到：指定 tpl_hope_burst 出了 tpl_redtext）。
  //   现在版式池写在 stores/<店铺名>.json 里，完整定义在 lib/store-profile.js 的 TPL_REGISTRY。
  const TPLS = storeProfile.resolveTemplates(PROFILE);
  // 说明（2026-10-07）：
  //   noDefaultBlocks → 请求带 blocks:[] / tags:[]，服务端 server.js:2316 见 userBlocks 非 null 就
  //     useUserLayout=true → **不叠默认「三黄块+一紫块」、也不叠 cutouts**，底图保持官方原样。
  //     不这么做的话，官方海报上会糊一层老版式的黄块紫块（实测黄块像素占 23%，一眼就看出来）。
  //   stickers → 服务端也有 _bakeStickers 能焊贴纸，但那要重启 8093 才生效；本地焊零重启、可立即验证。
  const FORCE_MAIN = process.env.KUN_MAIN_TPL || '';
  // 【2026-10-11 修·真实踩到】原来写的是
  //     (FORCE_MAIN && TPLS.find(...)) || TPLS[随机]
  //   于是 KUN_MAIN_TPL 指定的版式【不在店铺 主图.templates 池里】时，find 返回 undefined，
  //   表达式直接走 `||` 的右边 → **静默换成随机模板**。上面 2026-10-07 的注释就记过这个坑
  //   （指定 tpl_hope_burst 出了 tpl_redtext），但一直没修；今天我自己又踩了一次：
  //   指定 hmd_poster_suibian 却出了 hmd_yellow_3red，日志第一行还写着"指定"。
  //   现在：池里有就用池里的；池里没有但 TPL_REGISTRY 注册过，就按注册表用（并明确告警）；
  //   两边都没有 → 直接退出。宁可报错，也不要把 A 的图当 B 的图发出去。
  let tpl;
  if (FORCE_MAIN) {
    tpl = TPLS.find(function (x) { return x.key === FORCE_MAIN; });
    if (!tpl && storeProfile.TPL_REGISTRY[FORCE_MAIN]) {
      tpl = storeProfile.resolveTemplates({ name: STORE, 主图: { templates: [FORCE_MAIN] } })[0];
      console.log('⚠️ KUN_MAIN_TPL=' + FORCE_MAIN + ' 不在店铺「' + STORE + '」的 主图.templates 池里，' +
        '但 TPL_REGISTRY 注册过 → 按注册表用它（要它参与随机抽，得加进 stores/' + STORE + '.json）');
    }
    if (!tpl) {
      console.log('❌ KUN_MAIN_TPL=' + FORCE_MAIN + ' 既不在店铺「' + STORE + '」的版式池里，也没在 TPL_REGISTRY 登记 → 停。');
      console.log('   （旧行为是静默回落到随机版式，会把指定的版式和实际发出去的版式对不上）');
      process.exit(1);
    }
  } else {
    tpl = TPLS[Math.floor(Math.random() * TPLS.length)];
  }
  console.log('主图模板' + (process.env.KUN_MAIN_TPL ? '（本批分配）' : '（随机）') + ': ' + tpl.label + '  [' + tpl.key + ']');

  // ── 2. 出图 ──
  // 【2026-10-07 加】KUN_MAIN_IMG 指定本地主图 → 直接用，跳过生成和文字层。
  // 场景：老板给了一张现成海报（北京 IEM 大师赛），要求「用这个主图」。
  // 不传这个变量时行为完全不变（走原来的 /api/poster/make 生成流程）。
  //
  // ⛔【2026-11-12 加护栏 · 老板拍了板】这个口子会【完全绕过店铺版式】。
  //   事故：广州守望先锋首发，我用 KUN_MAIN_IMG 直出「底条版」「顶条+海报+底条三段式」，
  //   老板连续两次打回 —— 「主图版式没有加」「现在这个不显眼啊」。
  //   他要的一直是店里那套黄块+紫块的现役版式（xuliang-v1 / __shoukai）。
  //   所以：走成品图必须显式承认「这张没有版式」—— 加 KUN_ALLOW_PLAIN=1。
  //   不想要摩擦的话，正确姿势是 KUN_BASE_IMG + KUN_MAIN_TPL（底图 + 现役版式）。
  const MAIN_IMG = process.env.KUN_MAIN_IMG || '';
  const ALLOW_PLAIN = process.env.KUN_ALLOW_PLAIN === '1';
  if (MAIN_IMG && !ALLOW_PLAIN) {
    console.log('⛔ KUN_MAIN_IMG 会绕过店铺版式 —— 老板 2026-11-12 明确要求主图【必须带版式】。');
    console.log('   正确做法：KUN_BASE_IMG=<官方海报> + KUN_MAIN_TPL=' + (process.env.KUN_MAIN_TPL || '<版式 key>'));
    console.log('   店铺主图池：' + (PROFILE.主图 && PROFILE.主图.templates ? PROFILE.主图.templates.join(' / ') : '(未配)'));
    console.log('   确实要用不带版式的成品图（老板本人给整张海报那种），加 KUN_ALLOW_PLAIN=1 再跑。');
    process.exit(2);
  }
  if (MAIN_IMG && ALLOW_PLAIN) {
    console.log('⚠️ KUN_ALLOW_PLAIN=1 —— 本次主图【不带店铺版式】，出了事别怪版式系统。');
  }
  let imgB64;
  let r = null;
  // 【2026-10-07 改】底图优先取环境变量 KUN_BASE_IMG，其次取【店铺档案】的 主图.baseImg。
  //   档案里写死 baseImg = 这个店的版式固定配哪张底图（比如白底样板），不用每次传环境变量。
  const BASE_IMG = process.env.KUN_BASE_IMG || tpl.baseImg || '';
  // 【2026-10-08 加】底图的版式从哪来 —— 决定要不要把底图交给服务端。
  //   有的版式（xuliang-v1）在 8093 版式库里 layers=0，它的版式【就是】服务端那套默认
  //   「三黄块+一紫块」，本地无论如何叠不出来 → 必须把底图当 posterB64 交给服务端渲染。
  //   其余版式（kind:'layer' 的 __shoukai、noDefaultBlocks:true 的 tpl_redtext 和 Hope 四套）
  //   版式来自本地 layers，服务端不参与 —— 保持原样，Hope 的干净白底就是靠这条。
  //   ⚠️ 实测：tpl_redtext 走服务端 posterB64 会只剩一个游离的蓝块、红字全丢，所以它必须留在本地。
  const baseViaServer = !!(BASE_IMG && tpl.kind === 'json' && tpl.noDefaultBlocks === false);
  if (MAIN_IMG) {
    if (!fs.existsSync(MAIN_IMG)) { console.log('❌ 指定的主图不存在: ' + MAIN_IMG); process.exit(1); }
    const sharp0 = requireSvc('sharp', '底图/主图的裁切、缩放做不了');
    const raw0 = fs.readFileSync(MAIN_IMG);
    const meta0 = await sharp0(raw0).metadata();
    const w0 = meta0.width, h0 = meta0.height;
    let buf0 = raw0;
    if (Math.abs(w0 / h0 - 3 / 4) > 0.01) {
      const cw = w0 / h0 > 3 / 4 ? Math.round(h0 * 3 / 4) : w0;
      const ch = w0 / h0 > 3 / 4 ? h0 : Math.round(w0 * 4 / 3);
      buf0 = await sharp0(raw0).extract({ left: Math.floor((w0 - cw) / 2), top: Math.floor((h0 - ch) / 2), width: cw, height: ch }).toBuffer();
      console.log('主图: 指定本地图 ' + w0 + 'x' + h0 + ' → 裁成 3:4 (' + cw + 'x' + ch + ')');
    } else {
      console.log('主图: 指定本地图 ' + w0 + 'x' + h0 + '（已是 3:4，不裁）');
    }
    imgB64 = buf0.toString('base64');
    console.log('主图来源: ' + MAIN_IMG);
  } else if (BASE_IMG) {
    // 【2026-10-07 加】KUN_BASE_IMG：本地底图直接当底，**仍然叠文字层**。
    // 与 KUN_MAIN_IMG 的区别：
    //   KUN_MAIN_IMG = 成品图直接用、**不叠**文字层（老板给整张海报的场景）
    //   KUN_BASE_IMG = 换底图、**照旧叠**文字层（白底粉块版要的就是这个）
    //
    // ⚠️ 为什么不走 /api/poster/make 的 posterB64：实测**不生效** ——
    //   传一张纯白 1020x1360 进去，回来的图白色只占 62%，服务端把底图当"垫图"又加工了一遍
    //   （漏出 xuliang-v1 的黄块/紫块）。所以本地直接出底，只把叠字交给渲染器。
    // 【2026-10-08 补】上面那条只对 noDefaultBlocks:true 的版式成立。当版式的版式源头
    //   本来就在服务端（xuliang-v1）时，「漏出黄块紫块」正是我们要的东西 —— 见 baseViaServer。
    const f0 = BASE_IMG;
    if (!fs.existsSync(f0)) { console.log('❌ 指定的底图不存在: ' + f0); process.exit(1); }
    const sharp0 = requireSvc('sharp', '底图/主图的裁切、缩放做不了');
    const raw0 = fs.readFileSync(f0);
    const meta0 = await sharp0(raw0).metadata();
    const w0 = meta0.width, h0 = meta0.height;
    let buf0 = raw0;
    if (Math.abs(w0 / h0 - 3 / 4) > 0.01) {
      const cw = w0 / h0 > 3 / 4 ? Math.round(h0 * 3 / 4) : w0;
      const ch = w0 / h0 > 3 / 4 ? h0 : Math.round(w0 * 4 / 3);
      buf0 = await sharp0(raw0).extract({ left: Math.floor((w0 - cw) / 2), top: Math.floor((h0 - ch) / 2), width: cw, height: ch }).toBuffer();
      console.log('底图: 本地图 ' + w0 + 'x' + h0 + ' → 裁成 3:4 (' + cw + 'x' + ch + ')');
    } else {
      console.log('底图: 本地图 ' + w0 + 'x' + h0 + '（已是 3:4，不裁）');
    }
    if (baseViaServer) {
      // 交给服务端：底图当 posterB64，由它叠这套版式自己的默认块（不传 blocks → useUserLayout=false）
      const bodyB = { city: CITY, star: STAR, source: 'damai_official', ratio: '3:4',
        templateId: tpl.key, posterB64: buf0.toString('base64') };
      r = await post('/api/poster/make', bodyB);
      if (!r.ok || !r.imageB64) { console.log('❌ 底图叠版式失败: ' + (r.error || '')); process.exit(1); }
      console.log('底图: 本地图 → 交服务端叠「' + tpl.label + '」的默认块（baseOrigin=' + (r.baseOrigin || 'posterB64') + '）');
      imgB64 = r.imageB64;
    } else {
      imgB64 = buf0.toString('base64');
      r = { ok: true, imageB64: imgB64, baseOrigin: 'local' };
    }
  } else {
    const body = { city: CITY, star: STAR, source: 'damai_official', ratio: '3:4' };
    if (tpl.kind === 'json') body.templateId = tpl.key; else { body.blocks = []; body.tags = []; }
    // noDefaultBlocks：显式传空 blocks/tags → 服务端 useUserLayout=true → 不叠默认三黄块+一紫块
    if (tpl.noDefaultBlocks) { body.blocks = []; body.tags = []; }
    r = await post('/api/poster/make', body);
    if (!r.ok || !r.imageB64) { console.log('❌ 出图失败: ' + (r.error || '')); process.exit(1); }
    console.log('出图: OK  baseOrigin=' + (r.baseOrigin || 'search'));
    imgB64 = r.imageB64;
  }

  // ── 2b. 本地焊贴纸（带 stickers 的版式用）──
  // 服务端也有 _bakeStickers 能做这件事，但那要**重启 8093** 才生效；
  // 本地焊零重启、当场能验证，而且和"底图来源"这条链路解耦。
  // ⚠️ 【2026-11-11 修】KUN_MAIN_IMG（成品图），必须【跳过贴纸】。
  //   事故：广州守望先锋首发（itemId 1097491887563）随机抽到 hmd_yellow_3red，
  //   它带「三行红字-透明.png」贴纸；虽然走的是 KUN_MAIN_IMG（不叠文字层），
  //   但 stickers 这段只看 tpl.stickers、不看是不是成品图 →
  //   贴纸照样焊到成品图上，「万人团队/不中全额退/战绩可查」把
  //   「2026守望先锋全球总决赛」整块盖住，等于把底条版白做了。
  //   语义上 KUN_MAIN_IMG 就是「整张海报直接用、什么都不叠」，贴纸同理。
  if (!MAIN_IMG && tpl.stickers && tpl.stickers.length) {
    const sharp1 = requireSvc('sharp', '底图/主图的裁切、缩放做不了');
    const buf = Buffer.from(imgB64, 'base64');
    const meta1 = await sharp1(buf).metadata();
    const inputs = [];
    for (const st of tpl.stickers) {
      const sf = path.isAbsolute(st.file) ? st.file : path.join(ROOT, st.file);
      if (!fs.existsSync(sf)) { console.log('  ⚠️ 贴纸不存在，跳过: ' + sf); continue; }
      const sm = await sharp1(sf).metadata();
      const stW = Math.round(meta1.width * (st.sw || 0.3));
      const stH = Math.round(stW * sm.height / sm.width);
      const left = Math.round(meta1.width * (st.cx != null ? st.cx : 50) / 100 - stW / 2);
      const top = Math.round(meta1.height * (st.cy != null ? st.cy : 50) / 100 - stH / 2);
      inputs.push({ input: await sharp1(sf).resize({ width: stW, height: stH }).png().toBuffer(), left, top });
      console.log('  焊贴纸: ' + path.basename(sf) + ' → ' + stW + 'x' + stH + ' @(' + left + ',' + top + ')');
    }
    if (inputs.length) {
      imgB64 = (await sharp1(buf).composite(inputs).png().toBuffer()).toString('base64');
      // ⚠️ 必须回写 r.imageB64 —— 下一步叠文字层读的是 r.imageB64，
      //    不回写的话贴纸会被"从原图重新叠字"的结果盖掉（2026-10-07 实际踩到：爆炸贴整个消失）。
      if (r) r.imageB64 = imgB64;
    }
  }

  let useLayers = [];
  // 【2026-10-08 改】"用指定主图 ⇒ 不叠文字层"这个判断必须放在【取文字层之前】。
  //   原来它放在后面（先打「文字层[tpl_redtext]: 5 层」再清空），于是日志读起来像"叠了 5 层"，
  //   实际一层都没叠 —— 今天拿 KPL 海报跑的时候我自己就被这行日志骗了一下，
  //   只好再去肉眼看渲染结果才确认。日志说 A 做 B 是比没日志更糟的事。
  if (MAIN_IMG) {
    console.log('文字层: 跳过（用了 KUN_MAIN_IMG 指定主图，不叠字）');
  } else {
    if (tpl.kind === 'layer') useLayers = SHOUKAI;
    // 【2026-10-07 改】原来这里只对 tpl_redtext 特判去版式库取 layers ——
    // 新增的 tpl_hope_pink 同样是 kind:'json' 且 layers 存在版式库里，所以改成通用取法。
    // 取不到就是空数组，行为与改动前一致（xuliang-v1 本来就没有 layers）。
    if (tpl.kind === 'json') {
      // ⚠️【2026-11-13 修】原来这里裸调 JSON.parse(8093 返回体)，没有任何保护。
      //   问题：8093 如果是【老版本】（没有 /api/poster/templates 这个接口），
      //   它会返回一页 HTML 404，JSON.parse 直接抛 SyntaxError: Unexpected token '<'，
      //   学员屏幕上是整屏英文 stack trace —— 完全不知道发生了什么，也看不出是版本不匹配。
      //   现在：① 检查状态码 ② try/catch ③ 兜底读本地 lib/poster-templates-approved.json
      //   ④ 都不行就跳过文字层（图照样出，只是没叠字），并说清楚为什么。
      const localTplFile = path.join(ROOT, 'lib', 'poster-templates-approved.json');
      const pickLayers = (data) => ((data && (data.items || data)) || [])
        .filter ? (((data.items || data) || []).find((i) => i && i.id === tpl.key) || {}).layers || [] : [];

      let got = null;
      try {
        const raw = await new Promise((res, rej) => {
          http.get({ host: '127.0.0.1', port: 8093, path: '/api/poster/templates', headers: { 'x-api-key': KEY } },
            (x) => {
              let b = '';
              x.on('data', (c) => { b += c; });
              x.on('end', () => {
                if (x.statusCode !== 200) { rej(new Error('HTTP ' + x.statusCode)); return; }
                res(b);
              });
            }).on('error', rej);
        });
        got = JSON.parse(raw);
      } catch (e) {
        got = null;
        const why = String(e && e.message || e);
        // 这条要说得让人看得懂：学员不知道 8093 版本是什么意思
        console.log('[版式库] 取不到远程版式（' + why + '）—— 8093 可能是旧版本。');
        console.log('         不影响出图，只是这次不叠文字层。');
      }

      if (got) {
        useLayers = pickLayers(got);
        console.log('文字层[' + tpl.key + ']: ' + useLayers.length + ' 层');
      } else {
        // 兜底的真相（2026-11-13 实测过）：
        //   lib/poster-templates-approved.json 是【审核白名单】，结构是
        //     { approved: [{ key, name, src }], pending: [...] }
        //   它只记"哪些版式被老板审核通过过"，【不含 layers 图层数据】——
        //   真正的图层在中台的 poster-templates 表里，由 8093 拉下来。
        //   所以 8093 取不到时，本地【没有办法】还原文字层。
        //   那就别假装能兜底，直说：图照出，字不叠，以及怎么修。
        let whitelisted = false;
        try {
          const local = JSON.parse(fs.readFileSync(localTplFile, 'utf8'));
          whitelisted = ((local && local.approved) || []).some((x) => x && x.key === tpl.key);
        } catch (e2) { /* 本地文件读不到就算了，不影响出图 */ }
        useLayers = [];
        console.log('文字层: 跳过 —— 8093 取不到版式图层' +
          (whitelisted ? '（这个版式在本地白名单里，但图层数据只存在 8093）' : '') + '。');
        console.log('         图照样能出，只是不叠文字。');
        console.log('         要恢复叠字：把 xianyu-playwright-service 更新成跟安装包同一个版本。');
      }
    }
  }
  if (useLayers && useLayers.length) {
    // 【2026-11-13 第 144 轮改；第 162 轮统一到 requireSvc】
    //   这里原来直接 require，没装依赖时抛英文 Cannot find module。
    //   第 162 轮发现 sharp 的四处也一样裸着，于是一并收进 requireSvc()。
    // 【2026-11-14 修】requireSvc 返回的是**模块**，playwright 的模块形状是 { chromium, firefox, webkit, ... }；
      // 原来写成 const chromium = requireSvc('playwright') → chromium 其实是模块本身，.launch 不存在，
      // 于是报 chromium.launch is not a function。改成取 .chromium，业务逻辑一行未动。
      const chromium = requireSvc('playwright', '出图能出，但「把文字叠到图上」这一步做不了').chromium;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: 'window._iw={layers:[],stickerImgs:[],sourceUrl:""};function addLog(){};\n' + SRC_NORM + '\n' + SRC_APPLY + '\nwindow.__render=function(b,l,o){return new Promise(function(r){_iwApplyText(function(d){r(d);},o,"data:image/jpeg;base64,"+b,l);});};' });
    try {
      // 【2026-10-07 改】把 场次/活动类型 也传进去 —— 原来只传 city/star，
      // 于是版式里写 {场次类型}/{活动类型} 会原样留在图上（不替换）。渲染器本来就支持这两个占位符。
      const du = await page.evaluate(({ b64, l, o }) => window.__render(b64, l, o),
        { b64: r.imageB64, l: useLayers, o: { city: CITY, star: STAR, sessionType: SESSION, eventType: EVENT } });
      if (du) { imgB64 = du.replace(/^data:image\/[a-z]+;base64,/, ''); console.log('文字层: 已叠 ' + useLayers.length + ' 层'); }
    } finally { await browser.close(); }
  }

  // 统一转 JPEG（图床接口按 image/jpeg 上传），顺便压小体积
  const sharp = requireSvc('sharp', '底图/主图的裁切、缩放做不了');
  const jpg = await sharp(Buffer.from(imgB64, 'base64')).jpeg({ quality: 92 }).toBuffer();
  const imgFile = path.join(OUTDIR, [CITY, STAR, tpl.key.replace(/[^a-z0-9_-]/gi, ''), Date.now()].join('-') + '.jpg');
  fs.writeFileSync(imgFile, jpg);
  // ── 出图后顺手清理 publish-out ──
  // 【2026-11-13 加】这个目录只增不减：实测 456 个文件 / 161.9 MB，最老的从 09-26 起。
  //   每跑一次（含 --dry）就多一张 300KB 的图，学员反复试模板时会长得很快。
  //   安全性：图片上传后会拿到图床 URL（台账里的「图床URL」字段），
  //   商品显示用的是那个 URL，本地这张删了不影响；
  //   台账里的本地「图片」路径会失效，但那一条同时也记着 URL，回溯不受影响。
  //   策略：只留最近 150 张（约 50 MB），够复盘用。
  try {
    const olds = fs.readdirSync(OUTDIR)
      .map((n) => path.join(OUTDIR, n))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } })
      .map((p) => { try { return { p, t: fs.statSync(p).mtimeMs }; } catch (e) { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    let removed = 0;
    for (const x of olds.slice(150)) {
      try { fs.unlinkSync(x.p); removed++; } catch (e) { /* 占用中就跳过 */ }
    }
    if (removed) console.log('[清理] publish-out 删了 ' + removed + ' 张旧图（保留最近 150 张）');
  } catch (e) { /* 清理失败不影响出图 */ }
  const meta = await sharp(jpg).metadata();
  console.log('图片: ' + path.basename(imgFile) + '  ' + Math.round(jpg.length / 1024) + ' KB  ' + meta.width + 'x' + meta.height);

  // ── 3. 文案：随机一个 titlePattern + 模板正文 ──
  // 【第 235 轮修】这里原来是裸 readFileSync —— 文件不在就抛英文 ENOENT，
  //   而且是在【图都出完了】之后才炸，白等一轮还看不懂。
  //   实测（USERPROFILE 指向空目录）：
  //     ❌ ENOENT: no such file or directory, open '...\.xianyu-templates.json'
  //   同时 install.ps1 那句 warn 还写着「不影响发布」——两边对不上，都改。
  const TPL_FILE = path.join(os.homedir(), '.xianyu-templates.json');
  let T;
  try {
    T = JSON.parse(fs.readFileSync(TPL_FILE, 'utf8'));
  } catch (e) {
    console.log('❌ 文案模板库还没生成：' + TPL_FILE);
    console.log('   没有它就不知道该用哪套文案，所以发链接会停在这一步。');
    console.log('   怎么办：重跑一次 install.cmd（它会生成这个文件），或找管理员要一份 .xianyu-templates.json。');
    process.exit(1);
  }
  // 【2026-10-07 改】按【店铺】分模板池，池子来自【店铺档案】的 文案.templateIds。
  // 背景：一个 json 两个店共用，原来是全库随机抽 —— 一旦加了票务店的文案，
  //   代拍店会抽到票务话术、票务店会抽到代拍话术。
  //   优先级：档案 文案.templateIds > ~/.xianyu-templates.json 的 storeTemplates[店名] > 全部。
  //   （后两层是给"还没建档案的店"兜底的，行为与改动前完全一致）
  //   tools/store-init.js --apply 会把档案的这份列表【同步写回】storeTemplates，让桌面引擎也用同一个池子。
  const ALLOW = (Array.isArray((PROFILE.文案 || {}).templateIds) && PROFILE.文案.templateIds.length)
    ? PROFILE.文案.templateIds
    : ((T.storeTemplates && T.storeTemplates[STORE]) || null);
  const POOL = ALLOW ? T.templates.filter(function (x) { return ALLOW.indexOf(Number(x.id)) >= 0; }) : T.templates;
  if (!POOL.length) { console.log('❌ 店铺「' + STORE + '」的 文案.templateIds 一个都没匹配上：' + JSON.stringify(ALLOW)); process.exit(1); }
  console.log('文案池[' + STORE + ']: ' + POOL.map(function (x) { return x.id; }).join(',') + (ALLOW ? '' : '  (未配置 → 用全部)'));
  // 默认随机抽；publish-batch.js 会用 KUN_TITLE_TPL_ID 指定，做到【批次内不重复】。
  // 背景：N 个模板随机抽 N 次，标题全不重复的概率只有 N!/N^N —— 即大概率撞车。
  const FORCE_TPL = process.env.KUN_TITLE_TPL_ID ? Number(process.env.KUN_TITLE_TPL_ID) : null;
  // 【2026-10-09 修·真实事故】原来这里找不到就【静默回落到随机模板】：
  //   const cand = (... && POOL.find(...)) || POOL[random]
  //   事故：广州徐良补 3 条时第 3 条指定 tplId=5，但档案 文案.templateIds 只有 [1,2,3,4]，
  //   5 不在池里 → 静默随机 → 抽中模板2 → 与【已有那条链接的标题一模一样】。
  //   标题重复是有前科的：10-07 的 b2 批次标题成对重复，有一条直接没进在售（疑似被判重）。
  //   同样的静默回落坑，lib/store-profile.js 的注释里已经记过一次（KUN_MAIN_TPL 静默回落）。
  //   所以改成 fail-closed：指定的模板不在池里就报错退出，绝不猜。
  if (FORCE_TPL != null && !POOL.find(function (x) { return Number(x.id) === FORCE_TPL; })) {
    console.log('❌ KUN_TITLE_TPL_ID=' + FORCE_TPL + ' 不在文案池里（池=' +
      POOL.map(function (x) { return x.id; }).join(',') + '）—— 拒绝静默回落到随机模板。'
      + '\n   要么把该模板加进 档案.文案.templateIds，要么换一个池内的 id。');
    process.exit(1);
  }
  const cand = (FORCE_TPL != null && POOL.find(function (x) { return Number(x.id) === FORCE_TPL; }))
    || POOL[Math.floor(Math.random() * POOL.length)];
  // 【2026-11-14 加】KUN_TITLE 直接给标题（集合链接/万能链接专用）。
  //   为什么需要：模板6 是【固定标题】，一个店只能发一条 —— 第二条集合链接再用它就是标题重复
  //   （10-07 有前科：标题成对重复导致一条没进在售，疑似被判重）。
  //   传 KUN_TITLE='【必中代拍】全平台…' 走同一个 fitTitle 收口（30 字硬上限 + 补位），
  //   正文仍从指定模板取。给了 KUN_TITLE 就不再套模板的 {城市}{明星} 占位符。
  const FORCE_TITLE = process.env.KUN_TITLE || '';
  const titleRes = FORCE_TITLE
    ? fitTitle.detail(FORCE_TITLE)
    : fitTitle.detail(cand.titlePattern.replace(/\{明星\}/g, STAR).replace(/\{城市\}/g, CITY)
      .replace(/\{场次类型\}/g, SESSION).replace(/\{活动类型\}/g, EVENT));
  const title = titleRes.text;
  const descBody = cand.descPattern;
  const fullDesc = title + '\n\n' + descBody;
  console.log('文案模板' + (FORCE_TPL != null ? '（本批分配）' : '（随机）') + ': 模板' + cand.id);
  console.log('  标题(' + title.length + '): ' + JSON.stringify(title));
  // 【2026-10-11 加】标题被瘦身/截断时说清楚，别让它静默发生 ——
  //   以前是平台在尾部偷偷砍，我们回读才发现（还要靠人去对）。
  if (titleRes.how) {
    console.log('  ⚠️ 标题超出 ' + TITLE_MAX + ' 字上限 → ' + titleRes.how +
      '（闲鱼硬上限 30 字，不自己收好就会被平台从尾部静默砍掉）');
  }
  console.log('  正文 ' + descBody.length + ' 字 / ' + descBody.split('\n').length + ' 行');
  // 卡片标题 = fullDesc.slice(0,30)。标题上限提到 40 后，标题>30 字时
  // fullDesc.slice(0,30) 必然 ≠ 整个标题 —— 那是设计如此，不是错误。
  // 这里要检的是「有没有正文渗进卡片标题」，即卡片那 30 字是否就是标题的前 30 字。
  // 【2026-10-07 补】标题 < 30 字时必然"渗" —— 因为标题本身就不够 30 字，卡片会接着读正文。
  //   这不是 bug，是 TITLE_MIN 这个参数的直接后果（hope 店 26 就是老板定的取舍）。
  //   所以分开报：≥30 才是真检查，<30 只提示"漏几个字"。
  if (title.length >= 30) {
    console.log('  卡片标题(=前30字) == 标题前30字: ' + (fullDesc.slice(0, 30) === title.slice(0, 30)
      ? '✅ 正文没渗进卡片（标题 ' + title.length + ' 字）'
      : '❌ 正文渗进卡片标题了'));
  } else {
    console.log('  卡片标题: 标题只有 ' + title.length + ' 字 → 卡片会读到正文前 ' + (30 - title.length - 2) +
      ' 字（TITLE_MIN=' + TITLE_MIN + ' 的既定取舍，不是 bug）');
  }
  console.log('  全文 ' + fullDesc.length + ' 字，含 ' + (fullDesc.match(/\n/g) || []).length + ' 个换行');
  if (ADDR) console.log('  所在地: ' + ADDR.prov + '/' + ADDR.city + '/' + ADDR.area + '/' + ADDR.divisionId + '（按演唱会城市覆盖）');
  else console.log('  ⚠️ 所在地: 城市「' + CITY + '」不在 CITY_ADDR 表里 → 按规则就近落到 ' +
    (ADDR ? ADDR.city + ADDR.area : '（无可用地址）') + '（标题仍是「' + CITY + '」）。要按城市挂请补 CITY_ADDR。');
  // ── 3b. 副图清单（这里只解析，真上传在 DRY 之后）──
  // 背景（2026-10-07）：好易美票务Hope 的现有链接是「1 主图 + 8 副图」，
  //   而本脚本原来只发 1 张。三种给法：
  //     KUN_SUB_IMGS="/a/1.jpg,/a/2.jpg"    按顺序指定
  //     KUN_SUB_DIR="D:/pics/hope-sub"      取目录下所有图（按文件名排序）
  //     都不传 + 是 hope 店 → 用老板定的【固定 8 张战绩图】（见 STORE_SUB_DEFAULT）
  const SUB_ARG = process.env.KUN_SUB_IMGS || '';
  let SUB_DIR = process.env.KUN_SUB_DIR || '';
  // 【2026-10-07 改】副图目录改成读【店铺档案】的 副图.dir（原来是 STORE_SUB_DEFAULT 按店名 if）。
  //   显式传 KUN_SUB_* 时以显式为准 —— 档案只是"这个店默认发哪组副图"。
  const PROFILE_SUB_DIR = (PROFILE.副图 || {}).dir || '';
  if (!SUB_ARG && !SUB_DIR && PROFILE_SUB_DIR) {
    const d0 = path.isAbsolute(PROFILE_SUB_DIR) ? PROFILE_SUB_DIR : path.join(ROOT, PROFILE_SUB_DIR);
    if (fs.existsSync(d0)) { SUB_DIR = d0; console.log('副图: 用档案里「' + STORE + '」的固定副图（' + PROFILE_SUB_DIR + '）'); }
    else console.log('⚠️ 档案写的副图目录不存在，本次不发副图: ' + d0);
  }
  let subFiles = [];
  if (SUB_ARG) subFiles = SUB_ARG.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  else if (SUB_DIR && fs.existsSync(SUB_DIR)) {
    subFiles = fs.readdirSync(SUB_DIR).filter(function (f) { return /\.(jpe?g|png|webp)$/i.test(f); }).sort()
      .map(function (f) { return path.join(SUB_DIR, f); })
      // 🛡 护栏：副图目录里混进主图 → 主图会被【再发一遍】，详情页出现两张一样的主图。
      //    tools/fetch-sub-images.js 已经把主图单独放 <id>/主图.jpg、副图放 <id>/副图/，
      //    但如果有人手工把主图也拷进副图目录，这里必须拦住。
      .filter(function (f) {
        if (/主图/.test(path.basename(f))) { console.log('⚠️ 副图目录里混进主图，已跳过: ' + path.basename(f)); return false; }
        return true;
      });
  }
  subFiles = subFiles.filter(function (f) { if (!fs.existsSync(f)) { console.log('⚠️ 副图不存在，跳过: ' + f); return false; } return true; });
  console.log('副图: ' + (subFiles.length
    ? subFiles.length + ' 张 → ' + subFiles.map(function (f) { return path.basename(f); }).join(', ')
    : '无（要发副图请传 KUN_SUB_IMGS= 或 KUN_SUB_DIR=）'));

  // ── 3c. 档案对照表（2026-10-07 加）──
  // 这是 --dry 最有价值的一屏：把"这次发布实际会用什么配置"逐项打出来。
  // 以前这 10 个维度散在代码里，只能靠读源码确认；现在一屏对照 stores/<店名>.json。
  console.log('\n── 档案对照表 stores/' + STORE + '.json ──');
  console.log('  店铺/账号 : ' + STORE + '  ' + (PROFILE.accountId || '⚠️未填'));
  console.log('  主图      : ' + tpl.label + ' [' + tpl.key + ']  池=' + TPLS.map(function (x) { return x.key; }).join(','));
  console.log('  底图      : ' + (MAIN_IMG ? 'KUN_MAIN_IMG=' + MAIN_IMG : (BASE_IMG ? '本地底图 ' + BASE_IMG : '官方海报自动选（大麦）')));
  console.log('  副图      : ' + (subFiles.length ? subFiles.length + ' 张（档案 副图.dir=' + (PROFILE_SUB_DIR || '—') + '）' : '无'));
  console.log('  文案      : 池=' + POOL.map(function (x) { return x.id; }).join(',') + '  本次=模板' + cand.id);
  console.log('  标题字数  : ' + TITLE_MIN + ' ~ ' + TITLE_MAX);
  console.log('  分类      : ' + CAT.catName + '  catId=' + CAT.catId + ' channelCatId=' + CAT.channelCatId + (CAT.tbCatId ? ' tbCatId=' + CAT.tbCatId : ''));
  console.log('  规格      : ' + SPEC.propertyName + ' → ' + SPEC.itemSkuList.map(function (s) {
    return s.propertyList[0].valueText + ' ¥' + (Number(s.priceInCent) / 100) + ' ×' + s.quantity;
  }).join(' | ') + (SPECS_ARG ? '   ← --specs 临时指定（压过档案）' : ''));
  console.log('  价格/库存 : ¥' + PRICE + ' 起 / ' + STOCK + (PRICE !== PROFILE_PRICE ? '（本批覆盖，档案默认 ¥' + PROFILE_PRICE + '）' : ''));
  console.log('  所在地    : mode=' + (LOC.mode || 'city') + (LOC.fixedCity ? ' 固定=' + LOC.fixedCity + '/' + (LOC.fixedDistrict || '') : '') +
    '  本次=' + (ADDR ? ADDR.prov + '/' + ADDR.city + '/' + ADDR.area + '/' + ADDR.divisionId : '（无）'));
  console.log('  发货方式  : ' + SHIP + (SHIP === 'nomail' ? '（面交/虚拟）' : ''));
  console.log('  服务承诺  : ' + (function () {
    if (COMMIT.serviceCodes && COMMIT.serviceCodes.length) return COMMIT.serviceCodes.join(' + ') + '（直传 code）';
    var on = [];
    if (COMMIT.refundFull) on.push('退款');
    if (COMMIT.refundPostage) on.push('退运费');
    if (COMMIT.fastShip) on.push('极速发货');
    return on.length ? on.join(' + ') + '（布尔开关 → 映射成 GUARANTEE_REFUND/RETURN_POSTAGE/FAST_SHIP，与闲鱼实抓的 code 对不上，建议改用 serviceCodes）' : '全不勾（仅基座 无需物流）';
  })());
  console.log('  广告      : ' + ((PROFILE.广告 || {}).enabled === false ? '关闭（不参与自动开窗）' : '参与自动开窗，日预算上限 ¥' + ((PROFILE.广告 || {}).planBudget || 0)));

  if (DRY) { console.log('\n[--dry] 不发布'); return; }

  // ── 4. 上传主图到闲鱼图床 ──
  const up = await post('/api/agent/upload-image', { store: STORE, imageB64: jpg.toString('base64') }, 180000);
  if (!up.ok || !up.url) { console.log('❌ 图床上传失败: ' + (up.error || '')); process.exit(1); }
  console.log('图床: ' + up.url);

  // ── 4b. 上传副图（顺序 = 你给的顺序；payload 里只有第一条 major:true）──
  const subs = [];
  for (let i = 0; i < subFiles.length; i++) {
    const f = subFiles[i];
    try {
      const b = await sharp(f).jpeg({ quality: 92 }).toBuffer();
      const m2 = await sharp(b).metadata();
      const u2 = await post('/api/agent/upload-image', { store: STORE, imageB64: b.toString('base64') }, 180000);
      if (!u2.ok || !u2.url) { console.log('  ⚠️ 副图' + (i + 1) + ' 上传失败，跳过: ' + path.basename(f) + ' ' + (u2.error || '')); continue; }
      subs.push({ url: u2.url, width: m2.width, height: m2.height, file: path.basename(f) });
      console.log('  副图' + subs.length + ' ✅ ' + path.basename(f) + '  ' + m2.width + 'x' + m2.height);
    } catch (e) {
      console.log('  ⚠️ 副图' + (i + 1) + ' 处理失败，跳过: ' + path.basename(f) + ' ' + e.message);
    }
  }
  console.log('副图上传完成: ' + subs.length + ' / ' + subFiles.length + ' 张');

  // ── 5. 走 mtop API 发布 ──
  const inner = `(async function(){
  var out = { href: location.href };
  if (!window.lib || !window.lib.mtop) return Object.assign(out, { err: 'no window.lib.mtop（需在 www.goofish.com 页面）' });
  var sp = null;
  try {
    var pr = await window.lib.mtop.request({ api: 'mtop.taobao.idle.local.poi.get', v: '1.0', data: { longitude: '120.6', latitude: '31.3' }, headers: { 'EagleEye-UserData': 'spm-cnt=a21ybx' }, type: 'GET' });
    sp = pr && pr.data && pr.data.selectedPoi;
  } catch (e) { out.poiErr = (e && (e.ret || e.message)) || String(e); }
  if (!sp || !sp.city || !sp.divisionId) return Object.assign(out, { err: '拿不到官方定位 selectedPoi' });
  // poi.get 只认账号绑定定位（入参全被忽略），所以它只代表“默认值”
  out.定位_账号默认 = sp.city + '/' + (sp.area || '') + '/' + sp.divisionId;
  // 本次【实际发送】的所在地：优先用城市映射表（=演唱会城市），没配到才退回账号默认
  var ADDR = ${JSON.stringify(ADDR)};
  var addr = ADDR
    ? { area: ADDR.area, city: ADDR.city, divisionId: ADDR.divisionId, prov: ADDR.prov }
    : { area: sp.area || '', city: sp.city, divisionId: sp.divisionId, prov: sp.prov || '' };
  out.定位_本次发送 = addr.prov + '/' + addr.city + '/' + addr.area + '/' + addr.divisionId;
  out.定位_已覆盖城市 = !!ADDR;
  var url = ${JSON.stringify(up.url)};
  var data = {
    freebies: false, itemTypeStr: 'b', quantity: ${JSON.stringify(STOCK)}, simpleItem: 'true',
    imageInfoDOList: [{
      extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
      isQrCode: false, url: url, heightSize: ${meta.height}, widthSize: ${meta.width},
      major: true, type: 0, status: 'done'
    }].concat(${JSON.stringify(subs)}.map(function (s) {
      return { extraInfo: { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: false,
               url: s.url, heightSize: s.height, widthSize: s.width,
               major: false, type: 0, status: 'done' };
    })),
    itemTextDTO: { desc: ${JSON.stringify(fullDesc)}, title: ${JSON.stringify(title)}, titleDescSeparate: false },
    itemLabelExtList: [{
      channelCateName: ${JSON.stringify(CAT.catName)}, channelCateId: ${JSON.stringify(CAT.channelCatId)},
      propertyName: '分类', propertyId: '-10000', text: ${JSON.stringify(CAT.catName)},
      properties: ${JSON.stringify('-10000##分类:' + CAT.channelCatId + '##' + CAT.catName)},
      labelType: 'common', isUserClick: '1', from: 'newPublishChoice', labelFrom: 'newPublish'
    }],
    itemPriceDTO: {},
    defaultPrice: false,
    // 单档/多档规格：顶层 quantity 不生效（publish.js 抓包注释 + sku-structure-sample.json 均证实），
    // 真实库存在 itemSkuList[].quantity，而 itemSkuList 必须搭配 itemProperties 才生效。
    // 启用规格后 itemPriceDTO 必须为空对象 {}，价格改由 SKU 决定。
    // 【2026-10-07 改】规格从【店铺档案】的 规格 生成（原来写死「代拍费/标准」一档）：
    //   单档 → 1 条 sku；多档 → N 条，每档可单独给 price/quantity。
    itemProperties: [{
      propertyName: ${JSON.stringify(SPEC.propertyName)}, supportImage: false,
      propertyValues: ${JSON.stringify(SPEC.propertyValues)}
    }],
    itemSkuList: ${JSON.stringify(SPEC.itemSkuList)},
    // 【2026-10-06 修】原来 gps 无条件用账号默认定位（杭州）的坐标 →
    // 广州的链接行政区划写「广州/天河区」、经纬度却是杭州的，自相矛盾。
    // 区池里每个区都带实测坐标，优先用它；没有才退回账号默认。
    itemAddrDTO: { area: addr.area, city: addr.city, divisionId: addr.divisionId, gps: ${JSON.stringify((ADDR && ADDR.gps) || '')} || ((sp.latitude || '') + ',' + (sp.longitude || '')), poiId: '', poiName: '', prov: addr.prov },
    // 【2026-10-07 改】发货方式 + 服务承诺 都从【店铺档案】来（原来写死"面交、包邮全关、不勾任何承诺"）。
    //   语义与桌面引擎 publish.js L761-770 完全一致，改一处必须改两处。
    //   shipMode: nomail=面交 | free=包邮 | distance=按距离 | fixed=固定邮费¥10
    //   承诺: GUARANTEE_REFUND / RETURN_POSTAGE / FAST_SHIP，基座恒为「无需物流」(enable:false)
    userRightsProtocols: (function () {
      var c = ${JSON.stringify(COMMIT)};
      // 【2026-10-07 加】serviceCodes 优先 —— 它是闲鱼自己的 code，最权威；
      //   布尔开关那套是桌面引擎自己写的映射，与 2026-09-13 实抓的 payload 对不上（见 lib/store-profile.js 注释）。
      if (c.serviceCodes && c.serviceCodes.length) {
        var raw = [{ enable: false, serviceCode: 'SKILL_PLAY_NO_MIND' }];
        for (var i = 0; i < c.serviceCodes.length; i++) raw.push({ enable: true, serviceCode: c.serviceCodes[i] });
        return raw;
      }
      var rights = [{ enable: false, serviceCode: 'SKILL_PLAY_NO_MIND' }];
      if (c.refundFull) rights.push({ enable: true, serviceCode: 'GUARANTEE_REFUND' });
      if (c.refundPostage) rights.push({ enable: true, serviceCode: 'RETURN_POSTAGE' });
      if (c.fastShip) rights.push({ enable: true, serviceCode: 'FAST_SHIP' });
      return rights;
    })(),
    itemPostFeeDTO: (function () {
      var m = ${JSON.stringify(SHIP)};
      if (m === 'free') return { canFreeShipping: true, supportFreight: false, onlyTakeSelf: false, templateId: '0' };
      if (m === 'distance') return { canFreeShipping: false, supportFreight: true, onlyTakeSelf: false, templateId: '0' };
      if (m === 'fixed') return { canFreeShipping: false, supportFreight: true, onlyTakeSelf: false, templateId: '0', postage: 1000 };
      return { canFreeShipping: false, supportFreight: false, onlyTakeSelf: false, templateId: '0' };
    })(),
    // tbCatId：闲鱼编辑接口实抓的 payload 里有（代购 = 50664002），
    // 但两个引擎原先都没发。档案没写就不发（保持原行为），写了才带上。
    itemCatDTO: (function () {
      var d = { catId: ${JSON.stringify(CAT.catId)}, catName: ${JSON.stringify(CAT.catName)}, channelCatId: ${JSON.stringify(CAT.channelCatId)} };
      var tb = ${JSON.stringify(CAT.tbCatId || '')};
      if (tb) d.tbCatId = tb;
      return d;
    })(),
    uniqueCode: Date.now() + '_' + Math.random().toString(36).substring(2, 10),
    sourceId: 'pcMainPublish', bizcode: 'pcMainPublish', publishScene: 'pcMainPublish'
  };
  // 【2026-10-08 修】发布调用必须 try/catch，并且错误必须带信息出来。
  //   为什么：mtop 失败时 reject 的是【普通对象】（不是 Error）。不接就冒到 Playwright，
  //   报成一句毫无信息的 "page.evaluate: Object" —— 2026-10-08 成都第 4 条连炸两次就是这个，
  //   真实错误（闲鱼为什么拒）全丢了，只能靠猜。
  //   resp.data 有循环引用时 JSON.stringify 也会抛，一并兜住。
  function safeStr(v) {
    try { return JSON.stringify(v); } catch (e) { return '[不可序列化: ' + ((e && e.message) || String(e)) + ']'; }
  }
  var resp = null;
  try {
    resp = await window.lib.mtop.request({ api: 'mtop.idle.pc.idleitem.publish', v: '1.0', data: data, type: 'POST' });
  } catch (e) {
    out.err = 'PUBLISH_REJECT ' + ((e && e.ret) ? ('ret=' + safeStr(e.ret))
      : (e && e.message ? ('msg=' + e.message) : ('raw=' + safeStr(e))));
    out.ret = (e && e.ret) || null;
    out.dataSample = safeStr(e).slice(0, 500);
    return out;
  }
  out.ret = resp && resp.ret;
  function deepId(o, d) {
    if (!o || typeof o !== 'object' || d > 6) return '';
    if (o.itemId) return String(o.itemId);
    if (o.id && /^\\d{6,}$/.test(String(o.id))) return String(o.id);
    if (typeof o.redirectUrl === 'string') { var m = o.redirectUrl.match(/itemId=(\\d+)/); if (m) return m[1]; }
    for (var k in o) { if (typeof o[k] === 'object') { var v = deepId(o[k], d + 1); if (v) return v; } }
    return '';
  }
  out.itemId = deepId(resp && resp.data, 0);
  out.dataSample = safeStr(resp && resp.data).slice(0, 400);
  return out;
})()`;

  console.log('\nAPI 发布中...');
  await post('/api/agent/eval-on-store', { store: STORE, code: 'location.href="https://www.goofish.com/"; "ok"' }, 60000);
  await new Promise(z => setTimeout(z, 9000));
  const res = await post('/api/agent/eval-on-store', { store: STORE, code: inner }, 300000);
  console.log('返回: ' + JSON.stringify(res, null, 2));

  const out = res.result || {};

  // ── 6. 回读校验（2026-10-07 加）──
  // 为什么必须做：发布返回 SUCCESS 只代表"闲鱼收下了"，不代表字段真的落成了我们想要的样子。
  //   以前规格/库存根本读不回来（买家页不渲染规格、pc.detail 挂死、idleitem.detail ABORT），
  //   所以"发出去的规格对不对"只能靠信任返回值 —— 那不叫验证。
  //   现在用编辑页自己的接口 mtop.idle.pc.idleitem.editdetail 把真实字段读回来逐项比。
  //   实测：这个接口在 www.goofish.com 首页也能直接调，不用额外导航。
  let verify = null;
  if (out.itemId && !NO_VERIFY) {
    const vcode = `(async function(){
  function timeout(p, ms, l){ return Promise.race([p, new Promise(function(_, r){ setTimeout(function(){ r(new Error('超时 ' + l)); }, ms); })]); }
  var mtop = window.lib && window.lib.mtop && window.lib.mtop.request;
  if (!mtop) return JSON.stringify({ err: 'no window.lib.mtop' });
  try {
    var r = await timeout(mtop({ api: 'mtop.idle.pc.idleitem.editdetail', v: '1.0', data: { itemId: ${JSON.stringify(String(out.itemId))} }, type: 'GET' }), 25000, 'editdetail');
    var d = (r && r.data) || {};
    return JSON.stringify({
      ret: r && r.ret,
      sku: (d.itemSkuList || []).map(function (s) {
        var v = (s.propertyList && s.propertyList[0]) || {};
        return { property: v.propertyText, name: v.valueText, price: Number(s.priceInCent) / 100, stock: Number(s.quantity) };
      }),
      cat: d.itemCatDTO || null, postFee: d.itemPostFeeDTO || null,
      rights: d.userRightsProtocols || null, images: (d.imageInfoDOList || []).length,
      title: ((d.itemTextDTO || {}).title) || ''
    });
  } catch (e) { return JSON.stringify({ err: (e && (e.ret || e.message)) || String(e) }); }
})()`;
    try {
      const vr = await post('/api/agent/eval-on-store', { store: STORE, code: vcode }, 120000);
      verify = (vr && vr.ok === true) ? (typeof vr.result === 'string' ? JSON.parse(vr.result) : vr.result)
        : { err: (vr && vr.error) || 'eval 失败' };
    } catch (e) { verify = { err: e.message }; }

    console.log('\n── 平台侧回读校验（editdetail）──');
    if (!verify || verify.err) {
      console.log('  ⚠️ 读不回来，没法校验：' + ((verify && verify.err) || '未知'));
    } else {
      const wantSku = SPEC.itemSkuList.map(function (s) {
        return { name: s.propertyList[0].valueText, price: Number(s.priceInCent) / 100, stock: Number(s.quantity) };
      });
      const gotSku = (verify.sku || []).map(function (s) { return { name: s.name, price: s.price, stock: s.stock }; });
      const skuOk = JSON.stringify(gotSku) === JSON.stringify(wantSku);
      console.log('  ' + (skuOk ? '✅' : '❌') + ' 规格/价格/库存: ' +
        (gotSku.map(function (s) { return s.name + ' ¥' + s.price + ' ×' + s.stock; }).join(' | ') || '（无）') +
        (skuOk ? '' : '   期望 ' + wantSku.map(function (s) { return s.name + ' ¥' + s.price + ' ×' + s.stock; }).join(' | ')));
      const catOk = !!verify.cat && String(verify.cat.catId) === String(CAT.catId) && String(verify.cat.channelCatId) === String(CAT.channelCatId);
      console.log('  ' + (catOk ? '✅' : '❌') + ' 分类: ' + (verify.cat ? verify.cat.catName + ' ' + verify.cat.catId + '/' + verify.cat.channelCatId : '（无）'));
      const feeOk = !!verify.postFee && (verify.postFee.canFreeShipping === 'true' ? SHIP === 'free' : true);
      console.log('  ' + (feeOk ? '✅' : '❌') + ' 发货: ' + (verify.postFee ? '包邮=' + verify.postFee.canFreeShipping + ' 到付=' + verify.postFee.supportFreight + ' 自提=' + verify.postFee.onlyTakeSelf : '（无）'));
      const wantRights = (COMMIT.serviceCodes && COMMIT.serviceCodes.length) ? COMMIT.serviceCodes.slice() : [];
      const gotRights = (verify.rights || []).filter(function (x) { return x.enable === 'true' || x.enable === true; }).map(function (x) { return x.serviceCode; });
      console.log('  ' + (JSON.stringify(gotRights) === JSON.stringify(wantRights) ? '✅' : '❌') + ' 承诺: ' + (gotRights.join(',') || '（全不勾）'));
      const imgWant = 1 + subs.length;
      console.log('  ' + (verify.images === imgWant ? '✅' : '❌') + ' 图片数: ' + verify.images + '（主图 1 + 副图 ' + subs.length + '）');
      const titleOk = verify.title === title;
      console.log('  ' + (titleOk ? '✅' : '❌') + ' 标题: ' + (titleOk ? '一致' : JSON.stringify(verify.title)));
    }
  }

  const LEDGER = path.join(ROOT, '上架台账.json');
  // 台账记名（协作约定 §3）：这条是谁发的。KUN_BY='运营' / '工程'。
  // 【2026-10-11 加，应【工程】在 协作-待办.md 的请求】原来这一行不写 by，
  //   于是除了 tools/publish-schedule.js 事后按 itemId 回填之外，别的发布入口
  //   （tools/publish-group.js 手跑、桌面引擎）发出来的行**永远没有署名**，
  //   出了事查不到是谁发的（10-11 深圳王者荣耀重复铺货就卡在这儿）。
  //   没设 KUN_BY 就是空串：空串是假值，tools/publish-schedule.js 的
  //   `!r.by` 回填逻辑照样能把它补上，所以两条路不打架。
  const BY = process.env.KUN_BY || '';
  let led = [];
  try { led = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { }
  led.push({
    时间: new Date().toISOString(), 路径: 'mtop API', store: STORE, city: CITY, star: STAR,
    event: EVENT, session: SESSION, price: PRICE, stock: STOCK,
    itemId: out.itemId || null, ok: !!(res.ok && out.itemId),
    主图模板: tpl.key, 主图模板名: tpl.label, 文案模板id: cand.id,
    店铺档案: 'stores/' + STORE + '.json',
    分类: CAT.catName + '/' + CAT.catId + '/' + CAT.channelCatId,
    规格: SPEC.itemSkuList.map(function (s) { return s.propertyList[0].valueText + ':' + (Number(s.priceInCent) / 100); }).join('|'),
    发货方式: SHIP, 承诺: [COMMIT.refundFull ? '退款' : '', COMMIT.refundPostage ? '退运费' : '', COMMIT.fastShip ? '极速发货' : ''].filter(Boolean).join('+') || '无',
    标题: title, 标题字数: title.length, 图片: imgFile, 图床URL: up.url,
    正文字数: descBody.length, 全文长度: fullDesc.length,
    定位: out.定位_本次发送 || '', 定位_账号默认: out.定位_账号默认 || '', 定位_已按城市覆盖: !!out.定位_已覆盖城市,
    回读校验: verify ? (verify.err ? ('读取失败: ' + verify.err) : {
      规格: (verify.sku || []).map(function (s) { return s.name + ':' + s.price + 'x' + s.stock; }).join('|'),
      分类: verify.cat ? verify.cat.catId + '/' + verify.cat.channelCatId : '',
      承诺: (verify.rights || []).filter(function (x) { return x.enable === 'true' || x.enable === true; }).map(function (x) { return x.serviceCode; }).join(','),
      图片数: verify.images,
      标题一致: verify.title === title,
    }) : '（跳过）',
    ret: out.ret || null, 错误: out.err || res.error || '',
    by: BY,
  });
  fs.writeFileSync(LEDGER, JSON.stringify(led, null, 2));
  console.log('已记账 ' + LEDGER + '   by=' + (BY || '（空：未设 KUN_BY，下游仍可回填）'));
  if (out.itemId) console.log('\n✅ https://www.goofish.com/item?id=' + out.itemId);
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
