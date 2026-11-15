/**
 * tools/make-cover-lite.js — 「底条版」主图生成器（正式版，学员可用）
 *
 * 一句话：老板/大麦给的海报【原样保留、一个字不挡】，只在底部压一条不透明信息带，
 *        把「谁 · 哪场 · 哪天」+「信任背书」+「价格钩子」三件事收在条里。
 *
 * 为什么要它（2026-10-28 起的实测）：
 *   店里原有三套版式（xuliang-v1 / tpl_redtext / __shoukai）都把「7级店铺 / 3千+好评 /
 *   命中率100%」压在海报中上部 —— 正好盖住买家最想看的演出名和日期；
 *   tpl_redtext 更糟：城市+明星超过 8 字时，顶部文字层会撑破画布、左右被切边。
 *   底条版把这些信息挪到画面底部，主体（人物 + 演出大字）完全不被遮挡。
 *
 * 三种用法（学员用第 1 种就够了）：
 *
 *   ① 交互式（推荐，问 4 个问题就出图）
 *      node tools/cover.js
 *
 *   ② 参数式
 *      node tools/make-cover-lite.js <海报> "<第一行>" ["<第二行>"] ["<角标>"] [--out=<输出>]
 *      node tools/make-cover-lite.js D:\海报.jpg "深圳好势乘双 · 11.27 深圳体育中心"
 *
 *   ③ 规格文件式（中文参数走文件，最不容易被 PowerShell 吃掉字符）
 *      node tools/make-cover-lite.js --spec=cover.json
 *      cover.json: { "poster":"...", "out":"...", "line1":"...", "line2":"...", "badge":"...", "barRatio":0.195 }
 *
 * 输出：默认 publish-out/成品-<时间戳>.jpg（3:4，JPEG 质量 92）
 *
 * 发到闲鱼时怎么用（关键）：
 *   这张是【成品图】→ 发布时走 mainImg（整张直用、不叠任何版式），不是 baseImg。
 *   publish-group 方案文件里写：  "mainImg": "D:\\DSH\\achun\\publish-out\\成品-xxx.jpg"
 *   或 publish-one.js 前设环境变量：  $env:KUN_MAIN_IMG="...成品-xxx.jpg"
 *
 * 参数默认值（不给就用这些，都是店里验证过的文案）：
 *   line2 = 7级店铺 · 3千+好评 · 不中全额退
 *   badge = ¥50 起 代拍
 *   barRatio = 0.195（底条占高度 19.5%）
 */
const path = require('path');
const fs = require('fs');
const { svcRequire } = require('../lib/env');

const FONT = "'Microsoft YaHei','msyh','Noto Sans CJK SC','PingFang SC',sans-serif";
const DEFAULT_LINE2 = '7级店铺 · 3千+好评 · 不中全额退';
const DEFAULT_BADGE = '¥50 起 代拍';
const DEFAULT_BAR = 0.195;

function sharpLib() {
  try { return svcRequire('node_modules/sharp'); }
  catch (e) {
    throw new Error('找不到 sharp（它在 playwright-service 的 node_modules 里）。先跑一次 install.ps1，或确认三个仓库并排放着。');
  }
}

/** 取海报左边中点的像素色，用来补边（海报边缘通常是大面积纯色） */
async function edgeColor(sharp, p, w, h) {
  try {
    const { data } = await sharp(p).extract({ left: 0, top: Math.floor(h / 2), width: 1, height: 1 })
      .raw().toBuffer({ resolveWithObject: true });
    return { r: data[0], g: data[1], b: data[2], alpha: 1 };
  } catch (e) {
    return { r: 12, g: 12, b: 16, alpha: 1 };
  }
}

/** 把任意比例的海报补成精确 3:4（不裁、不丢内容） */
async function to3x4(sharp, poster) {
  const m = await sharp(poster).metadata();
  const ratio = m.width / m.height;
  if (Math.abs(ratio - 0.75) < 0.004) return { buf: await sharp(poster).jpeg({ quality: 95 }).toBuffer(), patched: false, w: m.width, h: m.height };

  let W = m.width, H = m.height;
  if (ratio > 0.75) H = Math.round(W / 0.75);        // 太宽 → 补上下
  else W = Math.round(H * 0.75);                     // 太高 → 补左右
  const bg = await edgeColor(sharp, poster, m.width, m.height);
  const buf = await sharp(poster)
    .resize(W, H, { fit: 'contain', background: bg, position: 'center' })
    .jpeg({ quality: 95 }).toBuffer();
  return { buf, patched: true, w: W, h: H, bg };
}

/**
 * 出图主函数
 * @param {{poster:string,line1:string,line2?:string,badge?:string,out?:string,barRatio?:number}} o
 * @returns {Promise<{out:string,w:number,h:number,kb:number,patched:boolean,line1:string,line2:string,badge:string}>}
 */
async function renderCover(o) {
  const sharp = sharpLib();
  if (!o || !o.poster) throw new Error('缺少 poster（海报路径）');
  const poster = path.resolve(o.poster);
  if (!fs.existsSync(poster)) throw new Error('海报文件不存在：' + poster);

  const line1 = String(o.line1 || '').trim();
  if (!line1) throw new Error('缺少 line1（底条第一行，建议写「城市+场次 · 日期 场馆」）');
  const line2 = (o.line2 === undefined ? DEFAULT_LINE2 : String(o.line2)).trim();
  const badge = (o.badge === undefined ? DEFAULT_BADGE : String(o.badge)).trim();
  const barRatio = Number(o.barRatio) > 0.08 && Number(o.barRatio) < 0.35 ? Number(o.barRatio) : DEFAULT_BAR;

  const out = path.resolve(o.out || path.join('publish-out', '成品-' + Date.now() + '.jpg'));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const base = await to3x4(sharp, poster);
  const W = base.w, H = base.h;
  const BAR_H = Math.round(H * barRatio);
  const barY = H - BAR_H;
  const FADE_H = Math.round(BAR_H * 0.28);

  // 字号按画布宽度自适应；长文案自动缩，避免撑破（tpl_redtext 就是栽在这）
  const fs1 = Math.min(Math.round(W * 0.034), Math.floor((W * 0.62) / Math.max(1, line1.length)) * 1.55);
  const fs2 = Math.min(Math.round(W * 0.034), Math.floor((W * 0.62) / Math.max(1, line2.length)) * 1.55);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#08080c" stop-opacity="0"/>
      <stop offset="100%" stop-color="#08080c" stop-opacity="1"/>
    </linearGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ff2d55"/>
      <stop offset="100%" stop-color="#ff9500"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${barY}" width="${W}" height="${FADE_H}" fill="url(#bar)"/>
  <rect x="0" y="${barY + FADE_H}" width="${W}" height="${BAR_H - FADE_H}" fill="#08080c"/>
  <rect x="0" y="${barY + FADE_H}" width="${W}" height="${Math.max(4, Math.round(H * 0.003))}" fill="url(#acc)"/>
  <text x="${Math.round(W * 0.035)}" y="${barY + Math.round(BAR_H * 0.38)}"
        font-family="${FONT}" font-size="${fs1}" font-weight="700" fill="#ffffff">${esc(line1)}</text>
  <text x="${Math.round(W * 0.035)}" y="${barY + Math.round(BAR_H * 0.76)}"
        font-family="${FONT}" font-size="${fs2}" font-weight="700" fill="#ffd60a">${esc(line2)}</text>
  <g>
    <rect x="${W - Math.round(W * 0.30)}" y="${barY + Math.round(BAR_H * 0.47)}"
          width="${Math.round(W * 0.265)}" height="${Math.round(BAR_H * 0.38)}" rx="${Math.round(BAR_H * 0.19)}" fill="#ff2d55"/>
    <text x="${W - Math.round(W * 0.1675)}" y="${barY + Math.round(BAR_H * 0.735)}"
          font-family="${FONT}" font-size="${Math.round(W * 0.031)}" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(badge)}</text>
  </g>
</svg>`;

  await sharp(base.buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(out);

  return { out, w: W, h: H, kb: +(fs.statSync(out).size / 1024).toFixed(0), patched: base.patched, line1, line2, badge };
}

module.exports = { renderCover, DEFAULT_LINE2, DEFAULT_BADGE };

// ── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const specArg = argv.find((a) => a.startsWith('--spec='));
    let o = {};
    if (specArg) {
      const f = specArg.slice(7);
      if (!fs.existsSync(f)) { console.error('❌ 规格文件不存在：' + f); process.exit(2); }
      o = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    } else {
      const pos = argv.filter((a) => !a.startsWith('--'));
      o = {
        poster: pos[0], line1: pos[1],
        line2: pos[2] !== undefined ? pos[2] : undefined,
        badge: pos[3] !== undefined ? pos[3] : undefined,
        out: (argv.find((a) => a.startsWith('--out=')) || '').slice(6) || undefined,
        barRatio: process.env.BAR_RATIO ? Number(process.env.BAR_RATIO) : undefined,
      };
    }
    if (!o.poster || !o.line1) {
      console.log('用法:');
      console.log('  node tools/make-cover-lite.js <海报> "<第一行>" ["<第二行>"] ["<角标>"] [--out=文件]');
      console.log('  node tools/make-cover-lite.js --spec=cover.json');
      console.log('  node tools/cover.js        ← 交互式，不知道参数就用这个');
      process.exit(2);
    }
    const r = await renderCover(o);
    console.log('✅ 出图: ' + r.out);
    console.log('   ' + r.w + 'x' + r.h + '  ' + r.kb + 'KB' + (r.patched ? '  （原图比例不是 3:4，已补边、内容未裁）' : '  （原图已是 3:4，未裁未补）'));
    console.log('   第一行: ' + r.line1);
    console.log('   第二行: ' + r.line2);
    console.log('   角  标: ' + r.badge);
    console.log('');
    console.log('发到闲鱼时用 mainImg（整张直用、不叠版式）：');
    console.log('   publish-group 方案里写  "mainImg": "' + r.out.replace(/\\/g, '\\\\') + '"');
    console.log('   或 publish-one 前设  $env:KUN_MAIN_IMG="' + r.out + '"');
  })().catch((e) => { console.error('❌ ' + (e && e.message || e)); process.exit(1); });
}
