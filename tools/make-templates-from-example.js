#!/usr/bin/env node
/**
 * tools/make-templates-from-example.js —— 从例子生成 ~/.xianyu-templates.json
 *
 * 为什么需要它（2026-11-12）：
 *   `~/.xianyu-templates.json` 是【用户目录】下的文案模板库，代码包里没有。
 *   而 first-publish.js 读不到会直接报「❌ 读不到文案模板…先跑一次 install.ps1」——
 *   原来 install.ps1 又不生成它，学员装完第一次发链接就卡死在这个循环里。
 *   安装器现在调这个脚本，把例子复制成真文件，并把店铺名填对。
 *
 * 用法:
 *   node tools/make-templates-from-example.js --store=我的店铺名
 *   node tools/make-templates-from-example.js --store=我的店铺名 --apply   # 真写（不带就只预演）
 *   node tools/make-templates-from-example.js --store=我的店铺名 --apply --force  # 覆盖已存在的
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'xianyu-templates.example.json');
const TARGET = path.join(os.homedir(), '.xianyu-templates.json');
const STORE = String(A.store || '').trim();
const APPLY = !!A.apply;
const FORCE = !!A.force;

if (!fs.existsSync(EXAMPLE)) {
  console.log('❌ 找不到 ' + EXAMPLE + '（包里应该带一份）');
  process.exit(1);
}
if (!APPLY) {
  // 安装器调用时默认就该写入；但单独跑时给个预演保护
  const willOverwrite = fs.existsSync(TARGET);
  console.log('预演：');
  console.log('  源   : ' + EXAMPLE);
  console.log('  目标 : ' + TARGET + (willOverwrite ? '  ⚠️ 已存在' + (FORCE ? '（会覆盖）' : '（不会覆盖，加 --force）') : ''));
  console.log('  店铺 : ' + (STORE || '(未指定，保留占位)'));
  console.log('\n加 --apply 真写。');
  process.exit(0);
}

if (fs.existsSync(TARGET) && !FORCE) {
  // ⚠️【2026-11-13 改】文件已存在时不能简单跳过。
  //   升级场景：老学员机器上早就有 ~/.xianyu-templates.json（可能是别的店 / 或旧版装的），
  //   里面的 storeTemplates 没有他现在的店名。虽然代码有 fallback（用全部模板），
  //   但 store-init 的一致性检查会报「档案 ↔ storeTemplates 不一致」，看着像坏了。
  //   所以：文件在、但缺当前店 → 只补这一项，不动其他内容。
  if (!STORE) {
    console.log('· 已存在但没给 --store，无法补店铺映射：' + TARGET);
    process.exit(0);
  }
  let cur;
  try { cur = JSON.parse(fs.readFileSync(TARGET, 'utf8')); }
  catch (e) { console.log('⚠️ 已有文件读不了（' + e.message + '），不覆盖，请人工检查'); process.exit(1); }
  cur.storeTemplates = cur.storeTemplates || {};
  if (Object.prototype.hasOwnProperty.call(cur.storeTemplates, STORE)) {
    console.log('· 已存在，且 storeTemplates 里已有「' + STORE + '」，不动');
    process.exit(0);
  }
  // 用 example 里的模板 id 列表补这一项
  let ids = [1, 2, 3, 4, 5];
  try {
    const ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    const firstKey = Object.keys(ex.storeTemplates || {})[0];
    if (firstKey) ids = ex.storeTemplates[firstKey];
  } catch (e) { /* 用默认 */ }
  cur.storeTemplates[STORE] = ids;
  fs.writeFileSync(TARGET, JSON.stringify(cur, null, 2), 'utf8');
  console.log('✅ 已有文件，补上 storeTemplates["' + STORE + '"] = ' + JSON.stringify(ids) + '（其他内容没动）');
  process.exit(0);
}

let j;
try { j = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')); }
catch (e) { console.log('❌ 例子文件读不了：' + e.message); process.exit(1); }

// 把占位店铺名换成真实店名（没给就保留占位，写一条提示）
const keys = Object.keys(j.storeTemplates || {});
if (keys.length === 1 && keys[0].indexOf('<') >= 0) {
  const ids = j.storeTemplates[keys[0]];
  if (STORE) {
    j.storeTemplates = { [STORE]: ids };
    console.log('店铺映射: ' + STORE + ' → ' + JSON.stringify(ids));
  } else {
    console.log('⚠️ 没给 --store，店铺映射保留占位（发布前要改，或用 store-wizard 配一次）');
  }
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, JSON.stringify(j, null, 2), 'utf8');
console.log('✅ 已写 ' + TARGET + '  (' + Object.keys(j.templates || {}).length + ' 套文案, ' + Math.round(fs.statSync(TARGET).size / 1024) + ' KB)');
