# tools/verify-config.ps1 —— 配置外置任务的统一验收器
#
# 为什么存在：批次 1 我是手敲命令验收的，批次 2 有 68 个文件，批次 3 可能更多。
# 手敲容易漏项（我第一次就漏了「写死店铺名」这个模式，导致基线只覆盖了 33/68 个文件）。
# 这个脚本把技能里那四层验收固化下来，批批复用。
#
# 四层：
#   ① 哈希   —— 与 BASELINE.txt 比对，证明「真的改了」
#   ② 残留   —— 老写法是否清干净（这一层才是唯一能证伪的）
#   ③ 编码   —— .ps1 必须带 BOM（PS 5.1 靠它认编码，否则中文注释会吞掉下一行代码）
#   ④ 语法   —— PowerShell AST 解析
#
# 用法:
#   powershell -File tools\verify-config.ps1 -Baseline _archive\baseline-batch2-20261002_025656
#
# 退出码: 0 = 全过；1 = 有文件未通过

param(
    [Parameter(Mandatory = $true)][string]$Baseline,
    # 需要检查「未改动」的例外（例如附带备份的 config.local.json 本来就允许被改）
    [string[]]$AllowUnchanged = @()
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $Baseline)) { $Baseline = Join-Path $root $Baseline }
if (-not (Test-Path $Baseline)) { Write-Host "❌ 基线目录不存在: $Baseline"; exit 1 }

$baselineFile = Join-Path $Baseline 'BASELINE.txt'
if (-not (Test-Path $baselineFile)) { Write-Host "❌ 基线里没有 BASELINE.txt"; exit 1 }

# 老写法（残留检查用）。注意要覆盖全部路径模式 ——
# 少了哪个，对应的写死值就会「改了但没查出来」。
# 2026-10-02：第一版就漏了模式，导致基线只覆盖 33/68 个文件。
$RESIDUAL_PATH = '43462|D:\\DSH\\achun|D:/DSH/achun'

# 凭证类残留单独算一档：**不判失败**。
# 理由：批次 1 的任务书明确允许把原字面量保留成 param 的兜底默认值
# （删掉会改变「无配置时」的行为）。但它确实不该随分发版发出去，
# 所以列出来当「发布前待清」的提醒，而不是当成改错。
#
# 【2026-10-08 改】这些字面量已于今天全部清掉（ad-balance-duty / ad-watch-stuck /
# wecom-send 的 param 兜底值改为空 + 读不到就跳过发送并记日志）。
# 本行原来把两个真实密钥当模式写在这里 —— 一个"查残留密钥"的检查器自己带着密钥，
# 那就没法随分发版发出去。改成通用形态匹配，效果一样但不含真值。
$RESIDUAL_SECRET = 'sk-studio-|wotj[A-Za-z0-9_-]{18,}'

function Get-ResidualCount([string]$Path, [string]$Pattern) {
    try {
        return (Select-String -Path $Path -Pattern $Pattern -AllMatches -ErrorAction SilentlyContinue |
                Measure-Object).Count
    } catch { return 0 }
}

$rows = @()
$fail = 0
$secretCount = 0
foreach ($line in (Get-Content $baselineFile -Encoding UTF8)) {
    if ($line -notmatch '^([0-9A-Fa-f]{64})\s\s(.+)$') { continue }
    $oldHash = $Matches[1]
    $rel = ($Matches[2] -replace '\s*\[附带\]\s*$', '').Trim()
    $full = Join-Path $root $rel

    if (-not (Test-Path $full)) {
        $rows += [pscustomobject]@{ 文件 = $rel; 哈希 = '❌ 文件消失'; 残留 = '-'; BOM = '-'; 语法 = '-' }
        $fail++
        continue
    }

    $newHash = (Get-FileHash $full -Algorithm SHA256).Hash
    $changed = if ($newHash -ne $oldHash) { '已改' } else { '未改' }

    $res = Get-ResidualCount $full $RESIDUAL_PATH
    $sec = Get-ResidualCount $full $RESIDUAL_SECRET
    $bom = '-'; $syn = '-'
    if ($full -like '*.ps1') {
        $b = [IO.File]::ReadAllBytes($full)
        $bom = if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { '有' } else { '❌无' }
        $err = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$null, [ref]$err)
        $syn = if ($err.Count -eq 0) { 'OK' } else { '❌' }
    }

    # 判定：附带的配置文件允许不改；其余必须「已改 + 路径残留 0 + BOM 有 + 语法 OK」。
    # 凭证残留（$sec）只提醒、不判失败 —— 见文件顶部注释。
    $isAllowed = $false
    foreach ($a in $AllowUnchanged) { if ($rel -like $a) { $isAllowed = $true; break } }
    $ok = ($res -eq 0) -and ($bom -ne '❌无') -and ($syn -ne '❌') -and ($isAllowed -or $changed -eq '已改')
    if (-not $ok) { $fail++ }
    if ($sec -gt 0) { $secretCount++ }

    $rows += [pscustomobject]@{
        文件 = $rel
        哈希 = $(if ($changed -eq '已改') { '✅已改' } else { $(if ($isAllowed) { '允许未改' } else { '❌未改' }) })
        路径残留 = $(if ($res -eq 0) { '0' } else { "❌$res" })
        凭证残留 = $(if ($sec -eq 0) { '-' } else { "⚠️$sec" })
        BOM  = $bom
        语法 = $syn
    }
}

$rows | Format-Table -AutoSize

Write-Host ''
Write-Host ("基线: {0}" -f $Baseline)
Write-Host ("受检文件: {0}    未通过: {1}" -f $rows.Count, $fail)
if ($secretCount -gt 0) {
    Write-Host ("⚠️ 有 {0} 个文件仍含凭证字面量（批次 1 刻意保留的兜底默认值）—— 不判失败，但分发前要清" -f $secretCount) -ForegroundColor Yellow
}
if ($fail -eq 0) { Write-Host '✅ 四层验收全过' -ForegroundColor Green; exit 0 }
Write-Host '❌ 有文件未通过，见上表' -ForegroundColor Red
exit 1
