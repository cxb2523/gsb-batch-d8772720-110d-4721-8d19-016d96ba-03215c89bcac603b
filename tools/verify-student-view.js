#!/usr/bin/env node
/**
 * tools/verify-student-view.js —— 用「学员的目录结构」验一遍安装流程
 *
 * 为什么需要它（2026-11-13）：
 *   这台开发机上 Node / museav / git 全都装好了，很多问题在本机【永远不会出现】。
 *   前几轮踩到的坑（文案模板没人生成、museav 装不上、store.active 指向老板的店、
 *   装完提示要自己替换占位符）都是靠"假装自己是学员"才发现的。
 *   而假装的方法每次都得手打一遍命令、还得盯输出——很容易漏。
 *   这个脚本把那一套固化下来：解压最新包 → 造一份假 service.local.json →
 *   跑 install.ps1 -DryRun → 逐项断言。
 *
 * ⚠️ 它只验【安装器这一侧】能验的东西。真机上才有的差异（没装 Node、
 *    Chromium 首次下载、真扫码、真发布）这里验不了，见 真机首装验证清单.md。
 *
 * 用法:
 *   node tools/verify-student-view.js                  # 用 D:\xianyu-release 里最新的包
 *   node tools/verify-student-view.js --zip=<路径>      # 指定包
 *   node tools/verify-student-view.js --store=我的测试店 # 指定假店名
 *   node tools/verify-student-view.js --keep            # 保留临时目录便于排查
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

const STORE = String(A.store || '验证用测试店');
const KEEP = !!A.keep;

function findZip() {
  if (A.zip) return A.zip;
  const dir = 'D:\\xianyu-release';
  if (!fs.existsSync(dir)) return '';
  const zips = fs.readdirSync(dir).filter(f => /^xianyu-install-.*\.zip$/.test(f));
  if (!zips.length) return '';
  // 按【修改时间】取最新（按字母序会选错：f4f4968 排在 7ed762d 后面）
  zips.sort((a, b) => fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
  return path.join(dir, zips[zips.length - 1]);
}

const ZIP = findZip();
if (!ZIP || !fs.existsSync(ZIP)) {
  console.log('');
  console.log('❌ 找不到分发包。');
  console.log('');
  console.log('   ⚠️ 这个脚本是【给技术负责人】用的，不是学员工具。');
  console.log('      学员不需要跑它 —— 装完之后双击「启动.cmd」打开网页就行。');
  console.log('');
  console.log('   它要在打包机上跑，且先要有分发包：');
  console.log('      node tools/make-release.js             （打三个仓）');
  console.log('      node tools/_build-install-bundle.js    （合成学员包）');
  console.log('      node tools/verify-student-view.js      （再回来验）');
  console.log('');
  console.log('   或者直接指定一个已有的包：');
  console.log('      node tools/verify-student-view.js --zip=<某个 xianyu-install-*.zip>');
  console.log('');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail: detail || '' });
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + name + (detail ? '   ' + detail : ''));
};

(async () => {
  console.log('\n════ 学员视角验证 ════');
  console.log('包     : ' + path.basename(ZIP));
  console.log('假店名 : ' + STORE);

  const stage = path.join(os.tmpdir(), 'xy-verify-' + Date.now());
  fs.mkdirSync(stage, { recursive: true });

  // ── ① 解压 ──
  console.log('\n① 解压');
  try {
    execFileSync('tar', ['-xf', ZIP, '-C', stage], { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    check('解压成功', false, String(e.message).slice(0, 80));
    process.exit(1);
  }
  const roots = fs.readdirSync(stage, { withFileTypes: true }).filter(d => d.isDirectory());
  if (!roots.length) { check('找到解压后的目录', false); process.exit(1); }
  const root = path.join(stage, roots[0].name);
  const achun = path.join(root, 'xianyu-achun');
  check('解压后能定位到 xianyu-achun', fs.existsSync(achun));

  // ── ② 三目录并排 ──
  console.log('\n② 目录结构（学员最容易搞错的地方）');
  ['xianyu-achun', 'xianyu-playwright-service', 'xianyu-monitor'].forEach(d => {
    check(d + ' 并排存在', fs.existsSync(path.join(root, d)));
  });
  check('install.cmd 在根层', fs.existsSync(path.join(root, 'install.cmd')));
  check('install-guide.html 在根层', fs.existsSync(path.join(root, 'install-guide.html')));

  // ── ③ 造一份学员的 service.local.json ──
  console.log('\n③ 造学员的账号配置');
  const svcLocal = path.join(root, 'xianyu-playwright-service', 'service.local.json');
  const fakeId = '00000000-1111-2222-3333-444444444444';
  fs.writeFileSync(svcLocal, JSON.stringify({
    _说明: 'verify-student-view.js 造的假配置，只用于验证',
    localAccounts: [{ id: fakeId, name: STORE, username: '', password: '' }],
  }, null, 2), 'utf8');
  check('service.local.json 已写入', fs.existsSync(svcLocal), 'id=' + fakeId.slice(0, 8) + '… name=' + STORE);

  // ── ④ 跑 install.cmd（学员真实入口，不是 install.ps1）──
  // ⚠️【2026-11-13 改】原来这里直接跑 install.ps1 —— 那是【跳过 launcher】的。
  //   结果 launcher 里一个裸的 ')' 让整个安装器崩掉（退出码 255）好几轮都没被发现，
  //   而这个脚本一直报 16/16 通过。学员双击的可是 install.cmd，不是 install.ps1。
  //   现在两层都跑：先 install.cmd（含 launcher 的 6 个 if 检查），再核对输出。
  console.log('\n④ 跑安装预演（-DryRun，经 install.cmd —— 学员双击的就是这个）');
  let out = '';
  let exitCode = null;
  try {
    // 用 cmd 调 .cmd 才能复现学员环境；< nul 是为了跳过脚本末尾的 pause
    // 注意：不要自己给路径套一层引号再拼进参数（Node 会再转义一次，cmd 收到的是 \"C:\...\"）
    // 注意：不要自己给路径套引号再拼进参数（Node 会再转义一次，cmd 收到 \"C:\...\"）。
    //   实测两种写法都不可靠：execFileSync('cmd', ['/c', '"..." -DryRun']) 和临时 .bat。
    //   最稳的：直接执行 .cmd（Windows 上 Node 会自己经 cmd.exe），
    //   末尾的 pause 用 input 喂回车跳过。
    // Node 在 Windows 上【不能直接 spawn .cmd】（spawnSync EINVAL）。
    // 必须经 cmd.exe，且路径要作为【独立参数】传（自己拼字符串会被 Node 再转义一次，
    // cmd 收到的是 \"C:\...\" 反而认不出来）。
    const r = execFileSync('cmd.exe', ['/c', path.join(root, 'install.cmd'), '-DryRun'],
      { cwd: root, encoding: 'utf8', timeout: 600000, input: '\r\n\r\n' });
    out = r;
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    exitCode = (e.status === undefined || e.status === null) ? -1 : e.status;
  }
  // launcher 崩掉的典型症状：退出码非 0 且没有任何"闲鱼自动化 · 安装"的横幅
  check('install.cmd 正常跑完（没在 launcher 阶段崩）', exitCode === 0 || exitCode === null,
    exitCode === null ? '' : ('退出码 ' + exitCode));
  // 【第 153 轮改】横幅从英文改成了中文（学员双击看到的第一行）。
  //   断言跟着改 —— 它的真正用途是「launcher 有没有跑到 echo 那一行」，
  //   中文横幅同样能证明这一点，而且顺带验了 UTF-8 中文在包里没乱码。
  check('launcher 横幅打印了', /闲鱼自动化 · 安装器/.test(out));
  // 【第 154 轮加】上面传的是 -DryRun，那就【只该预演】。
  //   原来的 launcher 不转发参数（没有 %*），-DryRun 被静默丢掉，
  //   于是「install.cmd -DryRun」会把【正式安装】也跑了 —— 想预演的人被真装。
  //   现在带参数走 :withargs 单步转发，这条断言守着它别再退回去。
  check('install.cmd -DryRun 只预演（参数有被转发）', !/第 2\/2 步：正式安装/.test(out),
    /第 2\/2 步：正式安装/.test(out) ? '带 -DryRun 却跑了正式安装 → 参数没转发' : '');
  check('没出现 cmd 语法错误', !/was unexpected at this time|is not recognized as an internal/i.test(out),
    (/was unexpected at this time/.test(out) ? '出现 "was unexpected at this time" → launcher 里有未转义的括号' : ''));

  // ── ⑤ 逐项断言 ──
  console.log('\n⑤ 断言');

  check('node 被识别', /\[ok\]\s+node:/.test(out), (out.match(/\[ok\]\s+node:.*/) || [''])[0].trim().slice(0, 70));

  // npm 必须和 node 同源（2026-11-12 修过的坑）
  const npmLine = (out.match(/\[DryRun\]\s+(\S*npm(?:\.cmd|\.exe|\.ps1))\s+install/) || [])[1] || '';
  const nodePath = (out.match(/\[ok\]\s+node:\s*(\S+)/) || [])[1] || '';
  const nodeDir = nodePath ? path.dirname(nodePath).toLowerCase() : '';
  check('npm 与 node 同源', !!npmLine && (!nodeDir || npmLine.toLowerCase().includes(nodeDir.slice(-30))),
    npmLine ? path.basename(npmLine.split(/\s+/)[0]) : '(没找到 npm install 行)');

  check('两个依赖仓都就位', /xianyu-playwright-service 已就位/.test(out) && /xianyu-monitor 已就位/.test(out));

  check('文案模板库这一步跑到了', /文案模板库/.test(out),
    (out.match(/已生成: .*xianyu-templates\.json|已存在，不覆盖: .*xianyu-templates\.json/) || [''])[0].trim().slice(0, 60));

  check('出图客户端这一步跑到了', /出图客户端/.test(out),
    (out.match(/museav 已装: .*|\[DryRun\] .*museav-cli@latest/) || [''])[0].trim().slice(0, 60));

  check('没有缺失项', /没有缺失项/.test(out));
  check('没有 FAIL', !/\[FAIL\]/.test(out));

  // 最关键的：装完提示必须用学员的店名，不能是占位符
  const tail = out.slice(out.indexOf('剩下必须人工做的三件事'));
  check('装完提示用了学员店名', tail.includes(STORE), tail.includes(STORE) ? '✓ 含 "' + STORE + '"' : '⚠️ 还是占位符');
  check('装完提示没有残留占位符', !/<你的店铺名>|<店铺名>/.test(tail),
    /<你的店铺名>|<店铺名>/.test(tail) ? '出现了 <你的店铺名>' : '');

  // ── ⑥ 学员的另一个入口：启动.cmd ──
  //   这个文件【不能真跑】（它前台起 node 服务、会阻塞，而且会抢 8099 端口）。
  //   但它有两个极易被改坏的点，静态检查就能抓：
  //     ① 必须用 GBK 存（中文系统 cmd 按 936 解析；存成 UTF-8 会印一屏乱码）
  //     ② 跑 node 之前必须 chcp 65001（node 输出是 UTF-8，936 下日志全乱码）
  console.log('\n⑥ 学员的日常入口 启动.cmd');
  const launchPath = path.join(achun, 'tools', 'staff-ui', '启动.cmd');
  if (!fs.existsSync(launchPath)) {
    check('启动.cmd 存在', false, 'tools/staff-ui/ 下没找到');
  } else {
    const buf = fs.readFileSync(launchPath);
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    // 用 GBK 解码，看中文能不能正常出来
    let asGbk = '';
    try { asGbk = buf.toString('latin1'); } catch (e) {}
    // Node 不内置 GBK 解码，用 TextDecoder
    let gbkOk = false;
    let gbkText = '';
    try {
      gbkText = new TextDecoder('gbk').decode(buf);
      gbkOk = /闲鱼上架助手|正在启动/.test(gbkText);
    } catch (e) { gbkOk = false; }
    check('启动.cmd 用 GBK 存（中文能正确解码）', gbkOk && !hasBom,
      hasBom ? '带 UTF-8 BOM（cmd 下会乱码）' : (gbkOk ? '' : 'GBK 解码后读不到中文，可能被存成了 UTF-8'));
    check('启动.cmd 里有 chcp 65001（给 node 日志用）', /chcp\s+65001/i.test(gbkText || ''));
    const idxChcp = (gbkText || '').toLowerCase().indexOf('chcp 65001');
    const idxNode = (gbkText || '').toLowerCase().indexOf('node tools');
    check('chcp 在 node 之前（顺序对了）', idxChcp >= 0 && idxNode > idxChcp,
      (idxChcp < 0 || idxNode < 0) ? '没找到 chcp 或 node 行' : '');
    check('启动.cmd 指向 server.js', /tools\\staff-ui\\server\.js/.test(gbkText || ''));
  }

  // ── ⑦ install-guide.html 里的命令对不对 ──
  //   为什么加（2026-11-13）：_install-guide.html.js 是 JS 模板字符串（反引号），
  //   里面写 `node tools\store-login.js` 时 `\s` 被当转义符 → 生成出来变成
  //   `node toolsstore-login.js`。整份说明里【所有 Windows 路径】都错了，
  //   学员照着敲一个都跑不起来。而程序本身完全正常，所以任何功能测试都发现不了。
  //   这里检查三件事：命令里的脚本在包里存在、路径有反斜杠、没有转义留下的痕迹。
  console.log('\n⑦ install-guide.html 里的命令');
  const guidePath = path.join(root, 'install-guide.html');
  if (!fs.existsSync(guidePath)) {
    check('install-guide.html 存在', false);
  } else {
    const html = fs.readFileSync(guidePath, 'utf8');
    // 提取 <pre><code>...</code></pre> 里的内容
    const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => m[1]);
    check('guide 里有命令块', blocks.length > 0, blocks.length + ' 块');

    // ① 明显被转义吃掉的痕迹
    const tabbed = blocks.filter(b => /\t/.test(b));
    check('没有 TAB 混进命令（\\t 被当转义符的症状）', tabbed.length === 0,
      tabbed.length ? tabbed[0].slice(0, 50).replace(/\t/g, '<TAB>') : '');
    const glued = blocks.filter(b => /tools[a-zA-Z]/.test(b));   // node toolsstore-login.js
    check('没有 tools 和脚本名粘连（\\s 被吃掉的症状）', glued.length === 0,
      glued.length ? glued[0].slice(0, 50) : '');

    // ② 命令里引用的脚本，包里真的有吗
    const missing = [];
    for (const b of blocks) {
      const refs = [...b.matchAll(/(?:node\s+)?(tools\\[\w\u4e00-\u9fa5.-]+\.js)/g)].map(m => m[1]);
      for (const rel of refs) {
        const abs = path.join(achun, rel.replace(/\\/g, path.sep));
        if (!fs.existsSync(abs)) missing.push(rel);
      }
    }
    check('命令引用的脚本都在包里', missing.length === 0,
      missing.length ? '缺: ' + [...new Set(missing)].slice(0, 3).join(', ') : '');

    // ③ 关键路径的完整性（这几个是学员一定会照着敲/点的）
    const mustHave = [
      'xianyu-achun\\tools\\staff-ui\\启动.cmd',
      'node tools\\store-login.js',
      'node tools\\store-init.js',
    ];
    const broken = mustHave.filter(k => html.indexOf(k) < 0);
    check('关键路径完整（反斜杠没被吃）', broken.length === 0,
      broken.length ? '缺: ' + broken.join(' / ') : '');

    // ④ 命令里的 --参数，脚本到底认不认
    //   为什么加（2026-11-13）：install-guide 里写着
    //     node publish-one.js 广州 王嘉尔 --yes    :: 真发
    //   但 publish-one.js 里【根本没有 --yes 这个参数】—— 它把 --yes 当未知参数静默忽略，
    //   而「不加 --dry 就是真发」，学员以为自己在"确认"，其实已经发出去了。
    //   这比代码 bug 危险：代码会报错，文档教错是让人【以为自己是对的】。
    //
    //   判定用宽松匹配：只要那个脚本文件里任何地方出现过 `--xxx` 字样就算支持
    //   （宁可漏报注释里提过的参数，也不要误报真参数）。
    const flagProblems = [];
    const cmds = [];
    for (const b of blocks) {
      for (const line of b.split(/\r?\n/)) {
        const m = line.match(/node\s+((?:tools[\\/])?[\w.-]+\.js)\s+(.+)$/);
        if (m) cmds.push({ script: m[1].replace(/\\/g, '/'), rest: m[2] });
      }
    }
    for (const c of cmds) {
      const sp = path.join(achun, c.script);
      if (!fs.existsSync(sp)) continue;                 // 脚本不存在由上一项报
      const src = fs.readFileSync(sp, 'utf8');
      const known = new Set([...src.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]));
      for (const u of [...c.rest.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1])) {
        if (!known.has(u)) flagProblems.push(c.script + ' 没有 ' + u);
      }
    }
    check('guide 里的 --参数脚本都认', flagProblems.length === 0,
      flagProblems.length ? flagProblems.slice(0, 3).join(' | ') : cmds.length + ' 条命令');

  // ⑦之二 全部学员文档里的参数，脚本到底认不认
  //   为什么加（2026-11-13 第 155 轮）：上面④只查了 install-guide.html，
  //   而学员文档一共有 9 份、100+ 条命令。第 154 轮就是从这个缝里漏出去的：
  //     《学员配置手册》L81 教 `install.cmd -InstallCode=XY-XXXX-XXXX`
  //     但包根的 install.cmd 【不转发参数】（没有 %*），-InstallCode 被静默丢掉；
  //     更狠的是 `install.cmd -DryRun` 会照样跑【正式安装】。
  //   那次是靠读手册偶然发现的，这次把它变成检查。
  //
  //   和④的区别（两处都得查，缺一不可）：
  //     ④   只查 install-guide.html、只查 `node xxx.js --flag`
  //     ⑦之二 查 9 份文档全文，另外查 `install.cmd -Xxx` / `install.ps1 -Xxx`
  //           —— 这两种常写在【行内反引号】里，不在代码块里，④ 的提取方式抓不到。
  console.log('\n⑦之二 全部学员文档里的参数');
  {
    const DOCS_ALL = [
      'install-guide.html',
      '真机首装验证清单.md',
      '发放说明-给学员.md',
      '管理员手册-分发包维护.md',
      '学员安装-给学员DSH.md',
      '学员常见错误速查.md',
      '学员配置手册.md',
      '先看这个-五步上手.html',
      '给学员的一页说明.md',
    ];
    const probs = [];
    let n = 0;

    // ── A) install.cmd / install.ps1 的参数（全文扫，行内代码也算）──
    for (const rel of DOCS_ALL) {
      const p = path.join(achun, rel);
      if (!fs.existsSync(p)) continue;
      let t;
      try { t = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
      for (const m of t.matchAll(/(?:\.\\)?(install\.(?:cmd|ps1))\s+(-{1,2}[A-Za-z][\w-]*)/gi)) {
        n++;
        const which = m[1].toLowerCase();
        const flag = m[2];
        // 占位符不算真参数 —— 第 171 轮踩过：管理员手册第七节【描述这条检查本身】时
        //   写了「`install.cmd -Xxx` / `install.ps1 -Xxx` 也算」，结果被自己查出来了。
        if (/^(X{2,}|Flag|YYY|ZZZ|foo|bar|param|你的参数)$/i.test(flag.replace(/^-+/, ''))) continue;
        if (which === 'install.cmd') {
          const cp = path.join(root, 'install.cmd');
          if (!fs.existsSync(cp)) { probs.push(rel + ': 包根 install.cmd 不在'); continue; }
          const cs = fs.readFileSync(cp, 'utf8');
          const knownCmd = new Set([...cs.matchAll(/(-{1,2}[A-Za-z][\w-]*)/g)].map((x) => x[1]));
          // 要么自己认这个参数，要么把 %* 转发给 install.ps1
          if (!knownCmd.has(flag) && !/%\*/.test(cs)) {
            probs.push(rel + ': install.cmd 不转发也不认 ' + flag);
          }
        } else {
          const pp = path.join(achun, 'install.ps1');
          if (!fs.existsSync(pp)) { probs.push(rel + ': install.ps1 不在'); continue; }
          const ps = fs.readFileSync(pp, 'utf8');
          const name = flag.replace(/^-+/, '');
          if (!new RegExp('\\$' + name + '\\b').test(ps)) {
            probs.push(rel + ': install.ps1 没有参数 ' + flag);
          }
        }
      }
    }
    check('install.cmd / install.ps1 的参数都认', probs.length === 0,
      probs.length ? [...new Set(probs)].slice(0, 3).join(' | ') : n + ' 处');

    // ── B) node xxx.js --flag（9 份文档的代码块，不止 guide）──
    const probs2 = [];
    let n2 = 0;
    for (const rel of DOCS_ALL) {
      const p = path.join(achun, rel);
      if (!fs.existsSync(p)) continue;
      let t;
      try { t = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
      const blocks = p.endsWith('.html')
        ? [...t.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((x) => x[1])
        : [...t.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((x) => x[1]);
      for (const b of blocks) {
        for (const raw of b.split(/\r?\n/)) {
          const m = raw.trim().match(/^node\s+((?:tools[\\/])?[\w.-]+\.js)\s+(.+)$/);
          if (!m) continue;
          n2++;
          const script = m[1].replace(/\\/g, '/');
          const sp = path.join(achun, script);
          if (!fs.existsSync(sp)) continue;          // 文件缺失由⑦组报
          const src = fs.readFileSync(sp, 'utf8');
          const known = new Set([...src.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]));
          const rest = m[2].split('`')[0];            // 行内代码后面可能跟散文
          for (const u of [...rest.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((x) => x[1])) {
            if (!known.has(u)) probs2.push(rel + ': ' + script + ' 没有 ' + u);
          }
        }
      }
    }
    check('9 份文档代码块里的 --参数脚本都认', probs2.length === 0,
      probs2.length ? [...new Set(probs2)].slice(0, 3).join(' | ') : n2 + ' 条命令');
  }

  // ⑦之三 学员文档里的 first-publish 示例【不能用具体城市+明星】
  //   为什么加（第 171-173 轮）：示例写的是【会过期的数据】。
  //   实测：上海 付航 / 杭州 周杰伦 / 杭州 那英 / 上海 周杰伦 —— 大麦上全都没有场次，
  //   而 first-publish 查不到就停在第 2 步（「大麦有X但没Y」），学员照敲必然失败。
  //   publish-one 有大麦海报兜底、不受影响；first-publish（网页那条路）没有。
  //   所以规则：学员文档里 first-publish 的第 2、3 个参数必须是占位符。
  {
    const PLACEHOLDER = new Set(['<城市>', '<明星>', '城市', '明星',
      '<你的店铺名>', '店铺名', '测试店', '冒烟测试店', '冒烟配发店']);
    // 这个列表和上面⑦之二 的 DOCS_ALL 是同一份 —— 但那是在它自己的块里声明的，
    // 出了块就没了。这里再列一次（同步改，别只改一处）。
    const DOCS3 = [
      'install-guide.html', '真机首装验证清单.md', '发放说明-给学员.md',
      '管理员手册-分发包维护.md', '学员安装-给学员DSH.md', '学员常见错误速查.md',
      '学员配置手册.md', '先看这个-五步上手.html', '给学员的一页说明.md',
    ];
    const probs3 = [];
    let n3 = 0;
    for (const rel of DOCS3) {
      const p = path.join(achun, rel);
      if (!fs.existsSync(p)) continue;
      let t;
      try { t = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
      const blocks = p.endsWith('.html')
        ? [...t.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((x) => x[1])
        : [...t.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((x) => x[1]);
      for (const b of blocks) {
        for (const raw of b.split(/\r?\n/)) {
          const line = raw.trim();
          // 必须是真命令（以 node 开头）—— 否则散文里提一句 first-publish.js
          // 也会被当成示例（第 174 轮第一版就误报了速查里的注释行）。
          if (!/^node\s/.test(line) || !/first-publish\.js/.test(line)) continue;
          // 抽出 first-publish.js 后面的前两个参数（跳过 flag）
          const args = [...line.matchAll(/first-publish\.js\s+(?:--[\w-]+=\S+\s+)*(\S+)\s+(\S+)/g)];
          for (const m of args) {
            n3++;
            const bad = [m[1], m[2]].filter((a) =>
              /[\u4e00-\u9fff]/.test(a)          // 含中文
              && !PLACEHOLDER.has(a));           // 且不是占位符
            if (bad.length) probs3.push(rel + ': first-publish 用了具体示例 ' + bad.join(' '));
          }
        }
      }
    }
    check('学员文档里 first-publish 的示例是占位符', probs3.length === 0,
      probs3.length ? [...new Set(probs3)].slice(0, 3).join(' | ') : n3 + ' 处');
  }

    // ⑤ 学员文档里点名的文件，包里必须真的有
    //   为什么加（2026-11-13）：install-guide.html 里写着「包里 xianyu-achun\\学员常见错误速查.md」，
    //   但那个文件【从未被 git 跟踪】—— make-release 从 git ls-files 打包，自然就没有它。
    //   学员按提示去找，找不到。这类问题 ①~④ 都抓不到：它们验的是"包里有的东西对不对"，
    //   不验"该有的东西有没有"。
    {
      // 这两个是【学员自己要建】的（从 .example 复制），本来就不该在包里；
      // 后面几个是产品名 / 被正则截断的残片，不是文件引用。
      // 【第 166 轮扩】把学员文档里【合理提到但包里没有】的都列进来：
      //   · 运行时才有 / 系统自带
      //   · 管理员侧的监控脚本 —— 学员配置手册 4.1 那张表明确标了「❌ 管理员侧」，
      //     第 165 轮加的说明也讲了「这是正常的，不是你装错了」
      //   · 内部文档 —— 给学员的一页说明里是【修改记录】（"原来这里列的…换成…"），
      //     本身就在解释它们不在包里
      const EXPECTED_ABSENT = new Set([
        'service.local.json', 'config.local.json',
        'Node.js', 'node.js', 'local.js',
        'package.json', 'package-lock.json', 'index.html', 'README.md', 'LICENSE',
        'xianyu-latest.zip', '版本.txt', 'state.json', 'files.json',
        'npm.cmd', 'node.exe', 'powershell.exe', 'start.bat', 'install.cmd',
        'store.json', 'xxx.js', 'xianyu-install-<版本>.zip',
        'xianyu-templates.json', 'feishu-webhook.txt', 'ad-plan-create-result.json',
        // 管理员侧监控（学员配置手册 4.1 已标注）
        'ad-window-guard.cmd', 'ad-plan-alert.js', 'ad-daily-report.js',
        'ad-balance-duty.ps1', 'ad-watch-stuck.ps1',
        // 内部文档（一页说明里是修改记录）
        '闲鱼自动化-操作手册.md', '多店铺快速配置方案.md', '中台需求-xianyu-install-config.md',
        // 历史事件里提到的工具
        'workbuddy-run.ps1',
        // 【第 166 轮】打包工具 —— install-guide 尾部有句「本包由 tools/make-release.js +
        //   tools/_build-install-bundle.js 产出」（来源说明，不是让学员去跑）；
        //   selftest-update.js 在配置手册 1.8 的 <details>「开发机用的命令」里（已标注）。
        'make-release.js', '_build-install-bundle.js', 'selftest-update.js',
      ]);

      const inPkg = new Set();
      (function rec(d) {
        for (const name of fs.readdirSync(d)) {
          const p = path.join(d, name);
          const st = fs.statSync(p);
          if (st.isDirectory()) rec(p); else inPkg.add(name);
        }
      })(root);

      // 【第 166 轮扩】原来只查 4 份文档，而学员文档一共 8 份 ——
      //   第 165 轮手工扫出的 11 处里，有 7 处在这 4 份之外（配置手册/一页说明/速查）。
      const docPaths = [
        path.join(root, 'install-guide.html'),
        path.join(root, '先看这个-五步上手.html'),
        path.join(achun, '发放说明-给学员.md'),
        path.join(achun, '学员安装-给学员DSH.md'),
        path.join(achun, '学员配置手册.md'),
        path.join(achun, '给学员的一页说明.md'),
        path.join(achun, '学员常见错误速查.md'),
        path.join(achun, '真机首装验证清单.md'),
      ];

      const gone = [];
      let refCount = 0;
      for (const dp of docPaths) {
        if (!fs.existsSync(dp)) continue;
        const t = fs.readFileSync(dp, 'utf8');
        // 【第 166 轮】原来只匹配 .md/.cmd/.ps1/.html —— 文档里提的 .js/.json 完全不查。
        //   第 165 轮手工扫学员文档时，`ad-plan-alert.js` 被我在表格里标成「见包内」
        //   而它其实不在包里，就是这条漏掉的（它是 .js）。
        // ⚠️ json 必须排在 js 前面 —— 否则 `service.local.json` 会被先匹配成
        //   `service.local.js`（正则按顺序试），报一堆假的「缺 .js」。第 166 轮踩过。
        const refs = [...t.matchAll(/([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*\.(?:md|cmd|ps1|html|json|js))/g)]
          .map((m) => m[1])
          .filter((x) => !EXPECTED_ABSENT.has(x));
        for (const r of new Set(refs)) {
          refCount++;
          if (!inPkg.has(r)) gone.push(path.basename(dp) + ' → ' + r);
        }
      }
      const uniqGone = [...new Set(gone)];
      check('学员文档引用的文件都在包里', uniqGone.length === 0,
        uniqGone.length ? uniqGone.slice(0, 3).join(' | ') : refCount + ' 个引用');
    }

    // ⑥ 所有学员文档里的 node 命令，脚本存在 + 参数脚本认
    //   为什么加（2026-11-13）：⑦ 的前五项只查 install-guide.html 一份。
    //   可学员手上还有另外四份文档（真机清单 / 发放说明 / 任务书 / 错误速查），
    //   那里面也有大量 `node tools\xxx.js --flag`。哪份写错了都是同一个后果：
    //   学员照着敲，跑不起来，而且他不知道自己敲错还是程序坏了。
    //   实测（第 104 轮）：六份文档共 43 行命令，16 条 node 脚本全部存在、参数全对。
    {
      const DOCS = [
        'install-guide.html',
        'xianyu-achun/真机首装验证清单.md',
        'xianyu-achun/发放说明-给学员.md',
        'xianyu-achun/管理员手册-分发包维护.md',
        'xianyu-achun/学员安装-给学员DSH.md',
        'xianyu-achun/学员常见错误速查.md',
        // 【2026-11-13 加】学员配置手册 600 行、25 条命令，是最大的学员文档，
        //   之前没进这个名单（第 115 轮手工验过一次全对，现在让它自动验）。
        'xianyu-achun/学员配置手册.md',
        // 一页纸和它的 md 版
        'xianyu-achun/先看这个-五步上手.html',
        'xianyu-achun/给学员的一页说明.md',
      ];
      const badCmds = [];
      let cmdCount = 0;
      // 这几个是【维护者文档里提到、但不在 xianyu-achun 包里】的：
      //   _build-install-bundle.js —— 打包脚本，只在开发机上有（make-release 不把它发出去）
      //   make-release.js —— 同上，第 114 轮也排掉了（学员用不到，里面有本机路径）
      //   server.js —— 在 xianyu-playwright-service 里，是另一个仓库的入口
      // 它们在管理员手册里出现是正常的，不该报"缺"。
      const NOT_IN_ACHUN = new Set([
        'tools/_build-install-bundle.js',
        'tools/make-release.js',
        'server.js',
        // 【2026-11-13 第 134 轮加】这两个是【发包工具】，只在打包机上跑：
        //   _sync-public.js    —— 把代码同步到公开仓
        //   publish-package.js —— 把 zip 发到 gh-pages（第 134 轮新加的）
        // 管理员手册里写它们是对的（那是给维护者看的）。
        'tools/_sync-public.js',
        'tools/publish-package.js',
        // 【2026-11-13 第 152 轮加】selftest-update.js 不进包（开发机的回归测试，
        //   要 git + 老板的店档案），但《学员配置手册》1.8 节里在
        //   <details>「开发机用的命令（学员可以忽略）」中提到了它 —— 那段是给
        //   维护者看的，提到是对的，不该报"缺"。
        'tools/selftest-update.js',
        'tools/regression-check.js',
        'tools/scan-package.js',
        // 【第 153 轮】打包后手动跑的工具（约 84 秒），管理员手册第六节提到它
        'tools/smoke-scripts.js',
      ]);
      for (const rel of DOCS) {
        const dp = path.join(root, rel.split('/').join(path.sep));
        if (!fs.existsSync(dp)) continue;
        const t = fs.readFileSync(dp, 'utf8');
        // 抓 node <脚本> <后面到行尾>
        for (const m of t.matchAll(/node\s+((?:tools[\\/])?[\w.\-]+\.js)([^\r\n`]*)/g)) {
          const script = m[1].split('\\').join('/');
          const rest = m[2] || '';
          // 只跳过"示例脚本名"，不因为带占位符就整条跳过 ——
          //   学员文档里绝大多数命令都带 <店铺名> 这类占位符，
          //   但【参数】部分仍然是真的，写错了照样跑不起来（第 104 轮反向验证踩过：
          //   因为整条跳过，往文档里塞 --fakeflag=1 都抓不到）。
          if (/xxx|example/i.test(script)) continue;
          if (NOT_IN_ACHUN.has(script)) continue;      // 见上面注释
          cmdCount++;
          const sp = path.join(achun, script);
          if (!fs.existsSync(sp)) {
            badCmds.push(path.basename(rel) + ': 缺 ' + script);
            continue;
          }
          // 参数：脚本文件里出现过这个 --flag 就算认
          const src = fs.readFileSync(sp, 'utf8');
          for (const f of rest.matchAll(/(--[a-z][a-z0-9-]*)/g)) {
            if (src.indexOf(f[1]) < 0) {
              badCmds.push(path.basename(rel) + ': ' + script + ' 没有 ' + f[1]);
            }
          }
        }
      }
      const uniqBad = [...new Set(badCmds)];
      check('六份文档里的 node 命令都能跑', uniqBad.length === 0,
        uniqBad.length ? uniqBad.slice(0, 3).join(' | ') : cmdCount + ' 条命令');

      // ⑦之五 文档里写的「N 条文档命令」要等于上面数出来的 cmdCount
      //   为什么加（第 214 轮）：第213 轮发现文档写 129、实际 131 ——
      //   加检查/改文档时没人同步这个数。它不是「检查项数」（那两个已有人守），
      //   是【命令条数】，和 cmdCount 是同一个来源，这里直接比。
      {
        const probs5 = [];
        for (const rel of ['交付状态-2026-11-13.md', '管理员手册-分发包维护.md']) {
          const p = path.join(achun, rel);
          if (!fs.existsSync(p)) { probs5.push('找不到 ' + rel); continue; }
          const rep = fs.readFileSync(p, 'utf8');
          const m = rep.match(/(\d+)\s*条文档命令|（\*\*(\d+) 条命令\*\*）/);
          const declared = m ? Number(m[1] || m[2]) : null;
          if (declared === null) probs5.push(rel + ' 里没写命令条数');
          else if (declared !== cmdCount) probs5.push(rel + ' 写 ' + declared + '、实际 ' + cmdCount);
        }
        check('文档写的命令条数和实际一致', probs5.length === 0,
          probs5.length ? probs5.slice(0, 2).join(' | ') : cmdCount + ' 条对上');
      }

      // ⑦之四 行内反引号里提到的 node 脚本也要在
      //   为什么加（第 204 轮）：上面的 ⑦ 只扫【代码块】里的命令，
      //   而「跑 `node tools/foo.js`」这种写在行内反引号里的，它抓不到。
      //   实测（第 204 轮）全包扫出157 处提及、24 处找不到 —— 逐条核完：
      //   22 处是管理员手册教维护者的工具（在 NOT_IN_ACHUN）、
      //   1 处是 dev-only 的 details 段、1 处是占位符 xxx.js。
      //   也就是说【目前没有真问题】，但这个口子得堵上：以后往学员文档里
      //   写一句行内引用而那个脚本被排掉了，这条就会红。
      {
        const probsInline = [];
        let nInline = 0;
        for (const rel of DOCS) {
          // ⚠️ DOCS 里的路径是相对【包根】的（'xianyu-achun/xxx.md'），
          //    不是相对 achun —— 第 204 轮第一版写成 join(achun, rel)，
          //    拼出 xianyu-achun/xianyu-achun/xxx.md，全部找不到 → 计数 0。
          const p = path.join(root, rel);
          if (!fs.existsSync(p)) continue;
          let t;
          try { t = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
          const clean = t.replace(/<!--[\s\S]*?-->/g, '');
          for (const m of clean.matchAll(/node\s+((?:\.\/)?(?:tools[\\\/])?[\w\u4e00-\u9fa5.-]+\.js)/g)) {
            nInline++;
            const spec = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
            const base = path.basename(spec);
            if (base === 'xxx.js') continue;                       // 文档里的占位符
            const inPkg = fs.existsSync(path.join(achun, spec))
              || fs.existsSync(path.join(achun, 'tools', base))
              || fs.existsSync(path.join(achun, base));
            if (inPkg) continue;
            if (NOT_IN_ACHUN.has(spec) || NOT_IN_ACHUN.has('tools/' + base)) continue;
            probsInline.push(rel + ' → ' + m[1]);
          }
        }
        check('行内提到的 node 脚本都在包里（或标了维护者专用）', probsInline.length === 0,
          probsInline.length ? [...new Set(probsInline)].slice(0, 3).join(' | ') : nInline + ' 处提及');
      }
    }
  }

  // ── ⑧ 扩展代码（monitor）的语法检查 ──
  //   为什么单独一组（2026-11-13）：xianyu-monitor 是 Chrome 扩展，里面的 js 是
  //   【浏览器代码】—— 有 importScripts、顶层 await、chrome.* API。
  //   用 `node -c`（CommonJS）检查会误报；必须复制成 .mjs 用 `node --check`。
  //
  //   但那天的教训是：**误报里也藏着真错**。background.js 报
  //     SyntaxError: await is only valid in async functions
  //   —— 这不是"浏览器专有语法"，是语法层的，Chrome 同样会拒。
  //   实际确认：PD_STOP_PUBLISH 分支的 await 没包 async IIFE，
  //   而外层 onMessage.addListener 不是 async → 整个 background.js 不加载。
  //   它活了三个多月没人发现，因为发布主流程走 content script，不依赖 background。
  console.log('\n⑧ xianyu-monitor 的浏览器代码语法');
  const monDir = path.join(root, 'xianyu-monitor');
  if (!fs.existsSync(monDir)) {
    check('xianyu-monitor 目录存在', false);
  } else {
    const jsFiles = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        if (/\.js$/i.test(name)) jsFiles.push(p);
      }
    })(monDir);

    const synBad = [];
    const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-syn-'));
    for (const f of jsFiles) {
      const dst = path.join(tmpd, path.basename(f).replace(/\.js$/i, '') + '_' + Math.random().toString(36).slice(2, 8) + '.mjs');
      // 复制失败就跳过这个文件（实测遇到过一次 ENOENT：源明明在，copyfile 报错）。
      // 检查脚本不该因为一个文件读不到就整体崩掉 —— 跳过它、继续查其余的，比全崩有用。
      try { fs.copyFileSync(f, dst); } catch (e) { continue; }
      try {
        execFileSync('node', ['--check', dst], { stdio: 'pipe', timeout: 30000 });
      } catch (e) {
        // 只报语法层错误；importScripts / chrome is not defined 这类是运行时，不算
        const msg = String((e.stderr || '') + (e.stdout || ''));
        if (/SyntaxError/.test(msg)) {
          const firstLine = (msg.split(/\r?\n/).find(l => /SyntaxError/.test(l)) || '').trim();
          synBad.push(path.basename(f) + ': ' + firstLine);
        }
      }
    }
    try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) {}

    check('monitor 的 js 没有语法错误（按 ES module 解析）', synBad.length === 0,
      synBad.length ? synBad.slice(0, 2).join(' | ') : jsFiles.length + ' 个文件');
  }

  // ── ⑨ xianyu-achun 自己的 Node 代码语法 ──
  //   为什么加（2026-11-13）：前面几十轮一直在验"装得上吗、文档对不对"，
  //   但从没验过【包里那 293 个 js 文件本身有没有语法错】。
  //   一个语法错 = 学员点某个按钮时 `SyntaxError: Unexpected token`，
  //   而且报错位置在文件里，学员完全看不懂。
  //   achun 是纯 Node 工具集（CommonJS），用 `node -c` 就够。
  console.log('\n⑨ xianyu-achun 的 Node 代码语法');
  {
    // 【2026-11-13 优化】原来这里对每个文件启动一次 `node -c`，293 个文件 = 293 次进程启动，
    //   占掉全部检查时间的一半以上（总耗时 127 秒）。
    //   改用 _syntax-check-all.js 在单进程里用 vm.Script 解析所有文件：1.3 秒，快 80 倍。
    //
    // ⚠️【2026-11-13 修】脚本路径原来用的是 __dirname（= 开发机那份），
    //   于是【包里的那份丢了也测不出来】—— 第 88 轮就是这么漏的：
    //   gitignore + make-release 两道规则把 _syntax-check-all.js 挡在外面，
    //   开发机上一切正常，包里却缺文件。
    //   现在改成用【包里那份】，并且先检查它在不在。
    const checkerInPkg = path.join(achun, 'tools', '_syntax-check-all.js');
    const checkerExists = fs.existsSync(checkerInPkg);
    check('包内有 _syntax-check-all.js（自检自己要用的）', checkerExists,
      checkerExists ? '' : '包里缺这个脚本，下面那项测不了');

    if (checkerExists) {
      let ok = false;
      let detail = '';
      try {
        execFileSync('node', [checkerInPkg, '--json', achun],
          { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
        ok = true;
        detail = '全部通过';
      } catch (e) {
        const raw = String(e.stdout || '');
        try {
          const j = JSON.parse(raw);
          if (j && Array.isArray(j.bad) && j.bad.length) {
            detail = j.bad.slice(0, 2)
              .map((b) => path.basename(b.file) + ': ' + b.err)
              .join(' | ');
          } else {
            detail = '（解析不出错误详情）';
          }
        } catch (e2) {
          detail = raw.split('\n').slice(0, 2).join(' ').slice(0, 120) || '执行失败';
        }
        ok = false;
      }
      check('achun 的 js 全部语法正确', ok, ok ? '' : detail);
    }
  }

  // ── ⑩ 所有 HTML 里的内联 <script> ──
  //   为什么加（2026-11-13）：学员天天用的 staff-ui 页面（ui.html）有 11.7 KB 内联 JS。
  //   一个语法错 = 打开网页一片空白，浏览器控制台里的报错学员根本不会去看。
  //   内联脚本不在任何 .js 文件里，所以 ⑧⑨ 两组都覆盖不到。
  console.log('\n⑩ HTML 里的内联脚本语法');
  {
    const htmlFiles = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        if (/\.html$/i.test(name)) htmlFiles.push(p);
      }
    })(root);

    let totalBlocks = 0;
    const htmlBad = [];
    const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-inl-'));
    let bi = 0;
    for (const f of htmlFiles) {
      const html = fs.readFileSync(f, 'utf8');
      const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
      for (const m of matches) {
        const js = m[1];
        if (!js.trim()) continue;
        totalBlocks++;
        const dst = path.join(tmpd, 'blk' + (++bi) + '.mjs');
        fs.writeFileSync(dst, js, 'utf8');
        try {
          execFileSync('node', ['--check', dst], { stdio: 'pipe', timeout: 20000 });
        } catch (e) {
          const msg = String((e.stderr || '') + (e.stdout || ''));
          const first = (msg.split(/\r?\n/).find(l => /SyntaxError/.test(l)) || '').trim();
          if (first) htmlBad.push(path.relative(root, f).replace(/\\/g, '/') + ': ' + first.slice(0, 70));
        }
      }
    }
    try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) {}

    check('HTML 内联脚本没有语法错误', htmlBad.length === 0,
      htmlBad.length ? htmlBad.slice(0, 2).join(' | ') : htmlFiles.length + ' 个 HTML / ' + totalBlocks + ' 块脚本');
  }

  // ── ⑪ staff-ui 页面的 id 引用完整性 ──
  //   为什么加（2026-11-13）：语法对了不等于运行时不炸。
  //   ui.html 里 JS 通过 getElementById('x') / val('x') 拿元素，
  //   如果 HTML 里那个 id 不存在 → 返回 null → 调用 .value 时抛
  //     TypeError: Cannot read properties of null
  //   学员看到的是「点了按钮没反应」，控制台里才有这句。
  //   这条检查是我用 ego 真的打开页面、连续调 refreshOnboard/refreshStoreLabel 之后
  //   想到的：那一步能验到运行时，但它依赖浏览器环境，进不了这个脚本；
  //   而「引用的 id 存不存在」是纯静态就能查的，覆盖了同一类故障。
  console.log('\n⑪ staff-ui 页面的 id 引用');
  {
    const uiPath = path.join(achun, 'tools', 'staff-ui', 'ui.html');
    if (!fs.existsSync(uiPath)) {
      check('staff-ui/ui.html 存在', false);
    } else {
      const html = fs.readFileSync(uiPath, 'utf8');
      const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
      const refs = new Set();
      for (const m of html.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
      for (const m of html.matchAll(/\bval\('([^']+)'\)/g)) refs.add(m[1]);
      for (const m of html.matchAll(/querySelector\('#([^']+)'\)/g)) refs.add(m[1]);

      const missingIds = [...refs].filter(x => !ids.has(x));
      check('JS 引用的 id 在 HTML 里都存在', missingIds.length === 0,
        missingIds.length ? '缺: ' + missingIds.slice(0, 4).join(', ')
                          : ids.size + ' 个 id / ' + refs.size + ' 个引用');
    }
  }

  // ── ⑫ 前端 ↔ 后端的跨文件一致性 ──
  //   两件（2026-11-13 加）：
  //   ① 前端 apiFetch('/api/xxx') 调的接口，server.js 里有没有实现？
  //      没实现 = 点了按钮一直转圈或 404，学员以为是"卡住了"。
  //   ② onclick="xxx()" 里的函数，ui.html 的 js 里有没有定义？
  //      没定义 = ReferenceError，点了没反应。
  //   这两条都是【跨文件】的 —— 单个文件语法全对，组合起来才出问题。
  console.log('\n⑫ 前端 ↔ 后端一致性');
  {
    const uiPath = path.join(achun, 'tools', 'staff-ui', 'ui.html');
    const srvPath = path.join(achun, 'tools', 'staff-ui', 'server.js');
    if (!fs.existsSync(uiPath) || !fs.existsSync(srvPath)) {
      check('staff-ui 的前后端文件都存在', false);
    } else {
      const ui = fs.readFileSync(uiPath, 'utf8');
      const srv = fs.readFileSync(srvPath, 'utf8');

      // ① 接口
      const called = new Set([...ui.matchAll(/apiFetch\('(\/api\/[^'?]+)/g)].map(m => m[1]));
      // 后端：把 server.js 里出现的所有 /api/xxx 字面量都算作"已实现"
      //   （不管它是 p === '/api/x' 还是 p.match(/^\/api\/x\//)，
      //    提取字面量比解析路由语法可靠 —— 第一版想匹配 p.match 的正则，转义层级搞错了）
      // 先把源码里的正则转义 \/ 还原成 /，再提取 —— 否则
      //   p.match(/^\/api\/task\/(\d+)$/) 里的 /api/task 一个都提不到
      const srvNorm = srv.replace(/\\\//g, '/');
      const defined = new Set([...srvNorm.matchAll(/\/api\/[a-z][a-z0-9-]*/g)].map(m => m[0]));
      const noImpl = [...called].filter(c => {
        if (defined.has(c)) return false;
        // 动态路由：前端写 /api/task/（带尾斜杠），后端有 /api/task
        if (c.endsWith('/')) return !defined.has(c.slice(0, -1));
        return true;
      });
      check('前端调的接口后端都实现了', noImpl.length === 0,
        noImpl.length ? '未实现: ' + noImpl.join(', ') : called.size + ' 个接口');

      // ② onclick 里的函数
      const onclickFns = new Set(
        [...ui.matchAll(/on(?:click|change|input)="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1])
      );
      // 在 ui.html 的 js 里找 function xxx( / const xxx = / var xxx =
      const definedFns = new Set();
      for (const m of ui.matchAll(/(?:function\s+|const\s+|let\s+|var\s+)([a-zA-Z_$][\w$]*)\s*(?:\(|=)/g)) definedFns.add(m[1]);
      const missingFns = [...onclickFns].filter(f => !definedFns.has(f));
      check('onclick 里的函数都有定义', missingFns.length === 0,
        missingFns.length ? '未定义: ' + missingFns.join(', ') : onclickFns.size + ' 个事件处理函数');
    }

    // ⑦ 「一句话输入」的解析 —— 目标里那句【输入城市明星】的字面路径
    //   为什么加（第 191 轮）：目标是「输入:城市明星，就能上架」。
    //   这条路径全在 ui.html 的 body('publish') 里：
    //     · 先按 空格/逗号/顿号/斜杠 切，≥2 段 → city=第一段，star=其余拼起来
    //     · 只有一段 → 拿 CITIES 列表前缀匹配（连写「广州王嘉尔」也认）
    //     · 都切不出来 → star 为空，前端 go() 会拦下并显示「请先填完整：star」
    //   实测（第 191 轮）10 个用例全过（4 种分隔符 + 连写 + 多词 + 边界）。
    //   这里静态核三件事：入口在、城市表够大、切分规则没被改坏。
    {
      const ui = fs.readFileSync(path.join(achun, 'tools', 'staff-ui', 'ui.html'), 'utf8');
      const probs7 = [];
      if (!/id="pub-oneline"/.test(ui)) probs7.push('找不到「一句话输入」框 id=pub-oneline');
      const cm = ui.match(/const CITIES = \[([\s\S]*?)\];/);
      const nCity = cm ? [...cm[1].matchAll(/'([^']+)'/g)].length : 0;
      if (nCity < 30) probs7.push('CITIES 只有 ' + nCity + ' 个城市（连写切分靠它，至少要 30）');
      // 用 includes 而不是正则 —— 源码里那行本身带 / 和 \，转义两层容易写错（第 191 轮踩过）
      if (!ui.includes('one.split(/[') || !ui.includes('\\s,，、\\/]+/)')) {
        probs7.push('一句话的分隔符切分规则被改了');
      }
      if (!ui.includes('one.startsWith(c)')) probs7.push('连写靠城市名前缀切的逻辑没了');
      if (!/请先填完整：/.test(ui)) probs7.push('没填全时的中文提示没了');
      check('一句话输入能解析（分隔符 + 连写 + 城市表）', probs7.length === 0,
        probs7.length ? probs7.slice(0, 3).join(' | ') : nCity + ' 个城市 / 4 种分隔符 / 连写可切');
    }

    // ⑨ 服务端 needed ←→ 前端 body() 字段契约
    //   为什么加（第 202 轮）：服务端 `for (const k of needed) if (!body[k]) 400`，
    //   前端 `if (!v) 请先填完整：k`。两边各写一份必填清单，改一边忘另一边
    //   就会出现【前端放行、服务端 400】或【前端拦死、永远发不出去】。
    //   第 200 轮踩过同源的坑：base 默认空串被前端必填拦下，而服务端根本不需要它。
    //   这里核：服务端要的每个字段，前端 body() 必须发。
    {
      const srvSrc = fs.readFileSync(path.join(achun, 'tools', 'staff-ui', 'server.js'), 'utf8');
      const uiSrc = fs.readFileSync(path.join(achun, 'tools', 'staff-ui', 'ui.html'), 'utf8');
      const probs9 = [];
      const needed = {};
      const needLine = srvSrc.split(/\r?\n/).find((l) => l.includes('const needed'));
      if (!needLine) probs9.push('服务端找不到 const needed');
      else {
        for (const m of needLine.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
          needed[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        }
      }
      const bodies = {};
      for (const m of uiSrc.matchAll(/if \(k === '(\w+)'\) return \{([^}]+)\};/g)) {
        bodies[m[1]] = [...m[2].matchAll(/(\w+):/g)].map((x) => x[1]).filter((x) => x !== 'kind');
      }
      // publish 是多行，且 city/star 是【简写属性】——只匹配 `k:` 会漏掉它们
      const mp = uiSrc.match(/if \(k === 'publish'\) \{[\s\S]*?return \{ kind: k, city, star,[\s\S]*?\};/);
      if (mp) {
        const keys = new Set(['city', 'star']);
        for (const m of mp[0].matchAll(/(\w+):/g)) if (m[1] !== 'kind') keys.add(m[1]);
        bodies.publish = [...keys];
      }
      // login 是内联发的（doLogin 里 JSON.stringify({kind:'login', store:name})）
      if (/kind: 'login', store:/.test(uiSrc)) bodies.login = ['store'];

      for (const [kind, req] of Object.entries(needed)) {
        const sent = bodies[kind];
        if (!sent) { probs9.push(kind + ' 前端没有发它的 body()'); continue; }
        const miss = req.filter((r) => !sent.includes(r));
        if (miss.length) probs9.push(kind + ' 前端没发必填的 ' + miss.join(','));
      }
      check('前端发的字段覆盖服务端必填', probs9.length === 0,
        probs9.length ? probs9.slice(0, 3).join(' | ') : Object.keys(needed).length + ' 个动作全对上');
    }
    // 【第 205 轮试过又撤掉】想在这儿补一个「报告里的回归项数也要对」的检查
    //   （回归127 只守自检项数，报告里的「回归 32/32」实际是43，没人管）。
    //   做法是 execFileSync 跑 tools/regression-check.js 数 ✅ —— 但
    //   `regression-check.js`【不在包里】（TOOLS_ALLOWED 没它），而
    //   `verify-student-view.js`【在包里】，于是 check-refs 立刻报：
    //       tools/verify-student-view.js → tools/regression-check.js 不在包里
    //   而且真在学员机上跑也会因为缺文件而误报失败。
    //   静态数也不行：regression 用 ok()/bad() 辅助函数 + 循环，
    //   源码里 ok(/bad( 只有 31 处，实际输出 43 项，差 12 超过 ±8 容差。
    //   → 这个检查只能由【跑一次 regression】来验，那就放在发包的人身上，
    //     不放进每轮都跑的 verify。
    //   （自检项数那条挪到 ⑯ 汇总前了 —— 那时 results.length 才是真数。）
  }

  // ── ⑬ 学员独立入口文件 ──
  //   为什么加（2026-11-13）：上面 ⑤ 只能抓「文档 A 引用了文件 B，但 B 不在包里」。
  //   可这几个文件是【独立入口】—— 学员直接从群里点开、或者双击，
  //   没有任何别的文档引用它们。哪天从包里丢了，⑤ 发现不了，
  //   学员只会说「那个说明找不到」。
  console.log('\n⑬ 学员独立入口文件');
  {
    const REQUIRED_DOCS = [
      { rel: 'xianyu-achun/学员五步上手.html', why: '贴群里的一页纸' },
      { rel: 'xianyu-achun/发放说明-给学员.md', why: '查阅手册' },
      { rel: 'xianyu-achun/学员安装-给学员DSH.md', why: 'AI agent 任务书' },
      { rel: 'xianyu-achun/学员常见错误速查.md', why: '按报错关键词搜的那份' },
      { rel: 'install-guide.html', why: '包根层图文安装说明' },
      { rel: '先看这个-五步上手.html', why: '包根层一页纸（解压第一眼就看到的）' },
    ];
    const missingDocs = [];
    for (const d of REQUIRED_DOCS) {
      const p = path.join(root, d.rel.split('/').join(path.sep));
      let ok = false;
      try { ok = fs.existsSync(p) && fs.statSync(p).size >= 200; } catch (e) { ok = false; }
      if (!ok) missingDocs.push(path.basename(d.rel));
    }
    check('六个学员入口文件都在包里且非空', missingDocs.length === 0,
      missingDocs.length ? missingDocs.join(', ') : REQUIRED_DOCS.length + ' 个文件');
  }

  // ── ⑭ 包里不该有老板的脚本 ──
  //   为什么加（2026-11-13，第 108-109 轮）：这是【反向检查】。
  //   前面 ①~⑬ 全在验"该有的东西在不在"，没有一条验"不该有的东西在不在"。
  //   实测：包里曾带着「暂停发布.cmd」「ad-balance-duty.ps1」「wecom-send.ps1」这些东西，
  //   学员误点「暂停发布.cmd」= 自动发布整个停掉，而且这些脚本里写死的都是 D:\DSH\achun。
  //   现在把包里的 .cmd/.bat/.ps1 全列出来，只允许白名单里的存在。
  // ⑬之二 【必须在包里】的清单 —— 防「排除规则排多了」
  //   为什么加（第 182 轮）：到现在已经排掉 943 个文件（25 批规则）。
  //   排除是黑名单，写错一条 regex 就会把学员要用的东西排掉，
  //   而且【语法上完全合法、跑起来才发现】。
  //   这份清单是【人工筛过的关键路径】，每加一条排除规则之前先跑这个。
  console.log('\n⑬之二 必须在包里的关键文件');
  {
    const MUST = [
      // 包根
      'install.cmd', 'install-guide.html', '先看这个-五步上手.html',
      // xianyu-achun 入口与核心
      'xianyu-achun/install.ps1', 'xianyu-achun/run-node.cmd', 'xianyu-achun/体检.cmd',
      'xianyu-achun/config.local.json.example', 'xianyu-achun/service.local.json.example',
      'xianyu-achun/PACKAGE-README.txt', 'xianyu-achun/publish-one.js',
      // 学员文档
      'xianyu-achun/学员配置手册.md', 'xianyu-achun/发放说明-给学员.md',
      'xianyu-achun/真机首装验证清单.md', 'xianyu-achun/学员常见错误速查.md',
      'xianyu-achun/给学员的一页说明.md', 'xianyu-achun/学员安装-给学员DSH.md',
      // 模板
      'xianyu-achun/stores/_template.json', 'xianyu-achun/publish-groups/_template.json',
      // 网页入口
      'xianyu-achun/tools/staff-ui/启动.cmd', 'xianyu-achun/tools/staff-ui/server.js',
      'xianyu-achun/tools/staff-ui/ui.html',
      // 学员工具
      'xianyu-achun/tools/store-wizard.js', 'xianyu-achun/tools/healthcheck.js',
      'xianyu-achun/tools/store-ready.js', 'xianyu-achun/tools/store-login.js',
      'xianyu-achun/tools/first-publish.js', 'xianyu-achun/tools/verify-published.js',
      'xianyu-achun/tools/list-onsale.js', 'xianyu-achun/tools/ad-review.js',
      'xianyu-achun/tools/ad-status.js', 'xianyu-achun/tools/install-tasks.js',
      'xianyu-achun/tools/ad-plan-create.js', 'xianyu-achun/tools/store-new.js',
      // 【第 203 轮】更新脚本 —— 手册 1.8 A 方案（推荐路径）就是它：
      //   `node tools/update.js --apply --from=<地址>`。不在包里的话学员只能走 B
      //   手动四步，而手册把 A 写在最前面。
      'xianyu-achun/tools/update.js',
    'xianyu-achun/tools/学员回报.js',   // 第242轮：真机验证一键收集（清单步骤10 让学员跑它）
      // 核心库
      'xianyu-achun/lib/crash.js', 'xianyu-achun/lib/env.js',
      'xianyu-achun/lib/store-profile.js', 'xianyu-achun/lib/agent.js',
      'xianyu-achun/lib/title.js', 'xianyu-achun/lib/http.js',
      'xianyu-achun/lib/mtop.js', 'xianyu-achun/lib/museav.js',
      // 服务仓
      'xianyu-playwright-service/package.json', 'xianyu-playwright-service/package-lock.json',
      'xianyu-playwright-service/start.bat', 'xianyu-playwright-service/server.js',
      'xianyu-monitor/native_host.bat', 'xianyu-monitor/一键安装.bat',
    ];
    const miss = MUST.filter((f) => !fs.existsSync(path.join(root, f)));
    check('必须在包里的关键文件都在', miss.length === 0,
      miss.length ? miss.slice(0, 4).join(' | ') : MUST.length + ' 个');
  }

  // ⑬之三 更新安全：手册 1.8 A 方案的四个承诺，静态核一遍
  //   为什么加（第 188 轮）：A 方案说 `update.js --from` 「只换代码、四样数据自动保住」。
  //   这四条是【手册写给学员的承诺】，一旦 update.js 的 KEEP_PREFIX 改动、
  //   或某个数据文件被 git 跟踪了，承诺就失效 —— 而学员只有在【更新那一次】才发现。
  //   实测（第 187 轮）过一遍要 30+ 秒，放不进每轮；改成静态核这几条关键条件。
  console.log('\n⑬之三 更新安全（手册 1.8 A 方案的承诺）');
  {
    const probs = [];
    const upPath = path.join(achun, 'tools', 'update.js');
    if (!fs.existsSync(upPath)) {
      probs.push('tools/update.js 不在包里');
    } else {
      const src = fs.readFileSync(upPath, 'utf8');
      const m = src.match(/const KEEP_PREFIX = \[([\s\S]*?)\n\];/);
      const keep = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
      // ① 保留名单必须含这些
      const need = ['stores/', 'config.local.json', 'publish-assets/', 'publish-out/',
        'playwright-service/service.local.json'];
      for (const n of need) {
        if (!keep.includes(n)) probs.push('KEEP_PREFIX 缺 ' + n + '（手册承诺会保住它）');
      }
      // ② KEEP_EXCEPT 必须只放行模板（整目录保留 + 模板跟着更新）
      if (!/KEEP_EXCEPT\s*=\s*\[\s*'stores\/_template\.json'/.test(src)) {
        probs.push('KEEP_EXCEPT 不再是 stores/_template.json（模板该跟着更新）');
      }
    }
    // ③ 登录态不能被 git 跟踪（跟踪了就会进更新清单 → 被覆盖）
    try {
      const tracked = execFileSync('git', ['-C', path.join(achun, '..'), 'ls-files', 'browser-profiles'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (tracked) probs.push('browser-profiles 被 git 跟踪了（更新会覆盖登录态）');
    } catch (e) { /* 包里没 .git 是正常的（学员包不带） */ }
    // ④ 学员的方案文件不该被跟踪（只有 _template.json 能进清单）
    try {
      const pg = execFileSync('git', ['-C', path.join(achun, '..'), 'ls-files', 'publish-groups'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/).filter(Boolean);
      const bad = pg.filter((f) => !/_template\.json$/.test(f));
      if (bad.length) probs.push('publish-groups 里被跟踪的非模板文件：' + bad.slice(0, 2).join(', '));
    } catch (e) { /* 同上 */ }

    check('更新会保住学员数据（KEEP_PREFIX + 未跟踪）', probs.length === 0,
      probs.length ? probs.slice(0, 3).join(' | ') : '保留名单 5 项 + 登录态/方案文件未跟踪');
  }

  // ⑬之四 安装配置不覆盖学员已填的值（配置手册 1.4 的承诺）
  //   为什么加（第 236 轮）：手册写着「它永远不会动你的配置」「不覆盖已有非空配置」，
  //   但 install-config.js --derive --apply 会不会真把学员手填的 apiKey/_note 冲掉，
  //   没人守。第236 轮实测过（带 port/apiKey/machine._note 的配置跑完全在），
  //   这里把它固化成检查：把 install-config.js + lib/ 拷到临时目录，
  //   写一份带自定义值的 config.local.json，跑 --derive --apply，再逐项核。
  console.log('\n⑬之四 安装配置不覆盖已有值（配置手册 1.4 的承诺）');
  {
    const probs4 = [];
    try {
      const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-icfg-'));
      fs.mkdirSync(path.join(fx, 'tools'), { recursive: true });
      fs.cpSync(path.join(achun, 'lib'), path.join(fx, 'lib'), { recursive: true });
      fs.copyFileSync(path.join(achun, 'tools', 'install-config.js'), path.join(fx, 'tools', 'install-config.js'));
      fs.writeFileSync(path.join(fx, 'config.local.json'),
        JSON.stringify({ port: 18083, service: { apiKey: 'MY_KEY_XYZ' }, _note: '学员手填的' }));
      const r = require('child_process').spawnSync(process.execPath,
        ['tools/install-config.js', '--derive', '--apply'],
        { cwd: fx, encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) {
        probs4.push('install-config 退出码 ' + r.status + '：' + String(r.stderr || r.stdout || '').split('\n')[0]);
      } else {
        const after = fs.readFileSync(path.join(fx, 'config.local.json'), 'utf8');
        if (!after.includes('MY_KEY_XYZ')) probs4.push('service.apiKey 被冲掉了');
        if (!after.includes('学员手填的')) probs4.push('_note 被冲掉了');
        if (!/"port"\s*:\s*18083/.test(after)) probs4.push('port 被冲掉了');
        if (!after.includes('"paths"')) probs4.push('paths 没推导出来');
      }
      fs.rmSync(fx, { recursive: true, force: true });
    } catch (e) { probs4.push('跑 install-config 出错: ' + e.message); }
    check('安装配置不覆盖学员已填的值', probs4.length === 0,
      probs4.length ? probs4.slice(0, 3).join(' | ') : 'port/apiKey/_note 全保住，paths 正常推导');
  }

  console.log('\n⑭ 包里没有老板的脚本');
  {
    // 这几个是学员真会用/会被链式调用的
    const ALLOWED = new Set([
      'install.cmd',            // 包根 + xianyu-achun 各一份
      'install.ps1',
      'run-node.cmd',           // 版本无关的 node 启动器
      '体检.cmd',               // 一键体检，学员双击用
      '启动.cmd',               // staff-ui 服务
      'start.bat',              // 8093 服务
      'native_host.bat',        // monitor 的原生消息宿主
      '一键安装.bat',           // monitor 安装
      'install_host.ps1',       // monitor 宿主安装
      'Config.ps1', 'Idle.ps1', 'Writes.ps1',   // lib/ps 被 run-node 那条链用
    ]);
    const found = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        // 【2026-11-13 加】顺便查 .tgz（DSH 主题包）和探测记录 —— 它们同样和闲鱼无关，
        //   第 110 轮实测包里带着 141KB 的 dsh-bloom-theme.tgz 和 129KB 的 dc4.txt。
        if (/\.(cmd|bat|ps1|tgz)$/i.test(name) || /^dc\d+\.txt$/i.test(name)) {
          const rel = path.relative(root, p).replace(/\\/g, '/');
          found.push({ rel, name });
        }
      }
    })(root);

    const extra = found.filter((x) => !ALLOWED.has(x.name));
    check('包里没有老板的脚本（.cmd/.bat/.ps1）', extra.length === 0,
      extra.length ? extra.slice(0, 3).map((x) => x.rel).join(' | ') : found.length + ' 个脚本');
  }

  // ── ⑭之二 tools/ 下只应该有【学员工具】──
  //   为什么加（2026-11-13 第 137 轮）：⑭ 组只覆盖了 .cmd/.bat/.ps1，
  //   但【维护者工具全是 .js】—— 一天之内三次被它们混进包：
  //     114 轮 verify-student-view.js（学员跑去看到「找不到分发包」）
  //     120 轮 scan-package.js       （要读 D:\xianyu-release，包里没有）
  //     136 轮 regression-check.js   （跑出「31 通过 / 7 失败 · 有修复被覆盖了」，最吓人）
  //   每次都是「发现了才加一条排除规则」，所以这次改成白名单：
  //   tools/ 下每个 .js 必须在这个名单里，否则报错。
  console.log('\n⑭之二 tools/ 下只有学员工具');
  {
    const ALLOWED_JS = new Set([
      // 建店 / 配店
      'store-wizard.js', 'store-init.js', 'store-ready.js', 'store-login.js',
      'store-new.js', 'store-list.js', 'store-bulk.js', 'store-audit.js',
      'preset-export.js', 'install-config.js', 'install-tasks.js',
      'dump-store-config.js', 'print-paths.js',
      // 出图 / 文案
      'make-base-img.js', 'rebuild-covers-and-desc.js',
      // 【第 161 轮】install.ps1 会调它生成文案模板库（漏了它 = 学员第一次发链接就炸）
      'make-templates-from-example.js',
      // 上架 / 验证
      'first-publish.js', 'publish-group.js', 'verify-published.js',
      'probe-item-sku.js', 'set-item-sku.js',
      // 【第 164 轮】first-publish 拿它当环境探针；漏了它 = 每次发链接第一步甩英文
      'agent-reset.js',
      // 【第 164 轮】大麦场次查询（发链接核心）+ 封面重出（rebuild-covers 的依赖）
      'damai-events.js', 'make-cover.js',
      // 推广
      'ad-plan-create.js', 'ad-status.js', 'ad-window.js', 'set-ad-hours.js',
      // 【2026-11-13 第 137 轮】这五个在学员文档里有明确用法（自查表 / 红线 / 错误速查）。
      //   注意：这份名单必须和 make-release.js 里的 TOOLS_ALLOWED 保持一致，
      //   否则就是「打包时留了、自检说没留」或者反过来。
      'list-onsale.js', 'ad-review.js',
      'probe-mtop-apis.js', 'probe-event-dup.js', 'ad-set-bid-budget.js',
      // 体检 / 自检
      // selftest-update.js 不进包（第 152 轮）：开发机的回归测试，要 git + 老板的店档案
      'healthcheck.js', 'selftest-lib.js',
      'verify-student-view.js',      // 技术负责人可用（找不到包时会说明）
      '_syntax-check-all.js',        // 被 verify 调用
      // 更新 / 编码
      'update.js', 'utf8-check.js', 'scrub-secrets.js', 'today.js',
      // staff-ui 自己的
      'staff-ui/server.js', 'staff-ui/start.js',
      // 【第 242 轮】真机验证一键收集回报（真机清单步骤10 用）
      '学员回报.js',
      // 【2026-11-13 第 140 轮】staff-ui/server.js 会真的执行这三个（预热 / 开关推广 / 应用改动）
      'ensure-agent.js', 'ad-power.js', 'apply-item.js',
    ]);
    const toolDir = path.join(achun, 'tools');
    const bad = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        if (!/\.js$/.test(name)) continue;
        const rel = path.relative(toolDir, p).replace(/\\/g, '/');
        if (!ALLOWED_JS.has(rel)) bad.push(rel);
      }
    })(toolDir);
    check('tools/ 下只有学员工具（白名单）', bad.length === 0,
      bad.length
        ? bad.slice(0, 5).join(' | ') + (bad.length > 5 ? ' …共 ' + bad.length + ' 个' : '')
        : '白名单内');
  }

  // ── ⑮ 核心模块能不能真的 require ──
  //   为什么加（2026-11-13）：⑨ 组只用 vm.Script 做【语法解析】，
  //   语法对不等于能加载 —— require 链上任何一环缺文件、循环依赖、ESM/CJS 混用，
  //   都会在运行时抛错，而语法检查看不出来。
  //   这一组在包内目录里真跑一次 require，验的是"加载得起来"。
  // ⑭之三 .cmd/.bat 的编码与行尾
  //   为什么加（第 176 轮）：把三个 .cmd 的英文换成中文时，连踩两个坑，
  //   都是【文件本身能过语法、跑起来才炸】的：
  //     ① 行尾不纯（1 个 CRLF / 32 个 LF）→ cmd 解析多字节时在字符中间切行，
  //        切出来的碎片被当成命令跑：'住你的问题…' 不是内部或外部命令。
  //        （体检.cmd 头部注释里就写着这个坑"坑过我们一整晚"，我还是踩了）
  //     ② 往 GBK 文件里写了 GBK 编不了的字符（❌ ⚠️ emoji）→ 变成 '?'，
  //        学员看到 "标 ? 的行"。
  //   这两条都查得出来，且必须在【文件层面】查 —— 跑起来才发现已经晚了。
  console.log('\n⑭之三 .cmd/.bat 的行尾与字符');
  {
    const probs = [];
    let n = 0;
    (function rec(d, dep) {
      if (dep > 8) return;
      for (const name of fs.readdirSync(d)) {
        if (['node_modules', '.git'].includes(name)) continue;
        const p = path.join(d, name);
        let st; try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) { rec(p, dep + 1); continue; }
        if (!/\.(cmd|bat|ps1)$/i.test(name)) continue;
        n++;
        const rel = path.relative(root, p).replace(/\\/g, '/');
        const buf = fs.readFileSync(p);
        const isCmd = /\.(cmd|bat)$/i.test(name);

        // ① 行尾必须纯 CRLF（只对 .cmd/.bat；PowerShell 认 LF）
        if (isCmd) {
          let crlf = 0, lf = 0;
          for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else lf++; }
          }
          if (lf > 0) probs.push(rel + ': ' + lf + ' 个 LF-only 行尾（应全为 CRLF，否则 cmd 会切错行）');
        }

        // ② GBK 编不了的字符（emoji / 特殊符号）
        //    ⚠️ 只查 .cmd/.bat —— .ps1 是 UTF-8 带 BOM，PowerShell 认 emoji，
        //    第 178 轮第一版把 install.ps1 的 ⚠️❌ 误报了。
        //    ⚠️ 编码挑法（第 177 轮踩过两版）：
        //      · 不能用「文件里有没有 chcp 65001」判断 —— 体检.cmd 的【注释】里就提到
        //        chcp 65001，而启动.cmd 有真的 chcp 65001 命令、文件却是 GBK（中文在它前面）。
        //      · 正确做法：先按 UTF-8 解，解出 U+FFFD 说明不是 UTF-8，再按 GBK 解。
        //        （install.cmd 是 UTF-8 no BOM，第 153 轮定的；体检/启动 是 GBK）
        let txt = '';
        let isUtf8 = true;
        try {
          txt = new TextDecoder('utf-8').decode(buf);
          if (txt.includes('\uFFFD')) { isUtf8 = false; txt = new TextDecoder('gbk').decode(buf); }
        } catch (e) { txt = buf.toString('utf8'); }
        const bad = [];
        if (isCmd) for (const ch of txt) {
          const cp = ch.codePointAt(0);
          if (cp === 0xFFFD) { bad.push('U+FFFD'); break; }
          if ((cp >= 0x1F000 && cp <= 0x1FAFF)   // emoji 区
            || cp === 0x274C || cp === 0x26A0     // ❌ ⚠
            || (cp >= 0xFE00 && cp <= 0xFE0F)) {  // 变体选择符
            bad.push('U+' + cp.toString(16).toUpperCase());
          }
        }
        if (bad.length) probs.push(rel + ': 含 GBK 编不了的字符 ' + [...new Set(bad)].slice(0, 3).join(' '));

        // ③ .ps1：有中文就必须带 UTF-8 BOM
        //    PowerShell 5.1 没有 BOM 时按 ANSI（中文系统=GBK）解码 → UTF-8 中文全成乱码。
        //    这个坑本会话踩过 5 次（edit 工具会把 BOM 剥掉），第 178 轮固化成检查。
        if (/\.ps1$/i.test(name)) {
          const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
          if (!hasBom) {
            let ptxt = '';
            try { ptxt = new TextDecoder('utf-8').decode(buf); } catch (e) { /* ignore */ }
            const hasCjk = /[\u4e00-\u9fff]/.test(ptxt);
            if (hasCjk) probs.push(rel + ': .ps1 有中文但没有 UTF-8 BOM（PowerShell 5.1 下会乱码）');
          }
        }
      }
    })(root, 0);

    // ⑭之四 三个 .cmd 的【关键中文提示】必须还在
    //   为什么加（第 217 轮）：第175/176 轮把 run-node / 启动 / 体检 的英文提示
    //   换成了中文（找不到 node、服务已停止、按任意键继续、退出码说明）。
    //   ⑭之三 只管【行尾和编码】，不管内容 —— 哪天被人改回英文它照样绿。
    //   这里静态断言四个关键串，每个都对应一次具体的修复。
    {
      const MARKS = [
        ['run-node.cmd', '找不到 node', '第176 轮：no node found → 中文'],
        ['tools/staff-ui/启动.cmd', '服务已停止', '第176 轮：Server stopped → 中文'],
        ['体检.cmd', '按任意键继续', '第175 轮：Press any key → set /p 中文'],
        ['体检.cmd', '退出码', '第176 轮：exit code 说明 → 中文'],
      ];
      const missMarks = [];
      for (const [rel, marker, why] of MARKS) {
        const p = path.join(achun, rel);
        if (!fs.existsSync(p)) { missMarks.push(rel + ' 不在包里（' + why + '）'); continue; }
        const buf = fs.readFileSync(p);
        let txt = '';
        try {
          txt = new TextDecoder('utf-8').decode(buf);
          if (txt.includes('\uFFFD')) txt = new TextDecoder('gbk').decode(buf);
        } catch (e) { txt = buf.toString('latin1'); }
        if (!txt.includes(marker)) missMarks.push(rel + ' 缺「' + marker + '」（' + why + '）');
      }
      check('三个 .cmd 的关键中文提示都在', missMarks.length === 0,
        missMarks.length ? missMarks.slice(0, 3).join(' | ') : '找不到 node / 服务已停止 / 按任意键继续 / 退出码');
    }

    // ⑭之四点五 utf8-check 不能去"修" .cmd（第 248 轮踩的坑）
    //   为什么加：错误速查教学生「改完 .ps1 跑一次 utf8-check.js --fix」，
    //   而那个工具的 NEED_BOM 原来含 '.cmd' —— 一跑就把 GBK 的三个入口
    //   （启动/体检/run-node）改成 UTF-8+BOM，GBK 下 @echo off 前面多出「锘?」，
    //   双击入口当场坏。第248 轮实测踩到，修完立刻加这条守住。
    {
      const uj = path.join(achun, 'tools', 'utf8-check.js');
      const t = fs.existsSync(uj) ? fs.readFileSync(uj, 'utf8') : '';
      const bad = [];
      if (!t) bad.push('utf8-check.js 不在包里');
      else {
        const m = t.match(/const\s+NEED_BOM\s*=\s*\[([^\]]*)\]/);
        if (!m) bad.push('找不到 NEED_BOM 定义');
        else if (/[.'"]cmd[.'"]/.test(m[1])) bad.push('NEED_BOM 里还有 .cmd（会把 GBK 入口改成 UTF-8+BOM）');
        // chcp 必须同时认 936 和 65001（两种合法设计）
        //   ⚠️ 只查字面量 `(65001|936)` —— 原来写的 /chcp\s+\(…\)/ 里 \s+ 被当成
        //   「一个或多个空白」，而源码里那是【反斜杠+s 加号】四个字符，永远匹配不上（第249 轮踩）。
        if (!/\(65001\|936\)/.test(t)) bad.push('chcp 检查只认一种码页');
      }
      check('utf8-check 不会去改 .cmd（第248 轮的坑）', bad.length === 0,
        bad.length ? bad.join(' | ') : 'NEED_BOM 不含 .cmd + chcp 认 936/65001');
    }

    // ⑭之五 install.ps1 的前置检查必须在（第 228–230 轮连着补的三条）
    //   为什么加：这三条全是「文档写了要求、代码却没执行」补出来的 ——
    //   Node18+ 门槛（228）、磁盘 <1GB 拦（229）、系统版本警告（230）。
    //   哪天有人改 install.ps1 把它们删了，⑤ 的运行时断言【抓不到】
    //   （因为这三条只在「坏机器」上才产生输出），所以这里做静态存在性检查。
    {
      const need = [
        ['$MinNode', '第228轮 Node18+ 门槛'],
        ['Node 版本太旧', '第228轮 版本太旧的中文提示'],
        ['$BlockFreeGB', '第229轮 磁盘分级'],
        ['磁盘空间不够', '第229轮 磁盘拦截的中文提示'],
        ['Windows 10 / 11', '第230轮 系统版本要求'],
        ['不是 Windows 10 / 11', '第230轮 系统版本的中文提示'],
      ];
      const ip = path.join(achun, 'install.ps1');
      const it = fs.existsSync(ip) ? fs.readFileSync(ip, 'utf8') : '';
      const miss5 = it ? need.filter(([s]) => !it.includes(s)).map(([s, w]) => s + '（' + w + '）')
        : ['install.ps1 不在包里'];
      check('install.ps1 的前置检查都在（228–230 轮补的三条）', miss5.length === 0,
        miss5.length ? miss5.slice(0, 3).join(' | ') : need.length + ' 项');
    }

    // ⑭之六 学生文档里的下载地址不能是死链（第256 轮抓到的）
    //   为什么加：`xiaozhi9501.github.io` 这个账号根本不存在（404），但
    //   学员安装-给学员DSH.md / 给学员的一页说明 / _发学员-转发清单 / 知识库
    //   四份文档里写死了它 —— 学员和 agent 照着下，第一步就下不动。
    //   打包脚本早就修了（改成环境变量），文档却没人回头改。
    {
      const dead = 'xiaozhi9501';
      const good = 'achun1107.github.io';
      const DOCS2 = ['学员安装-给学员DSH.md', '给学员的一页说明.md', '_发学员-转发清单.md',
        '发放说明-给学员.md', '真机首装验证清单.md', '学员常见错误速查.md', '学员配置手册.md'];
      const bad6 = [];
      for (const d of DOCS2) {
        const p = path.join(achun, d);
        if (!fs.existsSync(p)) continue;
        const t = fs.readFileSync(p, 'utf8');
        if (t.includes(dead)) bad6.push(d + ' 还写着 ' + dead);
      }
      check('学生文档里的下载地址不是死链', bad6.length === 0,
        bad6.length ? bad6.slice(0, 3).join(' | ') : '7 份文档都是 ' + good);
    }

    check('包内 .cmd/.bat/.ps1 的行尾、字符与 BOM', probs.length === 0,
      probs.length ? probs.slice(0, 3).join(' | ') : n + ' 个文件');
  }

  console.log('\n⑮ 核心模块能 require');
  {
    const MODS = ['./lib/env', './lib/http', './lib/agent', './lib/store-profile', './lib/user-id', './lib/museav'];
    const code = MODS.map((m) =>
      "try{require(" + JSON.stringify(m) + ");console.log('OK')}catch(e){console.log('FAIL ' + e.message.split(String.fromCharCode(10))[0])}"
    ).join(';');
    let ok = true;
    let detail = '';
    try {
      const r = execFileSync('node', ['-e', code],
        { cwd: achun, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
      const fails = r.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
      if (fails.length) { ok = false; detail = fails[0].slice(5, 80); }
      else detail = MODS.length + ' 个模块';
    } catch (e) {
      ok = false;
      detail = String(e.stdout || e.message || '').split('\n')[0].slice(0, 80);
    }
    check('包内核心模块都能 require', ok, detail);
  }

  // ── ⑯ 公共库纯函数断言（selftest-lib.js）──
  //   为什么加（2026-11-13）：⑨⑭ 只验「语法对不对」「加载得起来」，
  //   它们验不了「算得对不对」—— 标题规则算错、金额换算算错，代码照样能加载。
  //
  //   ⚠️ 只查【纯函数】那几组，不要求整个 selftest 全过：
  //   包里没有 config.local.json（学员自己建），所以「Key 已加载」「店铺名非空」这类
  //   依赖配置的断言在包里必然失败 —— 那是预期的，不是包坏了。
  console.log('\n⑯ 公共库纯函数断言');
  {
    const st = path.join(achun, 'tools', 'selftest-lib.js');
    if (!fs.existsSync(st)) {
      check('包内有 selftest-lib.js', false, '包里缺这个脚本');
    } else {
      // 这几条只依赖纯函数，跟配置文件无关，包里必须全过
      const PURE = [
        '平台标题上限',
        'makeFitTitle 把 max 压到 30',
        '超长标题被收到',
        '截断后括号是闭合的',
        '空/空白标题不补感叹号',
        'squeezeTitle 漏传 max 时不说 undefined',
        '短标题补到 min',
        '刚好 30 字的标题原样保留',
        '分转元',
        '集合计划识别',
        '单链接识别',
        '状态判定 online',
      ];
      let raw = '';
      try {
        raw = execFileSync('node', [st], {
          cwd: achun, encoding: 'utf8', timeout: 120000, stdio: 'pipe',
        });
      } catch (e) {
        raw = String(e.stdout || '');
      }
      // 逐行看：✅ <msg> / ❌ <msg>
      const seen = new Map();
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*(✅|❌)\s*(.+?)(?:（.*)?$/);
        if (m) seen.set(m[2].trim(), m[1]);
      }
      const missed = PURE.filter((k) => {
        for (const [msg, mark] of seen) {
          if (msg.indexOf(k) >= 0) return mark !== '✅';
        }
        return true;   // 完全没看到这条
      });
      check('公共库纯函数断言全过', missed.length === 0,
        missed.length ? '未过/缺失: ' + missed.slice(0, 2).join(', ') : PURE.length + ' 条');
    }
  }

  // ⑪ 文档里的【规模数字】要和源码对得上
  //   为什么加（第 208 轮）：第205–207 连着三轮在修过时数字 ——
  //   报告的自检项数、清单的项数、手册的组数/冒烟步数/脚本数，全是加检查时
  //   忘了同步。回归127 和「清单项数」只守了其中两条，剩下的没人管。
  //   这里一次性守：组数（数本文件的 console.log 组标题）和冒烟步数（数 smoke-test）。
  {
    const probs11 = [];
    // ① 组数：本文件里 console.log('\n①…') 的组标题
    //   ⚠️ 必须跳过注释行 —— 这条注释自己就含 `console.log('\n①`，
    //   第 208 轮第一版没跳，把注释数成了组（21 → 22）。
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    const nGroups = selfSrc.split(/\r?\n/).filter((l) => {
      const s = l.trim();
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return false;
      return /console\.log\('\\n/.test(l) && /[①-⑳]/.test(l);
    }).length;

    // 两份文档里该出现的地方
    //   ⚠️ 只守组数 —— 冒烟步数那半撤掉了（第 205 轮同样的原因：
    //   `smoke-test.js` 不在包里，check-refs 会报「引用了没发布的文件」）。
    const docs = [
      { rel: '管理员手册-分发包维护.md', group: /自检覆盖的\s*(\d+)\s*组/ },
      { rel: '交付状态-2026-11-13.md', group: /自动自检：\s*(\d+)\s*项\s*\/\s*(\d+)\s*组/ },
    ];
    for (const d of docs) {
      const p = path.join(achun, d.rel);
      if (!fs.existsSync(p)) { probs11.push('找不到 ' + d.rel); continue; }
      const rep = fs.readFileSync(p, 'utf8');
      const m = rep.match(d.group);
      if (!m) { probs11.push(d.rel + ' 里没找到组数'); continue; }
      const declared = Number(m[2] !== undefined ? m[2] : m[1]);
      if (declared !== nGroups) probs11.push(d.rel + ' 写 ' + declared + ' 组、实际 ' + nGroups);
    }
    check('文档里的组数和源码对得上', probs11.length === 0,
      probs11.length ? probs11.slice(0, 3).join(' | ') : nGroups + ' 组');
  }

  // ── ⑯ 汇总 ──
  // ⑩ 交付清单里写的「N 项自动检查」要和实际跑出来的数对得上
  //   为什么加（第 206 轮）：交付清单写的是「28 项」，实际早就53 了 ——
  //   加检查那几轮没人更新它，一路错着发出去。
  //   ⚠️ 放在汇总【前】才有意义：这时 results.length 已经是真数，
  //   再 +1 把这条自己算进去 → 精确比对，不需要容差。
  //   （放在中间用「数源码 check(」的办法不行：源码61 处、实际输出54，
  //    因为有些 check 在条件分支里，差7 已经逼近 ±8 容差。）
  {
    const listPath = path.join(achun, '交付清单.md');
    if (!fs.existsSync(listPath)) {
      check('交付清单写的自检项数和实际对得上', false, '找不到交付清单.md');
    } else {
      const rep = fs.readFileSync(listPath, 'utf8');
      const m = rep.match(/(\d+)\s*项自动检查/);
      if (!m) {
        check('交付清单写的自检项数和实际对得上', false, '清单里没写「N 项自动检查」');
      } else {
        const declared = Number(m[1]);
        const actual = results.length + 1;   // +1 = 这条自己
        check('交付清单写的自检项数和实际对得上', declared === actual,
          declared === actual ? actual + ' 项对上' : '清单写 ' + declared + '、实际 ' + actual);
      }
    }
  }

  const bad = results.filter(r => !r.ok);
  console.log('\n════ 结果 ════');
  console.log('  ' + (results.length - bad.length) + '/' + results.length + ' 通过');
  if (bad.length) {
    console.log('\n  ❌ 没过的：');
    bad.forEach(r => console.log('     · ' + r.name + (r.detail ? '  ' + r.detail : '')));
  } else {
    console.log('  ✅ 安装器这一侧没问题。真机上才有的差异见 真机首装验证清单.md');
  }

  if (!KEEP) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  } else {
    console.log('\n  临时目录保留在: ' + stage);
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
