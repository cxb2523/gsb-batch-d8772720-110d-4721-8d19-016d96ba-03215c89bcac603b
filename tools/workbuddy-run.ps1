# tools/workbuddy-run.ps1 —— 派活给 WorkBuddy(CodeBuddy) CLI
#
# 为什么存在（2026-10-02 一夜之间踩了两次）：
#   CodeBuddy 自动升级会把 `versions\22.22.2-3` 整个改名成 `.22.22.2-3.deleting.*`，
#   连 `node_modules`（全局装的 codebuddy 包、esbuild）一起搬走。
#   凡是写死版本号的派活命令，第二天必然失败。
#   `versions\current` 是一个【装着版本号的普通文本文件】，这里靠它解析路径。
#
# 用法:
#   powershell -File tools\workbuddy-run.ps1 -Prompt "Read the file ... and follow it exactly."
#
# 退出码: 0 = CLI 正常结束；1 = 路径解析失败（CLI 不存在）

param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$LogName = 'workbuddy-run',
    # 默认落到本脚本所在仓库的根（tools\ 的上一级），不再写死某台机器的盘符。
    [string]$WorkDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# 不写死 node 版本目录：优先环境变量，其次用户目录下的 WorkBuddy 默认位置。
$versionsDir = if ($env:XY_NODE_VERSIONS) { $env:XY_NODE_VERSIONS }
               else { Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions' }

function Resolve-Ver {
    # ① 信 current 文件
    $cur = Join-Path $versionsDir 'current'
    if (Test-Path $cur) {
        try {
            $v = ([System.IO.File]::ReadAllText($cur)).Trim()
            if ($v -and (Test-Path (Join-Path $versionsDir "$v\node.exe"))) { return $v }
        } catch { }
    }
    # ② 兜底：最新的一个带 node.exe 的版本目录（跳过 .xxx.deleting.*）
    $hit = Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' -and $_.Name -ne 'locks' } |
        Sort-Object LastWriteTime -Descending |
        Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } |
        Select-Object -First 1
    if ($hit) { return $hit.Name }
    return $null
}

$ver = Resolve-Ver
if (-not $ver) { Write-Host '❌ 找不到可用的 node 版本目录'; exit 1 }

$node = Join-Path $versionsDir "$ver\node.exe"
$cli  = Join-Path $versionsDir "$ver\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy"

if (-not (Test-Path $node)) { Write-Host "❌ node 不存在: $node"; exit 1 }
if (-not (Test-Path $cli)) {
    Write-Host "❌ CLI 不存在: $cli"
    Write-Host '   可能是自动升级没把全局包搬过来。抢救办法：'
    Write-Host '   从 versions\.<旧版本>.deleting.*\node_modules 里把 @tencent-ai 和 esbuild 复制到新版本目录。'
    exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log = Join-Path $WorkDir "logs\$LogName-$stamp.log"
Set-Location $WorkDir

Write-Host "node 版本: $ver"
Write-Host "日志: $log"
Write-Host '派活中…'

& $node $cli -p $Prompt --permission-mode acceptEdits --output-format text *>&1 |
    Tee-Object -FilePath $log

Write-Host ''
Write-Host "=== CLI 退出码 = $LASTEXITCODE ==="
exit 0
