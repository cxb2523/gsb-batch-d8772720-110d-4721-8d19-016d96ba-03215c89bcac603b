/**
 * tools/fix-poster-template.js — 修主图模板的文字层：把渲染成丑方块的 emoji 换成普通字符
 *
 * 背景（2026-09-29 看图确认）：
 *   tpl_redtext 第 [3] 层文字是 `级店铺➕⬆千好评`（老板要的是「七级店铺+上千好评」）。
 *   实拍渲染结果：
 *     7️⃣  → 蓝圆角方块 + 白 7      ✅ 正常（模板设计如此，保留）
 *     ➕  → 白底大黑加号            ❌ 丑
 *     ⬆  → 蓝圆角方块 + 白上箭头    ❌ 丑
 *   老板原话「有一个模板只有『七』符合」= 那一行里只有「七」是正常的。
 *
 * 修法：
 *   ① 把会变成 emoji 的字符换成普通字符：➕→+   ⬆→上
 *   ② 把 fontFamily 里的 emoji 字体挪到中文字体【后面】
 *      （现在是 "Segoe UI Emoji" 排第一，中文/符号渲染不稳的根因）
 *
 * 安全：改前备份 poster-templates.json；只动命中的字符串，不重建模板结构。
 *
 * 用法:
 *   node tools/fix-poster-template.js            # 预览
 *   node tools/fix-poster-template.js --apply    # 写入
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const { PATHS } = require('../lib/env');

const APPLY = process.argv.includes('--apply');
const CFG = path.join(PATHS.playwrightService, 'assets/poster-templates.json');

// 会被 emoji 字体吃掉、渲染成丑方块的字符 → 换成普通字符
const REPL = [
  ['➕', '+'],
  ['⬆', '上'],
  ['⬇', '下'],
  ['⭐', '★'],
];

// emoji 字体（应从 fontFamily 里挪到最后）
const EMOJI_FONTS = /"Segoe UI Emoji"|"Apple Color Emoji"|"Noto Color Emoji"/g;
const CJK_FONTS = ['"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'];

/** 把 fontFamily 里的 emoji 字体挪到末尾，中文优先 */
function fixFontFamily(ff) {
  if (typeof ff !== 'string' || !ff) return { value: ff, changed: false };
  if (!/"Segoe UI Emoji"|"Apple Color Emoji"|"Noto Color Emoji"/.test(ff)) return { value: ff, changed: false };
  const parts = ff.split(',').map((s) => s.trim()).filter(Boolean);
  const emoji = parts.filter((p) => EMOJI_FONTS.test(p));
  const rest = parts.filter((p) => !EMOJI_FONTS.test(p));
  const merged = rest.concat(emoji).join(',');
  return { value: merged, changed: merged !== ff };
}

(async () => {
  if (!fs.existsSync(CFG)) { out.bad('找不到模板配置：' + CFG); out.done(2); }
  const list = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  if (!Array.isArray(list)) { out.bad('配置不是数组'); out.done(2); }

  out.head('主图模板文字层修复');
  out.kv('配置', CFG);
  out.kv('模板数', list.length);

  const changes = [];
  list.forEach((tpl) => {
    (tpl.layers || []).forEach((L, i) => {
      if (typeof L.text === 'string') {
        let t = L.text, did = [];
        // 「级店铺」前面漏了「七」——只补不重复（这行本该是「七级店铺+上千好评」）
        if (/^级店铺/.test(t)) { t = '七' + t; did.push('补「七」'); }
        REPL.forEach(([from, to]) => {
          if (t.indexOf(from) >= 0) { t = t.split(from).join(to); did.push(from + '→' + to); }
        });
        if (did.length) {
          changes.push({ id: tpl.id, i, field: 'text', from: L.text, to: t, note: did.join(' ') });
          L.text = t;
        }
      }
      if (typeof L.fontFamily === 'string') {
        const r = fixFontFamily(L.fontFamily);
        if (r.changed) {
          changes.push({ id: tpl.id, i, field: 'fontFamily', from: L.fontFamily, to: r.value, note: 'emoji 字体后置' });
          L.fontFamily = r.value;
        }
      }
    });
  });

  if (!changes.length) { out.ok('没有需要改的字符/字体'); out.done(0); }

  changes.forEach((c) => {
    out.plain('');
    out.plain('  ' + c.id + ' 第[' + c.i + ']层 .' + c.field + '   （' + c.note + '）');
    out.plain('    旧: ' + JSON.stringify(c.from).slice(0, 150));
    out.plain('    新: ' + JSON.stringify(c.to).slice(0, 150));
  });

  if (!APPLY) { out.plain(''); out.kv('DRY', '未写入，加 --apply 生效'); out.done(0); }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  fs.copyFileSync(CFG, CFG + '.bak_' + stamp);
  fs.writeFileSync(CFG, JSON.stringify(list, null, 2), 'utf8');
  out.head('已写入');
  out.ok('改了 ' + changes.length + ' 处');
  out.kv('备份', path.basename(CFG) + '.bak_' + stamp);
  out.plain('  注意：出图服务会重新读这个文件；若没生效，重启一次 8093 服务。');
  out.done(0);
})().catch((e) => out.fail(e));
