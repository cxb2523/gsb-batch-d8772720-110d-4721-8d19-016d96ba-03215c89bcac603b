/**
 * tools/ledger-mark.js — 给台账里指定的链接补写「状态」
 *
 * 为什么收成工具：这个动作我已经用一次性脚本做过三次
 *   （6 条重发、泉州徐良下架、孙燕姿 4 条下架），每次都要重写一遍。
 *   而且台账是【以后判断"这条链接还在不在售"的依据】，
 *   漏标会让未来误判（"台账里有、还 ok=true"不等于它在售）。
 *
 * 用法:
 *   node tools/ledger-mark.js <itemId...> --status "已下架（原因）"
 *   node tools/ledger-mark.js <itemId...> --show        # 只看现状
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');

const a = process.argv.slice(2);
const ids = a.filter((x) => /^\d+$/.test(x));
const si = a.indexOf('--status');
const status = si >= 0 ? a[si + 1] : '';
const SHOW = a.includes('--show');
if (!ids.length) { console.log('用法: node tools/ledger-mark.js <itemId...> --status "..."'); process.exit(2); }

const F = path.join(ROOT, '上架台账.json');
const rows = JSON.parse(fs.readFileSync(F, 'utf8'));

if (SHOW || !status) {
  for (const id of ids) {
    const r = rows.filter((x) => String(x.itemId) === id).pop();
    console.log('  ' + id + '  ' + (r ? ((r.标题 || '').slice(0, 34) + '   状态=' + (r.状态 || '(无)')) : '(台账里没有)'));
  }
  if (!status) process.exit(0);
}

let n = 0;
for (const id of ids) {
  const r = rows.filter((x) => String(x.itemId) === id).pop();
  if (!r) { console.log('  ⚠️ 台账里没有 ' + id + '，跳过'); continue; }
  r.状态 = status;
  n++;
  console.log('  ✓ ' + id + '  ' + (r.标题 || '').slice(0, 34));
}
fs.writeFileSync(F, JSON.stringify(rows, null, 2), 'utf8');
console.log('  已写盘，' + n + ' 条。台账总条数 ' + rows.length);
