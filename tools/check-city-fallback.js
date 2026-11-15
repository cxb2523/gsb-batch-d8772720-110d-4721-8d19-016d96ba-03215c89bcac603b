/**
 * tools/check-city-fallback.js — 验证「地址库里没有的城市」的落位规则
 *
 * 老板定的规则（2026-09-29）：
 *   香港 → 广州 / 深圳
 *   澳门 → 珠海 / 广州 / 深圳
 *   其它国外（新加坡、吉隆坡…）→ 随机一线城市（北京/上海/广州/深圳）
 * 只影响「宝贝所在地」；标题里的城市仍用原城市。
 *
 * 本脚本先确保页面装了最新 publish.js，然后：
 *   1) 报 ADDRESS_DB 里有没有这些目标城市（没有就落不下去）
 *   2) 如果 kunPublish 导出了 resolveLocation，直接调它把每个 case 跑 12 次看分布
 *
 * 用法: node tools/check-city-fallback.js
 */
const out = require('../lib/out');
const agent = require('../lib/agent');
const { execFileSync } = require('child_process');

const CASES = ['香港', '澳门', '新加坡', '吉隆坡', '常州', '佛山', '成都'];

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  // 先装最新 publish.js（reload 会清掉，必须重装才测得到新代码）
  try {
    execFileSync(process.execPath, [require('path').join(__dirname, 'ensure-page-ready.js')],
      { stdio: 'ignore', timeout: 300000 });
  } catch (e) { out.warn('ensure-page-ready 非 0 退出，继续尝试'); }

  // 1) 地址库覆盖
  const cov = await agent.evalOnStore(
    '(function(){try{var want=' + JSON.stringify(['广州', '深圳', '珠海', '北京', '上海', '常州', '佛山', '香港', '澳门']) + ';' +
    'var o={};want.forEach(function(c){o[c]=ADDRESS_DB.filter(function(a){return a.city===c;}).length;});' +
    'return JSON.stringify(o);}catch(e){return JSON.stringify({err:e.message});}})()',
    { timeout: 60000 });
  const c = typeof cov === 'string' ? JSON.parse(cov) : cov;
  out.head('地址库覆盖');
  out.table(['城市', 'ADDRESS_DB 条数', '能否落位'],
    Object.keys(c).map((k) => [k, c[k], c[k] > 0 ? '✅ 可以' : '❌ 不行']),
    { maxCol: [8, 14, 10] });

  // 2) 直接调 resolveLocation（如果导出了）
  const t = await agent.evalOnStore(
    "(function(){return typeof (window.kunPublish && window.kunPublish.resolveLocation);})()",
    { timeout: 30000 });
  out.kv('kunPublish.resolveLocation', String(t));

  if (String(t) === 'function') {
    const code = [
      '(function () {',
      '  var cases = ' + JSON.stringify(CASES) + ';',
      '  var o = {};',
      '  for (var i = 0; i < cases.length; i++) {',
      '    var hit = {};',
      '    for (var n = 0; n < 12; n++) {',
      "      var r = window.kunPublish.resolveLocation({ locationMode: 'city', fixedCity: '' }, cases[i]);",
      "      var k = (r && r.city) || '?';",
      '      hit[k] = (hit[k] || 0) + 1;',
      '    }',
      '    o[cases[i]] = Object.keys(hit).map(function (k) { return k + ' + "'×'" + ' + hit[k]; }).join(' + "' '" + ');',
      '  }',
      '  return JSON.stringify(o);',
      '})()',
    ].join('\n');
    const rr = await agent.evalOnStore(code, { timeout: 60000 });
    const res = typeof rr === 'string' ? JSON.parse(rr) : rr;
    out.head('resolveLocation 实测（每例 12 次）');
    out.table(['任务城市', '落到的城市分布'],
      CASES.map((k) => [k, res[k] || '—']), { maxCol: [10, 60] });
    out.plain('');
    out.kv('期望', '香港→广州/深圳；澳门→珠海/广州/深圳；新加坡/吉隆坡→一线随机；常州/佛山/成都→原地');
  } else {
    out.warn('未导出 resolveLocation，无法直接实测；请看上面的地址库覆盖 + 代码里的 CITY_FALLBACK');
  }
  out.done(0);
})().catch((e) => out.fail(e));
