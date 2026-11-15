/**
 * tools/compose-base.js — 把「纯色/白底 + 一张贴纸」合成成一张 3:4 底图
 *
 * 为什么需要它（2026-10-07 给 hope 店建"红爆炸贴"版式）：
 *   贴纸（爆炸贴）不是圆角矩形，中台渲染器的 `bg` 画不出来，只能当图片贴。
 *   而走服务端 `stickers` 那条路要改 server.js（加路由 + 文件映射），
 *   所以这里**本地把贴纸焊到底图上**，前端只负责叠字 —— 零服务端改动。
 *
 * 用法:
 *   node tools/compose-base.js --out=<输出png> --sticker=<贴纸png> --cx=49.8 --cy=60.5 --sw=85.6 [--bg=#FFFFFF] [--w=1020 --h=1360]
 *   --cx/--cy = 贴纸中心在底图上的位置（%）；--sw = 贴纸宽占底图宽（%）
 */
const path = require('path');
const fs = require('fs');
const { ROOT, svcRequire } = require('../lib/env');
const sharp = svcRequire('node_modules/sharp');

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const OUT = opt('out', ''), STICKER = opt('sticker', '');
if (!OUT || !STICKER) { console.log('用法: node tools/compose-base.js --out=<png> --sticker=<png> [--cx=50 --cy=50 --sw=60 --bg=#FFFFFF --w=1020 --h=1360]'); process.exit(2); }
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const hex2rgb = (h) => { const m = h.replace('#', ''); return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) }; };

(async () => {
  const W = Number(opt('w', 1020)), H = Number(opt('h', 1360));
  const bg = hex2rgb(opt('bg', '#FFFFFF'));
  const cx = Number(opt('cx', 50)), cy = Number(opt('cy', 50)), sw = Number(opt('sw', 60));

  const sf = resolve(STICKER);
  if (!fs.existsSync(sf)) { console.log('❌ 找不到贴纸: ' + sf); process.exit(1); }
  const sm = await sharp(sf).metadata();
  const stW = Math.round(W * sw / 100);
  const stH = Math.round(stW * sm.height / sm.width);
  const left = Math.round(W * cx / 100 - stW / 2);
  const top = Math.round(H * cy / 100 - stH / 2);
  const resized = await sharp(sf).resize({ width: stW, height: stH }).png().toBuffer();

  const base = await sharp({ create: { width: W, height: H, channels: 3, background: bg } }).png().toBuffer();
  const out = await sharp(base).composite([{ input: resized, left, top }]).png().toBuffer();
  fs.writeFileSync(resolve(OUT), out);

  console.log('底图合成完成: ' + OUT);
  console.log('  底图 ' + W + 'x' + H + '  背景 ' + opt('bg', '#FFFFFF'));
  console.log('  贴纸 ' + path.basename(sf) + ' → ' + stW + 'x' + stH +
    '  放左上角 (' + left + ',' + top + ')   中心 ' + cx + '%/' + cy + '%  宽占图 ' + sw + '%');
  console.log('  大小 ' + Math.round(out.length / 1024) + ' KB');
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
