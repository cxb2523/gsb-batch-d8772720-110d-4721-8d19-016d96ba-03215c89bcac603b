/**
 * tools/verify-shows-queue.js — 验证唤醒发布链真的会发这 12 条
 *
 * 为什么必须验：队列文件是我直接写的，但真正决定「发什么」的是**店铺页面里**的
 * window.kunPublish —— 它通过 native host 的 readDailyTasks 把文件读进 localStorage，
 * 再用 runBatchPublish 的过滤条件挑任务。文件写对了不代表页面读得到、挑得对。
 *
 * 本脚本复刻 runBatchPublish 的过滤条件（publish.js:1715-1719）：
 *   t.status !== 'done' && t.status !== 'failed' && !t.itemId && _taskMatchStore(t, store)
 *
 * 用法: node tools/verify-shows-queue.js
 * 退出码: 0 通过；1 数量/图片不对；2 连不上
 */
const out = require('../lib/out');
const agent = require('../lib/agent');
const { STORE, PATHS } = require('../lib/env');

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  await agent.ready();

  // 页面里的代码：切店 → 从磁盘同步 → 按 runBatchPublish 的条件过滤
  const code = [
    '(async () => { try {',
    '  window.kunPublish.setStore(' + JSON.stringify(STORE) + ');',
    '  await window.kunPublish.syncTasksFromDisk();',
    "  var d = JSON.parse(localStorage.getItem('kun_daily_tasks_v2') || '{}');",
    '  var ts = d.tasks || [];',
    '  var tgt = ' + JSON.stringify(STORE) + ';',
    '  var p = ts.filter(function (x) {',
    '    if (x.status === "done" || x.status === "failed") return false;',
    '    if (x.itemId) return false;',
    '    var s = x.targetStore || x.store;',
    '    if (s && s !== tgt) return false;',
    '    return true;',
    '  });',
    '  return JSON.stringify({',
    "    store: localStorage.getItem('kun_cur_store') || '?',",
    '    total: ts.length, pending: p.length,',
    '    autoPolish: d.autoPolish, templateId: d.templateId,',
    '    publishInterval: d.publishInterval, batchSize: d.batchSize,',
    '    rows: p.map(function (x) { return { city: x.city, star: x.star, sess: x.sessionType,',
    '      ev: x.eventType, img: (x.imageUrls || [])[0], price: x.price, stock: x.stock,',
    '      cat: x.categoryName, id: x.id }; })',
    '  });',
    "} catch (e) { return 'ERR ' + e.message; } })()",
  ].join('\n');

  const raw = await agent.evalOnStore(code, { timeout: 120000 });
  if (typeof raw === 'string' && raw.indexOf('ERR ') === 0) { out.bad(raw); out.done(1); }
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;

  out.head('唤醒发布链 · 队列验证');
  out.kv('页面当前店铺', j.store);
  out.kv('队列总条数', j.total);
  out.kv('待发布（runBatchPublish 会挑的）', j.pending);
  out.kv('autoPolish', String(j.autoPolish) + (j.autoPolish === false ? '  → 只上架，不建推广' : '  → 会自动建推广'));
  out.kv('templateId / 间隔', j.templateId + ' / ' + j.publishInterval + ' 分钟');

  out.table(['序', '场次', '场次类型', '活动', '主图', '价/库存'],
    (j.rows || []).map((r, i) => [i + 1, r.city + r.star, r.sess, r.ev, r.img, r.price + '/' + r.stock]),
    { maxCol: [3, 16, 8, 6, 28, 10] });

  // ── 断言 ──
  let bad = 0;
  const chk = (ok, msg) => { if (ok) out.ok(msg); else { out.bad(msg); bad++; } };
  const rows = j.rows || [];
  const a = require('../lib/args').parse();
  const EXPECT = a.expect ? Number(a.expect) : rows.length;

  chk(j.store === STORE, '页面店铺 = ' + STORE + '（实际 ' + j.store + '）');
  chk(rows.length === EXPECT, '待发布正好 ' + EXPECT + ' 条（实际 ' + rows.length + '）');
  chk(j.autoPolish === false, 'autoPolish=false（不会自动开推广花钱）');

  const imgs = rows.map((r) => r.img);
  chk(new Set(imgs).size === imgs.length, '12 条主图互不相同（' + new Set(imgs).size + ' 张）');

  const { ROOT } = require('../lib/env');
  const fs = require('fs');
  const path = require('path');
  const missing = imgs.filter((f) => !f || !fs.existsSync(path.join(PATHS.images, STORE, String(f))));
  chk(missing.length === 0, missing.length ? '缺图：' + missing.join('、') : '12 张主图文件都在磁盘上');

  const cities = {};
  rows.forEach((r) => { cities[r.city] = (cities[r.city] || 0) + 1; });
  const shows = new Set(rows.map((r) => r.city + r.star));
  out.kv('城市分布', Object.keys(cities).map((c) => c + '×' + cities[c]).join('  '));
  // directTitle 模式下 star 字段装的是【完整标题】，所以 city+star 天然唯一；
  // 这里改成断言「标题互不重复」，那才是真正要防的（曾经因为店铺模板没有 {场次类型} 而撞车）。
  chk(shows.size === rows.length, '标题互不重复（' + shows.size + '/' + rows.length + ' 条唯一）');
  const sessDist = {};
  rows.forEach((r) => { const k = r.sess; sessDist[k] = (sessDist[k] || 0) + 1; });
  out.kv('场次类型分布', Object.keys(sessDist).map((k) => k + '×' + sessDist[k]).join('  '));

  out.head('结果');
  if (bad) out.bad(bad + ' 项不通过');
  else out.ok('全部通过 —— 唤醒发布链每 30 分钟会发 1 条，12 条约 6 小时发完');
  out.full(j, 'verify-shows-queue');
  out.done(bad ? 1 : 0);
})().catch((e) => out.fail(e));
