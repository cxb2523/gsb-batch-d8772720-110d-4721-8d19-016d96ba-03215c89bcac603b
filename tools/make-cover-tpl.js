/**
 * tools/make-cover-tpl.js —— 「底图 + 现役版式文字层」出成品图（不焊贴纸）
 *
 * ⛔ 2026-11-12 起【不用于店铺主图】。
 *   老板拍板：主图就走 xuliang-v1 / __shoukai 原样版式，
 *   正确姿势是 `KUN_BASE_IMG + KUN_MAIN_TPL`（publish-one.js 出图），不要先出成品图再喂 KUN_MAIN_IMG
 *   —— 那样会绕过版式，publish-one.js 现在会直接报错拦下来。
 *   本文件保留作为「版式层坐标排查」工具：看某套版式的文字层落在哪、
 *   哪些层压主体（--maxY 过滤 + --yOverride 试位置）。别拿它出正式主图。
 *
 * ---- 以下为原始说明 ----
 *
 * 为什么要它（2026-11-12，老板两次打回）：
 *   ① 用 KUN_MAIN_IMG 走底条版 → 老板说「主图版式没有加」。
 *      底条版只有底部信息带，没有店铺那套黄块+{城市}{明星}的版式特征，
 *      和店里其它链接放在一起不像一家店的货。
 *   ② 用 KUN_BASE_IMG 走现役版式 → 版式文字层铺满 y=12/32/48/66/82，
 *      正好压住海报主体（「2026守望先锋全球总决赛」那几个字）。
 *
 *   所以这里换个做法：**底条版成品图当底**（主体+信息带已经排好），
 *   只从版式里取「不挡主体」的那几层（顶部黄块 / 底部红字），本地叠上去。
 *   贴纸（stickers）一律不焊 —— hmd_yellow_3red 的三行红字贴纸就是压在 y≈613 的元凶。
 *
 * 用法:
 *   node tools/make-cover-tpl.js --base=<底图> --out=<输出> \
 *        [--tpl=hmd_yellow_3red] [--city=广州] [--star=守望先锋] \
 *        [--layers='[{"text":"...","y":8,"x":50,"size":129,"color":"#040201"}]']
 *
 *   --layers 给了就完全按它画（忽略 --tpl）；没给就从 --tpl 里取 y ≤ 30 的层
 *   （只保留顶部区，避开海报主体）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PATHS, ROOT } = require('../lib/env');

const A = {};
// 支持两种写法： --key=value  和  --key value
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

const BASE = A.base;
const OUT = A.out;
const TPL = A.tpl || 'hmd_yellow_3red';
const CITY = A.city || '广州';
const STAR = A.star || '守望先锋';
const MAX_Y = Number(A.maxY || 30);          // 只取 y ≤ 这个百分比的层（避开主体）
if (!BASE || !OUT) {
  console.log("用法: node tools/make-cover-tpl.js --base=<底图> --out=<输出> [--tpl=hmd_yellow_3red] [--city=广州] [--star=守望先锋] [--layers='[...]']");
  process.exit(2);
}
if (!fs.existsSync(BASE)) { console.log('❌ 底图不存在: ' + BASE); process.exit(1); }

const SVC = PATHS.playwrightService;
const KEY = require('../lib/env').SVC.apiKey;

function apiGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 8093, path: p, headers: { 'x-api-key': KEY } }, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('非 JSON')); } });
    }).on('error', reject);
  });
}

function extractFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('找不到函数: ' + header);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}

(async () => {
  const sharp = require(path.join(SVC, 'node_modules', 'sharp'));

  // 1. 定层
  let layers;
  if (A.layersFile) {
    // 中文 + 引号走文件最稳（PowerShell 直接传 JSON 参数会把引号吃掉）
    layers = JSON.parse(fs.readFileSync(A.layersFile, 'utf8'));
    console.log('层: 用 --layersFile 指定 ' + A.layersFile + ' 的 ' + layers.length + ' 层');
  } else if (A.layers) {
    layers = JSON.parse(A.layers);
    console.log('层: 用 --layers 指定的 ' + layers.length + ' 层');
  } else {
    const t = await apiGet('/api/poster/templates');
    const tpl = (t.items || []).find(x => x.id === TPL);
    if (!tpl) { console.log('❌ 版式不存在: ' + TPL); process.exit(1); }
    const all = tpl.layers || [];
    layers = all.filter(l => Number(l.y) <= MAX_Y).map(l => Object.assign({}, l));   // 深拷一层，保留背景等全部属性
    // 只调位置/字号时用这两个参数覆盖 —— 手写 layers 会丢背景块属性（黄块就没了）
    if (A.yOverride) layers.forEach(l => { l.y = Number(A.yOverride); });
    if (A.sizeOverride) layers.forEach(l => { l.size = Number(A.sizeOverride); });
    console.log('版式 ' + TPL + ' [' + tpl.name + '] 共 ' + all.length + ' 层，只取 y≤' + MAX_Y + '% 的 ' + layers.length + ' 层：');
    all.forEach(l => console.log('   y=' + l.y + (Number(l.y) <= MAX_Y ? '  ✅保留' : '  ⛔丢弃(压主体)') + '  ' + String(l.text).slice(0, 30)));
    layers.forEach(l => console.log('   → 实际渲染 y=' + l.y + ' size=' + l.size));
    if (tpl.stickers && tpl.stickers.length) console.log('   ⚠️ 该版式带 ' + tpl.stickers.length + ' 个贴纸 —— 本脚本一律不焊');
  }
  if (!layers.length) { console.log('❌ 没有可用层（都不满足 y≤' + MAX_Y + '%）'); process.exit(1); }

  // 2. 底图转 3:4
  const raw = fs.readFileSync(BASE);
  const meta = await sharp(raw).metadata();
  const w0 = meta.width, h0 = meta.height;
  let buf = raw;
  if (Math.abs(w0 / h0 - 3 / 4) > 0.01) {
    const cw = w0 / h0 > 3 / 4 ? Math.round(h0 * 3 / 4) : w0;
    const ch = w0 / h0 > 3 / 4 ? h0 : Math.round(w0 * 4 / 3);
    buf = await sharp(raw).extract({ left: Math.floor((w0 - cw) / 2), top: Math.floor((h0 - ch) / 2), width: cw, height: ch }).toBuffer();
    console.log('底图 ' + w0 + 'x' + h0 + ' → 裁 3:4 (' + cw + 'x' + ch + ')');
  } else {
    console.log('底图 ' + w0 + 'x' + h0 + '（已是 3:4）');
  }

  // 3. 本地渲染层（复用发布台 _iwApplyText，保证与线上渲染一致）
  const dash = fs.readFileSync(path.join(PATHS.xianyuMonitor, 'publish_dashboard.js'), 'utf8');
  const SRC_NORM = extractFn(dash, 'function _normLayer(l)');
  const SRC_APPLY = extractFn(dash, 'function _iwApplyText(callback, overrides, srcUrl, layersOverride)');

  const { chromium } = require(path.join(SVC, 'node_modules', 'playwright'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.addScriptTag({ content:
    'window._iw = { layers: [], stickerImgs: [], sourceUrl: "" };\nfunction addLog(){};\n' +
    SRC_NORM + '\n' + SRC_APPLY + '\n' +
    'window.__render = function(b64, layers, ov) {\n' +
    '  return new Promise(function(res){ _iwApplyText(function(d){ res(d); }, ov, "data:image/jpeg;base64," + b64, layers); });\n' +
    '};'
  });

  const dataUrl = await page.evaluate(({ b64, layers, city, star }) =>
    window.__render(b64, layers, { city: city, star: star }), { b64: buf.toString('base64'), layers, city: CITY, star: STAR });
  await browser.close();

  if (!dataUrl) { console.log('❌ 渲染失败'); process.exit(1); }
  // 渲染器返回的是 PNG（canvas.toDataURL 默认），统一转 JPEG：闲鱼主图按 JPEG 存更小更稳
  const pngBuf = Buffer.from(String(dataUrl).replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
  const outBuf = await sharp(pngBuf).jpeg({ quality: 92 }).toBuffer();
  const outMeta = await sharp(outBuf).metadata();
  fs.writeFileSync(OUT, outBuf);
  console.log('\n✅ ' + OUT);
  console.log('   ' + outMeta.width + 'x' + outMeta.height + '  ' + Math.round(outBuf.length / 1024) + 'KB  ' + layers.length + ' 层');
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
