#!/usr/bin/env node
/**
 * tools/sched-health.js —— 调度体检（实施清单 A1，**只读**）
 *
 * 解决什么问题（2026-11-09 活证据）：
 *   「关窗守护」XianyuAdWindowGuard 实测 Disabled、Last Run 2026/10/14 —— 停摆近一个月没人知道；
 *   同期 11-06、11-08 两次关窗失败、11-09 08:00 开窗失败(exit 3)，全都没人看见。
 *   → 22 个 Xianyu* 任务里，没有任何一个在检查"别人有没有成功跑"。
 *
 * 做什么：扫全部 `Xianyu*` 与 `jg-*` 计划任务，报**三红**：
 *   R1 Disabled        —— 该跑的却停用
 *   R2 LastResult ≠ 0  —— 上次失败（267011/0x41303 = 还没跑过，单列黄，不算红）
 *   R3 超过 2× 周期没跑 —— 用 Schedule Type 推周期；推不出就按 26h 兜底并标 unknown
 *
 * 纪律：**只读**。只调 `schtasks /query`、只写本地 `data/`。不改任务、不启动任务、不重启服务。
 *
 * 用法：
 *   node tools/sched-health.js               # 人读表格
 *   node tools/sched-health.js --json        # 只输出 JSONL 到 data/sched-health.jsonl
 *   node tools/sched-health.js --prefix=Xianyu   # 只查某前缀
 *
 * 退出码：0 全绿 / 1 有红 / 2 体检自己失败（也要落一条记录，别静默）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'sched-health.jsonl');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => {
  const eq = argv.find((x) => x.startsWith('--' + k + '='));
  if (eq) return eq.slice(k.length + 3);
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const JSONONLY = has('--json');
const PREFIX = (val('prefix') || '').toLowerCase();

// ── 周期推断：从 Schedule Type / Start Time / 任务名 猜"应该多久跑一次"────────
function periodHours(task) {
  const name = String(task.TaskName || '');
  const st = String(task['Schedule Type'] || '').toLowerCase();
  if (/minute/.test(st)) return 0.5;
  if (/hour/.test(st)) return 1;
  if (/daily/.test(st) || /每天/.test(st)) return 24;
  if (/weekly/.test(st) || /每周/.test(st)) return 168;
  // 名字里带 1900 / 8AM / 11PM / 0900 / 1130 这类整点时点，归到 daily
  if (/\d{3,4}(am|pm)?/i.test(name)) return 24;
  return null; // 推不出
}
const H = 3600 * 1000;
function parseLocal(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/\//g, '-').replace(/\s+/, 'T'));
  return Number.isFinite(t) ? t : null;
}

function readTasks() {
  // schtasks /query /fo csv /v：字段里带引号，用 ConvertFrom-Json 不合适，这里手工解析 CSV
  const out = execFileSync('schtasks', ['/query', '/fo', 'csv', '/v'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const parseLine = (line) => {
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  };
  const header = parseLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i] === undefined ? '' : cells[i].trim(); });
    return o;
  });
}

function main() {
  const now = Date.now();
  let tasks = [];
  try { tasks = readTasks(); }
  catch (e) {
    const rec = { ts: new Date().toISOString(), check: 'sched-health', verdict: 'error', error: String(e.message || e) };
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n', 'utf8');
    console.error('❌ 体检自己失败了（已落盘）:', rec.error);
    process.exit(2);
  }

  const scope = tasks.filter((t) => {
    const n = String(t.TaskName || '');
    const base = n.replace(/^\\/, '');
    if (PREFIX) return base.toLowerCase().startsWith(PREFIX);
    return /^xianyu/i.test(base) || /^jg-/i.test(base) || /^XianyuJg/i.test(base);
  });

  const rows = [], reds = [], yellows = [];
  scope.forEach((t) => {
    const name = String(t.TaskName || '').replace(/^\\/, '');
    const status = String(t.Status || '');
    const lastRunRaw = t['Last Run Time'] || '';
    const lastResRaw = t['Last Result'] || '';
    const lastRun = parseLocal(lastRunRaw);
    const lastRes = Number(lastResRaw);
    const ph = periodHours(t);
    const ageH = lastRun ? (now - lastRun) / H : null;

    const issues = [];
    if (/disabled/i.test(status) || /已禁用/.test(status)) issues.push({ code: 'R1', level: 'red', msg: '任务被停用' });
    if (Number.isFinite(lastRes) && lastRes !== 0) {
      if (lastRes === 267011 || lastRes === 0x41303) issues.push({ code: 'Y-notrun', level: 'yellow', msg: '还没跑过（267011/0x41303）' });
      else if (lastRes === 267009 || lastRes === 0x41301) issues.push({ code: 'Y-running', level: 'yellow', msg: '正在运行（267009）' });
      else issues.push({ code: 'R2', level: 'red', msg: 'Last Result=' + lastRes + '（0x' + (lastRes >>> 0).toString(16) + '）' });
    }
    if (ph && ageH !== null && ageH > ph * 2) {
      issues.push({ code: 'R3', level: 'red', msg: '已 ' + ageH.toFixed(1) + 'h 未跑（周期 ' + ph + 'h）' });
    } else if (!ph && ageH !== null && ageH > 26) {
      issues.push({ code: 'R3?', level: 'yellow', msg: '已 ' + ageH.toFixed(1) + 'h 未跑（周期未知，按 26h 提示）' });
    }

    const row = {
      ts: new Date().toISOString(), check: 'task', task: name, status,
      last_run: lastRunRaw, last_result: lastResRaw, age_hours: ageH === null ? null : Number(ageH.toFixed(2)),
      period_hours: ph, verdict: issues.some((i) => i.level === 'red') ? 'red' : issues.length ? 'yellow' : 'green',
      issues,
    };
    rows.push(row);
    if (row.verdict === 'red') reds.push(row);
    else if (row.verdict === 'yellow') yellows.push(row);
  });

  // ── R4 账户可用余额（2026-11-09 加；触发原因：余额=0 连续两天无人告警）──────────
  // 数据源优先级：--balance=<数字> > --balance-file=<json> > data/balance-latest.json
  // 该文件形状：{ "source":"goofish|jg", "balance": <number>, "ts": "ISO8601" }
  // 读不到 → 🟡 "未知"，不报绿（不许把"没数据"当成"余额正常"）。
  let balRow = null;
  try {
    const balArg = val('balance');
    const balFile = val('balance-file') || path.join(ROOT, 'data', 'balance-latest.json');
    let bal = null, balSrc = null, balTs = null;
    if (balArg !== null) { bal = Number(String(balArg).replace(/[^0-9.\-]/g, '')); balSrc = 'cli'; }
    else if (fs.existsSync(balFile)) {
      const bj = JSON.parse(fs.readFileSync(balFile, 'utf8'));
      bal = Number(String(bj.balance).replace(/[^0-9.\-]/g, ''));
      balSrc = bj.source || 'file'; balTs = bj.ts || null;
    }
    const RED_AT = 0, YEL_AT = Number(val('balance-warn') || 50);
    let verdict = 'yellow', msg = '未知：没有余额数据源（data/balance-latest.json 不存在）';
    if (Number.isFinite(bal)) {
      if (bal <= RED_AT) { verdict = 'red'; msg = '账户可用余额 ' + bal + ' 元（≤0，平台已停投放）'; }
      else if (bal < YEL_AT) { verdict = 'yellow'; msg = '账户可用余额 ' + bal + ' 元（< ' + YEL_AT + '，即将中断）'; }
      else { verdict = 'green'; msg = '账户可用余额 ' + bal + ' 元'; }
    }
    // 【2026-11-09】--emit-balance：把本次读到的余额落盘，给 R4 当数据源。
    // 形状 {source, balance, ts}；只有拿到真实数字时才写（不写 null）。
    if (has('--emit-balance') && Number.isFinite(bal)) {
      const outBal = path.join(ROOT, 'data', 'balance-latest.json');
      fs.mkdirSync(path.dirname(outBal), { recursive: true });
      fs.writeFileSync(outBal, JSON.stringify({
        source: val('balance-source') || balSrc || 'unknown',
        balance: bal,
        ts: val('balance-ts') || new Date().toISOString(),
        written_at: new Date().toISOString(),
        written_by: 'tools/sched-health.js --emit-balance',
      }, null, 1), 'utf8');
      if (!JSONONLY) console.log('📝 已落余额数据源: data/balance-latest.json（' + bal + ' 元）');
    }
    // 【2026-11-10】余额数据"过期"也要报：文件可能是几小时前写的，不能当实时绿。
    let staleH = null;
    if (balTs) { const t = Date.parse(balTs); if (Number.isFinite(t)) staleH = (Date.now() - t) / 3600000; }
    const staleMax = Number(val('balance-max-age-h') || 1.5);   // 余额变化快（实测 1.84 元/分），默认 1.5 小时即算过期
    if (staleH !== null && staleH > staleMax && verdict === 'green') { verdict = 'yellow'; msg += '（数据已 ' + staleH.toFixed(1) + ' 小时未更新，按过期处理）'; }
    else if (staleH !== null && staleH > staleMax) { msg += '（数据已 ' + staleH.toFixed(1) + ' 小时未更新）'; }
    balRow = { ts: new Date().toISOString(), check: 'balance', stale_hours: staleH === null ? null : Number(staleH.toFixed(2)), source: balSrc, balance: Number.isFinite(bal) ? bal : null, balance_ts: balTs, verdict, issues: [{ code: 'R4', level: verdict === 'red' ? 'red' : (verdict === 'yellow' ? 'yellow' : 'info'), msg }] };
    fs.appendFileSync(OUT, JSON.stringify(balRow) + '\n', 'utf8');
    if (!JSONONLY) {
      const icon = verdict === 'red' ? '🔴' : verdict === 'yellow' ? '🟡' : '🟢';
      console.log('\n' + icon + ' R4 余额（来源: ' + (balSrc || '无') + '）: ' + msg);
      if (verdict === 'red') {
        // 四行文案（固定的，给企微/桌面用）：余额 / 今日花费 / 擦亮中 / 已暂停
        const tf = val('today-spend') || '?', on = val('active-plans') || '?', ps = val('paused-plans') || '?';
        console.log('   告警四行：');
        console.log('     账户可用余额: ' + bal + ' 元');
        console.log('     今日花费: ' + tf + ' 元');
        console.log('     擦亮中计划: ' + on);
        console.log('     已暂停擦亮计划: ' + ps);
        console.log('   （上面 4 个数可用 --today-spend/--active-plans/--paused-plans 传入，缺则显示 ?）');
      }
    }
  } catch (e) {
    fs.appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), check: 'balance', verdict: 'error', error: String(e.message || e) }) + '\n', 'utf8');
    if (!JSONONLY) console.log('\n⚠ R4 余额检查自身出错（已落盘）: ' + e.message);
  }

  // 落盘（一行一条）
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  rows.forEach((r) => fs.appendFileSync(OUT, JSON.stringify(r) + '\n', 'utf8'));

  if (JSONONLY) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), total: rows.length, red: reds.length, yellow: yellows.length }));
  } else {
    console.log('── 调度体检 ' + new Date().toLocaleString('zh-CN') + ' ──────────');
    console.log('扫描任务:', rows.length, ' | 🔴', reds.length, '| 🟡', yellows.length, '| 🟢', rows.length - reds.length - yellows.length);
    if (reds.length) {
      console.log('\n🔴 红（必须处理）:');
      reds.forEach((r) => console.log('  ' + r.task.padEnd(28) + ' ' + r.issues.filter((i) => i.level === 'red').map((i) => i.code + ' ' + i.msg).join(' / ')));
    }
    if (yellows.length) {
      console.log('\n🟡 黄（看一眼）:');
      yellows.forEach((r) => console.log('  ' + r.task.padEnd(28) + ' ' + r.issues.map((i) => i.msg).join(' / ')));
    }
    if (!reds.length && !yellows.length) console.log('\n✅ 全部正常');
    console.log('\n已追加: ' + path.relative(ROOT, OUT).replace(/\\/g, '/'));
  }
  const balRed = !!(typeof balRow !== 'undefined' && balRow && balRow.verdict === 'red');

  // 【2026-11-10】巡检出红就发飞书（企微 850003 已失效）；--no-alert 可关。
  if ((reds.length || balRed) && !has('--no-alert')) {
    try {
      const lines = [];
      lines.push('【巡检】' + new Date().toLocaleString('zh-CN'));
      lines.push('任务红 ' + reds.length + ' 条 / 黄 ' + yellows.length + ' 条');
      reds.slice(0, 6).forEach((r) => lines.push('· ' + r.task + ' → ' + r.issues.filter(i => i.level === 'red').map(i => i.code).join(',')));
      if (balRow) lines.push('· 余额: ' + (balRow.balance == null ? '未知' : balRow.balance + ' 元') + ' (' + balRow.verdict + ')');
      const text = lines.join('\n');
      require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'feishu-alert.js'), '--text', text], { timeout: 45000, stdio: 'pipe' });
      if (!JSONONLY) console.log('📣 已发飞书巡检告警');
    } catch (e) { console.log('⚠ 飞书告警未送达（已落桌面兜底由 feishu-alert 处理）'); }
  }
  process.exit((reds.length || balRed) ? 1 : 0);
}

main();
