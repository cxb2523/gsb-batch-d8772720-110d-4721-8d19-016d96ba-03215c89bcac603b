// 一次性自检：把 publish.js 里真实的 CONCERT_TEMPLATES + fitTitle 抠出来跑，
// 用真实明星/城市/轮次数据验证每条模板替换后的长度，确认都落在 30~40。
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../lib/env');

// publish.js 属于 xianyu-monitor 那个仓库（本仓只依赖）。路径走 PATHS，别再写死本机绝对路径。
const P = path.join(PATHS.xianyuMonitor || '', 'publish.js');
if (!PATHS.xianyuMonitor || !fs.existsSync(P)) {
  console.log('❌ 找不到 publish.js：' + P +
    '\n   请在 config.local.json 的 paths.xianyuMonitor 里填 xianyu-monitor 仓库的位置。');
  process.exit(2);
}
const src = fs.readFileSync(P, 'utf8');

const arrTxt = src.match(/var CONCERT_TEMPLATES = (\[[\s\S]*?\n    \]);/);
if (!arrTxt) { console.log('FAIL 抠不到 CONCERT_TEMPLATES'); process.exit(1); }
const fitTxt = src.match(/var TITLE_MAX = 40;[\s\S]*?\n    \}/);
if (!fitTxt) { console.log('FAIL 抠不到 fitTitle'); process.exit(1); }

let CONCERT_TEMPLATES;
eval('CONCERT_TEMPLATES = ' + arrTxt[1] + ';');
eval(fitTxt[0]);

console.log('模板条数 =', CONCERT_TEMPLATES.length);
const ids = CONCERT_TEMPLATES.map(t => t.id).join(',');
console.log('id 序列 =', ids, ids === '1,2,3,4,5,6' ? 'OK' : 'BAD');

const CASES = [
  ['孙燕姿', '广州', '首开', '演唱会'],
  ['侯明昊', '郑州', '二开', '见面会'],
  ['TOP登陆少年', '上海', '一开', '音乐节'],
  ['某某某', '北京', '捡漏', '话剧'],
];
const PH = [['{明星}', 0], ['{城市}', 1], ['{场次类型}', 2], ['{活动类型}', 3]];

let bad = 0;
for (const t of CONCERT_TEMPLATES) {
  console.log('\nid=' + t.id + '  ' + t.name);
  console.log('  pattern: ' + t.titlePattern);
  for (const c of CASES) {
    let s = t.titlePattern;
    for (const [k, i] of PH) s = s.split(k).join(c[i]);
    const out = fitTitle(s);
    const ok = out.length >= 30 && out.length <= 40;
    if (!ok) bad++;
    console.log('   ' + (ok ? 'OK ' : 'BAD') + ' len=' + String(out.length).padStart(2) + '  ' + out);
  }
  // 占位符残留检查
  const left = t.titlePattern.match(/\{[^}]+\}/g) || [];
  const unknown = left.filter(x => !['{明星}', '{城市}', '{场次类型}', '{活动类型}'].includes(x));
  if (unknown.length) { console.log('   BAD 未知占位符: ' + unknown.join(',')); bad++; }
  // descPattern 一致性
  if (t.descPattern !== CONCERT_TEMPLATES[0].descPattern) { console.log('   BAD descPattern 与模板1不一致'); bad++; }
}
console.log('\n结论: ' + (bad === 0 ? 'PASS 全部 ' + (CONCERT_TEMPLATES.length * CASES.length) + ' 组标题长度合规' : 'FAIL ' + bad + ' 处问题'));
process.exit(bad === 0 ? 0 : 1);
