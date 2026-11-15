/**
 * tools/req-gate.js —— 请求预算闸门的查看/复位入口
 *
 * 为什么需要它：`lib/req-gate.js` 是"拦"的那一半，但出了事人得能一眼看清
 * 「现在被挡住了没、还有多久、这一小时是谁在烧预算」—— 否则又会退化成
 * 事故发生时的样子：不知道状态，只能靠反复试探，**而反复试探正是把限流压死的原因**。
 *
 * 用法:
 *   node tools/req-gate.js --status           # 现在能不能发（被挡了退出码 2）
 *   node tools/req-gate.js --status --json    # 给 .ps1 判断用
 *   node tools/req-gate.js --report           # 近 48 小时逐小时用量 + 最近调用方
 *   node tools/req-gate.js --reset --yes      # 清空状态（确认限流已解除/已重登后再用）
 */
const args = require('../lib/args');
const gate = require('../lib/req-gate');

const A = args.parse();

function fmtDur(sec) {
  if (sec <= 0) return '0 秒';
  const m = Math.floor(sec / 60), s = sec % 60;
  return (m ? m + ' 分 ' : '') + s + ' 秒';
}

function bar(n, max, width) {
  const w = Math.max(0, Math.min(width, Math.round((n / Math.max(1, max)) * width)));
  return '█'.repeat(w) + '·'.repeat(width - w);
}

const snap = gate.snapshot();

if (A.on('status') || (!A.on('report') && !A.on('reset'))) {
  if (A.on('json')) {
    console.log(JSON.stringify({
      enabled: snap.enabled, bypass: snap.bypass, blocked: snap.blocked,
      blockedForSec: snap.blockedForSec, strikes: snap.strikes,
      used10Min: snap.used10Min, usedHour: snap.usedHour, total: snap.total,
      limits: snap.limits, stateFile: snap.stateFile,
    }));
    process.exit(snap.blocked ? 2 : 0);
  }
  console.log('闸门      : ' + (snap.enabled ? (snap.bypass ? '开着（本次进程 BYPASS，只记不拦）' : '开着') : '关着（XY_NO_GATE=1）'));
  console.log('状态文件  : ' + snap.stateFile);
  console.log('');
  if (snap.blocked) {
    console.log('🔴 正在退避：还有 ' + fmtDur(snap.blockedForSec) + '（第 ' + snap.strikes + ' 次命中）');
    console.log('   原因：' + snap.blockedReason);
    console.log('   ⚠️ **不要重试** —— 重试只会把限流压得更死。');
    console.log('   等够了再发；确实要临时放行就 XY_GATE_BYPASS=1。');
  } else {
    console.log('✅ 没在退避，可以发。');
    if (snap.strikes > 0) {
      console.log('   （strikes=' + snap.strikes + '：下次再命中限流会停更久，成功一次即复位）');
    }
  }
  console.log('');
  const L = snap.limits;
  console.log('10 分钟用量 : ' + snap.used10Min + ' / ' + L.per10Min + '  ' + bar(snap.used10Min, L.per10Min, 24));
  console.log('60 分钟用量 : ' + snap.usedHour + ' / ' + L.perHour + '  ' + bar(snap.usedHour, L.perHour, 24));
  console.log('最小间隔    : ' + L.minGapMs + 'ms（连续调用之间自动等）');
  console.log('退避阶梯    : ' + (L.backoffMinutes || []).join(' / ') + ' 分钟（每命中一次进一档，成功即复位）');
  console.log('累计调用    : ' + snap.total);
  console.log('');
  console.log('（只统计 /api/agent/eval* —— 真正消耗闲鱼请求配额的那类；');
  console.log('  status / start-one / 截图 不过闸门。）');
  process.exit(snap.blocked ? 2 : 0);
}

if (A.on('report')) {
  const keys = Object.keys(snap.hist).sort();
  console.log('闸门用量报告（近 ' + gate.config.keepHistHours + ' 小时，逐小时）');
  console.log('文件: ' + snap.stateFile + '   累计: ' + snap.total + ' 次');
  console.log('');
  if (!keys.length) {
    console.log('（还没有任何记录 —— 装上之后才有数据）');
  } else {
    const max = Math.max.apply(null, keys.map((k) => snap.hist[k]));
    let sum = 0, peak = 0;
    keys.forEach((k) => {
      const n = snap.hist[k];
      sum += n;
      if (n > peak) peak = n;
      console.log('  ' + k.replace('T', ' ') + ' 时  ' + String(n).padStart(4) + ' 次  ' + bar(n, max, 30));
    });
    console.log('');
    console.log('  合计 ' + sum + ' 次；单小时峰值 ' + peak + ' 次');
    console.log('  上限  10 分钟 ' + snap.limits.per10Min + ' / 60 分钟 ' + snap.limits.perHour);
    if (peak > snap.limits.perHour * 0.5) {
      console.log('  ⚠️ 峰值已接近 60 分钟上限的一半 —— 要么收敛调用，要么按真实数据上调上限。');
    }
  }
  console.log('');
  console.log('最近调用方（最多 20 条，从旧到新）:');
  (snap.lastCallers || []).forEach((c) => {
    console.log('  ' + new Date(c.at).toLocaleString('zh-CN', { hour12: false }) + '  ' + c.label);
  });
  process.exit(0);
}

if (A.on('reset')) {
  if (!A.on('yes')) {
    console.log('这会清空闸门的计数与退避状态（不碰业务数据）。确认无误请重跑并加 --yes：');
    console.log('  node tools/req-gate.js --reset --yes');
    process.exit(2);
  }
  const before = snap;
  gate.reset();
  console.log('✅ 已清空闸门状态。');
  if (before.blocked) console.log('   （清掉的是还剩 ' + fmtDur(before.blockedForSec) + ' 的退避）');
  console.log('   ⚠️ 只在确认限流真的解除了才这么做；否则马上又会命中，且 strikes 从 1 重新开始。');
  process.exit(0);
}

console.log('用法:');
console.log('  node tools/req-gate.js --status [--json]   现在能不能发（被挡了退出码 2）');
console.log('  node tools/req-gate.js --report            近 48 小时用量 + 最近调用方');
console.log('  node tools/req-gate.js --reset --yes       清空状态');
process.exit(2);
