/**
 * lib/env.js — 环境与配置的唯一出口
 *
 * 为什么存在：以前 140 个脚本各自内联 API Key、端口、店铺名，改一次配置要动 140 个文件，
 * 且曾经把店铺名写坏成乱码（GBK/UTF-8 混淆）都没人发现。
 * 现在任何脚本要配置，只 require 这个文件。
 *
 * 用法：
 *   const { STORE, STORES, URL, TH, RULES, p, ROOT } = require('./lib/env');
 *   const { PATHS, NODE, MIDDLE, WECOM } = require('./lib/env');
 *
 * 覆盖优先级：环境变量 > lib/config.json > 内置默认值
 *   XY_API_KEY / XY_PORT / XY_HOST / XY_STORE
 *
 * 机器相关的值（绝对路径 / 中台密钥 / 企微身份）走 config.local.json，三层：
 *   内置默认值(FALLBACK) < lib/config.json(出厂) < config.local.json(本机，每台一份)
 *   PATHS.work / NODE.path 带自愈，配置缺失或失效也不会返回 undefined。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FALLBACK = {
  service: { host: '127.0.0.1', port: 8093, apiKey: '' },
  store: { default: '好易美代拍', all: ['好易美代拍', '好易美娱乐', '超能水手代拍'] },
  url: {
    dayu: 'https://dayu.goofish.com/',
    adConsole: 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage',
    goofish: 'https://www.goofish.com/',
    publish: 'https://www.goofish.com/publish',
  },
  node: {},
  // ── 下面三段主要来自 config.local.json ──
  // 这里只保证它们是对象（否则 const { MIDDLE } = require(...) 之后 MIDDLE.base 会直接崩）。
  // paths.work 是唯一例外：它能从本文件位置推导出来，永远是对的，所以给真值当自愈兜底。
  paths: { work: ROOT },
  machine: {},
  middle: {},
  wecom: {},
  thresholds: { adCumCost: 50, adCostPerChat: 10, adBudgetPct: 0.8, adDayCost: 100, adTargetCost: 4, adOrderCum: 150 },
  rules: { collectionPrefix: '擦亮宝贝', chatCap: 4, orderCap: 35, superPolishMaxItems: 10, superPolishSharedPerPlan: 4 },
  output: { maxLines: 15, logMaxKB: 1024, logKeepLines: 2000 },
};

function loadConfig() {
  const f = path.join(__dirname, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return deepMerge(FALLBACK, raw);
  } catch (e) {
    process.stderr.write('[lib/env] config.json 读不到或格式错，用内置默认值：' + e.message + '\n');
    return JSON.parse(JSON.stringify(FALLBACK));
  }
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;                       // 注释键跳过
    const b = out[k], o = over[k];
    out[k] = (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o))
      ? deepMerge(b, o) : o;
  }
  return out;
}

const cfg = loadConfig();

// ── 环境变量覆盖（临时调试用，不改文件）──
if (process.env.XY_HOST) cfg.service.host = process.env.XY_HOST;
if (process.env.XY_PORT) cfg.service.port = Number(process.env.XY_PORT);
if (process.env.XY_API_KEY) cfg.service.apiKey = process.env.XY_API_KEY;
if (process.env.XY_STORE) cfg.store.default = process.env.XY_STORE;

const SVC = cfg.service;
const STORE = cfg.store.default;
const STORES = cfg.store.all;
/** 当前实际运营的店铺（config.store.active）。ready() 只启动这些。 */
const ACTIVE = (cfg.store.active && cfg.store.active.length) ? cfg.store.active : [STORE];
const URLS = cfg.url;
const TH = cfg.thresholds;
const RULES = cfg.rules;
const OUT = cfg.output;

/** 拼接项目内绝对路径（一律用正斜杠，Node 在 Windows 下完全支持） */
function p(...parts) {
  return path.join(ROOT, ...parts).replace(/\\/g, '/');
}

/**
 * 读 JSON。必须剥掉 BOM：本仓库有 250+ 个文件带 UTF-8 BOM（历史遗留，
 * PowerShell 的 Out-File 默认加），而 fs.readFileSync 的 'utf8' 会把 BOM
 * 解成 U+FEFF 留在字符串开头，导致 JSON.parse 直接抛「Unexpected token」。
 * require() 能处理 BOM，JSON.parse 不能——所以这里统一兜住。
 */
function readJSON(file, fallback) {
  try {
    let s = fs.readFileSync(file, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch (e) { return fallback === undefined ? null : fallback; }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ── 本机配置 config.local.json（每台电脑一份，不进版本库）──
// 读不到就是 {}，下面所有取值自动退回出厂配置/内置默认值，行为与加这层之前完全一致。
// 仍然故意不动 store —— 别让本机文件的 store.default 盖掉 XY_STORE 环境变量。
const LOCAL = readJSON(path.join(ROOT, 'config.local.json')) || {};
const LAYER = {
  paths:  deepMerge(cfg.paths  || {}, LOCAL.paths  || {}),
  node:   deepMerge(cfg.node   || {}, LOCAL.node   || {}),
  middle: deepMerge(cfg.middle || {}, LOCAL.middle || {}),
  wecom:  deepMerge(cfg.wecom  || {}, LOCAL.wecom  || {}),
  // 【2026-10-09 修】machine：本机身份。之前 LAYER 里漏了这个键，
  //   于是 MACHINE.id 永远读不到 config.local.json 的 machine.id，一直静默退化成主机名 ——
  //   而 healthcheck 还把它当 ✅ 打出来。注释写了优先级、代码没实现（"注释说 A、代码做 B"）。
  machine: deepMerge(cfg.machine || {}, LOCAL.machine || {}),
  // 【2026-10-07 加】service：本机专属的 8093 apiKey。
  //   出厂 lib/config.json 里 apiKey 已【故意留空】—— 那个文件要进版本库，
  //   密钥散在 50+ 个文件里是这个仓一直不敢加 remote 的原因。
  service: deepMerge(cfg.service || {}, LOCAL.service || {}),
  // 【2026-10-08 加】阈值/规则/地址：中台可以按学员下发覆盖值（比如某人的日预算上限不同）。
  //   没配就是空对象，deepMerge 后等于不覆盖 —— 行为与加这三行之前完全一致。
  thresholds: LOCAL.thresholds || {},
  rules:      LOCAL.rules      || {},
  urls:       LOCAL.urls       || {},
};

// ⚠️ LOCAL 是在上面那次「环境变量覆盖」【之后】才读的，所以这里必须把 XY_API_KEY 再压一次，
//    否则本机文件会悄悄盖掉环境变量，破坏「环境变量 > config.local.json > lib/config.json」的优先级。
// ⚠️ 必须用 Object.assign 原地改，不能 `cfg.service = ...` —— SVC 在文件上半部分就
//    指向了原对象，重新赋值会让 SVC 拿到旧的那份（这是个静默失效型的坑）。
//    同理 URLS/TH/RULES 也是在上半部分就绑定到 cfg.url/cfg.thresholds/cfg.rules 的，
//    所以这三层也必须原地 assign。
Object.assign(cfg.service, LAYER.service);
Object.assign(cfg.url, LAYER.urls);
Object.assign(cfg.thresholds, LAYER.thresholds);
Object.assign(cfg.rules, LAYER.rules);
// machine 必须原地 assign：MACHINE 在下面就是按 cfg.machine 读的（同上文的坑）
cfg.machine = Object.assign(cfg.machine || {}, LAYER.machine);
if (process.env.XY_API_KEY) cfg.service.apiKey = process.env.XY_API_KEY;

/**
 * node.path 自愈 —— 照搬 lib/ps/Config.ps1 的 Resolve-XyNodePath（两边必须保持一致）
 *
 * 为什么：CodeBuddy 自动升级会把 versions\22.22.2-3 整个改名成 .22.22.2-3.deleting.*，
 *  2026-10-02 凌晨真的发生了一次，所有写死版本号的配置一夜失效。
 *
 * 路径存在时**原样返回**，行为与没加自愈时完全一致；只有失效了才会被替换。
 */
function resolveNodePath(configured, fallback) {
  if (configured && fs.existsSync(configured)) return configured;   // 正常情况：什么都不做
  if (!configured) return fallback;

  // ⚠️ 不能 existsSync 校验 configured 的父目录：版本目录整个被改名/删除正是要救的场景，
  //    那个父目录必然不存在。（批次 1 第一版就是这么写的，自愈永远返回 null。）
  //    所以只从【路径结构】里切出 versions 目录，然后只要求 versions 目录本身在。
  const m = configured.replace(/\//g, '\\').match(/^(.+?\\versions)\\([^\\]+)\\([^\\]+)$/);
  if (!m) return fallback;
  const versionsDir = m[1];
  if (!fs.existsSync(versionsDir)) return fallback;

  // ① versions\current 装着版本号的普通文本文件（不是软链接），优先信它
  try {
    const curFile = path.join(versionsDir, 'current');
    if (fs.existsSync(curFile)) {
      const ver = fs.readFileSync(curFile, 'utf8').trim();
      if (ver) {
        const cand = path.join(versionsDir, ver, 'node.exe');
        if (fs.existsSync(cand)) {
          process.stderr.write('[lib/env] 配置里的 node 路径已失效，自愈为 ' + cand + '；建议更新 config.local.json\n');
          return cand;
        }
      }
    }
  } catch (e) { /* 读不到就走 ② */ }

  // ② 兜底：versions 下最新的一个 node.exe（跳过 .xxx.deleting.* 与 locks）
  try {
    const hit = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'locks')
      .map((d) => ({ name: d.name, t: fs.statSync(path.join(versionsDir, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((d) => path.join(versionsDir, d.name, 'node.exe'))
      .filter((c) => fs.existsSync(c))[0];
    if (hit) {
      process.stderr.write('[lib/env] 配置里的 node 路径已失效，自愈为 ' + hit + '；建议更新 config.local.json\n');
      return hit;
    }
  } catch (e) { /* 扫不动就返回兜底 */ }

  return fallback;
}

const PATHS = Object.assign({}, LAYER.paths);
if (!PATHS.work) PATHS.work = ROOT;        // 自愈：本机配置缺失时从自身位置推导，不能是 undefined

/**
 * playwrightService / xianyuMonitor 是【另外两个仓库】的克隆位置（本仓只依赖，不包含它们）。
 *
 * 【2026-10-08 加自愈】为什么不强制配置：要给几十个学员装，没人愿意手填这两个路径，
 * 填错还会得到一堆看不懂的 ENOENT。改成"约定优于配置"——按常见布局猜一遍，
 * 猜不到就留空，调用方拿到空串会得到一个明显的路径错误，而不是一个拼错的路径。
 *
 * 安装器（install.ps1）会把真实路径写进 config.local.json，所以这里只是兜底。
 */
function guessPath(cands) {
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c.replace(/\\/g, '/'); } catch (e) { /* 继续猜 */ } }
  return '';
}
// 【2026-10-08 加】这三个路径也支持环境变量覆盖，优先级最高。
// 为什么：install.ps1 的 Resolve-DepDir 认 XY_PLAYWRIGHTSERVICE / XY_XIANYUMONITOR，
// 而 install-config.js 走的是 env.js 的 PATHS —— 两套解析同一个路径必然会打架
// （实测：设置环境变量后安装器找到了仓库，install-config 却仍往默认位置写）。
if (process.env.XY_PLAYWRIGHTSERVICE) PATHS.playwrightService = process.env.XY_PLAYWRIGHTSERVICE.replace(/\\/g, '/');
if (process.env.XY_XIANYUMONITOR) PATHS.xianyuMonitor = process.env.XY_XIANYUMONITOR.replace(/\\/g, '/');
if (process.env.XY_IMAGES) PATHS.images = process.env.XY_IMAGES.replace(/\\/g, '/');
if (!PATHS.playwrightService) {
  PATHS.playwrightService = guessPath([
    path.join(path.dirname(ROOT), 'playwright-service'),          // 两个仓并排克隆（推荐布局）
    path.join(path.dirname(ROOT), 'xianyu-playwright-service'),
    path.join(os.homedir(), '.kun', 'default_workspace', 'playwright-service'),   // 本机历史位置
  ]);
}
if (!PATHS.xianyuMonitor) {
  PATHS.xianyuMonitor = guessPath([
    path.join(path.dirname(ROOT), 'xianyu-monitor'),
    path.join(os.homedir(), 'Desktop', 'xianyu-monitor'),
  ]);
}
if (!PATHS.images) {
  PATHS.images = guessPath([path.join(os.homedir(), 'Desktop', '闲鱼上架图片')]);
}

// 三个路径都拿不到时给一条【能照做】的提示，而不是让调用方在 deeper 的地方炸 ENOENT。
function needPath(key, hint) {
  if (PATHS[key]) return;
  process.stderr.write('[lib/env] ⚠️ 路径未配置：paths.' + key + ' —— ' + hint +
    '\n            写到 config.local.json 的 paths 里即可（安装器会自己填）。\n');
}
needPath('playwrightService', '8093 Playwright 服务那个仓库克隆在哪');
needPath('xianyuMonitor', 'xianyu-monitor 那个仓库克隆在哪（publish.js / publish_dashboard.js 在这里）');

const NODE = Object.assign({}, LAYER.node);
// 【2026-10-08 改】第二个兜底原来是 undefined —— 也就是"配置里没写就返回 undefined"，
// 于是一个没填 node.path 的新机器上，所有 spawn(node) 的脚本都会以看不懂的方式失败。
// 改成回落到 process.execPath：**正在跑这个脚本的那个 node 本身就是一个可用的 node**。
NODE.path = resolveNodePath(NODE.path, process.execPath);

const MIDDLE = Object.assign({}, LAYER.middle);
const WECOM = Object.assign({}, LAYER.wecom);

/** 本机时区的 YYYYMMDD，用于 mtop 日期参数 */
function ymd(d) {
  d = d || new Date();
  return d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/**
 * require 另外两个仓库里的依赖（目前只有 sharp / playwright 需要）。
 *
 * 为什么要有这个包装：本仓自己不装 node_modules，sharp 装在 8093 服务那个仓库里。
 * 以前 11 个工具各自写死 `require('<某台机器的绝对路径>/node_modules/sharp')` ——
 * 换一台机器、或者那个仓库克隆到别的地方，这些工具就全部报「Cannot find module」。
 * 现在统一走这里，路径来自 PATHS，且路径缺失时给的是【能照做】的提示。
 */
function svcRequire(rel) {
  if (!PATHS.playwrightService) {
    throw new Error('paths.playwrightService 未配置，没法加载 ' + rel +
      '。请把它写进 config.local.json 的 paths（或跑 install.ps1 生成）。');
  }
  return require(path.join(PATHS.playwrightService, ...String(rel).split('/')));
}

/**
 * 本机身份（machine id）—— 用来强制「一个闲鱼账号只能被一台机器操作」这条红线。
 *
 * 为什么必须有个【机器可校验】的身份：
 *   这条红线以前只写在文档里。跨机器完全没有约束 —— 两台机器同时登录同一个闲鱼账号，
 *   后果是登录互踢 + 重复发布 + 两个浏览器抢同一个广告计划。
 *   店铺档案是跟 git 走的，所以把 ownerMachine 写进档案，另一台机器 pull 下来就能自己拦住自己。
 *
 * 取值优先级：config.local.json 的 machine.id → 环境变量 XY_MACHINE_ID → 主机名。
 * ⚠️ config.local.json 是 gitignored 的，所以每台机器天然不同；
 *    主机名是兜底（开发机够用，学员机上 install.ps1 会写一个随机 id）。
 * ⚠️ 拿不到就返回空串 —— 空串表示"本机身份未知"，此时【不拦】（见 store-profile.isForeign），
 *    否则一旦读不到配置，所有店都会被自己锁死。
 */
const MACHINE = {
  id: String((cfg.machine && cfg.machine.id) || process.env.XY_MACHINE_ID || os.hostname() || '').trim(),
  source: (cfg.machine && cfg.machine.id) ? 'config.local.json' : (process.env.XY_MACHINE_ID ? 'env' : 'hostname'),
};

module.exports = {
  ROOT, cfg,
  PATHS, NODE, MIDDLE, WECOM, MACHINE,
  SVC, STORE, STORES, ACTIVE, URLS, TH, RULES, OUT,
  URL: URLS,                     // 兼容两种写法
  p, readJSON, writeJSON, ymd, now, svcRequire,
  serviceBase: 'http://' + SVC.host + ':' + SVC.port,
};
