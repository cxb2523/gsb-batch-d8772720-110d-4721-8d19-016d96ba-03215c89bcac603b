/**
 * tools/test-req-gate.js —— lib/req-gate.js 的自测（不依赖浏览器、秒级跑完）
 *
 * 为什么必须先测这个再上：闸门会被装进**所有** eval 调用路径（发布、广告、巡检…）。
 * 一个没人测过的开关塞进必经之路，比没有闸门更危险 —— 事故里"守护只是写日志等着腐烂"
 * 就是这么来的。所以这里把每条规则都钉死：
 *   窗口滑动 / 两个窗口的上限 / 最小间隔 / 退避阶梯 / 退避中不叠加 /
 *   成功复位 / 只拦 eval 路径 / 限流特征识别 / 【跨进程并发不丢计数】
 *
 * 用法: node tools/test-req-gate.js
 * 所有用例都在临时状态文件上跑（XY_GATE_STATE），绝不碰线上 req-gate-state.json。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FILE = __filename;
// ⚠️ 必须尊重外部传进来的 XY_GATE_STATE（并发用例里父进程就是靠它让 6 个子进程
//    写同一个文件）。第一版这里是无条件按自己的 pid 重算路径，于是子进程各写各的，
//    父进程读不到 → 并发用例假失败。测试自己踩了"共享状态"的坑。
const TMP = process.env.XY_GATE_STATE || path.join(os.tmpdir(), 'req-gate-test-' + process.pid + '.json');
process.env.XY_GATE_STATE = TMP;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '   → ' + extra : '')); }
};
const clean = () => { try { fs.unlinkSync(TMP); } catch (e) { /* 不存在 */ } };
const readTmp = () => { try { return JSON.parse(fs.readFileSync(TMP, 'utf8')); } catch (e) { return null; } };

// ── 子进程模式：并发用例用 ──
if (process.argv[2] === '--child') {
  const n = Number(process.argv[3]) || 1;
  const gate = require('../lib/req-gate');
  (async () => {
    for (let i = 0; i < n; i++) { try { await gate.check({ label: 'child' }); } catch (e) { /* 上限到了就少记，见用例说明 */ } }
  })();
} else {
  (async () => {
    // 每个用例前重新 require 太麻烦：用 XY_GATE_CONFIG 在一个进程里覆盖不了，
    // 所以下面按"同一份配置、逐个验证规则"来组织，窗口上限用写入状态的方式构造。
    clean();
    process.env.XY_GATE_CONFIG = JSON.stringify({ per10Min: 4, perHour: 6, minGapMs: 0, maxGapWaitMs: 0, backoffMinutes: [10, 20, 40, 60] });
    const gate = require('../lib/req-gate');

    console.log('\n══ 1. 路径判定（只拦 eval）══');
    ok('/api/agent/eval-on-store 要拦', gate.isGatedPath('/api/agent/eval-on-store') === true);
    ok('/api/agent/eval 要拦', gate.isGatedPath('/api/agent/eval') === true);
    ok('/api/agent/status 不拦', gate.isGatedPath('/api/agent/status') === false);
    ok('/api/agent/start-one 不拦', gate.isGatedPath('/api/agent/start-one') === false);
    ok('/api/agent/screenshot 不拦', gate.isGatedPath('/api/agent/screenshot') === false);
    ok('空路径不拦', gate.isGatedPath(undefined) === false);

    console.log('\n══ 2. 限流特征识别 ══');
    ok('fatigue 认', gate.looksRateLimited('request limit by fatigue') === true);
    ok('SESSION_EXPIRED 认（事故里 eval 只回这句）', gate.looksRateLimited('ERR FAIL_SYS_SESSION_EXPIRED::Session过期') === true);
    ok('antiCreep 认', gate.looksRateLimited('FAIL_SYS_ANTI_CREEP') === true);
    ok('中文"访问过于频繁"认', gate.looksRateLimited('访问过于频繁，请稍后再试') === true);
    ok('对象也能认', gate.looksRateLimited({ result: 'x FAIL_SYS_SESSION_EXPIRED y' }) === true);
    ok('正常成功不认', gate.looksRateLimited('{"ok":true,"result":"[]"}') === false);
    // 2026-10-13 当天实测的假阳性：一次 eval 里既有成功的子调用、又有诊断子调用的
    // "request limit by fatigue" 报错 → 平台是好的，不该退避。
    ok('同时有成功证据时不认（今天的假阳性）',
      gate.looksRateLimited('{"ok":true,"result":"SUCCESS::调用成功 fatigue request limit"}') === false);
    ok('纯报错（无成功证据）仍然认', gate.looksRateLimited('只有 fatigue 没有成功') === true);
    ok('接口调用成功 也算成功证据',
      gate.looksRateLimited('SUCCESS::接口调用成功 ... FAIL_SYS_SESSION_EXPIRED') === false);
    ok('null 不认', gate.looksRateLimited(null) === false);
    ok('店铺未就绪不认（那是本地问题，不该退避）', gate.looksRateLimited('执行失败: 店铺「好易美代拍」未就绪') === false);

    console.log('\n══ 3. 记账与快照 ══');
    clean();
    await gate.check({ label: 'a' });
    await gate.check({ label: 'b' });
    let s = gate.snapshot();
    ok('记了 2 次', s.usedHour === 2 && s.total === 2, JSON.stringify({ used: s.usedHour, total: s.total }));
    ok('未触发退避', s.blocked === false);
    const st = readTmp();
    ok('状态文件里有 hits', Array.isArray(st.hits) && st.hits.length === 2);
    const hk = Object.keys(st.hist)[0];
    ok('hist 按小时聚合', !!hk && st.hist[hk] === 2, JSON.stringify(st.hist));
    ok('记下了调用方 label', st.lastCallers.length === 2 && st.lastCallers[0].label === 'a', JSON.stringify(st.lastCallers));

    console.log('\n══ 4. 10 分钟窗口上限（失控保护）══');
    // per10Min=4：现在已有 2 次，再发 2 次到 4，第 5 次应被拒
    await gate.check({ label: 'c' });
    await gate.check({ label: 'd' });
    let err = null;
    try { await gate.check({ label: 'e' }); } catch (e) { err = e; }
    ok('超过 per10Min 抛错', !!err && err.code === 'REQ_GATE_BUDGET', err && err.code);
    ok('错误里带 gate 标记', !!err && err.gate === true);
    ok('错误信息给出等待秒数', !!err && err.waitSec > 0);
    ok('错误信息明确说别重试', !!err && /不要重试|别重试|暂停/.test(err.message));
    ok('被拒的那次没有被记账（仍是 4）', gate.snapshot().usedHour === 4, gate.snapshot().usedHour);

    console.log('\n══ 5. 窗口会滑动（旧记录不再算）══');
    clean();
    {
      const now = Date.now();
      const fake = { hits: [now - 11 * 60000, now - 11 * 60000, now - 11 * 60000, now - 11 * 60000],
        hist: {}, lastCallers: [], strikes: 0, blockedUntil: 0, blockedReason: '', lastHitAt: 0, total: 4 };
      fs.writeFileSync(TMP, JSON.stringify(fake));
    }
    s = gate.snapshot();
    ok('11 分钟前的 4 次不算进 10 分钟窗口', s.used10Min === 0, s.used10Min);
    ok('11 分钟前的 4 次仍在 60 分钟窗口里', s.usedHour === 4, s.usedHour);
    err = null;
    try { await gate.check({ label: 'after-slide' }); } catch (e) { err = e; }
    ok('滑动后又能发了', err === null, err && err.message);

    console.log('\n══ 6. 命中限流 → 退避 ══');
    clean();
    let r = gate.noteOutcome('ERR FAIL_SYS_SESSION_EXPIRED::Session过期');
    ok('进入退避', !!r && r.strikes === 1 && r.backoffMs === 10 * 60000, JSON.stringify(r));
    s = gate.snapshot();
    ok('snapshot 显示被挡', s.blocked === true);
    ok('有剩余秒数', s.blockedForSec > 500 && s.blockedForSec <= 600, s.blockedForSec);
    err = null;
    try { await gate.check({ label: 'while-blocked' }); } catch (e) { err = e; }
    ok('退避中 check 抛 REQ_GATE_BLOCKED', !!err && err.code === 'REQ_GATE_BLOCKED', err && err.code);
    ok('退避中的报错带剩余秒数', !!err && err.waitSec > 0);
    ok('退避中的报错提示 XY_GATE_BYPASS', !!err && /XY_GATE_BYPASS/.test(err.message));

    console.log('\n══ 7. 退避中不叠加（防止自己把自己锁死）══');
    r = gate.noteOutcome('ERR FAIL_SYS_SESSION_EXPIRED::Session过期');
    ok('第二次命中不升档', !!r && r.alreadyBlocked === true, JSON.stringify(r));
    ok('strikes 仍是 1', gate.snapshot().strikes === 1, gate.snapshot().strikes);

    console.log('\n══ 8. 退避时长指数增长 ══');
    // 模拟"上一次退避已到期"，再命中一次 → 应进第二档（20 分钟）
    {
      const st2 = readTmp();
      st2.blockedUntil = Date.now() - 1000;
      fs.writeFileSync(TMP, JSON.stringify(st2));
    }
    r = gate.noteOutcome('FAIL_SYS_SESSION_EXPIRED');
    ok('第 2 次退避 = 20 分钟', !!r && r.strikes === 2 && r.backoffMs === 20 * 60000, JSON.stringify(r));
    {
      const st3 = readTmp();
      st3.blockedUntil = Date.now() - 1000;
      fs.writeFileSync(TMP, JSON.stringify(st3));
    }
    r = gate.noteOutcome('FAIL_SYS_SESSION_EXPIRED');
    ok('第 3 次退避 = 40 分钟', !!r && r.strikes === 3 && r.backoffMs === 40 * 60000, JSON.stringify(r));
    {
      const st4 = readTmp();
      st4.blockedUntil = Date.now() - 1000;
      fs.writeFileSync(TMP, JSON.stringify(st4));
    }
    r = gate.noteOutcome('FAIL_SYS_SESSION_EXPIRED');
    ok('第 4 次退避 = 60 分钟', !!r && r.strikes === 4 && r.backoffMs === 60 * 60000, JSON.stringify(r));
    {
      const st5 = readTmp();
      st5.blockedUntil = Date.now() - 1000;
      fs.writeFileSync(TMP, JSON.stringify(st5));
    }
    r = gate.noteOutcome('FAIL_SYS_SESSION_EXPIRED');
    ok('第 5 次封顶在 60 分钟（不会无限涨）', !!r && r.backoffMs === 60 * 60000, JSON.stringify(r));

    console.log('\n══ 9. 成功一次即复位 ══');
    gate.noteOutcome('{"ok":true,"result":"[]"}');
    s = gate.snapshot();
    ok('strikes 归零', s.strikes === 0, s.strikes);
    ok('退避解除', s.blocked === false);
    err = null;
    try { await gate.check({ label: 'recovered' }); } catch (e) { err = e; }
    ok('复位后能正常发', err === null, err && err.message);

    console.log('\n══ 10. reset ══');
    gate.noteOutcome('FAIL_SYS_SESSION_EXPIRED');
    ok('先制造退避', gate.snapshot().blocked === true);
    gate.reset();
    s = gate.snapshot();
    ok('reset 清掉退避', s.blocked === false && s.strikes === 0);
    ok('reset 清掉计数', s.usedHour === 0 && s.total === 0, JSON.stringify({ h: s.usedHour, t: s.total }));

    console.log('\n══ 11. 跨进程并发不丢计数（锁是否真的有效）══');
    clean();
    const PROCS = 6, EACH = 5;
    const kids = [];
    for (let i = 0; i < PROCS; i++) {
      kids.push(spawnSync(process.execPath, [FILE, '--child', String(EACH)], {
        stdio: 'ignore',
        env: Object.assign({}, process.env, {
          XY_GATE_STATE: TMP,
          XY_GATE_CONFIG: JSON.stringify({ per10Min: 1000, perHour: 1000, minGapMs: 0, maxGapWaitMs: 0, backoffMinutes: [10] }),
        }),
      }));
    }
    const badSpawn = kids.filter((k) => k.error || k.status !== 0);
    ok('子进程都正常退出', badSpawn.length === 0,
      badSpawn.map((k) => (k.error && k.error.message) || ('status=' + k.status)).join('; '));
    const finalSt = readTmp();
    const want = PROCS * EACH;
    ok(PROCS + ' 进程 × ' + EACH + ' 次 = ' + want + ' 次全部记上（无覆盖丢失）',
      !!finalSt && finalSt.total === want, finalSt && finalSt.total);

    console.log('\n══ 12. 接线：lib/http 的 eval 路径真的过闸 ══');
    // 只测"过闸"这件事：制造退避后，eval 请求必须在【打到服务之前】就被拦下。
    // 这里特意用一个不存在的店铺名 —— 如果闸门没接上，报的会是别的错（服务侧错误），
    // 于是这条断言会红。这样"我自以为接上了"就不可能蒙混过关。
    clean();
    {
      const now = Date.now();
      fs.writeFileSync(TMP, JSON.stringify({
        hits: [], hist: {}, lastCallers: [], strikes: 1,
        blockedUntil: now + 5 * 60000, blockedReason: '测试制造', lastHitAt: 0, total: 0,
      }));
    }
    const { post } = require('../lib/http');
    err = null;
    try { await post('/api/agent/eval-on-store', { store: '___不存在的店___', code: 'return 1' }, { timeout: 5000 }); }
    catch (e) { err = e; }
    ok('退避中 eval 抛 REQ_GATE_BLOCKED（说明真的过闸了）',
      !!err && err.code === 'REQ_GATE_BLOCKED', err && (err.code || String(err.message).slice(0, 90)));
    err = null;
    try { await post('/api/agent/status', {}, { timeout: 8000 }); } catch (e) { err = e; }
    ok('退避中 status 不受闸门影响（允许服务侧报错，但不该是闸门的错）',
      !(err && err.gate === true), err && String(err.message).slice(0, 90));

    clean();
    console.log('\n──────────────────────────────');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  })().catch((e) => { console.log('❌ 测试自己崩了: ' + ((e && e.stack) || e)); clean(); process.exit(1); });
}
