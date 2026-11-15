/**
 * tools/install-tasks.js — 把【数据监控】那套计划任务注册到本机（幂等）
 *
 * 为什么必须有它：
 *   「数据监控」模块靠 8 个 Windows 计划任务在跑，但仓里【只有删任务的脚本】
 *   （ad-cleanup-tasks.cmd），没有注册任务的脚本 —— 这一套一直是老板这台机器上手工建的，
 *   学员机器上根本装不出来。老板要「把功能安装到学员本地 agent」，这就是缺的那一环。
 *
 * 为什么用 schtasks 命令行而不是 PowerShell 的 Register-ScheduledTask：
 *   ① 不依赖执行策略（学员机上 ExecutionPolicy 常常是 Restricted）
 *   ② 老板这台机器的任务本来就是 schtasks 建的，参数能 1:1 照抄（见下表）
 *   ③ 失败信息直白，学员看得懂
 *
 * 为什么路径要自己算，不能抄老板机器的：
 *   老板机器上是 D:\DSH\achun 和 C:\Users\43462\.kun\...，学员机器不一样。
 *   所以这里一律用 <本文件所在仓库根> 和 lib/env.js 解析出来的 playwright-service 路径。
 *   任务里跑的是 run-node.cmd（本身就是版本无关的 node 启动器），所以不写死 node 路径。
 *
 * 用法:
 *   node tools/install-tasks.js                 # 预演（默认）：只打印会注册什么
 *   node tools/install-tasks.js --apply         # 真注册
 *   node tools/install-tasks.js --remove        # 全部卸掉（换机器/排查用）
 *   node tools/install-tasks.js --only=XianyuAdCostBreaker
 *   node tools/install-tasks.js --check         # 只看现在注册了哪些
 *
 * 退出码: 0 成功 / 1 有任务建失败 / 2 环境问题
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARGV = process.argv.slice(2);
const APPLY = ARGV.indexOf('--apply') >= 0;
const REMOVE = ARGV.indexOf('--remove') >= 0;
const CHECK = ARGV.indexOf('--check') >= 0;
const ONLY = (ARGV.find((x) => x.startsWith('--only=')) || '').slice(7);

const ROOT = path.resolve(__dirname, '..');
let SVC_DIR = '';
try { SVC_DIR = require('../lib/env').PATHS.playwrightService || ''; } catch (e) {}

/** 引号包一层（schtasks 的 /tr 是一整个字符串，路径带空格时必须包） */
const q = (s) => '"' + String(s) + '"';
const NN = path.join(ROOT, 'run-node.cmd');
const PS = 'powershell.exe';

/**
 * 任务表 —— 每一行都对应老板机器上实际在跑的一个任务（2026-10-08 用 schtasks /query /xml 抄下来的），
 * 只把绝对路径换成 <ROOT> 的推导值。时间点/间隔与线上一致。
 *
 *   kind: 'daily'   → 每天 at 里列出的每个时间点各一个触发器
 *         'minute'  → 每 mo 分钟
 *         'hourly'  → 每 mo 小时
 */
const TASKS = [
  { name: 'XianyuAdWindow8AM', kind: 'daily', at: ['08:00'],
    cmd: path.join(ROOT, 'ad-window-8am.cmd'), args: '',
    why: '早上 8 点开窗（全店计划批量恢复投放）' },

  { name: 'XianyuAdWindow11PM', kind: 'daily', at: ['23:00'],
    cmd: path.join(ROOT, 'ad-window-11pm.cmd'), args: '',
    why: '晚上 23 点关窗' },

  { name: 'XianyuAdWindowGuard', kind: 'daily', at: ['08:40', '23:40'],
    cmd: path.join(ROOT, 'ad-window-guard.cmd'), args: '',
    why: '开窗/关窗后 40 分钟【校验】到底成没成（曾经开窗返回 0xFF 而整夜没关）' },

  { name: 'XianyuAdCostBreaker', kind: 'minute', mo: 30,
    cmd: NN, args: q(path.join(ROOT, 'ad-cost-breaker.js')),
    why: '熔断：超阈值自动暂停计划 + 告警' },

  { name: 'XianyuAdDailyReport', kind: 'daily', at: ['21:30'],
    cmd: NN, args: q(path.join(ROOT, 'ad-daily-report.js')),
    why: '广告日报写进企微表格' },

  { name: 'XianyuAdBalanceDuty', kind: 'hourly', mo: 3,
    cmd: PS, args: '-NoProfile -ExecutionPolicy Bypass -File ' + q(path.join(ROOT, 'ad-balance-duty.ps1')),
    why: '余额巡检，快没了告警' },

  { name: 'XianyuAdRetryOrder', kind: 'daily', at: ['09:00'],
    cmd: PS, args: '-NoProfile -ExecutionPolicy Bypass -File ' + q(path.join(ROOT, 'ad-retry-order.ps1')),
    why: '重试没接到的订单' },

  { name: 'XianyuWatchStuck', kind: 'minute', mo: 30,
    cmd: PS, args: '-NoProfile -ExecutionPolicy Bypass -File ' + q(path.join(ROOT, 'ad-watch-stuck.ps1')),
    why: '看任务有没有卡死' },

  { name: 'XianyuSheetCommand', kind: 'minute', mo: 15,
    cmd: NN, args: q(path.join(ROOT, 'sheet-command-runner.js')),
    why: '轮询企微表格里的指令（老板用表格下命令的入口）' },

  { name: 'XianyuWakePublish', kind: 'minute', mo: 30,
    cmd: SVC_DIR ? path.join(SVC_DIR, 'wake-publish-sleep.bat') : '',
    args: '',
    why: '唤醒发布队列（它自己会看 PAUSE-PUBLISH 决定跑不跑）' },
];

const sh = (args, opts) => execFileSync('schtasks', args, Object.assign({ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, opts || {})).trim();
const shOk = (args) => { try { return { ok: true, out: sh(args) }; } catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message).trim() }; } };

function registered() {
  const r = shOk(['/query', '/fo', 'csv', '/nh']);
  if (!r.ok) return null;
  const set = {};
  r.out.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^"([^"]+)"/);
    if (m) set[m[1].replace(/^\\/, '')] = true;
  });
  return set;
}

/** 一个任务的所有触发器时间点（daily 可能有多个） */
function triggersOf(t) {
  if (t.kind === 'daily') return t.at.slice();
  if (t.kind === 'minute') return ['00:00'];
  return ['00:00'];
}

function createArgs(t, at, first) {
  const a = ['/create', '/tn', t.name, '/tr', '"' + t.cmd + (t.args ? ' ' + t.args : '') + '"', '/f'];
  a.push('/rl', 'LIMITED');
  if (t.kind === 'daily') {
    a.push('/sc', 'daily', '/st', at);
    // schtasks 一次只能建一个触发器；第二个时间点要用 /ri 不行，所以用 XML 之外的替代：
    // 见下面 createTask() 里的处理 —— 第二个时间点会建成 <名字>PM 后缀的兄弟任务。
    return a;
  }
  if (t.kind === 'minute') { a.push('/sc', 'minute', '/mo', String(t.mo)); return a; }
  a.push('/sc', 'hourly', '/mo', String(t.mo));
  return a;
}

(async () => {
  console.log('仓库根   : ' + ROOT);
  console.log('node 入口: ' + NN + (fs.existsSync(NN) ? '' : '   ⚠️ 不存在！'));
  console.log('服务目录 : ' + (SVC_DIR || '(未解析到)'));
  console.log('模式     : ' + (CHECK ? '只看现状' : REMOVE ? '卸载' : APPLY ? '真注册' : '预演'));
  console.log('');

  const reg = registered();
  if (reg === null) { console.log('❌ 查不了计划任务（schtasks 不可用？）'); process.exit(2); }

  // ── --check ──
  if (CHECK) {
    // ⚠️ 判「在不在」不能只看任务名，要看【触发器个数】。
    //   老板这台机器上 Guard 是一个任务里两个触发器（08:40+23:40）；
    //   而本脚本注册时是拆成 XianyuAdWindowGuard + …PM 两个任务。
    //   两种形态都对，第一版只认后者，于是把老板机器上报成「❌ 缺 1 个」——假警报。
    const triggerCount = (name) => {
      const r = shOk(['/query', '/tn', name, '/xml']);
      return r.ok ? (r.out.match(/<StartBoundary>/g) || []).length : 0;
    };
    console.log('任务名                    现状     触发器  说明');
    console.log('-'.repeat(104));
    let miss = 0;
    TASKS.forEach((t) => {
      const need = t.at ? t.at.length : 1;
      const total = triggerCount(t.name) + (reg[t.name + 'PM'] ? triggerCount(t.name + 'PM') : 0);
      const good = total >= need;
      if (!good) miss++;
      console.log('  ' + t.name.padEnd(24) + (good ? '✅ 在  ' : '❌ 缺  ').padEnd(9) +
        (total + '/' + need).padEnd(8) + t.why);
    });
    const extra = Object.keys(reg).filter((n) => /^Xianyu/.test(n) && !TASKS.some((t) => t.name === n || t.name + 'PM' === n));
    if (extra.length) console.log('\n  额外存在的闲鱼任务（不是这套里的）：' + extra.join(', '));
    console.log('');
    console.log(miss ? ('❌ 缺 ' + miss + ' 个 → node tools/install-tasks.js --apply') : '✅ 这套任务全在，触发器个数也对');
    process.exit(miss ? 1 : 0);
  }

  // ── 先检查要引用的文件是否存在（别建出一堆跑不起来的任务）──
  // ⚠️ 只对【绝对路径】做存在性检查。
  //   第一版对 powershell.exe 也做 fs.existsSync('powershell.exe') → 必然 false，
  //   于是 3 个用 powershell 的任务（余额/重试/卡死）被静默跳过，
  //   监控就只装了一半 —— 这种「少装了一半还不报错」最难发现。
  //   裸命令名（不含路径分隔符）走 PATH，用 where 确认能解析到就行。
  const missing = [];
  const whereOk = (c) => { try { execFileSync('where', [c], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
  // 【2026-11-14 第 165 轮修】原来只看 t.cmd，而【解释器型】任务的 cmd 是 node/powershell，
  //   真正要跑的脚本在 args 里 —— 于是 node 一存在就算"可解析"，
  //   注册出来的任务指向一个【包里根本没有的文件】，到点静默失败。
  //   实测：学员包里 ad-balance-duty.ps1 / ad-watch-stuck.ps1 / sheet-command-runner.js
  //   全都不在（打包规则排掉的），但它们照样会被注册。
  //   现在：命令本身 + args 里的脚本路径，两样都要存在。
  const resolvable = (t) => {
    const c = t.cmd;
    if (!c) return false;
    const cmdOk = /[\\/]/.test(c) ? fs.existsSync(c) : whereOk(c);
    if (!cmdOk) return false;
    const argFiles = String(t.args || '').match(/[A-Za-z]:[\\/][^"'\s]+\.(?:js|ps1|cmd|bat)/g) || [];
    for (const p of argFiles) {
      if (!fs.existsSync(p)) return false;
    }
    return true;
  };
  TASKS.forEach((t) => {
    if (!t.cmd) { missing.push(t.name + '（没解析到命令路径）'); return; }
    if (!resolvable(t)) missing.push(t.name + ' → ' + (t.args ? String(t.args).match(/[A-Za-z]:[\\/][^"'\s]+\.(?:js|ps1|cmd|bat)/) || [t.cmd] : [t.cmd])[0]);
  });
  if (missing.length) {
    // 【2026-11-14 第 165 轮改】原来这句是「先把仓库装全」—— 但学员包【本来就不带】
    //   这些文件（开窗/关窗/校验/余额/日报/表格命令是管理员那边的监控，
    //   打包规则第 109/118 轮排掉的），学员永远"装不全"，看到这句只会以为自己装坏了。
    //   改成说清：这是设计如此 + 本机实际能装上几个。
    const total = TASKS.length;
    const got = total - missing.length;
    console.log('⚠️ 下列任务的【脚本不在这个包里】，已跳过（这是正常的，不是你装错了）：');
    missing.forEach((m) => console.log('   · ' + m));
    console.log('');
    console.log('   原因：开窗/关窗/校验/余额巡检/日报/表格命令属于【管理员那边】的监控，');
    console.log('         发给学员的包里本来就不带（打包时排掉了）。');
    console.log('         你这边要装的只有能跑的那 ' + got + ' 个 —— 通常就是熔断（ad-cost-breaker）。');
    console.log('   要看现在装了哪些：node tools/install-tasks.js --check');
    console.log('');
  }
  const usable = TASKS.filter((t) => resolvable(t));

  // ── --remove ──
  if (REMOVE) {
    TASKS.forEach((t) => {
      const r = shOk(['/delete', '/tn', t.name, '/f']);
      console.log('  ' + (r.ok ? '🗑 ' : '· ') + t.name + (r.ok ? '' : '（本来就没有）'));
    });
    console.log('\n✅ 已卸载这套任务（其它非 Xianyu 前缀的任务没动）');
    process.exit(0);
  }

  // ── 预演 / 真注册 ──
  console.log('任务名                    周期              状态      说明');
  console.log('-'.repeat(112));
  let failed = 0;
  for (const t of usable) {
    const at = triggersOf(t);
    const cycle = t.kind === 'daily' ? ('每天 ' + t.at.join(' + '))
      : t.kind === 'minute' ? ('每 ' + t.mo + ' 分钟') : ('每 ' + t.mo + ' 小时');
    const already = !!reg[t.name];
    if (!APPLY) {
      console.log('  ' + t.name.padEnd(24) + cycle.padEnd(18) + (already ? '已存在→覆盖' : '新建').padEnd(9) + t.why);
      if (t.at && t.at.length > 1) console.log('  ' + ' '.repeat(24) + '（两个时间点会建成两个触发器：' + t.at.join(', ') + '）');
      continue;
    }
    // 多触发器的任务：第 1 个时间点用原名，后面的用「原名+PM/2」兄弟任务。
    // 为什么不用 XML：schtasks /create /xml 要求 UTF-16 文件，跨机器容易踩编码坑
    //（这个仓已经被 BOM/GBK 坑过好几次）。拆成两个同名系任务更笨但更稳，--check 也都认。
    let okAll = true;
    for (let i = 0; i < at.length; i++) {
      const name = i === 0 ? t.name : t.name + 'PM';
      const a = createArgs(t, at[i]);
      a[a.indexOf('/tn') + 1] = name;
      const r = shOk(a);
      if (!r.ok) { okAll = false; failed++; console.log('  ❌ ' + name + '  ' + r.out.slice(0, 150)); }
    }
    if (okAll) console.log('  ✅ ' + t.name.padEnd(24) + cycle.padEnd(18) + '已注册');
  }

  if (!APPLY) {
    console.log('');
    console.log('[预演] 没动任何东西。加 --apply 真注册。');
    console.log('提示：注册计划任务不需要管理员权限（都是当前用户、LIMITED 权限级）。');
    process.exit(0);
  }
  console.log('');
  console.log(failed ? ('❌ ' + failed + ' 个任务建失败（上面有 schtasks 的原文报错）')
    : '✅ 全部注册完成。验证：node tools/install-tasks.js --check');
  console.log('   手动注销整套：node tools/install-tasks.js --remove');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(2); });
