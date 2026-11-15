/**
 * tools/make-cover-full.js —— 「顶条 + 海报 + 底条」三段式主图（3:4，海报一字不挡）
 *
 * ⛔⛔ 2026-11-12 起【停用】—— 不要用它出店铺主图 ⛔⛔
 *   老板看了效果后原话：「我之前的主图模版呢，现在这个不显眼啊」。
 *   他要的一直是店里那套现役版式（xuliang-v1 三黄块+一紫块 / __shoukai 紫块+三行红字）。
 *   本店主图的唯一正确姿势： KUN_BASE_IMG=<官方海报> + KUN_MAIN_TPL=<版式 key>
 *   （模板池见 stores/好易美代拍.json 的 主图.templates，现在只有上面两个 key）
 *   本文件保留，仅供「老板书面要求做不带版式的信息图」时参考。
 *   调用前请确认：这是老板要的，不是我自己图省事。
 *
 * 为什么当时写它（留作教训）：
 *   这张官方海报【顶部本身就有大字】（OW 徽标 + WORLD FINALS），
 *   任何覆盖式版式都会撞，于是我自作主张改成"加边不覆盖"——
 *   技术上没毛病，但【做的不是老板要的东西】。技术取舍不能替代业务判断。
 *
 * ---- 以下为原始说明 ----
 *
 * 为什么再写一个（2026-11-12，老板两次打回之后）：
 *   `make-cover-lite`（底条版）→ 老板说「主图版式没有加」（没有店铺黄块版式特征）
 *   现役版式 + 底图           → 文字层铺满 y=12/32/48/66/82，压住海报主体
 *   底条版 + 顶部黄块覆盖     → 黄块必然压住海报自带的 logo / WORLD FINALS
 *
 *   根因：这张官方海报【顶部本身就有大字】，任何"覆盖式"版式都会撞。
 *   所以改成【加边不覆盖】：整张画布加高，顶部一条黄块版式带、底部一条信息带，
 *   海报整体缩进中间，**一个字都不挡**。
 *
 * 版式（1290×1720，3:4）：
 *   ┌───────────────────────────┐
 *   │  黄块：广州守望先锋        │  110px   ← 版式带（店铺识别）
 *   ├───────────────────────────┤
 *   │                           │
 *   │      官方海报（完整）       │ 1400px   ← 不裁不盖
 *   │                           │
 *   ├───────────────────────────┤
 *   │ 场次·日期·场馆             │  210px   ← 信息带
 *   │ 背书          [¥50 起]     │
 *   └───────────────────────────┘
 *
 * 用法:
 *   node tools/make-cover-full.js --poster=<海报> --out=<输出> \
 *        --top="广州守望先锋" \
 *        --line1="广州守望先锋全球总决赛 · 12.4-12.6 广州体育馆" \
 *        [--line2="7级店铺 · 3千+好评 · 不中全额退"] [--badge="¥50 起 代拍"] \
 *        [--topColor=#FFD400] [--topText=#111111]
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../lib/env');

const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

const POSTER = A.poster;
const OUT = A.out;
const TOP = A.top || '广州守望先锋';
const LINE1 = A.line1;
const LINE2 = A.line2 || '7级店铺 · 3千+好评 · 不中全额退';
const BADGE = A.badge || '¥50 起 代拍';
const TOP_BG = A.topColor || '#FFD400';
const TOP_FG = A.topText || '#111111';
const BAR_BG = A.barColor || '#101010';
const BAR_FG = A.barText || '#FFD400';

if (!POSTER || !OUT || !LINE1) {
  console.log('用法: node tools/make-cover-full.js --poster=<海报> --out=<输出> --top="广州守望先锋" --line1="…" [--line2="…"] [--badge="…"]');
  process.exit(2);
}
if (!fs.existsSync(POSTER)) { console.log('❌ 海报不存在: ' + POSTER); process.exit(1); }

const W = 1290, H = 1720;          // 3:4
const TOP_H = 110;
const BAR_H = 210;
const MID_H = H - TOP_H - BAR_H;   // 1400

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(async () => {
  const sharp = require(path.join(PATHS.playwrightService, 'node_modules', 'sharp'));

  // 1. 海报缩到中间区（等比，不裁）
  const meta = await sharp(fs.readFileSync(POSTER)).metadata();
  const scale = Math.min(W / meta.width, MID_H / meta.height);
  const pw = Math.round(meta.width * scale);
  const ph = Math.round(meta.height * scale);
  const posterBuf = await sharp(fs.readFileSync(POSTER)).resize(pw, ph, { fit: 'inside' }).jpeg({ quality: 95 }).toBuffer();

  // 2. 顶条（黄块 + 场次名）
  const topSvg = `<svg width="${W}" height="${TOP_H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${TOP_H}" fill="${TOP_BG}"/>
    <text x="${W / 2}" y="${TOP_H / 2 + 34}" font-family="Microsoft YaHei, PingFang SC, sans-serif"
          font-size="68" font-weight="bold" fill="${TOP_FG}" text-anchor="middle">${esc(TOP)}</text>
  </svg>`;

  // 3. 底条（信息 + 角标）
  const badgeW = 300, badgeH = 74, badgeX = W - badgeW - 40, badgeY = 118;
  const barSvg = `<svg width="${W}" height="${BAR_H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${BAR_H}" fill="${BAR_BG}"/>
    <rect x="0" y="0" width="${W}" height="3" fill="${TOP_BG}"/>
    <text x="40" y="62" font-family="Microsoft YaHei, PingFang SC, sans-serif"
          font-size="38" font-weight="bold" fill="#ffffff">${esc(LINE1)}</text>
    <text x="40" y="140" font-family="Microsoft YaHei, PingFang SC, sans-serif"
          font-size="40" font-weight="bold" fill="${BAR_FG}">${esc(LINE2)}</text>
    <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="37" fill="#ff4d6a"/>
    <text x="${badgeX + badgeW / 2}" y="${badgeY + 50}" font-family="Microsoft YaHei, PingFang SC, sans-serif"
          font-size="34" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(BADGE)}</text>
  </svg>`;

  // 4. 合图
  const out = await sharp({
    create: { width: W, height: H, channels: 3, background: '#0a0a0a' }
  })
    .composite([
      { input: await sharp(Buffer.from(topSvg)).png().toBuffer(), top: 0, left: 0 },
      { input: posterBuf, top: TOP_H + Math.round((MID_H - ph) / 2), left: Math.round((W - pw) / 2) },
      { input: await sharp(Buffer.from(barSvg)).png().toBuffer(), top: H - BAR_H, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  fs.writeFileSync(OUT, out);
  console.log('✅ ' + OUT);
  console.log('   ' + W + 'x' + H + '  ' + Math.round(out.length / 1024) + 'KB');
  console.log('   顶条 ' + TOP_H + 'px ｜ 海报 ' + pw + 'x' + ph + '（原图 ' + meta.width + 'x' + meta.height + '，等比不裁）｜ 底条 ' + BAR_H + 'px');
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
