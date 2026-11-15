#!/usr/bin/env node
/**
 * tools/err-class-regress.js —— 错误分类回归集（**只跑分类，不改任何脚本行为**）
 *
 * 四条样本全部摘自真实日志（原文照抄，不做修饰）：
 *   ① 2026-11-09 21:20:31  ad-window.log  「页面不可用：广告页未登录」但 onAd=true（页面残留文案）
 *   ② 2026-11-08 23:00:39  ad-window.log  「eval 失败: page.evaluate: Object」
 *   ③ 2026-11-09 04:07:24  ad-window.log  「eval 失败: page.evaluate: Object」（同一症状！）
 *   ④ 2026-11-10 08:01:27  ad-window.log  「等 60s 仍未就绪」onAd=false（停在 seller 工作台）
 *
 * 期望（lead 指定）：①E6 ②E8 ③E3 ④E6
 * 用法：node tools/err-class-regress.js
 */
const { classifyError } = require('../lib/err-class');

const CASES = [
  {
    id: '①', expect: 'E6', expectNote: '页面残留「立即登录」→ 误判未登录，应判就绪判定失败',
    raw: '[2026/11/9 21:20:31] ❌ 页面不可用：广告页未登录（页面停在「立即登录」）  {"href":"https://dayu.goofish.com/?site=FISHAD#/home","onAd":true,"hasMtop":true,"needLogin":true,"ready":"complete","head":"推广平台 登 录 你的宝贝很好，只是缺一个超强擦亮 一键超强擦亮…"}',
    // 现场上下文：同一分钟（21:20:29）mtop-session-check 的广告接口是 SUCCESS；1 分钟后 21:21:47 同一页面成功读出 5 条计划
    ctx: { script: 'ad-window --verify', href: 'https://dayu.goofish.com/?site=FISHAD#/home', onAd: true, needLogin: true, hasMtop: true, adProbe: 'SUCCESS' },
  },
  {
    id: '②', expect: 'E8', expectNote: 'eval 只回 Object，无可判特征 → UNKNOWN + 三件证据',
    raw: '[2026/11/8 23:00:39] ❌ eval 失败: page.evaluate: Object',
    ctx: { script: 'ad-window --off', href: 'https://dayu.goofish.com/?site=FISHAD#/home', onAd: true, needLogin: null, hasMtop: null, adProbe: null },
  },
  {
    id: '③', expect: 'E8', expectSuspected: 'E3', expectNote: '11-09 04:07 —— 日志无限流原文 → E8 + suspected E3（lead 2026-11-14 裁定）',
    raw: '[2026/11/9 04:07:24] ❌ eval 失败: page.evaluate: Object',
    ctx: { script: 'ad-window --verify', href: 'https://dayu.goofish.com/?site=FISHAD#/home', onAd: true, needLogin: null, hasMtop: null, adProbe: null },
  },
  {
    id: '④', expect: 'E6', expectNote: 'onAd=false 停在 seller 工作台 → 重导航 1 次',
    raw: '[2026/11/10 08:01:27] ❌ 页面不可用：等 60s 仍未就绪  {"href":"https://seller.goofish.com/?site=COMMONPRO#/seller-ad/home","onAd":false,"hasMtop":true,"needLogin":false,"ready":"complete","head":"通知 65 消息 10 下载 好易美代拍 迪昂tx 数据 数据总览 商品"}',
    ctx: { script: 'ad-window --on', href: 'https://seller.goofish.com/?site=COMMONPRO#/seller-ad/home', onAd: false, needLogin: false, hasMtop: true, adProbe: null },
  },
  {
    id: '⑤', expect: 'E3', expectNote: '【新增】同一症状但带 mtop 原文 → 证据升级后当场可判 E3（不必等两天后猜）',
    makeErr: {
      script: 'ad-window --on', stage: 'innerEval',
      href: 'https://dayu.goofish.com/?site=FISHAD#/home', onAd: true, needLogin: false, hasMtop: true,
      adProbe: 'FAIL_SYS_TRAFFIC_LIMIT::限流',
      mtopRaw: '{"api":"mtop.taobao.idle.ad.campaign.search","ret":["FAIL_SYS_TRAFFIC_LIMIT::限流"]}',
      innerError: '[object Object]',
    },
  },
];

let pass = 0, fail = 0;
console.log('── 错误分类回归（只分类，不改行为）────────────');
CASES.forEach((c) => {
  const errObj = c.makeErr ? require('../lib/err-class').makeEvalError(c.makeErr) : c.raw;
  const r = classifyError(errObj, c.makeErr ? errObj.ctx : c.ctx);
  const susOk = !c.expectSuspected || String(r.suspected || '').includes(c.expectSuspected);
  const ok = r.code === c.expect && susOk;
  if (ok) pass++; else fail++;
  console.log('');
  console.log((ok ? '✅' : '❌') + ' 样本 ' + c.id + '  期望 ' + c.expect + ' → 实判 ' + r.code + ' (' + r.name + (r.sub ? '/' + r.sub : '') + ')');
  console.log('   输入    : ' + (c.raw ? c.raw.slice(0, 110) + '…' : 'makeEvalError（含 mtop 原文）'));
  console.log('   理由    : ' + (r.reason || '(按特征串命中)'));
  console.log('   动作    : ' + r.action + ' | 重试=' + r.retry + ' 停手=' + r.gated + ' 告警=' + r.alert + ' exit=' + r.exit);
  if (r.suspected) console.log('   疑似    : ' + r.suspected);
  console.log('   证据    : href=' + r.evidence.href + ' onAd=' + r.evidence.onAd + ' needLogin=' + r.evidence.needLogin + ' adProbe=' + r.evidence.adProbe);
});
console.log('');
console.log('结果: ' + pass + ' 对 / ' + fail + ' 错（共 ' + CASES.length + ' 条）');
process.exit(fail ? 1 : 0);
