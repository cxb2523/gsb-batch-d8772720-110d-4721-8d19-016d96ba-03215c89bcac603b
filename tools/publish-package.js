#!/usr/bin/env node
/**
 * tools/publish-package.js —— 把最新打的学员包发到 GitHub Pages
 *
 * 为什么有它（2026-11-13 第 134 轮）：
 *   发包这一步原来是一串手贴的 PowerShell（clone gh-pages → 复制 zip →
 *   算 sha256 → 改 index.html → commit → push → 等 70 秒 → 探活）。
 *   在这个会话里手工贴了 40+ 次 —— 每次都要改包名，改错一次就可能发了个旧的。
 *   而且中间任何一步失败（clone 慢、push 401、Pages 没刷新完）都要重新来一遍。
 *
 * 它做什么（顺序不能换）：
 *   ① 找 D:\xianyu-release 里【最新】的 xianyu-install-*.zip（按 mtime）
 *   ② clone gh-pages 到临时目录
 *   ③ 清掉旧版本 zip，放新的 + .sha256
 *   ④ xianyu-latest.zip 覆盖成同一份；重算它的 sha256
 *   ⑤ 更新 版本.txt 和 index.html 里的包名
 *   ⑥ commit + push
 *   ⑦ 等 Pages 刷新（默认 70 秒），然后 HEAD 探活
 *
 * 用法:
 *   node tools/publish-package.js                 # 全自动
 *   node tools/publish-package.js --dry           # 只打印会做什么
 *   node tools/publish-package.js --wait=0        # 不等 Pages 刷新（CI 用）
 *
 * 环境变量:
 *   GH_TOKEN     GitHub token（必填，或已存在 git 凭据里）
 *   XY_RELEASE_DIR  发布目录（默认 <本仓>\..\..\xianyu-release）
 *   XY_PAGES_REPO   仓库（默认 github.com/achun1107/xianyu-project）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const WAIT_ARG = (process.argv.find((a) => a.startsWith('--wait=')) || '').split('=')[1];
const WAIT_SEC = WAIT_ARG !== undefined ? Number(WAIT_ARG) : 70;

const RELEASE = process.env.XY_RELEASE_DIR || path.join(ROOT, '..', '..', 'xianyu-release');
const PAGES_REPO = process.env.XY_PAGES_REPO || 'achun1107/xianyu-project';
const TOKEN = process.env.GH_TOKEN || '';
const LIVE_URL = 'https://achun1107.github.io/xianyu-project/xianyu-latest.zip';

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ encoding: 'utf8', stdio: 'pipe' }, opts || {}));
}
function step(n, msg) { console.log('\n  [' + n + '] ' + msg); }
function ok(msg) { console.log('      ✅ ' + msg); }
function info(msg) { console.log('      ·  ' + msg); }

(async () => {
  console.log('');
  console.log('  ════ 发学员包到 GitHub Pages ════');
  if (DRY) console.log('  模式: --dry（只打印，不做任何改动）');

  // ── ① 找最新包 ──
  step(1, '找最新的学员包');
  if (!fs.existsSync(RELEASE)) {
    console.log('      ❌ 发布目录不存在: ' + RELEASE);
    console.log('         先跑 node tools\\make-release.js && node tools\\_build-install-bundle.js');
    process.exit(1);
  }
  const zips = fs.readdirSync(RELEASE)
    .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!zips.length) {
    console.log('      ❌ ' + RELEASE + ' 里没有 xianyu-install-*.zip');
    process.exit(1);
  }
  const ZIP = zips[0].f;
  const ZIP_PATH = path.join(RELEASE, ZIP);
  if (zips.length > 1) {
    info('目录里有 ' + zips.length + ' 个包，取最新的这个');
    zips.slice(1).forEach((x) => info('  旧: ' + x.f));
  }
  ok(ZIP + '  ' + (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2) + ' MB');

  // 【2026-11-14 第 161 轮加】发之前先看打包时那四道检查的结果。
  //   为什么：_build-install-bundle 的 try/catch 会吞掉非零退出码（设计是"只报告不阻断"），
  //   于是出现过「冒烟测试红了、包照发」—— 瞬时抖动红一次我没注意就发了。
  //   现在打包会把结果写进 <zip>.checks.json，这里读它，任一失败就【拒绝发】。
  const checksFile = ZIP_PATH + '.checks.json';
  if (!fs.existsSync(checksFile)) {
    console.log('');
    console.log('  ❌ 找不到 ' + path.basename(checksFile));
    console.log('     这个文件是 _build-install-bundle.js 写的（四道检查的结果）。');
    console.log('     没有它 = 这个包不是从当前流程打出来的，或者打包时没跑检查。');
    console.log('     重新跑一次：node tools\\_build-install-bundle.js');
    console.log('');
    process.exit(1);
  }
  let checks;
  try { checks = JSON.parse(fs.readFileSync(checksFile, 'utf8')); } catch (e) {
    console.log('  ❌ ' + path.basename(checksFile) + ' 解析不了：' + e.message);
    process.exit(1);
  }
  if (!checks.ok) {
    const failed = (checks.checks || []).filter((c) => !c.ok).map((c) => c.name);
    console.log('');
    console.log('  ❌ 这个包的四道检查没过，拒绝发布：' + failed.join('、'));
    console.log('     打包时间 ' + checks.at + '，重跑 _build-install-bundle.js 让检查过了再来。');
    console.log('');
    process.exit(1);
  }
  ok('四道检查全过（' + (checks.checks || []).length + ' 道，' + checks.at.slice(11, 19) + '）');

  // 【第 220 轮加】发之前把管理员手册「发包前手动补两道」也跑了。
  //   为什么放这：那两道（verify 57 项 / smoke-scripts 26+4）【不写 .checks.json】，
  //   原来全靠发包的人记得手跑 —— 忘了就发出去了。
  //   放 publish-package 而不是 build：build 每轮打好几次，加进来要多 90 秒；
  //   publish 一个版本才一次，多这 90 秒换「不可能漏」值。
  const { execFileSync: _ex } = require('child_process');
  const MANUAL = [
    ['verify-student-view.js', '自检（57 项 / 21 组）', 180000],
    ['smoke-scripts.js', '学员脚本逐个真跑（26 + 4 专项）', 240000],
  ];
  step(1, '发之前补跑「手动两道」');
  for (const [script, label, timeout] of MANUAL) {
    const p = path.join(__dirname, script);
    if (!fs.existsSync(p)) { console.log('      ❌ ' + script + ' 不在'); process.exit(1); }
    try {
      _ex(process.execPath, [p], { cwd: path.join(__dirname, '..'), stdio: 'pipe', encoding: 'utf8', timeout });
      ok(label);
    } catch (e) {
      const out = String((e.stdout || '') + (e.stderr || ''));
      const tail = out.split(/\r?\n/).filter((l) => l.trim()).slice(-6);
      console.log('      ❌ ' + label + ' 没过，拒绝发布：');
      tail.forEach((l) => console.log('         ' + l.trim().slice(0, 110)));
      process.exit(1);
    }
  }

  // ── ② clone gh-pages ──
  step(2, 'clone gh-pages');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publishpkg-'));
  const url = TOKEN
    ? 'https://x-access-token:' + TOKEN + '@github.com/' + PAGES_REPO + '.git'
    : 'https://github.com/' + PAGES_REPO + '.git';
  if (DRY) { info('[dry] git clone --depth 1 -b gh-pages ' + PAGES_REPO); }
  else {
    try {
      // 注意：git clone 会把 "Cloning into ..." 写到 stderr ——【即使成功】。
      //   所以不能用 stderr 非空来判断失败，只能看退出码（execFileSync 退出码非 0 才抛）。
      //   mkdtempSync 已经建了目录，clone 到已存在的空目录是允许的。
      sh('git', ['clone', '--depth', '1', '-b', 'gh-pages', url, tmp]);
      ok('clone 完成');
    } catch (e) {
      console.log('      ❌ clone 失败');
      // 完整打出来 —— 第 134 轮第一次跑时只打第一行，正好是 "Cloning into..."，
      // 完全看不出真实原因。
      const detail = String(e.stderr || e.message || '').trim();
      detail.split('\n').slice(-6).forEach((l) => console.log('         ' + l));
      if (!TOKEN) console.log('         💡 没设 GH_TOKEN —— set GH_TOKEN=ghp_xxx');
      else console.log('         💡 token 可能失效；手动试: git clone --depth 1 -b gh-pages https://github.com/' + PAGES_REPO + '.git <空目录>');
      process.exit(1);
    }
  }

  // ── ③④ 复制 + 重算 latest 的 sha256 ──
  step(3, '放新包 + 重算 xianyu-latest.zip 的 sha256');
  const latestPath = path.join(tmp, 'xianyu-latest.zip');
  let sha = '';
  if (DRY) {
    info('[dry] 清掉旧 xianyu-install-*.zip');
    info('[dry] 复制 ' + ZIP);
    info('[dry] 复制成 xianyu-latest.zip 并算 sha256');
  } else {
    for (const f of fs.readdirSync(tmp)) {
      if (/^xianyu-install-.*\.zip(\.sha256)?$/.test(f)) fs.unlinkSync(path.join(tmp, f));
    }
    fs.copyFileSync(ZIP_PATH, path.join(tmp, ZIP));
    if (fs.existsSync(ZIP_PATH + '.sha256')) fs.copyFileSync(ZIP_PATH + '.sha256', path.join(tmp, ZIP + '.sha256'));
    fs.copyFileSync(ZIP_PATH, latestPath);
    sha = crypto.createHash('sha256').update(fs.readFileSync(latestPath)).digest('hex');
    fs.writeFileSync(path.join(tmp, 'xianyu-latest.zip.sha256'), sha + '  xianyu-latest.zip\n', 'utf8');
    ok('sha256 ' + sha);
  }

  // ── ⑤ 版本.txt + index.html ──
  step(4, '更新 版本.txt 和 index.html');
  if (DRY) info('[dry] 写 版本.txt / 替换 index.html 里的包名');
  else {
    fs.writeFileSync(path.join(tmp, '版本.txt'),
      '当前最新版：' + ZIP + '\nsha256：' + sha + '\n更新时间：' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '\n',
      'utf8');
    const idxPath = path.join(tmp, 'index.html');
    if (fs.existsSync(idxPath)) {
      const before = fs.readFileSync(idxPath, 'utf8');
      const after = before.replace(/xianyu-install-[\w-]+\.zip/g, ZIP);
      fs.writeFileSync(idxPath, after, 'utf8');
      ok(before === after ? 'index.html 里已经是这个包名' : 'index.html 里的包名已更新');
    } else info('没有 index.html，跳过');
  }

  // ── ⑥ commit + push ──
  step(5, 'commit + push');
  if (DRY) info('[dry] git commit + push origin gh-pages');
  else {
    const git = (args) => sh('git', ['-c', 'safe.directory=' + tmp,
      '-c', 'user.email=achun1107@users.noreply.github.com',
      '-c', 'user.name=achun1107'].concat(args), { cwd: tmp });
    git(['add', '-A']);
    try {
      git(['commit', '-m', 'release: ' + ZIP.replace(/\.zip$/, '')]);
      ok('commit 完成');
    } catch (e) {
      info('没有新改动可提交（可能上次已经发过同一版）');
    }
    try {
      git(['push', 'origin', 'gh-pages']);
      ok('push 完成');
    } catch (e) {
      // 第 134 轮实测：第一次 push 失败、重试就成功 —— 常见原因是同时跑了
      //   _sync-public.js --push（两个 git 进程打同一个远端），或者网络抖动。
      info('第一次 push 没成功，5 秒后重试一次…');
      await new Promise((r) => setTimeout(r, 5000));
      try {
        git(['push', 'origin', 'gh-pages']);
        ok('push 完成（重试成功）');
      } catch (e2) {
        console.log('      ❌ push 失败');
        const detail = String(e2.stderr || e2.message || '').trim();
        detail.split('\n').slice(-8).forEach((l) => console.log('         ' + l));
        console.log('         💡 常见原因：token 失效 / 同时有别的 git 进程在 push / 网络');
        process.exit(1);
      }
    }
  }
  // 清理失败不该影响已经推成功的发布
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('  · 临时目录没清掉（句柄还占着），不影响结果: ' + e.message); }

  // ── ⑦ 等 Pages 刷新 + 探活 ──
  step(6, '等 Pages 刷新（' + WAIT_SEC + ' 秒）然后探活');
  if (DRY || WAIT_SEC === 0) {
    info('[dry] 跳过等待和探活');
    console.log('\n  ✅ 干跑完成。去掉 --dry 就是真发。\n');
    return;
  }
  await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));
  let status = 0;
  try {
    status = await new Promise((resolve) => {
      https.get(LIVE_URL, { method: 'HEAD' }, (res) => { resolve(res.statusCode); res.resume(); })
        .on('error', () => resolve(0));
    });
  } catch (e) { status = 0; }
  if (status === 200) {
    console.log('');
    console.log('  ✅ 发布完成');
    console.log('     包:     ' + ZIP);
    console.log('     sha256: ' + sha);
    console.log('     下载:   ' + LIVE_URL);
    console.log('');
  } else {
    console.log('');
    console.log('  ⚠️ push 成功了，但探活返回 ' + status + '（Pages 有时要更久）');
    console.log('     过一分钟自己打开看一眼: ' + LIVE_URL);
    console.log('');
    process.exit(1);
  }
})();
