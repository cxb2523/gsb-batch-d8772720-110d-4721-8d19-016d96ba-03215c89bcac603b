/**
 * tools/make-subimgs.js —— 出一条/一组「副图」（本店口径，不带别家品牌水印）
 *
 * 为什么做（2026-11-13）：
 *   超能水手代拍的副图目录是空的；能借到的只有好易美那 8 张——但它们是
 *   「好易美代拍票务」品牌水印的战绩拼图，换店后用在超能水手的链接上就是串品牌。
 *   所以这里用本店自己的金色底图 + 已 approved 的通用素材（三行红字 / 随便问必中 / 命中率高）
 *   现成出图，再叠一张「场次信息卡」——所有信息都是这条链接真实卖的场次，不冒充别人的战绩。
 *
 * 用法:
 *   node tools/make-subimgs.js --store="超能水手代拍" --city=北京 --star=双高胎 \
 *     --date="11/29" --times="14:30 / 19:30" --venue="北京 微博in·钻石中心" --platform="微博购 / 猫眼演出"
 *   → publish-assets/<店>/副图/副图1..4.jpg
 *
 * ⚠️ 只做「不加品牌」的图；别把别家的战绩拼图搬过来。
 */
const fs = require('fs');
const path = require('path');
const { ROOT, PATHS, svcRequire } = require('../lib/env');

const sharp = svcRequire('node_modules/sharp');

const argv = process.argv.slice(2);
const GET = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };

const STORE = GET('store', '超能水手代拍');
const CITY = GET('city', '北京');
const STAR = GET('star', '双高胎');
const TITLE = GET('title', '');                     // 活动全名，例：麻辣王子年轻之夜
const DATE = GET('date', '');
const TIMES = GET('times', '');
const VENUE = GET('venue', '');
const PLATFORM = GET('platform', '');

const W = 1104, H = 1472;
const BASE = path.join(ROOT, 'publish-assets', STORE, '底图', 'base-gold.jpg');
const OUT = path.join(ROOT, 'publish-assets', STORE, '副图');
const FONT = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 一条横向信息卡（半透明黑底 + 白字），返回 {svg, x, y, w, h} 尺寸由调用方放 */
function infoCard(lines, opts) {
  opts = opts || {};
  const padX = 40, padY = 30, lh = (opts.lh || 64);
  const fs1 = opts.fs1 || 46, fs2 = opts.fs2 || 40;
  const h = padY * 2 + lines.reduce((s, l) => s + (l.size === 'big' ? fs1 : fs2) + 18, 0);
  const w = W - 120;
  let y = padY;
  let body = '';
  for (const l of lines) {
    const fs0 = l.size === 'big' ? fs1 : fs2;
    y += fs0;
    body += '<text x="' + (w / 2) + '" y="' + y + '" font-family="' + FONT + '" font-size="' + fs0 +
      '" fill="' + (l.color || '#ffffff') + '" text-anchor="middle" font-weight="' + (l.bold === false ? 'normal' : 'bold') + '">' +
      esc(l.t) + '</text>';
    y += 18;
  }
  const svg = '<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="28" fill="' + (opts.bg || 'rgba(0,0,0,0.55)') + '"/>' +
    body + '</svg>';
  return { svg, w, h };
}

/** 顶部黄块标题 */
function topBar(text) {
  const w = W - 160, h = 150;
  const svg = '<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="26" fill="#FFD400"/>' +
    '<text x="' + (w / 2) + '" y="104" font-family="' + FONT + '" font-size="92" fill="#111111" text-anchor="middle" font-weight="bold">' +
    esc(text) + '</text></svg>';
  return { svg, w, h };
}

async function compose(baseBuf, layers) {
  const inputs = [];
  for (const l of layers) {
    const buf = await sharp(Buffer.from(l.svg)).png().toBuffer();
    inputs.push({ input: buf, left: Math.round((W - l.w) / 2), top: Math.round(l.top) });
  }
  return sharp(baseBuf).resize(W, H, { fit: 'cover' }).composite(inputs).jpeg({ quality: 92 }).toBuffer();
}

(async () => {
  if (!fs.existsSync(BASE)) { console.log('❌ 底图不存在: ' + BASE); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const baseBuf = fs.readFileSync(BASE);

  // ① 场次信息卡（空字段自动跳过，标题用 --title，没给就用「城市+明星」）
  const bar = topBar(CITY + STAR);
  const lines = [{ t: TITLE || (CITY + STAR), size: 'big', color: '#FFD400' }];
  if (DATE || TIMES) lines.push({ t: '演出时间  ' + [DATE, TIMES].filter(Boolean).join('  ') });
  if (VENUE) lines.push({ t: '演出场馆  ' + VENUE });
  if (PLATFORM) lines.push({ t: '购票平台  ' + PLATFORM });
  const card = infoCard(lines, { top: 0 });
  const info1 = await compose(baseBuf, [Object.assign({}, bar, { top: 120 }), Object.assign({}, card, { top: 340 })]);
  fs.writeFileSync(path.join(OUT, '副图1-场次信息.jpg'), info1);

  // ② 信任三件套（好易美那套「三行红字」是通用素材，不带店名）
  const three = path.join(ROOT, 'publish-assets', '好易美代拍', '版式', '三行红字-透明.png');
  if (fs.existsSync(three)) {
    const m = await sharp(three).metadata();
    const w = Math.round(W * 0.84);
    const buf = await sharp(three).resize({ width: w }).png().toBuffer();
    const img = await sharp(baseBuf).resize(W, H, { fit: 'cover' })
      .composite([{ input: buf, left: Math.round((W - w) / 2), top: Math.round((H - Math.round(w * m.height / m.width)) / 2) }])
      .jpeg({ quality: 92 }).toBuffer();
    fs.writeFileSync(path.join(OUT, '副图2-可信承诺.jpg'), img);
  }

  // ③④ 两个通用贴纸
  const stickers = [
    ['贴纸-随便问必中-爆炸.png', '副图3-随便问必中.jpg'],
    ['贴纸-米字格-命中率高-全透明.png', '副图4-命中率高.jpg'],
  ];
  for (const [f, out] of stickers) {
    const p = path.join(ROOT, 'publish-assets', '好易美代拍', '贴纸', f);
    if (!fs.existsSync(p)) { console.log('  ⚠️ 没有贴纸，跳过: ' + f); continue; }
    const m = await sharp(p).metadata();
    const w = Math.round(W * 0.78);
    const buf = await sharp(p).resize({ width: w }).png().toBuffer();
    const img = await sharp(baseBuf).resize(W, H, { fit: 'cover' })
      .composite([{ input: buf, left: Math.round((W - w) / 2), top: Math.round((H - Math.round(w * m.height / m.width)) / 2) }])
      .jpeg({ quality: 92 }).toBuffer();
    fs.writeFileSync(path.join(OUT, out), img);
  }

  const list = fs.readdirSync(OUT).filter((f) => /\.(jpg|png)$/i.test(f));
  console.log('✅ 副图已生成 ' + list.length + ' 张 → ' + OUT);
  list.forEach((f) => console.log('   ' + f + '  ' + Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + ' KB'));
})().catch((e) => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
