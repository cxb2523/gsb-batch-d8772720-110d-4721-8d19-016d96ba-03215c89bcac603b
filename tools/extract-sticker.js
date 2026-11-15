/**
 * tools/extract-sticker.js — 从「白底贴纸图」里抠出贴纸形状，重建成干净的透明 PNG
 *
 * 为什么需要它（2026-10-07 给 hope 店建"红色爆炸贴"版式）：
 *   老板给的爆炸贴是**成品截图**（白底 + 红爆炸贴 + 白字黑边 + 小红书水印），不是分层素材。
 *   第一版做法是"抠背景 + 把文字修补成红色"—— **不行**：残留描边幽灵 + 逐行取中位红产生横带条纹。
 *
 * 现在的做法（只取形状，不要原图颜色）：
 *   ① 从四边泛洪填充背景白 → 贴纸轮廓（贴纸内部的白色文字被围住，连通不出去，安全）
 *   ② 只保留**最大连通块** → 顺手把小红书水印那种零散小块扔掉
 *   ③ 距离变换：距背景 ≤ 描边宽 → 填黑（描边）；否则 → 填红（贴纸本体）
 *   ⇒ 文字不会出现在结果里（压根没用原图颜色），条纹也不会有
 *
 * 用法:
 *   node tools/extract-sticker.js <输入图> <输出png> [--red=#DF2F31] [--outline=13] [--preview=预览.png]
 */
const path = require('path');
const fs = require('fs');
const { ROOT, svcRequire } = require('../lib/env');
const sharp = svcRequire('node_modules/sharp');

const args = process.argv.slice(2);
const IN = args[0], OUT = args[1];
const opt = (k, d) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const PREVIEW = opt('preview', '');
const RED = opt('red', '#DF2F31');                   // 贴纸本体色（笔刷条就传黄色）
const OUTLINE_ARG = opt('outline', 'auto');          // 'auto' = 按短边 1.8% 算；给数字就用这个（0 = 不要描边）
const OUTLINE_COLOR = opt('outlineColor', '#0C0C0E');
if (!IN || !OUT) { console.log('用法: node tools/extract-sticker.js <输入图> <输出png> [--red=#DF2F31] [--outline=13] [--preview=预览.png]'); process.exit(2); }
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const hex2rgb = (h) => { const m = h.replace('#', ''); return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]; };

(async () => {
  const { data, info } = await sharp(resolve(IN)).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels, N = W * H;

  // ① 背景 = 能从四边连通过去的"亮且不饱和"像素。
  //    阈值放宽到 225（不是 232）：小红书水印那层浅灰要能被穿过，否则水印会被当成贴纸的一部分。
  const isBg = (p) => {
    const i = p * C, r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mn > 225 && (mx - mn) < 22;
  };
  const outside = new Uint8Array(N);
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push(x, 0, x, H - 1); }
  for (let y = 0; y < H; y++) { stack.push(0, y, W - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (outside[p] || !isBg(p)) continue;
    outside[p] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  // ② 只保留最大连通块（扔掉水印等零散小块）
  //    两种模式：
  //      mode=bg（默认）：轮廓 = 所有"非背景"像素。适合**有黑描边**的贴纸（爆炸贴）。
  //      mode=color     ：轮廓 = 与 --red 颜色接近的像素，再**逐列 minY~maxY 补洞**。
  //        适合"实色形状 + 文字压在它上面、且文字比形状高"的情况（黄色笔刷条）——
  //        此时非背景连通块会把露在上面的字一起圈进来，必须按颜色取。
  const MODE = opt('mode', 'bg');
  const [TR, TG, TB] = hex2rgb(RED);
  const near = (p) => {
    const i = p * C;
    return Math.abs(data[i] - TR) < 60 && Math.abs(data[i + 1] - TG) < 60 && Math.abs(data[i + 2] - TB) < 60;
  };
  const isShape = MODE === 'color' ? near : (p) => !outside[p];

  const seen = new Uint8Array(N);
  let best = null;
  for (let s = 0; s < N; s++) {
    if (!isShape(s) || seen[s]) continue;
    const comp = [];
    const q = [s]; seen[s] = 1;
    for (let head = 0; head < q.length; head++) {
      const p = q[head]; comp.push(p);
      const x = p % W, y = (p / W) | 0;
      const nb = [];
      if (x > 0) nb.push(p - 1); if (x < W - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - W); if (y < H - 1) nb.push(p + W);
      for (const m of nb) if (isShape(m) && !seen[m]) { seen[m] = 1; q.push(m); }
    }
    if (!best || comp.length > best.length) best = comp;
  }
  if (!best) { console.log('❌ 没找到任何非背景区域'); process.exit(1); }
  const mask = new Uint8Array(N);
  best.forEach((p) => { mask[p] = 1; });

  if (MODE === 'color') {
    // 逐列取上下包络，再填。
    // ⚠️ 不能只按"本列的 minY~maxY"填（第一版就是这么写的，出来是**阶梯缺口**）：
    //    文字压在形状上时，被遮住的是**形状的顶边**，该列第一个黄像素被推到了文字下面 ——
    //    min~max 只在"中间有洞"时管用，管不了"顶边被吃掉"。
    //    所以对每列取**滑动窗口内的最小 minY / 最大 maxY**（上/下包络），把被文字吃掉的边桥回来。
    const colMin = new Int32Array(W).fill(-1), colMax = new Int32Array(W).fill(-1);
    best.forEach((p) => { const x = p % W, y = (p / W) | 0;
      if (colMin[x] < 0 || y < colMin[x]) colMin[x] = y;
      if (y > colMax[x]) colMax[x] = y; });
    const K = Math.max(8, Math.round(W * 0.035));
    const top = new Int32Array(W).fill(-1), bot = new Int32Array(W).fill(-1);
    for (let x = 0; x < W; x++) {
      let mn = -1, mx = -1;
      for (let d = -K; d <= K; d++) {
        const xx = x + d; if (xx < 0 || xx >= W) continue;
        if (colMin[xx] >= 0) { if (mn < 0 || colMin[xx] < mn) mn = colMin[xx]; }
        if (colMax[xx] > mx) mx = colMax[xx];
      }
      top[x] = mn; bot[x] = mx;
    }
    for (let x = 0; x < W; x++) if (top[x] >= 0) for (let y = top[x]; y <= bot[x]; y++) mask[y * W + x] = 1;
  }

  // ③ 距离变换（源=背景/外部），用来切出描边环
  const dist = new Int32Array(N).fill(-1);
  const q2 = [];
  for (let p = 0; p < N; p++) if (!mask[p]) { dist[p] = 0; q2.push(p); }
  for (let head = 0; head < q2.length; head++) {
    const p = q2[head], x = p % W, y = (p / W) | 0;
    const nb = [];
    if (x > 0) nb.push(p - 1); if (x < W - 1) nb.push(p + 1);
    if (y > 0) nb.push(p - W); if (y < H - 1) nb.push(p + W);
    for (const m of nb) if (dist[m] < 0) { dist[m] = dist[p] + 1; q2.push(m); }
  }

  let minX = W, maxX = -1, minY = H, maxY = -1;
  best.forEach((p) => { const x = p % W, y = (p / W) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; });
  const shortSide = Math.min(maxX - minX + 1, maxY - minY + 1);
  const outline = OUTLINE_ARG === 'auto' ? Math.max(4, Math.round(shortSide * 0.018)) : Number(OUTLINE_ARG);

  const [R, G, B] = hex2rgb(RED);
  const [OR, OG, OB] = hex2rgb(OUTLINE_COLOR);
  const out = Buffer.alloc(N * 4);
  for (let p = 0; p < N; p++) {
    const o = p * 4;
    if (!mask[p]) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
    if (outline > 0 && dist[p] <= outline) { out[o] = OR; out[o + 1] = OG; out[o + 2] = OB; }   // 描边
    else { out[o] = R; out[o + 1] = G; out[o + 2] = B; }                                          // 本体
    out[o + 3] = 255;
  }

  const bx = maxX - minX + 1, by = maxY - minY + 1;
  // 输出**裁到包围盒**的紧致 PNG —— 整张画布的话外面全是透明像素，
  // 合成时按"宽高比"算尺寸会算错（2026-10-07 实际踩到：873 宽算出 1151 高，实际只有 520）。
  const png = await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: minX, top: minY, width: bx, height: by }).png().toBuffer();
  fs.writeFileSync(resolve(OUT), png);
  console.log('抠图完成: ' + OUT + '  ' + Math.round(png.length / 1024) + ' KB   贴纸色 ' + RED + '  描边宽 ' + outline + 'px');
  console.log('  紧致尺寸: ' + bx + 'x' + by + '   在原图位置 x ' + (minX / W * 100).toFixed(1) + '%~' + (maxX / W * 100).toFixed(1) +
    '%  y ' + (minY / H * 100).toFixed(1) + '%~' + (maxY / H * 100).toFixed(1) + '%');
  console.log('  中线: x=' + ((minX + maxX) / 2 / W * 100).toFixed(1) + '%  y=' + ((minY + maxY) / 2 / H * 100).toFixed(1) + '%');
  console.log('  尺寸占原图: 宽 ' + (bx / W * 100).toFixed(1) + '%  高 ' + (by / H * 100).toFixed(1) + '%');

  if (PREVIEW) {
    const bg = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
    fs.writeFileSync(resolve(PREVIEW), await sharp(bg).composite([{ input: png, left: minX, top: minY }]).png().toBuffer());
    console.log('  预览(灰底，按原位置): ' + PREVIEW);
  }
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
