/**
 * tools/selftest-update.js — 造一台「学员机」端到端验证 tools/update.js
 *
 * 为什么要有这个测试（不是洁癖，是它真的抓到过东西）：
 *   写 update.js 时「跑一遍看起来对」，但这个测试第一次跑就抓出 3 个真 bug：
 *     ① 被删除的文件也塞进 `git checkout origin/master -- <文件>` → pathspec 报错，整次更新失败
 *     ② 只比 diff 不比 ahead/behind → 在【领先远端】的机器上把「回退新提交」当成「更新」
 *     ③ checkout 只改工作区不挪 HEAD → 每次跑都报「落后 1 个提交」，永远「有更新」
 *   所以这个测试必须留在仓里：update.js 是「没有它就不要分发」的那一环。
 *
 * 它验证 5 件事：
 *   ① 落后远端时能更新代码（改到的文件生效、远端删的本地也删）
 *   ② 【最关键】学员改过的 stores/*.json 和 config.local.json 一个字节都不许动
 *   ③ 自检真跑了、备份真生成了、HEAD 真跟上了
 *   ④ 幂等：更新完再跑一次报「已是最新」
 *   ⑤ 回滚真能还原
 *
 * 用法: node tools/selftest-update.js        # 退出码 0 = 全过
 *
 * 为什么用 Node 而不是 PowerShell 写：
 *   这台机器上 PS 5.1 会把没有 BOM 的 .ps1 按 GBK 读，中文一进去就炸
 *   （这一晚上已经因为这个坑返工三次）。Node 是 UTF-8 原生，不折腾。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SRC = path.resolve(__dirname, '..');
let PASS = 0, FAIL = 0;
const ok = (m) => { console.log('✅ ' + m); PASS++; };
const no = (m) => { console.log('❌ ' + m); FAIL++; };
const say = (m) => console.log('\n────── ' + m + ' ──────');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-upd-'));
console.log('临时目录: ' + T);

let failed = false;
try {
  // ── 1. 造一个「源码仓」（只带代码和档案，不带 85MB 图片，免得测试跑十分钟）──
  say('1. 造远端和两台机器');
  const src = path.join(T, 'src');
  fs.mkdirSync(src, { recursive: true });
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const n of fs.readdirSync(from)) {
      if (n === 'node_modules' || n === '_backup') continue;
      const a = path.join(from, n), b = path.join(to, n);
      if (fs.statSync(a).isDirectory()) copyDir(a, b);
      else fs.copyFileSync(a, b);
    }
  };
  for (const n of ['lib', 'tools', 'stores', 'data', 'package.json']) {
    const a = path.join(SRC, n);
    if (!fs.existsSync(a)) continue;
    if (fs.statSync(a).isDirectory()) copyDir(a, path.join(src, n));
    else fs.copyFileSync(a, path.join(src, n));
  }
  for (const n of fs.readdirSync(SRC)) {
    if (n.endsWith('.js') && fs.statSync(path.join(SRC, n)).isFile()) fs.copyFileSync(path.join(SRC, n), path.join(src, n));
  }
  // ⚠️ 不要依赖真实仓库里某个探针文件存在（它随时可能被归档，一归档这个回归测试就硬失败）。
  //   测试仓自己造一个当"待删除的文件"。
  fs.mkdirSync(path.join(src, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(src, 'tools', 'dump-store-config.js'), '// 测试用占位：模拟一个会被删除的代码文件\n', 'utf8');
  // data/ 也要有，才测得了「学员的监控历史不被更新抹掉」
  fs.mkdirSync(path.join(src, 'data'), { recursive: true });
  if (!fs.existsSync(path.join(src, 'data', 'ad-daily.json'))) fs.writeFileSync(path.join(src, 'data', 'ad-daily.json'), '{}\n', 'utf8');

  git(src, ['init', '-q', '-b', 'master']);
  git(src, ['config', 'user.email', 't@t.t']);
  git(src, ['config', 'user.name', 't']);
  git(src, ['add', '-A']);
  git(src, ['commit', '-q', '-m', 'init']);
  git(T, ['clone', '-q', '--bare', src, path.join(T, 'origin.git')]);
  git(T, ['clone', '-q', path.join(T, 'origin.git'), path.join(T, 'student')]);
  git(T, ['clone', '-q', path.join(T, 'origin.git'), path.join(T, 'dev')]);
  for (const d of ['student', 'dev']) {
    const p = path.join(T, d);
    git(p, ['config', 'user.email', 't@t.t']);
    git(p, ['config', 'user.name', 't']);
  }
  console.log('   lib 文件 ' + fs.readdirSync(path.join(T, 'student', 'lib')).length + ' 个；档案: ' +
    fs.readdirSync(path.join(T, 'student', 'stores')).join(', '));

  // ── 2. dev 造一个新版本 ──
  say('2. 在 dev 里造新版本');
  const argsFileDev = path.join(T, 'dev', 'lib', 'args.js');
  fs.appendFileSync(argsFileDev, '\n// [测试] 远端新增的一行，学员机更新后应该能看到\n', 'utf8');
  const doomed = path.join(T, 'dev', 'tools', 'dump-store-config.js');
  if (!fs.existsSync(doomed)) { no('测试前提不成立：测试仓没造出 dump-store-config.js'); process.exit(1); }
  fs.unlinkSync(doomed);
  // 顺便让远端也改一下 lib/config.json —— 这正是"会把学员的店冲掉"的那个文件。
  //   update.js 现在把 lib/config.json 列进 KEEP_PREFIX，所以这次改动【不应该】到达学员机。
  const devCfg = path.join(T, 'dev', 'lib', 'config.json');
  const dj = JSON.parse(fs.readFileSync(devCfg, 'utf8').replace(/^\uFEFF/, ''));
  dj._remoteMarker = '远端改过 lib/config.json'; if (dj.store) dj.store.all = ['远端的店'];
  fs.writeFileSync(devCfg, JSON.stringify(dj, null, 2), 'utf8');
  git(path.join(T, 'dev'), ['add', '-A']);
  git(path.join(T, 'dev'), ['commit', '-q', '-m', 'test: 新版本']);
  git(path.join(T, 'dev'), ['push', '-q', 'origin', 'master']);
  ok('远端已有一个新提交（改 lib/args.js + 删 tools/dump-store-config.js + 改 lib/config.json）');

  // ── 3. 学员机：已装好 + 改过自己的档案 ──
  say('3. 学员机已装好（有 config.local.json）+ 改自己的店铺档案');
  // ⚠️ 真实的学员机一定已经装过一次：config.local.json 是【未跟踪】文件，install.ps1 写的。
  //    不模拟它的话，selftest-lib.js 会因为「Key 已加载」失败 → 自检不过 → 更新回滚，
  //    那是测试造得不真，不是 update.js 的 bug。
  const localCfg = path.join(T, 'student', 'config.local.json');
  fs.writeFileSync(localCfg, JSON.stringify({
    service: { apiKey: 'xy_TESTKEY0000000000000000000000' },
    middle: { base: 'https://example.invalid', tenant: 'test', key: 'sk-test' },
    thresholds: { adDayCost: 66 },
  }, null, 2), 'utf8');

  const storeFile = path.join(T, 'student', 'stores', '好易美代拍.json');
  fs.writeFileSync(storeFile, fs.readFileSync(storeFile, 'utf8').replace('"default": 50', '"default": 88'), 'utf8');
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const beforeStore = sha(storeFile), beforeCfg = sha(localCfg);

  // ⚠️ 学员机上还有两处状态住在【被 git 跟踪的】文件里：
  //   lib/config.json   = 学员的店铺归属（tools/install-config.js 写的）
  //   data/ad-daily.json = 学员自己的监控历史（tools/ad-daily.js 写的）
  //   这里同时做两件事，正好覆盖之前会把学员机搞坏的两个缺陷：
  //   ① 默认店设成【不是】好易美代拍 —— 原来的 selftest-lib 断言会失败 → 更新回滚 → 永远更不了
  //   ② 改动这两个文件 —— 它们原来不在 KEEP_PREFIX 里，更新会把店冲回出厂、抹掉历史
  const stuShipped = path.join(T, 'student', 'lib', 'config.json');
  const sj = JSON.parse(fs.readFileSync(stuShipped, 'utf8').replace(/^\uFEFF/, ''));
  sj._studentMarker = '学员自己的店在这里';
  sj.store = { default: '学员的店', all: ['学员的店'], active: ['学员的店'] };
  fs.writeFileSync(stuShipped, JSON.stringify(sj, null, 2), 'utf8');
  const stuDaily = path.join(T, 'student', 'data', 'ad-daily.json');
  fs.writeFileSync(stuDaily, JSON.stringify({ _学员历史: '三天数据', rows: [1, 2, 3] }, null, 2), 'utf8');
  const beforeShipped = sha(stuShipped), beforeDaily = sha(stuDaily);
  ok('学员价格改 88；默认店设为「学员的店」；lib/config.json 与 data/ 都写了学员态');

  const run = (args) => {
    try { return { out: execFileSync(process.execPath, [path.join(T, 'student', 'tools', 'update.js')].concat(args), { cwd: path.join(T, 'student'), encoding: 'utf8' }), code: 0 }; }
    catch (e) { return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status }; }
  };

  // ── 4. 预演 ──
  say('4. 预演（不该碰 stores/）');
  const dry = run([]).out;
  console.log(dry);
  const leaked = dry.split(/\r?\n/).filter((l) => /^\s+stores\//.test(l));
  if (leaked.length) no('预演把 stores/ 列进了更新范围: ' + leaked.join(' '));
  else ok('预演没有把 stores/ 列进更新范围');

  // ── 5. 真更新 ──
  say('5. 真更新');
  const r = run(['--apply']);
  console.log(r.out);
  console.log('退出码: ' + r.code);
  const out = r.out;

  // ── 6. 验收 ──
  say('6. 验收');
  if (r.code !== 0) no('更新退出码非 0: ' + r.code); else ok('更新退出码 0');
  if (/远端新增的一行/.test(fs.readFileSync(argsFileDev.replace('dev', 'student'), 'utf8'))) ok('lib/args.js 更新到新版本');
  else no('lib/args.js 没更新');
  if (fs.existsSync(path.join(T, 'student', 'tools', 'dump-store-config.js'))) no('该删的 dump-store-config.js 还在');
  else ok('远端删掉的文件，学员机也删了');

  if (sha(storeFile) === beforeStore) ok('【关键】学员档案 sha256 完全没变（' + beforeStore.slice(0, 12) + '）');
  else no('【关键】学员档案被改了！');
  if (JSON.parse(fs.readFileSync(storeFile, 'utf8')).价格.default === 88) ok('档案里价格还是 88');
  else no('档案里的价格被改了');
  if (sha(localCfg) === beforeCfg) ok('【关键】config.local.json（本机密钥）也没被动过');
  else no('config.local.json 被改了！');

  // 这两条是 2026-10-09 补的回归：之前 update.js 会把它们一起 checkout 回去，
  // 静默把学员的店冲回出厂默认、抹掉他的监控历史，而自检照过。
  if (sha(stuShipped) === beforeShipped) ok('【关键】lib/config.json（学员的店铺归属）没被上游冲掉');
  else no('【关键】lib/config.json 被更新覆盖了 —— 学员的店被冲回出厂！');
  if (sha(stuDaily) === beforeDaily) ok('【关键】data/ad-daily.json（学员监控历史）没被抹掉');
  else no('【关键】data/ 被更新覆盖了 —— 学员的监控历史被抹掉！');
  const stuStoreNow = (() => { try { return JSON.parse(fs.readFileSync(stuShipped, 'utf8')).store; } catch (e) { return null; } })();
  if (stuStoreNow && stuStoreNow.default === '学员的店') ok('学员仍是「学员的店」的归属（没被退回 好易美代拍）');
  else no('学员的店被退回成 ' + JSON.stringify(stuStoreNow));

  if (/selftest-lib\.js/.test(out)) ok('自检真跑了'); else no('没有自检记录');
  if (/HEAD 已跟到/.test(out)) ok('HEAD 已跟到远端（否则每次跑都报「有更新」）'); else no('HEAD 没跟到远端');
  const bakDir = path.join(T, 'student', '_backup');
  if (fs.existsSync(bakDir) && fs.readdirSync(bakDir).length) ok('备份已生成: ' + fs.readdirSync(bakDir)[0]);
  else no('没有备份');

  // ── 7. 幂等 ──
  say('7. 幂等检查');
  const again = run([]).out;
  if (/已是最新/.test(again)) ok('再跑一次报「已是最新」'); else no('再跑一次不是已是最新:\n' + again);

  // ── 8. 回滚 ──
  say('8. 回滚');
  const studentArgs = path.join(T, 'student', 'lib', 'args.js');
  fs.appendFileSync(studentArgs, '\n// 手工搞坏\n', 'utf8');
  const brokenSha = sha(studentArgs);
  console.log(run(['--rollback']).out);
  if (sha(studentArgs) !== brokenSha) ok('回滚把备份文件还原了');
  else no('回滚没起作用');

  // ── 9. 真实学员包不带 .git ──
  //   2026-11-13 第 151 轮：上面 1-8 模拟的「学员机」是 `git clone` 出来的（有 .git），
  //   但真实发出去的包【不含 .git】—— make-release 的规则第 ③ 条就是排掉它
  //   （带了等于把 git 历史和内部密钥发出去）。
  //   于是这个测试一直没覆盖到真学员：他们照《学员配置手册》1.8 敲 `node tools/update.js`，
  //   看到的是「fatal: not a git repository」—— 一句学员完全看不懂的英文。
  //   这条把 .git 摘掉，验 update.js 给的是中文说明、退出码 3，而不是英文报错。
  say('9. 学员包不带 .git（真实发出去的包就是这样）');
  fs.rmSync(path.join(T, 'student', '.git'), { recursive: true, force: true });
  const noGit = run([]);
  if (noGit.code === 3 && /学员包里不带 \.git/.test(noGit.out)) ok('默认命令给出中文说明（退出码 3）');
  else no('默认命令的提示不对：code=' + noGit.code + '  首行=' + String(noGit.out).split('\n')[0]);
  if (!/not a git repository/.test(noGit.out)) ok('没把 "not a git repository" 甩给学员');
  else no('还是把英文 git 报错甩给学员了');
  const noGitStatus = run(['--status']);
  if (noGitStatus.code === 3 && /学员包里不带 \.git/.test(noGitStatus.out)) ok('--status 也给出中文说明');
  else no('--status 的提示不对：code=' + noGitStatus.code + '  首行=' + String(noGitStatus.out).split('\n')[0]);

  console.log('\n════════════════════════');
  console.log(FAIL ? '⛔ 通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项' : '🎉 全部 ' + PASS + ' 项通过');
} catch (e) {
  failed = true;
  console.log('❌ 测试本身炸了：' + (e && e.stack || e));
} finally {
  if (!FAIL && !failed) {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) {}
  } else {
    console.log('（失败时保留临时目录以便排查: ' + T + '）');
  }
}
process.exit(FAIL || failed ? 1 : 0);
