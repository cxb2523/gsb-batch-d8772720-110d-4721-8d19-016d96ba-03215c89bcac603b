/**
 * tools/update.js — 学员机器上的【一键更新】（下载 → 校验 → 备份 → 只换代码 → 自检 → 回滚）
 *
 * 为什么必须有它（老板 2026-10-01 批的需求书 §9.2 原话）：
 *   「自动更新（开机或每日拉一次，失败自动回滚）—— 没有这个就不要分发」。
 *   学员不止一个，靠人远程连过去 git pull 一遍，是最快把整批机器搞不一致的做法。
 *
 * 四件最难的事，本脚本的处理方式：
 *   ① 学员改过 stores/<店铺名>.json（那是他的配置，而且【是被 git 跟踪的】）。
 *      普通 git pull 会和这些改动打架 → 所以这里不用 merge，改成：
 *      fetch 之后算出「哪些文件变了」，把 stores/ config.local.json publish-assets/ 等
 *      用户资产【排除在更新范围之外】，只对剩下的代码文件做 git checkout origin/<分支> -- <文件>。
 *      这样永远不会产生冲突，也永远不会覆盖学员的配置。
 *   ② 更新完的新代码可能有 bug → 换之前先备份那些文件，换完跑自检，
 *      自检不过就把备份拷回去（回滚），并返回非 0 退出码。
 *   ③ 本机可能【领先】远端（开发机）。只 diff 不比 ahead/behind 的话，会把「回退新提交」
 *      当成「更新」，方向完全反了。所以 behind=0 直接退出，ahead>0 必须 --force。
 *   ④ 用哪个源 → 参数化：--from=<zip url> / --git / 默认走 git。
 *
 * 用法:
 *   node tools/update.js                     # 预演（默认）。只列出要动哪些文件，不改任何东西
 *   node tools/update.js --apply             # 真更新
 *   node tools/update.js --middle            # 从中台要版本 + 下包（学员机的正路，见下）
 *   node tools/update.js --middle --apply    # 真从中台更新
 *   node tools/update.js --apply --from=https://.../code.zip --sha256=<64位hex>
 *   node tools/update.js --rollback          # 手动回滚到最近一次备份
 *   node tools/update.js --status            # 看当前落后/领先远端多少
 *
 * 退出码: 0=已是最新或更新成功  1=出错  2=自检失败已回滚  3=参数/环境问题
 *
 * ── 【2026-10-15 加】--middle：学员机不该碰 git ──
 * 背景（见 中台需求-代码包分发与更新.md）：学员不懂 gitlab、不一定能翻墙、机器要能长期自更新。
 * 所以学员侧的更新源是【中台】，不是 git：
 *   GET  {MIDDLE.base}/api/xianyu-install-package?channel=stable&current=<本机版本>
 *        Header: X-Client-Key: <machine.id 换来的长期 key>
 *   → { ok, latest, upToDate, url, sha256, size, minInstaller, notes }
 * 本机版本从仓库根的 version.json 读；upToDate=true 就只传几百字节，不重复下 4MB。
 *
 * ⚠️ 中台端点【尚未确认就绪】（2026-10-15 实测：网关对任何 /api/* 都回 401，
 *    不存在的端点也是 401，所以从外部无法判断建没建）。端点没好之前 --middle 会
 *    明确报「中台没就绪」并退出 3，【不会】静默回落到 git —— 学员机上那些改动
 *    经不起一次方向错误的更新。
 *
 * ⚠️ 改这个文件时注意：本机 pwsh 会话是 Windows PowerShell 5.1，`Get-Content | Set-Content`
 * 往返会把 UTF-8 无 BOM 的中文读成 GBK 再写回去，整份文件变乱码（踩过一次，返工整份重写）。
 * 要改就用会写 UTF-8 的编辑器，别拿 PS 的文本 cmdlet 过一道。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const APPLY = ARGV.indexOf('--apply') >= 0;
const FORCE = ARGV.indexOf('--force') >= 0;
const ROLLBACK = ARGV.indexOf('--rollback') >= 0;
const STATUS = ARGV.indexOf('--status') >= 0;
const argOf = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const FROM = argOf('from', '');
const WANT_SHA = argOf('sha256', '');
const BRANCH = argOf('branch', 'master');
const MIDDLE_MODE = ARGV.indexOf('--middle') >= 0;
const CHANNEL = argOf('channel', 'stable');
const MIDDLE_BASE = argOf('middle-base', '');
/** 走中台时下载包要用同一把 key（有些对象存储是签名的）；git/--from 模式为空 */
let AUTH_KEY = '';

const BACKUP_DIR = path.join(ROOT, '_backup');
const LOGF = path.join(ROOT, 'update.log');

/**
 * 【绝不覆盖】的路径 —— 学员的资产和本机专属配置。
 * 注意 stores 是【整目录】保留，只有 _template.json 例外（那是代码，要跟着更新走）。
 */
const KEEP_PREFIX = [
  'stores/',                 // 学员的店铺档案（下面单独放行 _template.json）
  'config.local.json',
  'publish-assets/',         // 素材
  'publish-out/',            // 出图产物
  'playwright-service/service.local.json',
  'node_modules/',
  '_backup/',
  '.git/',
  // ⚠️ 【2026-10-09 加】这两个是【被跟踪的、但装的是学员自己的状态】：
  //   tools/install-config.js 把学员的店铺写进 lib/config.json（env.js 故意不让本机文件盖 store）；
  //   tools/ad-daily.js 把学员自己的监控历史写进 data/ad-daily.json。
  //   不保它们 → 一次更新就会 `git checkout origin/master -- <文件>`，静默把学员退回出厂默认店
  //   并抹掉他的广告历史，而自检照过、不回滚。**数据丢失比拿不到上游改动严重得多。**
  //   代价：这两个文件的上游改动不会自动到达学员机（可以接受；它们极少变）。
  //   正确长期解：把学员态挪出被跟踪文件（挪进 config.local.json / data 忽略掉），届时可移除这两行。
  'lib/config.json',
  'data/',
];
const KEEP_EXCEPT = ['stores/_template.json'];

function kept(p) {
  const f = p.replace(/\\/g, '/');
  if (KEEP_EXCEPT.indexOf(f) >= 0) return false;          // 例外：要更新
  return KEEP_PREFIX.some((k) => f === k || f.startsWith(k));
}

const log = (s) => {
  const l = '[' + new Date().toLocaleString('zh-CN') + '] ' + s;
  console.log(l);
  try { fs.appendFileSync(LOGF, l + '\n'); } catch (e) {}
};
const die = (code, msg) => { console.log('❌ ' + msg); process.exit(code); };

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opts || {})).trim();
}
function gitOk(args) { try { return { ok: true, out: git(args) }; } catch (e) { return { ok: false, out: String((e && e.stdout) || e.message || '').trim() }; } }

/** 备份目录名：ISO 串去掉 - : T 再截 14 位 = 20261008113317（截 15 会带一个结尾的点） */
function stampName() {
  return 'update-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// ── 学员机没有 .git（2026-11-13 第 151 轮修）─────────────────────────────
//   学员包【不带 .git】（带了就等于把 git 历史和老板的密钥发出去了），
//   所以「按 git 更新」这条路在学员机上根本不成立。
//
//   原来这里没有守卫，学员照着《学员配置手册》1.8 节敲 `node tools/update.js`，
//   看到的是一坨英文：
//       ❌ git fetch 失败（网络或凭据）：Command failed: git fetch origin master
//          fatal: not a git repository (or any of the parent directories): .git
//   「not a git repository」对学员没有任何意义，只会以为自己装坏了。
//
//   --middle（中台）和 --from（指定 zip）不需要 git，放行；
//   --rollback 读的是本地 _backup，也不需要 git，放行。
if (!MIDDLE_MODE && !FROM && !ROLLBACK && !fs.existsSync(path.join(ROOT, '.git'))) {
  die(3, [
    '这台机器上没法用「按 git 更新」—— 学员包里不带 .git（也不需要带）。',
    '',
    '  《学员配置手册》1.8 节那几条 update.js 命令是【开发机】用的。',
    '',
    '  学员这边的更新通道还没接好：中台的代码包端点（--middle）尚未就绪，',
    '  所以现在不能自动更新。这不影响你现在正常用。',
    '',
    '  要拿新版本：找管理员要一个新的 xianyu-install-*.zip，解压覆盖即可。',
    '  你自己的配置（stores/、config.local.json、publish-assets/）不会被覆盖。',
  ].join('\n'));
}

// ── --status ──────────────────────────────────────────────────────────────
if (STATUS) {
  const f = gitOk(['fetch', 'origin', BRANCH]);
  if (!f.ok) die(3, 'git fetch 失败（网络或凭据）：' + f.out);
  const lr = gitOk(['rev-list', '--left-right', '--count', 'origin/' + BRANCH + '...HEAD']);
  if (!lr.ok) die(3, '读不到远端状态：' + lr.out);
  const [behind, ahead] = lr.out.split(/\s+/).map(Number);
  console.log('本机分支: ' + (gitOk(['rev-parse', '--abbrev-ref', 'HEAD']).out || '?'));
  console.log('落后远端 ' + behind + ' 个提交，领先 ' + ahead + ' 个');
  if (behind) {
    const names = gitOk(['diff', '--name-only', 'HEAD', 'origin/' + BRANCH]).out.split('\n').filter(Boolean);
    const code = names.filter((n) => !kept(n));
    const keptN = names.filter(kept);
    console.log('变化的文件 ' + names.length + ' 个：代码 ' + code.length + ' 个，你的资产 ' + keptN.length + ' 个（不会被更新碰到）');
    code.slice(0, 30).forEach((n) => console.log('   ' + n));
    if (code.length > 30) console.log('   … 还有 ' + (code.length - 30) + ' 个');
  } else console.log('✅ 已是最新');
  process.exit(0);
}

// ── --rollback ────────────────────────────────────────────────────────────
if (ROLLBACK) {
  if (!fs.existsSync(BACKUP_DIR)) die(1, '没有 _backup 目录，没有可回滚的备份');
  const snaps = fs.readdirSync(BACKUP_DIR).filter((d) => d.startsWith('update-')).sort();
  if (!snaps.length) die(1, '_backup 里没有 update-* 备份');
  const newest = snaps[snaps.length - 1];
  const dir = path.join(BACKUP_DIR, newest);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'));
  console.log('回滚到备份 ' + newest + '（' + meta.files.length + ' 个文件）');
  meta.files.forEach((f) => {
    const src = path.join(dir, 'files', f);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true }); fs.copyFileSync(src, path.join(ROOT, f)); }
  });
  log('=== 已回滚到 ' + newest + ' ===');
  process.exit(0);
}

// ── 算要更新哪些文件 ──────────────────────────────────────────────────────
function planGit() {
  const f = gitOk(['fetch', 'origin', BRANCH]);
  if (!f.ok) die(3, 'git fetch 失败（网络或凭据）：' + f.out);
  // ⚠️ 必须同时看「落后」和「领先」。
  //   只 diff 的话，在【领先于远端】的机器上会算出一堆「要更新的文件」，
  //   而它们的实际含义是「把本机的新提交回退掉」—— 方向完全反了。
  //   这台开发机就踩到了：领先 4 个提交时预演报「要更新 19 个文件、删除 13 个」。
  const lr = gitOk(['rev-list', '--left-right', '--count', 'origin/' + BRANCH + '...HEAD']).out.split(/\s+/).map(Number);
  const behind = lr[0] || 0, ahead = lr[1] || 0;
  const names = gitOk(['diff', '--name-only', 'HEAD', 'origin/' + BRANCH]).out.split('\n').map((s) => s.trim()).filter(Boolean);
  const deleted = gitOk(['diff', '--name-status', 'HEAD', 'origin/' + BRANCH]).out.split('\n')
    .map((l) => l.split(/\s+/)).filter((a) => a[0] === 'D' && !kept(a[1])).map((a) => a[1]);
  // ⚠️ 被删除的文件【必须】从 code 里剔掉。
  //   `git checkout origin/master -- <一个在 origin 里已不存在的路径>` 会直接报
  //   "pathspec ... did not match any file(s) known to git" 并让整次更新失败。
  //   这个 bug 是「学员机模拟测试」(tmp-test-update.js) 抓到的，不是想出来的。
  const code = names.filter((n) => !kept(n) && deleted.indexOf(n) < 0);
  return { names, code, deleted, behind, ahead };
}

// ── 自检：新代码到底能不能用 ──────────────────────────────────────────────
function selfCheck() {
  const steps = [];
  const run = (label, fn) => {
    try { fn(); steps.push('✅ ' + label); return true; }
    catch (e) { steps.push('❌ ' + label + '：' + String(e.message || e).slice(0, 200)); return false; }
  };

  let allOk = true;
  allOk = run('lib/store-profile 能加载所有店铺档案（含推广 9 项）', () => {
    const sp = require('../lib/store-profile');
    const names = sp.list();
    for (const n of names) { const P = sp.load(n); sp.resolveAdPlan(P); sp.resolveTemplates(P); }
    steps.push('    （校了 ' + names.length + ' 份档案）');
  }) && allOk;
  allOk = run('lib/env 能加载本机配置', () => { const e = require('../lib/env'); if (!e.SVC || !e.SVC.port) throw new Error('SVC.port 读不到'); }) && allOk;
  allOk = run('lib/mtop 能加载', () => { const m = require('../lib/mtop'); if (typeof m.adPlans !== 'function') throw new Error('adPlans 不是函数'); }) && allOk;
  allOk = run('tools/selftest-lib.js 通过', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'selftest-lib.js')], { cwd: ROOT, stdio: 'ignore', timeout: 180000 });
  }) && allOk;
  return { allOk, steps };
}

/** 备份一批文件，返回备份目录 */
function backup(files, fromLabel) {
  const stamp = stampName();
  const bak = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(path.join(bak, 'files'), { recursive: true });
  files.filter((f) => fs.existsSync(path.join(ROOT, f))).forEach((f) => {
    const dst = path.join(bak, 'files', f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), dst);
  });
  fs.writeFileSync(path.join(bak, 'files.json'), JSON.stringify({ at: new Date().toISOString(), from: fromLabel, files }, null, 2), 'utf8');
  return { stamp, bak };
}

function restore(bak, files) {
  files.filter((f) => fs.existsSync(path.join(bak, 'files', f))).forEach((f) => {
    fs.copyFileSync(path.join(bak, 'files', f), path.join(ROOT, f));
  });
}

// ── zip 源 ────────────────────────────────────────────────────────────────
function doZipUpdate(src, wantSha, label) {
  const zipUrl = src;
  let sha = wantSha;   // 【第 225 轮】const → let：没给 --sha256 时会试着从 <包地址>.sha256 取
  const fromLabel = label || src;
  const tmp = path.join(os.tmpdir(), 'xy-update-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'code.zip');

  log('① 下载…');
  const DL = `
    const fs=require('fs'),https=require('https'),http=require('http');
    const u=process.argv[1], out=process.argv[2], key=process.argv[3]||'';
    const go=(url,depth)=>{ if(depth>5){console.error('重定向太多');process.exit(1);}
      const mod=url.startsWith('https')?https:http;
      const h={'User-Agent':'xy-update'}; if(key) h['X-Client-Key']=key;
      mod.get(url,{headers:h},r=>{
        if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){ r.resume(); return go(new URL(r.headers.location,url).href,depth+1); }
        if(r.statusCode!==200){ console.error('HTTP '+r.statusCode); process.exit(1); }
        r.pipe(fs.createWriteStream(out)).on('finish',()=>process.exit(0));
      }).on('error',e=>{console.error(e.message);process.exit(1)}); };
    go(u,0);`;
  try { execFileSync(process.execPath, ['-e', DL, zipUrl, zip, AUTH_KEY], { stdio: 'inherit', timeout: 300000 }); }
  catch (e) { die(1, '下载失败：' + e.message); }

  // 【第 225 轮加】没给 --sha256 时，试着取「包地址 + .sha256」。
  //   发布流程本来就把 .sha256 放在 zip 旁边（make-release 写、publish-package 推，
  //   公网 xianyu-latest.zip.sha256 一直在），但学员用 --from=<地址> 时从来不去拿 ——
  //   白白跳过校验，包下坏了/被改过都发现不了。
  //   拿不到就保持原样（下面那句「跳过校验」的提示）。
  if (!sha && /^https?:\/\//i.test(zipUrl) && /\.zip$/i.test(zipUrl)) {
    try {
      const shaFile = path.join(tmp, 'code.zip.sha256');
      execFileSync(process.execPath, ['-e', DL, zipUrl + '.sha256', shaFile, AUTH_KEY],
        { stdio: 'ignore', timeout: 60000 });
      const m = fs.readFileSync(shaFile, 'utf8').match(/[0-9a-f]{64}/i);
      if (m) { sha = m[0]; log('② 取到 ' + zipUrl.split('/').pop() + '.sha256，下面会校验'); }
    } catch (e) { /* 拿不到就按原样跳过 */ }
  }

  if (sha) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    if (got !== String(sha).toLowerCase()) die(1, 'sha256 不匹配！期望 ' + sha + '，实际 ' + got + '（包可能损坏或被改过，已终止）');
    log('② sha256 校验通过');
  } else log('② ⚠️ 没有 sha256，跳过校验（建议让中台下发这个值）');

  // 解包：优先用 Windows 自带的 tar（能读 zip），退 PowerShell Expand-Archive
  const ex = path.join(tmp, 'x');
  fs.mkdirSync(ex, { recursive: true });
  let unpacked = false;
  try { execFileSync('tar', ['-xf', zip, '-C', ex], { stdio: 'ignore' }); unpacked = true; }
  catch (e) {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + ex + '" -Force'], { stdio: 'ignore' });
      unpacked = true;
    } catch (e2) {}
  }
  if (!unpacked) die(1, '解包失败（tar 和 Expand-Archive 都不行）');

  // 压缩包里通常有一层根目录
  let unpackRoot = ex;
  const top = fs.readdirSync(ex);
  if (top.length === 1 && fs.statSync(path.join(ex, top[0])).isDirectory()) unpackRoot = path.join(ex, top[0]);

  // 先收集要覆盖的文件清单（这样备份和覆盖用的是同一份列表）
  const changed = [];

  (function walk(dir, rel) {
    for (const n of fs.readdirSync(dir)) {
      const abs = path.join(dir, n), r = rel ? rel + '/' + n : n;
      if (fs.statSync(abs).isDirectory()) { walk(abs, r); continue; }
      if (kept(r)) continue;
      changed.push(r);
    }
  })(unpackRoot, '');

  const { stamp, bak } = backup(changed, fromLabel);
  for (const r of changed) {
    const dst = path.join(ROOT, r);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(unpackRoot, r), dst);
  }
  log('③ 已覆盖 ' + changed.length + ' 个代码文件（备份在 _backup/' + stamp + '）');

  const chk = selfCheck();
  chk.steps.forEach((s) => log('   ' + s));
  if (!chk.allOk) {
    log('④ 自检没过 → 回滚');
    restore(bak, changed);
    process.exit(2);
  }
  log('④ 自检通过');
  log('=== 更新完成 ===');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

/**
 * ── 中台源 ────────────────────────────────────────────────────────────────
 * 问中台「我该装哪一版」，拿回 { url, sha256, ... }。
 *
 * 为什么单独一个函数、而不是继续用 --from：学员机上【没有】可填的 URL
 * （他们不知道包在哪，也不该知道），URL 必须是中台算出来的。
 *
 * 失败策略是 fail-closed：中台不通/端点没建/码过期 → 报错退出 3，
 * 【绝不】偷偷回落到 git 或旧包。理由见文件头 ④。
 */
function askMiddle() {
  let MIDDLE = {};
  try { MIDDLE = require('../lib/env').MIDDLE || {}; } catch (e) { /* 下面统一报错 */ }
  const base = (MIDDLE_BASE || MIDDLE.base || '').replace(/\/+$/, '');
  if (!base) die(3, 'config.local.json 里没有 middle.base，无法走中台更新。用 --middle-base=<url> 临时指定。');

  // 本机身份 + 长期 key。缺任何一个都说明这台机器【没装过】——那是 install.ps1 的活，不是 update 的。
  let machineId = '';
  try { machineId = String((require('../lib/env').MACHINE || {}).id || '').trim(); } catch (e) {}
  const clientKey = String(MIDDLE.clientKey || MIDDLE.key || '').trim();
  if (!machineId) die(3, '读不到 machine.id —— 这台机器看起来没走过 install.ps1，先装一次再谈更新。');
  if (!clientKey) die(3, '读不到中台的 clientKey —— 学员机应该有（安装时用安装码换的）。');

  const cur = readVersion();
  const q = '/api/xianyu-install-package?channel=' + encodeURIComponent(CHANNEL) +
    (cur ? '&current=' + encodeURIComponent(cur) : '');
  const url = base + q;

  console.log('中台: ' + base);
  console.log('本机版本: ' + (cur || '(读不到 version.json)'));
  console.log('GET ' + q);
  console.log('');

  let res;
  const ASK = `
    const https=require('https'),http=require('http');
    const [u,key]=process.argv.slice(1);
    const go=(url,depth)=>{ if(depth>5){console.error('重定向太多');process.exit(1);}
      const mod=url.startsWith('https')?https:http;
      mod.get(url,{headers:{'X-Client-Key':key,'User-Agent':'xy-update'}},r=>{
        if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){ r.resume(); return go(new URL(r.headers.location,url).href,depth+1); }
        let b=''; r.on('data',c=>b+=c);
        r.on('end',()=>{ console.log(JSON.stringify({status:r.statusCode,body:b})); process.exit(0); });
      }).on('error',e=>{console.error(e.message);process.exit(1)}); };
    go(u,0);`;
  let raw;
  try {
    raw = execFileSync(process.execPath, ['-e', ASK, url, clientKey],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die(3, '问中台失败（网络不通？）：' + String(e.message || e).slice(0, 300));
  }
  try { res = JSON.parse(raw); } catch (e) { die(3, '中台返回的不是 JSON：' + String(raw).slice(0, 300)); }

  if (res.status !== 200) {
    // 401/403 最常见的原因是【安装码过期或 key 没换】，要把话说到人话
    const hint = (res.status === 401 || res.status === 403)
      ? '\n   401/403 通常意味着：① 端点还没建（网关对任何 /api/* 都回 401）；② clientKey 过期/不对。\n'
        + '   先确认中台那个端点到底建了没 —— 从外部【探不出来】：不存在的路径也返回 401。'
      : '';
    die(3, '中台返回 HTTP ' + res.status + '：' + String(res.body).slice(0, 300) + hint);
  }

  let j;
  try { j = JSON.parse(res.body); } catch (e) { die(3, '中台 body 不是 JSON：' + String(res.body).slice(0, 300)); }
  if (j.ok === false) die(3, '中台说不行：' + (j.error || JSON.stringify(j).slice(0, 300)));

  if (j.upToDate) {
    console.log('✅ 已是最新（中台 latest=' + (j.latest || '?') + '）—— 只传了几百字节，没下包。');
    process.exit(0);
  }
  if (!j.url) die(3, '中台说不是最新，却没给 url。需求书 §3.1 要求必须给。');

  // minInstaller：防止很老的安装器装新包装出半残状态
  if (j.minInstaller) {
    const mine = readInstallerVersion();
    if (mine && cmpVer(mine, String(j.minInstaller)) < 0) {
      die(3, '这个包要求安装器 ≥ ' + j.minInstaller + '，本机是 ' + mine +
        '。请让中台/运营重跑一次 install.ps1，不要用旧安装器硬装。');
    }
  }

  console.log('中台最新: ' + (j.latest || '?') + (j.size ? '（' + Math.round(j.size / 1024) + ' KB）' : ''));
  if (j.notes) console.log('更新说明: ' + String(j.notes).slice(0, 200));
  if (!j.sha256) {
    // 需求书要求必须有；没有就是中台没照做。给警告而不是硬失败（否则学员全卡住），但要说清风险。
    console.log('⚠️ 中台没给 sha256 —— 没法校验完整性。请让中台按需求书 §3.1 补上。');
  }
  return { url: j.url, sha256: j.sha256 || '', latest: j.latest || '', clientKey };
}

/** 读仓库根的 version.json（包内固定带一个，需求书 §3.1 要点 5） */
function readVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    return String(v.version || '').trim();
  } catch (e) { return ''; }
}

/** 安装器自己的版本 —— 从 install.ps1 里抠 $InstallerVersion；抠不到就认空（不拦） */
function readInstallerVersion() {
  try {
    const s = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
    const m = s.match(/\$InstallerVersion\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

/** 版本比较：按 . 分段数字比，比不出来就按字符串比（客户端不装 git，只做这个） */
function cmpVer(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
    if (isNaN(x) || isNaN(y)) return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 上报更新结果（需求书 §3.5）。设计成【绝不因为上报失败而影响更新本身】——
 * 上报是"让中台看得见每台机器跑什么版本"，它坏了不该拖垮学员机。
 */
function reportMiddle(ok, version, err) {
  let MIDDLE = {};
  try { MIDDLE = require('../lib/env').MIDDLE || {}; } catch (e) { return; }
  const base = (MIDDLE_BASE || MIDDLE.base || '').replace(/\/+$/, '');
  const clientKey = AUTH_KEY || String(MIDDLE.clientKey || MIDDLE.key || '').trim();
  if (!base || !clientKey) return;

  const payload = JSON.stringify({
    clientKey, version: version || readVersion(), updatedAt: new Date().toISOString(),
    ok: !!ok, error: err ? String(err).slice(0, 500) : '',
  });
  const POST = `
    const https=require('https'),http=require('http');
    const [u,key,body]=process.argv.slice(1);
    const m=u.startsWith('https')?https:http;
    const r=m.request(u,{method:'POST',headers:{'Content-Type':'application/json','X-Client-Key':key,'Content-Length':Buffer.byteLength(body)}},res=>{
      res.resume(); res.on('end',()=>process.exit(res.statusCode<300?0:1)); });
    r.on('error',()=>process.exit(1)); r.write(body); r.end();`;
  try {
    execFileSync(process.execPath, ['-e', POST, base + '/api/xianyu-client/report', clientKey, payload],
      { stdio: 'ignore', timeout: 20000 });
    log('⑤ 已上报中台：版本 ' + (version || readVersion()) + ' ok=' + !!ok);
  } catch (e) {
    // 静默：端点多半还没建。只在日志里留一句，不打扰学员。
    log('⑤ 上报中台失败（不影响本次更新）');
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
(async () => {
  // ⚠️ 必须同时判 ok：gitOk 失败时 out 里放的是【错误信息】，
  //   而错误信息也有长度 —— 拿 `.out.length > 0` 判断，没 git 的机器会
  //   把「fatal: not a git repository」当成「有 remote」，一路走到 fetch 才炸。
  const remoteRes = gitOk(['remote']);
  const hasRemote = remoteRes.ok && remoteRes.out.trim().length > 0;
  if (!hasRemote && !FROM && !MIDDLE_MODE) die(3, '这个仓库没有 remote，也没有 --from=<zip url> / --middle，没法更新。');

  // ── 中台源（学员机的正路）──
  if (MIDDLE_MODE) {
    const m = askMiddle();
    AUTH_KEY = m.clientKey;
    console.log('源: 中台 ' + CHANNEL + ' → ' + m.latest);
    console.log('模式: ' + (APPLY ? '真更新' : '预演'));
    console.log('');
    console.log('将下载 → 校验 sha256 → 备份 → 只覆盖代码文件 → 自检 → 失败回滚');
    console.log('保留（绝不覆盖）：' + KEEP_PREFIX.join('  ') + '（例外 ' + KEEP_EXCEPT.join(',') + '）');
    if (!APPLY) { console.log('\n[预演] 没做任何事。加 --apply 真更新。'); process.exit(0); }
    doZipUpdate(m.url, m.sha256, 'middle:' + CHANNEL + ':' + m.latest);
    reportMiddle(true, m.latest, '');
    return;
  }

  console.log('源: ' + (FROM || ('git origin/' + BRANCH)));
  console.log('模式: ' + (APPLY ? '真更新' : '预演'));
  console.log('');

  if (FROM) {
    console.log('将下载 ' + FROM + ' → 校验 sha256 → 备份 → 只覆盖代码文件 → 自检 → 失败回滚');
    console.log('保留（绝不覆盖）：' + KEEP_PREFIX.join('  ') + '（例外 ' + KEEP_EXCEPT.join(',') + '）');
    if (!APPLY) { console.log('\n[预演] 没做任何事。加 --apply 真更新。'); process.exit(0); }
    return doZipUpdate(FROM, WANT_SHA, FROM);
  }

  const plan = planGit();

  // ① 已经是最新 → 什么都不做（哪怕本机领先，也不是这个脚本该管的事）
  if (plan.behind === 0) {
    console.log('✅ 已是最新（远端没有比你新的提交）');
    if (plan.ahead) console.log('   注意：你比远端【多】' + plan.ahead + ' 个提交 —— 这台是开发机，不是学员机。');
    if (plan.names.length) console.log('   （与远端有 ' + plan.names.length + ' 个文件差异，那是你领先的部分，按设计不动）');
    process.exit(0);
  }
  // ② 本机有远端没有的提交 → 更新会把它们退回去，必须显式同意
  if (plan.ahead && !FORCE) {
    console.log('⛔ 你比远端【多】' + plan.ahead + ' 个提交，同时落后 ' + plan.behind + ' 个。');
    console.log('   直接更新会把本机那几个提交的文件退回到远端版本（代码会丢改动）。');
    console.log('   这台看起来是开发机 —— 学员机不该出现这种情况。');
    console.log('   确认要退回就加 --force；或者先 git push 把你的提交推上去。');
    process.exit(3);
  }

  if (!plan.code.length && !plan.deleted.length) {
    console.log('✅ 已是最新（远端没有需要更新的代码文件）');
    if (plan.names.length) console.log('   （远端有 ' + plan.names.length + ' 个变化，全在你的资产目录里，按设计不动）');
    process.exit(0);
  }
  console.log('落后远端 ' + plan.behind + ' 个提交' + (plan.ahead ? '，领先 ' + plan.ahead + ' 个（--force）' : ''));
  console.log('要更新的代码文件 ' + plan.code.length + ' 个' + (plan.deleted.length ? '，删除 ' + plan.deleted.length + ' 个' : ''));
  plan.code.slice(0, 40).forEach((n) => console.log('   ' + n));
  if (plan.code.length > 40) console.log('   … 还有 ' + (plan.code.length - 40) + ' 个');
  const keptN = plan.names.filter((n) => plan.code.indexOf(n) < 0 && plan.deleted.indexOf(n) < 0);
  if (keptN.length) console.log('\n跳过（你的资产，' + keptN.length + ' 个）：' + keptN.slice(0, 8).join(' ') + (keptN.length > 8 ? ' …' : ''));

  if (!APPLY) { console.log('\n[预演] 没改任何文件。加 --apply 真更新。'); process.exit(0); }

  // ① 备份
  const targets = plan.code.concat(plan.deleted);
  const { stamp, bak } = backup(targets, 'git origin/' + BRANCH);
  log('① 已备份 ' + targets.length + ' 个文件 → _backup/' + stamp);

  // ② 只换代码：存在的文件 checkout 过去，远端删掉的本地也删掉
  if (plan.code.length) {
    const co = gitOk(['checkout', 'origin/' + BRANCH, '--'].concat(plan.code));
    if (!co.ok) die(1, 'git checkout 失败：' + co.out);
  }
  plan.deleted.forEach((f) => { try { fs.unlinkSync(path.join(ROOT, f)); } catch (e) {} });
  log('② 已更新 ' + plan.code.length + ' 个代码文件、删除 ' + plan.deleted.length +
    ' 个（你的 stores/ 和 config.local.json 一个都没动）');

  // ③ 自检
  const chk = selfCheck();
  chk.steps.forEach((s) => log('   ' + s));
  if (!chk.allOk) {
    log('③ 自检没过 → 回滚');
    restore(bak, targets);
    log('   已用 _backup/' + stamp + ' 还原。');
    process.exit(2);
  }
  log('③ 自检通过');

  // ④ 把 HEAD 挪到远端。
  //   为什么必须做：上面是 `git checkout origin/master -- <文件>`，它只改工作区，
  //   HEAD 还停在旧提交 —— 于是每次跑都报「落后 1 个提交」，永远「有更新」。
  //   用 --mixed：只动 HEAD 和索引，【不碰工作区】，学员的 stores/ 改动原样留着。
  //   放在自检【之后】：万一自检没过要回滚，HEAD 还停在旧提交，状态才是自洽的。
  if (!plan.ahead) {
    const rs = gitOk(['reset', '--mixed', 'origin/' + BRANCH]);
    if (rs.ok) log('④ HEAD 已跟到 origin/' + BRANCH + '（工作区未动，你的档案改动仍在）');
    else log('④ ⚠️ HEAD 没能跟到远端：' + rs.out + '（文件已更新，但下次还会报有更新）');
  }
  log('=== 更新完成（备份留在 _backup/' + stamp + '）===');
})().catch((e) => require('../lib/crash').crash(e, 1));
