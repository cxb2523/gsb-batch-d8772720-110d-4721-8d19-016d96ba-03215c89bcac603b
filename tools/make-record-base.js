/**
 * tools/make-record-base.js — 生成「近期战绩」副图的底图
 *
 * 背景（2026-10-07 hope 店，由老板给的两张样板逆向）：
 *   样板 = ① 浅蓝色调的**瓦片马赛克**底  ② 中部**官方海报**（带白边）
 *          ③ 顶部红条「{城市}{明星}」    ④ 底部大红字「近期战绩」
 *   其中 ③④ 由版式 tpl_hope_record 叠（本工具不管），本工具产出 ①②。
 *
 * 两张样板对比出来的关键结论：
 *   **订单截图每场次不同，但瓦片"类型混排"是一样的** —— 所以马赛克是
 *   「固定风格背景 + 每场次替换订单截图」，可以程序化生成，不需要老板给背景素材。
 *   瓦片类型（全部用 SVG 画，不用抠素材）：
 *     shot  订单截图（cover 裁剪）
 *     badge 红底白字「中了」
 *     logo  白底圆 + 深色「好」
 *     label 竖排白条「票务 · 明星周边」
 *     strip 小标注条「{城市}{明星} {日期}，{价格} 单张」
 *
 * 用法:
 *   node tools/make-record-base.js --star=刘宇宁 --city=成都 --shots=<订单截图目录> --out=<输出png>
 *   node tools/make-record-base.js --star=刘宇宁 --city=成都 --shots=... --out=... --noPoster    # 只要马赛克
 */
const path = require('path');
const fs = require('fs');
const { post } = require('../lib/http');
const { ROOT, svcRequire } = require('../lib/env');
const sharp = svcRequire('node_modules/sharp');

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const STAR = opt('star', ''), CITY = opt('city', ''), SHOTS = opt('shots', ''), OUT = opt('out', '');
if (!STAR || !CITY || !SHOTS || !OUT) {
  console.log('用法: node tools/make-record-base.js --star=<明星> --city=<城市> --shots=<截图目录> --out=<输出png>');
  process.exit(2);
}
const W = Number(opt('w', 1179)), H = Number(opt('h', 1564));
const COLS = Number(opt('cols', 6));
const TINT = opt('tint', '#A5CEEE');
const TINT_ALPHA = Number(opt('tintAlpha', 0.55));
const POSTER_H = Number(opt('posterH', 0.52));   // 海报【高】占图高（主控）—— 三张样板比出来：宽占比 33% vs 50% 不一样，但高度接近，说明设计是按高度定的
const POSTER_W = Number(opt('posterW', 0));     // >0 时覆盖上面的高度规则
const POSTER_CY = Number(opt('posterCy', 0.50));  // 海报中心 y（占图高）
const CAPTION = opt('caption', '');           // 例：1.10，980 单张
const NO_POSTER = argv.includes('--noPoster');
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const hex2rgb = (h) => { const m = h.replace('#', ''); return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]; };
const FONT = '"Microsoft YaHei","PingFang SC",sans-serif';
// ⚠️ FONT 里含双引号，写进 SVG 属性必须用【单引号】包住属性值，
//    否则 `font-family="Microsoft YaHei","PingFang SC"...` 会把属性截断 → librsvg 报 XML 解析错。
const FONT_ATTR = "'" + FONT + "'";
const svg = (w, h, inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`);

/** 确定性伪随机：同样的输入永远给同样的排布（方案=执行，别每次跑都不一样） */
function rng(seed) { let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296; }

const TILES = {
  badge: (w, h) => svg(w, h, `<rect width="${w}" height="${h}" fill="#E60012"/><text x="${w / 2}" y="${h / 2}" font-family=${FONT_ATTR} font-size="${Math.round(h * 0.42)}" font-weight="bold" fill="#fff" text-anchor="middle" dominant-baseline="central">中了</text>`),
  logo: (w, h) => svg(w, h, `<rect width="${w}" height="${h}" fill="#DCEBFA"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.round(Math.min(w, h) * 0.36)}" fill="#fff"/><text x="${w / 2}" y="${h / 2}" font-family=${FONT_ATTR} font-size="${Math.round(Math.min(w, h) * 0.42)}" font-weight="bold" fill="#222" text-anchor="middle" dominant-baseline="central">好</text>`),
  label: (w, h) => {
    const chars = '演出·票务·明星周边'.split('');
    // 字号要同时满足：不超格宽，且【整串竖排塞得进格高】—— 否则末尾几个字画到格外被裁掉
    // （2026-10-07 实测：固定 0.24*min 时「票务·明星周边」只出得来「票务·明星」）。
    const fs2 = Math.min(Math.round(w * 0.24), Math.floor(h * 0.82 / (chars.length * 1.12)));
    const inner = chars.map((c, i) => `<text x="${w / 2}" y="${Math.round(h * 0.09 + i * fs2 * 1.12 + fs2 / 2)}" font-family=${FONT_ATTR} font-size="${fs2}" font-weight="bold" fill="#1a1a1a" text-anchor="middle" dominant-baseline="central">${c}</text>`).join('');
    return svg(w, h, `<rect width="${w}" height="${h}" fill="#EAF3FC"/><rect x="${Math.round(w * 0.30)}" y="${Math.round(h * 0.05)}" width="${Math.round(w * 0.40)}" height="${Math.round(h * 0.90)}" rx="10" fill="#fff"/>${inner}`);
  },
  // 品牌瓦片：白卡片 + 蓝色「好易美」（样板里那张牌）。
  // ⚠️ 样板里是**真 logo**（蓝色机器人吉祥物 + 「好易美」），这里是 SVG 画的同款占位 ——
  //    老板给了 logo PNG 就换成图片，画的不如真 logo 像。
  brand: (w, h) => svg(w, h,
    `<rect width="${w}" height="${h}" fill="#DCEBFA"/>` +
    `<rect x="${Math.round(w * 0.10)}" y="${Math.round(h * 0.30)}" width="${Math.round(w * 0.80)}" height="${Math.round(h * 0.40)}" rx="${Math.round(w * 0.08)}" fill="#fff"/>` +
    `<circle cx="${Math.round(w * 0.26)}" cy="${Math.round(h * 0.50)}" r="${Math.round(w * 0.085)}" fill="#3AA0F0"/>` +
    `<text x="${Math.round(w * 0.62)}" y="${Math.round(h * 0.50)}" font-family=${FONT_ATTR} font-size="${Math.round(w * 0.19)}" font-weight="bold" fill="#1E88E5" text-anchor="middle" dominant-baseline="central">好易美</text>`),
};
/** 小标注条：白底 + 黑字，压在瓦片顶部（样板里每条截图上方都有） */
const stripSvg = (w, h, text) => svg(w, h,
  `<rect width="${w}" height="${h}" fill="#ffffff" fill-opacity="0.94"/>` +
  `<text x="10" y="${h / 2}" font-family=${FONT_ATTR} font-size="${Math.round(h * 0.52)}" fill="#111" dominant-baseline="central">${String(text).replace(/[<>&]/g, '')}</text>`);

async function buildMosaic(dir, city, star, caption) {
  const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (!files.length) throw new Error('目录里没有图: ' + dir);
  const cellW = Math.ceil(W / COLS);
  const cellH = Math.round(cellW * 1.35);
  const rows = Math.ceil(H / cellH);
  const rand = rng(city + star);
  const inputs = [];
  const capW = Math.round(cellW * 0.92), capH = Math.round(cellH * 0.11);
  let shotIdx = 0, nBadge = 0, nLogo = 0, nLabel = 0, nBrand = 0, nStrip = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const left = c * cellW, top = r * cellH;
      const roll = rand();
      if (roll < 0.14) {           // 中了徽章
        inputs.push({ input: await sharp(TILES.badge(cellW, cellH)).png().toBuffer(), left, top }); nBadge++;
      } else if (roll < 0.26) {     // 好 圆标
        inputs.push({ input: await sharp(TILES.logo(cellW, cellH)).png().toBuffer(), left, top }); nLogo++;
      } else if (roll < 0.38) {     // 竖排文字条
        inputs.push({ input: await sharp(TILES.label(cellW, cellH)).png().toBuffer(), left, top }); nLabel++;
      } else if (roll < 0.46) {     // 好易美 品牌牌
        inputs.push({ input: await sharp(TILES.brand(cellW, cellH)).png().toBuffer(), left, top }); nBrand++;
      } else {                      // 订单截图（带小标注条）
        const f = path.join(dir, files[shotIdx++ % files.length]);
        const cell = await sharp(f).resize({ width: cellW, height: cellH, fit: 'cover', position: 'top' }).toBuffer();
        inputs.push({ input: cell, left, top });
        if (caption && rand() < 0.75) {
          inputs.push({ input: await sharp(stripSvg(capW, capH, city + star + ' ' + caption)).png().toBuffer(), left: left + Math.round((cellW - capW) / 2), top: top + Math.round(cellH * 0.05) });
          nStrip++;
        }
      }
    }
  }
  const base = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const buf = await sharp(base).composite(inputs).png().toBuffer();
  return { buf, info: `${COLS}列×${rows}行=${COLS * rows}格  截图${Math.min(shotIdx, files.length)}张  中的${nBadge} 好标${nLogo} 竖条${nLabel} 品牌${nBrand} 标注条${nStrip}` };
}

async function fetchOfficialPoster(city, star) {
  const r = await post('/api/poster/make', { city, star, source: 'damai_official', ratio: '3:4', blocks: [], tags: [] }, { timeout: 300000 });
  if (!r || !r.ok || !r.imageB64) throw new Error('官方海报取不到: ' + JSON.stringify(r).slice(0, 160));
  return { buf: Buffer.from(r.imageB64, 'base64'), origin: r.baseOrigin || '' };
}

(async () => {
  const shotsDir = resolve(SHOTS);
  if (!fs.existsSync(shotsDir)) { console.log('❌ 截图目录不存在: ' + shotsDir); process.exit(1); }

  const m = await buildMosaic(shotsDir, CITY, STAR, CAPTION);
  console.log('马赛克: ' + W + 'x' + H + '  ' + m.info);

  const [tr, tg, tb] = hex2rgb(TINT);
  const veil = await sharp({ create: { width: W, height: H, channels: 4, background: { r: tr, g: tg, b: tb, alpha: TINT_ALPHA } } }).png().toBuffer();
  let out = await sharp(m.buf).composite([{ input: veil, blend: 'over' }]).png().toBuffer();
  console.log('色调: 叠 ' + TINT + ' @' + TINT_ALPHA);

  if (!NO_POSTER) {
    const p = await fetchOfficialPoster(CITY, STAR);
    const pm = await sharp(p.buf).metadata();
    const ph = POSTER_W > 0 ? Math.round(W * POSTER_W * pm.height / pm.width) : Math.round(H * POSTER_H);
    const pw = POSTER_W > 0 ? Math.round(W * POSTER_W) : Math.round(ph * pm.width / pm.height);
    const ple = Math.round(W / 2 - pw / 2), ptop = Math.round(H * POSTER_CY - ph / 2);
    const poster = await sharp(p.buf).resize({ width: pw, height: ph }).png().toBuffer();
    const border = await sharp({ create: { width: pw + 16, height: ph + 16, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const framed = await sharp(border).composite([{ input: poster, left: 8, top: 8 }]).png().toBuffer();
    out = await sharp(out).composite([{ input: framed, left: ple - 8, top: ptop - 8 }]).png().toBuffer();
    console.log('海报: 官方图(' + p.origin + ') → ' + pw + 'x' + ph + '  中心 (50%, ' + (POSTER_CY * 100) + '%)');
  }

  fs.writeFileSync(resolve(OUT), out);
  console.log('底图已写: ' + OUT + '  ' + Math.round(out.length / 1024) + ' KB');
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
