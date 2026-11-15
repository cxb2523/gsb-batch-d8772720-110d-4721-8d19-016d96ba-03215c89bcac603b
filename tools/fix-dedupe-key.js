/**
 * tools/fix-dedupe-key.js — 修 dedupe-api-key.js 造成的两处破坏
 *
 * 事故（2026-10-06）：
 *   ① dedupe-api-key.js 把【带引号】的字面量 'xy_...' 里的内容换成了 SVC.apiKey，
 *      于是变成 const KEY = 'SVC.apiKey';  —— 是字符串，不是取值。
 *      node --check 查不出来（合法字符串），但所有请求会 401。
 *   ② publish-one.js 里本来就有 `const SVC = PATHS.playwrightService;`，
 *      我又从 lib/env 解构了 SVC → 重复声明 → SyntaxError。
 *
 * 修法：
 *   ① 'SVC.apiKey' （带引号） → SVC.apiKey （不带）
 *   ② publish-one.js：把 env 解构的 SVC 改名 SVC_ENV，KEY 读 SVC_ENV.apiKey
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const FILES = ['publish-one.js', 'run-cfgs.js', 'tools/run-4groups.js', 'tools/probe-area-target.js', 'tools/apply-tpl-session.js'];
const APPLY = process.argv.includes('--apply');

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('  ✗ ' + rel); continue; }
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  const notes = [];

  // ① 去引号
  const q = (s.match(/'SVC\.apiKey'/g) || []).length;
  if (q) { s = s.replace(/'SVC\.apiKey'/g, 'SVC.apiKey'); notes.push(q + ' 处去引号'); }

  // ② publish-one.js 撞名
  if (rel === 'publish-one.js') {
    if (/const \{ SVC, PATHS, ROOT, STORE \} = require\('\.\/lib\/env'\);/.test(s)) {
      s = s.replace("const { SVC, PATHS, ROOT, STORE } = require('./lib/env');",
                    "const { SVC: SVC_ENV, PATHS, ROOT, STORE } = require('./lib/env');");
      s = s.replace('const KEY = SVC.apiKey;', 'const KEY = SVC_ENV.apiKey;');
      notes.push('SVC→SVC_ENV 解决撞名');
    }
  }

  if (s !== before) {
    console.log('  ✅ ' + rel.padEnd(30) + notes.join('，'));
    if (APPLY) fs.writeFileSync(p, s, 'utf8');
  } else {
    console.log('  ─ ' + rel.padEnd(30) + '无需改');
  }
}
console.log('\n' + (APPLY ? '已写' : '预演（加 --apply 真写）'));
