/**
 * lib/idle.js — 用户空闲检测（Windows GetLastInputInfo）
 *
 * 为什么存在（2026-10-01 老板反馈「后台一直弹窗」）：
 *   闲鱼广告接口只在 dayu 域可用，所以几乎所有巡检类任务一开始都要
 *   `location.href = dayu...` 把那个【可见的】Chrome 窗口导航过去 —— 每跑一次就弹一次。
 *   实测 6 个计划任务里【只有熔断】加了空闲门槛，另外 5 个都在弹：
 *     XianyuSheetCommand  每 15 分钟   ← 最烦
 *     XianyuWatchStuck    每 30 分钟
 *     XianyuAdBalanceDuty 每 3 小时
 *     XianyuAdDailyReport 每天 21:30
 *     XianyuAdRetryOrder  每天 09:00
 *   现在把门槛抽成公共件，各入口一行接入。
 *
 * 规矩：你在用电脑（空闲 < 阈值）→ 跳过，不碰浏览器；你离开 → 照常跑，功能一点不少。
 *   ⚠️ 发布链（wake-publish-sleep.ps1）**刻意不设**这个门槛
 *      —— 老板要求「守在电脑前也要发」。两处不一致是【故意的】，别当成 bug 修掉。
 *
 * 检测失败时按「不忙」处理（fail-open）：宁可弹一次窗，也不让烧钱熔断/卡住恢复失效。
 */
const { execFileSync } = require('child_process');

const DEFAULT_THRESHOLD = 300;   // 5 分钟

/**
 * 已空闲多少【秒】；-1 = 检测失败
 *
 * ⚠️ 2026-10-01 踩坑：GetLastInputInfo 的 dwTime 与 TickCount 都是【毫秒】。
 *    第一版直接返回差值，等于把毫秒当秒，300 秒阈值实际只剩 300 毫秒 ——
 *    闸门几乎永远放行，ad-watch-stuck.ps1 就这么漏过去了（PS 版同一个 bug）。
 *    现在统一换算成秒；TickCount 是 int32 会 ~49.7 天回绕，负数时补 2^32。
 */
function idleSeconds() {
  try {
    const ps = "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;"
      + "public class XYIdleCli{ [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LI i);"
      + " [StructLayout(LayoutKind.Sequential)] public struct LI{ public uint cbSize; public uint dwTime; } }' -EA Stop;"
      + "$i=New-Object XYIdleCli+LI; $i.cbSize=8; [XYIdleCli]::GetLastInputInfo([ref]$i)|Out-Null;"
      + "$ms=[double]([uint32][Environment]::TickCount)-[double][uint32]$i.dwTime;"
      + "if($ms -lt 0){$ms=$ms+4294967296};[int]($ms/1000)";
    const r = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    const n = parseInt(String(r).trim(), 10);
    return isFinite(n) && n >= 0 ? n : -1;
  } catch (e) { return -1; }
}

/** 用户是否在忙（空闲 < 阈值）。检测失败返回 false（不跳过） */
function isBusy(thresholdSec) {
  const th = Number(thresholdSec) > 0 ? Number(thresholdSec) : DEFAULT_THRESHOLD;
  const idle = idleSeconds();
  if (idle < 0) return false;          // fail-open
  return idle < th;
}

/**
 * 忙就打印一行并返回 true —— 调用方接 `if (idle.skipIfBusy('xxx')) process.exit(0);`
 * opts: { threshold, force }（force=true 跳过检测，用于 --dry / --selftest / 手动强制跑）
 */
function skipIfBusy(label, opts) {
  opts = opts || {};
  if (opts.force) return false;
  const th = Number(opts.threshold) > 0 ? Number(opts.threshold) : DEFAULT_THRESHOLD;
  const idle = idleSeconds();
  if (idle >= 0 && idle < th) {
    console.log(new Date().toLocaleString('zh-CN', { hour12: false })
      + '  [跳过] ' + (label || '本任务') + '：用户活跃中（空闲 ' + idle + ' 秒 < ' + th + '），不碰浏览器以免弹窗');
    return true;
  }
  return false;
}

module.exports = { idleSeconds, isBusy, skipIfBusy, DEFAULT_THRESHOLD };
