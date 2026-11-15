/**
 * tools/make-cover.js — 出【成品】主图：底图 + 模板文字层（一步到位）
 *
 * ⚠️ 为什么必须有这个工具（2026-09-29 踩的坑）：
 *   出图是【两步】，我原来只做了第 1 步：
 *     第 1 步  /api/poster/make { templateId }   → 底图
 *     第 2 步  无头浏览器里跑 _iwApplyText(...)  → 把模板文字层叠上去  ← 漏了这步
 *   后果：12 条上架商品的封面全是「光底图 + 一个残留的蓝 7」，模板文字一个都没有。
 *   gen-3-covers.js 和 publish-one.js 都做了第 2 步，只有我新写的工具漏了。
 *   → 所以这里把两步封在一起，任何调用方都不可能再漏。
 *
 * 底图两种来源：
 *   spec.poster 给了 → 直接用那张本地图当底图（老板指定的海报走这条）
 *   没给             → 让服务端按 city+star 搜大麦官方图
 *
 * 用法（中文参数一律走 JSON 文件，命令行只传文件名，避免 PowerShell 吃掉中文）:
 *   node tools/make-cover.js --spec=我的规格.json
 *   spec: { "city":"成都", "star":"宋雨琦", "tpl":"tpl_redtext", "out":"D:/.../x.jpg", "poster":"C:/.../底图.jpg" }
 *   tpl 可为 xuliang-v1 / tpl_redtext / __shoukai
 *
 * ⚠️ 规格文件请自己建、放到不提交的位置。仓库里原来躺着一个 cover-spec.json
 *    （2026-10-08 已移出跟踪）—— 一次性输入规格留在版本库里既没价值，
 *    又会把某台机器的绝对路径带进仓库。
 *
 * 退出码: 0 成功；1 失败
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const http = require('../lib/http');
const { PATHS } = require('../lib/env');

const a = require('../lib/args').parse();
if (!a.spec) { out.bad('用法: node tools/make-cover.js --spec=<你的规格>.json'); out.done(2); }

// 读 spec 必须【剥 BOM】——PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
// 而 JSON.parse 遇到 BOM 直接抛 Unexpected token（本仓库反复踩过，见 tools/utf8-check.js）。
let _specRaw = fs.readFileSync(path.resolve(a.spec), 'utf8');
if (_specRaw.charCodeAt(0) === 0xFEFF) _specRaw = _specRaw.slice(1);
_specRaw = _specRaw.replace(/^\s+/, '');
const SPEC = JSON.parse(_specRaw);
const CITY = SPEC.city, STAR = SPEC.star, TPL = SPEC.tpl || 'xuliang-v1';
const OUTP = SPEC.out ? path.resolve(SPEC.out) : null;
const POSTER = SPEC.poster ? path.resolve(SPEC.poster) : null;
if (!CITY || !STAR || !OUTP) { out.bad('spec 里 city / star / out 必填'); out.done(2); }

// ⛔ 版式审核闸门（老板 2026-10-01 定的规矩：新版式必须他本人审核才能用到好易美代拍店铺）
// 为什么装在这里：make-cover.js 是【所有出图的唯一入口】——
//   build-shows-batch / run-batch / rebuild-covers / 手动调用，全都过它。
//   闸门装在这里，就没有任何旁路能绕过审核。
{
  const APF = path.join(__dirname, '..', 'lib', 'poster-templates-approved.json');
  let approved = null;
  try { approved = JSON.parse(fs.readFileSync(APF, 'utf8')); } catch (e) { /* 见下 */ }
  if (!approved || !Array.isArray(approved.approved)) {
    out.bad('读不到版式白名单 ' + APF + ' —— 无法确认版式是否已审核，拒绝出图（fail-closed）');
    out.done(2);
  }
  const keys = approved.approved.map((x) => x.key);
  if (keys.indexOf(String(TPL || '')) < 0) {
    out.bad('版式「' + TPL + '」不在已审核白名单里，拒绝出图');
    out.plain('  已审核可用的：' + keys.join('、'));
    const pend = (approved.pending || []).find((x) => x.key === TPL || x.name === TPL);
    if (pend) out.plain('  它现在在 pending：' + pend.name + '（' + pend.why + '）');
    out.plain('  要启用：老板审核后，把该版式从 lib/poster-templates-approved.json 的');
    out.plain('          pending 挪到 approved，并写明审核日期与成品图证据。');
    out.done(3);
  }
}

const DASH = path.join(PATHS.xianyuMonitor, 'publish_dashboard.js');
const SVC = PATHS.playwrightService;

function extractFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('找不到函数: ' + header);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } }
  return src.slice(i, k + 1);
}
function extractBraces(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('找不到: ' + header);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } }
  return src.slice(j, k + 1);
}

(async () => {
  out.head('出成品封面');
  out.kv('场次', CITY + STAR);
  out.kv('模板', TPL);
  out.kv('底图', POSTER ? '指定：' + path.basename(POSTER) : '服务端搜大麦官方图');

  // ── 1. 拿底图 ──
  let baseB64 = '';
  if (POSTER) {
    if (!fs.existsSync(POSTER)) { out.bad('底图不存在：' + POSTER); out.done(1); }
    baseB64 = fs.readFileSync(POSTER).toString('base64');
    out.ok('底图读到 ' + Math.round(fs.statSync(POSTER).size / 1024) + ' KB');
  } else {
    const body = { city: CITY, star: STAR, source: 'damai_official', ratio: '3:4' };
    // xuliang-v1 / tpl_redtext 是服务端 json 模板；__shoukai 由文字层库提供，出图时不指定 templateId
    if (TPL !== '__shoukai') body.templateId = TPL;
    else { body.blocks = []; body.tags = []; }
    const r = await http.post('/api/poster/make', body, { timeout: 240000 });
    if (!r || !r.ok || !r.imageB64) { out.bad('出图失败：' + ((r && r.error) || '无图')); out.done(1); }
    baseB64 = r.imageB64;
    out.ok('底图来自 ' + (r.baseOrigin || 'search') + '  ' + Math.round(Buffer.from(baseB64, 'base64').length / 1024) + ' KB');
  }

  // ── 2. 取该模板的文字层 ──
  let layers = [];
  if (TPL === '__shoukai') {
    const dash = fs.readFileSync(DASH, 'utf8');
    const LIB = eval('(' + extractBraces(dash, 'var _LAYER_TPL_LIB = {') + ')');
    const key = Object.keys(LIB).filter((k) => k.indexOf('首开') >= 0)[0];
    layers = LIB[key] || [];
    out.kv('文字层来源', '_LAYER_TPL_LIB["' + key + '"]  ' + layers.length + ' 层');
  } else {
    const t = await http.get('/api/poster/templates', { timeout: 60000 });
    const item = (t.items || []).find((x) => x.id === TPL);
    layers = (item && item.layers) || [];
    out.kv('文字层来源', '/api/poster/templates[' + TPL + ']  ' + layers.length + ' 层');
  }

  // ── 3. 叠文字层（这一步就是原来漏掉的）──
  let finalB64 = baseB64, mode = '只有底图（该模板无文字层）';
  if (layers.length) {
    const dash = fs.readFileSync(DASH, 'utf8');
    const SRC_NORM = extractFn(dash, 'function _normLayer(l)');
    const SRC_APPLY = extractFn(dash, 'function _iwApplyText(callback, overrides, srcUrl, layersOverride)');

    const { chromium } = require(SVC + '/node_modules/playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content:
      'window._iw = { layers: [], stickerImgs: [], sourceUrl: "" };\nfunction addLog(){};\n' +
      SRC_NORM + '\n' + SRC_APPLY + '\n' +
      'window.__render = function(b64, layers, ov) { return new Promise(function(res){ _iwApplyText(function(d){ res(d); }, ov, "data:image/jpeg;base64," + b64, layers); }); };'
    });
    const du = await page.evaluate(({ b64, layers, city, star }) =>
      window.__render(b64, layers, { city, star }), { b64: baseB64, layers, city: CITY, star: STAR });
    await browser.close();
    if (du) { finalB64 = String(du).replace(/^data:image\/[a-z]+;base64,/, ''); mode = '底图 + 文字层×' + layers.length; }
  }

  // ── 4. 落盘（扩展名按真实格式，不再出现「PNG 存成 .jpg」）──
  const buf = Buffer.from(finalB64, 'base64');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  let realExt = isPng ? '.png' : '.jpg';
  let target = OUTP;
  const wantExt = path.extname(OUTP).toLowerCase();
  if (wantExt && wantExt !== realExt) {
    // 让扩展名与真实格式一致
    target = OUTP.slice(0, -wantExt.length) + realExt;
    out.warn('扩展名与真实格式不符，改存为 ' + path.basename(target));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);

  out.head('完成');
  out.ok(mode);
  out.kv('文件', target);
  out.kv('大小', Math.round(buf.length / 1024) + ' KB   ' + (isPng ? 'PNG' : 'JPEG'));
  out.plain(JSON.stringify({ ok: true, file: target, format: isPng ? 'png' : 'jpeg', layers: layers.length }));
  out.done(0);
})().catch((e) => out.fail(e));
