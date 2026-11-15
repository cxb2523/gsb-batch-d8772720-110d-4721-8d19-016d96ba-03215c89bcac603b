/**
 * lib/store-profile.js — 店铺档案（一店一文件）
 *
 * 为什么存在（2026-10-07）：
 *   在这之前，一个店铺的"个性"散落在 8 个地方 —— publish-one.js 的代码常量、lib/config.json、
 *   ~/.xianyu-templates.json 的 storeTemplates、8093 的版式库、goofish 页的 kun_store_cfg_<店>、
 *   本地 localStorage 的 kun_tpl_<店>、browser-profiles/<accountId>/state.json、publish-assets/<店>/。
 *   于是"配一个新店"= 在 8 个地方各改一次，而且改完不知道漏没漏 —— 实测开一个店要花近一天。
 *
 *   现在：一个店铺 = 一个 JSON 文件 stores/<店铺名>.json，本文件负责读它、补默认值、
 *   把版式 id 解析成注册表里的完整定义。写它（推送到上面那些位置）是 tools/store-init.js 的事。
 *
 * 设计约束：
 *   1. 档案里【只放会变的东西】。机器路径 / API Key / 闲鱼账号密码【不进档案】——
 *      档案要进 git，而且会发给学员。那些走 config.local.json（本机专属、已 gitignore）和中台。
 *   2. 没档案 = 好易美代拍今天的行为（DEFAULTS 就是照它抄的）。
 *      所以"给老店补档案"是零行为变更的改动，不会静默改变正在跑的店铺。
 *   3. 档案写了但值非法 → 报错退出，【绝不静默回落】。今天已经踩过
 *      "KUN_MAIN_TPL 指定 tpl_hope_burst 却出了 tpl_redtext"（TPLS 硬编码匹配不上，静默随机）。
 *
 * 用法：
 *   const { load, list, resolveTemplates, TPL_REGISTRY, DEFAULTS } = require('./lib/store-profile');
 *   const P = load('好易美票务Hope');
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'stores');

/**
 * 版式注册表 —— 店铺档案里【只写 id】，完整定义（标签/取层方式/是否叠默认色块/贴纸）在这里。
 * 为什么拆开：档案要给人看、要能 diff，不该塞满几何参数；而"哪些版式存在"是代码知识。
 *
 * kind:
 *   'json'  = 版式在 8093 的 poster-templates.json 里（发布时按 templateId 取底图 + 取 layers）
 *   'layer' = 版式是 publish_dashboard.js 里的 _LAYER_TPL_LIB（只有文字层，无服务端注册）
 * noDefaultBlocks:
 *   true → 请求带 blocks:[]/tags:[]，服务端 useUserLayout=true，不叠默认「三黄块+一紫块」。
 *   用了自己设计底图/贴纸的版式【必须】为 true，否则官方海报上会糊一层老版式。
 * stickers:
 *   本地焊贴纸（sharp composite）。服务端也能焊（_bakeStickers），但那要重启 8093。
 */
const TPL_REGISTRY = {
  // ── 好易美代拍在用 ──
  // 【2026-10-08 修】必须显式 noDefaultBlocks:false。
  //   xuliang-v1 在 8093 版式库里的 layers = 0，它的版式【就是】服务端那套默认「三黄块+一紫块」
  //   （老板的基准图 闲鱼上架图片/好易美代拍/*-xuliang-v1.jpg 正是这个样子）。
  //   而 L208 的 Object.assign 默认值写的是 noDefaultBlocks:true，等于把它的版式源头掐了 ——
  //   结果是「抽到 xuliang-v1 就出一张裸官方海报」，而它的 label 还写着"三黄块+一紫块"，行为与标签相反。
  'xuliang-v1': { label: '三黄块+一紫块', kind: 'json', noDefaultBlocks: false },
  '__shoukai': { label: '首开紫块样式（干净版）', kind: 'layer' },
  'tpl_redtext': { label: '白底红字版', kind: 'json' },
  // 【2026-10-11 加】老板自制主图模版（黄块 + 三行红字），A+B 两种机制第一次同时用上：
  //   A（文字层）= 黄块底条 + {城市}{明星}，在 8093 版式库 hmd_yellow_3red 里，可精确换字换色；
  //   B（贴纸）  = 三行固定卖点「万人团队/不中全额退/成绩可查」，从老板原图整块抠成透明 PNG，
  //                本地 sharp 焊 —— 因为它是双描边（红字+黄描边+黑外描边），而渲染器 _normLayer
  //                只保留单个 stroke，用文字层无论如何都做不出第二道描边。
  //   baseImg 指白底：这个设计是白底的，不能让它去抓官方海报当底图。
  'hmd_yellow_3red': {
    label: '黄块三行红字版（白底）', kind: 'json', noDefaultBlocks: true,
    baseImg: 'publish-assets/好易美代拍/版式/白底-1440x1920.png',
    stickers: [{ file: 'publish-assets/好易美代拍/版式/三行红字-透明.png', cx: 50, cy: 60.5, sw: 0.9556 }],
  },
  // ── 好易美票务Hope 的 5 套（2026-10-07 逆向老板给的白底样板建成）──
  'tpl_hope_pink': { label: 'Hope白底粉块版', kind: 'json', noDefaultBlocks: true },
  'tpl_hope_burst': {
    label: 'Hope红爆炸贴版', kind: 'json', noDefaultBlocks: true,
    // 爆炸贴几何由 tools/extract-sticker.js 量的：822x490，宽占 85.6%，中心 (49.8%, 60.5%)
    stickers: [{ file: 'publish-assets/hope-待建模版/爆炸贴-透明.png', cx: 49.8, cy: 60.5, sw: 0.856 }],
  },
  'tpl_hope_pink3': { label: 'Hope三粉块倾斜版', kind: 'json', noDefaultBlocks: true },
  'tpl_hope_yellow': { label: 'Hope黄块黑字版', kind: 'json', noDefaultBlocks: true },
  // 【2026-10-11 加】B 路的示范版式：官方海报当底 + 随便问必中贴纸，不叠任何文字层。
  //   不在店铺 主图.templates 池里（不参与随机抽，别影响正在跑的店），要用手动指定：
  //     KUN_MAIN_TPL=hmd_poster_suibian node publish-one.js <城市> <明星>
  'hmd_poster_suibian': {
    label: '官方海报+随便问必中（贴纸）', kind: 'json', noDefaultBlocks: true,
    stickers: ['suibian_biaoti'],
  },
  'hmd_poster_mizige': {
    label: '官方海报+米字格（贴纸）', kind: 'json', noDefaultBlocks: true,
    stickers: ['mizige_mingzhong'],
  },
  // tpl_hope_record 是【副图生成器】（配 tools/make-record-base.js 的底图），不是发布用主图版式。
  'tpl_hope_record': { label: 'Hope近期战绩副图', kind: 'json', noDefaultBlocks: true },
};

/**
 * 贴纸库（B 路）—— 把「固定美术」做成可复用的透明 PNG，版式或店铺档案【按名字】引用。
 *
 * 老板 2026-10-11：「A和B都有」。A = 版式文字层（字由 canvas 精确画），
 * B = 贴纸（原图整块抠下来，压到任意底图上）。这两个库各管一件事，别混。
 *
 * 什么时候必须走 B：图案做不出文字层的时候。实测两个硬限制 ——
 *   ① 渲染器 _normLayer 只保留单个 stroke（outerColor/outerWidth 被它吃掉）→ 双描边做不出来；
 *   ② 爆炸星、米字格网格线、麻将牌这类「不是字」的东西，文字层根本没有。
 *
 * 几何怎么来的：tools/_cut-sticker.py 从原图量出来的（cx/cy 是中线百分比，sw 是宽占底图宽的比例），
 * 不是眼估。要重抠就重跑那个脚本，把新数字填回来。
 *
 * ⚠️ 规矩：贴纸【不留底色】。老板 2026-10-11 明确「不要白底图的透明贴纸」——
 *   米字格第一版把宣纸底一起留下了，在黑底上一眼就能看出是个白方块（他看出来了）。
 *   判据：不透明像素里"近白"的占比应该接近 0；剩下那些白只应该是设计本身的字
 *   （比如 02 红块里的白字「随便问」—— 那是图案的一部分，不是底）。
 */
const STICKER_LIB = {
  suibian_biaoti: {
    label: '随便问/必中（胖体描边）',
    file: 'publish-assets/好易美代拍/贴纸/贴纸-随便问必中-描边.png',
    cx: 49.5, cy: 50.2, sw: 0.9639,
  },
  suibian_baozha: {
    label: '随便问/必中（红黄爆炸）',
    file: 'publish-assets/好易美代拍/贴纸/贴纸-随便问必中-爆炸.png',
    cx: 50, cy: 42.4, sw: 1.0,
  },
  mizige_mingzhong: {
    label: '米字格·命中率高有票包中（全透明）',
    file: 'publish-assets/好易美代拍/贴纸/贴纸-米字格-命中率高-全透明.png',
    cx: 49.7, cy: 50.2, sw: 0.9396,
  },
};

/** 贴纸引用 → 完整定义。写名字（字符串）或直接写 {file,cx,cy,sw} 都行；名字没登记就报出来，不静默丢 */
function resolveStickers(arr, who) {
  return (arr || []).map((s) => {
    if (typeof s !== 'string') return s;
    const t = STICKER_LIB[s];
    if (!t) {
      process.stderr.write('[store-profile] ⚠️ ' + who + ' 引用了没登记的贴纸：' + s +
        '（登记到 lib/store-profile.js 的 STICKER_LIB）\n');
      return null;
    }
    return { file: t.file, cx: t.cx, cy: t.cy, sw: t.sw };
  }).filter(Boolean);
}

/** 分类模板库（与桌面引擎 publish.js 的 CATEGORY_TEMPLATES 同源，改一处必须改两处） */const CATEGORY_TEMPLATES = {
  '代购': { channelCatId: '201456914', catId: '50025461' },
  '创业/副业培训': { channelCatId: '202155826', catId: '50023914' },
  '技能类招工': { channelCatId: '202147361', catId: '' },
  '互联网产品与运营技能培训': { channelCatId: '50025963', catId: '127284048' },
};

/**
 * 推广计划（超级擦亮）的参数域 —— 与桌面引擎 publish.js 的 startCampaign() 同源。
 *
 * 为什么放在店铺档案里：老板要开 100 个店，每个店的出价/预算/时段都可能不一样，
 * 而这 9 项以前【只存在于桌面引擎的界面里】，CLI 一份配置都没有 → 换台机器就得重填一遍。
 * 现在它是档案的一部分：一份档案 = 上架 9 项 + 推广 9 项 + 监控阈值。
 *
 * 9 项与字段的对应（和老板给的清单逐条对齐）：
 *   ① 擦亮方式      → 方式 ↔ productId（'超级擦亮' = 1）
 *   ② 擦亮宝贝      → 宝贝 ↔ entityList（auto / [itemId]）
 *   ③ 擦亮类型      → 类型 ↔ promotionMode（custom 自定义 / package 套餐）
 *   ④ 出价方式      → 出价方式 ↔ bidType（smart_bid 智能 / custom 手动）
 *   ⑤ 预期成本出价  → 预期成本（元）↔ bidPrice（分）
 *   ⑥ 日花费上限    → 日上限（元）↔ maxDayBudget（分）
 *   ⑦ 计划名称      → 名称（模板）↔ baseInfo.title
 *   ⑧ 创意优化      → 创意优化 ↔ extraFunctions.creativeOptSwitch
 *   ⑨ 定向设置时段  → 时段 ↔ infoTab.budgetScheduleDurations（地区 → targetInfo.divisionList）
 */
const AD_PLAN = {
  PROMOTION_MODES: { custom: '自定义', package: '套餐' },
  BID_TYPES: { smart_bid: '智能出价', custom: '手动出价' },
  BID_TARGETS: { exposure: '曝光量', click: '浏览量', follow_collect: '关注收藏量', chat: '咨询量', order: '订单量' },
  PRODUCT_IDS: { '超级擦亮': 1 },
  // 平台硬要求：投放时段合计不得少于 4 小时（set-ad-hours.js 同样拦这条）
  MIN_HOURS: 4,
  // 名称模板默认值。实抓到的真实计划名三种形态：
  //   ¥2.88·创意开·泉州徐良        ← 桌面引擎 startCampaign 的写法（含创意开关状态）
  //   广州KPL-咨询120 / 三亚周杰伦-咨询120   ← 老板手建的单链计划（城市+明星-目标+日预算）
  //   擦亮宝贝20261007133032       ← 主/副集合计划（前缀是熔断护栏的判据，见 lib/mtop.js isCollection）
  // 所以留成模板。要跟老板手建的那批一致就写：{城市}{明星}-{目标}{日上限}
  TITLE_DEFAULT: '{出价}·{目标}·{城市}{明星}',
  // 一个计划最多推几个链接（平台限制 10）
  MAX_ITEMS_PER_PLAN: 10,
  /**
   * 默认投放时段 = 窗口 8:00-23:00。
   *
   * 【2026-10-09 修·口径】这里原来是 [8..23]（16 格），是错的：格 h 表示 h:00-(h+1):00，
   *   所以窗口 8:00-23:00 是格 [8..22]，共【15】格；[8..23] 是 8:00-24:00，多一小时。
   *   权威依据是平台自己渲染的「投放计划 → 投放时段」列：ad-hours-live.js 实测
   *   9 条 15 格的计划，平台全部显示「部分时段 8:00-23:00」。
   *   同一个坑在 ad-driver.js 上也踩过：它是 `h <= endHour` 闭区间，
   *   所以 run-cfgs.js 注释写「时段 8:00-23:00」时配的是 endHour: 22，不是 23。
   *   ⚠ 改这个值会直接影响 tools/ad-plan-create.js 建出来的计划，别随手改回去。
   */
  DEFAULT_HOURS: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
};

/**
 * 默认档案 = 2026-10-07 之前「好易美代拍」的既有行为，逐项对照：
 *   主图池   publish-one.js L191-195 的 TPLS 前三个
 *   标题字数 L158 的 TITLE_MIN_BY_STORE 兜底（30）+ TITLE_MAX（40）
 *   分类/规格/库存/发货/承诺  L45 / L465-489
 * 改这里等于改【所有没档案的店铺】，慎改。
 */
const DEFAULTS = {
  $schema: 'store-profile/1',
  name: '',
  accountId: '',
  // ownerMachine: 这个店归哪台机器操作。空 = 未认领（放行但会提醒）。
  // 红线：一个闲鱼账号只能被一台机器操作 —— 写进档案是为了跨机器也能拦住（档案跟 git 走）。
  ownerMachine: '',
  enabled: true,
  // status: 'live' = 接完了，能用；'draft' = 还在建（比如闲鱼账号还没进中台/还没登录）。
  // 为什么需要：开 100 个店的过程里会同时躺着很多半成品店，
  // draft 让 tools/store-init.js 把它们的问题降级成 ⚠️，不至于让整批体检永远红着（那样就没人看了）。
  status: 'live',
  主图: { templates: ['xuliang-v1', '__shoukai', 'tpl_redtext'], baseImg: '', stickers: [] },
  副图: { dir: '', count: 0 },
  文案: { templateIds: null, titleMin: 30, titleMax: 40 },
  分类: { catName: '代购', catId: '50025461', channelCatId: '201456914', tbCatId: '' },
  规格: { propertyName: '代拍费', specs: [{ valueText: '标准' }] },
  价格: { default: 50, origPrice: null },
  库存: { default: 9999 },
  所在地: { mode: 'city', fixedCity: '', fixedDistrict: '' },
  发货方式: { shipMode: 'nomail' },
  // serviceCodes: 直传闲鱼的服务承诺 code。【比 3 个布尔开关更权威】——
  //   布尔开关那套（GUARANTEE_REFUND / RETURN_POSTAGE / FAST_SHIP）是桌面引擎 publish.js 自己写的映射，
  //   而 2026-09-13 从闲鱼自己的编辑接口抓到的真实 payload 用的是
  //   NONCONFORMITY_FREE_REFUND（描述不符包退）+ VIRTUAL_NONCONFORMITY_FREE_REFUND_SERVICE（虚拟商品）。
  //   两套 code 对不上 → 填了 serviceCodes 就以它为准，布尔开关只作为"没填时"的兜底。
  承诺: { refundFull: false, refundPostage: false, fastShip: false, serviceCodes: [] },
  广告: {
     enabled: true,
     // planBudget = 老的简写（一个店只用一个日预算时填它）。
     // 计划.日上限 填了就以它为准；两个都没填 → ¥50（= 好易美代拍的历史值）。
     planBudget: 0,
     计划: {
       方式: '超级擦亮',
       类型: 'custom',
       出价方式: 'smart_bid',
       目标: 'chat',
       预期成本: 4,
       日上限: null,
       名称: AD_PLAN.TITLE_DEFAULT,
       创意优化: true,
       时段: AD_PLAN.DEFAULT_HOURS.slice(),
       地区: [],
       宝贝: 'auto',
     },
   },
};

const SHIP_MODES = ['nomail', 'free', 'distance', 'fixed'];
const LOC_MODES = ['city', 'fixed', 'random_tier1', 'random_any'];

/**
 * 账号互斥：这个店归哪台机器操作。
 *
 * 红线（老板定的）：**一个闲鱼账号只能被一台机器操作**，否则登录互踢 + 重复发布。
 * 以前这条只写在文档里，跨机器零约束。现在档案里带 ownerMachine，另一台机器 pull 下来就能自己拦。
 *
 * 三态，刻意做成"只对已认领的店 fail-closed"：
 *   ownerMachine 为空        → 未认领，【放行】但提醒（否则老档案一上来全被锁死）
 *   ownerMachine == 本机 id  → 放行
 *   ownerMachine == 别的机器 → **拒绝**，并给转移命令
 * 本机 id 拿不到（空串）时一律放行 —— 读不到配置不该把整套锁死。
 */
function ownerOf(P) {
  return String((P && P.ownerMachine) || '').trim();
}
function isForeign(P, machineId) {
  const owner = ownerOf(P);
  const me = String(machineId || '').trim();
  if (!owner || !me) return false;         // 任一为空 → 不拦
  return owner !== me;
}
/** 返回一句人话 + 处置命令；不拦时返回 null */
function foreignReason(P, machineId) {
  if (!isForeign(P, machineId)) return null;
  const owner = ownerOf(P);
  return '店铺「' + ((P && P.name) || '?') + '」的 ownerMachine = ' + owner +
    '，不是本机（' + machineId + '）。\n' +
    '   红线：一个闲鱼账号只能被一台机器操作（登录互踢 / 重复发布 / 两个浏览器抢同一个计划）。\n' +
    '   如果这台机器【确实】接管了这家店（另一台已经停了），先转移归属：\n' +
    '     node tools/store-claim.js --store="' + ((P && P.name) || '?') + '" --to=' + machineId + ' --apply\n' +
    '   只是想看看：node tools/store-claim.js --list';
}


function fileOf(name) {
  if (!name || typeof name !== 'string') throw new Error('店铺名必填');
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('店铺名不能含路径字符：' + name);
  return path.join(DIR, name + '.json');
}

function exists(name) {
  try { return fs.existsSync(fileOf(name)); } catch (e) { return false; }
}

function list() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.slice(0, -5));
  } catch (e) { return []; }
}

function readJSON(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // 本仓 250+ 个文件带 BOM，JSON.parse 会炸
  return JSON.parse(s);
}

/** 深合并，数组整体替换（与 lib/env.js 的 deepMerge 同语义）；`_` 开头是注释键，跳过 */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;
    const b = out[k], o = over[k];
    out[k] = (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o))
      ? merge(b, o) : o;
  }
  return out;
}

/**
 * 读店铺档案。读不到 → 返回 DEFAULTS（= 老行为），并在 stderr 提示一句。
 * 读到但格式错 → 【抛错】，不回落（静默回落是今天出过事故的那类 bug）。
 */
function load(name) {
  const f = fileOf(name);
  if (!fs.existsSync(f)) {
    process.stderr.write('[store-profile] 「' + name + '」没有档案，用好易美代拍的默认值（' + path.relative(ROOT, f).replace(/\\/g, '/') + ' 不存在）\n');
    return Object.assign({}, DEFAULTS, { name: name });
  }
  let raw;
  try { raw = readJSON(f); }
  catch (e) { throw new Error('店铺档案格式错（' + f + '）：' + e.message); }

  const P = merge(DEFAULTS, raw);
  P.name = raw.name || name;
  if (P.name !== name) {
    throw new Error('档案里的 name「' + P.name + '」和文件名「' + name + '」不一致 —— 必须一致，' +
      '否则 resolved 出来的店铺和实际启动的店铺会是两个（f=' + f + '）');
  }
  // 分类：允许只写 catName，catId/channelCatId 从模板库补
  const cat = P.分类 || {};
  const tpl = CATEGORY_TEMPLATES[cat.catName];
  if (tpl) {
    if (!cat.channelCatId) cat.channelCatId = tpl.channelCatId;
    if (!cat.catId) cat.catId = tpl.catId;
  }

  // 发货方式 / 所在地模式：非法值直接抛，别让它悄悄用成 nomail
  const ship = (P.发货方式 || {}).shipMode;
  if (SHIP_MODES.indexOf(ship) < 0) {
    throw new Error('档案「' + name + '」的发货方式.shipMode = ' + JSON.stringify(ship) +
      ' 不是合法值，只能是 ' + SHIP_MODES.join(' / '));
  }
  const loc = (P.所在地 || {}).mode;
  if (LOC_MODES.indexOf(loc) < 0) {
    throw new Error('档案「' + name + '」的所在地.mode = ' + JSON.stringify(loc) +
      ' 不是合法值，只能是 ' + LOC_MODES.join(' / '));
  }
  if (loc === 'fixed' && !P.所在地.fixedCity) {
    throw new Error('档案「' + name + '」所在地.mode=fixed 但没写 fixedCity');
  }
  // status：只能是 live / draft
  if (['live', 'draft'].indexOf(P.status) < 0) {
    throw new Error('档案「' + name + '」的 status = ' + JSON.stringify(P.status) + ' 不是合法值，只能是 live / draft');
  }
  // 推广计划 9 项：非法值【抛错】。理由同发货方式 —— 静默回落会让老板以为改生效了。
  resolveAdPlan(P);
  return P;
}

/**
 * 把档案里的「广告.计划」解析成可直接下发的配置（并校验）。
 * 这是这 9 项的唯一权威实现：tools/ad-plan-create.js 和 store-init --verify 都调它。
 */
function resolveAdPlan(P) {
  const who = (P && P.name) || '';
  const ad = (P && P.广告) || {};
  const raw = ad.计划 || DEFAULTS.广告.计划;

  const mode = raw.类型;
  if (!AD_PLAN.PROMOTION_MODES[mode]) {
    throw new Error('档案「' + who + '」广告.计划.类型 = ' + JSON.stringify(mode) +
      ' 不是合法值，只能是 ' + Object.keys(AD_PLAN.PROMOTION_MODES).join(' / '));
  }
  const bidType = raw.出价方式;
  if (!AD_PLAN.BID_TYPES[bidType]) {
    throw new Error('档案「' + who + '」广告.计划.出价方式 = ' + JSON.stringify(bidType) +
      ' 不是合法值，只能是 ' + Object.keys(AD_PLAN.BID_TYPES).join(' / '));
  }
  const target = raw.目标;
  if (!AD_PLAN.BID_TARGETS[target]) {
    throw new Error('档案「' + who + '」广告.计划.目标 = ' + JSON.stringify(target) +
      ' 不是合法值，只能是 ' + Object.keys(AD_PLAN.BID_TARGETS).join(' / '));
  }
  const productId = AD_PLAN.PRODUCT_IDS[raw.方式];
  if (!productId) {
    throw new Error('档案「' + who + '」广告.计划.方式 = ' + JSON.stringify(raw.方式) +
      ' 不是合法值，目前只支持 ' + Object.keys(AD_PLAN.PRODUCT_IDS).join(' / '));
  }
  const bidYuan = Number(raw.预期成本);
  if (!(bidYuan > 0)) {
    throw new Error('档案「' + who + '」广告.计划.预期成本 = ' + JSON.stringify(raw.预期成本) + ' 必须 > 0（单位：元）');
  }
  // 日上限：计划.日上限 > 广告.planBudget > 50
  const budgetYuan = Number(raw.日上限 || ad.planBudget || 50);
  if (!(budgetYuan > 0)) {
    throw new Error('档案「' + who + '」广告.计划.日上限 / 广告.planBudget = ' + JSON.stringify(raw.日上限 || ad.planBudget) + ' 必须 > 0（单位：元）');
  }
  const hours = (raw.时段 || []).map(Number);
  if (hours.length < AD_PLAN.MIN_HOURS) {
    throw new Error('档案「' + who + '」广告.计划.时段 合计 ' + hours.length +
      ' 小时，平台要求至少 ' + AD_PLAN.MIN_HOURS + ' 小时');
  }
  if (hours.some((h) => !(h >= 0 && h <= 23))) {
    throw new Error('档案「' + who + '」广告.计划.时段 只能是 0-23 的整数，实际 ' + JSON.stringify(raw.时段));
  }
  const babies = raw.宝贝;
  const babyOk = babies === 'auto' || babies === 'none' || Array.isArray(babies);
  if (!babyOk) {
    throw new Error('档案「' + who + '」广告.计划.宝贝 只能是 "auto" / "none" / [itemId,...]，实际 ' + JSON.stringify(babies));
  }
  return {
    enabled: ad.enabled !== false,
    方式: raw.方式, productId,
    类型: mode, promotionMode: mode,
    出价方式: bidType,
    目标: target, bidTarget: target,
    预期成本: bidYuan, bidPrice: Math.round(bidYuan * 100),
    日上限: budgetYuan, maxDayBudget: Math.round(budgetYuan * 100),
    名称: String(raw.名称 || AD_PLAN.TITLE_DEFAULT),
    创意优化: raw.创意优化 !== false,
    时段: hours.slice().sort((a, b) => a - b),
    地区: (raw.地区 || []).slice(),
    宝贝: babies,
  };
}

/**
 * 计划名模板 → 真名。
 * ctx: { 城市, 明星, 日期? }。占位符：
 *   {出价} ¥4 ｜ {出价数字} 4 ｜ {目标} 咨询 ｜ {日上限} 120 ｜ {城市} 广州 ｜ {明星} 周杰伦 ｜ {日期} 1009
 * 城市/明星为空时不留下孤零零的分隔符（'¥4·咨询·' → '¥4·咨询'）。
 *
 * over: 可选的临时覆盖（tools/ad-plan-create.js 的 --bid/--budget 用它）。
 *   ⚠️ 踩过：覆盖了 bidPrice 却没同步计划名 → 计划建出来叫「¥4·咨询…」而实际出价 ¥2.88，
 *   名字和内容不一致，事后按名字对账会全对不上。所以覆盖必须同时进 payload 和名字。
 */
function campaignTitle(P, ctx, over) {
  const p = Object.assign(resolveAdPlan(P), over || {});
  const c = ctx || {};
  const map = {
    '{出价}': '¥' + (Math.round(p.预期成本 * 100) / 100),
    '{出价数字}': String(Math.round(p.预期成本 * 100) / 100),
    '{目标}': AD_PLAN.BID_TARGETS[p.目标].replace(/量$/, ''),
    '{日上限}': String(Math.round(p.日上限)),
    '{城市}': c.城市 || '',
    '{明星}': c.明星 || '',
    '{日期}': c.日期 || '',
  };
  let t = p.名称;
  for (const k of Object.keys(map)) t = t.split(k).join(map[k]);
  return t.replace(/[·\-_\s]+$/, '').replace(/^[·\-_\s]+/, '');
}

/**
 * 生成 mtop.taobao.idle.ad.campaign.startV2 的 requestJson。
 * items: [{itemId, catId?, priceYuan?}]，最多 AD_PLAN.MAX_ITEMS_PER_PLAN 条。
 * 结构 1:1 抄桌面引擎 publish.js 的 startCampaign()（那是唯一在线上跑通过的版本）。
 */
function campaignPayload(P, items, ctx, over) {
  const p = Object.assign(resolveAdPlan(P), over || {});
  const list = (items || []).slice(0, AD_PLAN.MAX_ITEMS_PER_PLAN).map((e) => ({
    entityId: parseInt(e.itemId, 10),
    // ⚠️ 广告侧要的是【渠道类目 channelCatId】，不是叶子类目 catId。
    //   2026-10-09 实抓线上 11 个计划、33 条 entityList：catId 全是 201456914（= 我们的 channelCatId），
    //   一条 50025461 都没有。桌面引擎 publish.js 的兜底值也是 201456914，互相印证。
    //   写成叶子类目不会报错，但计划会挂到错的类目上 —— 这类"不报错的错"最难查。
    catId: parseInt(e.catId || P.分类.channelCatId || P.分类.catId, 10) || 201456914,
    price: Math.round(Number(e.priceYuan || P.价格.default) * 100),
    startTime: Date.now(),
    areaTarget: false,
  }));
  if (!list.length) throw new Error('建计划至少要一个宝贝（entityList 为空）');
  return {
    entityType: 1,
    fromScene: 'pc_campaign-manage',
    oldMember: true,
    entityList: list,
    customInfo: {
      bidPrice: p.bidPrice,
      maxDayBudget: p.maxDayBudget,
      budgetScheduleDurations: p.时段,
    },
    baseInfo: {
      productId: p.productId,
      promotionMode: p.promotionMode,
      bidType: p.出价方式,
      bidTarget: p.bidTarget,
      title: campaignTitle(P, ctx, over),
    },
    targetInfo: { divisionList: p.地区 },
    clueInfo: { chatButton: true, bookButton: false, bookText: '' },
    extraFunctions: { creativeOptSwitch: p.创意优化 },
  };
}

/**
 * 把档案里的版式 id 列表解析成 publish-one.js 直接能用的数组。
 * 未登记的 id：给一个保守定义（kind:'json'，不叠默认色块）并【在 stderr 警告】——
 * 警告而不是抛错，是为了"先在服务端加了版式、还没来得及登记"时仍能跑；
 * 但 tools/store-init.js --verify 会把它标成 ⚠️，跑不起来才不至于没人发现。
 */
function resolveTemplates(P) {
  const ids = (P && P.主图 && P.主图.templates) || DEFAULTS.主图.templates;
  if (!Array.isArray(ids) || !ids.length) throw new Error('档案「' + (P && P.name) + '」的 主图.templates 是空的');
  const baseImg = (P.主图 && P.主图.baseImg) || '';
  const extraStickers = (P.主图 && P.主图.stickers) || [];
  const unknown = [];
  const out = ids.map((id) => {
    const reg = TPL_REGISTRY[id];
    if (!reg) unknown.push(id);
    const t = Object.assign({ key: id, label: id, kind: 'json', noDefaultBlocks: true }, reg || {});
    if (baseImg) t.baseImg = baseImg;                       // 档案的 baseImg 覆盖（KUN_BASE_IMG 仍可临时压过）
    // 贴纸：注册表里的先按名字解，档案里的再并上去（档案 = 全店所有版式都焊）
    if (t.stickers) t.stickers = resolveStickers(t.stickers, 'TPL_REGISTRY ' + id);
    if (extraStickers.length) t.stickers = (t.stickers || []).concat(resolveStickers(extraStickers, '档案「' + (P && P.name) + '」的 主图.stickers'));
    return t;
  });
  if (unknown.length) {
    process.stderr.write('[store-profile] ⚠️ 版式 id 没在注册表登记：' + unknown.join(', ') +
      '（按"JSON 版式 + 不叠默认色块"处理；登记到 lib/store-profile.js 的 TPL_REGISTRY 才稳）\n');
  }
  return out;
}

module.exports = {
  ROOT, DIR, TPL_REGISTRY, STICKER_LIB, CATEGORY_TEMPLATES, DEFAULTS, SHIP_MODES, LOC_MODES, AD_PLAN,
  fileOf, exists, list, load, resolveTemplates,
  resolveAdPlan, campaignTitle, campaignPayload,
  ownerOf, isForeign, foreignReason,
};
