/**
 * tools/lint-layers.js — 分层护栏：lib/ 之外不许重写公共层的逻辑
 *
 * 为什么存在：
 *   lib/ 有 http / env / mtop / log / idle 五层，但大量脚本绕过它自己重写。
 *   2026-10-04 自审数过一次，2026-10-12 复测在恶化（内联 http.request 40→75 个文件）。
 *   根因是没有护栏：新代码照旧写，没人拦。这个脚本就是那条护栏。
 *
 * 只报告，不自动修改任何文件。退出码 0=无违规 / 1=有违规（方便接进自动检查）。
 * 零依赖：只用 node 内置模块，也【不 require 本仓库的 lib/】—— linter 不该依赖被它检查的东西。
 *
 * 用法:
 *   node tools/lint-layers.js            # 扫描并报告摘要
 *   node tools/lint-layers.js --list     # 除摘要外，把每处命中也打出来（最多 20 条/规则）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.resolve(__filename);
const LIST_MODE = process.argv.slice(2).indexOf('--list') >= 0;
const MAX_LIST = 20; // --list 时每条规则最多打几条

// ── 9 条规则（逐字来自自审文档附录 A）──
// test(line) 判定单行是否命中；一处 = 一行。
const RULES = [
  { no: 1, name: 'http.request',      use: 'lib/http',    test: l => l.indexOf('http.request') >= 0 },
  { no: 2, name: 'apiKey 字面量',      use: 'lib/env',     test: l => /xy_[0-9a-fA-F]{32}/.test(l) },
  { no: 3, name: 'D:\\DSH\\achun / 43462', use: 'PATHS',   test: l => l.indexOf('D:\\DSH\\achun') >= 0 || l.indexOf('43462') >= 0 },
  { no: 4, name: 'campaign.search',   use: 'lib/mtop',     test: l => l.indexOf('campaign.search') >= 0 },
  { no: 5, name: 'campaign.pause',    use: 'mtop.adPause', test: l => l.indexOf('campaign.pause') >= 0 },
  { no: 6, name: 'statusDescTitle',   use: 'planVerdict',  test: l => l.indexOf('statusDescTitle') >= 0 },
  { no: 7, name: 'pauseStatus',       use: 'planVerdict',  test: l => l.indexOf('pauseStatus') >= 0 },
  { no: 8, name: 'GetLastInputInfo',  use: 'lib/idle',     test: l => l.indexOf('GetLastInputInfo') >= 0 },
  { no: 9, name: 'fs.appendFileSync(+log', use: 'lib/log', test: l => l.indexOf('fs.appendFileSync(') >= 0 && /log/i.test(l) },
];

// ── 白名单：路径含以下任一段就跳过 ──
// node_modules / _archive / .git / lib\（公共层自己当然会用到这些 API）/ 本脚本自己
// ⚠️ 本脚本源码里就写着上面那些正则字符串，不排除自己会 100% 自报违规。
const SKIP_DIRS = ['node_modules', '_archive', '.git', 'lib'];

function isExcluded(absFile) {
  if (absFile === SELF) return true;
  const rel = path.relative(ROOT, absFile).replace(/\\/g, '/').toLowerCase();
  return ('/' + rel + '/').split('/').some(seg => SKIP_DIRS.indexOf(seg) >= 0);
}

/** 递归收集待扫的 .js 文件（已排除白名单目录） */
function collect(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.indexOf(e.name) >= 0) continue;
      collect(full, acc);
    } else if (e.isFile() && /\.js$/i.test(e.name) && !isExcluded(full)) {
      acc.push(full);
    }
  }
  return acc;
}

// ── 扫描 ──
const files = collect(ROOT, []);
const hits = RULES.map(r => ({ rule: r, files: 0, items: [] }));
const touched = new Set();

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const h of hits) {
      if (!h.rule.test(lines[i])) continue;
      h.items.push({ file: rel, line: i + 1, text: lines[i].slice(0, 120) });
      touched.add(file);
    }
  }
}
for (const h of hits) h.files = new Set(h.items.map(i => i.file)).size;

// ── 输出 ──
const disp = s => s.replace(/[^\x00-\xff]/g, '..').length; // 中文按 2 列宽算
const pad = (s, w) => s + ' '.repeat(Math.max(1, w - disp(s)));

console.log('── 分层违规（lib/ 之外不许出现）──');
for (const h of hits) {
  const head = '  规则 ' + h.rule.no + '  ' + pad(h.rule.name, 26) + String(h.files) + ' 个文件';
  console.log(head);
  if (LIST_MODE) {
    for (const it of h.items.slice(0, MAX_LIST)) {
      console.log('      ' + it.file + ':' + it.line + '  ' + it.text);
    }
    if (h.items.length > MAX_LIST) console.log('      ... 另 ' + (h.items.length - MAX_LIST) + ' 处（详见 JSON）');
  }
}

const totalHits = hits.reduce((n, h) => n + h.items.length, 0);
const badRules = hits.filter(h => h.items.length > 0).length;
console.log('  合计违规 ' + badRules + ' 条规则 / ' + totalHits + ' 处 / ' + touched.size + ' 个文件');

const logDir = path.join(ROOT, 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) { /* 已存在 */ }
const d = new Date();
const stamp = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const logFile = path.join(logDir, 'lint-layers-' + stamp + '.json');
const relLog = path.relative(ROOT, logFile).replace(/\\/g, '/');
try {
  fs.writeFileSync(logFile, JSON.stringify({
    date: stamp,
    root: ROOT,
    scanned: files.length,
    total: { rules: badRules, hits: totalHits, files: touched.size },
    rules: hits.map(h => ({
      no: h.rule.no, name: h.rule.name, shouldUse: h.rule.use,
      files: h.files, hits: h.items.length, items: h.items,
    })),
  }, null, 2), 'utf8');
  console.log('  明细已写 ' + relLog);
} catch (e) {
  console.log('  明细写入失败 ' + relLog + '：' + e.message);
}

process.exit(totalHits > 0 ? 1 : 0);
