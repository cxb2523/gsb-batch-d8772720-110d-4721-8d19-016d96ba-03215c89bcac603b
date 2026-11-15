/**
 * tools/inspect-item.js — 看一条已上架商品的【真实】所在地 / 价格 / 库存 / 规格
 *
 * 为什么必须看编辑页：商品详情页只显示标题正文，
 * 只有「发闲置」编辑页（https://www.goofish.com/publish?itemId=<id>）能看到真实字段。
 *
 * 同时输出页面里的发布配置，用来解释「为什么所在地不对」：
 *   - typeof ADDRESS_DB      —— 没加载的话 resolveLocation 会退化成随机一线城市
 *   - kun_store_cfg_<店铺>    —— 店铺配置（fixedCity / locationMode / price / stock）
 *
 * 用法: node tools/inspect-item.js <itemId> [itemId...]
 */
const out = require('../lib/out');
const agent = require('../lib/agent');
const { STORE } = require('../lib/env');

const IDS = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!IDS.length) { out.bad('用法: node tools/inspect-item.js <itemId> [...]'); out.done(2); }

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  await agent.ready();

  // ── 1. 先看配置：为什么所在地会不对 ──
  const cfgCode = [
    '(function(){',
    "  var o = { addrDbLoaded: (typeof ADDRESS_DB !== 'undefined'),",
    "            addrDbCount: (typeof ADDRESS_DB !== 'undefined' && ADDRESS_DB.length) || 0 };",
    "  try { o.storeCfg = JSON.parse(localStorage.getItem('kun_store_cfg_' + " + JSON.stringify(STORE) + ") || 'null'); } catch(e) { o.storeCfgErr = e.message; }",
    "  try { o.storeCfgRaw = localStorage.getItem('kun_store_cfg_' + " + JSON.stringify(STORE) + '); } catch(e) {}',
    "  o.curStore = localStorage.getItem('kun_cur_store');",
    '  return JSON.stringify(o);',
    '})()',
  ].join('\n');
  const cfg = await agent.evalOnStore(cfgCode, { timeout: 60000 });
  const c = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;

  out.head('发布配置（页面上真实的）');
  out.kv('当前店铺', c.curStore);
  out.kv('ADDRESS_DB 已加载', c.addrDbLoaded ? '是（' + c.addrDbCount + ' 条）' : '❌ 否 —— 所在地会退化成随机一线城市');
  out.kv('店铺配置', c.storeCfgRaw ? JSON.stringify(c.storeCfg) : '（未设置，全用默认值）');
  if (c.storeCfg) {
    out.kv('  locationMode', String(c.storeCfg.locationMode));
    out.kv('  fixedCity', JSON.stringify(c.storeCfg.fixedCity || ''));
    out.kv('  price / stock', JSON.stringify(c.storeCfg.price || '') + ' / ' + JSON.stringify(c.storeCfg.stock || ''));
  }

  // ── 2. 逐条打开编辑页看真实字段 ──
  for (const id of IDS) {
    const url = 'https://www.goofish.com/publish?itemId=' + id;
    out.head('商品 ' + id);
    out.kv('编辑页', url);
    try {
      await agent.evalOnStore('location.href=' + JSON.stringify(url) + '; "go"', { timeout: 90000 });
      await agent.sleep(12000);

      const dump = [
        '(function(){',
        '  function txt(el){ return el ? (el.innerText||el.textContent||"").replace(/\\s+/g," ").trim() : ""; }',
        '  var o = { href: location.href, title: document.title };',
        '  o.inputs = [];',
        '  var els = document.querySelectorAll("input, textarea, select");',
        '  for (var i = 0; i < els.length && i < 40; i++) {',
        '    var e = els[i];',
        '    o.inputs.push({ tag: e.tagName, type: e.type || "", ph: e.placeholder || "", val: String(e.value || "").slice(0, 40),',
        '                    lbl: txt(e.closest("div") ? e.closest("div").previousElementSibling : null).slice(0, 20) });',
        '  }',
        '  o.body = (document.body.innerText || "").replace(/\\n{2,}/g, "\\n").slice(0, 1800);',
        '  return JSON.stringify(o);',
        '})()',
      ].join('\n');
      const raw = await agent.evalOnStore(dump, { timeout: 90000 });
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // 挑关键词行
      const lines = String(d.body || '').split('\n');
      const hits = [];
      lines.forEach((l, i) => {
        if (/所在地|发货地/.test(l)) {
          // 「宝贝所在地」的【值】通常在它后面几行，单独抓出来
          hits.push(l);
          for (let k = 1; k <= 4 && i + k < lines.length; k++) {
            const nx = lines[i + k].trim();
            if (nx) hits.push('    ↳ ' + nx);
          }
        } else if (/价格|库存|规格|票面|代拍费|广东|江苏|广州|常州|佛山|天河|天宁|禅城/.test(l)) {
          hits.push(l);
        }
      });
      out.plain('  页面关键词行：');
      hits.slice(0, 22).forEach((l) => out.plain('    ' + String(l).slice(0, 100)));
      out.plain('  输入框（前 12 个非空值）：');
      (d.inputs || []).filter((x) => x.val).slice(0, 12).forEach((x) =>
        out.plain('    <' + x.tag + (x.type ? ' ' + x.type : '') + '> val=' + x.val + (x.ph ? '  ph=' + x.ph : '')));
    } catch (e) {
      out.bad('  ' + e.message);
    }
  }
  out.done(0);
})().catch((e) => out.fail(e));
