/**
 * lib/err-class.js —— 「取不到」的可行动分类（2026-11-14）
 *
 * 设计文档：`错误分类-可行动状态-20261114.md`
 * 目的：把今天早上开窗失败（页面没跳过去）、昨天聚光 401（cookie 过期）、前天限流（要停手）、
 *       上周 `page.evaluate: Object`（其实是掉登录）——这四种"同一个取不到"，判成四种不同动作。
 *
 * 铁律：
 *   1. `E8 UNKNOWN` 单独一类，**绝不并进 E0 接口空**；
 *   2. `E0` 不是错误（200 + 结构合法 + 确实空）；
 *   3. `E1/E3` 必须停手（计入 req-gate）；`E2/E4/E7` 重试无用；`E5/E6` 只允许重试 1 次；`E8` 不重试。
 *
 * 用法：
 *   const { classifyError, EXIT } = require('../lib/err-class');
 *   const r = classifyError(err, { script: 'ad-window', href, onAd, needLogin, hasMtop, adProbe });
 *   // r = { code, name, sub, action, retry, gated, alert, exit, evidence }
 */

const EXIT = {
  OK: 0, UNKNOWN: 1, AUTH: 2, RATE: 3, STALE: 4, RISK: 5, HUMAN: 6,
  TIMEOUT: 7, NOTREADY: 8, ENV: 9,
};

const DEFS = {
  E0: { name: 'EMPTY_OK', action: '不处理（拿到 200 且确实空）', retry: false, gated: false, alert: false, exit: EXIT.OK },
  E1: { name: 'RISK_BLOCK', action: '立刻停手，换网络/设备人工确认，不许连点验证', retry: false, gated: true, alert: true, exit: EXIT.RISK },
  E2: { name: 'VERIFY_REQUIRED', action: '停手转人工（需在窗口过滑块/扫码/短信）', retry: false, gated: false, alert: true, exit: EXIT.HUMAN },
  E3: { name: 'RATE_COOLING', action: '停手退避 10/20/40/60 分，什么都不做', retry: false, gated: true, alert: false, exit: EXIT.RATE },
  E4: { name: 'AUTH_STALE', action: '停手转人工重新登录（store-login 扫码）', retry: false, gated: false, alert: true, exit: EXIT.AUTH },
  E5: { name: 'IO_TIMEOUT', action: '重试 1 次（先等 networkidle）', retry: true, gated: false, alert: false, exit: EXIT.TIMEOUT },
  E6: { name: 'PAGE_NOT_READY', action: '重新导航到目标页 1 次，再等 30s；仍不行升级 E8', retry: true, gated: false, alert: false, exit: EXIT.NOTREADY },
  E7: { name: 'ENV_DEP_MISSING', action: '不重试，跑 install/ensure-agent；告警里带命令', retry: false, gated: false, alert: true, exit: EXIT.ENV },
  E8: { name: 'UNKNOWN', action: '不重试，留三件证据，告警标题带 UNKNOWN', retry: false, gated: false, alert: true, exit: EXIT.UNKNOWN },
  E9: { name: 'MISMATCH', action: '数据拿到了但结果不符：查任务/改计划，别动登录', retry: false, gated: false, alert: true, exit: EXIT.UNKNOWN },
  E10: { name: 'STALE', action: '重新采一次，别当实时绿', retry: false, gated: false, alert: false, exit: EXIT.STALE },
};

// 已知特征串 → 分类。**顺序有意义**：先风控/验证/限流/鉴权，再页面/依赖，最后 UNKNOWN。
const RULES = [
  // E1 风控
  { code: 'E1', re: /风控|risk[\s_-]?control|punish|baxia|人机验证|拒绝访问/i },
  // E2 需人工验证
  { code: 'E2', re: /captcha|滑块|短信验证|扫码登录|verification required|verify required|FAIL_SYS_USER_VALIDATE/i },
  // E3 限流（平台明说）
  { code: 'E3', re: /request limit by fatigue|命中平台限流|正在退避中|ERR_REQUEST_LIMIT|限流冷却|rate[\s_-]?limit(ed)?\b|FAIL_SYS_TRAFFIC_LIMIT|TRAFFIC_LIMIT|限流/i },
  // E4 鉴权（过期/无效/不完整）
  { code: 'E4', sub: 'expired', re: /FAIL_SYS_SESSION_EXPIRED|Session过期|session expired|token.{0,6}过期|HTTP 401|\b401\b/i },
  { code: 'E4', sub: 'incomplete', re: /unb\s*(为空|missing|空)|_tb_token_\s*(缺失|missing)/i },
  // E7 环境/依赖
  { code: 'E7', re: /Cannot find module|依赖未安装|is not a function|未就绪（先跑|请先跑\s*node tools\/ensure-agent|ENOENT|EACCES|EADDRINUSE/i },
  // E5 超时/上下文销毁
  { code: 'E5', re: /net::ERR_|Timeout|timeout|timed out|Execution context was destroyed|Navigation failed because/i },
];

function pickDef(code, sub) {
  const d = DEFS[code] || DEFS.E8;
  return { code, name: d.name, sub: sub || null, action: d.action, retry: d.retry, gated: d.gated, alert: d.alert, exit: d.exit };
}

/** 从错误对象/字符串/页面上下文里抽出证据（三件证据里最关键的两件） */
function extractCtx(err, ctx) {
  const e = ctx || {};
  const msg = typeof err === 'string' ? err : (err && (err.message || err.stack) ? (err.message || err.stack) : JSON.stringify(err));
  // 有些调用会把页面信息塞在错误消息 JSON 里（ad-window 就是这么打的）
  let page = {};
  const m = String(msg).match(/\{[\s\S]*"href"[\s\S]*\}/);
  if (m) { try { page = JSON.parse(m[0]); } catch (_) {} }
  return {
    msg: String(msg),
    script: e.script || null,
    href: e.href || page.href || null,
    onAd: e.onAd !== undefined ? e.onAd : page.onAd,
    needLogin: e.needLogin !== undefined ? e.needLogin : page.needLogin,
    hasMtop: e.hasMtop !== undefined ? e.hasMtop : page.hasMtop,
    adProbe: e.adProbe || null,      // 'SUCCESS' | 'FAIL_SYS_…' | null（未知）
    httpStatus: e.httpStatus || null,
    at: new Date().toISOString(),
  };
}

/**
 * 主分类函数
 * @param {*} err  错误对象 / 字符串 / 日志原文
 * @param {object} [ctx] 现场上下文（href/onAd/needLogin/hasMtop/adProbe/httpStatus/script）
 */
function classifyError(err, ctx) {
  const c = extractCtx(err, ctx);
  const evidence = {
    script: c.script, at: c.at, msg_head: c.msg.slice(0, 400),
    href: c.href, onAd: c.onAd, needLogin: c.needLogin, hasMtop: c.hasMtop,
    adProbe: c.adProbe, httpStatus: c.httpStatus,
  };

  // ── 裁判优先：广告接口能不能用，才是唯一的裁判（SOP §2.9）───────────
  //   实测反复踩过：`refreshAutoLogin` 报 fatigue 的同时，广告接口 SUCCESS、命中 3 条计划。
  //   所以「接口 SUCCESS + 页面无矛盾」= 正常，**不许因为别处出现"限流"字样就判 E3**。
  if (c.adProbe && /^SUCCESS/.test(String(c.adProbe))) {
    if (c.onAd === false) return { ...pickDef('E6'), evidence, reason: 'adProbe=SUCCESS 但页面不在目标页（onAd=false）' };
    if (c.needLogin === true) return { ...pickDef('E6'), evidence, reason: 'adProbe=SUCCESS 但页面残留登录墙文案 → 就绪判定不可信' };
    return { ...pickDef('E0'), evidence, reason: 'adProbe=SUCCESS：广告接口可用，其余告警都不作数' };
  }

  // ── 先按文本特征判 ──────────────────────────────────────────────
  for (const r of RULES) {
    if (r.re.test(c.msg)) {
      const out = pickDef(r.code, r.sub);
      return { ...out, evidence };
    }
  }

  // ── 页面状态判据（顺序：先鉴权确证，再就绪判定）────────────────
  // ① 鉴权已确证：广告接口明确说会话过期 → E4a（此时 needLogin 与文案都不可信）
  if (c.adProbe && /FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED|401/i.test(String(c.adProbe))) {
    return { ...pickDef('E4', 'expired'), evidence, reason: 'adProbe=SESSION_EXPIRED' };
  }
  // ② 没到目标页 → E6（今天 08:00 就是这条）
  if (c.onAd === false) {
    return { ...pickDef('E6'), evidence, reason: 'onAd=false（页面活着但不在目标页）' };
  }
  // ③ 到了目标页、接口也通，只是页面上残留「立即登录」文案 → E6（**不许判 E4**，11-09 21:20 栽在这）
  if (c.onAd === true && c.needLogin === true && (c.adProbe === 'SUCCESS' || c.adProbe === null)) {
    return {
      ...pickDef('E6'), evidence,
      reason: 'onAd=true 且 needLogin=true，但 adProbe=' + (c.adProbe || '未知') + ' → 按"就绪判定不可信"处理（文案不是鉴权事实）',
    };
  }

  // ── 其它散装特征 ───────────────────────────────────────────────
  if (/等 \d+s 仍未就绪|仍未就绪|not ready/i.test(c.msg)) return { ...pickDef('E6'), evidence, reason: '就绪超时' };
  if (/❌ eval (失败|内部报错)[\s\S]*Object/.test(c.msg) || /^page\.evaluate: Object$/i.test(c.msg.trim())) {
    // 典型的"未知形状"：报错里只有一个 Object，没有可判特征 → 必须进 UNKNOWN
    return {
      ...pickDef('E8'), evidence,
      reason: 'eval 只回了个 Object，无可判特征；不许当"接口空"，不重试',
      suspected: c.onAd === true ? 'E3（限流）或 E4（鉴权）——两者都缺现场原文，无法区分' : 'E6（页面不在目标页）',
    };
  }

  // ── 兜底：UNKNOWN（绝不并进 E0）────────────────────────────────
  return { ...pickDef('E8'), evidence, reason: '不在已知清单，进 UNKNOWN 并留证' };
}

/**
 * 【2026-11-14 本轮最重要】把「只回了个 Object」变成可判的证据体。
 *
 * 为什么：11-08 / 11-09 两次 page.evaluate: Object 一模一样，**因为没有原文**，
 *   时隔两天还在猜"到底是限流还是掉登录"。这个函数负责让下一次不再猜。
 *
 * @param {object} p {script, href, onAd, needLogin, hasMtop, adProbe, mtopRaw, innerError, stage}
 * @returns {Error} message 里带结构化 JSON；err.ctx / err.stage 供 classifier 直接用
 */
function makeEvalError(p) {
  const parts = {
    stage: (p && p.stage) || 'eval',
    href: (p && p.href) || null,
    onAd: p && p.onAd,
    needLogin: p && p.needLogin,
    hasMtop: p && p.hasMtop,
    adProbe: (p && p.adProbe) || null,
    mtopRaw: (p && p.mtopRaw) || null,          // ← mtop 响应原文（含 ret 串），最关键
    innerError: (p && p.innerError) || null,    // ← 页面内 catch 到的原始错误/对象
  };
  const err = new Error('eval 失败（结构化）: ' + JSON.stringify(parts));
  err.ctx = parts;
  err.stage = parts.stage;
  return err;
}

const isRecoverable = (r) => !!(r && r.retry);        // 允许自动重试（最多 1 次）
const mustStop = (r) => !!(r && r.gated);             // 必须停手（计 req-gate）
const mustAskHuman = (r) => !!(r && r.alert && !r.gated); // 需转人工/告警

module.exports = { classifyError, makeEvalError, EXIT, DEFS, RULES, isRecoverable, mustStop, mustAskHuman };
