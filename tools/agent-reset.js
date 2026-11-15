/**
 * tools/agent-reset.js — 让浏览器只保留「当前运营的店铺」
 *
 * 为什么需要：
 *   以前预热调 /api/agent/open-all-stores，会把三个店铺 context 全开。
 *   现在 lib/agent.js 的 ready() 只启动 config.store.active 里的店铺，
 *   但**已经开着的**那两个不会自己消失 —— 只能等浏览器空闲 20 分钟整体回收。
 *   这个命令把它立刻收干净，省掉两个 Chromium context 的内存。
 *
 * 做法（三步，每步都可单独回滚）：
 *   1) POST /api/agent/stop        —— 先 saveCookies() 再关浏览器，登录态落 state.json
 *   2) POST /api/agent/start-all   —— 重建 agent（懒加载，此时不启浏览器）
 *   3) POST /api/agent/start-one   —— 只启动 active 里的店铺
 *
 * 安全性：cookie 在第 1 步已存盘，第 3 步 switchTo 会 loadState 灌回去，不需要重新登录。
 *
 * 用法:
 *   node tools/agent-reset.js          # 预览当前开着哪些
 *   node tools/agent-reset.js --apply  # 执行
 */
const out = require('../lib/out');
const http = require('../lib/http');
const { ACTIVE, STORE } = require('../lib/env');

const APPLY = process.argv.includes('--apply');

async function openStores() {
  try {
    const r = await http.get('/api/agent/debug-stores', { timeout: 15000 });
    return Object.keys(r || {});
  } catch (e) { return []; }
}

(async () => {
  if (!(await http.alive())) { out.bad('Playwright 服务没在跑'); out.done(2); }

  const before = await openStores();
  out.head('店铺会话');
  out.kv('当前开着', before.length ? before.join('、') : '（无）');
  out.kv('应当只开', ACTIVE.join('、'));

  const extra = before.filter((n) => ACTIVE.indexOf(n) < 0);
  if (!extra.length) {
    out.ok('已经只有运营店铺，无需处理');
    out.done(0);
  }
  out.warn('多开着 ' + extra.length + ' 个：' + extra.join('、'));

  if (!APPLY) {
    out.plain('');
    out.plain('  加 --apply 执行：stop(存cookie) → start-all → start-one ' + STORE);
    out.done(0);
  }

  // 1) 存 cookie 并关浏览器
  const s = await http.post('/api/agent/stop', {}, { timeout: 120000 });
  if (!s || s.ok !== true) { out.bad('stop 失败：' + ((s && s.error) || '未知')); out.done(1); }
  out.ok('已存 cookie 并关闭浏览器');

  // 2) 重建 agent（懒加载，不启浏览器）
  const a = await http.post('/api/agent/start-all', {}, { timeout: 60000 });
  if (!a || a.ok !== true) { out.bad('start-all 失败：' + ((a && a.error) || '未知')); out.done(1); }
  out.ok('agent 已重建');

  // 3) 只启动运营店铺
  for (const name of ACTIVE) {
    const r = await http.post('/api/agent/start-one', { name }, { timeout: 180000 });
    if (!r || r.ok !== true) { out.bad('启动「' + name + '」失败：' + ((r && r.error) || '未知')); out.done(1); }
    out.ok('已启动「' + name + '」 state=' + (r.state || '?'));
  }

  const after = await openStores();
  out.head('结果');
  out.kv('现在开着', after.join('、') || '（无）');
  const stillExtra = after.filter((n) => ACTIVE.indexOf(n) < 0);
  if (stillExtra.length) out.warn('仍有额外店铺：' + stillExtra.join('、'));
  else out.ok('只剩运营店铺');
  out.done(0);
})().catch((e) => out.fail(e));
