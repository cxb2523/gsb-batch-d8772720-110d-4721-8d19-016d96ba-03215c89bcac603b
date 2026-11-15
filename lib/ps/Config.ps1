# lib/ps/Config.ps1 — 供 .ps1 脚本 dot-source 的配置读取器
#
# 为什么存在：
#   .ps1 没法 require() lib/env.js，所以 PowerShell 侧需要自己的读取器。
#   取值优先级（三级，缺一不可）：
#     1) config.local.json  本机配置，每台机器一份（不进版本库）
#     2) lib/config.json    出厂配置（node.workbuddy / node.scoop / store.default ...）
#     3) $Default           调用方给的兜底值
#
# 用法（脚本顶部）：
#   . (Join-Path $PSScriptRoot 'lib\ps\Config.ps1')
#   $work = Get-XyPath 'paths.work'
#   $node = Get-XyPath 'node.path'
#
# ⚠️ 本文件含中文，**必须带 UTF-8 BOM**：PS 5.1 靠 BOM 认编码，否则按 GBK 读
#    会把下一行代码吞进注释里（本项目踩过这个坑）。

# 目录在 dot-source 时一次性算好：函数里再读 $PSScriptRoot 会拿到【调用方】的目录。
$script:XyPsDir  = $PSScriptRoot
$script:XyLibDir = Split-Path -Parent $PSScriptRoot
$script:XyRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:XyConfigLocalCache   = $null
$script:XyConfigShippedCache = $null

# 第四级兜底：内置默认值（在 本机配置 → 出厂配置 都取不到时用）。
# 存在的理由：config.local.json 丢了的话，$work 会变成 $null，
#   于是所有日志/状态文件会被 Join-Path 拼到不该去的地方，而且不报错。
#   paths.work 可以从本文件的位置推导出来，永远是对的，所以放进来。
# ⚠️ 机器相关的绝对路径（node.path / paths.xianyuMonitor / node.wecomCli）
#   **故意不放**：猜错会静默操作到别人的目录，比取到 $null 更危险。
#   宁可让调用方拿到 $null / $Default，把「配置缺失」暴露出来。
# 注意结构：Get-XyPath 是按 '.' 逐段下钻的，所以这里必须嵌套，不能写成 'paths.work' 平铺。
$script:XyBuiltin = @{
    paths = @{
        work = $script:XyRoot
    }
}

function Read-XyJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    if (-not (Test-Path $Path)) { return $null }
    try {
        # ReadAllText 会自动识别并剥掉 BOM；带 BOM 的 JSON 会让 ConvertFrom-Json 抛错。
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        if (-not $raw -or $raw.Trim().Length -eq 0) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-XyConfigLocal {
    if (-not $script:XyConfigLocalCache) {
        $script:XyConfigLocalCache = Read-XyJson (Join-Path $script:XyRoot 'config.local.json')
    }
    return $script:XyConfigLocalCache
}

function Get-XyConfigShipped {
    if (-not $script:XyConfigShippedCache) {
        $script:XyConfigShippedCache = Read-XyJson (Join-Path $script:XyLibDir 'config.json')
    }
    return $script:XyConfigShippedCache
}

# node.path 自愈：CodeBuddy 自动升级会把 versions\22.22.2-3 整个换成 versions\22.22.2-5，
# 配置里写死的版本号必然过期 —— 2026-10-02 凌晨真的发生了（一夜之间目录被改名删除）。
# versions\current 是一个【装着版本号的普通文件】（不是软链接），就是给这种场景用的。
# 路径存在时原样返回，行为与不加自愈时完全一致。
function Resolve-XyNodePath {
    param([string]$Configured)

    if ($Configured -and (Test-Path $Configured)) { return $Configured }   # 正常情况：什么都不做

    if (-not $Configured) { return $null }

    # ⚠️ 这里**不能**用 Test-Path 去校验 Configured 的父目录 —— 自动升级会把
    #    versions\22.22.2-3 整个改名成 .22.22.2-3.deleting.*，那个目录必然不存在，
    #    而"目录消失"恰恰就是要救的场景。（第一版就是这么写的，自愈永远返回 $null。）
    #    所以只从【路径结构】里切出 versions 目录，然后只要求 versions 目录本身在。
    $norm = $Configured -replace '/', '\'
    if ($norm -notmatch '^(?<dir>.+?\\versions)\\[^\\]+\\[^\\]+$') { return $null }
    $versionsDir = $matches['dir']
    if (-not (Test-Path $versionsDir)) { return $null }

    # ① 优先信 current 文件里的版本号
    $curFile = Join-Path $versionsDir 'current'
    if (Test-Path $curFile) {
        try {
            $ver = ([System.IO.File]::ReadAllText($curFile)).Trim()
            if ($ver) {
                $cand = Join-Path (Join-Path $versionsDir $ver) 'node.exe'
                if (Test-Path $cand) {
                    Write-Warning ("[Config.ps1] 配置里的 node 路径已失效，自愈为 versions\{0}\node.exe；建议更新 config.local.json" -f $ver)
                    return $cand
                }
            }
        } catch { }
    }

    # ② 兜底：versions 下最新的一个 node.exe（跳过 .xxx.deleting.* 与 .locks）
    try {
        $hit = Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike '.*' -and $_.Name -ne 'locks' } |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($hit) {
            Write-Warning ("[Config.ps1] 配置里的 node 路径已失效，自愈为 {0}" -f $hit)
            return $hit
        }
    } catch { }

    return $null
}

# 返回整个配置对象：本机配置优先，没有则给出厂配置。
function Get-XyConfig {
    $local = Get-XyConfigLocal
    if ($local) { return $local }
    return (Get-XyConfigShipped)
}

# 按点号路径取值，取不到返回 $Default
#   Get-XyPath 'paths.work'   → 'D:/DSH/achun'
#   Get-XyPath 'node.path'    → node.exe 路径
#   Get-XyPath 'store.default' '好易美代拍'
function Get-XyPath {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        $Default = $null
    )
    $found = $null
    foreach ($cfg in @((Get-XyConfigLocal), (Get-XyConfigShipped), $script:XyBuiltin)) {
        if (-not $cfg) { continue }
        $cur = $cfg
        $hit = $true
        foreach ($seg in ($Key -split '\.')) {
            if ($cur -is [System.Collections.IDictionary]) {
                if (-not $cur.Contains($seg)) { $hit = $false; break }
                $cur = $cur[$seg]
            } else {
                $prop = $cur.PSObject.Properties | Where-Object { $_.Name -eq $seg } | Select-Object -First 1
                if (-not $prop) { $hit = $false; break }
                $cur = $prop.Value
            }
        }
        if ($hit -and $cur -ne $null) { $found = $cur; break }
    }

    # node.path 自愈（路径存在时行为完全不变；只有失效了才会被替换）
    if ($Key -eq 'node.path') {
        $self = Resolve-XyNodePath -Configured $found
        if ($self) { return $self }
    }

    if ($found -ne $null) { return $found }
    return $Default
}
