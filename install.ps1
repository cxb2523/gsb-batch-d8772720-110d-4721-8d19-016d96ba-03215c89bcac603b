<#
================================================================================
 install.ps1 — 闲鱼自动化 · 一键安装（幂等，可以反复跑）

 设计原则（每一条都是踩出来的）：
   1. 幂等 —— 每一步都先判断"是不是已经好了"，重跑不会越装越乱。
   2. 失败软着陆 —— 拿不到中台配置、克隆失败、服务起不来，都【不中断】：
      把能装的装完，把缺的列成清单打印出来。学员电脑上能自动装的东西
      不该被一次网络问题全废掉。
   3. 不覆盖已有非空配置 —— 重装/升级不能把老板手工填的值冲掉。要覆盖加 -Force。
   4. 密钥不出现在屏幕上 —— 只打掩码。
   5. -DryRun 先预演，什么都不改。

 用法:
   powershell -ExecutionPolicy Bypass -File install.ps1
   powershell -ExecutionPolicy Bypass -File install.ps1 -InstallCode <码>
   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipDeps -NoStart   # 只落配置

 退出码: 0 = 骨架已装好（哪怕还有缺项）；1 = 参数错或前置不满足（缺少 node 等）
================================================================================
#>
[CmdletBinding()]
param(
    [string]$InstallCode = '',
    [string]$MiddleBase  = '',   # 中台下发的服务端地址；公开版留空（内部地址不入库）。要用时传 -MiddleBase <地址>
    [string]$GitBase     = 'https://gitlab.com/hym-company',
    [string]$GitToken    = '',            # 私有仓库只读 token；也可由中台下发
    [switch]$SkipDeps,                    # 跳过克隆 / npm install
    [switch]$NoStart,                     # 不启动 8093 服务
    [switch]$Force,                       # 允许覆盖已有非空配置
    [switch]$DryRun                       # 只打印计划
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Root   = $PSScriptRoot
$Parent = Split-Path -Parent $Root
$achunCfg = Join-Path $Root 'config.local.json'
$Missing = New-Object System.Collections.ArrayList
$Warned  = New-Object System.Collections.ArrayList

function Read-Json([string]$p) {
    if (-not (Test-Path $p)) { return $null }
    try { return ([System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { return $null }
}

<#
 找到依赖仓库的位置。
   ① 已有 config.local.json 里配的（重跑/升级时最重要）
   ② 环境变量
   ③ 问 lib/env.js —— 路径的约定式自愈规则只有那一份，别在这里抄第二遍
      （第一版就是抄了一遍、还漏了 Desktop 那条，把明明装好的 xianyu-monitor 当成"要克隆"）
   ④ 都没有 → 返回约定位置 <parent>\<名字>，让调用方去克隆
#>
function Resolve-DepDir([string]$Key, [string]$DefaultName, [string]$EnvName) {
    $c = Read-Json $achunCfg
    if ($c -and $c.paths) {
        $p = [string]$c.paths.$Key
        if ($p -and (Test-Path $p)) { return $p }
    }
    $e = [Environment]::GetEnvironmentVariable($EnvName)
    if ($e -and (Test-Path $e)) { return $e }
    $pp = Join-Path $Root 'tools\print-paths.js'
    if ($NodeExe -and (Test-Path $pp)) {
        try {
            $out = (& $NodeExe $pp 2>$null | Out-String)
            if ($out) {
                $o = $out | ConvertFrom-Json
                $p = [string]$o.paths.$Key
                if ($p -and (Test-Path $p)) { return $p }
            }
        } catch { }
    }
    foreach ($cand in @((Join-Path $Parent $DefaultName),
                        (Join-Path $env:USERPROFILE ('.kun\default_workspace\' + $DefaultName)))) {
        if (Test-Path $cand) { return $cand }
    }
    return (Join-Path $Parent $DefaultName)
}

function Head($t) { Write-Host ''; Write-Host ('── ' + $t + ' ' + ('─' * [Math]::Max(0, 58 - $t.Length))) -ForegroundColor Cyan }
function Ok($t)   { Write-Host ('  [ok]   ' + $t) -ForegroundColor Green }
function Info($t) { Write-Host ('  [..]   ' + $t) }
function Warn($t) { Write-Host ('  [warn] ' + $t) -ForegroundColor Yellow; [void]$Warned.Add($t) }
function Bad($t)  { Write-Host ('  [FAIL] ' + $t) -ForegroundColor Red }
function Miss($t) { Write-Host ('  [缺]   ' + $t) -ForegroundColor Yellow; [void]$Missing.Add($t) }
function Mask($s) { if (-not $s) { return '' }; if ($s.Length -le 8) { return '****' }; return $s.Substring(0,5) + '****' + $s.Substring($s.Length-3) }

# 执行一条外部命令；-DryRun 时只打印不执行
# ⚠️ 参数名不叫 $Args —— $Args 是 PowerShell 的自动变量，用它当形参会出诡异问题。
function Run([string]$Exe, [string[]]$ArgList, [string]$Why) {
    if ($DryRun) { Info ('[DryRun] ' + $Exe + ' ' + ($ArgList -join ' ') + '    # ' + $Why); return 0 }
    Info ($Why + ' -> ' + $Exe + ' ' + ($ArgList -join ' '))
    & $Exe @ArgList 2>&1 | ForEach-Object {
        $s = "$_"
        # 【2026-11-14 第 157 轮】node 在【有代理】的机器上会打这两行英文技术噪音：
        #     (node:xxx) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...
        #     (Use `node --trace-warnings ...` to show where the warning was created)
        # 学员看不懂，而且它真正想说的事（"你开了代理"）上面 1b 节已经用中文讲清楚了，
        # 所以这里直接滤掉 —— 只滤这几行，其它警告照常显示。
        if ($s -match 'UNDICI-|ExperimentalWarning|trace-warnings') { return }
        Write-Host ('         ' + $s)
    }
    return $LASTEXITCODE
}

Write-Host ''
Write-Host '============================================================'
Write-Host '  闲鱼自动化 · 安装'
Write-Host '============================================================'
Write-Host ("  仓库根 : " + $Root)
if ($DryRun) { Write-Host '  模式   : DryRun（只预演，不改任何东西）' -ForegroundColor Yellow }

# ── 1. 前置：node / git ──────────────────────────────────────────
Head '前置检查'

# ── 1a. 系统版本（2026-11-14 第 230 轮加）─────────────────────────
# 为什么加：install-guide 第 0 节、学员安装、真机清单三处都写「Windows 10 / 11」，
#   但安装器从没验过。Win7/8 上 playwright 新版本根本跑不起来，
#   学员会装到一半才撞上，而且报的多半是英文。
# 只警告不拦截：版本号有时被兼容模式带偏（6.2 不一定是真的 Win8），
#   说清楚让他自己判断，别替他决定装不装。
$osVer = $null
try {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    if ($cv.CurrentMajorVersionNumber) { $osVer = [int]$cv.CurrentMajorVersionNumber }
} catch { }
if (-not $osVer) { try { $osVer = [System.Environment]::OSVersion.Version.Major } catch { $osVer = $null } }
if ($osVer -and $osVer -lt 10) {
    # 注意：Win10 和 Win11 的注册表主版本号都是 10，Win7/8 才是 6.x。
    # 所以这里读到 <10 基本可以断定不是 Win10+；直接说「不是 Win10/11」
    # 比打印「Windows 6」清楚。
    Warn ('这台机器不是 Windows 10 / 11（主版本号 ' + $osVer + '）')
    Write-Host '         playwright + Chromium 需要 Win10 以上；老系统上会装到一半失败。'
    Write-Host '         先确认一下：设置 → 系统 → 关于 里看「Windows 规格」。'
    Write-Host '         （确认过确实是 Win10+ 就继续；真是老系统就换台机器装。）'
}

# node：和 run-node.cmd 同一套四级回退，别写死版本号（自动升级会改名）
$NodeExe = $null
$vd = if ($env:XY_NODE_VERSIONS) { $env:XY_NODE_VERSIONS } else { Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions' }
if ($env:XY_NODE -and (Test-Path $env:XY_NODE)) { $NodeExe = $env:XY_NODE }
if (-not $NodeExe -and (Test-Path (Join-Path $vd 'current'))) {
    $v = ([System.IO.File]::ReadAllText((Join-Path $vd 'current'))).Trim()
    if ($v -and (Test-Path (Join-Path $vd "$v\node.exe"))) { $NodeExe = Join-Path $vd "$v\node.exe" }
}
if (-not $NodeExe -and (Test-Path $vd)) {
    $hit = Get-ChildItem $vd -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' -and $_.Name -ne 'locks' } |
        Sort-Object LastWriteTime -Descending |
        Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
    if ($hit) { $NodeExe = Join-Path $hit.FullName 'node.exe' }
}
if (-not $NodeExe) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $NodeExe = $c.Source } }

if (-not $NodeExe) {
    # 2026-11-13：这里是学员的【第一道坎】，原来只说"请先装 Node.js 18+"，
    # 没告诉他去哪下、装哪个、装完为什么还可能找不到。补全。
    Bad '找不到 Node.js —— 这是必须先装的第一个东西，装完其它才谈得上。'
    Write-Host ''
    Write-Host '  怎么装（3 步）：' -ForegroundColor Yellow
    Write-Host '    1) 打开 https://nodejs.org/zh-cn  → 下载 LTS 版'
    Write-Host '    2) 一路下一步装完（不用改任何选项）'
    Write-Host '    3) 【关掉所有命令行窗口】再双击 install.cmd'
    Write-Host '       （不关的话新装的 PATH 不生效，还会报同样的错）'
    Write-Host ''
    Write-Host '  已经装过、但这个脚本找不到？'
    Write-Host '    命令行跑  where node  看它在哪，然后 set XY_NODE=<那个路径> 再跑'
    Write-Host ''
    exit 1
}
Ok ('node: ' + $NodeExe + '  (' + (& $NodeExe -v) + ')')

# 【第 228 轮加】文档三处都写「Node.js 18 或更高」（install-guide 第0 节 / 学员安装 / 真机清单），
#   但这里从没验过 —— 装了 Node 16 的机器会一路跑到 npm install 才炸，而且报的是英文。
#   学员的第一道坎，应该在这儿就拦住并给出中文指引。
$nv = ''
try { $nv = (& $NodeExe -v 2>$null | Select-Object -First 1) } catch { $nv = '' }
# 门槛和提示里的数字用同一个变量 —— 改门槛时不会漏改文案（第228 轮实测反向验证过）
$MinNode = 18
if ($nv -match 'v(\d+)') {
    $major = [int]$Matches[1]
    if ($major -lt $MinNode) {
        Bad ('Node 版本太旧：' + $nv.Trim() + '（需要 v' + $MinNode + ' 或更高）')
        Write-Host ''
        Write-Host '  怎么办（3 步）：' -ForegroundColor Yellow
        Write-Host '    1) 打开 https://nodejs.org/zh-cn → 下载 LTS 版（当前是 v22）'
        Write-Host '    2) 一路下一步装完（覆盖旧版本即可，不用先卸载）'
        Write-Host '    3) 【关掉所有命令行窗口】再重新双击 install.cmd'
        Write-Host '       （不关的话新装的 PATH 不生效，还会看到同样的错）'
        Write-Host ''
        exit 1
    }
}

$GitExe = $null
if (-not $SkipDeps) {
    $g = Get-Command git -ErrorAction SilentlyContinue
    if ($g) { $GitExe = $g.Source; Ok ('git: ' + $GitExe) }
    else {
        # 2026-11-13：学员不知道 git 是干嘛的，也不知道没它会影响什么
        Warn '这台电脑没有 git（版本管理工具）'
        Write-Host '         影响：本来要自动下载两个配套目录（xianyu-playwright-service / xianyu-monitor），'
        Write-Host '               现在下不了 —— 安装包要提前把这两个目录解压好，否则装完用不了。'
        Write-Host '         处理：如果你拿的是完整 zip（解压出来就有三个目录），忽略这条即可。'
        Write-Host '               如果只有 xianyu-achun 一个目录，去找管理员要完整包。'
    }
}

# ── 1c. 磁盘空间（2026-11-14 第 229 轮加）──────────────────────────
# 为什么加：install-guide 第 0 节写着「磁盘留 3 GB（首次装会下 Chromium 约 1.5 GB）」，
#   但安装器从来没验过这件事 —— 满盘时 npm install / Chromium 下载会中途炸，
#   报的是英文 ENOSPC / ENOSPC，学员既看不懂也想不到是磁盘。
# 分级：<1 GB 直接拦（装必炸），1–3 GB 只警告（可能够，让他自己掂量）。
$MinFreeGB = 3; $BlockFreeGB = 1
try {
    $driveLetter = (Get-Item -LiteralPath $Root).PSDrive.Name
    $freeGB = [math]::Round((Get-PSDrive -Name $driveLetter -ErrorAction Stop).Free / 1GB, 1)
    if ($freeGB -lt $BlockFreeGB) {
        Bad ('磁盘空间不够：' + $driveLetter + ': 只剩 ' + $freeGB + ' GB（至少要 ' + $MinFreeGB + ' GB）')
        Write-Host ''
        Write-Host '  为什么会炸：首次安装要下 Chromium（约 1.5 GB）+ 依赖，空间不够会下到一半失败。' -ForegroundColor Yellow
        Write-Host '  怎么办：'
        Write-Host ('    1) 打开「此电脑」看 ' + $driveLetter + ': 还剩多少')
        Write-Host '    2) 清掉回收站 / 下载文件夹里的旧文件，或改解压到别的盘（D: E: 都行）'
        Write-Host '    3) 重新解压安装包，再双击 install.cmd'
        Write-Host ''
        exit 1
    } elseif ($freeGB -lt $MinFreeGB) {
        Warn ('磁盘空间偏紧：' + $driveLetter + ': 只剩 ' + $freeGB + ' GB（建议至少 ' + $MinFreeGB + ' GB）')
        Write-Host '         首次安装要下 Chromium（约 1.5 GB）。够就继续，不够会在下到一半时报错。'
    } else {
        Ok ('磁盘空间：' + $driveLetter + ': 剩 ' + $freeGB + ' GB')
    }
} catch { }


# ── 1b. 代理（2026-11-14 第 157 轮加）─────────────────────────────
# 为什么加：《发放说明》第一节就要求「装之前先关掉 VPN / 系统代理」，
#   但安装器从来没验过这件事。有代理时会同时出两个症状，而且都不好懂：
#     ① node 的 fetch 打一行英文 experimental warning 到屏幕上
#        （(node:xxx) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...）
#     ② 装完闲鱼连不上 —— 学员只看到「浏览器一直转圈」，根本想不到是代理
#   所以在这里【提前用中文说清楚】，比事后排查省事。
# 只警告不拦截：有人确实要走代理装，那让他自己承担后果，别替他决定。
$proxyEnv = @($env:HTTP_PROXY, $env:HTTPS_PROXY, $env:http_proxy, $env:https_proxy) |
    Where-Object { $_ -and $_.Trim() }
$inetProxy = $null
try {
    $k = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($k -and $k.ProxyEnable -eq 1) { $inetProxy = $k.ProxyServer }
} catch { }
if ($proxyEnv -or $inetProxy) {
    $p = if ($proxyEnv) { ($proxyEnv | Select-Object -First 1) } else { $inetProxy }
    Warn ('检测到代理：' + $p)
    Write-Host '         《发放说明》第一步就要求「装之前先关掉 VPN / 系统代理」。'
    Write-Host '         不关的后果：闲鱼连不上（浏览器一直转圈）、扫码登录会失败、出图取不到数。'
    Write-Host '         关掉方法：退出 VPN 客户端；系统代理在 设置 → 网络和 Internet → 代理 里关。'
    Write-Host '         （确定要用代理装的话可以继续，但出问题先想到它。）'
}

# ── 2. 依赖仓库（这里只定义函数，调用在第 4b 步）──────────────────
# ⚠️ 注意顺序：Resolve-DepDir / Ensure-Repo 的【调用】放在「本机配置」和「中台下发」之后。
#    原因：中台下发的 git.token 要能用于克隆，而 Resolve-DepDir 要先读 config.local.json
#    才知道仓库该放哪。第一版把克隆放在最前面，于是"token 由中台给"这条路径根本走不通
#    （token 拿到时已经错过克隆了）。函数定义留在这里，调用挪到后面。
function Ensure-Repo([string]$Dir, [string]$RepoName, [string]$Marker, [string]$Why) {
    # Marker = "这个仓库确实在"的标志文件：服务是 package.json，monitor 是 publish.js
    # （xianyu-monitor 本来就没有 package.json —— 它是浏览器控制台 JS，没有构建步骤）
    if (Test-Path (Join-Path $Dir $Marker)) { Ok ($RepoName + ' 已就位: ' + $Dir); return $true }
    if (Test-Path (Join-Path $Dir '.git')) { Ok ($RepoName + ' 已克隆: ' + $Dir); return $true }
    if (Test-Path $Dir) {
        $n = @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue).Count
        if ($n -gt 0) {
            Warn ($RepoName + ' 这个目录里已经有东西，但不像正常的仓库：' + $Dir)
            Write-Host ('         缺了关键文件（' + $Marker + '），可能是解压不完整或者放错了地方。')
            Write-Host '         处理：把这个目录删掉，重新从 zip 里解压一份出来。'
            return $false
        }
    }
    if ($SkipDeps) { Miss ($RepoName + ' 不存在（-SkipDeps）：' + $Dir + '  —— ' + $Why); return $false }
    if (-not $GitExe) { Miss ($RepoName + ' 需要手动放置到 ' + $Dir + '（没有 git，无法克隆）'); return $false }
    $url = $GitBase.TrimEnd('/') + '/' + $RepoName + '.git'
    if ($GitToken) { $url = $url -replace '^https://', ('https://oauth2:' + $GitToken + '@') }
    # ⚠️ 打印一律走脱敏 URL：DryRun 的输出最常被复制粘贴进聊天，带上 token 就是泄漏。
    $safeUrl = $url -replace 'oauth2:[^@]+@', 'oauth2:***@'
    Info ('克隆 ' + $RepoName + ' -> ' + $Dir)
    if ($DryRun) { Info ('[DryRun] git clone ' + $safeUrl + ' ' + $Dir); return $false }
    & $GitExe clone --depth 1 $url $Dir 2>&1 | ForEach-Object { Write-Host ('         ' + ($_ -replace 'oauth2:[^@]+@', 'oauth2:***@')) }
    if ($LASTEXITCODE -ne 0) {
        Miss ($RepoName + ' 克隆失败（私有仓库要 token）：git clone ' + $safeUrl + ' ' + $Dir)
        return $false
    }
    Ok ($RepoName + ' 克隆完成: ' + $Dir)
    return $true
}

# ── 3. 本机配置（paths / node）──────────────────────────────────
Head '本机配置'
$cfgTool = Join-Path $Root 'tools\install-config.js'
if (-not (Test-Path $cfgTool)) {
    # 2026-11-13：学员不知道 install-config.js 是什么
    Bad '这个安装包不完整 —— 缺了核心文件 tools\install-config.js'
    Write-Host '     说明：那个文件负责「告诉程序你的电脑路径在哪」，没有它装不下去。'
    Write-Host '     处理：重新下载 zip 并完整解压（别只拷一部分文件），再跑一次。'
    exit 1
    exit 1
}
$argv = @($cfgTool, '--derive', '--apply')
if ($Force) { $argv += '--force' }
if ($DryRun) { $argv = @($cfgTool, '--derive') }
[void](Run $NodeExe $argv '推导本机路径并写 config.local.json')

# ── 4. 中台下发（可失败）────────────────────────────────────────
Head '中台配置下发'
$tmpResp = Join-Path $env:TEMP ('xy-install-' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.json')
$gotRemote = $false
if (-not $InstallCode) {
    # 2026-11-13：学员根本不知道 InstallCode 是什么，原来那句等于没说
    Info '没给安装码（-InstallCode）—— 正常，不用管'
    Write-Host '         安装码是「自动拉取你的账号和密钥」用的，那个功能还没做好。'
    Write-Host '         现在走的是「手工填配置」，所以这一步跳过不影响使用。'
} elseif ($DryRun) {
    Info ('[DryRun] GET ' + $MiddleBase.TrimEnd('/') + '/api/xianyu-install-config  (X-Install-Code: ' + (Mask $InstallCode) + ')')
} else {
    $url = $MiddleBase.TrimEnd('/') + '/api/xianyu-install-config'
    Info ('GET ' + $url + '  (X-Install-Code: ' + (Mask $InstallCode) + ')')
    try {
        $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 30 -Headers @{ 'X-Install-Code' = $InstallCode }
        if ($resp -and $resp.ok -eq $true) {
            ($resp | ConvertTo-Json -Depth 12) | Out-File -FilePath $tmpResp -Encoding UTF8
            Ok '中台配置已取到'
            if ($resp.git -and $resp.git.token -and -not $GitToken) { $GitToken = $resp.git.token; Info '中台下发了 git 只读 token（用于后续拉代码）' }
            $gotRemote = $true
        } else {
            Warn ('中台返回 ok!=true：' + ($resp | ConvertTo-Json -Compress -Depth 4))
            Miss '中台还没下发配置（这个端点尚未就绪，属正常）—— 复制 config.local.json.example 成 config.local.json，照里面每段的 _说明 填好再重跑'
        }
    } catch {
        Warn ('中台不可达 / 安装码失效：' + $_.Exception.Message)
        Miss '中台还没下发配置（网络不通或端点没建）—— 复制 config.local.json.example 成 config.local.json，照里面每段的 _说明 填好再重跑'
    }
}
if ($gotRemote -and -not $DryRun) {
    $argv2 = @($cfgTool, ('--from=' + $tmpResp), '--apply')
    if ($Force) { $argv2 += '--force' }
    [void](Run $NodeExe $argv2 '把中台配置合并进 config.local.json')
}

# ── 4b. 依赖仓库（必须在"中台下发"之后 —— git.token 要能用于克隆）──
Head '依赖仓库'
# 约定布局：两个仓库并排放在本仓库的上一级。
#   <parent>\playwright-service     （gitlab: xianyu-playwright-service）
#   <parent>\xianyu-monitor
# 找不到就克隆；克隆不了就记一笔缺失，继续往下装。
$SvcDir = Resolve-DepDir 'playwrightService' 'playwright-service' 'XY_PLAYWRIGHTSERVICE'
$MonDir = Resolve-DepDir 'xianyuMonitor'     'xianyu-monitor'     'XY_XIANYUMONITOR'
$svcOk = Ensure-Repo $SvcDir 'xianyu-playwright-service' 'package.json' '8093 浏览器服务（出图/发布/账号全靠它）'
$monOk = Ensure-Repo $MonDir 'xianyu-monitor' 'publish.js' '桌面发布台 + 文案/版式库（publish.js / publish_dashboard.js）'

# ── 5. 服务侧密钥对齐 ───────────────────────────────────────────
Head '服务侧密钥'
# 8093 服务每次启动都会保证 service.local.json 里有一把密钥（没有就随机生成）。
# 这里只做检查与提示：两边不一致的话，客户端所有请求都会 401。
$svcCfg = Join-Path $SvcDir 'service.local.json'
# Read-Json / $achunCfg 在文件顶部已定义（那时就要用来找依赖仓库的路径）
$sc = Read-Json $svcCfg
$ac = Read-Json $achunCfg
if (-not (Test-Path $svcCfg)) {
    Info ('服务还没启动过，service.local.json 未生成：' + $svcCfg)
    Info '  服务第一次启动时会自己生成一把随机密钥；生成后要把同样的值填进 config.local.json 的 service.apiKey。'
} elseif ($sc -and $sc.apiKey -and $ac -and $ac.service -and $ac.service.apiKey) {
    if ($sc.apiKey -eq $ac.service.apiKey) { Ok ('两边一致：' + (Mask $sc.apiKey)) }
    else {
        Warn ('两边 apiKey 不一致！服务=' + (Mask $sc.apiKey) + '  客户端=' + (Mask $ac.service.apiKey))
        # 2026-11-13：只报「不一致」学员不知道会怎样。说清后果和下一步。
        Write-Host '         会导致：本机出的图和 8093 服务互相不认，请求全部 401。'
        Write-Host '         下面会自动把服务侧密钥同步过来 —— 看到「已同步」就不用管。'
        if ($DryRun) { Info '[DryRun] 会把服务侧的密钥同步进 config.local.json' }
        else {
            if (-not $ac.service) { $ac | Add-Member -NotePropertyName service -NotePropertyValue ([pscustomobject]@{}) }
            $ac.service.apiKey = $sc.apiKey
            [System.IO.File]::WriteAllText($achunCfg, ($ac | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
            Ok '已把服务侧密钥同步进 config.local.json'
        }
    }
} else {
    # 2026-11-13：原来只说"读不到 apiKey"，学员不知道这意味着什么
    Warn '两边配置里的 apiKey 对不上（或有一边还没写），这一项跳过'
    Write-Host '         影响：出图照常，但「共享版式到中台」可能会失败。'
    Write-Host '         处理：一般不用管；真遇到共享版式失败再找管理员对齐。'
}

# ── 6. 服务依赖 ─────────────────────────────────────────────────
Head '服务依赖'
$svcModules = Join-Path $SvcDir 'node_modules'
if ($SkipDeps) { Info '-SkipDeps：跳过 npm install' }
elseif (Test-Path (Join-Path $svcModules 'express')) { Ok 'node_modules 已就位（express/playwright/sharp）' }
else {
    # 2026-11-12 修：Get-Command npm 取的是 PATH 里第一个 npm，可能和上面检测到的
    # node 不是一套（实测：node=workbuddy v22，npm=scoop 的 npm.ps1）。版本错配装依赖会出怪问题。
    # 优先用 node 同目录的 npm，找不到才回落 PATH。
    $npm = $null
    if ($NodeExe) {
        $nodeDir = Split-Path $NodeExe -Parent
        foreach ($n in @('npm.cmd', 'npm.exe', 'npm')) {
            $cand = Join-Path $nodeDir $n
            if (Test-Path $cand) { $npm = [pscustomobject]@{ Source = $cand }; break }
        }
    }
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { Miss '需要 npm 来装服务依赖（express / playwright / sharp）' }
    else {
        Info '装服务依赖（express / playwright / sharp），首次会下载 Chromium，比较慢…'
        if ($DryRun) { Info ('[DryRun] ' + $npm.Source + ' install  (cwd=' + $SvcDir + ')') }
        else {
            Push-Location $SvcDir
            & $npm.Source install 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
            $code = $LASTEXITCODE
            Pop-Location
            if ($code -eq 0 -and (Test-Path (Join-Path $svcModules 'express'))) { Ok '服务依赖装好' }
            else {
                # 【2026-11-13 改】原来只说「进 xxx 手动跑 npm install」。
                #   学员照做，还是失败 —— 因为卡住的往往不是 npm 本身，是 Chromium（约 150 MB）
                #   从境外 CDN 下载。这一步在国内网络上超时是最常见的原因。
                #   把三种真实原因和对应的做法列出来，别让人反复重试同一件不会成功的事。
                Miss ('服务依赖安装失败（退出码 ' + $code + '）')
                Write-Host ''
                Write-Host '         这一步要下 Chromium（约 150 MB），卡住多半是下面三种之一：'
                Write-Host ''
                Write-Host '         ① 网络超时（最常见）—— 换国内镜像重试：'
                Write-Host '              npm config set registry https://registry.npmmirror.com'
                Write-Host '              set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright'
                Write-Host '            然后【关掉这个窗口】重新双击 install.cmd'
                Write-Host ''
                Write-Host '         ② 磁盘不够 —— 这一步要留 500 MB 以上'
                Write-Host '             看一下 C 盘剩余空间（我的电脑 → 右键 C 盘 → 属性）'
                Write-Host ''
                Write-Host '         ③ 杀毒软件拦住了 node.exe'
                Write-Host '             临时关掉杀毒的「实时防护」，装完再打开'
                Write-Host ''
                Write-Host '         想手动重跑：'
                Write-Host ('             cd "' + $SvcDir + '"')
                Write-Host '             npm install'
                Write-Host ''
                Write-Host '         还是不行就把上面整段输出发给管理员。'
            }
        }
    }
}

# ── 7. 启动并探活 ───────────────────────────────────────────────
Head '启动 8093 服务'
$Port = 8093
if ($ac -and $ac.service -and $ac.service.port) { $Port = [int]$ac.service.port }
$probeUrl = 'http://127.0.0.1:' + $Port + '/api/agent/status'
function Test-Service {
    try { $r = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 5 -UseBasicParsing; return ($r.StatusCode -eq 200) } catch { return $false }
}
if (Test-Service) { Ok ('服务已在运行：' + $probeUrl) }
elseif ($NoStart) { Info '-NoStart：不启动。手动启动：' + (Join-Path $SvcDir 'start.bat') }
elseif ($DryRun) { Info ('[DryRun] 启动 ' + (Join-Path $SvcDir 'start.bat') + ' 然后探活 ' + $probeUrl) }
else {
    $startBat = Join-Path $SvcDir 'start.bat'
    if (-not (Test-Path $startBat)) { Miss ('找不到启动脚本：' + $startBat) }
    else {
        Info '后台启动服务…'
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $startBat + '"') -WorkingDirectory $SvcDir -WindowStyle Minimized | Out-Null
        $up = $false
        for ($i = 1; $i -le 30; $i++) { Start-Sleep -Seconds 2; if (Test-Service) { $up = $true; break } }
        if ($up) { Ok ('服务已起来：' + $probeUrl) } else { Miss ('服务 60 秒内没起来，看 ' + (Join-Path $SvcDir 'startup.log')) }
    }
}

# ── 7.5 文案模板库（~/.xianyu-templates.json）────────────────────
# 2026-11-12 加：这个文件在【用户目录】下，不在代码包里。
#   而 first-publish.js 读不到它会直接报「❌ 读不到文案模板（~/.xianyu-templates.json）。先跑一次 install.ps1」——
#   但原来 install.ps1 根本不生成它，学员装完第一次发链接就卡在这个死循环上。
#   现在：包里带一份 xianyu-templates.example.json（10 套通用文案），装的时候复制到用户目录，
#   并把 storeTemplates 的占位店铺名换成学员 service.local.json 里的真实店名。
Head '文案模板库'
$tplUser    = Join-Path $env:USERPROFILE '.xianyu-templates.json'
$tplExample = Join-Path $Root 'xianyu-templates.example.json'

# 学员的店铺名：从 service.local.json 读第一个 localAccounts[].name
$studentStore = ''
$svcLocal = Join-Path $SvcDir 'service.local.json'
if (Test-Path $svcLocal) {
    try {
        $sj = Get-Content -Raw -Encoding UTF8 $svcLocal | ConvertFrom-Json
        if ($sj.localAccounts -and $sj.localAccounts.Count -gt 0) { $studentStore = [string]$sj.localAccounts[0].name }
    } catch { }
}

if (Test-Path $tplUser) {
    Ok ('已存在，不覆盖: ' + $tplUser)
}
elseif (-not (Test-Path $tplExample)) {
    Warn '包里没有 xianyu-templates.example.json —— 发布时会缺文案模板，把这条发给管理员'
}
else {
    if ($DryRun) {
        Info ('[DryRun] 生成 ' + $tplUser + '  (storeTemplates 填: ' + $(if ($studentStore) { $studentStore } else { '<你的店铺名>' }) + ')')
    }
    else {
        # 用 node 走一遍，避免 PowerShell 处理中文 JSON 转义出错
        $mk = Join-Path $Root 'tools\make-templates-from-example.js'
        if (Test-Path $mk) {
            & $NodeExe $mk --store=$studentStore 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
            if (Test-Path $tplUser) { Ok ('已生成: ' + $tplUser) }
            else {
                # 2026-11-14 第 235 轮改：原来写「不影响发布（会自动用全部模板）」——
                #   那句说的是【storeTemplates 里没有这个店】的兜底（publish-one L665），
                #   但这个 warn 触发的条件是【文件根本不存在】—— 那条路 publish-one
                #   原来是裸 readFileSync，直接抛英文 ENOENT（第235 轮实测）。
                #   两个场景被混成一句了，现在说真话。
                Warn '文案模板库没生成成功 —— 这一步【会】影响发链接'
                Write-Host '         发链接时会停在「文案模板库还没生成」（中文提示，已修好不会甩英文）。'
                Write-Host '         想修：把这条发给管理员，或者重跑一次 install.cmd。'
            }
        }
        else {
            # 同上：缺这个脚本也不影响发布，只是挑模板功能用不了
            Warn '缺 tools\make-templates-from-example.js —— 不影响发布'
            Write-Host '         处理：把这条发给管理员，让他补上这个文件。'
        }
    }
}

# ── 7.6 出图客户端（museav-cli）──────────────────────────────────
# 2026-11-12 加：老板要求「主图模板引导学员用 museav 中台」，
#   而 store-wizard.js / make-base-img.js 都要调 museav CLI。原来 install.ps1 完全不装它，
#   学员配店走到第③步必然「❌ 出图失败」，只能退回到大麦海报（抓不到就干脆没图）。
#   注意：这不影响「发布」本身 —— publish-one.js 出图走 8093 的 /api/poster/make。
#   这里装的是【店铺专属底图】那项能力。装不上不阻断，只警告。
Head '出图客户端（museav）'
$museavCmd = $null
$mg = Get-Command museav -ErrorAction SilentlyContinue
if ($mg) { $museavCmd = $mg.Source }

if ($museavCmd) {
    Ok ('museav 已装: ' + $museavCmd)
}
else {
    # 找 npm：和上面"服务依赖"同一套规则（优先 node 同目录）
    $npmForGlobal = ''
    if ($NodeExe) {
        $nd = Split-Path $NodeExe -Parent
        foreach ($n in @('npm.cmd', 'npm.exe', 'npm')) {
            $cand = Join-Path $nd $n
            if (Test-Path $cand) { $npmForGlobal = $cand; break }
        }
    }
    if (-not $npmForGlobal) { $g2 = Get-Command npm -ErrorAction SilentlyContinue; if ($g2) { $npmForGlobal = $g2.Source } }

    if (-not $npmForGlobal) { Warn '找不到 npm，装不了 museav —— 出图会退回大麦海报（不影响发布）' }
    elseif ($DryRun) { Info ('[DryRun] ' + $npmForGlobal + ' install -g museav-cli@latest') }
    else {
        Info '装 museav-cli（用于生成店铺专属底图，约 1 分钟）…'
        & $npmForGlobal install -g museav-cli@latest 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
        $mg2 = Get-Command museav -ErrorAction SilentlyContinue
        if ($mg2) {
            Ok ('museav 已装: ' + $mg2.Source)
            Info '还需要登录中台才能出图：在命令行跑一次  museav login'
        }
        else {
            Warn 'museav 没装上 —— 不影响发布，但配店时出不了"店铺专属底图"。'
            Warn '  手动补：' + $npmForGlobal + ' install -g museav-cli@latest'
        }
    }
}

# ── 8. 店铺骨架 + 自验收 ────────────────────────────────────────
Head '店铺骨架与自验收'
foreach ($d in @((Join-Path $Root 'stores'), (Join-Path $Root 'publish-assets'))) {
    if (Test-Path $d) { Ok ('已存在 ' + $d) }
    elseif ($DryRun) { Info ('[DryRun] 建目录 ' + $d) }
    else { New-Item -ItemType Directory -Force -Path $d | Out-Null; Ok ('建目录 ' + $d) }
}
if ((Test-Path (Join-Path $Root 'stores')) -and @(Get-ChildItem (Join-Path $Root 'stores') -Filter '*.json' -ErrorAction SilentlyContinue).Count -gt 0) {
    [void](Run $NodeExe @((Join-Path $Root 'tools\store-list.js')) '全店离线对照表')
} else {
    Info '还没有店铺档案 —— 用 tools\store-new.js 建一个（见「下一步」）'
}

# ── 9. 收尾 ─────────────────────────────────────────────────────
if (Test-Path $tmpResp) { Remove-Item $tmpResp -Force -ErrorAction SilentlyContinue }

Head '结果'
# DryRun 下 --derive 故意不带 --apply（预览就该什么都不改），所以这里不能报"缺 config.local.json"
if ($DryRun) { Info 'DryRun：config.local.json 的写入已跳过（正式跑会写）' }
elseif (Test-Path $achunCfg) { Ok 'config.local.json 已就绪' }
else { Miss 'config.local.json 还没有' }
if ($Missing.Count -eq 0) { Ok '没有缺失项' } else { Write-Host ('  有 ' + $Missing.Count + ' 项要补：') -ForegroundColor Yellow; $Missing | ForEach-Object { Write-Host ('    · ' + $_) } }

Write-Host ''
Write-Host '══════════ 剩下必须人工做的三件事 ══════════'
  # 2026-11-13：用学员实际填的店名（$studentStore），而不是让他自己对应占位符
  $N = if ($studentStore) { $studentStore } else { '<你的店铺名>' }
  Write-Host '  ① 闲鱼登录（滑块 / 短信验证码，机器做不了）'
  Write-Host ('       node tools\store-ready.js "' + $N + '"')
  Write-Host ('       node tools\store-login.js "' + $N + '" --wait=15')
  Write-Host '  ② 出一张主图看看（只出图，不发布）'
  # 【第 172 轮】原来这里印的是「杭州 那英」—— 实测那对城市+明星【大麦上没有场次】，
  #   学员照敲会停在「大麦有那英的场次，但没有杭州的」，以为出故障了。
  #   改成占位符（和《先看这个-五步上手》一致），让他填自己确定在售的那场。
  Write-Host ('       $env:XY_STORE="' + $N + '"; node publish-one.js <城市> <明星> <首开/二开> --dry')
  Write-Host ('  ③ 副图（把图丢进 publish-assets\' + $N + '\副图\）')
Write-Host ''
Write-Host '  开新店：  node tools\store-new.js --list-accounts'
Write-Host '  看全局：  node tools\store-list.js'
# 【2026-11-13 改】原来这里写「操作手册：闲鱼自动化-操作手册.md」——
#   那份是【给管理员/老板看的】，开篇第一句就是「工作目录一律是 D:\DSH\achun」，
#   学员的目录不是这个，看了只会更糊涂。而且它在解压包的 xianyu-achun\ 里，
#   学员站在包根目录也找不到。
#   学员该看的是这两份（包根就有一份一页纸）：
Write-Host ''
Write-Host '  想再看一遍怎么用：'
Write-Host '     先看这个-五步上手.html        （包根，一页纸，五分钟）'
Write-Host '     xianyu-achun\发放说明-给学员.md（详细版，遇到问题翻）'
Write-Host '     卡住了：打开网页点右上角「一键体检」，把结果贴给管理员。'
Write-Host ''
if ($DryRun) { Write-Host '（DryRun 模式：上面什么都没真的改）' -ForegroundColor Yellow }
exit 0
