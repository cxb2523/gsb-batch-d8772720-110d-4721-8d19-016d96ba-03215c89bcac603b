/**
 * tools/hold-shows.js — 把队列里未发布的 show* 任务【摘出来暂存】，阻止它们被发出去
 *
 * 用途：发现已发出去的商品有关键字段错误（所在地/规格），必须先停住剩下的，
 * 免得一路错下去。摘出来的任务存到 shows-hold.json，修好后用 --restore 放回去。
 *
 * 为什么不设 status='failed'：runBatchPublish 的过滤条件是
 *   t.status !== 'done' && t.status !== 'failed' && !t.itemId
 * —— 'failed' 确实能挡住，但会把任务永久标记为失败、丢失「本来还没发」的语义。
 * 摘出来更干净，也完全可逆。
 *
 * 用法:
 *   node tools/hold-shows.js            # 摘出未发布的 show* 任务
 *   node tools/hold-shows.js --restore  # 放回去
 *   node tools/hold-shows.js --status   # 只看现状
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const queue = require('../lib/queue');
const { ROOT, STORE } = require('../lib/env');

const HOLD = path.join(ROOT, 'shows-hold.json');
const MODE = process.argv.includes('--restore') ? 'restore'
  : process.argv.includes('--status') ? 'status' : 'hold';

const isShow = (t) => String(t.id || '').indexOf('show') === 0;
const isPending = (t) => t.status !== 'done' && t.status !== 'failed' && !t.itemId;

function load() { return queue.readQueue(); }

/**
 * 同时写磁盘和页面 localStorage —— 走统一写入口：
 * 暂停发布链 → 读 → 改 → 写盘（带备份）→ 推页面 → 回读核对 → 恢复发布链。
 * 调用方只改了 q.tasks，所以这里用刚读到的队列 + 调用方的 tasks 落盘。
 */
async function saveBoth(q) {
  const res = await queue.guardWrite(async (qq) => {
    qq.tasks = q.tasks;
    return null;
  });
  return res.verify;
}

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  const q = load();
  const all = q.tasks || [];
  const pendingShow = all.filter((t) => isShow(t) && isPending(t));

  out.head('队列现状');
  out.kv('总条数', all.length);
  out.kv('未发布的 show*', pendingShow.length + ' 条');
  pendingShow.forEach((t) => out.plain('    ' + t.id + '  ' + t.city + '  ' + String(t.star).slice(0, 30)));
  if (MODE === 'status') out.done(0);

  if (MODE === 'hold') {
    if (!pendingShow.length) { out.ok('没有待发布的 show* 任务，无需处理'); out.done(0); }
    fs.writeFileSync(HOLD, JSON.stringify({ at: new Date().toISOString(), reason: '暂存：待修所在地/规格', tasks: pendingShow }, null, 2), 'utf8');
    q.tasks = all.filter((t) => !(isShow(t) && isPending(t)));
    await saveBoth(q);
    out.head('已暂存');
    out.ok('摘出 ' + pendingShow.length + ' 条 → shows-hold.json');
    out.kv('队列剩余', q.tasks.length + ' 条');
    out.kv('放回', 'node tools/hold-shows.js --restore');
    out.done(0);
  }

  if (MODE === 'restore') {
    if (!fs.existsSync(HOLD)) { out.bad('没有 shows-hold.json'); out.done(2); }
    const h = JSON.parse(fs.readFileSync(HOLD, 'utf8'));
    const have = new Set((q.tasks || []).map((t) => t.id));
    const add = (h.tasks || []).filter((t) => !have.has(t.id));
    // 关掉规格：店铺级 kun_store_cfg_<店铺>.specs 是开启的（代拍费 50/500/800），
    // 这里用任务级 specs 覆盖成关闭 —— publish.js 的取值是 `task.specs || 店铺配置`。
    add.forEach((t) => { t.specs = { enabled: false }; });
    q.tasks = (q.tasks || []).concat(add);
    await saveBoth(q);
    out.head('已放回');
    out.ok('加回 ' + add.length + ' 条（已设 specs.enabled=false 关掉规格）；队列共 ' + q.tasks.length + ' 条');
    out.done(0);
  }
})().catch((e) => out.fail(e));
