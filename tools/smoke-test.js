#!/usr/bin/env node
/**
 * tools/smoke-test.js —— 在【刚打出来的包里】真跑一次体检
 *
 * 为什么有它（2026-11-13 第 142 轮）：
 *   静态检查（verify-student-view）能验「文件在不在」「语法对不对」，
 *   但验不了「跑起来会不会报错」和「提示文案指的地方对不对」。
 *   第 141 轮就是【在解压包里手跑了一次 healthcheck】，才发现：
 *     → node tools/store-new.js --name="<店铺名>" --from="好易美代拍"
 *   那句提示指的是【老板的店】，学员机器上根本没有 —— 静态检查永远看不出来。
 *
 * 它做什么：
 *   ① 解压最新的 xianyu-install-*.zip 到临时目录（模拟学员解压）
 *   ② 在 xianyu-achun 里跑 tools/healthcheck.js
 *   ③ 只把【意料之外】的失败报出来
 *      「config.local.json 不存在」「stores/ 下一份都没有」是正常的 ——
 *      学员装之前本来就没有，这两条不算问题。
 *
 * 用法:
 *   node tools/smoke-test.js
 *   node tools/smoke-test.js --keep     # 保留临时目录便于排查
 *
 * 退出码: 0 = 没有意料之外的失败；1 = 有
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const RELEASE = process.env.XY_RELEASE_DIR
  || path.join(ROOT, '..', '..', 'xianyu-release');

// 这些是【正常的】（学员装之前必然如此）
const EXPECTED = [
  'config.local.json：不存在',
  'stores/ 下一份都没有',
  'git 跟踪检查：跳过',
];

// 【第 167 轮】改成 async —— 新加的 [6] 起 staff-ui 后要轮询 /api/health，
//   那里用了 await。main 现在返回 Promise，末尾挂 .catch 兜住未捕获异常。
async function main() {
  console.log('');
  console.log('  ════ 包内冒烟测试 ════');

  if (!fs.existsSync(RELEASE)) {
    console.log('  · 发布目录不存在: ' + RELEASE);
    console.log('    先跑 node tools\\_build-install-bundle.js');
    process.exit(2);
  }
  const zips = fs.readdirSync(RELEASE)
    .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!zips.length) {
    console.log('  · 发布目录里没有 zip');
    process.exit(2);
  }
  const zip = path.join(RELEASE, zips[0].f);
  console.log('  [1] 解压 ' + zips[0].f);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'pipe' });
  const root = path.join(tmp, fs.readdirSync(tmp)[0]);
  const achun = path.join(root, 'xianyu-achun');
  if (!fs.existsSync(achun)) {
    console.log('  ❌ 解开后找不到 xianyu-achun');
    process.exit(1);
  }
  const top = fs.readdirSync(root);
  console.log('      ' + top.join(' / '));

  console.log('\n  [2] 在包内跑 healthcheck.js');
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [path.join('tools', 'healthcheck.js')],
      { cwd: achun, encoding: 'utf8', timeout: 180000, stdio: 'pipe' });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
    code = e.status == null ? 1 : e.status;
  }

  // 抓「必须先处理这些 ❌」那一段
  const m = out.match(/必须先处理这些 ❌：([\s\S]*?)(?:\n\n|$)/);
  const fails = m
    ? m[1].split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('·'))
    : [];

  const unexpected = fails.filter((f) => !EXPECTED.some((x) => f.includes(x)));

  console.log('      退出码 ' + code + '，❌ 项 ' + fails.length + ' 个');
  fails.forEach((f) => {
    const isExpected = EXPECTED.some((x) => f.includes(x));
    console.log('        ' + (isExpected ? '·（正常）' : '❌') + ' ' + f.replace(/^·\s*/, '').slice(0, 80));
  });

  // 顺便看结论行
  const sum = out.match(/✅ (\d+) 项通过\s+⚠️ (\d+) 项待办\s+❌ (\d+) 项有问题/);
  if (sum) console.log('\n      汇总: ' + sum[1] + ' ✅ / ' + sum[2] + ' ⚠️ / ' + sum[3] + ' ❌');

  // ── [3] 跑【学员最可能手贱试的那条】：publish-one 城市 明星 --dry ──
  //   第 144 轮实测：它在「还没装依赖」时抛的是英文
  //   「Cannot find module '...\node_modules\playwright'」—— 和 healthcheck 的失败
  //   完全不是一回事，只有真跑一次才看得见。
  //   --dry 不发（只出图），产物落在临时目录里，跑完整个 tmp 一起删掉。
  console.log('\n  [3] 在包内跑 publish-one 广州 王嘉尔 --dry');
  let pOut = '';
  try {
    pOut = execFileSync('node', [path.join('publish-one.js'), '广州', '王嘉尔', '--dry'],
      { cwd: achun, encoding: 'utf8', timeout: 240000, stdio: 'pipe' });
  } catch (e) {
    pOut = String((e.stdout || '') + (e.stderr || ''));
  }
  const pLines = pOut.split(/\r?\n/);

  // 这些是【正常的】（学员装之前）：
  const P_EXPECTED = [
    /还没装依赖/,                    // 144 轮改的中文提示（上面那三行）
    /依赖未安装/,                    // 144 轮 throw 的那一行（也是正常的）
    /Cannot find module .*playwright/i,  // 万一中文提示没生效，也别算致命
    /还没有自己的档案/,               // 店没配
    /先用一套通用默认值跑/,
    /出图: OK/,                      // 说明主链路通
  ];
  const pProblems = pLines.filter((l) => {
    if (/^(❌|Error:|TypeError|ReferenceError)/.test(l.trim())) {
      return !P_EXPECTED.some((re) => re.test(l));
    }
    return false;
  });

  // 关键正面信号：能出图 = 8093 通 + 大麦取数通 + 模板引擎通
  const gotImage = /出图: OK/.test(pOut);
  console.log('      ' + (gotImage ? '✅ 出图 OK（8093 + 大麦取数 + 模板引擎都通）' : '⚠️ 没看到「出图: OK」'));
  const noDep = /还没装依赖|Cannot find module .*playwright/i.test(pOut);
  if (noDep) console.log('      ·（正常）这台机器没装依赖，叠字那步做不了（中文提示已给）');

  if (pProblems.length) {
    console.log('      ❌ 意料之外的报错 ' + pProblems.length + ' 行:');
    pProblems.slice(0, 4).forEach((l) => console.log('          ' + l.trim().slice(0, 90)));
  }

  // ── [4] 跑【配置模板】那一步：store-wizard --dry ──
  //   为什么加（第 156 轮）：目标是「学员配好自己的模板 → 输入城市明星 → 上架」。
  //   前面三步验的是【装】和【发】，唯独没验【配】—— 而向导正是⑤「配置一家新店」的入口。
  //   它一条链上验了四件事：8093 账号表读得到、museav 能出图、按底图主色推荐版式、
  //   档案能拼出来（--dry 只不落盘）。
  //   输入喂一行店名，后面的步骤读到 EOF 就走默认值 —— 实测能一路跑完五步。
  console.log('\n  [4] 在包内跑 store-wizard --apply（配置模板那一步）');
  let wOut = '';
  try {
    wOut = execFileSync('node', [path.join('tools', 'store-wizard.js'), '--apply'],
      { cwd: achun, encoding: 'utf8', timeout: 180000, stdio: 'pipe', input: '冒烟配发店\n' });
  } catch (e) {
    wOut = String((e.stdout || '') + (e.stderr || ''));
  }
  const wSteps = {
    账号表: /8093 里的闲鱼账号/.test(wOut),
    // 出图：museav 成功（✅ 底图：…）或者【按设计降级】（出图失败但给出中文补救命令）
    //   第 162 轮实测：museav 挂了时向导会打
    //     「这次不写入底图，发布时会退回用大麦官方海报（不影响发布）」
    //     +「想补专属底图：museav login 后再跑 node tools/make-base-img.js …」
    //   这是【处理过的降级】不是 bug，不该让冒烟测试红。
    出图: /✅ 底图：/.test(wOut) || (/出图失败/.test(wOut) && /不影响发布/.test(wOut)),
    版式推荐: /推荐：/.test(wOut),
    档案预览: /将要写入档案|还差这两步/.test(wOut),
    档案写成功: fs.existsSync(path.join(achun, 'stores', '冒烟配发店.json')),
  };
  Object.entries(wSteps).forEach(([k, v]) => console.log('      ' + (v ? '✅' : '❌') + ' ' + k));
  // 只把【没被处理过的】算失败：
  //   fetch failed / 出图失败 —— 向导已给出中文说明和补救命令（见上）
  //   依赖没装 —— 中文提示已给（见 [3]）
  const wProblems = wOut.split(/\r?\n/).filter((l) =>
    /^(❌|Error:|TypeError|ReferenceError)/.test(l.trim())
    && !/还没装依赖|依赖未安装|fetch failed|出图失败|Command failed/.test(l));
  if (wProblems.length) {
    console.log('      ❌ 意料之外的报错 ' + wProblems.length + ' 行:');
    wProblems.slice(0, 4).forEach((l) => console.log('          ' + l.trim().slice(0, 90)));
  }

  // ── [5] 用【刚配好的店】发一次 ──
  //   为什么（第 162 轮）：[3] 是【没配店】时发的，走的是默认档；
  //   而学员一定是【先配店再发】，那条路会 require sharp（裁切/缩放），
  //   第 162 轮实测那里原来甩英文 Cannot find module —— 只有带档案才走得到。
  console.log('\n  [5] 用刚配好的店发一次（XY_STORE=冒烟配发店 --dry）');
  let cOut = '';
  try {
    cOut = execFileSync('node', [path.join('publish-one.js'), '广州', '王嘉尔', '--dry'],
      {
        cwd: achun, encoding: 'utf8', timeout: 240000, stdio: 'pipe',
        env: Object.assign({}, process.env, { XY_STORE: '冒烟配发店' }),
      });
  } catch (e) {
    cOut = String((e.stdout || '') + (e.stderr || ''));
  }
  const cLines = cOut.split(/\r?\n/);
  const cGotImage = /出图: OK/.test(cOut);
  const cNoDep = /还没装依赖|依赖未安装|Cannot find module/i.test(cOut);
  console.log('      ' + (cGotImage ? '✅ 出图 OK（带档案的完整链路通）'
    : cNoDep ? '·（正常）没装依赖，中文提示已给' : '⚠️ 没看到「出图: OK」'));
  // 关键：不能甩裸英文
  const cRaw = cLines.filter((l) => /Cannot find module|MODULE_NOT_FOUND/.test(l));
  if (cRaw.length) {
    console.log('      ❌ 还在甩英文 Cannot find module：' + cRaw[0].trim().slice(0, 90));
    wProblems.push('带档案发时甩了 Cannot find module');
  }

  // 【第 163 轮修】清理失败不该让测试判失败：Windows 上子进程句柄没放完时
  //   fs.rmSync 会 EPERM，于是「测试全过但清理崩了」→ 整个冒烟红 → build 报
  //   「四道检查没过」→ 拒发。实测连续两次 build 都栽在这（standalone 跑能过，
  //   因为负载不同、句柄释放得快）。清理是收尾动作，失败只提示。
  // ── [6] 网页入口：从包里起 staff-ui，验 /api/health 和首页 ──
  //   为什么加（第 167 轮）：一页纸第 ④ 步是【双击 启动.cmd → 浏览器自动打开】，
  //   那是学员的【主入口】，而前面五步验的全是命令行。服务起不来 = 学员第一步就卡住。
  //   用独立端口（默认 8099 可能被本机正在跑的服务占着），跑完立刻杀掉。
  console.log('\n  [6] 从包里起 staff-ui（网页入口）');
  const PORT = 18099;
  let webOk = false;
  let srv = null;
  try {
    srv = require('child_process').spawn(process.execPath,
      [path.join('tools', 'staff-ui', 'server.js'), '--port=' + PORT, '--store=冒烟测试店'],
      { cwd: achun, stdio: ['ignore', 'pipe', 'pipe'] });
    // 等它 listen
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const http = require('http');
        await new Promise((res, rej) => {
          const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2000 },
            (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); });
          req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
        }).then((d) => { webOk = /"ok"\s*:\s*true/.test(d); });
        if (webOk) break;
      } catch (e) { /* 还没起来，继续等 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('      ' + (webOk ? '✅ /api/health 返回 ok（服务起来了）' : '❌ 20 秒内没起来'));
    // 首页
    if (webOk) {
      const page = await new Promise((res, rej) => {
        const http = require('http');
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 5000 },
          (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); });
        req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
      }).catch(() => '');
      const hasCn = /闲鱼|上架|店铺/.test(page);
      console.log('      ' + (page.length > 1000 && hasCn ? '✅ 首页能开（' + page.length + ' 字节，中文正常）' : '❌ 首页不对'));
      if (!(page.length > 1000 && hasCn)) webOk = false;

      // 【第 199 轮加】目标那句话的字面路径在页面上必须存在：
      //   「一句话输入」框 + 城市/明星 两栏 + 确认发布勾选框 + 引导语。
      //   这些是学员点「① 发一条新链接」之后真正要交互的元素，
      //   少一个他就卡住（而 /api/health 和「中文正常」都发现不了）。
      const need = ['id="pub-oneline"', 'id="pub-city"', 'id="pub-star"', 'id="pub-confirm"'];
      const missIds = need.filter((s) => !page.includes(s));
      console.log('      ' + (missIds.length === 0
        ? '✅ 发链接要的4个控件都在（一句话输入/城市/明星/确认发布）'
        : '❌ 缺控件: ' + missIds.join(', ')));
      if (missIds.length) webOk = false;

      // 引导语：第 198 轮真浏览器看到的是「一句话输入 城市 明星 就行」。
      const hasGuide = /一句话输入/.test(page) && /城市/.test(page) && /明星/.test(page);
      console.log('      ' + (hasGuide ? '✅ 页面上有「一句话输入 城市 明星」的引导' : '❌ 引导语没了'));
      if (!hasGuide) webOk = false;

      // 【第 201 轮加】「配置发布模板」那半段（⑤ 向导）的控件 ——
      //   目标前半句是「配置好她的发布模板」，smoke [4] 验的是【命令行】向导，
      //   网页表单少一个输入框学员就配不了，而 /api/health 和 [4] 都发现不了。
      //   10 个字段里 wz-store 是必填，其余9 个都有默认值（价格50/版式__shoukai…）。
      const needWz = ['id="wz-store"', 'id="wz-price"', 'id="wz-spec"', 'id="wz-cat"',
        'id="wz-style"', 'id="wz-tpl"', 'id="wz-tone"', 'id="wz-budget"', 'id="wz-bid"'];
      const missWz = needWz.filter((s) => !page.includes(s));
      console.log('      ' + (missWz.length === 0
        ? '✅ 配模板的9个控件都在（店名/价格/规格/分类/风格/版式/口味/预算/出价）'
        : '❌ 向导缺控件: ' + missWz.join(', ')));
      if (missWz.length) webOk = false;

      // 【第 232 轮加】坏输入的报错必须是中文。
      //   为什么加：第232 轮实测 /api/action 的各种坏输入都返回
      //     400 {"error":"缺少参数：city"} / "未知动作" —— 全中文 ✅
      //   但这是「碰巧写对的」，没人守。哪天改成英文或直接甩堆栈，
      //   学员点「开始」只会看到天书，而 [6] 原有的断言（health/首页/控件）全都发现不了。
      //   三条全是400，不会真的起任务，安全。
      const badCases = [
        ['publish 缺城市', { kind: 'publish' }],
        ['未知动作', { kind: '不存在的动作' }],
        ['wizard 缺店名', { kind: 'wizard' }],
      ];
      let apiOk = true;
      for (const [name, body] of badCases) {
        try {
          const r = await fetch('http://127.0.0.1:' + PORT + '/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const txt = await r.text();
          const eng = /Cannot find module|node:internal|TypeError|at Object\.|stack/i.test(txt);
          const cn = /缺少参数|未知动作/.test(txt);
          if (r.status !== 400 || eng || !cn) {
            apiOk = false;
            console.log('      ❌ ' + name + ' → HTTP ' + r.status + ' ' + txt.slice(0, 90));
          }
        } catch (e) {
          apiOk = false;
          console.log('      ❌ ' + name + ' → ' + e.message);
        }
      }
      // 【第 233 轮】任务查询的坏路径 —— 兜底 404 原来是英文 `not found`，
      //   同一轮改成了「接口不存在：<路径>」。这两条守着它。
      for (const [name, u] of [
        ['任务不存在', '/api/task/99999'],
        ['非法任务id', '/api/task/abc'],
        ['兜底404', '/api/nope'],
      ]) {
        try {
          const r = await fetch('http://127.0.0.1:' + PORT + u);
          const txt = await r.text();
          const eng = /Cannot find module|node:internal|TypeError|stack/i.test(txt) || txt.includes('"not found"');
          const cn = /任务不存在|接口不存在/.test(txt);
          if (r.status !== 404 || eng || !cn) {
            apiOk = false;
            console.log('      ❌ ' + name + ' → HTTP ' + r.status + ' ' + txt.slice(0, 90));
          }
        } catch (e) {
          apiOk = false;
          console.log('      ❌ ' + name + ' → ' + e.message);
        }
      }
      console.log('      ' + (apiOk
        ? '✅ 坏输入的报错都是中文（缺少参数 / 未知动作 / 任务不存在 / 接口不存在，6 条）'
        : '❌ 有接口报错不是中文或不是预期状态码'));
      if (!apiOk) webOk = false;
    }
  } catch (e) {
    console.log('      ❌ 起服务失败: ' + e.message);
  } finally {
    if (srv) { try { srv.kill(); } catch (e) { /* 已退出 */ } }
  }
  if (!webOk) wProblems.push('staff-ui 起不来或首页不对');

  // ── [7] first-publish 的优雅停止 ──
  //   为什么加（第 195 轮）：[5] 验的是 publish-one（命令行，有兜底），
  //   而【网页那条路】跑的是 first-publish —— 它查不到场次会停在第 2 步。
  //   要验的是：停得【优雅且全中文】，不甩英文堆栈。
  //   （实测：广州 王嘉尔 大麦上没场次 → 正好用来验这条停止路径）
  //   ⚠️ 不要设 XY_STORE：设了会先走 store-ready，而冒烟店在 8093 里没有账号 →
  //      停在第 1 步「店铺没就绪」，根本走不到大麦那步（第 195 轮第一版就这么栽的）。
  //      不设就是默认店，它会先打一行「[还没配置]」警告再继续到第 2 步 —— 正是要验的路径。
  console.log('\n  [7] first-publish 查不到场次时的停止（网页那条路）');
  let f7 = '';
  try {
    f7 = execFileSync('node', [path.join('tools', 'first-publish.js'), '广州', '王嘉尔', '首开', '--event=演唱会'],
      { cwd: achun, encoding: 'utf8', timeout: 180000, stdio: 'pipe' });
  } catch (e) {
    f7 = String((e.stdout || '') + (e.stderr || ''));
  }
  const f7Stopped = /已停止|没有「/.test(f7);
  const f7Chinese = /大麦有「/.test(f7);
  const f7English = /Cannot find module|node:internal\/|\n\s+at\s+\w/.test(f7);
  console.log('      ' + (f7Stopped ? '✅' : '❌') + ' 停在大麦那步（没场次是预期）');
  console.log('      ' + (f7Chinese ? '✅' : '❌') + ' 提示是中文（大麦有「X」但没有「Y」）');
  console.log('      ' + (f7English ? '❌ 有英文堆栈' : '✅ 没有英文堆栈'));
  if (!f7Stopped) wProblems.push('first-publish 没停在大麦那步');
  if (!f7Chinese) wProblems.push('first-publish 的停止提示不是中文');
  if (f7English) wProblems.push('first-publish 甩了英文堆栈');

  if (!KEEP) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch (e) { console.log('  · 临时目录没清掉（句柄还占着），不影响结果: ' + e.message); }
  } else {
    console.log('\n      临时目录保留: ' + tmp);
  }

  console.log('');
  const wFailed = Object.values(wSteps).filter((v) => !v).length;
  if (unexpected.length || pProblems.length || wProblems.length || wFailed) {
    const n = unexpected.length + pProblems.length + wProblems.length + wFailed;
    console.log('  ❌ 有 ' + n + ' 项意料之外的失败 —— 这个包发出去学员会卡住');
    console.log('');
    process.exit(1);
  }
  console.log('  ✅ 没有意料之外的失败（「没装过」那几条是正常的）');
  console.log('');
}

main().catch((e) => {
  console.error('❌ 冒烟测试自己炸了: ' + (e && e.stack || e));
  process.exit(1);
});
