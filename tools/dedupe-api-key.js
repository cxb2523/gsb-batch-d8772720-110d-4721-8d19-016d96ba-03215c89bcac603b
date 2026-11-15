/**
 * tools/dedupe-api-key.js — 把硬编码的 8093 x-api-key 改成读 lib/env 的 SVC.apiKey
 *
 * 为什么（2026-10-07 为「把 achun 推上 gitlab」而做）：
 *   8093 的 x-api-key 被硬编码在 50+ 个文件里，加上中台 key / 管理员密码，
 *   是这个仓一直不敢加 remote 的原因。key 已经挪进 config.local.json（不入库），
 *   这里负责把文件里的字面量全摘干净。
 *
 * 做法（幂等，重复跑不会重复加）：
 *   ① 把字面量 'xy_...' 换成 SVC.apiKey
 *   ② 确保该文件能拿到 SVC：
 *        - 已有 `const { ... } = require('.../lib/env')` → 补上 SVC
 *        - 没有 → 在文件里第一条 require 之后插入 `const { SVC } = require('.../lib/env');`
 *   ③ 没有 require 的文件（浏览器注入脚本）**不动**，列出来人工看 —— 别硬塞 require
 *
 * 用法: node tools/dedupe-api-key.js           # 预演
 *       node tools/dedupe-api-key.js --apply   # 真写
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
// ⚠️ 字面量从本机配置读（不再硬编码）——否则这个工具自己就成了新的泄漏点
const LITERAL = require('../lib/env').SVC.apiKey;
if (!LITERAL) { console.log('❌ 读不到 apiKey（config.local.json 的 service.apiKey 是空的）'); process.exit(2); }

const SKIP_DIR = /\\_archive\\|\\node_modules\\|\\logs\\|\\publish-out\\|\\渲染确认\\|\\_deleted-tasks\\|\\_tmp_mm\\|\\\.git\\/;
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(p + '\\')) walk(p, out); }
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);
const changed = [], manual = [], clean = [];

for (const p of files) {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  let s = fs.readFileSync(p, 'utf8');
  const litCount = s.split(LITERAL).length - 1;
  if (!litCount) continue;

  // 浏览器注入脚本没有 require —— 硬塞会把它彻底弄坏
  if (!/require\(/.test(s)) { manual.push(rel + '  (字面量×' + litCount + '，但文件里没有 require)'); continue; }

  const depth = rel.split('/').length - 1;           // 根目录=0，tools/=1
  const envPath = depth === 0 ? './lib/env' : '../'.repeat(depth) + 'lib/env';

  const before = s;
  let note = '字面量×' + litCount;

  // ⚠️ 名字冲突：这几个文件里 SVC 已经被当成「服务目录路径」用了
  //    （const SVC = PATHS.playwrightService），直接补 SVC 会
  //    "Identifier 'SVC' has already been declared"（2026-10-07 实测 4 个文件）。
  //    冲突时导入成 SVC: SVC_ENV，表达式写 SVC_ENV.apiKey（publish-one.js 就是这么干的）。
  const hasLocalSVC = /(^|\n)\s*(?:const|let|var)\s+SVC\s*=/.test(s);
  const importAs = hasLocalSVC ? 'SVC: SVC_ENV' : 'SVC';
  const keyExpr = hasLocalSVC ? 'SVC_ENV.apiKey' : 'SVC.apiKey';
  if (hasLocalSVC) note += ' [SVC 撞名→用 SVC_ENV]';

  // ② 确保拿到 SVC
  const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*lib\/env['"]\s*\)/;
  const m = s.match(re);
  if (m) {
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (!names.some((n) => n === 'SVC' || n.startsWith('SVC:') || n === 'SVC_ENV')) {
      names.unshift(importAs);
      s = s.replace(re, 'const { ' + names.join(', ') + " } = require('" + envPath + "')");
      note += ' + 已在既有解构里补 ' + importAs;
    }
  } else {
    const lines = s.split('\n');
    let at = -1;
    for (let i = 0; i < Math.min(lines.length, 60); i++) if (/require\(/.test(lines[i]) && /;/.test(lines[i])) { at = i; break; }
    if (at < 0) { manual.push(rel + '  (有 require 但找不到可插入的完整行)'); continue; }
    lines.splice(at + 1, 0, "const { " + importAs + " } = require('" + envPath + "');   // 【密钥外置】由 tools/dedupe-api-key.js 插入");
    s = lines.join('\n');
    note += ' + 插入了 const { ' + importAs + ' } = require(...)';
  }

  // ① 字面量 → SVC.apiKey
  // ⚠️⚠️ 必须**先把带引号的整块**替掉。
  //   第一版直接 s.split(LITERAL).join('SVC.apiKey')，只换了引号【里面】的文本，
  //   结果 `const KEY = 'xy_...';` 变成 `const KEY = 'SVC.apiKey';` ——
  //   一个**字符串字面量**，不是表达式，45 个文件全部静默失效（2026-10-07 实际踩到）。
  //   这里先替 'xxx' / "xxx" 整块，再兜底替裸字面量（模板字符串里那种）。
  s = s.split("'" + LITERAL + "'").join(keyExpr)
       .split('"' + LITERAL + '"').join(keyExpr)
       .split(LITERAL).join(keyExpr);

  if (s !== before) { changed.push({ rel, note }); if (APPLY) fs.writeFileSync(p, s, 'utf8'); }
  else clean.push(rel);
}

console.log((APPLY ? '【真写】' : '【预演】') + ' 扫描 ' + files.length + ' 个 .js\n');
console.log('会改动的 ' + changed.length + ' 个：');
changed.forEach((c) => console.log('  ✅ ' + c.rel.padEnd(42) + c.note));
if (clean.length) { console.log('\n含字面量但无需改的 ' + clean.length + ' 个：'); clean.forEach((c) => console.log('  ─ ' + c)); }
if (manual.length) {
  console.log('\n⚠️ 需要人工看的 ' + manual.length + ' 个（脚本没动）：');
  manual.forEach((c) => console.log('  ⚠ ' + c));
}
if (!APPLY && changed.length) console.log('\n加 --apply 真写。');
