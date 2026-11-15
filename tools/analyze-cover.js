/**
 * tools/analyze-cover.js — 只读：把一张主图"量"出来（找色块横条的位置/尺寸/颜色/圆角）
 *
 * 为什么需要它（2026-10-07 给 hope 店建主图模版）：
 *   老板给了一张白底样板图，要把上面的粉色横条"逆向"成中台版式的文字层。
 *   目测估坐标一定会偏，而版式的 x/y/size/bgRadius 都是硬参数 ——
 *   所以直接按像素扫：找出粉色横条的行区间、每条的 x 跨度、主色、圆角半径。
 *
 * 用法:
 *   node tools/analyze-cover.js "publish-assets/hope-待建模版/王力宏-白底样板.jpg"
 */
const path = require('path');
const fs = require('fs');
const { ROOT, svcRequire } = require('../lib/env');
const sharp = svcRequire('node_modules/sharp');

const FILE = process.argv[2];
if (!FILE) { console.log('用法: node tools/analyze-cover.js "<图片路径>"'); process.exit(2); }
const f = path.isAbsolute(FILE) ? FILE : path.join(ROOT, FILE);
if (!fs.existsSync(f)) { console.log('❌ 找不到: ' + f); process.exit(2); }

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

(async () => {
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const px = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };

  // ── 配色统计：找出现最多的"非白非黑"颜色（应该就是横条色）──
  const hist = new Map();
  let white = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      if (r > 240 && g > 240 && b > 240) { white++; continue; }
      const k = (r >> 3) + ',' + (g >> 3) + ',' + (b >> 3);
      const e = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      hist.set(k, e);
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4)
    .map(([k, e]) => ({ c: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)], n: e.n, k }));

  console.log('图片: ' + path.basename(f) + '   ' + W + 'x' + H + '   比例=' + (W / H).toFixed(4));
  console.log('白色占比: ' + (white / (W * H) * 100).toFixed(1) + '%');
  console.log('主要非白颜色(前4):');
  top.forEach((t) => console.log('   ' + hex(t.c[0], t.c[1], t.c[2]) + '   rgb(' + t.c.join(',') + ')   ' +
    (t.n / (W * H) * 100).toFixed(2) + '% 像素'));

  // ── 用主色当"横条色"，扫描行区间 ──
  const main = top[0].c;
  const isBar = (r, g, b) => Math.abs(r - main[0]) < 45 && Math.abs(g - main[1]) < 45 && Math.abs(b - main[2]) < 45;
  const rowCnt = new Array(H).fill(0);
  for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) { const p = px(x, y); if (isBar(p[0], p[1], p[2])) c++; } rowCnt[y] = c; }

  const bands = [];
  let cur = null;
  for (let y = 0; y < H; y++) {
    const on = rowCnt[y] > W * 0.12;
    if (on && !cur) cur = { y0: y, y1: y };
    else if (on && cur) cur.y1 = y;
    else if (!on && cur) { if (cur.y1 - cur.y0 > 12) bands.push(cur); cur = null; }
  }
  if (cur && cur.y1 - cur.y0 > 12) bands.push(cur);

  // 合并被文字描边切开的行区间：同一根横条会因为黑色描边横穿整幅而被切成两段，
  // 段间缝隙一般 <1.5% 图高。不合并会把 4 条横条数成 6 条（2026-10-07 实际踩到）。
  const merged = [];
  bands.forEach((b) => {
    const last = merged[merged.length - 1];
    // 阈值 0.008（0.8% 图高）：实测「条内被描边切开」的缝是 2~6px（0.15%~0.44%），
    // 而「条与条之间」的缝是 16~17px（1.25%）。取 0.008 正好分开两者；
    // 取 0.015 会把相邻两条误并成一条（2026-10-07 实际踩到）。
    if (last && (b.y0 - last.y1) < H * 0.008) last.y1 = b.y1;
    else merged.push({ y0: b.y0, y1: b.y1 });
  });
  bands.length = 0;
  merged.forEach((b) => bands.push(b));

  console.log('\n检测到 ' + bands.length + ' 条横条（主色 ' + hex(main[0], main[1], main[2]) + '）：');
  bands.forEach((b, i) => {
    let minX = W, maxX = -1;
    for (let y = b.y0; y <= b.y1; y++) for (let x = 0; x < W; x++) { const p = px(x, y); if (isBar(p[0], p[1], p[2])) { if (x < minX) minX = x; if (x > maxX) maxX = x; } }
    // 圆角：顶部那一行的 x 跨度比中段窄，差值的一半 ≈ 半径
    let topMinX = W, topMaxX = -1;
    for (let x = 0; x < W; x++) { const p = px(x, b.y0 + 1); if (isBar(p[0], p[1], p[2])) { if (x < topMinX) topMinX = x; if (x > topMaxX) topMaxX = x; } }
    const radius = Math.max(0, Math.round(((maxX - minX) - (topMaxX - topMinX)) / 2));
    const h = b.y1 - b.y0 + 1, w = maxX - minX + 1;
    const cy = (b.y0 + b.y1) / 2, cx = (minX + maxX) / 2;
    console.log('  #' + (i + 1) +
      '  y ' + (b.y0 / H * 100).toFixed(1) + '%~' + (b.y1 / H * 100).toFixed(1) + '%' +
      '  →  中线上移定位: pos(y)=' + (cy / H * 100).toFixed(1) + '%' +
      '  x ' + (minX / W * 100).toFixed(1) + '%~' + (maxX / W * 100).toFixed(1) + '%' +
      '  →  中线(x)=' + (cx / W * 100).toFixed(1) + '%');
    console.log('       像素: 高' + h + ' 宽' + w + '  圆角≈' + radius + 'px (' + (radius / h).toFixed(2) + '×高)  ' +
      '字号≈' + Math.round(h * 0.62) + 'px');
  });

  // 相邻横条的间距（用来定 y 坐标）
  if (bands.length > 1) {
    console.log('\n条间距（上一底 → 下一顶，占图高）:');
    for (let i = 1; i < bands.length; i++) {
      console.log('  #' + i + '→#' + (i + 1) + ':  ' + (bands[i].y0 - bands[i - 1].y1) + 'px  (' +
        ((bands[i].y0 - bands[i - 1].y1) / H * 100).toFixed(1) + '%)');
    }
  }
  console.log('\n给版式用的汇总:');
  console.log('  图 ' + W + 'x' + H + '  横条色 ' + hex(main[0], main[1], main[2]));
  bands.forEach((b, i) => console.log('  layer' + i + ': y=' + ((b.y0 + b.y1) / 2 / H * 100).toFixed(1) +
    '% (底色块高 ' + ((b.y1 - b.y0 + 1) / H * 100).toFixed(1) + '% 图高)'));
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
