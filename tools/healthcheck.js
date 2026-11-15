/**
 * tools/healthcheck.js — 学员机【一键体检】：装完到底能不能用
 *
 * 为什么必须有它（老板 2026-10-01 批的需求书 §9.2 原话）：
 *   「一键体检（80% 的工单靠它自愈）」。
 *   学员机器上的问题绝大多数是同一个形状：node 找不到 / 8093 没起 / 店铺没登录 /
 *   档案少一个字段。这些都能靠机器自己查出来，不该让老板远程连过去看。
 *
 * 与 tools/store-init.js 的分工：
 *   store-init.js  = 【店铺档案】级体检（某家店的十个维度配得对不对），会写文件（--apply）
 *   healthcheck.js = 【整机】级体检（环境/服务/依赖/档案/推广/监控/安全），只读不写
 *   先把整机跑通，再用 store-init 逐店修。
 *
 * 三个功能模块各查一遍，和老板的需求 1:1 对应：
 *   ① 自动化上架   → 档案的九个维度 + 素材目录 + 分类 id
 *   ② 超级擦亮     → 推广九项 + 广告开关 + 建计划工具能不能预演
 *   ③ 数据监控     → 阈值/规则是否齐全 + 计划任务是否注册 + 两个手动开关
 *
 * 用法:
 *   node tools/healthcheck.js            # 全部
 *   node tools/healthcheck.js --quiet     # 只打印 ❌ 和结论（给定时任务用）
 *   node tools/healthcheck.js --json      # 机器可读
 * 退出码: 0 = 没有 ❌  1 = 有 ❌  2 = 连环境都读不到
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARGV = process.argv.slice(2);
const QUIET = ARGV.indexOf('--quiet') >= 0;
const JSONOUT = ARGV.indexOf('--json') >= 0;

const ROWS = [];
const chk = (level, sec, name, detail, fix) => ROWS.push({ level, sec, name, detail: detail || '', fix: fix || '' });
const ok = (s, n, d) => chk('ok', s, n, d);
const warn = (s, n, d, f) => chk('warn', s, n, d, f);
const bad = (s, n, d, f) => chk('bad', s, n, d, f);

let env = null, profile = null;
try { env = require('../lib/env'); } catch (e) { console.log('❌ lib/env.js 加载不了：' + e.message); process.exit(2); }
try { profile = require('../lib/store-profile'); } catch (e) { console.log('❌ lib/store-profile.js 加载不了：' + e.message); process.exit(2); }

const ROOT = env.ROOT;

// ── ① 运行环境 ────────────────────────────────────────────────────────────
(function sectionEnv() {
  const S = '① 运行环境';
  const v = process.versions.node.split('.').map(Number);
  if (v[0] >= 18) ok(S, 'Node 版本', process.versions.node + '  (' + process.execPath + ')');
  else bad(S, 'Node 版本', '只有 ' + process.versions.node + '，需要 >= 18', '装 Node 20/22 后重跑 install.cmd');

  try {
    const g = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
    ok(S, 'git', g);
  } catch (e) { warn(S, 'git', '找不到 git（不影响运行，只影响一键更新）', '装 git 后 node tools/update.js --status'); }

  ok(S, '工作目录', ROOT);
  const SVC_DIR = env.PATHS && env.PATHS.playwrightService;
  if (SVC_DIR && fs.existsSync(SVC_DIR)) ok(S, 'playwright-service 仓库', SVC_DIR);
  else bad(S, 'playwright-service 仓库', '找不到（' + (SVC_DIR || '未配置') + '）', '跑 install.cmd，或设 XY_PLAYWRIGHTSERVICE 指向它');
  const MON_DIR = env.PATHS && env.PATHS.xianyuMonitor;
  if (MON_DIR && fs.existsSync(MON_DIR)) ok(S, 'xianyu-monitor 仓库', MON_DIR);
  else warn(S, 'xianyu-monitor 仓库', '没找到（只有桌面发布台要用它）', '跑 install.cmd -SkipDeps 之外的完整安装');
})();

// ── ② 本机配置 ────────────────────────────────────────────────────────────
(function sectionCfg() {
  const S = '② 本机配置';
  const f = path.join(ROOT, 'config.local.json');
  if (!fs.existsSync(f)) {
    bad(S, 'config.local.json', '不存在 —— 这台机器没被 install 过', '跑 install.cmd（或 .\\install.ps1 -DryRun 先看它会做什么）');
  } else {
    ok(S, 'config.local.json', '存在');
    const c = env.SVC || {};
    if (c.apiKey) ok(S, 'service.apiKey', '已配置（' + String(c.apiKey).slice(0, 5) + '****）');
    else bad(S, 'service.apiKey', '空的 —— 8093 会拒绝所有请求', 'node tools/install-config.js --derive --apply');
    ok(S, 'service.port', c.port || '(默认 8093)');
  }
  const M = env.MIDDLE || {};
  if (M.base) ok(S, '中台地址', M.base + (M.tenant ? '  tenant=' + String(M.tenant).slice(0, 8) + '…' : ''));
  else warn(S, '中台地址', '没配 —— 中台下发/反馈功能不可用', 'node tools/install-config.js --derive --apply');
  const W = env.WECOM || {};
  if (W.chatId || W.webhook) ok(S, '企微通知', '已配置');
  else warn(S, '企微通知', '没配 —— 熔断/日报只会写日志不会推消息', '在 config.local.json 里补 wecom.chatId');
})();

// ── ③ 8093 服务 ───────────────────────────────────────────────────────────
async function sectionService() {
  const S = '③ 8093 浏览器服务';
  const http = require('../lib/http');
  try {
    const st = await http.get('/api/agent/status', { timeout: 8000 });
    ok(S, '服务在跑', 'http://127.0.0.1:' + (env.SVC.port || 8093));
    if (st && st.ok !== false) ok(S, '服务自述状态', JSON.stringify(st).slice(0, 110));
  } catch (e) {
    bad(S, '服务在跑', '连不上：' + e.message, '启动 ' + path.join(env.PATHS.playwrightService || 'playwright-service', 'start.bat'));
    return;
  }
  try {
    const acc = await http.get('/api/agent/accounts', { timeout: 15000 });
    const list = (acc && (acc.accounts || acc.data)) || [];
    if (list.length) ok(S, '账号表', list.length + ' 个：' + list.map((a) => a.name || a.username || a.id).join(', '));
    else warn(S, '账号表', '空的 —— 没有闲鱼账号进中台', '在中台加账号，或检查 middle 配置');
  } catch (e) { warn(S, '账号表', '读不到：' + e.message); }
}

// ── ④⑤⑥ 档案：上架九项 + 推广九项 ────────────────────────────────────────
function sectionStores() {
  const S1 = '④ 店铺档案（上架九项）';
  const S2 = '⑤ 推广计划（推广九项）';
  let names = [];
  try { names = profile.list(); } catch (e) {}
  if (!names.length) {
    // 【2026-11-13 第 141 轮修】原来这里写 --from="好易美代拍" —— 那是【老板的店】，
    //   学员机器上根本没有（stores/ 下一份都没有才会走到这条），照抄必然失败。
    //   学员该用的是包里带的样板：--preset=代拍-标准。
    bad(S1, '店铺档案', 'stores/ 下一份都没有',
      'node tools/store-new.js --name="<你的店铺名>" --preset=代拍-标准 --copy-sub');
    return;
  }
  ok(S1, '店铺档案', names.length + ' 份：' + names.join(', '));

  // 账号互斥（红线）：一个闲鱼账号只能被一台机器操作。
  //   体检必须报，因为 store-audit / store-init 都不拦启动 —— 真正拦的是 lib/agent.js ready()，
  //   但等到那时候已经晚了（脚本跑到一半才炸），所以在这里提前说。
  try {
    const { MACHINE } = env;
    const mine = [], foreign = [], unclaimed = [];
    names.forEach((n) => {
      try {
        const P = profile.load(n);
        const o = profile.ownerOf(P);
        if (!o) unclaimed.push(n);
        else if (profile.isForeign(P, MACHINE.id)) foreign.push(n + '→' + o);
        else mine.push(n);
      } catch (e) {}
    });
    ok(S1, '本机身份', (MACHINE.id || '(拿不到)') + '  [来源 ' + MACHINE.source + ']');
    if (foreign.length) {
      bad(S1, '账号互斥', '这些店归别的机器，本机启动会被拒：' + foreign.join('，'),
        '确实接管了才转移：node tools/store-claim.js --store="<店名>" --apply');
    } else if (unclaimed.length) {
      warn(S1, '账号互斥', '未认领的店任何机器都能操作：' + unclaimed.join('，'),
        '认领：node tools/store-claim.js --store="<店名>" --apply');
    } else {
      ok(S1, '账号互斥', mine.length + ' 家店都已认领给本机');
    }
  } catch (e) { warn(S1, '账号互斥', '检查失败：' + e.message.slice(0, 60)); }

  // ⚠️ ④ 和 ⑤ 分开收集、最后各自成段。
  //   第一版是每个店依次 push ④①⑤，结果标题在「④/⑤/④/⑤」之间来回跳，
  //   看着像两段反复重开，学生扫不出结构。同一类信息必须挨在一起。
  const rowsS1 = [], rowsS2 = [];
  const seen = {};
  names.forEach((n) => {
    let P;
    try { P = profile.load(n); }
    catch (e) { rowsS1.push({ level: 'bad', name: n, detail: '档案读不了：' + e.message, fix: '按报错修 stores/' + n + '.json' }); return; }
    const issues = [];
    if (!P.accountId) issues.push('缺 accountId');
    else if (seen[P.accountId]) issues.push('accountId 和「' + seen[P.accountId] + '」重复（一个账号只能属于一个店）');
    else seen[P.accountId] = n;
    if (!P.分类.catId && !P.分类.catName) issues.push('缺分类 id');
    const specs = (P.规格 || {}).specs || [];
    if (!specs.length) issues.push('规格为空');
    const sub = P.副图 || {};
    if (sub.dir) {
      const d = path.isAbsolute(sub.dir) ? sub.dir : path.join(ROOT, sub.dir);
      if (!fs.existsSync(d)) issues.push('副图目录不存在（' + sub.dir + '）');
      else {
        const n2 = fs.readdirSync(d).filter((x) => /\.(jpe?g|png|webp)$/i.test(x)).length;
        if (sub.count && n2 !== sub.count) issues.push('副图张数 ' + n2 + ' ≠ 档案写的 ' + sub.count);
      }
    }
    const bi = (P.主图 || {}).baseImg;
    if (bi) {
      const b = path.isAbsolute(bi) ? bi : path.join(ROOT, bi);
      if (!fs.existsSync(b)) issues.push('主图底图不存在（' + bi + '）');
    }
    // 【2026-11-13 改】草稿店（status=draft）的素材缺失降级成 warn。
    //   为什么：草稿店本来就是"还没备齐料"的状态 —— 副图目录、底图文件不存在是正常的
    //   （store-init.js 早就这么处理了，healthcheck 没跟上，两边不一致）。
    //   后果：好易美娱乐一个草稿店让整个体检 bad=1、退出码 1，
    //   网页上顶着一个红叉，学员/老板看不出"这其实不用管"。
    //   真正的配置错误（缺 accountId / 缺分类 / 规格为空 / 推广九项不合法）仍然算 bad。
    const isDraft = P.status === 'draft';
    if (issues.length) {
      rowsS1.push({
        level: isDraft ? 'warn' : 'bad',
        name: n + (isDraft ? '（草稿店）' : ''),
        detail: issues.join('；') + (isDraft ? ' —— 草稿店，备齐素材后把 status 改成 live' : ''),
        fix: 'node tools/store-init.js "' + n + '" --verify',
      });
    } else {
      rowsS1.push({ level: 'ok', name: n, detail: '¥' + P.价格.default + ' / 库存' + P.库存.default + ' / ' + P.发货方式.shipMode +
        ' / 规格 ' + specs.length + ' 档 / ' + (P.status === 'draft' ? '草稿' : '正常') });
    }

    // 推广九项
    try {
      const p = profile.resolveAdPlan(P);
      rowsS2.push({ level: 'ok', name: n, detail: (p.enabled ? '开' : '关') + ' ｜ ' + profile.AD_PLAN.BID_TYPES[p.出价方式] + ' ｜ ' +
        profile.AD_PLAN.BID_TARGETS[p.目标] + ' ｜ 出价 ¥' + p.预期成本 + ' ｜ 日上限 ¥' + p.日上限 +
        ' ｜ ' + p.时段.length + 'h ｜ 创意' + (p.创意优化 ? '开' : '关') });
      if (!p.enabled) rowsS2.push({ level: 'warn', name: n + ' 不投广告', detail: '广告.enabled=false', fix: '要投就改成 true' });
    } catch (e) {
      rowsS2.push({ level: 'bad', name: n, detail: '推广九项不合法：' + e.message, fix: '按报错修 stores/' + n + '.json 的 广告.计划' });
    }
  });
  rowsS1.forEach((r) => chk(r.level, S1, r.name, r.detail, r.fix));
  rowsS2.forEach((r) => chk(r.level, S2, r.name, r.detail, r.fix));
}

// ── ⑦ 数据监控 ────────────────────────────────────────────────────────────
function sectionMonitor() {
  const S = '⑦ 数据监控';
  const TH = env.TH || {}, RULES = env.RULES || {};
  const needTH = ['adCumCost', 'adCostPerChat', 'adBudgetPct', 'adDayCost', 'adTargetCost', 'adOrderCum'];
  const missTH = needTH.filter((k) => TH[k] === undefined);
  if (missTH.length) bad(S, '阈值', '缺 ' + missTH.join(', '), '在 config.local.json 的 thresholds 里补');
  else ok(S, '阈值', needTH.map((k) => k + '=' + TH[k]).join('  '));
  const needR = ['collectionPrefix', 'chatCap', 'orderCap', 'superPolishMaxItems', 'superPolishSharedPerPlan'];
  const missR = needR.filter((k) => RULES[k] === undefined);
  if (missR.length) bad(S, '规则', '缺 ' + missR.join(', '), '在 config.local.json 的 rules 里补');
  else ok(S, '规则', '集合前缀「' + RULES.collectionPrefix + '」（熔断护栏判据，别改）');

  // 计划任务
  const TASKS = [
    ['XianyuAdWindow8AM', '08:00 开窗'],
    ['XianyuAdWindow11PM', '23:00 关窗'],
    ['XianyuAdWindowGuard', '开窗后校验'],
    ['XianyuAdCostBreaker', '熔断（每 30 分）'],
    ['XianyuAdDailyReport', '广告日报 21:30'],
    ['XianyuAdBalanceDuty', '余额巡检'],
    ['XianyuWatchStuck', '卡死巡检'],
    ['XianyuWakePublish', '唤醒发布'],
  ];
  let have = '';
  try {
    have = execFileSync('schtasks', ['/query', '/fo', 'csv', '/nh'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { warn(S, '计划任务', '查不了（非 Windows？）'); }
  if (have) {
    const found = TASKS.filter(([n]) => have.indexOf(n) >= 0);
    const missing = TASKS.filter(([n]) => have.indexOf(n) < 0);
    if (!missing.length) ok(S, '计划任务', found.length + ' 个都已注册');
    else bad(S, '计划任务', '缺 ' + missing.length + ' 个：' + missing.map(([n, d]) => n + '(' + d + ')').join(', '),
      'node tools/install-tasks.js --apply');
  }

  // 两个手动开关
  const pa = path.join(ROOT, 'PAUSE-ADS'), pp = path.join(ROOT, 'PAUSE-PUBLISH');
  if (fs.existsSync(pa)) warn(S, 'PAUSE-ADS', '存在 → 全店停投中，开窗/日报/巡检都会跳过', '要复投就删掉这个文件');
  else ok(S, 'PAUSE-ADS', '不存在（正常投放）');
  if (fs.existsSync(pp)) warn(S, 'PAUSE-PUBLISH', '存在 → 自动发布被停', '要恢复发布就删掉这个文件');
  else ok(S, 'PAUSE-PUBLISH', '不存在（发布正常）');
}

// ── ⑧ 安全 / 编码 ─────────────────────────────────────────────────────────
function sectionSafety() {
  const S = '⑧ 安全与编码';
  // 密钥文件不能被 git 跟踪
  try {
    // stdio 必须显式给（第 168 轮）：默认情况下 execFileSync【既捕获又转发】子进程 stderr，
  //   于是学员包里没有 .git 时，`git ls-files` 的
  //     fatal: not a git repository (or any of the parent directories): .git
  //   会直接打到屏幕上 —— 而这个检查本来就是【已知会失败、下面用 warn() 兜住】的
  //   （L269 那句「跳过」），英文原文不该漏给学员看。
  const tracked = execFileSync('git', ['ls-files', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\0').filter(Boolean);
    const danger = tracked.filter((f) => /(^|\/)(config\.local\.json|service\.local\.json)$/.test(f));
    if (danger.length) bad(S, '密钥文件没被跟踪', '这些被 git 跟踪了：' + danger.join(', '), 'git rm --cached <文件> 并确认 .gitignore');
    else ok(S, '密钥文件没被跟踪', 'config.local.json / service.local.json 都不在版本库里');
    ok(S, '被跟踪文件数', String(tracked.length));
  } catch (e) {
    // 【第 168 轮】原来这里打 e.message —— 而 execFileSync 的 message 里【含着 stderr】，
    //   于是学员屏上出现两行：
    //     ⚠️ git 跟踪检查：跳过：Command failed: git ls-files -z
    //     fatal: not a git repository (or any of the parent directories): .git
    //   第二行是 git 的英文原文，学员看不懂（他包里本来就不该有 .git）。
    //   按原因分开说：不是 git 仓库 = 正常；别的原因才带原文。
    const msg = String(e.stderr || e.message || '');
    if (/not a git repository/.test(msg)) {
      warn(S, 'git 跟踪检查', '跳过：这个包不带 .git（正常，只有开发机上才有）');
    } else {
      warn(S, 'git 跟踪检查', '跳过：' + String(e.message || e).split('\n')[0].slice(0, 60));
    }
  }

  for (const f of ['config.local.json', path.join('playwright-service', 'service.local.json')]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      try { JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); ok(S, f + ' 是合法 JSON', ''); }
      catch (e) { bad(S, f + ' 是合法 JSON', e.message, '修好它，否则所有脚本都会崩'); }
    }
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────
(async () => {
  await sectionService();
  sectionStores();
  sectionMonitor();
  sectionSafety();

  const bads = ROWS.filter((r) => r.level === 'bad');
  const warns = ROWS.filter((r) => r.level === 'warn');
  const oks = ROWS.filter((r) => r.level === 'ok');

  if (JSONOUT) {
    console.log(JSON.stringify({ ok: oks.length, warn: warns.length, bad: bads.length, rows: ROWS }, null, 2));
    process.exit(bads.length ? 1 : 0);
  }

  console.log('');
  console.log('══════════════ 学员机体检 ══════════════');
  let cur = '';
  ROWS.forEach((r) => {
    if (r.sec !== cur) { cur = r.sec; console.log('\n── ' + cur + ' ' + '─'.repeat(Math.max(0, 50 - cur.length))); }
    if (QUIET && r.level === 'ok') return;
    const tag = r.level === 'ok' ? '✅' : r.level === 'warn' ? '⚠️ ' : '❌';
    console.log('  ' + tag + ' ' + r.name + (r.detail ? '：' + r.detail : ''));
    if (r.fix && r.level !== 'ok') console.log('      → ' + r.fix);
  });

  console.log('\n══════════════ 结论 ══════════════');
  console.log('  ✅ ' + oks.length + ' 项通过    ⚠️ ' + warns.length + ' 项待办    ❌ ' + bads.length + ' 项有问题');
  if (bads.length) {
    console.log('\n  必须先处理这些 ❌：');
    bads.forEach((r) => console.log('    · [' + r.sec + '] ' + r.name + '：' + r.detail + (r.fix ? '\n      → ' + r.fix : '')));
  }
  console.log(bads.length
    ? '\n  ❌ 有 ' + bads.length + ' 项拦住你，处理完再上架/开推广。'
    : '\n  ✅ 整机可用。接下来逐店体检：node tools/store-init.js --all');
  console.log('');
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'logs', 'healthcheck-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.json'),
      JSON.stringify({ at: new Date().toISOString(), ok: oks.length, warn: warns.length, bad: bads.length, rows: ROWS }, null, 2), 'utf8');
  } catch (e) {}
  process.exit(bads.length ? 1 : 0);
})().catch((e) => { console.log('❌ 体检本身炸了：' + (e && e.stack || e)); process.exit(2); });
