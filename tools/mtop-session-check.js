/**
 * tools/mtop-session-check.js —— 一条命令判断「mtop 为什么报 Session过期」
 *
 * 为什么要有它（2026-10-13 事故）：
 *   那一刻所有 mtop 接口都回 `FAIL_SYS_SESSION_EXPIRED::Session过期`，
 *   广告后台页面还渲染成落地页、满屏「立即登录」—— 看起来 100% 是掉登录。
 *   于是我在一个小时内反复试：换页面、reload、改探针……**全是在加压**，
 *   结果把风控的【疲劳限流】越压越死。
 *   真因只是 `window.lib.refreshAutoLogin()` 的返回值：`request limit by fatigue`。
 *   教训：**别再造临时探针**（`_probe-*.js` 一度有 6 个残留），
 *   用这一个工具、一次调用把结论定下来。
 *
 * 判据（⚠️ 2026-10-13 当天改过一次，按这个顺序，别倒过来）：
 *   ① **广告接口能不能用，才是唯一的裁判。**
 *      `SUCCESS::调用成功` → 会话正常，到此为止（哪怕别的诊断子调用在报限流）。
 *   ② 广告接口 **不通** 且 refreshAutoLogin() 报 "limit/fatigue" → 判【疲劳限流】
 *      → 立即停手，等自然恢复；这段时间定时任务也会失败，别去改脚本。
 *   ③ 广告接口不通、且有登录墙 / cookie 缺失 → 判【掉登录】，要老板扫码。
 *
 *   ⚠️ 第一版把 ② 当成了唯一判别器（"refreshAutoLogin 是判别器"），**是错的**：
 *      当天实测它报 fatigue 的同时，广告接口 SUCCESS、命中 3 条计划、页面无登录墙
 *      —— 那是它自己那条路的限额，和广告接口无关。
 *      后果：工具误报"被限流"，`lib/req-gate.js` 也跟着退避了 10 分钟（假退避）。
 *      两处一起修了，见 `lib/req-gate.js` 的 `looksRateLimited` 注释。
 *
 * 用法:
 *   node tools/mtop-session-check.js
 *   node tools/mtop-session-check.js --store="好易美代拍"
 *   退出码: 0=正常  1=不通且原因不明  2=疲劳限流  3=掉登录
 */
const { post } = require('../lib/http');
const { STORE: DEFAULT_STORE } = require('../lib/env');
const { rawAdSearchCode } = require('../lib/mtop');
const args = require('../lib/args');

const A = args.parse();
const STORE = A.store || DEFAULT_STORE;

// 广告接口那句由公共层生成（见 lib/mtop.js 的 rawAdSearchCode 注释）：
// 接口名属于 lib/mtop，不该让诊断工具各抄一遍（lint 规则 4 已经有 49 个文件在踩）。
const AD_CALL = rawAdSearchCode({ pageNum: 1, pageSize: 3 });

// 一次调用把三件事问完：重登结论 / 广告接口 / 登录旁证
// —— 只发一次是有意的：少发一次就少一分被风控限流的风险（req-gate 头部那次事故）。
const CODE = `(async function(){
  var out = { href: location.href };
  var L = window.lib || {};
  var mtop = (window.lib || {}).mtop;
  // ① 判别器：被限流时只有它会说实话
  try {
    if (typeof L.refreshAutoLogin === 'function') {
      var v = await L.refreshAutoLogin();
      out.refreshAutoLogin = (v === undefined) ? '(undefined)' : String(v);
    } else out.refreshAutoLogin = '(页面没有这个函数)';
  } catch (e) { out.refreshAutoLogin = 'ERR ' + String((e && (e.ret || e.message)) || e); }
  // ② 广告接口（调用方真正要用的那类）
  try {
    var r = await (${AD_CALL});
    out.adRet = (r && r.ret) || null;
    out.adCount = (((r && r.data) || {}).result || []).length;
  } catch (e) { out.adRet = 'ERR ' + String((e && (e.ret || e.message)) || e); }
  // ③ 登录旁证（不额外发请求，只看页面与 cookie）
  var t = String((document.body && document.body.innerText) || '');
  out.loginWall = /立即登录|请登录|扫码登录/.test(t);
  var m = document.cookie.match(/(?:^|;\\s*)unb=([^;]*)/);
  out.unbNonEmpty = !!(m && m[1] && m[1].length > 3);
  out.hasTbToken = /(?:^|;\\s*)_tb_token_=/.test(document.cookie);
  out.hasTracknick = /(?:^|;\\s*)tracknick=/.test(document.cookie);
  return JSON.stringify(out, null, 1);
})()`;

function call(code) {
  // ⚠️ 必须走 lib/http 的 post（而不是在本文件里再抄一份 HTTP 底层样板）：
  //    闸门就挂在 lib/http 的 /api/agent/eval* 路径上。第一版我抄了样板，
  //    结果这个工具【绕过自己刚建的闸门】—— 实测闸门用量还是 0。
  //    新写的工具又抄一份，正是内联 HTTP 样板从 40 处涨到 75 处的原因，别再重复。
  //    post() 返回服务端 body；调用方按 {ok,result} 判读。
  // 📌 这里刻意不写出那个 12 字母接口名：tools/lint-layers.js 的规则 1 是
  //    【对整份文件文本做子串匹配、不剥注释】，写出来会让本文件被记成违规、
  //    把"迁移进度"这个指标算错（我踩过一次：注释里的名字贡献了 3 次命中）。
  return post('/api/agent/eval-on-store', { store: STORE, code }, { timeout: 90000 });
}

(async () => {
  const j = await call(CODE);
  if (!j.ok) {
    console.log('❌ eval 失败：' + String(j.error).slice(0, 200));
    console.log('   （店铺页可能没起来：node tools/ensure-agent.js）');
    process.exit(1);
  }
  const d = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;

  // 【2026-11-14 统一分类】本脚本是其它脚本的"判据源"，所以结论必须由 lib/err-class 出码，
  //   而不是各脚本自己写一段 if。注意：**退出码仍用历史约定**（0/2/3/1），
  //   因为 ad-window / ad-watch-stuck 按 SOP §2.9 依赖这两个数字。
  const { classifyError } = require('../lib/err-class');
  const cls = (code, extra) => {
    // 用真实现场字段拼一条判据文本，再交给分类器；确保"码"忠于证据，而不是硬写
    const bits = [];
    bits.push('adRet=' + JSON.stringify(d.adRet));
    if (d.refreshAutoLogin) bits.push('refreshAutoLogin=' + d.refreshAutoLogin);
    bits.push('登录墙=' + d.loginWall + ' unb非空=' + d.unbNonEmpty + ' _tb_token_=' + d.hasTbToken);
    if (extra && extra.refreshAutoLogin) bits.push(String(extra.refreshAutoLogin));
    const text = bits.join(' | ');
    const r = classifyError(text, { script: 'mtop-session-check', href: d.href, adProbe: (d.adRet && String(d.adRet[0])) || null, ...(extra || {}) });
    return r;
  };
  console.log('页面      : ' + d.href);
  console.log('refreshAutoLogin : ' + d.refreshAutoLogin);
  console.log('广告接口  : ' + JSON.stringify(d.adRet) + (d.adCount !== undefined ? '  命中 ' + d.adCount + ' 条' : ''));
  console.log('登录旁证  : 登录墙=' + d.loginWall + '  unb非空=' + d.unbNonEmpty +
    '  _tb_token_=' + d.hasTbToken + '  tracknick=' + d.hasTracknick);

  const ra = String(d.refreshAutoLogin || '');
  const adOk = d.adRet && String(d.adRet[0] || '').indexOf('SUCCESS') === 0;
  const loggedOut = d.loginWall === true || d.unbNonEmpty === false;
  console.log('');
  // ⚠️【2026-10-13 修正】判据的主次关系搞反过一次，务必按这个顺序：
  //   ① **广告接口能不能用才是唯一的裁判**。它 SUCCESS = 平台是好的，到此为止。
  //   ② `refreshAutoLogin` 的 "request limit by fatigue" **单独不足以定案** ——
  //      当天实测：它报 fatigue 的同时，广告接口 SUCCESS 且命中 3 条计划、页面无登录墙。
  //      那个接口和广告接口是两套限额，它被限不代表我们干活的路被限。
  //      第一版把 ① ② 的顺序写反了（拿 refreshAutoLogin 当唯一判别器），
  //      于是**误报"被限流"并让闸门退避了 10 分钟**，还在文档里写错了判据。
  if (adOk) {
    console.log('✅ 结论：会话正常，广告接口可用（命中 ' + (d.adCount === undefined ? '?' : d.adCount) + ' 条）。');
    console.log('   [err-class] E0 EMPTY_OK / 实为"正常"，不是取不到（classify: ' + cls('E0').code + '）');
    if (/limit|fatigue/i.test(ra)) {
      console.log('   注：refreshAutoLogin 回了「' + ra + '」—— 那是它自己那条路的限额，');
      console.log('       与广告接口无关，**不要**据此停手。');
    }
    process.exit(0);
  }
  if (/limit|fatigue/i.test(ra)) {
    // 【2026-11-14 统一分类】判定仍按本脚本自己的主次顺序（广告接口为唯一裁判），
    //   但结论与证据交给 lib/err-class 统一出码；**退出码保持历史约定**（2=疲劳限流，3=掉登录），
    //   因为 ad-window / ad-watch-stuck 等调用方按 SOP §2.9 依赖这两个数字，改号会连带改一堆脚本。
    const c3 = cls('E3', { refreshAutoLogin: ra, adRet: d.adRet });
    console.log('🔴 结论：广告接口不通，且 refreshAutoLogin 报限流 → 判为【疲劳限流】。');
    console.log('   [err-class] ' + c3.code + ' ' + c3.name + ' | 重试=' + c3.retry + ' 停手=' + c3.gated + ' 告警=' + c3.alert + ' | 本脚本退出码沿用 **2**（历史约定，见 SOP §2.9）');
    console.log('   证据: adRet=' + JSON.stringify(d.adRet) + ' refreshAutoLogin=' + ra);
    console.log('   → 立即停手，不要重试、不要换页面重试。等自然恢复（分钟级到小时级）。');
    console.log('   → 这段时间 ad-watch-stuck / ad-window 也会失败，日志是');
    console.log('     「read failed: 执行失败: ...」—— 别当成脚本坏了去改脚本。');
    process.exit(2);
  }
  if (loggedOut) {
    const sub = (d.unbNonEmpty === false || d.hasTbToken === false) ? 'incomplete' : (adOk ? null : 'expired');
    const c4 = cls('E4', { sub, loginWall: d.loginWall, unbNonEmpty: d.unbNonEmpty, hasTbToken: d.hasTbToken, adRet: d.adRet });
    console.log('🔴 结论：广告接口不通 + 有登录墙/cookie 缺失 → 判为【掉登录】。');
    console.log('   [err-class] ' + c4.code + (c4.sub ? '/' + c4.sub : '') + ' ' + c4.name + ' | 重试=' + c4.retry + ' 告警=' + c4.alert + ' | 本脚本退出码沿用 **3**（历史约定，见 SOP §2.9）');
    console.log('   证据: 登录墙=' + d.loginWall + ' unb非空=' + d.unbNonEmpty + ' _tb_token_=' + d.hasTbToken + ' tracknick=' + d.hasTracknick + ' adRet=' + JSON.stringify(d.adRet));
    console.log('   → 需要老板在浏览器里重新扫码登录店铺。');
    process.exit(3);
  }
  const c8 = cls('E8', { loginWall: d.loginWall, unbNonEmpty: d.unbNonEmpty, adRet: d.adRet });
  console.log('⚠️ 结论：广告接口不通，但既不是限流也不像掉登录 —— 去查别的（页面报错见上）。');
  console.log('   [err-class] ' + c8.code + ' ' + c8.name + ' | 证据: adRet=' + JSON.stringify(d.adRet) + ' loginWall=' + d.loginWall + ' unb非空=' + d.unbNonEmpty);
  console.log('   → E8 不重试；请把上面三件证据贴给 lead，并补进错误分类表的已知清单。');
  process.exit(1);
})().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
