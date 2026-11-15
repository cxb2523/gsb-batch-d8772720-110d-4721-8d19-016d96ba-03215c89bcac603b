/**
 * tools/shows-progress.js — 查唤醒发布链把我排的 12 条任务发到哪一步了
 *
 * 为什么需要单独一个：check-listings 只看「店里有没有这个场次」，
 * 看不出「队列里还剩几条、哪些 failed、itemId 是多少」。排障要看队列本身。
 *
 * 两个视角都看（它们会不一致，见 index/07-唤醒发布链.md）：
 *   磁盘  ~/.xianyu-daily-tasks-<店铺>.json
 *   页面  localStorage['kun_daily_tasks_v2']
 *
 * 用法: node tools/shows-progress.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = require('../lib/out');
const { STORE } = require('../lib/env');

const QUEUE = path.join(os.homedir(), '.xianyu-daily-tasks-' + STORE + '.json');

function summarize(label, data) {
  const ts = (data && data.tasks) || [];
  const show = ts.filter((t) => String(t.id || '').startsWith('show'));
  const byStatus = {};
  show.forEach((t) => { const k = t.status || 'pending'; byStatus[k] = (byStatus[k] || 0) + 1; });
  out.kv(label + ' · 总任务', ts.length + ' 条（其中 show* ' + show.length + ' 条）');
  out.kv(label + ' · 状态', JSON.stringify(byStatus));
  out.kv(label + ' · autoPolish', String(data && data.autoPolish));
  return show;
}

(async () => {
  out.head('唤醒发布链 · 进度');

  // ── 磁盘视角 ──
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(QUEUE, 'utf8')); }
  catch (e) { out.warn('读不到磁盘队列：' + e.message); }
  const diskShow = disk ? summarize('磁盘', disk) : [];

  // ── 页面视角 ──
  let pageShow = [];
  try {
    const agent = require('../lib/agent');
    await agent.ready();
    const code = [
      '(function(){',
      'var d = {};',
      "try { d = JSON.parse(localStorage.getItem('kun_daily_tasks_v2') || '{}'); } catch(e) {}",
      'var ts = d.tasks || [];',
      'return JSON.stringify({ autoPolish: d.autoPolish, total: ts.length, rows: ts.map(function(t){',
      '  return { id: t.id, star: t.star, city: t.city, sess: t.sessionType, status: t.status,',
      '           itemId: t.itemId || "", error: String(t.error || "").slice(0, 80) }; }) });',
      '})()',
    ].join('\n');
    const raw = await agent.evalOnStore(code, { timeout: 60000 });
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    pageShow = (j.rows || []).filter((t) => String(t.id || '').startsWith('show'));
    const byStatus = {};
    pageShow.forEach((t) => { const k = t.status || 'pending'; byStatus[k] = (byStatus[k] || 0) + 1; });
    out.kv('页面 · 总任务', j.total + ' 条（其中 show* ' + pageShow.length + ' 条）');
    out.kv('页面 · 状态', JSON.stringify(byStatus));
    out.kv('页面 · autoPolish', String(j.autoPolish));
  } catch (e) {
    out.warn('读页面队列失败：' + e.message);
  }

  // ── 逐条（优先用页面的，它才是执行时的真相）──
  const list = pageShow.length ? pageShow : diskShow;
  out.head('逐条');
  if (!list.length) out.warn('两边都没有 show* 任务 —— 队列已被清空');
  else out.table(['id', '场次', '场次类型', '状态', 'itemId', 'error'],
    list.map((t) => [t.id, t.city + t.star, t.sess, t.status || 'pending', t.itemId || '—', t.error || '']),
    { maxCol: [10, 16, 8, 8, 18, 40] });

  const done = list.filter((t) => t.status === 'done');
  const failed = list.filter((t) => t.status === 'failed');
  const pending = list.filter((t) => t.status !== 'done' && t.status !== 'failed');

  out.head('结论');
  out.plain('  已发: ' + done.length + ' 条    失败: ' + failed.length + ' 条    还没发: ' + pending.length + ' 条');
  // 期望条数不能写死 —— 常州周深当时只保留 1 条（另一条因重复被下架），所以总数是 11 不是 12。
  // 真正要盯的是【磁盘与页面是否一致】：不一致才说明某一侧被截断/没同步。
  const diskIds = diskShow.map((t) => String(t.id)).sort().join(',');
  const pageIds = pageShow.map((t) => String(t.id)).sort().join(',');
  out.plain('  磁盘/页面: ' + diskShow.length + ' / ' + pageShow.length +
    (diskIds === pageIds ? '（一致）' : '（❌ 不一致，重推一次即可）'));
  if (diskIds !== pageIds) {
    out.warn('磁盘与页面的任务集合不一致 —— 用 build-shows-batch.js 重推一次即可同步');
  }
  out.plain('  未发的场次: ' + (list.filter((t) => t.status !== 'done' && t.status !== 'failed')
    .map((t) => t.city + t.star.slice(0, 12)).join('、') || '（无）'));
  out.plain('');
  out.plain('  说明：队列截断坑（publish.js 的 data.tasks = tasks）已于 2026-09-29 修复，');
  out.plain('        现在每发 1 条其余任务原地保留，回归测试见 tools/fire-one-publish.js。');
  out.full({ disk: diskShow, page: pageShow }, 'shows-progress');
  out.done(0);
})().catch((e) => out.fail(e));
