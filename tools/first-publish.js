/**
 * tools/first-publish.js —— 学员的「第一条链接」入口（一次只发一条，全程带护栏）
 *
 * 为什么需要它：
 *   学员装完、登录完、验收通过之后，要发的第一条链接没有简单入口。
 *   直接跑 publish-one.js 会踩这些坑（都是 2026-10-17/18 真人真事）：
 *     ① 标题与在售重复 → 链接被判重、不进在售
 *     ② 大麦查不到票务 → 转 AI 兜底 → 中台积分不足 → 出图失败
 *     ③ 海报是 WebP 伪装 .jpg → 后续链路按扩展名处理出错
 *     ④ 海报不是 3:4 → 会被裁，可能裁掉主体
 *     ⑤ 冷门城市区划码错（宁波 330202 是江北区，海曙应为 330203）→ 发布被拒
 *     ⑥ 发布"成功"但平台审核中(-9) → 学员以为系统坏了
 *
 * 本入口把上面 6 条全部前置检查 + 事后复核，学员只需要回答几个问题。
 *
 * 用法（学员只需要记这一条）：
 *   node tools/first-publish.js 杭州 周杰伦 首开
 *
 * 可选：
 *   --event=脱口秀      活动类型（默认 演唱会）
 *   --price=50          标价（默认走店铺档案）
 *   --yes               跳过确认（自动化用，不建议学员用）
 *   --verify-wait=600   发布后等多久复核（默认 600 秒）
 *
 * 流程：
 *   ① 环境体检（8093 在跑 / 店铺已登录）
 *   ② 大麦查场次（查不到就直接停 —— 不让你花 AI 积分兜底）
 *   ③ 海报校验（格式 / 比例 / 自动转 JPEG + 裁 3:4）
 *   ④ 标题生成 + 与台账在售全量查重
 *   ⑤ --dry 预演给你看
 *   ⑥ 你确认 → 真发
 *   ⑦ 等 N 分钟 → 复核平台是否放行
 *
 * 退出码: 0 成功在售 / 1 失败或需人工 / 2 用法或环境问题
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const { STORE, PATHS } = require('../lib/env');
const titleLib = require('../lib/title');

// ── 参数 ──
const argv = process.argv.slice(2);
const argOf = (k) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : ''; };
const POS = argv.filter((a) => !a.startsWith('--'));
const CITY = POS[0];
const STAR = POS[1];
const SESSION = POS[2] || '首开';
const EVENT = argOf('event') || '演唱会';
const PRICE = argOf('price') || '';
const YES = argv.includes('--yes');
const VERIFY_WAIT = Number(argOf('verify-wait') || 600);
// 底图来源（2026-11-12 加）：
//   实测发现 first-publish 原来【无条件】用大麦官方海报，把档案里配好的
//   museav 店铺专属底图（主图.baseImg）整个盖掉了 —— 老板要的「主图走 museav 中台」
//   在真实发布里根本没生效。
//   现在三级：命令行 --base= > 档案 主图.底图来源 > 默认 damai
//   damai = 大麦官方海报（有明星脸，点击率高）
//   shop  = 店铺专属底图（museav 生成，无版权风险、小众场次也能用、视觉统一）
const BASE_MODE = (() => {
  const fromArg = (argOf('base') || '').toLowerCase();
  if (fromArg) return fromArg;
  try {
    const p = require(path.join(ROOT, 'lib', 'store-profile')).load(STORE);
    const fromProfile = p && p.主图 && p.主图.底图来源;
    if (fromProfile) return String(fromProfile).toLowerCase();
  } catch (e) { /* 档案读不到就用默认 */ }
  return 'damai';
})();

if (!CITY || !STAR) {
  console.log('');
  console.log('用法: node tools/first-publish.js <城市> <明星> [场次] [--event=演唱会] [--price=50]');
  console.log('');
  console.log('例子:');
  console.log('  node tools/first-publish.js 杭州 周杰伦 首开');
  console.log('  node tools/first-publish.js 上海 付航 首开 --event=脱口秀');
  console.log('');
  process.exit(2);
}

const say = (s) => console.log(s);
const head = (s) => { say(''); say('='.repeat(64)); say('  ' + s); say('='.repeat(64)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts) {
  try {
    // stdio 必须显式给（第 164 轮实测）：默认情况下 execFileSync【既捕获又转发】
    //   子进程的 stderr —— 于是 tools/agent-reset.js 不在包里时，这句虽然被
    //   try/catch 吞了，屏幕上照样打出一坨英文：
    //       node:internal/modules/cjs/loader:1572  throw err;  Error: Cannot find module ...
    //   ['ignore','pipe','pipe'] = stdout/stderr 都捕获、都不往控制台漏。
    const out = execFileSync(cmd, args, Object.assign(
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      opts || {}));
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') + '\n[exit] ' + e.message };
  }
}

// ── 标题生成（与 publish-one.js / publish-group.js 同一套）──
const TPL = (() => {
  const f = path.join(os.homedir(), '.xianyu-templates.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).templates || []; } catch (e) { return []; }
})();
const PAD = [' 全站全价位都可接', ' 全价位都能接', ' 高命中率', ' 全价位接', ' 可上号', ' 秒付前排', ' 稳中', ' 秒付', ' 包中'];
const fit = titleLib.makeFitTitle({ pad: PAD, max: titleLib.PLATFORM_TITLE_MAX, min: 30 });

function titleOf(tplId) {
  const t = TPL.find((x) => Number(x.id) === Number(tplId));
  if (!t) return null;
  const raw = String(t.titlePattern)
    .replace(/\{明星\}/g, STAR).replace(/\{城市\}/g, CITY)
    .replace(/\{活动类型\}/g, EVENT).replace(/\{场次类型\}/g, SESSION);
  // ⚠️ fit(raw) 直接返回【字符串】；fit.detail(raw) 才返回 {text, how}。
  //    2026-10-18 这里用错 API，导致读 t.text 报 undefined.length 整脚本崩。
  const text = fit(raw);
  if (typeof text !== 'string' || !text) return null;
  return { text };
}

(async () => {
  head('第一条链接 · ' + CITY + ' ' + STAR + ' ' + EVENT + ' ' + SESSION);

  // ═══ 步骤 1：环境体检 ═══
  say('');
  say('[1/6] 检查环境...');

  // 8093
  let svcUp = false;
  try {
    const r = run(NODE, [path.join(ROOT, 'tools', 'agent-reset.js'), '--help'], { timeout: 30000 });
    svcUp = true; // agent-reset 能跑说明环境基本正常；真正的检查在下一步
  } catch (e) { /* 忽略 */ }

  const ready = run(NODE, [path.join(ROOT, 'tools', 'store-ready.js'), STORE], { timeout: 300000 });
  if (!ready.ok || !/就绪|ready/.test(ready.out)) {
    say('  ❌ 店铺「' + STORE + '」没就绪。');
    say('');
    say('  先做这两件事：');
    say('    1. 确认 8093 服务在跑：看 playwright-service\\startup.log 最后几行');
    say('    2. 跑 node tools/store-ready.js "' + STORE + '"');
    say('');
    say('  原始输出：');
    say(ready.out.split('\n').slice(-8).map((l) => '    ' + l).join('\n'));
    process.exit(2);
  }
  say('  ✅ 店铺「' + STORE + '」就绪');

  // ═══ 步骤 2：大麦查场次 ═══
  say('');
  say('[2/6] 查大麦（这一步查不到就停 —— 避免花中台积分兜底）...');
  const damai = run(NODE, [path.join(ROOT, 'tools', 'damai-events.js'), STAR, '--full'], { timeout: 300000 });
  const dOut = damai.out || '';
  if (/一条都没截到/.test(dOut)) {
    say('  ⚠️ 大麦查不到「' + STAR + '」的场次。');
    say('');
    say('  这意味着：出图会走中台 AI 兜底，而中台积分不足会直接失败。');
    say('  建议：');
    say('    · 确认明星名写法对不对（比如「亿轩」vs「彭梓烨」）');
    say('    · 或者让管理员给你一张海报，用 --base-img=<路径> 指定');
    say('');
    say('  —— 已停止，不继续。');
    process.exit(1);
  }

  // 解析候选行。格式来自 tools/damai-events.js 的输出（--full 时列宽是固定的）：
  //   "  <id> <cityName padEnd(5)> <showTime slice(0,40) padEnd(40+2)> <venue padEnd(40+2)> <name>"
  // 注意：城市后面没有分隔符，时间字段内部也有空格 —— 所以【不能靠 \S+/空格 切】，
  //       必须按 damai-events.js 的固定列宽切。这里用「id + 城市(<=5汉字) + 时间 + 场馆 + 名称」
  //       的更宽松写法：先按前导空白切出 id，再按「两个以上空格」分段（因为 padEnd 会补很多空格）。
  const cands = [];
  dOut.split('\n').forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    const idm = line.match(/^\s{2}(\d{10,})\s+(.*)$/);
    if (!idm) return;
    const id = idm[1];
    const rest = idm[2];
    // 按「2 个以上空格」分段：城市/时间之间可能只有 1 个空格，所以先取城市 = 开头的非空格串
    const cityM = rest.match(/^(\S+)\s+(.*)$/);
    if (!cityM) return;
    const city = cityM[1];
    const tail = cityM[2];
    const parts = tail.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    // parts 通常是 [时间, 场馆, 名称]；若名称里也有大段空格，合并后面所有段
    const showTime = parts[0] || '';
    const venue = parts[1] || '';
    const name = parts.slice(2).join(' ') || parts[parts.length - 1] || '';
    cands.push({ id, city, showTime, venue, name });
  });
  const inCity = cands.filter((c) => c.city.includes(CITY) || CITY.includes(c.city));
  if (!inCity.length) {
    say('  ⚠️ 大麦有「' + STAR + '」的场次，但没有「' + CITY + '」的：');
    cands.slice(0, 8).forEach((c) => say('     [' + c.city + '] ' + c.name.slice(0, 40)));
    say('');
    say('  —— 已停止。城市写错了？还是这场还没开票？');
    process.exit(1);
  }
  const show = inCity[0];
  say('  ✅ 找到：' + show.name);
  say('     大麦 id ' + show.id + ' · ' + show.showTime + ' · ' + show.venue);

  // ═══ 步骤 3：海报 ═══
  say('');
  say('[3/6] 检查海报...');
  const posterRe = /海报:\s*(https?:\/\/\S+)/;
  const pm = dOut.match(posterRe);
  let baseImg = '';

  // 店铺专属底图优先（--base=shop）：直接拿档案里的 主图.baseImg，跳过下载大麦海报
  const shopBase = (() => {
    try {
      const p = require(path.join(ROOT, 'lib', 'store-profile')).load(STORE);
      return (p && p.主图 && p.主图.baseImg) || '';
    } catch (e) { return ''; }
  })();
  if (BASE_MODE === 'shop') {
    if (!shopBase) {
      say('  ⚠️ 档案里没有 主图.baseImg，退回用大麦海报。先跑：node tools/make-base-img.js --store="' + STORE + '" --style=gold');
    } else if (!fs.existsSync(path.join(ROOT, shopBase))) {
      say('  ⚠️ 底图文件不存在：' + shopBase + '，退回用大麦海报');
    } else {
      baseImg = path.join(ROOT, shopBase);
      say('  ✅ 用店铺专属底图（museav）：' + shopBase);
    }
  }

  if (!baseImg && !pm) {
    say('  ⚠️ 大麦返回里没找到海报 URL，将走服务端自动搜图（可能失败）');
  } else if (!baseImg) {
    const url = pm[1];
    const dir = path.join(ROOT, 'publish-assets', STORE, '底图', '大麦-新场次');
    fs.mkdirSync(dir, { recursive: true });
    const raw = path.join(dir, show.id + '-raw');
    const dst = path.join(dir, show.id + '-3x4.jpg');

    // 下载
    const dl = run(NODE, ['-e', `
      const https=require('https'),fs=require('fs');
      const u=${JSON.stringify(url)};
      (function get(url, depth){
        if (depth > 5) { console.error('重定向过多'); process.exit(1); }
        https.get(url,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://m.damai.cn/'}},r=>{
          if (r.statusCode>=300 && r.statusCode<400 && r.headers.location) { return get(r.headers.location, depth+1); }
          const chunks=[]; r.on('data',c=>chunks.push(c));
          r.on('end',()=>{ fs.writeFileSync(${JSON.stringify(raw)}, Buffer.concat(chunks)); process.stdout.write('ok'); });
        }).on('error',e=>{console.error(e.message);process.exit(1);});
      })(u, 0);
    `], { timeout: 120000 });

    if (!dl.ok) {
      say('  ⚠️ 海报下载失败：' + (dl.out || '').slice(0, 120));
      say('     将走服务端自动搜图。');
    } else {
      // 用 sharp 检测格式 + 裁成 3:4
      // ⚠️ 不能写成 node -e "<长脚本>"：里面嵌套 JSON.stringify 会被外层先求值，
      //    导致 "dst is not defined"（2026-10-18 实际踩到）。改用临时文件。
      const tmpJs = path.join(ROOT, '_tmp-cover-' + Date.now() + '.js');
      const sharpPath = path.join(PATHS.playwrightService || '', 'node_modules', 'sharp')
        .replace(/\\/g, '/');
      fs.writeFileSync(tmpJs, `
const sharp = require(${JSON.stringify(sharpPath)});
const src = ${JSON.stringify(raw)};
const dst = ${JSON.stringify(dst)};
(async () => {
  const m = await sharp(src).metadata();
  const w = m.width, h = m.height;
  const r = w / h;
  let cw = w, ch = h, left = 0, top = 0;
  if (Math.abs(r - 0.75) > 0.01) {
    if (r > 0.75) { cw = Math.round(h * 0.75); left = Math.floor((w - cw) / 2); }
    else { ch = Math.round(w * 4 / 3); top = Math.floor((h - ch) / 2); }
  }
  await sharp(src).extract({ left, top, width: cw, height: ch }).jpeg({ quality: 92 }).toFile(dst);
  const m2 = await sharp(dst).metadata();
  process.stdout.write(JSON.stringify({ srcFormat: m.format, w, h, outFormat: m2.format, ow: m2.width, oh: m2.height, ratio: (m2.width / m2.height).toFixed(4), cropped: Math.abs(r - 0.75) > 0.01 }));
})().catch((e) => { console.error(e.message); process.exit(1); });
`, 'utf8');

      const conv = run(NODE, [tmpJs], { timeout: 120000 });
      try { fs.unlinkSync(tmpJs); } catch (e) {}

      if (!conv.ok) {
        say('  ⚠️ 海报处理失败：' + (conv.out || '').slice(0, 120));
        say('     将走服务端自动搜图。');
      } else {
        const info = JSON.parse(conv.out);
        baseImg = dst;
        say('  ✅ 海报已备好：' + info.w + 'x' + info.h + ' (' + info.srcFormat + ') → ' + info.ow + 'x' + info.oh + ' (' + info.outFormat + ', ' + info.ratio + ')');
        if (info.cropped) say('     注意：原图不是 3:4，已居中裁切（可能裁掉边缘）');
        try { fs.unlinkSync(raw); } catch (e) {}
      }
    }
  }

  // ═══ 步骤 4：标题 + 查重 ═══
  say('');
  say('[4/6] 生成标题并查重...');
  const POOL = [1, 2, 3, 4, 5];
  const led = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '上架台账.json'), 'utf8')); } catch (e) { return []; } })();
  const onSale = led.filter((x) => !x.状态 && x.标题);

  const cands2 = [];
  for (const id of POOL) {
    const t = titleOf(id);
    // ⚠️ titleOf 可能返回 undefined（模板不存在 / fitText 内部抛错）——
    //    2026-10-18 踩过：t.text 读 undefined.length 直接崩，学员会看到一坨堆栈。
    if (!t || typeof t.text !== 'string' || !t.text) continue;
    const clash = onSale.some((r) => r.标题 === t.text);
    cands2.push({ tplId: id, text: t.text, clash, len: t.text.length });
  }
  if (!cands2.length) {
    say('  ❌ 读不到文案模板（~/.xianyu-templates.json）。先跑一次 install.ps1。');
    process.exit(2);
  }

  const safe = cands2.filter((c) => !c.clash);
  say('  模板候选（与在售 ' + onSale.length + ' 条比对）：');
  cands2.forEach((c) => {
    say('    模' + c.tplId + ' ' + (c.clash ? '❌ 与在售重复' : '✅ ') + c.len + '字  ' + JSON.stringify(c.text));
  });

  if (!safe.length) {
    say('');
    say('  ❌ 五个模板算出来的标题全都与在售重复。');
    say('     说明这个场次已经发过了。先看有没有旧链接可以直接用：');
    onSale.filter((r) => String(r.标题).includes(STAR)).slice(0, 5).forEach((r) => say('       ' + r.itemId + '  ' + r.标题));
    say('');
    say('  —— 已停止，没有发任何东西。');
    process.exit(1);
  }

  const pick = safe[0];
  say('');
  say('  本次使用：模' + pick.tplId + ' · ' + pick.text.length + ' 字');
  say('     ' + JSON.stringify(pick.text));

  // ═══ 步骤 5：预演 ═══
  say('');
  say('[5/6] 预演（--dry，不真发）...');
  const dryArgs = [path.join(ROOT, 'publish-one.js'), CITY, STAR, SESSION, '--dry', '--event=' + EVENT];
  const dryEnv = Object.assign({}, process.env, { KUN_TITLE_TPL_ID: String(pick.tplId) });
  if (PRICE) { dryArgs.push('--price=' + PRICE); }
  if (baseImg) { dryEnv.KUN_BASE_IMG = baseImg; }
  const dry = run(NODE, dryArgs, { env: dryEnv, timeout: 600000 });

  const keep = /档案对照表|主图|底图|副图|文案|标题字数|分类|规格|价格|所在地|发货|承诺|广告|文字层|卡片标题|全文|❌|⚠️/;
  dry.out.split('\n').forEach((l) => { if (keep.test(l)) say('  ' + l.trim()); });

  if (/❌/.test(dry.out)) {
    say('');
    say('  ❌ 预演里有错误，已停止。把上面这段发给管理员。');
    process.exit(1);
  }

  // ═══ 步骤 6：确认后真发 ═══
  say('');
  say('[6/6] 真要发吗？');
  say('');
  say('  城市 ' + CITY + ' · 明星 ' + STAR + ' · ' + EVENT + ' · ' + SESSION);
  say('  标题 ' + JSON.stringify(pick.text));
  say('');
  if (!YES) {
    say('  确认无误就重跑，末尾加 --yes：');
    say('    node tools/first-publish.js ' + CITY + ' ' + STAR + ' ' + SESSION +
      ' --event=' + EVENT + (baseImg ? ' --yes' : ' --yes'));
    say('');
    say('  （没有发任何东西）');
    process.exit(0);
  }

  say('  发布中...');
  const pubArgs = [path.join(ROOT, 'publish-one.js'), CITY, STAR, SESSION, '--event=' + EVENT];
  if (PRICE) pubArgs.push('--price=' + PRICE);
  const pub = run(NODE, pubArgs, { env: dryEnv, timeout: 900000 });
  pub.out.split('\n').forEach((l) => {
    if (/itemId|✅|❌|回读|图床|已记账|goofish\.com\/item/.test(l)) say('  ' + l.trim());
  });

  const idm = pub.out.match(/itemId["'\s:]+(\d{10,})/) || pub.out.match(/item\?id=(\d{10,})/);
  if (!idm) {
    say('');
    say('  ❌ 没拿到 itemId —— 可能没发出去。把上面输出发给管理员。');
    process.exit(1);
  }
  const itemId = idm[1];
  say('');
  say('  ✅ 已发布：https://www.goofish.com/item?id=' + itemId);

  // ═══ 事后复核 ═══
  say('');
  say('等 ' + Math.round(VERIFY_WAIT / 60) + ' 分钟后复核平台是否放行（审核中的 -9 会自己转正）...');
  const ver = run(NODE, [path.join(ROOT, 'tools', 'verify-published.js'), itemId, '--wait=' + VERIFY_WAIT], { timeout: (VERIFY_WAIT + 300) * 1000 });
  ver.out.split('\n').forEach((l) => { if (l.trim()) say('  ' + l.trim()); });

  if (/在售/.test(ver.out) && !/❌/.test(ver.out)) {
    say('');
    say('  🎉 成功！这条链接已经在售。');
    say('     链接：https://www.goofish.com/item?id=' + itemId);
    process.exit(0);
  }
  say('');
  say('  ⚠️ 复核没过。可能还在审核，也可能被拒。');
  say('     过 10 分钟再跑一次：node tools/verify-published.js ' + itemId);
  process.exit(1);
})().catch((e) => { console.error('ERR: ' + (e && e.stack || e)); process.exit(2); });
