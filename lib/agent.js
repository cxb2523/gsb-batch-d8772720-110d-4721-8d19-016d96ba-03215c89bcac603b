/**
 * lib/agent.js — 闲鱼店铺浏览器（Playwright 服务）的高层封裝
 *
 * 为什么存在：150 个脚本各自抄了一份「post + eval-on-store + 等页面」，
 * 于是「店铺未就绪」「浏览器未启动」这类错误在 150 个地方各写一遍。
 *
 * 用法：
 *   const agent = require('./lib/agent');
 *   await agent.ready();                          // 确保服务在跑 + 所有店铺页面已打开
 *   const r = await agent.evalOnStore('return location.href');   // 在店铺页执行 JS
 *   const r2 = await agent.evalFile('ad-verify-plans.js');       // 执行一个 .js 文件
 *   await agent.enterAdConsole();                 // 进广告控制台（带缓存，不重复等 16 秒）
 *   const png = await agent.screenshot();         // 截 agent.page
 */
const fs = require('fs');
const path = require('path');
const { post, get, getBuffer, alive } = require('./http');
const { STORE, STORES, ACTIVE, URLS, ROOT, MACHINE } = require('./env');
const storeProfile = require('./store-profile');

let storesReady = false;
let adConsoleAt = 0;

/** 服务活着吗 */
async function isUp() { return alive(); }

/** 状态：账号、页面就绪情况 */
async function status() {
  try { return await get('/api/agent/status', { timeout: 8000 }); }
  catch (e) { return { ok: false, error: e.message }; }
}

async function accounts() {
  const r = await get('/api/agent/accounts');
  return (r && (r.accounts || r.data || r)) || [];
}

/**
 * 确保「当前运营的店铺」页面已打开。
 *
 * 2026-09-28 改：原来调 /api/agent/open-all-stores，会把三个店铺页面**全部**打开。
 * 实际只运营「好易美代拍」，另外两个白占两个 Chromium context（内存 + 一次导航）。
 * 现在按 config.store.active 逐个调 /api/agent/start-one；已就绪的会复用存档，不重登。
 *
 * opts.all = true 时仍开全部（需要用其它店铺时显式传）。
 * 进程内只真正调一次；opts.force 强制重来。
 */
async function ready(opts) {
  opts = opts || {};
  if (storesReady && !opts.force) return true;

  const want = opts.stores || (opts.all ? STORES : ACTIVE);

  // ── 账号互斥闸门（所有登录/发布/广告操作都必经这里）──
  //   红线：一个闲鱼账号只能被一台机器操作。档案里带 ownerMachine，不是本机的【直接拒绝启动】。
  //   放在这里而不是各脚本里：这里是唯一的必经之路，"在每个脚本里记得检查"是靠不住的。
  const blocked = [];
  for (const name of want) {
    try {
      const P = storeProfile.load(name);
      const why = storeProfile.foreignReason(P, MACHINE.id);
      if (why) blocked.push(why);
      else if (!storeProfile.ownerOf(P)) {
        process.stderr.write('[agent] ⚠️ 「' + name + '」没有 ownerMachine（未认领）—— 任何机器都能操作它。' +
          '建议认领：node tools/store-claim.js --store="' + name + '" --apply\n');
      }
    } catch (e) { /* 档案读不了的问题交给各自的脚本报，这里不拦 */ }
  }
  if (blocked.length) {
    throw new Error('拒绝启动店铺（账号互斥）：\n  ' + blocked.join('\n  '));
  }

  const opened = [];
  for (const name of want) {
    const r = await post('/api/agent/start-one', { name }, { timeout: opts.timeout || 180000 });
    if (!r || r.ok !== true) {
      throw new Error('启动店铺「' + name + '」失败：' + ((r && r.error) || '未知'));
    }
    opened.push(name);
  }
  storesReady = true;
  return opened;
}

/** 在指定店铺页执行 JS 字符串（服务端会自动 await，所以可以传 async IIFE） */
async function evalOnStore(code, opts) {
  opts = opts || {};
  const store = opts.store || STORE;
  if (!storesReady) await ready(opts);
  const r = await post('/api/agent/eval-on-store', { store, code }, { timeout: opts.timeout || 240000 });
  if (r && r.blocked) {
    const e = new Error(r.error || 'BLOCKED_BY_DELETE_GUARD');
    e.blocked = true;
    throw e;
  }
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'eval 失败');
  return r.result;
}

/** 执行一个 .js 文件的内容（替代 84 个手抄的 _*-run.js） */
async function evalFile(file, opts) {
  const f = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(f)) throw new Error('找不到要注入的文件：' + f);
  const code = fs.readFileSync(f, 'utf8');
  const raw = await evalOnStore(code, opts);
  if (opts && opts.parse === false) return raw;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

/** 在 goofish / dayu 标签页执行（服务端 /api/agent/eval 支持 page 选择） */
async function evalPage(code, page, opts) {
  opts = opts || {};
  const r = await post('/api/agent/eval', { page: page || 'goofish', code }, { timeout: opts.timeout || 180000 });
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'eval 失败');
  return r.result;
}

/** 让某个店铺的窗口到前台（配合人工看一眼） */
async function showStore(name) {
  return post('/api/agent/show-store', { name: name || STORE }, { timeout: 30000 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 进入广告控制台。
 * mtop 广告接口只在 dayu.goofish.com 域下可用，所有擦亮/出价操作都要先到这儿。
 * 有些脚本用 location.href 跳转，有些用 goto；这里统一成 goto 并等页面 settle。
 * 2 分钟内重复调用不重复跳转（省掉每次 16 秒）。
 */
async function enterAdConsole(opts) {
  opts = opts || {};
  const settle = opts.settle === undefined ? 16000 : opts.settle;
  if (!opts.force && Date.now() - adConsoleAt < (opts.ttl || 120000)) return true;

  if (opts.method === 'goto') {
    await post('/api/agent/navigate', { url: URLS.adConsole }, { timeout: 60000 });
  } else {
    await evalOnStore('location.href="' + URLS.adConsole + '"; "ok"', { store: opts.store, timeout: 60000 });
  }
  if (settle > 0) await sleep(settle);

  // 校验真的到了
  const href = await evalOnStore('location.href', { store: opts.store, timeout: 30000 });
  if (String(href).indexOf('dayu.goofish.com') < 0) {
    throw new Error('没进到广告控制台，当前页面：' + href);
  }
  adConsoleAt = Date.now();
  return true;
}

/** 截图当前 agent.page，返回 Buffer；给了 out 就写文件 */
async function screenshot(out) {
  const buf = await getBuffer('/api/agent/screenshot', { timeout: 60000 });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
  }
  return buf;
}

/** 店铺页现在在哪 */
async function whereAmI(opts) {
  return evalOnStore('JSON.stringify({href:location.href,title:document.title})', Object.assign({ timeout: 30000 }, opts));
}

/** 在店铺页跑一段 mtop 原始代码，返回解析后的结果 */
async function mtop(code, opts) {
  const raw = await evalOnStore('(async()=>{const mtop=window.lib.mtop;' + code + '})()', opts);
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

module.exports = {
  isUp, status, accounts, ready, evalOnStore, evalFile, evalPage, showStore,
  enterAdConsole, screenshot, whereAmI, mtop, sleep,
  STORES, STORE, ACTIVE,
};
