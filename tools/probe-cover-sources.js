/**
 * tools/probe-cover-sources.js — 探主图底图能不能找到
 *
 * publish-one.js 出图是 POST /api/poster/make { city, star, source:'damai_official', ratio:'3:4' }，
 * 服务端自己去搜这个场次的官方图当底图，返回 baseOrigin 说明来源。
 * 底图找不到 → 出图会退化成通用图或者失败，所以上架前必须先探。
 *
 * 用法: node tools/probe-cover-sources.js [--only=4,5,6] [--file shows.json]
 * 只出图不落盘，报告 baseOrigin 与图片大小。
 */
const path = require('path');
const out = require('../lib/out');
const http = require('../lib/http');
const { ROOT, readJSON } = require('../lib/env');

const a = require('../lib/args').parse();
const FILE = a.file ? path.resolve(ROOT, a.file) : path.join(ROOT, 'shows.json');
const ONLY = a.only ? String(a.only).split(',').map((x) => x.trim()) : null;

(async () => {
  const cfg = readJSON(FILE);
  if (!cfg || !Array.isArray(cfg.shows)) { out.bad('读不到清单：' + FILE); out.done(2); }

  let shows = cfg.shows;
  if (ONLY) shows = shows.filter((s) => ONLY.indexOf(String(s.no)) >= 0);

  out.head('主图底图探测');
  out.kv('清单', path.basename(FILE) + ' · ' + shows.length + ' 个场次');

  const rows = [];
  const detail = [];
  for (const s of shows) {
    // 场次名（如「放肆快乐」）本身没有明星，照样当 star 传给服务端搜
    const body = { city: s.city, star: s.star, source: 'damai_official', ratio: '3:4' };
    let r = null, err = '';
    const t0 = Date.now();
    try {
      r = await http.post('/api/poster/make', body, { timeout: 120000 });
    } catch (e) { err = e.message; }
    const ms = Date.now() - t0;

    if (err) {
      rows.push([s.no, s.label, '❌ 调用失败', '—', Math.round(ms / 1000) + 's']);
      detail.push({ no: s.no, label: s.label, error: err });
      continue;
    }
    const ok = !!(r && r.ok && r.imageB64);
    const kb = ok ? Math.round(Buffer.from(r.imageB64, 'base64').length / 1024) : 0;
    rows.push([
      s.no, s.label,
      ok ? '✅ 有底图' : '❌ 出图失败',
      ok ? (r.baseOrigin || 'search') + '  ' + kb + 'KB' : (r && r.error) || '',
      Math.round(ms / 1000) + 's',
    ]);
    detail.push({ no: s.no, label: s.label, ok, baseOrigin: (r && r.baseOrigin) || '', kb, error: (r && r.error) || '' });
  }

  out.table(['序', '场次', '结果', '底图来源/大小', '耗时'], rows, { maxCol: [3, 28, 12, 28, 6] });

  const bad = detail.filter((d) => !d.ok);
  out.head('结论');
  if (!bad.length) out.ok('全部 ' + detail.length + ' 个场次都能出图');
  else {
    out.warn(bad.length + ' 个出不了图，需要人工提供底图或用通用图：');
    bad.forEach((d) => out.plain('    ' + d.no + '. ' + d.label + '  ' + (d.error || '')));
  }
  out.full(detail, 'probe-cover-sources');
  out.done(bad.length ? 1 : 0);
})().catch((e) => out.fail(e));
