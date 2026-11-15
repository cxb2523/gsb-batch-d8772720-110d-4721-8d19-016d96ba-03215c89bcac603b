/**
 * tools/resync-queue-to-shelf.js — 按【真实货架】校准队列状态
 *
 * 为什么需要：
 *   队列里任务的 status/itemId 是「我们以为的」，而真实货架是闲鱼那边的事实。
 *   下架、重发、文件写坏恢复……都可能让两者对不上。对不上的后果很实际：
 *     · 实际已下架但标着 done   → 永远不会被重发（货架空着没人管）
 *     · 实际在售但标着 pending  → 会被重发一条重复的
 *   2026-09-30 就是因为恢复到了「下架之前」的备份，10 条实际已下架却标着 done。
 *
 * 做法：
 *   1. 从「在售可投池」拿到真实的 itemId 集合（= 在售）
 *   2. 逐条 show* 任务比对：
 *        在售   → status=done，保留 itemId
 *        不在售 → 清掉 itemId，status=pending（交给发布链重发）
 *   3. 磁盘 + 页面 localStorage 两边都写
 *
 * ⚠️ 改队列前必须先暂停发布链（PAUSE-PUBLISH），否则会和它抢写文件（踩过，文件被写坏）。
 *
 * 用法:
 *   node tools/resync-queue-to-shelf.js --dry
 *   node tools/resync-queue-to-shelf.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = require('../lib/out');
const queue = require('../lib/queue');
const agent = require('../lib/agent');
const { ROOT, STORE } = require('../lib/env');

const DRY = process.argv.includes('--dry');
const QUEUE = path.join(os.homedir(), '.xianyu-daily-tasks-' + STORE + '.json');
const PAUSE = path.join(ROOT, 'PAUSE-PUBLISH');

/** 在售可投池的 itemId 集合 */
async function liveIds() {
  const code = [
    "const r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV2', v:'1.0', type:'POST',",
    "  data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });",
    "if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err:(r&&r.ret)||null });",
    'const d = (r.data || {}).result || r.data || {};',
    'return JSON.stringify({ ids:(d.itemList||[]).map(function(i){ return String(i.itemId); }) });',
  ].join('\n');
  const r = await agent.mtop(code);
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  if (!d || d.err) throw new Error('拉在售池失败：' + JSON.stringify(d && d.err));
  return new Set(d.ids || []);
}

(async () => {
  if (fs.existsSync(PAUSE)) out.ok('发布链已暂停（PAUSE-PUBLISH 存在）—— 不会抢写');
  else out.warn('⚠️ 发布链【未暂停】！可能与本次写入抢同一文件。建议先建 PAUSE-PUBLISH。');

  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  await agent.ready();

  const live = await liveIds();
  out.head('校准');
  out.kv('在售可投池', live.size + ' 条');

  const q = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
  const tasks = (q.tasks || []).filter((t) => String(t.id || '').indexOf('show') === 0);
  out.kv('队列 show* 任务', tasks.length + ' 条');

  const rows = [];
  const fix = [];
  tasks.forEach((t) => {
    const id = String(t.itemId || '');
    const isLive = !!id && live.has(id);
    const should = isLive ? 'done' : 'pending';
    const changed = (t.status !== should) || (!isLive && t.itemId);
    if (changed) fix.push(t);
    rows.push([t.id, t.city + (t.eventType || ''),
      t.itemId || '—', isLive ? '✅ 在售' : '❌ 不在售',
      (t.status || '?') + ' → ' + should, changed ? '要改' : '']);
  });
  out.table(['任务', '场次', 'itemId', '真实', '状态', ''], rows,
    { maxCol: [9, 12, 17, 10, 16, 5] });

  if (!fix.length) { out.ok('队列与货架一致，无需调整'); out.done(0); }

  fix.forEach((t) => {
    const id = String(t.itemId || '');
    const isLive = !!id && live.has(id);
    if (isLive) { t.status = 'done'; return; }
    delete t.itemId; delete t.error;
    t.status = 'pending';
    t.specs = { enabled: false };
    t.subImg = true;
    t.price = '50';
    t.stock = '9999';
  });

  out.head('结果');
  out.kv('需要调整', fix.length + ' 条');
  out.kv('→ 复位为待发', fix.filter((t) => t.status === 'pending').length + ' 条');
  out.kv('→ 标为已发布', fix.filter((t) => t.status === 'done').length + ' 条');

  if (DRY) { out.plain(''); out.kv('DRY', '未写入'); out.done(0); }

  // 走 lib/queue 的唯一写入口：自动「写前暂停发布链 → 写盘(带备份) → 推页面 → 回读核对 → 恢复」。
  // 原来这里是 fs.writeFileSync(QUEUE, ...) + 直接 evalOnStore 推页面 —— 与发布链抢写会写坏文件。
  const res = await queue.guardWrite(async (diskQ) => {
    diskQ.tasks = q.tasks;   // 用上面算好的那份（已按真实货架校准过）
    return { fixed: fix.length };
  });
  out.kv('写后核对', JSON.stringify(res.verify));
  if (!res.verify.ok) { out.bad('写后核对不通过'); out.done(1); }

  out.plain('');
  out.plain('  下一步：恢复发布（删掉 PAUSE-PUBLISH）后，待发的会一条条发出来。');
  out.done(0);
})().catch((e) => out.fail(e));
