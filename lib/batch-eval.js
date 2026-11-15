/**
 * lib/batch-eval.js —— 【可核对结局的批量采集入口】
 *
 * 为什么存在：以前一次采集（广告计划、商品搜索……）就是一串 await evalOnStore，
 * 闸门命中时只会从循环里抛出一个 GateError —— 哪些条目已经发出去、哪些被挡、
 * 退避什么时候结束，调用方只能从异常文本里猜，猜完还不知道半成品能不能用。
 *
 * 本模块把"一串带 label 的 eval 调用"作为一个整体，逐条给出【可核对的结局】：
 *
 *   const batch = require('./lib/batch-eval');
 *   const res = await batch.runBatch([
 *     { label: '广告计划', store, code: '...' },                 // 等价 evalOnStore
 *     { label: '商品搜索', path: '/api/agent/eval',
 *       body: { page: 'goofish', code: '...' } },               // 任意 eval* 路径
 *   ]);
 *   // res.items[i].outcome ∈ gate.OUTCOMES：
 *   //   executed 已执行  blocked 被退避挡住  rejected 超预算被拒  failed 执行失败
 *   // res.summary.interruptedByBackoff / blockedForSec 告诉脚本这一批为何停下。
 *
 * 规则（和 lib/req-gate.js 的闸门语义完全一致，本文件不自造判定）：
 *   ① 被退避挡住 / 超预算被拒的条目【不发出】；一旦本批出现这种条目，后续条目
 *      全部停止发送，逐条保留为 blocked/rejected —— 已完成条目的结局不受影响。
 *   ② 单条"执行失败"（HTTP 错、服务报错、响应带限流特征）只记 failed，
 *      **不丢整批**；但若该失败响应带限流特征，闸门会进入退避，后续条目随即被挡。
 *   ③ 只接受 /api/agent/eval* 路径 —— 非 eval 路径不过闸，也不允许混进本批，
 *      入参阶段直接抛错（闸门从来不管 status / start-one / 截图）。
 *   ④ XY_NO_GATE=1 完全关闭（全批直通，计数也不做）；
 *      XY_GATE_BYPASS=1 只记不拦（不会产生 blocked/rejected）。
 *
 * 状态文件只由 lib/req-gate.js 经【文件锁 + 同目录原子 rename】读写，
 * 本模块绝不直接写状态文件，更不碰发布队列文件（lib/queue.js 的红线）。
 */
const http = require('./http');
const gate = require('./req-gate');

const { OUTCOMES } = gate;

/** 归一化一条入参；非 eval 路径 / 缺 label 直接抛错（整批不启动，不留半套结局） */
function normalizeItem(item, idx, defaultStore) {
  if (!item || typeof item !== 'object') {
    throw new Error('batch-eval: 第 ' + (idx + 1) + ' 条不是对象');
  }
  const label = String(item.label || ('item-' + (idx + 1)));
  let path = item.path;
  let body = item.body;
  // 便捷写法：{ label, store, code } → eval-on-store
  if (!path) {
    if (typeof item.code !== 'string') {
      throw new Error('batch-eval: 「' + label + '」缺少 path 或 code');
    }
    path = '/api/agent/eval-on-store';
    body = { store: item.store || defaultStore, code: item.code };
  }
  if (!gate.isGatedPath(path)) {
    throw new Error('batch-eval: 「' + label + '」的路径 ' + path +
      ' 不是 /api/agent/eval* —— 非 eval 路径不过闸，不能进批量采集入口');
  }
  if (body === undefined || body === null) body = {};
  return { label, path, body, timeout: item.timeout };
}

/**
 * 跑一批。返回值（永不因单条失败而整体抛错 —— 结局都在 items 里）：
 *
 *   {
 *     items: [{
 *       index, label, path, sent,                 // sent=false = 根本没发出
 *       outcome: 'executed'|'blocked'|'rejected'|'failed',
 *       code,                                     // 机器可读的细分原因
 *       message,                                  // 人话原因
 *       waitedMs,                                 // 闸门为最小间隔等了多久
 *       rateLimited,                              // 该条响应是否带限流特征
 *       data, error,                              // 成功/失败各自的载荷
 *     }],
 *     summary: {
 *       total, executed, blocked, rejected, failed,
 *       interrupted: true/false,                  // 本批是否在中途停止发送
 *       interruptedByBackoff, interruptedByBudget,
 *       rateLimited,                              // 是否有条目触发了限流退避
 *       blocked, blockedForSec, blockedUntil, blockedReason,
 *     }
 *   }
 *
 * @param {Array} items   批量 eval 调用，每条至少 { label, path, body } 或 { label, code }
 * @param {object} opts   { store: 默认店铺, timeout, includeData: 是否在结局里带响应体（默认 true） }
 */
async function runBatch(items, opts) {
  opts = opts || {};
  const list = Array.isArray(items) ? items : [];
  const normalized = list.map((it, i) => normalizeItem(it, i, opts.store));

  const results = [];
  let stopReason = null;      // 'backoff' | 'budget' —— 一旦置位，后续条目不再发送
  let batchRateLimited = false;

  for (let i = 0; i < normalized.length; i++) {
    const it = normalized[i];

    // ── 前一条已经把这批打断：后续条目逐条补结局，但一个请求都不发 ──
    if (stopReason) {
      const outcome = stopReason === 'backoff' ? OUTCOMES.BLOCKED : OUTCOMES.REJECTED;
      const snap0 = gate.snapshot();
      results.push({
        index: i, label: it.label, path: it.path, sent: false,
        outcome,
        code: stopReason === 'backoff' ? 'REQ_GATE_BLOCKED' : 'REQ_GATE_BUDGET',
        message: stopReason === 'backoff'
          ? '前序条目已触发退避，本批停止发送（剩余 ' + snap0.blockedForSec + ' 秒）'
          : '前序条目已超窗口预算，本批停止发送',
        waitedMs: 0, rateLimited: false, data: undefined, error: undefined,
      });
      continue;
    }

    const base = { index: i, label: it.label, path: it.path };
    try {
      // http.request 内部对 eval* 路径执行 gate.check（退避/预算/间隔/记账），
      // 并在响应回来后 gate.noteOutcome（限流识别 + 进入退避）。
      // 本模块不重复实现任何闸门判定，保证两条入口的语义永远一致。
      const r = await http.request('POST', it.path, it.body, {
        label: it.label,
        timeout: it.timeout || opts.timeout || 240000,
      });
      const waitedMs = (r.gate && Number(r.gate.waitedMs)) || 0;

      const text = r.buffer ? r.buffer.toString('utf8') : safeText(r.data);
      const limited = gate.looksRateLimited(text);
      if (limited) batchRateLimited = true;

      const bodyOk = r.data && r.data.ok === true;
      if (r.status >= 400 || !bodyOk) {
        results.push(Object.assign({}, base, {
          sent: true,
          outcome: OUTCOMES.FAILED,
          code: limited ? 'RATE_LIMITED' : ('HTTP_' + r.status + (bodyOk ? '' : '_NOT_OK')),
          message: limited
            ? '响应带平台限流特征，闸门已进入退避'
            : ('eval 执行失败（HTTP ' + r.status + '）：' + ((r.data && (r.data.error || r.data.message)) || '').slice(0, 160)),
          waitedMs, rateLimited: limited,
          data: opts.includeData === false ? undefined : r.data,
          error: (r.data && (r.data.error || r.data.message)) || ('HTTP ' + r.status),
        }));
        if (limited) stopReason = 'backoff';   // 退避已由 noteOutcome 写入状态，后续不能再发
        continue;
      }

      results.push(Object.assign({}, base, {
        sent: true,
        outcome: OUTCOMES.EXECUTED,
        code: 'OK',
        message: '已执行',
        waitedMs,
        rateLimited: false,
        data: opts.includeData === false ? undefined : r.data,
        error: undefined,
      }));
    } catch (e) {
      const gateOutcome = gate.outcomeOfGateError(e);
      if (gateOutcome === OUTCOMES.BLOCKED || gateOutcome === OUTCOMES.REJECTED) {
        // 闸门在请求发出前拦下：记账没发生，后续条目同因停止。
        stopReason = gateOutcome === OUTCOMES.BLOCKED ? 'backoff' : 'budget';
        results.push(Object.assign({}, base, {
          sent: false,
          outcome: gateOutcome,
          code: e.code,
          message: e.message,
          waitedMs: 0, rateLimited: false, data: undefined,
          error: { name: e.name, code: e.code, waitSec: e.waitSec, message: e.message },
        }));
        continue;
      }
      // 非闸门错误 = 请求已发出但没拿到可用响应（连不上 / 超时 / 非 JSON）。
      // 单条失败不丢整批：记 failed，继续后面的条目（没有限流证据，不打断本批）。
      results.push(Object.assign({}, base, {
        sent: true,
        outcome: OUTCOMES.FAILED,
        code: (e && e.code) || (e && e.name) || 'ERROR',
        message: String((e && e.message) || e).slice(0, 200),
        waitedMs: 0, rateLimited: false, data: undefined,
        error: { name: e && e.name, code: e && e.code, message: e && e.message },
      }));
    }
  }

  // 汇总以闸门【当前状态】为准 —— blockedForSec 让脚本能直接决定"多久后再来"。
  const snap = gate.snapshot();
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const summary = {
    total: results.length,
    executed: count(OUTCOMES.EXECUTED),
    blocked: count(OUTCOMES.BLOCKED),
    rejected: count(OUTCOMES.REJECTED),
    failed: count(OUTCOMES.FAILED),
    interrupted: stopReason !== null,
    interruptedByBackoff: stopReason === 'backoff',
    interruptedByBudget: stopReason === 'budget',
    rateLimited: batchRateLimited,
    blocked: snap.blocked,
    blockedForSec: snap.blockedForSec,
    blockedUntil: snap.blockedUntil,
    blockedReason: snap.blockedReason,
  };

  return { items: results, summary };
}

function safeText(d) {
  if (d === undefined || d === null) return '';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch (e) { return String(d); }
}

module.exports = { runBatch, OUTCOMES };
