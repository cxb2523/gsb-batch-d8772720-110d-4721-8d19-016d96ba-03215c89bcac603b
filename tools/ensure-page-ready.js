/**
 * tools/ensure-page-ready.js — 让店铺页面具备发布条件（唤醒链与手动催发共用）
 *
 * 为什么需要：
 *   页面上发布要两样东西 ——
 *     ① `ADDRESS_DB`  地址库：没有它 findAddress() 返回 null，直接抛「addr not found」
 *     ② `kunPublish`  发布程序（桌面 publish.js）
 *   而 wake-publish-sleep.ps1 每轮都会 `location.reload()`，**reload 会把这两个都清掉**。
 *   原来它只 reload 然后干等 90 秒，等不到就白跑一轮（日志里的「页面未就绪」）。
 *
 * 本脚本的作用：reload 之后**主动把两个都装回去并逐一校验**，
 *   两样都在 → 退出码 0（调用方可以发布）
 *   缺任何一样 → 退出码 2（调用方跳过本轮，绝不用残缺的页面发布）
 *
 * 为什么用 Node 而不是写在 .ps1 里：两个文件合计 140 KB 且含中文，
 *   走 PowerShell 的 ConvertTo-Json 有编码/转义风险；Node 是 UTF-8 原生，直接读直接发。
 *
 * 用法: node tools/ensure-page-ready.js [--no-reload]
 */
const fs = require('fs');
const out = require('../lib/out');
const agent = require('../lib/agent');
const { PATHS } = require('../lib/env');

const DIR = PATHS.xianyuMonitor + '/';
const PUBJS = DIR + 'publish.js';
const ADBJS = DIR + 'address_db.js';
const NO_RELOAD = process.argv.includes('--no-reload');

const CHK = [
  '(function () {',
  '  try {',
  '    var k = window.kunPublish;',
  "    var a = (typeof ADDRESS_DB !== 'undefined') && ADDRESS_DB ? ADDRESS_DB.length : 0;",
  '    return JSON.stringify({',
  "      kun: (k && typeof k.runBatchPublish === 'function') ? k.runBatchPublish.length : -1,",
  '      adb: a',
  '    });',
  "  } catch (e) { return JSON.stringify({ err: e.message }); }",
  '})()',
].join('\n');

async function check() {
  const r = await agent.evalOnStore(CHK, { timeout: 30000 });
  return typeof r === 'string' ? JSON.parse(r) : r;
}

(async () => {
  if (!(await agent.isUp())) { out.bad('Playwright 服务没在跑'); out.done(2); }
  await agent.ready();

  let pubSrc = '', dbSrc = '';
  try { pubSrc = fs.readFileSync(PUBJS, 'utf8'); }
  catch (e) { out.bad('读不到 publish.js：' + e.message); out.done(2); }
  try { dbSrc = fs.readFileSync(ADBJS, 'utf8'); }
  catch (e) { out.warn('读不到 address_db.js：' + e.message + '（所在地会不准）'); }

  // 1. 刷新页面（加载最新的 publish.js）
  if (!NO_RELOAD) {
    try { await agent.evalOnStore('try{location.reload()}catch(e){}; "reloading"', { timeout: 30000 }); }
    catch (e) { /* 页面跳转会报错，正常 */ }
    await agent.sleep(8000);
  }

  let st = await check();

  // 2. 地址库：reload 后通常丢了，装回去
  //    注意 address_db.js 里是 `var ADDRESS_DB = ...`，在 page.evaluate 的函数作用域里
  //    只是局部变量，必须显式挂到 window 上，publish.js 闭包里的 ADDRESS_DB 才看得到。
  if (dbSrc && !(st.adb > 0)) {
    const wrap = '(function(){' + dbSrc +
      '\n; window.ADDRESS_DB = (typeof ADDRESS_DB !== "undefined" ? ADDRESS_DB : null);' +
      'return window.ADDRESS_DB ? window.ADDRESS_DB.length : "null";})()';
    try {
      const n = await agent.evalOnStore(wrap, { timeout: 120000 });
      out.kv('装入地址库', 'ADDRESS_DB = ' + String(n) + ' 条');
    } catch (e) { out.warn('装地址库失败：' + e.message); }
  }

  // 3. 发布程序：kunPublish 不在就注入源码
  st = await check();
  if (!(st.kun >= 1)) {
    try {
      await agent.evalOnStore(pubSrc, { timeout: 180000 });
      await agent.sleep(3000);
    } catch (e) { out.warn('装 publish.js 失败：' + e.message); }
  }

  st = await check();
  out.head('页面就绪检查');
  out.kv('地址库 ADDRESS_DB', st.adb > 0 ? st.adb + ' 条' : '❌ 没有');
  out.kv('发布程序 kunPublish', st.kun >= 1 ? 'runBatchPublish.length=' + st.kun : '❌ 没有');

  if (st.adb > 0 && st.kun >= 1) { out.ok('就绪，可以发布'); out.done(0); }
  out.bad('未就绪 —— 调用方应跳过本轮（不要用残缺页面发布）');
  out.done(2);
})().catch((e) => out.fail(e));
