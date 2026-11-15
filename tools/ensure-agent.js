/**
 * tools/ensure-agent.js — 巡检前置：确保 Playwright 服务在跑、且当前运营店铺的页面已就绪
 *
 * 为什么存在（2026-10-01）：
 *   ad-watch-stuck.ps1 这类巡检直接走 eval-store.js 打 8093，自己**不调 ready()**。
 *   店铺页的 context 一旦被回收，接口就回「执行失败: 店铺「好易美代拍」未就绪」，
 *   脚本白跑一轮（ad-watch-stuck.log 里 10:00 / 10:30 / 11:00 / 11:30 四次全是这个）。
 *   跑之前先 ready() 一下就没事了 —— 这里把这一步抽成一个 12 行的公共前置。
 *
 * 用法: node tools/ensure-agent.js [--force]
 * 退出码: 0 = 就绪，可以继续；2 = 起不来（调用方跳过本轮，不要用残缺页面干活）
 */
const out = require('../lib/out');
const agent = require('../lib/agent');

(async () => {
  if (!(await agent.isUp())) { out.bad('Playwright 服务没在跑'); out.done(2); return; }

  try {
    const r = await agent.ready({ force: process.argv.includes('--force') });
    out.kv('店铺就绪', (r === true ? agent.ACTIVE : r).join('、'));
  } catch (e) {
    out.bad('店铺起不来：' + e.message);
    out.done(2);
    return;
  }

  out.ok('浏览器侧就绪');
  out.done(0);
})().catch((e) => out.fail(e));
