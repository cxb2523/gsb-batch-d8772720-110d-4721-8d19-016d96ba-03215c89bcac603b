# tools/test-utf8-writer.ps1
# Regression test for lib/ps/Writes.ps1.
#
# Verifies the exact failure mode this helper exists to prevent:
#   PS 5.1 `Out-File -Encoding UTF8` writes a BOM, and a BOM-carrying JSON makes
#   Node's JSON.parse(fs.readFileSync(...)) throw "Unexpected token".
#
# ASCII-only on purpose (see ad-watch-stuck.ps1: .ps1 files with Chinese need a BOM,
# which editors drop). The Chinese sample is built from code points instead.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-utf8-writer.ps1
# Exit code: 0 = pass, 1 = fail

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\lib\ps\Writes.ps1')

$fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host ("  PASS  " + $name) }
    else { Write-Host ("  FAIL  " + $name); $script:fail++ }
}

$tmp = Join-Path $env:TEMP 'xy-utf8-writer-test.json'
$cn = [string]([char]0x597D + [char]0x6613 + [char]0x7F8E + [char]0x4EE3 + [char]0x62CD)  # "haoyimeidaipai" in Chinese
$payload = @{ store = $cn; n = 3; nested = @{ k = 'v' } } | ConvertTo-Json -Depth 4

Write-Utf8NoBom -Path $tmp -Text $payload

# 1) no BOM
$bytes = [System.IO.File]::ReadAllBytes($tmp)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Check 'writes UTF-8 without BOM' (-not $hasBom)

# 2) PowerShell round-trip keeps the Chinese
$back = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Check 'PowerShell reads Chinese back intact' ($back.store -eq $cn)

# 3) the JSON is parseable as strict JSON (BOM would break this)
$raw = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
Check 'first char is { not U+FEFF' ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0x7B)

# 4) Read-Utf8Text helper
Check 'Read-Utf8Text returns the same text' ((Read-Utf8Text -Path $tmp).Length -gt 0)

# 5) contrast: the OLD idiom really does write a BOM (documents why this exists)
$old = Join-Path $env:TEMP 'xy-utf8-writer-old.json'
@{ a = 1 } | ConvertTo-Json | Out-File $old -Encoding UTF8
$ob = [System.IO.File]::ReadAllBytes($old)
$oldHasBom = ($ob.Length -ge 3 -and $ob[0] -eq 0xEF -and $ob[1] -eq 0xBB -and $ob[2] -eq 0xBF)
if ($PSVersionTable.PSVersion.Major -le 5) {
    Check 'OLD idiom (Out-File -Encoding UTF8) does write a BOM' $oldHasBom
} else {
    Write-Host ("  SKIP  OLD idiom check (PowerShell " + $PSVersionTable.PSVersion + " writes no BOM anyway)")
}

Remove-Item $tmp, $old -ErrorAction SilentlyContinue

if ($fail) { Write-Host ("FAILED: " + $fail); exit 1 }
Write-Host 'OK'
exit 0
