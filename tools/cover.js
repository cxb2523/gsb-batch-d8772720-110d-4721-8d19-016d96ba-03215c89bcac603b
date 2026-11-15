/**
 * tools/cover.js — 主图「底条版」交互式生成（学员用这一个命令就够）
 *
 *   node tools/cover.js
 *
 * 它会问你 4 件事，然后出一张 3:4 的主图成品：
 *   ① 海报路径（可以把图直接拖进窗口 / 粘贴路径）
 *   ② 底条第一行（建议「城市+场次 · 日期 场馆」）
 *   ③ 底条第二行（回车 = 7级店铺 · 3千+好评 · 不中全额退）
 *   ④ 右侧角标（回车 = ¥50 起 代拍）
 *
 * 出的图是【成品图】，发布时走 mainImg（整张直用、不叠版式）——
 * 脚本最后会把可直接粘贴的配置片段打给你。
 *
 * 只想一条命令出图、不想回答问题：用 tools/make-cover-lite.js 的参数式。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { renderCover, DEFAULT_LINE2, DEFAULT_BADGE } = require('./make-cover-lite');

const rl = readline.createInterface({ input: process.stdin });

// 【2026-10-30 修】原来用 rl.question()，在管道/重定向输入下会拿不到值就返回空
// （实测：`echo ... | node tools/cover.js` 第一问直接跳过 → 误报「找不到文件」）。
// 改成「'line' 事件 + 待取队列」：TTY 手输和管道喂入都稳。
const pending = [];
let waiter = null;
rl.on('line', (l) => {
  if (waiter) { const w = waiter; waiter = null; w(l); }
  else pending.push(l);
});
const ask = (q) => new Promise((res) => {
  process.stdout.write(q);
  if (pending.length) res(String(pending.shift() || '').trim());
  else waiter = (l) => res(String(l || '').trim());
});

function pickPoster(p) {
  let s = p.trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  if (!fs.existsSync(s)) {
    // 学员常见：只给了文件名，或者拖进来带了引号/空格
    const guess = path.join('publish-assets', s);
    if (fs.existsSync(guess)) return guess;
  }
  return s;
}

(async () => {
  console.log('');
  console.log('════════ 主图生成 · 底条版 ════════');
  console.log('海报原样保留，只在底部压一条信息带：谁/哪场/哪天 + 信任背书 + 价格');
  console.log('');
  console.log('【第 1 问】海报图片在哪？');
  console.log('  · 直接把图片文件拖进这个窗口，回车');
  console.log('  · 或者粘贴完整路径，例如 D:\\海报\\深圳好势乘双.jpg');
  console.log('');
  const rawPoster = await ask('海报路径 > ');
  const poster = pickPoster(rawPoster);
  if (!poster || !fs.existsSync(poster)) {
    console.log('');
    console.log('❌ 找不到这个文件：' + (poster || '(空)'));
    console.log('   提示：路径里可以带空格；拖进窗口时如果带了引号，脚本会自动去掉。');
    process.exit(2);
  }

  console.log('');
  console.log('【第 2 问】底条第一行写什么？（这一行最重要，买家 1 秒内看的就是它）');
  console.log('  写法：城市 + 场次名 · 日期 + 场馆');
  console.log('  例子：深圳好势乘双 · 11.27 深圳体育中心');
  const line1 = await ask('第一行 > ');
  if (!line1) { console.log('❌ 第一行必须写，否则买家看不出是什么场次。'); process.exit(2); }

  console.log('');
  console.log('【第 3 问】底条第二行（信任背书）。直接回车 = ' + DEFAULT_LINE2);
  const line2raw = await ask('第二行 > ');

  console.log('');
  console.log('【第 4 问】右侧角标（价格钩子）。直接回车 = ' + DEFAULT_BADGE);
  const badgeRaw = await ask('角标 > ');

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = path.join('publish-out', '成品-' + stamp + '.jpg');

  console.log('');
  console.log('出图中…');
  const r = await renderCover({
    poster,
    line1,
    line2: line2raw || undefined,
    badge: badgeRaw || undefined,
    out,
  });

  console.log('');
  console.log('✅ 好了：' + r.out);
  console.log('  尺寸 ' + r.w + 'x' + r.h + '，' + r.kb + 'KB' + (r.patched ? '（原图不是 3:4，已自动补边，内容没裁）' : '（原图已是 3:4）'));
  console.log('');
  console.log('──────────────── 发布时怎么用 ────────────────');
  console.log('这是【成品图】，发布要走 mainImg，不要再用 baseImg / 版式：');
  console.log('');
  console.log('  方案文件（publish-groups\\xxx.json）里加一行：');
  console.log('    "mainImg": "' + r.out.replace(/\\/g, '\\\\') + '"');
  console.log('');
  console.log('  或者 publish-one.js 之前设环境变量：');
  console.log('    $env:KUN_MAIN_IMG="' + r.out + '"');
  console.log('');
  console.log('发之前建议先预演看一眼：');
  console.log('    node tools\\publish-group.js <你的方案文件> --plan');
  console.log('─────────────────────────────────────────────');
  console.log('');

  const again = await ask('还要再出一张吗？(y = 是，直接回车 = 结束) > ');
  rl.close();
  if (/^y/i.test(again)) {
    require('child_process').spawn(process.execPath, [__filename], { stdio: 'inherit' });
  }
})().catch((e) => { console.error('❌ ' + (e && e.message || e)); process.exit(1); });
