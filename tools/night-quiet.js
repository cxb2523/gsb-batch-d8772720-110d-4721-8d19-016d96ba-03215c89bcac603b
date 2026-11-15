/**
 * tools/night-quiet.js —— 夜间静默区间的唯一实现（配置在 lib/config.json 的 quietHours）
 *
 * 老板 2026-10-12：「11点到8点这段时间，停止活动」。
 * 后来又改成「改个时间区间」→ 所以区间做成可配的，改 config.json 的 from/to 即可，
 * 不用动计划任务、不用改这个文件。
 *
 * 它做什么：
 *   区间内  → 落两个开关（带 NIGHT-QUIET-SET 标记）
 *              · PAUSE-ADS     挡住熔断 / 卡住恢复 / 余额播报 / 日报 / 企微指令轮询 / 08:00 开投
 *              · PAUSE-PUBLISH 挡住 30 分钟一轮的自动发布
 *   区间外  → 把【自己落的】两个开关摘掉
 *
 * ⚠️ 为什么必须带标记（这是本文件最重要的约束）：
 *   PAUSE-ADS / PAUSE-PUBLISH 同时是**手动放假开关**（桌面上的「暂停发布.cmd」、
 *   tools/ad-pause-all.js）。如果这个脚本无脑 del，老板放的假会被每天夜里静默解除。
 *   所以：
 *     · 落开关时写第一行 NIGHT-QUIET-SET；
 *     · 摘开关前先看第一行是不是这个标记，不是就**绝不碰**（并打日志说明）。
 *
 * 用法:
 *   node tools/night-quiet.js              # 按当前时间与配置执行（计划任务用的就是这个）
 *   node tools/night-quiet.js --dry        # 只说明会做什么，不落/不摘
 *   node tools/night-quiet.js --at=23:30   # 假装现在是 23:30（用来验两个分支，不动真时间）
 *   node tools/night-quiet.js --status     # 看当前区间、当前判断、两个开关的真实内容
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');

const MARK = 'NIGHT-QUIET-SET';
const FLAGS = [path.join(ROOT, 'PAUSE-ADS'), path.join(ROOT, 'PAUSE-PUBLISH')];

const argOf = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : ''; };
const DRY = process.argv.includes('--dry');
const STATUS = process.argv.includes('--status');

// 读配置（唯一配置出口是 lib/config.json；不在这里另写默认值以外的东西）
function loadCfg() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
  const q = raw.quietHours || {};
  return {
    enabled: q.enabled !== false,
    from: /^\d{1,2}:\d{2}$/.test(String(q.from)) ? String(q.from) : '23:00',
    to: /^\d{1,2}:\d{2}$/.test(String(q.to)) ? String(q.to) : '08:00',
  };
}

const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** 左闭右开 [from, to)，支持跨午夜 */
function inQuiet(nowMin, cfg) {
  const f = mins(cfg.from), t = mins(cfg.to);
  if (f === t) return false;                 // 零长度区间 = 不静默
  return f < t ? (nowMin >= f && nowMin < t) : (nowMin >= f || nowMin < t);
}

function nowMin() {
  const at = argOf('at');
  if (/^\d{1,2}:\d{2}$/.test(at)) return mins(at);
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

const firstLine = (f) => {
  try { return String(fs.readFileSync(f, 'utf8')).split(/\r?\n/)[0].trim(); } catch (e) { return null; }
};

const log = (s) => console.log('[' + new Date().toLocaleString('zh-CN') + '] ' + s);

const cfg = loadCfg();
const nm = nowMin();
const quiet = cfg.enabled && inQuiet(nm, cfg);
const hhmm = String(Math.floor(nm / 60)).padStart(2, '0') + ':' + String(nm % 60).padStart(2, '0');

if (STATUS) {
  log('配置区间: ' + (cfg.enabled ? cfg.from + ' - ' + cfg.to + '（左闭右开）' : '已关闭（enabled=false）'));
  log('当前判断: ' + hhmm + ' → ' + (quiet ? '【区间内】应静默' : '【区间外】应解除'));
  FLAGS.forEach((f) => {
    const ex = fs.existsSync(f);
    log('  ' + path.basename(f) + ': ' + (ex ? '存在，首行=' + JSON.stringify(firstLine(f)) + (firstLine(f) === MARK ? ' ← 本脚本落的，归我管' : ' ← 手动放的，不碰') : '不存在'));
  });
  process.exit(0);
}

log('区间 ' + cfg.from + '-' + cfg.to + '，现在 ' + hhmm + ' → ' + (quiet ? '进入静默' : '解除静默') + (DRY ? '（--dry 不落不改）' : ''));

let changed = 0;
for (const f of FLAGS) {
  const base = path.basename(f);
  const exists = fs.existsSync(f);
  const mine = exists && firstLine(f) === MARK;

  if (quiet) {
    if (exists && !mine) { log('  ' + base + '：已存在且是手动开关（首行不是标记）→ 不动它'); continue; }
    if (exists && mine) { log('  ' + base + '：已是本脚本落的，幂等跳过'); continue; }
    if (!DRY) fs.writeFileSync(f, MARK + '\r\n', 'utf8');
    log('  ' + base + '：落标记开关 ✅');
    changed++;
  } else {
    if (!exists) { continue; }
    if (!mine) { log('  ' + base + '：存在但是手动开关（首行不是标记）→ 不动它'); continue; }
    if (!DRY) fs.unlinkSync(f);
    log('  ' + base + '：摘掉标记开关 ✅');
    changed++;
  }
}
log('完成，改动 ' + changed + ' 项');
