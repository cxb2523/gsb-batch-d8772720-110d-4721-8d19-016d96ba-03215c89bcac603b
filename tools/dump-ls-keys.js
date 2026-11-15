/**
 * tools/dump-ls-keys.js — 列出店铺页面里所有 kun* 的 localStorage 键
 *
 * 用途：查「规格模板/店铺配置到底存在哪」。publish.js 的规格来源是
 *   `task.specs || loadStoreConfig().specs`，键名是 kun_store_cfg_<店铺>。
 * 页面里到底有没有这个键、内容是什么，只有列出来才知道。
 *
 * 用法: node tools/dump-ls-keys.js [--full]
 */
const out = require('../lib/out');
const agent = require('../lib/agent');

const FULL = process.argv.includes('--full');
const PRE = FULL ? 4000 : 200;

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  await agent.ready();

  const code = [
    '(function () {',
    '  var o = [];',
    '  for (var i = 0; i < localStorage.length; i++) {',
    '    var k = localStorage.key(i);',
    "    if (String(k).indexOf('kun') !== 0) continue;",
    "    var v = localStorage.getItem(k) || '';",
    '    o.push({ k: k, len: v.length, head: v.slice(0, ' + PRE + ') });',
    '  }',
    '  o.sort(function (a, b) { return a.k < b.k ? -1 : 1; });',
    '  return JSON.stringify({ origin: location.origin, href: location.href, keys: o });',
    '})()',
  ].join('\n');

  const raw = await agent.evalOnStore(code, { timeout: 60000 });
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;

  out.head('页面 localStorage · kun*');
  out.kv('origin', j.origin);
  out.kv('href', String(j.href).slice(0, 80));
  out.kv('键数', (j.keys || []).length);
  (j.keys || []).forEach((x) => {
    out.plain('');
    out.plain('  ' + x.k + '   (' + x.len + ' 字节)');
    out.plain('    ' + String(x.head).replace(/\s+/g, ' ').slice(0, FULL ? 900 : 200));
  });
  out.done(0);
})().catch((e) => out.fail(e));
