/**
 * tools/test-batch-eval.js —— lib/batch-eval.js 批量采集入口的自测
 *
 * 不依赖真实浏览器 / 线上状态文件：
 *   - XY_GATE_STATE / XY_GATE_CONFIG 指向临时文件和压到个位数的窗口；
 *   - 本机临时起一个 HTTP 服务假扮 8093（XY_PORT 指向它），只收 eval* 请求。
 *
 * 钉死的行为（对应交付验收）：
 *   1. 退避中：逐条返回结局，被挡条目不发出，后续条目也不再发；已完成条目保留
 *   2. 执行中撞上限流：当条 failed(rateLimited) 且闸门进退避，后续全 blocked
 *   3. 窗口预算耗尽：当条 rejected，后续同因 rejected，全部不发出
 *   4. 正常路径：全部 executed 且闸门计数 == 条目数
 *   5. 单条执行失败不丢整批
 *   6. 非 eval 路径不允许进批量入口
 *   7. XY_NO_GATE=1 全关（不计数）；XY_GATE_BYPASS=1 只记不拦
 *   8. tools/req-gate.js --status --json 带得齐批量结局判断字段（含退避剩余秒数）
 *
 * 用法: node tools/test-batch-eval.js
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const spawn = require('child_process').spawn;

const FILE = __filename;
const TMP = process.env.XY_GATE_STATE || path.join(os.tmpdir(), 'batch-eval-test-' + process.pid + '.json');

// ── 子进程模式 ────────────────────────────────────────────────────
// --child        ：NO_GATE / BYPASS 开关语义（窗口=2，一批 3 条）
// --budget-child ：窗口预算语义（per10Min=3，一批 5 条，只回结局 JSON 给父进程断言）
if (process.argv[2] === '--child' || process.argv[2] === '--budget-child') {
  const mode = process.argv[2];
  process.env.XY_GATE_STATE = TMP;
  process.env.XY_GATE_CONFIG = mode === '--budget-child'
    ? JSON.stringify({ per10Min: 3, perHour: 100, minGapMs: 0, maxGapWaitMs: 0, backoffMinutes: [10] })
    : JSON.stringify({ per10Min: 2, perHour: 2, minGapMs: 0, maxGapWaitMs: 0, backoffMinutes: [10] });
  // XY_PORT 在 spawn 时已指向父进程的假服务
  const batch = require('../lib/batch-eval');
  const gate = require('../lib/req-gate');
  const n = mode === '--budget-child' ? 5 : 3;
  const items = [];
  for (let i = 1; i <= n; i++) items.push({ label: 'c' + i, store: '测试店', code: 'return ' + i });
  batch.runBatch(items, { store: '测试店' }).then((res) => {
    process.stdout.write(JSON.stringify({
      total: gate.snapshot().total,
      items: res.items.map((r) => ({ label: r.label, outcome: r.outcome, sent: r.sent, code: r.code })),
      summary: res.summary,
    }));
    // 显式退出：本进程没有自己的 HTTP server（连的是父进程的），但闸门/环境模块
    // 可能留着定时器句柄，不主动退父进程的异步等待会一直挂着。
    process.exit(0);
  }).catch((e) => { process.stdout.write(JSON.stringify({ fatal: String((e && e.message) || e) })); process.exit(1); });
  return;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '   → ' + extra : '')); }
};
const clean = () => { for (const f of [TMP, TMP + '.lock']) { try { fs.unlinkSync(f); } catch (e) { /* 无 */ } } };
const readTmp = () => { try { return JSON.parse(fs.readFileSync(TMP, 'utf8')); } catch (e) { return null; } };

/**
 * 跑一个子进程并收集 stdout。
 * ⚠️ 不用 spawnSync：Windows 上本进程持有 mock 服务的监听 socket，spawnSync 的子进程
 *    会继承该句柄，实测会把同步等待挂到超时（异步 spawn 不受影响）。
 */
function runChild(args, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, args, {
      env: Object.assign({}, process.env, extraEnv),
    });
    let out = '', err = '';
    kid.stdout.on('data', (d) => { out += d.toString(); });
    kid.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { kid.kill(); } catch (e) { /* 已退出 */ } resolve({ status: 'TIMEOUT', stdout: out, stderr: err }); }, timeoutMs || 30000);
    kid.on('exit', (code) => { clearTimeout(t); resolve({ status: code, stdout: out, stderr: err }); });
    kid.on('error', (e) => { clearTimeout(t); resolve({ status: 'SPAWN_ERROR', stdout: out, stderr: err + ' ' + e.message }); });
  });
}

/** 假扮 8093：按 body 里的 @MODE 标记决定回什么；统计实际收到的请求 */
function startMockServer() {
  const hits = { count: 0, paths: [], bodies: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.count++;
      hits.paths.push(req.url);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* 空 body */ }
      hits.bodies.push(body);
      const code = String((body && body.code) || '');
      const m = code.match(/@MODE=(\w+)/);
      const mode = m ? m[1] : 'ok';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (mode === 'ratelimit') {
        // 事故里的真实长相：HTTP 200 + 仅一句 SESSION_EXPIRED（无成功证据 → 判限流）
        return res.end(JSON.stringify({ ok: false, error: 'FAIL_SYS_SESSION_EXPIRED::Session过期' }));
      }
      if (mode === 'fail') {
        return res.end(JSON.stringify({ ok: false, error: '执行失败: 店铺「测试店」未就绪' }));
      }
      if (mode === 'http500') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ ok: false, error: 'boom' }));
      }
      res.end(JSON.stringify({ ok: true, result: 'done:' + (body.store || '') }));
    });
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })); });
}

(async () => {
  // ⚠️ 必须先起假服务、拿到端口并设好 XY_PORT，再 require lib/http ——
  //    env.js 在 require 那一刻就读走 XY_PORT 了，后设不生效。
  const mock = await startMockServer();

  // 主进程把窗口放得很宽，避免各用例在同一个 10 分钟窗口里互相烧预算；
  // 需要小窗口的用例（预算 / 开关）一律走子进程，在子进程里用 XY_GATE_CONFIG 压窗口。
  process.env.XY_GATE_STATE = TMP;
  process.env.XY_GATE_CONFIG = JSON.stringify({ per10Min: 100, perHour: 100, minGapMs: 0, maxGapWaitMs: 0, backoffMinutes: [10, 20, 40, 60] });
  process.env.XY_PORT = String(mock.port);

  const gate = require('../lib/req-gate');
  const batch = require('../lib/batch-eval');
  const { OUTCOMES } = gate;

  const mk = (n, mode) => ({ label: 'L' + n, store: '测试店', code: 'return ' + n + (mode ? '; //@MODE=' + mode : '') });
  const labels = (res) => res.items.map((r) => r.label + ':' + r.outcome + '(sent=' + r.sent + ')').join(' ');

  try {
    console.log('\n══ 1. 退避中：逐条结局 + 后续不发 + 已完成保留 ══');
    clean();
    fs.writeFileSync(TMP, JSON.stringify({
      hits: [], hist: {}, lastCallers: [], strikes: 1,
      blockedUntil: Date.now() + 5 * 60000, blockedReason: '测试制造的退避', lastHitAt: 0, total: 0,
    }));
    const beforeHits = mock.hits.count;
    let res = await batch.runBatch([mk(1), mk(2), mk(3)], { store: '测试店' });
    ok('三条全部给了结局', res.items.length === 3, JSON.stringify(res.items.map((r) => r.outcome)));
    ok('结局全是 blocked', res.items.every((r) => r.outcome === OUTCOMES.BLOCKED), labels(res));
    ok('一条都没发给浏览器', mock.hits.count === beforeHits, '实际收到 ' + (mock.hits.count - beforeHits) + ' 个请求');
    ok('sent=false', res.items.every((r) => r.sent === false));
    ok('summary 标记退避中断', res.summary.interrupted === true && res.summary.interruptedByBackoff === true);
    ok('summary 带剩余退避秒数（约 300 秒）', res.summary.blockedForSec > 250 && res.summary.blockedForSec <= 300, String(res.summary.blockedForSec));
    ok('summary.blocked 与闸门一致', res.summary.blocked === true);
    ok('blocked 条目带原因码 REQ_GATE_BLOCKED', res.items[0].code === 'REQ_GATE_BLOCKED', res.items[0].code);

    console.log('\n══ 2. 执行中撞上限流：当条 failed + 进退避 + 后续 blocked ══');
    clean();
    mock.hits.count = 0;
    res = await batch.runBatch([mk(1), mk(2, 'ratelimit'), mk(3), mk(4)], { store: '测试店' });
    ok('四条结局齐全', res.items.length === 4, JSON.stringify(res.items.map((r) => r.outcome)));
    ok('第 1 条 executed', res.items[0].outcome === OUTCOMES.EXECUTED, labels(res));
    ok('第 2 条 failed 且标记 rateLimited',
      res.items[1].outcome === OUTCOMES.FAILED && res.items[1].rateLimited === true, labels(res));
    ok('第 3/4 条 blocked（不再发送）',
      res.items[2].outcome === OUTCOMES.BLOCKED && res.items[3].outcome === OUTCOMES.BLOCKED, labels(res));
    ok('浏览器只收到前 2 个请求（后 2 个没发）', mock.hits.count === 2, '实际收到 ' + mock.hits.count);
    ok('已完成条目结局保留（第 1 条数据还在）', res.items[0].data && res.items[0].data.ok === true);
    ok('summary 标记限流中断', res.summary.interruptedByBackoff === true && res.summary.rateLimited === true);
    const stAfter = readTmp();
    ok('退避真的写进了状态文件（strikes=1）', !!stAfter && stAfter.strikes === 1, JSON.stringify(stAfter && stAfter.strikes));

    console.log('\n══ 3. 窗口预算上限：rejected + 后续同因 + 不发出（子进程，per10Min=3）══');
    clean();
    mock.hits.count = 0;
    {
      const kid = await runChild([FILE, '--budget-child'], { XY_GATE_STATE: TMP });
      let out = null;
      try { out = JSON.parse(kid.stdout); } catch (e) { /* 置空 */ }
      ok('子进程正常退出', kid.status === 0 && out && !out.fatal,
        String(kid.status) + ' ' + (kid.stderr || '').slice(0, 120) + ' ' + (out && out.fatal));
      ok('五条结局齐全', !!out && out.items.length === 5, out && JSON.stringify(out.items.map((r) => r.outcome)));
      ok('前 3 条 executed', !!out && out.items.slice(0, 3).every((r) => r.outcome === OUTCOMES.EXECUTED),
        out && JSON.stringify(out.items.map((r) => r.outcome)));
      ok('第 4 条 rejected（REQ_GATE_BUDGET）',
        !!out && out.items[3].outcome === OUTCOMES.REJECTED && out.items[3].code === 'REQ_GATE_BUDGET');
      ok('第 5 条同样 rejected 且没发',
        !!out && out.items[4].outcome === OUTCOMES.REJECTED && out.items[4].sent === false);
      ok('浏览器只收到 3 个请求', mock.hits.count === 3, '实际收到 ' + mock.hits.count);
      ok('summary 标记预算中断',
        !!out && out.summary.interruptedByBudget === true && out.summary.interruptedByBackoff === false);
      ok('预算拒绝不产生退避', !!out && out.summary.blocked === false && out.summary.blockedForSec === 0);
    }

    console.log('\n══ 4. 正常路径：全部 executed 且计数正确 ══');
    clean();
    mock.hits.count = 0;
    res = await batch.runBatch([
      { label: 'eval-on-store 简写', store: '测试店', code: 'return 1' },
      { label: 'eval 全写', path: '/api/agent/eval', body: { page: 'goofish', code: 'return 2' } },
    ]);
    ok('两条都 executed', res.items.every((r) => r.outcome === OUTCOMES.EXECUTED), labels(res));
    ok('浏览器收到 2 个请求', mock.hits.count === 2, '实际收到 ' + mock.hits.count);
    ok('闸门 total 计数 = 2', gate.snapshot().total === 2, String(gate.snapshot().total));
    ok('没有中断', res.summary.interrupted === false);
    ok('计数汇总 executed=2', res.summary.executed === 2 && res.summary.total === 2);
    ok('响应数据保留在结局里', res.items[0].data && res.items[0].data.result === 'done:测试店',
      res.items[0].data && res.items[0].data.result);

    console.log('\n══ 5. 单条执行失败不丢整批 ══');
    clean();
    mock.hits.count = 0;
    res = await batch.runBatch([mk(1, 'fail'), mk(2), mk(3, 'http500'), mk(4)], { store: '测试店' });
    ok('四条结局齐全', res.items.length === 4);
    ok('第 1 条 failed（业务失败，无限流特征）',
      res.items[0].outcome === OUTCOMES.FAILED && res.items[0].rateLimited === false, labels(res));
    ok('第 2 条仍然 executed（没被前面的失败带崩）', res.items[1].outcome === OUTCOMES.EXECUTED, labels(res));
    ok('HTTP 500 也算 failed', res.items[2].outcome === OUTCOMES.FAILED && /^HTTP_500/.test(res.items[2].code), res.items[2].code);
    ok('第 4 条继续 executed', res.items[3].outcome === OUTCOMES.EXECUTED, labels(res));
    ok('本批未中断', res.summary.interrupted === false);
    ok('四个请求都真的发了', mock.hits.count === 4, '实际收到 ' + mock.hits.count);
    ok('汇总 failed=2 executed=2', res.summary.failed === 2 && res.summary.executed === 2);

    console.log('\n══ 6. 非 eval 路径不允许进批量入口 ══');
    clean();
    mock.hits.count = 0;
    let threw = null;
    try { await batch.runBatch([{ label: '截图', path: '/api/agent/screenshot', body: {} }]); }
    catch (e) { threw = e; }
    ok('非 eval 路径入参阶段直接抛错', !!threw && /eval/.test(threw.message), threw && threw.message);
    ok('一个请求都没发', mock.hits.count === 0);
    let threw2 = null;
    try { await batch.runBatch([{ label: '空' }]); } catch (e2) { threw2 = e2; }
    ok('缺 code/path 也抛错', !!threw2 && /code/.test(threw2.message), threw2 && threw2.message);

    console.log('\n══ 7. 开关语义：XY_NO_GATE=1 全关 / XY_GATE_BYPASS=1 只记不拦 ══');
    // 窗口只有 2，一批 3 条：开着闸门必被预算拦；两个逃生口都应放过去。
    for (const [envName, envVal] of [['XY_NO_GATE', '1'], ['XY_GATE_BYPASS', '1']]) {
      clean();
      const kid = await runChild([FILE, '--child'], { XY_GATE_STATE: TMP, [envName]: envVal });
      let out = null;
      try { out = JSON.parse(kid.stdout); } catch (e) { /* 解析失败置空 */ }
      ok('[' + envName + '=1] 子进程正常退出', kid.status === 0 && out && !out.fatal,
        String(kid.status) + ' ' + (kid.stderr || '').slice(0, 120) + ' ' + (out && out.fatal));
      ok('[' + envName + '=1] 三条全部 executed',
        !!out && out.items.every((o) => o.outcome === OUTCOMES.EXECUTED),
        out && JSON.stringify(out.items.map((o) => o.outcome)));
      ok('[' + envName + '=1] 三条都真的发出', !!out && out.items.every((o) => o.sent === true));
      ok('[' + envName + '=1] 无中断', !!out && out.summary.interrupted === false);
      if (envName === 'XY_NO_GATE') {
        ok('[' + envName + '=1] 完全关闭：计数也不做（total=0）', !!out && out.total === 0, out && String(out.total));
      } else {
        ok('[' + envName + '=1] 只记不拦：计数照做（total=3）', !!out && out.total === 3, out && String(out.total));
      }
    }

    console.log('\n══ 8. tools/req-gate.js --status --json 字段齐全 ══');
    clean();
    fs.writeFileSync(TMP, JSON.stringify({
      hits: [], hist: {}, lastCallers: [], strikes: 2,
      blockedUntil: Date.now() + 90 * 1000, blockedReason: '测试：剩余秒数', lastHitAt: 0, total: 7,
    }));
    {
      const r = await runChild([path.join(__dirname, 'req-gate.js'), '--status', '--json'], { XY_GATE_STATE: TMP });
      let j = null;
      try { j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch (e) { /* 置空 */ }
      ok('输出合法 JSON', !!j, r.stdout.slice(0, 120));
      ok('退出码 2（退避中）', r.status === 2, String(r.status));
      ok('blocked=true 且带剩余秒数', !!j && j.blocked === true && j.blockedForSec > 80 && j.blockedForSec <= 90,
        j && String(j.blockedForSec));
      ok('blockedUntil 是时间戳', !!j && j.blockedUntil > Date.now());
      ok('blockedReason 透出', !!j && /剩余秒数/.test(j.blockedReason), j && j.blockedReason);
      ok('outcomes 带齐四种结局词表',
        !!j && j.outcomes && j.outcomes.EXECUTED === 'executed' && j.outcomes.BLOCKED === 'blocked' &&
        j.outcomes.REJECTED === 'rejected' && j.outcomes.FAILED === 'failed',
        j && JSON.stringify(j.outcomes));
      ok('原有字段保留（enabled/strikes/total/limits/stateFile）',
        !!j && j.enabled === true && j.strikes === 2 && j.total === 7 && !!j.limits && /batch-eval-test/.test(j.stateFile));
    }
    // 非退避状态退出码应为 0
    clean();
    {
      const r = await runChild([path.join(__dirname, 'req-gate.js'), '--status', '--json'], { XY_GATE_STATE: TMP });
      ok('无退避时退出码 0 且 blocked=false', r.status === 0 && /"blocked":false/.test(r.stdout), String(r.status));
    }
  } finally {
    clean();
    await new Promise((resolve) => mock.server.close(resolve));
  }

  console.log('\n──────────────────────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 测试自己崩了: ' + ((e && e.stack) || e)); clean(); process.exit(1); });
