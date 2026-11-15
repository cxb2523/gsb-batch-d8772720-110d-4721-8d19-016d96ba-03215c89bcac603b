# lib/ps/Idle.ps1 — 供 .ps1 脚本 dot-source 的空闲检测
#
# 与 lib/idle.js 是同一套逻辑（Windows GetLastInputInfo），给 PowerShell 入口用。
#
# 规矩：你在用电脑（空闲 < 阈值）→ 跳过，不碰浏览器；你离开 → 照常跑。
#   ⚠️ 发布链（wake-publish-sleep.ps1）刻意不设此门槛（老板要求「守在电脑前也要发」）。
#
# 用法（脚本顶部）：
#   . (Join-Path $PSScriptRoot 'lib\ps\Idle.ps1')
#   if (Test-UserBusy) { Write-Log '用户活跃中，跳过'; exit }
#
# 检测失败时 Test-UserBusy 返回 $false（fail-open）：宁可弹一次窗，也不让烧钱熔断失效。

function Get-IdleSeconds {
    try {
        Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class XYIdlePs{ [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO ii); [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO{ public uint cbSize; public uint dwTime; } }' -ErrorAction Stop
    } catch { }
    try {
        $i = New-Object XYIdlePs+LASTINPUTINFO
        $i.cbSize = 8
        [XYIdlePs]::GetLastInputInfo([ref]$i) | Out-Null
        # ⚠️ dwTime 与 TickCount 都是【毫秒】。第一版忘了 /1000，等于把 300 秒阈值
        #    变成 300 毫秒，闸门几乎永远放行（ad-watch-stuck.ps1 因此漏过）。
        #    这里用 double 运算避免 int32 溢出，负数（~49.7 天回绕）时补 2^32。
        $ms = [double]([uint32][Environment]::TickCount) - [double]([uint32]$i.dwTime)
        if ($ms -lt 0) { $ms = $ms + 4294967296 }
        return [int]($ms / 1000)
    } catch { return -1 }
}

function Test-UserBusy {
    param([int]$ThresholdSec = 300)
    $idle = Get-IdleSeconds
    if ($idle -ge 0 -and $idle -lt $ThresholdSec) { return $true }
    return $false
}
