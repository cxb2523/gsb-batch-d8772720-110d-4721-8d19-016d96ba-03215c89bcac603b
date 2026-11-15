# lib/ps/Writes.ps1 — 供 .ps1 脚本 dot-source 的共用写入函数
#
# 为什么存在：
#   PowerShell 5.1 的 `Out-File -Encoding UTF8` 和 `Set-Content -Encoding UTF8`
#   写出来的是 **UTF-8 带 BOM**。本仓库 171 个 .json 的 BOM 就是这么来的。
#   带 BOM 的 JSON 会让 Node 侧 `JSON.parse(fs.readFileSync(f,'utf8'))` 直接抛
#   「Unexpected token」，读状态的地方如果包了 try/catch 就会**静默丢状态**。
#
#   所以规矩是：UTF-8 是万国码，但 BOM 只在 .ps1/.bat 上需要（PS 5.1 靠它认编码），
#   .json/.js/.md 一律不带。
#
# 用法（在脚本顶部）：
#   . (Join-Path $PSScriptRoot 'lib\ps\Writes.ps1')
#   Write-Utf8NoBom -Path $stateFile -Text ($state | ConvertTo-Json -Depth 4)
#
# 审计入口：node tools/utf8-check.js [--fix]

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    # UTF8Encoding($false) = 不写 BOM
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}
