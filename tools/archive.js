/**
 * tools/archive.js — 归档死文件、轮转日志（可预览、可还原）
 *
 * 背景：D:\DSH\achun 根目录堆了 940 个文件、534 个 .js，其中 405 个
 * 「文件名在整个仓库里只出现过它自己」——三个月前摸 mtop 接口留下的探针。
 * 它们让每次 glob/grep 都撞 250 条上限，是**每次会话都要交的税**。
 *
 * 安全性：
 *   - 只移动、从不删除；写 _archive/MANIFEST.json 记录映射
 *   - --restore 按 MANIFEST 原样搬回
 *   - 有保护名单：lib/ tools/ index/ PROJECT.md、7 个计划任务入口、
 *     指令通道依赖的 4 个文件、发布/下架/校验链路，一律不动
 *   - 判据只认「被别的文件引用过」或「被计划任务引用过」；拿不准就保留
 *
 * 用法:
 *   node tools/archive.js --plan      # 只预览，不动文件
 *   node tools/archive.js --apply     # 执行
 *   node tools/archive.js --restore   # 按 MANIFEST 还原
 *   node tools/archive.js --logs      # 只轮转日志 + 截断超大日志
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const { ROOT, PATHS } = require('../lib/env');
const { execFileSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const RESTORE = process.argv.includes('--restore');
const LOGS_ONLY = process.argv.includes('--logs');
const PLAN_ONLY = !APPLY && !RESTORE && !LOGS_ONLY;

const ARCH = path.join(ROOT, '_archive');
const MANIFEST = path.join(ARCH, 'MANIFEST.json');

const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', 'desktop-profile-backup',
  'blobs', 'Cache', 'Code Cache', 'logs', 'lib', 'tools', 'index']);

/** 绝对保护：这些即使看起来没人引用也不许动 */
const PROTECT = new Set([
  'PROJECT.md', 'package.json', 'package-lock.json',
  // 计划任务入口 + 它们的直接依赖
  'ad-balance-duty.ps1', 'ad-balance-watch.ps1', 'ad-cost-breaker.js', 'ad-daily-report.js',
  'ad-retry-order.ps1', 'ad-retry-order-notify.js', 'ad-watch-stuck.ps1', 'stuck-plan.js',
  'sheet-command-runner.js', 'wecom-sheet.js', 'wecom-send.ps1', 'set-bid.js', 'run-on-console.js',
  // 发布 / 下架 / 校验链路
  'publish-batch.js', 'publish-one.js', 'publish-batch-config.json',
  'do-offshelf.js', '_click-offshelf.js', 'gen-3-covers.js',
  'verify-publish-3.js', 'confirm-render.js', 'check-item-images.js', 'run-eval-store.js',
  // 通道 / 平台脚本
  'ss-call.ps1', 'ask-dsh.ps1', 'make-channel.ps1', 'add-cmd-sheet.ps1',
  'test-guard-live.ps1',
  // 【2026-10-13 删】原来这里还保护着 'watch-webkubor.ps1'。它监控的是 GitHub 用户
  //   webkubor 的 DSH 插件仓库，和闲鱼业务无关 —— 老板要求把非闲鱼的活分出去后，
  //   已连同 bloom-pkg / dsh-llm-hub-pkg 一起搬到 D:\DSH\dsh-plugins\。
  //   留在这张表里会指向一个不存在的文件，让人以为仓里还有它。
  // 状态文件
  'ad-cost-breaker-state.json', 'ad-balance-state.json', 'ad-watch-stuck-state.json',
  'ad-retry-order-state.json', 'sheet-command-state.json', 'plans-pending-order.json',
  // 回归测试 / 校验脚本：没有别的文件引用它们，但验证的是线上不变量，属于活资产
  //   test-publishjs-fittitle.js → 校验 publish-one.js 与桌面版 publish.js 的 fitTitle 一致
  //   test-guard*.js             → 校验下架/删除守卫
  'test-publishjs-fittitle.js', 'test-guard-mismatch.js', 'test-guard.js',
  'sim-templates.js',            // 文案/主图模板分配模拟器
  'shot-items.js',               // 商品页截图助手
]);
const PROTECT_EXT = ['.md', '.ps1', '.bat', '.cmd'];     // 文档与平台脚本一律不自动归档

// ── 收集语料 ──
function walk(dir, acc, withText) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc, withText);
    } else if (e.isFile()) {
      const full = path.join(dir, e.name);
      const ext = path.extname(e.name).toLowerCase();
      if (withText && ['.js', '.json', '.md', '.ps1', '.bat', '.cmd', '.txt'].includes(ext)) {
        try { acc.corpus.push(fs.readFileSync(full, 'utf8')); } catch (e2) { /* ignore */ }
      }
      acc.files.push(full);
    }
  }
  return acc;
}

function scheduledText() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-ScheduledTask -TaskName 'Xianyu*').Actions.Arguments -join ' '"], { encoding: 'utf8' });
  } catch (e) { return ''; }
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return null; }
}

// ── 还原 ──
if (RESTORE) {
  const m = loadManifest();
  if (!m || !m.moved || !m.moved.length) { out.warn('没有可还原的 MANIFEST'); out.done(0); }
  let n = 0, miss = 0;
  for (const it of m.moved) {
    if (fs.existsSync(it.to) && !fs.existsSync(it.from)) {
      fs.mkdirSync(path.dirname(it.from), { recursive: true });
      fs.renameSync(it.to, it.from);
      n++;
    } else if (!fs.existsSync(it.to)) miss++;
  }
  out.head('还原完成');
  out.kv('搬回', n + ' 个');
  if (miss) out.warn(miss + ' 个文件在 _archive 里找不到');
  out.done(0);
}

// ── 日志轮转 ──
function rotateLogs() {
  out.head('日志轮转');
  const MAX_MB = 8;
  let cut = 0, saved = 0;
  const logs = [];
  for (const dir of [ROOT, path.join(ROOT, 'logs')]) {
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of ents) {
      if (!/\.(log|ndjson)$/i.test(n)) continue;
      const f = path.join(dir, n);
      let st; try { st = fs.statSync(f); } catch (e) { continue; }
      logs.push({ f, n, size: st.size });
    }
  }
  // 第三方服务的超大日志（在 ROOT 之外，单独处理）
  const extra = [path.join(PATHS.playwrightService, 'startup.log')];
  for (const f of extra) {
    try { const st = fs.statSync(f); logs.push({ f, n: 'playwright-service/startup.log', size: st.size }); } catch (e) { /* ignore */ }
  }

  logs.sort((a, b) => b.size - a.size);
  for (const L of logs) {
    if (L.size <= MAX_MB * 1024 * 1024) continue;
    // 被占用的日志（例如 playwright-service 正在写的 startup.log）会 EBUSY，
    // 这不是错误，是「要停服务才能截」——记下来别崩。
    try {
      const lines = fs.readFileSync(L.f, 'utf8').split('\n');
      const kept = lines.slice(-2000).join('\n');
      fs.writeFileSync(L.f, '[截断 ' + new Date().toISOString() + '：原 ' +
        Math.round(L.size / 1024 / 1024) + ' MB，保留最后 2000 行]\n' + kept, 'utf8');
      saved += L.size - Buffer.byteLength(kept);
      cut++;
      out.kv('已截断', L.n + '  ' + Math.round(L.size / 1024 / 1024) + ' MB → ' + Math.round(Buffer.byteLength(kept) / 1024) + ' KB');
    } catch (e) {
      out.warn('跳过 ' + L.n + '（' + Math.round(L.size / 1024 / 1024) + ' MB，' +
        (e.code === 'EBUSY' ? '被运行中的进程占用，需停服务后再截' : e.message) + '）');
    }
  }
  out.kv('截断数 / 释放', cut + ' 个 / ' + Math.round(saved / 1024 / 1024) + ' MB');
  if (!cut) out.ok('没有超过 ' + MAX_MB + ' MB 的日志');
}

if (LOGS_ONLY) { rotateLogs(); out.done(0); }

// ── 计算归档计划 ──
const acc = { files: [], corpus: [] };
walk(ROOT, acc, true);
const corpus = acc.corpus.join('\n');
const sched = scheduledText();

const buckets = { scripts: [], backups: [], dumps: [] };
const kept = [];

for (const f of acc.files) {
  const name = path.basename(f);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel.includes('/')) continue;                         // 只动根目录
  if (PROTECT.has(name)) { kept.push({ name, why: '保护名单' }); continue; }
  const ext = path.extname(name).toLowerCase();
  if (PROTECT_EXT.includes(ext)) continue;                  // 文档/平台脚本不自动归档

  // 备份与一次性 dump 单独归类
  if (/^(bak-|baseline-|baseline_)/.test(name) || /\.bak(_|$)/.test(name)) {
    buckets.backups.push({ name, rel });
    continue;
  }
  if (ext === '.js') {
    // 判据：文件名在整个仓库里是否还被别人提到
    const hits = corpus.split(name).length - 1;
    if (hits <= 1 && !sched.includes(name)) buckets.scripts.push({ name, rel });
    else kept.push({ name, why: '被引用 ' + hits + ' 次' });
    continue;
  }
  if (ext === '.json') {
    if (/^ad-run-/.test(name)) { buckets.dumps.push({ name, rel }); continue; }
  }
}

const total = buckets.scripts.length + buckets.backups.length + buckets.dumps.length;

// ── 输出 ──
const rootCount = acc.files.filter((f) => !path.relative(ROOT, f).includes(path.sep)).length;

out.head('归档计划');
out.kv('根目录文件', rootCount + ' 个');
out.kv('拟归档', total + ' 个');
out.kv('  死脚本', buckets.scripts.length + ' 个 .js');
out.kv('  备份', buckets.backups.length + ' 个');
out.kv('  一次性 dump', buckets.dumps.length + ' 个 ad-run-*.json');
out.kv('保留（被引用）', kept.filter((k) => k.why !== '保护名单').length + ' 个');
out.kv('模式', PLAN_ONLY ? '预览（不动文件）' : 'APPLY');

if (PLAN_ONLY) {
  // 落一份计划文件，方便逐条人工复核（--list 直接打印全部候选名）
  fs.mkdirSync(ARCH, { recursive: true });
  fs.writeFileSync(path.join(ARCH, 'PLAN.json'), JSON.stringify({
    at: new Date().toISOString(), total, buckets, kept,
  }, null, 1), 'utf8');

  if (process.argv.includes('--list')) {
    const names = [].concat(buckets.scripts, buckets.backups, buckets.dumps).map((x) => x.name);
    out.plain('');
    out.plain(names.join(' '));
    out.done(0);
  }

  out.plain('');
  out.kv('样例-死脚本', buckets.scripts.slice(0, 6).map((x) => x.name).join(' '));
  out.kv('样例-备份', buckets.backups.slice(0, 6).map((x) => x.name).join(' '));
  out.kv('完整清单', '_archive/PLAN.json（或 --list 打印全部候选名）');
  out.plain('  加 --apply 执行；还原用 --restore');
  out.done(0);
}

// ── 执行 ──
const dest = { scripts: 'scripts', backups: 'backups', dumps: 'dumps' };
const moved = [];
for (const key of Object.keys(buckets)) {
  const dir = path.join(ARCH, dest[key]);
  fs.mkdirSync(dir, { recursive: true });
  for (const it of buckets[key]) {
    const from = path.join(ROOT, it.name);
    const to = path.join(dir, it.name);
    try {
      fs.renameSync(from, to);
      moved.push({ from, to, bucket: key });
    } catch (e) {
      out.warn('移动失败 ' + it.name + '：' + e.message);
    }
  }
}
fs.writeFileSync(MANIFEST, JSON.stringify({
  at: new Date().toISOString(),
  criteria: '根目录 .js 文件名在整个仓库中只出现一次且非计划任务引用；备份/一次性 dump 单独归类',
  moved,
}, null, 1), 'utf8');

const rootAfter = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isFile()).length;
out.head('归档完成');
out.ok('移动 ' + moved.length + ' 个到 _archive/');
out.kv('根目录文件', rootCount + ' → ' + rootAfter);
out.kv('清单', 'logs 之外的 _archive/MANIFEST.json');
out.kv('还原', 'node tools/archive.js --restore');
out.done(0);
