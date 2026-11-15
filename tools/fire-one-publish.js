/**
 * tools/fire-one-publish.js — 手动催一轮唤醒发布，并验证队列【没有】被截断
 *
 * 背景：publish.js 的 runBatchPublish 原来有 `data.tasks = tasks;`，
 * 会把「本次要发的 1 条」写回整个队列，其余任务被丢掉（2026-09-29 已修）。
 * 这个脚本就是那条修复的回归测试：
 *   发之前 pending = N  →  发之后 pending 应等于 N-1
 * 如果 after === 0，说明截断 bug 还在。
 *
 * 复刻 wake-publish-sleep.ps1 的关键步骤：setStore → syncTasksFromDisk → runBatchPublish(1)
 *
 * 用法: node tools/fire-one-publish.js [--dry]
 * 退出码: 0 = 发成功且队列保住；1 = 队列被截断；2 = 环境问题
 */
const out = require('../lib/out');
const agent = require('../lib/agent');
const { PATHS, STORE } = require('../lib/env');

const DRY = process.argv.includes('--dry');

const COUNT_JS = [
  'function _pend(o) {',
  "  return (o.tasks || []).filter(function (x) {",
  "    if (x.status === 'done' || x.status === 'failed') return false;",
  '    if (x.itemId) return false;',
  '    var s = x.targetStore || x.store;',
  '    if (s && s !== ' + JSON.stringify(STORE) + ') return false;',
  '    return true;',
  '  }).length;',
  '}',
  'function _snap() {',
  "  var d = {}; try { d = JSON.parse(localStorage.getItem('kun_daily_tasks_v2') || '{}'); } catch (e) {}",
  '  return d;',
  '}',
].join('\n');

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  await agent.ready();

  const code = [
    '(async () => { try {',
    COUNT_JS,
    '  window.kunPublish.setStore(' + JSON.stringify(STORE) + ');',
    '  await window.kunPublish.syncTasksFromDisk();',
    '  var b = _snap(); var before = _pend(b);',
    DRY
      ? "  return JSON.stringify({ dry: true, before: before, after: before, total: (b.tasks||[]).length });"
      : [
        '  if (!before) return JSON.stringify({ before: 0, after: 0, total: (b.tasks||[]).length, note: "没有待发任务" });',
        '  await window.kunPublish.runBatchPublish(1);',
        '  var a = _snap();',
        '  var done = (a.tasks || []).filter(function (x) {',
        "    return x.status === 'done' && String(x.id || '').indexOf('show') === 0;",
        "  }).map(function (x) { return x.id + '=' + (x.itemId || '?'); });",
        '  return JSON.stringify({ before: before, after: _pend(a), total: (a.tasks||[]).length, showDone: done });',
      ].join('\n'),
    "} catch (e) { return 'ERR ' + e.message; } })()",
  ].join('\n');

  out.head('催一轮发布' + (DRY ? '（dry）' : ''));
  out.kv('店铺', STORE);

  // 必须让页面用上【最新的 publish.js】——wake-publish-sleep.ps1 是靠 location.reload()，
  // 但实测 reload 后 window.kunPublish 不会自动回来（注入只在页面创建时做一次，
  // 唤醒日志里的「页面未就绪（新代码未加载）」就是这个）。所以这里直接 eval 源码注入。
  const a2 = require('../lib/args').parse();
  if (!a2['no-reload']) {
    const DIR = PATHS.xianyuMonitor + '/';
    const PUBJS = DIR + 'publish.js';
    const ADBJS = DIR + 'address_db.js';
    const fsx = require('fs');
    let src = '', dbSrc = '';
    try { src = fsx.readFileSync(PUBJS, 'utf8'); } catch (e) { out.bad('读不到 publish.js'); out.done(2); }
    try { dbSrc = fsx.readFileSync(ADBJS, 'utf8'); } catch (e) { out.warn('读不到 address_db.js：' + e.message); }

    out.kv('注入', 'publish.js ' + Math.round(src.length / 1024) + ' KB' +
      (dbSrc ? ' + address_db.js ' + Math.round(dbSrc.length / 1024) + ' KB' : ''));

    // ⚠️ reload 会同时清掉 ADDRESS_DB 和 kunPublish，两个都要补回来。
    // 漏掉 address_db.js 会让 findAddress() 返回 null → 「addr not found」直接发布失败（踩过）。
    try { await agent.evalOnStore('try{location.reload()}catch(e){}; "reloading"', { timeout: 30000 }); }
    catch (e) { /* 跳转会报错，正常 */ }
    await agent.sleep(8000);

    if (dbSrc) {
      // address_db.js 里是 `var ADDRESS_DB = ...`，在 page.evaluate 的函数作用域里只是局部变量，
      // 必须显式挂到 window 上，publish.js 闭包里的 typeof ADDRESS_DB 才看得到。
      const wrap = '(function(){' + dbSrc + '\n; window.ADDRESS_DB = (typeof ADDRESS_DB!=="undefined"?ADDRESS_DB:null);' +
        'return window.ADDRESS_DB?window.ADDRESS_DB.length:"null";})()';
      try {
        const n = await agent.evalOnStore(wrap, { timeout: 120000 });
        out.kv('ADDRESS_DB', String(n) + ' 条');
      } catch (e) { out.bad('注入 address_db.js 失败：' + e.message); out.done(2); }
    }

    const chk = '(function(){try{return (window.kunPublish&&typeof window.kunPublish.runBatchPublish==="function")?String(window.kunPublish.runBatchPublish.length):"-1"}catch(e){return "-2"}})()';
    let v = '-1';
    try { v = await agent.evalOnStore(chk, { timeout: 30000 }); } catch (e) { /* ignore */ }

    if (Number(v) < 1) {
      out.kv('reload 后未就绪', '改为直接注入 publish.js 源码');
      try { await agent.evalOnStore(src, { timeout: 180000 }); }
      catch (e) { out.bad('注入失败：' + e.message); out.done(2); }
      await agent.sleep(3000);
      try { v = await agent.evalOnStore(chk, { timeout: 30000 }); } catch (e) { /* ignore */ }
    }

    const ready = Number(v) >= 1;
    out.kv('页面就绪', ready ? '是（runBatchPublish.length=' + v + '）' : '❌ 否（' + v + '）');
    if (!ready) { out.warn('页面未就绪，放弃本次（避免用旧代码发布）'); out.done(2); }
  }

  // 复位失败任务：runBatchPublish 会跳过 status='failed' 的，重试前必须清掉
  if (a2['retry-failed']) {
    const r = await agent.evalOnStore([
      '(function(){',
      "  var d = JSON.parse(localStorage.getItem('kun_daily_tasks_v2') || '{}');",
      '  var n = 0;',
      "  (d.tasks || []).forEach(function (t) { if (t.status === 'failed') { t.status = 'pending'; delete t.error; n++; } });",
      "  localStorage.setItem('kun_daily_tasks_v2', JSON.stringify(d));",
      '  return String(n);',
      '})()',
    ].join('\n'), { timeout: 60000 });
    out.kv('复位失败任务', String(r) + ' 条');
  }

  const raw = await agent.evalOnStore(code, { timeout: 500000 });
  if (typeof raw === 'string' && raw.indexOf('ERR ') === 0) { out.bad(raw); out.done(2); }
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;

  out.kv('发之前待发', j.before + ' 条');
  out.kv('发之后待发', j.after + ' 条');
  out.kv('队列总条数', j.total);
  if (j.showDone && j.showDone.length) out.kv('show* 已完成', j.showDone.join('  '));
  if (j.note) out.warn(j.note);

  out.head('结果');
  if (DRY) { out.ok('dry：未触发发布'); out.done(0); }

  if (j.before === 0) { out.warn('没有待发任务，无法验证'); out.done(0); }

  if (j.after === j.before - 1) {
    out.ok('✅ 发了 1 条，队列剩 ' + j.after + ' 条 —— 截断 bug 已修复');
    out.done(0);
  } else if (j.after === 0) {
    out.bad('❌ 队列被清空（' + j.before + ' → 0）—— 截断 bug 仍在！');
    out.done(1);
  } else {
    out.warn('⚠️ 待发 ' + j.before + ' → ' + j.after + '（既不是 -1 也不是 0，需人工看）');
    out.done(1);
  }
})().catch((e) => out.fail(e));
