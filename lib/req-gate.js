/**
 * lib/req-gate.js —— 【请求预算闸门】：滑动窗口计数 + 突发间隔 + 命中限流后指数退避
 *
 * ── 为什么必须有（2026-10-13 真实事故）──────────────────────────────
 * 老板让「南京 wuuhaa 开推广」，计划建完我顺手又核了一堆事：一小时里反复
 * `adPlans()` 轮询 + 可投性查询 + 多次 `editdetail` 探针 + 4 次页面导航。
 * 结果触发了淘宝风控的【疲劳限流】：所有 mtop 接口回报
 * `FAIL_SYS_SESSION_EXPIRED::Session过期`，广告后台渲染成落地页、满屏「立即登录」
 * —— **外观和真掉登录一模一样**。我不知道是限流，就继续换页面重试、reload，
 * **每一次重试都在加压**，越压越死。
 *
 * 当时的防护为什么没挡住：
 *   1. `lib/idle.js` 那套「用户在用电脑就跳过」的闸门**只管定时任务**；
 *      我手敲的 `node _probe-*.js` 全部绕过它，一个都没被拦。
 *   2. 仓库里根本没有"我这一小时已经打了多少次"的概念 —— 没法自觉，只能靠记忆。
 *
 * ── 三道防线（按重要性排序）──────────────────────────────────────
 *   ① **退避是最重要的**：平台一旦说限流，立刻停手 10 分钟起（而不是继续试）。
 *      事故里真正把情况搞糟的就是"再看一眼好了没"。
 *   ② **最小间隔**：给连续调用之间插入间隔，把突发拉平。手工探针最爱连着发。
 *   ③ **窗口上限**：兜住失控的循环（bug 导致的死循环调用）。
 *      注意：窗口上限是**失控保护**，不是限流的精确阈值 —— 真阈值未知，
 *      所以默认给得较宽（宁可漏杀不可误杀，批量发布不能被它打断）。
 *      要收紧就按 `--report` 的真实数据调，别拍脑袋。
 *
 * ── 覆盖范围 ─────────────────────────────────────────────────
 * 挂在 `lib/http.js` 的 `/api/agent/eval*` 路径上（`lib/agent.js` 自己也走它），
 * 所以**所有** eval-on-store / eval / mtop 调用都过闸门。
 * 不拦 `/api/agent/status` `/start-one` `/screenshot` 等 —— 那些只打本机 8093，
 * 不消耗闲鱼的请求配额，拦了没意义还会添乱。
 * ⚠️ 仍内联 `http.request` 的历史脚本绕过本闸门（那批正在迁移到 lib/http）。
 *
 * ── 开关 ─────────────────────────────────────────────────────
 *   XY_NO_GATE=1      完全关掉（计数也不做）—— 只在明确知道自己在干什么时用
 *   XY_GATE_BYPASS=1  只跳过"拦"，仍然计数（临时放行一次批量操作）
 *   配置见 lib/config.json 的 reqGate；本文件内置默认值兜底。
 */
const fs = require('fs');
const path = require('path');

let ROOT = __dirname;
let CFG = {};
try {
  const env = require('./env');
  ROOT = env.ROOT;
  CFG = (env.cfg && env.cfg.reqGate) || {};
} catch (e) { /* env 读不了就用内置默认值，本闸门不能因此失效 */ }

const DEFAULTS = {
  enabled: true,
  per10Min: 60,        // 失控保护：10 分钟窗口
  perHour: 240,        // 失控保护：60 分钟窗口
  minGapMs: 1200,      // 连续调用之间的最小间隔（拉平突发）
  maxGapWaitMs: 5000,  // 为了满足 minGap 最多等这么久，超过就直接放行（别把调用方挂死）
  backoffMinutes: [10, 20, 40, 60],   // 第 1/2/3/4+ 次命中限流后的停手时长
  stateFile: 'req-gate-state.json',
  keepHistHours: 48,
};
const C = Object.assign({}, DEFAULTS, CFG);

// 测试 / 临时调参的一次性覆盖（不进配置文件）：
//   XY_GATE_CONFIG='{"perHour":10,"minGapMs":0}'
// 存在理由：闸门必须能被**独立验证**（不然就是把一个没人测过的开关塞进所有调用路径）。
// tools/test-req-gate.js 就是靠它把窗口压到个位数、把间隔压到 0，秒级跑完全部用例。
if (process.env.XY_GATE_CONFIG) {
  try { Object.assign(C, JSON.parse(process.env.XY_GATE_CONFIG)); }
  catch (e) { process.stderr.write('[req-gate] XY_GATE_CONFIG 不是合法 JSON，忽略：' + e.message + '\n'); }
}

const DISABLED = process.env.XY_NO_GATE === '1';
const BYPASS = process.env.XY_GATE_BYPASS === '1';

// XY_GATE_STATE 让测试用临时文件，绝不碰线上的 req-gate-state.json
const STATE_PATH = process.env.XY_GATE_STATE || C.stateFile;
const STATE = path.isAbsolute(STATE_PATH) ? STATE_PATH : path.join(ROOT, STATE_PATH);
const LOCK = STATE + '.lock';
const LOCK_STALE_MS = 3000;

const MIN = 60000;
const HOUR = 3600000;

/** 闸门只管 eval 类路径 */
function isGatedPath(p) {
  return /^\/api\/agent\/eval/.test(String(p || ''));
}

class GateError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'GateError';
    this.gate = true;
    Object.assign(this, extra || {});
  }
}

/**
 * 从任意响应文本里识别"被限流了"。
 *
 * ⚠️ `FAIL_SYS_SESSION_EXPIRED` 必须算进来 —— 事故里 eval 的返回**只有**这一句，
 *    "request limit by fatigue" 只出现在页面自带的 refreshAutoLogin() 里。
 *    所以不能只认 fatigue 字样，否则闸门在最需要它的时候是哑的。
 *
 * ⚠️⚠️ **但"有成功证据"时必须判为没被限流** —— 这是 2026-10-13 当天实测出的假阳性：
 *    我的 `tools/mtop-session-check.js` 一次 eval 里既问 refreshAutoLogin（回
 *    "request limit by fatigue"）又问广告接口（回 `SUCCESS::调用成功`，命中 3 条计划）。
 *    旧规则在整段文本里匹配到 fatigue 就退避 10 分钟 —— **平台明明是好的**。
 *    教训：一次 eval 里可能有多个子调用，其中一个的报错不代表整体被限流；
 *    只要同一次响应里出现了成功证据，就不该据此停手。
 *    （真事故里整段响应没有任何 SUCCESS，所以这条收紧不会漏掉真限流。）
 */
const SUCCESS_MARK = /SUCCESS::(?:调用|接口调用)成功/;

const RATE_LIMIT_PATTERNS = [
  /request\s+limit/i,
  /fatigue/i,
  /anti.?creep/i,
  /anti.?flood/i,
  /FAIL_SYS_SESSION_EXPIRED/i,
  /FAIL_SYS_TRAFFIC_LIMIT/i,
  /FAIL_SYS_ILLEGAL_ACCESS/i,
  /访问过于频繁/,
  /请求过于频繁/,
];

function looksRateLimited(text) {
  if (text === undefined || text === null) return false;
  const s = typeof text === 'string' ? text : safeStringify(text);
  if (SUCCESS_MARK.test(s)) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(s));
}

function safeStringify(x) {
  try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
}

// ── 状态读写（跨进程 + 原子）────────────────────────────────────
function emptyState() {
  return { hits: [], hist: {}, lastCallers: [], strikes: 0, blockedUntil: 0, blockedReason: '', lastHitAt: 0, total: 0 };
}

function readState() {
  try {
    let s = fs.readFileSync(STATE, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const j = JSON.parse(s);
    return Object.assign(emptyState(), j);
  } catch (e) { return emptyState(); }
}

function writeState(st) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, STATE);     // 同目录 rename 是原子的：读方永远看不到半个文件
}

function sleepSync(ms) {
  // check/记录 都是同步小操作，用同步睡眠避免 async 传染（调用方在 Promise 里，无所谓）
  const until = Date.now() + ms;
  // eslint-disable-next-line no-constant-condition
  while (Date.now() < until) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, until - Date.now())); }
    catch (e) { /* 环境不支持就忙等这一小段 */ }
  }
}

/**
 * 文件锁。定时任务（每 30 分钟）和手工脚本会【同时】跑，
 * 没有锁的话 read-modify-write 会互相覆盖计数 —— 那闸门就形同虚设。
 * 拿不到锁不抛错：宁可少记一次，也不要让业务挂掉。
 */
function withLock(fn, opts) {
  opts = opts || {};
  const tries = opts.tries || 60;
  for (let i = 0; i < tries; i++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      try { return fn(); } finally { try { fs.unlinkSync(LOCK); } catch (e) { /* 已被清 */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 锁太老 = 上一个进程死了没清（崩溃/被杀），抢过来
      try {
        const age = Date.now() - fs.statSync(LOCK).mtimeMs;
        if (age > LOCK_STALE_MS) { try { fs.unlinkSync(LOCK); } catch (e2) { /* 别人先抢了 */ } continue; }
      } catch (e2) { continue; }   // 锁刚被释放，直接重试
      sleepSync(25 + i * 5);
    }
  }
  return null;   // 放弃（不阻塞业务）
}

function prune(st, now) {
  const cut = now - HOUR;
  st.hits = (st.hits || []).filter((t) => Number(t) > cut);
  const histCut = now - C.keepHistHours * HOUR;
  const h = {};
  for (const k of Object.keys(st.hist || {})) {
    const t = Date.parse(k + ':00:00');
    if (isNaN(t) || t >= histCut) h[k] = st.hist[k];
  }
  st.hist = h;
  if ((st.lastCallers || []).length > 20) st.lastCallers = st.lastCallers.slice(-20);
  return st;
}

function hourKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0');
}

function backoffMs(strikes) {
  const arr = C.backoffMinutes && C.backoffMinutes.length ? C.backoffMinutes : DEFAULTS.backoffMinutes;
  const idx = Math.min(Math.max(strikes, 1), arr.length) - 1;
  return Number(arr[idx]) * MIN;
}

/** 当前状态快照（只读，不加锁：给 --status 用，允许轻微误差） */
function snapshot() {
  const now = Date.now();
  const st = prune(readState(), now);
  const recent10 = st.hits.filter((t) => Number(t) > now - 10 * MIN).length;
  return {
    now,
    enabled: !DISABLED && C.enabled !== false,
    bypass: BYPASS,
    blocked: Number(st.blockedUntil) > now,
    blockedUntil: Number(st.blockedUntil) || 0,
    blockedForSec: Math.max(0, Math.round(((Number(st.blockedUntil) || 0) - now) / 1000)),
    blockedReason: st.blockedReason || '',
    strikes: st.strikes || 0,
    used10Min: recent10,
    usedHour: st.hits.length,
    total: st.total || 0,
    limits: { per10Min: C.per10Min, perHour: C.perHour, minGapMs: C.minGapMs, backoffMinutes: C.backoffMinutes },
    hist: st.hist || {},
    lastCallers: st.lastCallers || [],
    stateFile: STATE,
  };
}

/**
 * 过闸。会：
 *   ① 被退避挡住 → 抛 GateError（code REQ_GATE_BLOCKED）
 *   ② 超窗口上限 → 抛 GateError（code REQ_GATE_BUDGET）
 *   ③ 距上次调用太近 → 睡一小会儿（把突发拉平）
 *   ④ 记账，并返回本次的 label
 * 返回 { skipped, waitedMs }
 */
async function check(opts) {
  opts = opts || {};
  if (DISABLED || C.enabled === false) return { skipped: true, waitedMs: 0 };

  const now = Date.now();
  const st = prune(readState(), now);
  const label = String(opts.label || opts.path || 'unknown');

  // ① 退避
  if (Number(st.blockedUntil) > now) {
    const waitSec = Math.ceil((st.blockedUntil - now) / 1000);
    if (!BYPASS) {
      throw new GateError(
        '[req-gate] 正在退避中，还有 ' + waitSec + ' 秒（原因：' + (st.blockedReason || '命中平台限流') +
        '）。**不要重试** —— 重试只会把限流压得更死。\n' +
        '  想立刻放行：XY_GATE_BYPASS=1 加在命令前面（会记录，用于临时批量操作）。\n' +
        '  看状态：node tools/req-gate.js --status',
        { code: 'REQ_GATE_BLOCKED', waitSec });
    }
  }

  // ② 窗口上限（失控保护）
  const recent10 = st.hits.filter((t) => Number(t) > now - 10 * MIN).length;
  if (!BYPASS && recent10 >= C.per10Min) {
    const oldest = Math.min.apply(null, st.hits.filter((t) => Number(t) > now - 10 * MIN));
    const waitSec = Math.max(1, Math.ceil((oldest + 10 * MIN - now) / 1000));
    throw new GateError(
      '[req-gate] 10 分钟内已发 ' + recent10 + ' 次 eval 调用（上限 ' + C.per10Min + '），暂停 ' + waitSec + ' 秒。\n' +
      '  这是失控保护：正常批量发布不该这么密。真需要就 XY_GATE_BYPASS=1。\n' +
      '  看是谁在烧：node tools/req-gate.js --report',
      { code: 'REQ_GATE_BUDGET', waitSec });
  }
  if (!BYPASS && st.hits.length >= C.perHour) {
    const waitSec = Math.max(1, Math.ceil((Math.min.apply(null, st.hits) + HOUR - now) / 1000));
    throw new GateError(
      '[req-gate] 60 分钟内已发 ' + st.hits.length + ' 次 eval 调用（上限 ' + C.perHour + '），暂停 ' + waitSec + ' 秒。\n' +
      '  看是谁在烧：node tools/req-gate.js --report',
      { code: 'REQ_GATE_BUDGET', waitSec });
  }

  // ③ 最小间隔
  let waitedMs = 0;
  const last = Number(st.lastHitAt) || 0;
  const gap = now - last;
  if (last && gap < C.minGapMs) {
    const want = C.minGapMs - gap;
    if (want <= C.maxGapWaitMs) { await new Promise((r) => setTimeout(r, want)); waitedMs = want; }
  }

  // ④ 记账
  const at = Date.now();
  withLock(() => {
    const s2 = prune(readState(), at);
    s2.hits.push(at);
    s2.lastHitAt = at;
    s2.total = (s2.total || 0) + 1;
    const k = hourKey(at);
    s2.hist[k] = (s2.hist[k] || 0) + 1;
    s2.lastCallers.push({ at, label: label.slice(0, 80) });
    if (s2.lastCallers.length > 20) s2.lastCallers = s2.lastCallers.slice(-20);
    writeState(s2);
  });

  return { skipped: false, waitedMs };
}

/**
 * 报告一次调用的结果。
 *   ok=true  → 记为"恢复正常"，把 strikes 清零（下次命中重新从第一次的时长退避）
 *   命中限流 → 进入退避，时长按 strikes 指数增长
 * ⚠️ **已经在退避中就不再叠加** —— 否则一次事故里每条失败调用都把时长翻倍，
 *    几分钟内就能涨到几小时，那就成了自己把自己锁死。
 */
function noteOutcome(text, ok) {
  if (DISABLED || C.enabled === false) return null;
  const now = Date.now();
  const hit = looksRateLimited(text);

  if (!hit && ok !== false) {
    // 快路径：绝大多数调用都是"成功的普通调用"，此时根本没有退避要复位。
    // 先生读一次状态（rename 原子写，无锁读是安全的），没有退避就直接返回，
    // 避免每次 eval 都去抢一次锁 —— 那会让闸门本身成为瓶颈。
    const quick = readState();
    if (!(quick.strikes > 0) && !(Number(quick.blockedUntil) > now)) return null;

    // 成功一次就复位。用锁读改写，避免和 check() 的记账互相覆盖。
    const r = withLock(() => {
      const st = prune(readState(), now);
      if ((st.strikes || 0) === 0 && !(Number(st.blockedUntil) > now)) return null;
      st.strikes = 0;
      st.blockedUntil = 0;
      st.blockedReason = '';
      writeState(st);
      return { reset: true };
    });
    return r;
  }

  if (!hit) return null;

  return withLock(() => {
    const st = prune(readState(), now);
    if (Number(st.blockedUntil) > now) return { alreadyBlocked: true, until: st.blockedUntil };
    st.strikes = (st.strikes || 0) + 1;
    const ms = backoffMs(st.strikes);
    st.blockedUntil = now + ms;
    st.blockedReason = '命中平台限流（第 ' + st.strikes + ' 次）：' + safeStringify(text).slice(0, 160);
    writeState(st);
    process.stderr.write('[req-gate] 🔴 命中平台限流 → 停手 ' + Math.round(ms / MIN) + ' 分钟（第 ' +
      st.strikes + ' 次）。**不要重试**。\n');
    return { strikes: st.strikes, backoffMs: ms, until: st.blockedUntil };
  });
}

/** 手工清空（例如老板确认已重新登录、限流已解除） */
function reset() {
  return withLock(() => { writeState(emptyState()); return true; });
}

module.exports = {
  check, noteOutcome, snapshot, reset, isGatedPath, looksRateLimited,
  GateError, DEFAULTS,
  get config() { return Object.assign({}, C); },
  get stateFile() { return STATE; },
};
