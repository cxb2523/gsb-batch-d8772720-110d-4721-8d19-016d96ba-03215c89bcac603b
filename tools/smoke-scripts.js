#!/usr/bin/env node
/**
 * tools/smoke-scripts.js —— 把【学员文档里教的脚本】逐个真跑一遍，找甩英文报错的
 *
 * 为什么有它（2026-11-13 第 152 轮）：
 *   `verify-student-view` ⑦ 组只查「命令里的脚本文件在不在、参数存不存在」，
 *   `smoke-test` 只跑 healthcheck + publish-one 两个。
 *   于是「跑起来会炸」这一类漏了三次：
 *     144 轮  publish-one 缺依赖 → 英文 Cannot find module
 *     151 轮  update.js 没 .git  → 英文 fatal: not a git repository
 *     152 轮  scrub-secrets 没 git → 英文 Command failed: git ls-files
 *              selftest-update 要 git+老板店档案 → ENOENT
 *   这个脚本把「学员文档里出现过的每个 node 脚本」在【解压出来的包里】跑一遍
 *   （不带参数，多数会打印用法就退出），把抛英文错的挑出来。
 *
 * ⚠️ 它【不会】自动挂进打包流程（要 75 秒，而且个别脚本无参也可能有副作用）。
 *   用法：加了新的学员命令、或者改了公共库之后，手动跑一次。
 *
 * 用法: node tools/smoke-scripts.js [--zip=<路径>]
 * 退出码: 0 = 没有甩英文报错的；1 = 有
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = process.env.XY_RELEASE_DIR || path.join(ROOT, '..', '..', 'xianyu-release');

// 明确跳过：无参也【会真动手】的（下架 / 开浏览器 / 真发 / 写样板）
const SKIP = new Set([
  'do-offshelf.js',            // 下架商品
  'publish-one.js',            // 真发（smoke-test 里用 --dry 单独跑）
  'tools/store-login.js',      // 会开浏览器扫码
  'tools/publish-group.js',    // 需要方案文件，且会真发
  'tools/first-publish.js',    // 会真发
  'tools/preset-export.js',    // --apply 会写样板
  'tools/install-tasks.js',    // 会注册计划任务
  'tools/store-ready.js',      // 会自动 start-all 起服务
  'tools/xxx.js',              // 文档里的占位符
]);

// 学员文档里出现过的脚本（改手册时同步这里）
const SCRIPTS = [
  'ad-cost-breaker.js',
  'tools/ad-plan-create.js', 'tools/ad-set-bid-budget.js', 'tools/ad-status.js',
  'tools/ad-window.js', 'tools/dump-store-config.js',
  'tools/print-paths.js', 'tools/probe-item-sku.js',
  'tools/scrub-secrets.js', 'tools/selftest-lib.js',
  'tools/set-ad-hours.js', 'tools/set-item-sku.js',
  'tools/store-audit.js', 'tools/store-bulk.js',
  'tools/store-init.js', 'tools/store-list.js', 'tools/store-new.js',
  'tools/today.js', 'tools/update.js',
  'tools/utf8-check.js', 'tools/verify-published.js',
  'tools/ad-review.js', 'tools/list-onsale.js', 'tools/probe-event-dup.js',
  'tools/probe-mtop-apis.js',
  // 【第 196 轮补】install-config.js —— 一页说明 / DSH 任务书 / 速查三份文档都提到它，
  //   但一直没进这个清单。无参跑 = 只打用法（exit 0），实测安全。
  'tools/install-config.js',
];

// 英文报错特征（学员看不懂的）
const ENGLISH = [
  /Cannot find module/i, /MODULE_NOT_FOUND/, /ENOENT/, /not a git repository/i,
  /SyntaxError/, /ReferenceError/, /TypeError/, /is not a function/,
  /Unexpected token/, /Command failed/, /npm ERR!/,
];

function main() {
  console.log('');
  console.log('  ════ 学员文档里的脚本逐个真跑 ════');

  let zip = (process.argv.find((a) => a.startsWith('--zip=')) || '').split('=')[1];
  if (!zip) {
    if (!fs.existsSync(RELEASE)) { console.log('  · 发布目录不存在'); return 2; }
    const zips = fs.readdirSync(RELEASE)
      .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!zips.length) { console.log('  · 没有 zip'); return 2; }
    zip = path.join(RELEASE, zips[0].f);
  }
  console.log('  ' + path.basename(zip));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-scripts-'));
  try {
    execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'pipe' });
    const root = path.join(tmp, fs.readdirSync(tmp)[0]);
    const achun = path.join(root, 'xianyu-achun');

    const list = SCRIPTS.filter((s) => !SKIP.has(s));
    console.log('  跑 ' + list.length + ' 个（跳过 ' + SKIP.size + ' 个会真动手的）\n');

    let bad = 0;
    for (const s of list) {
      const abs = path.join(achun, s);
      if (!fs.existsSync(abs)) {
        console.log('  ❌ ' + s + '  —— 文件不在包里（⑦ 组应该抓到，这里再兜一次）');
        bad++;
        continue;
      }
      let out = '', code = 0;
      try {
        out = execFileSync(process.execPath, [abs],
          { cwd: achun, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        out = String((e.stdout || '') + (e.stderr || ''));
        code = e.status == null ? -1 : e.status;
      }
      const eng = ENGLISH.filter((re) => re.test(out));
      if (!eng.length) continue;
      bad++;
      const first = out.split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).join('  |  ');
      console.log('  ❌ ' + s + '  (exit ' + code + ')');
      console.log('       命中: ' + eng.map((e) => e.source).join(', '));
      console.log('       ' + first.slice(0, 150));
    }

    console.log('');
    // ── 带参数的专项（无参跑不到的错误分支）──
    //   第 158 轮：`store-ready.js "不存在的店"` 原来甩的是 API 原文
    //     ❌ switch 也失败：{"ok":false,"error":"账号未找到: 测试店"}
    //   学员照手册敲这条命令（名字打错 / 还没配店）必然撞上。
    //   无参数跑只能看到用法，抓不到这类 —— 所以单独列几条。
    console.log('  带参数的专项（验错误分支的文案）');
    const WITH_ARGS = [
      {
        args: ['tools/store-ready.js', '冒烟测试-不存在的店'],
        // 期望：中文说清「没有这个店」，并且【不要】甩 {"ok":false,...} 这种 API 原文
        must: [/没有叫「冒烟测试-不存在的店」的店铺/],
        mustNot: [/\{"ok":false/],
      },
      {
        // 第 159 轮：store-login 原来每次都把 switch 的整个返回值甩出来
        //   （切换店铺：{"ok":true,"state":...}），失败时只说「切换失败，中止」。
        //   这条用【不存在的店名】触发，它会在开浏览器【之前】就退出，安全。
        args: ['tools/store-login.js', '冒烟测试-不存在的店'],
        must: [/账号列表里没有「冒烟测试-不存在的店」/],
        mustNot: [/\{"ok":/],
      },
      {
        // 第 216 轮：install-tasks 无参 = 预演（不注册任何任务，安全）。
        //   第165 轮修过它的报错：解释器型任务会注册到不存在的文件，
        //   提示改成「这是正常的，不是你装错了」。这条守着那个文案。
        args: ['tools/install-tasks.js'],
        must: [/脚本不在这个包里/, /不是你装错了/],
        mustNot: [/is not recognized|Cannot find module/],
      },
      {
        // 第 151 轮：update.js --status 在没有 .git 的学员包里
        //   原来甩英文 `fatal: not a git repository`，现在是中文说明。
        args: ['tools/update.js', '--status'],
        must: [/没法用「按 git 更新」/],
        mustNot: [/fatal: not a git repository|not a git repository/],
      },
      {
        // 第 243 轮：学员回报.js 是清单步骤10 让学员跑的收集器，
        //   它会跑预演安装 + 体检（约 11 秒），--no-save 是别写桌面
        //   （冒烟在开发机上跑，会覆盖桌面上已有的那份）。
        args: ['tools/学员回报.js', '--no-save'],
        must: [/【1】安装包校验/, /【5】一键体检/, /不写桌面文件/],
        mustNot: [/Cannot find module|node:internal|ENOENT/],
      },
    ];
    let argBad = 0;
    for (const c of WITH_ARGS) {
      const abs = path.join(achun, c.args[0]);
      if (!fs.existsSync(abs)) { console.log('  ❌ ' + c.args[0] + ' 不在包里'); argBad++; continue; }
      let out = '';
      try {
        out = execFileSync(process.execPath, [abs].concat(c.args.slice(1)),
          { cwd: achun, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        out = String((e.stdout || '') + (e.stderr || ''));
      }
      const miss = c.must.filter((re) => !re.test(out));
      const leak = c.mustNot.filter((re) => re.test(out));
      if (!miss.length && !leak.length) {
        console.log('  ✅ ' + c.args[0] + (c.args[1] ? ' ' + c.args[1] : '（无参）') + '  → 中文提示到位');
      } else {
        argBad++;
        console.log('  ❌ ' + c.args[0] + (c.args[1] ? ' ' + c.args[1] : '（无参）'));
        miss.forEach((re) => console.log('       缺少期望文案: ' + re));
        leak.forEach((re) => console.log('       泄漏了原文: ' + re + '  → ' + (out.match(re) || [''])[0].slice(0, 80)));
      }
    }

    console.log('');
    if (bad || argBad) {
      const n = bad + argBad;
      console.log('  ❌ ' + n + ' 个会甩英文报错给学员');
      console.log('     修法：识别出这个分支，给中文说明 + 告诉学员下一步该做什么');
      console.log('     （参考 144 轮 publish-one、151 轮 update.js、152 轮 scrub-secrets、158 轮 store-ready）');
      console.log('');
      return 1;
    }
    console.log('  ✅ 没有甩英文报错的');
    console.log('');
    return 0;
  } finally {
    // 同上：清理失败 ≠ 测试失败
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('  · 临时目录没清掉（句柄还占着），不影响结果: ' + e.message); }
  }
}

process.exit(main());
