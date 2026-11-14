@echo off
setlocal
cd /d "%~dp0"
title Douyin Image Publish Control Panel

echo ============================================================
echo Douyin Image Publish Control Panel
echo Local URL: http://127.0.0.1:3400/
echo Close this window to stop the control panel.
echo ============================================================

where node.exe >nul 2>&1
if errorlevel 1 goto :node_missing
where npm.cmd >nul 2>&1
if errorlevel 1 goto :npm_missing

if not exist "node_modules\playwright\package.json" (
  echo Installing dependencies for the first run...
  call npm.cmd install
  if errorlevel 1 goto :dependency_failed
)

powershell.exe -NoProfile -Command "try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3400/api/panel/status' -TimeoutSec 2; if ($status.ok -eq $true) { exit 0 }; exit 1 } catch { exit 1 }"
if not errorlevel 1 goto :already_running

set "PANEL_AUTO_OPEN=true"
call npm.cmd run panel
set "panel_exit=%errorlevel%"
if not "%panel_exit%"=="0" (
  echo.
  echo [FAILED] Control panel exited with code %panel_exit%.
  echo Review the error above. This window will stay open.
  pause
)
exit /b %panel_exit%

:already_running
start "" "http://127.0.0.1:3400/"
echo Control panel is already running. Browser opened.
ping -n 3 127.0.0.1 >nul
exit /b 0

:node_missing
echo.
echo [FAILED] node.exe was not found. Install Node.js 20 or newer.
goto :failed

:npm_missing
echo.
echo [FAILED] npm.cmd was not found. Check Node.js and PATH.
goto :failed

:dependency_failed
echo.
echo [FAILED] Dependency installation failed. Check npm and the network.

:failed
pause
exit /b 1
