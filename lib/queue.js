/**
 * lib/queue.js — 发布队列的【唯一写入口】
 *
 * 为什么存在（2026-09-29 两次真实事故，必须从工具层堵住）：
 *   1. 抢写：唤醒发布链（wake-publish-sleep.ps1 每 30 分钟一轮）里的
 *      kunPublish.runBatchPublish → saveDailyTasks → 经 native host 写
 *      ~/.xianyu-daily-tasks-<店铺>.json；我们的工具也在写同一个文件。
 *      两边同时写 → 文件开头变成一长串空格，JSON.parse 直接失败，靠备份才恢复。
 *   2. 假成功：工具按 do-offshelf.js 的【返回文字】判下架成败，有一条格式没匹配上被判失败，
 *      但它照样把任务置回 pending → 1 条未下架的商品被重发成重复链接。
 *      判据必须来自真实货架，不能来自返回文字（已修 republish-bad.js）。
 *   3. 缺核对：工具报「成功」，但队列 / 页面 / 真实货架三者不一致。
 *
 * 所以任何「读队列 → 改 → 写磁盘 → 推页面」都必须走 guardWrite()：
 *   暂停发布链（PAUSE-PUBLISH）→ 读 → 交给调用方改 → 写盘（带备份）→ 推页面
 *   → 回读核对（磁盘条数 == 页面条数 && 无重复 id）→ 恢复发布链。
 *   任何一步抛错，finally 都会把发布链恢复成进入前的状态。
 *
 * 用法：
 *   const queue = require('../lib/queue');
 *   const res = await queue.guardWrite(async (q) => { q.tasks.push(x); return { n: 1 }; });
 *   // res = { paused, result, verify }
 *
 * ⚠️ 不要再 fs.writeFileSync(QUEUE, ...) 直写队列文件 —— 那就是事故的来源。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const agent = require('./agent');
const { ROOT, STORE } = require('./env');

/** 队列文件（发布链与我们共用的那一个） */
const QUEUE = path.join(os.homedir(), '.xianyu-daily-tasks-' + STORE + '.json');
/** 暂停开关：存在即发布链不发（wake-publish-sleep.ps1 认这个文件） */
const PAUSE = path.join(ROOT, 'PAUSE-PUBLISH');

/** 备份名后缀，与 .bak_titles_ / .bak_desc_ 等保持同一格式（20260930003002） */
function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

/** 发布链是否已暂停 */
function isPaused() {
  return fs.existsSync(PAUSE);
}

/** 暂停发布链。已经暂停就不动（避免覆盖别人写的 reason，也避免误恢复） */
function pauseChain(reason) {
  if (isPaused()) return { created: false };
  fs.writeFileSync(PAUSE, String(reason || '工具写入中') + '  ' + new Date().toLocaleString('zh-CN', { hour12: false }), 'utf8');
  return { created: true };
}

/** 恢复发布链（删掉 PAUSE-PUBLISH） */
function resumeChain() {
  if (!isPaused()) return { removed: false };
  fs.unlinkSync(PAUSE);
  return { removed: true };
}

/**
 * 读磁盘队列。解析失败（含文件不存在）一律抛错，错误信息里带文件名 ——
 * 静默吞掉就是「文件写坏了但工具照报成功」的成因。
 */
function readQueue() {
  let s;
  try {
    s = fs.readFileSync(QUEUE, 'utf8');
  } catch (e) {
    throw new Error('读队列失败（' + QUEUE + '）：' + e.message);
  }
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  // 2026-09-29 抢写事故的症状就是「开头多出一长串空白」，这里顺手剥掉再 parse。
  // （剥掉只是兜住空白这种症状，文件真被写坏依然会抛错 —— 那才是我们要的。）
  s = s.replace(/^\s+/, '');
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error('队列 JSON 解析失败（' + QUEUE + '）：' + e.message);
  }
}

/** 备份 + 写磁盘。备份名 QUEUE + '.bak_' + <stamp> */
function writeQueue(q) {
  if (fs.existsSync(QUEUE)) fs.copyFileSync(QUEUE, QUEUE + '.bak_' + stamp());
  const text = JSON.stringify(q, null, 2);
  fs.writeFileSync(QUEUE, text, 'utf8');
  return { file: QUEUE, bytes: Buffer.byteLength(text) };
}

/**
 * 把队列写进页面 localStorage。
 * 为什么必须：publish.js 的 syncTasksFromDisk() 靠 window.postMessage 找浏览器扩展的
 * content script，而 Playwright 浏览器里没装这个扩展 → 磁盘同步在那边不生效，
 * 页面只认自己的 localStorage。所以磁盘 + 页面两边都写。
 */
async function pushPage(q) {
  await agent.ready();
  const code = 'localStorage.setItem("kun_cur_store", ' + JSON.stringify(STORE) + ');'
    + 'localStorage.setItem("kun_daily_tasks_v2", ' + JSON.stringify(JSON.stringify(q)) + ');'
    + '(function(){var d=JSON.parse(localStorage.getItem("kun_daily_tasks_v2"));'
    + 'return JSON.stringify({store:localStorage.getItem("kun_cur_store"),n:(d.tasks||[]).length});})()';
  return agent.evalOnStore(code, { timeout: 90000 });
}

/** 读页面上的队列对象；读不到 / 解析失败一律返回 null（不抛，交给 verify 判 ok） */
async function readPage() {
  try {
    await agent.ready();
    const raw = await agent.evalOnStore(
      '(function(){try{return JSON.stringify(JSON.parse(localStorage.getItem("kun_daily_tasks_v2")||"null"));}catch(e){return "null";}})()',
      { timeout: 60000 });
    if (raw === null || raw === undefined) return null;
    const s = String(raw);
    if (!s || s === 'null') return null;
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/**
 * 写后核对。
 * 磁盘条数以【回读】为准（不信任入参 q）—— 只有回读才能发现「写坏了 / 被发布链抢写」。
 * 入参 q 只是给调用方一个对称的签名（guardWrite 传的就是刚写进去的那份）。
 * ok = （页面条数 == 磁盘条数） && dup === 0
 */
async function verify(q) {
  const disk = readQueue();
  const tasks = disk.tasks || [];
  const page = await readPage();
  const pageTasks = (page && page.tasks) || [];

  const ids = tasks.map((t) => String(t.id || ''));
  const dup = ids.length - new Set(ids).size;

  const v = {
    diskTasks: tasks.length,
    pageTasks: page ? pageTasks.length : -1,
    showTasks: tasks.filter((t) => String(t.id || '').indexOf('show') === 0).length,
    pending: tasks.filter((t) => t.status !== 'done' && t.status !== 'failed' && !t.itemId).length,
    done: tasks.filter((t) => !!t.itemId).length,
    dup: dup,
    withDesc: tasks.filter((t) => !!t.description).length,
  };
  v.ok = (v.pageTasks === v.diskTasks) && v.dup === 0;
  return v;
}

/**
 * ★ 队列写入的唯一入口。
 *
 *   await queue.guardWrite(async (q) => { ...改 q... });   →  { paused, result, verify }
 *
 * 行为：
 *   1. 未暂停 → pauseChain('工具写入中')，paused=true；本来就暂停 → paused=false，且保持暂停
 *   2. 读队列 → 交给 fn(q)
 *   3. fn 返回后：写磁盘（带备份）→ 推页面 → 回读核对
 *   4. 核对不 ok → 抛错（错误信息带 verify 内容）
 *   5. 只有【本次暂停】的才恢复；try/finally 保证任何一步抛错都会走到第 5 步
 */
async function guardWrite(fn) {
  const pausedByMe = !isPaused();
  if (pausedByMe) pauseChain('工具写入中');
  try {
    const q = readQueue();
    const result = await fn(q);
    writeQueue(q);
    await pushPage(q);
    const v = await verify(q);
    if (!v.ok) throw new Error('写后核对不通过：' + JSON.stringify(v));
    return { paused: pausedByMe, result: result, verify: v };
  } finally {
    if (pausedByMe) resumeChain();
  }
}

module.exports = {
  QUEUE, PAUSE, STORE,
  isPaused, pauseChain, resumeChain,
  readQueue, writeQueue, pushPage, readPage, verify, guardWrite,
};
