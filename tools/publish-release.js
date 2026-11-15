#!/usr/bin/env node
/**
 * tools/publish-release.js —— 把包发到 GitHub Pages，给学员一个稳定下载地址
 *
 * 背景（2026-11-12）：
 *   打包脚本原来写死 GH_OWNER='xiaozhi9501'，但那个 GitHub 账号根本不存在
 *   （`gh api users/xiaozhi9501` → 404），`xiaozhi9501.github.io` 也是 404 ——
 *   印在 install-guide.html 里的下载地址是死链。现在地址改成环境变量可配，
 *   这个脚本负责把包真的推上去，并且【推完验证链接能下】。
 *
 * 为什么用 gh-pages 而不是 Release：
 *   国内网络下 <user>.github.io 是通的，Release 的 objects.githubusercontent.com 反而不通。
 *   这是这个项目早就踩过的坑（见 _build-install-bundle.js 注释）。
 *
 * 用法:
 *   node tools/publish-release.js --owner=achun1107            # 预演：只打印要做什么
 *   node tools/publish-release.js --owner=achun1107 --apply    # 真发
 *   node tools/publish-release.js --owner=achun1107 --apply --repo=xianyu-project
 *
 * ⚠️ 默认【只预演】。真发要显式 --apply，因为这一步会：
 *   ① 可能创建公开仓库（代码对外可见）
 *   ② 覆盖 gh-pages 分支
 *   这两件事都不可逆到"别人已经下载了"的程度，所以要你亲手确认。
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

const OWNER = String(A.owner || process.env.XY_GH_OWNER || '').trim();
const REPO = String(A.repo || process.env.XY_GH_REPO || 'xianyu-project').trim();
const APPLY = !!A.apply;
const RELEASE_DIR = String(A.dir || 'D:\\xianyu-release');

function sh(exe, args, opts) {
  return execFileSync(exe, args, Object.assign({ encoding: 'utf8', timeout: 300000 }, opts || {}));
}
function trySh(exe, args, opts) {
  try { return { ok: true, out: sh(exe, args, opts) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}

if (!OWNER) {
  console.log('❌ 必须给 --owner=<你的 GitHub 用户名>（或用环境变量 XY_GH_OWNER）');
  console.log('   例：node tools/publish-release.js --owner=achun1107');
  process.exit(2);
}

console.log('\n════ 发布到 GitHub Pages ════');
console.log('账号   : ' + OWNER);
console.log('仓库   : ' + OWNER + '/' + REPO);
console.log('源目录 : ' + RELEASE_DIR);
console.log('模式   : ' + (APPLY ? '真发（会建仓/推 gh-pages）' : '预演（只打印，什么都不做）'));

// ① gh 登录了吗
const auth = trySh('gh', ['auth', 'status']);
if (!auth.ok) {
  console.log('\n❌ gh 没登录。先跑：gh auth login');
  process.exit(1);
}
console.log('\n① gh 已登录');

// ② 找要发的包
if (!fs.existsSync(RELEASE_DIR)) {
  console.log('❌ 目录不存在: ' + RELEASE_DIR + '（先跑 node tools/_build-install-bundle.js）');
  process.exit(1);
}
const zips = fs.readdirSync(RELEASE_DIR).filter(f => /^xianyu-install-.*\.zip$/.test(f));
if (!zips.length) {
  console.log('❌ 没找到 xianyu-install-*.zip（先跑打包）');
  process.exit(1);
}
const bundleName = zips.sort().pop();
const bundlePath = path.join(RELEASE_DIR, bundleName);
const shaPath = bundlePath + '.sha256';
console.log('② 要发的包：' + bundleName + '  ' + Math.round(fs.statSync(bundlePath).size / 1048576 * 10) / 10 + ' MB');
if (!fs.existsSync(shaPath)) console.log('   ⚠️ 没有 .sha256（学员无法校验，建议重新打包）');

// ③ 仓库存在吗
const repoCheck = trySh('gh', ['repo', 'view', OWNER + '/' + REPO, '--json', 'name,visibility']);
const repoExists = repoCheck.ok;
console.log('③ 仓库' + (repoExists ? '已存在' : '还不存在（会用 --public 新建）'));

// ④ 计划
const cloneDir = path.join(os.tmpdir(), 'xy-gh-pages-' + Date.now());
console.log('\n════ 将要执行 ════');
if (!repoExists) console.log('  1. gh repo create ' + OWNER + '/' + REPO + ' --public');
console.log('  2. git clone https://github.com/' + OWNER + '/' + REPO + '.git ' + cloneDir + '（无内容则建 gh-pages 分支）');
console.log('  3. 把 ' + bundleName + ' 和 .sha256 拷进去，写一个 index.html 列出版本');
console.log('  4. git push origin gh-pages');
console.log('  5. 等 Pages 生效后验证 https://' + OWNER + '.github.io/' + REPO + '/' + bundleName);
console.log('\n   然后重新打包即可把正确下载地址印进说明：');
console.log('     $env:XY_GH_OWNER="' + OWNER + '"; node tools/_build-install-bundle.js');

if (!APPLY) {
  console.log('\n[预演] 什么都没做。确认无误后加 --apply。');
  console.log('       ⚠️ --apply 会创建【公开】仓库（代码对外可见）—— 确认这是你要的。');
  process.exit(0);
}

// ── 真发 ──
console.log('\n════ 开始执行 ════');
if (!repoExists) {
  const r = trySh('gh', ['repo', 'create', OWNER + '/' + REPO, '--public',
    '--description', '闲鱼自动化 · 学员分发包（只放 zip，不放源码）']);
  if (!r.ok) { console.log('❌ 建仓失败：' + r.out.slice(0, 300)); process.exit(1); }
  console.log('✅ 仓库已建（公开）');
}

fs.mkdirSync(cloneDir, { recursive: true });
const clone = trySh('git', ['clone', 'https://github.com/' + OWNER + '/' + REPO + '.git', cloneDir]);
if (!clone.ok) { console.log('❌ clone 失败：' + clone.out.slice(0, 300)); process.exit(1); }

// 切到 gh-pages（没有就建孤儿分支）
const hasBranch = trySh('git', ['-C', cloneDir, 'rev-parse', '--verify', 'origin/gh-pages']);
if (hasBranch.ok) {
  trySh('git', ['-C', cloneDir, 'checkout', 'gh-pages']);
} else {
  trySh('git', ['-C', cloneDir, 'checkout', '--orphan', 'gh-pages']);
  trySh('git', ['-C', cloneDir, 'rm', '-rf', '--cached', '.']);
  trySh('git', ['-C', cloneDir, 'clean', '-fdx']);
}

// 拷包
fs.copyFileSync(bundlePath, path.join(cloneDir, bundleName));
if (fs.existsSync(shaPath)) fs.copyFileSync(shaPath, path.join(cloneDir, bundleName + '.sha256'));

// 2026-11-13 加：同时生成一个【固定名】的副本，学员只需记一个地址，
// 不用在十几个带时间戳的包名里找最新。首页也指向它。
fs.copyFileSync(bundlePath, path.join(cloneDir, 'xianyu-latest.zip'));
const latestSha = require('crypto').createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
fs.writeFileSync(path.join(cloneDir, 'xianyu-latest.zip.sha256'), latestSha + '  xianyu-latest.zip\n', 'utf8');
fs.writeFileSync(path.join(cloneDir, '版本.txt'),
  '当前最新版：' + bundleName + '\nsha256：' + latestSha +
  '\n固定下载地址：https://' + OWNER + '.github.io/' + REPO + '/xianyu-latest.zip' +
  '\n更新时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) + '\n', 'utf8');
console.log('✅ 已生成固定名 xianyu-latest.zip（sha256 ' + latestSha.slice(0, 16) + '…）');

// 列一下有哪些版本（简单 index）
const allZips = fs.readdirSync(RELEASE_DIR).filter(f => /^xianyu-install-.*\.zip$/.test(f)).sort().reverse();
fs.writeFileSync(path.join(cloneDir, 'index.html'), `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>闲鱼自动化 · 分发包</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1d2129}
h1{font-size:20px}li{margin:8px 0;line-height:1.7}code{background:#f2f3f5;padding:2px 6px;border-radius:4px;font-size:13px}
.note{background:#f7f8fa;border-left:3px solid #165dff;padding:10px 14px;font-size:13px;margin:16px 0}</style></head>
<body>
<h1>闲鱼自动化 · 分发包</h1>
<div class="note">下载后先校验：<code>Get-FileHash &lt;zip&gt; -Algorithm SHA256</code>，和同名 .sha256 文件逐字对比。</div>
<ul>
${allZips.map(z => `<li><a href="${z}">${z}</a>${fs.existsSync(path.join(RELEASE_DIR, z + '.sha256')) ? ' · <a href="' + z + '.sha256">sha256</a>' : ''}</li>`).join('\n')}
</ul>
</body></html>
`, 'utf8');

const add = trySh('git', ['-C', cloneDir, 'add', '-A']);
const commit = trySh('git', ['-C', cloneDir, 'commit', '-m', 'release: ' + bundleName]);
const push = trySh('git', ['-C', cloneDir, 'push', '-u', 'origin', 'gh-pages']);
if (!push.ok) { console.log('❌ 推送失败：' + push.out.slice(0, 400)); process.exit(1); }
console.log('✅ 已推 gh-pages');

// 验证（Pages 有延迟，最多等 3 分钟）
const url = 'https://' + OWNER + '.github.io/' + REPO + '/' + bundleName;
console.log('\n⏳ 等 Pages 生效（最多 3 分钟）：' + url);
(async () => {
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const r = trySh('curl', ['-sI', '-o', '/dev/null', '-w', '%{http_code}', url]);
    const code = (r.out || '').trim().slice(-3);
    if (code === '200') {
      console.log('✅ 可以下载了：' + url);
      console.log('\n下一步（把正确地址印进说明并重打）：');
      console.log('  $env:XY_GH_OWNER="' + OWNER + '"; node tools/_build-install-bundle.js');
      return;
    }
    process.stdout.write('.');
  }
  console.log('\n⚠️ 3 分钟内没等到 200。Pages 首次开通可能要更久，过一会儿再手动打开那个链接看看。');
})();
