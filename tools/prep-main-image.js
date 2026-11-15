/**
 * tools/prep-main-image.js — 把任意比例的图处理成闲鱼主图用的 3:4，且【不丢内容】
 *
 * 为什么需要它：
 *   publish-one.js 的 KUN_MAIN_IMG 分支原来一律「按 3:4 居中裁」。
 *   老板给的演唱会海报常是 2:3（如 1282x1924），裁 3:4 会上下各切 5.6% ——
 *   而海报的顶部（演出名）和底部（城市/日期/场馆）正好都在被切的位置。
 *   所以改成默认【补边】：保持原图完整，左右/上下补到 3:4，补边色从图像边缘取样。
 *
 * 用法:
 *   node tools/prep-main-image.js <输入图> [输出图] [--crop]
 *   不给输出路径 → 同目录 <名>-3x4.jpg；--crop 则走原来的居中裁
 */
const path = require('path');
const fs = require('fs');
const { PATHS, svcRequire } = require('../lib/env');
const SVC = PATHS.playwrightService;
const sharp = svcRequire('node_modules/sharp');

const IN = process.argv[2];
if (!IN || !fs.existsSync(IN)) { console.log('用法: node tools/prep-main-image.js <输入图> [输出图] [--crop]'); process.exit(2); }
const CROP = process.argv.includes('--crop');
const OUT = (process.argv[3] && !process.argv[3].startsWith('--'))
  ? process.argv[3]
  : path.join(path.dirname(IN), path.basename(IN, path.extname(IN)) + '-3x4.jpg');

(async () => {
  const buf = fs.readFileSync(IN);
  const m = await sharp(buf).metadata();
  const w = m.width, h = m.height, r = w / h;
  console.log('输入: ' + IN);
  console.log('  ' + w + 'x' + h + '   比例 ' + r.toFixed(4) + '   (3:4 = 0.7500)');

  if (Math.abs(r - 0.75) <= 0.005) {
    fs.writeFileSync(OUT, buf);
    console.log('  ✅ 已经是 3:4，原样输出 → ' + OUT);
    return;
  }

  if (CROP) {
    const cw = r > 0.75 ? Math.round(h * 3 / 4) : w;
    const ch = r > 0.75 ? h : Math.round(w * 4 / 3);
    await sharp(buf).extract({ left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch })
      .jpeg({ quality: 95 }).toFile(OUT);
    console.log('  ✂️ 居中裁 → ' + cw + 'x' + ch + '  (切掉 ' + (h - ch ? ((h - ch) + 'px 高') : ((w - cw) + 'px 宽')) + ')');
    console.log('  → ' + OUT);
    return;
  }

  // 补边：算 3:4 的目标画布，保持原图完整
  const tw = r > 0.75 ? w : Math.round(h * 3 / 4);
  const th = r > 0.75 ? Math.round(w * 4 / 3) : h;

  // 补边色：取原图左右（或上下）边缘各 3px 的平均色，避免白边/黑边突兀
  const strip = r < 0.75
    ? { left: 0, top: 0, width: Math.min(3, w), height: h }          // 竖图 → 补左右，取样左边缘
    : { left: 0, top: 0, width: w, height: Math.min(3, h) };          // 横图 → 补上下，取样上边缘
  const st = await sharp(buf).extract(strip).stats();
  const bg = { r: Math.round(st.channels[0].mean), g: Math.round(st.channels[1].mean), b: Math.round(st.channels[2].mean) };
  console.log('  补边色（边缘取样）: rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')');

  await sharp(buf)
    .resize({ width: tw, height: th, fit: 'contain', background: bg, position: 'centre' })
    .jpeg({ quality: 95 })
    .toFile(OUT);

  const m2 = await sharp(OUT).metadata();
  console.log('  🖼 补边 → ' + tw + 'x' + th + '  （原图完整保留，' +
    (r < 0.75 ? '左右各补 ' + Math.round((tw - w) / 2) + 'px' : '上下各补 ' + Math.round((th - h) / 2) + 'px') + '）');
  console.log('  输出: ' + OUT + '   实际 ' + m2.width + 'x' + m2.height + '   比例 ' + (m2.width / m2.height).toFixed(4));
})();
