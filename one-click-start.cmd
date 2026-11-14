@echo off
setlocal
cd /d "%~dp0"
title Douyin RPA Publisher - One Click Start

echo ============================================================
echo Douyin RPA Publisher - One Click Start
echo Actions: environment check, batch validation, login, server
echo This script does NOT start the scheduler or publish content.
echo ============================================================

where node.exe >nul 2>&1
if errorlevel 1 goto :node_missing
where npm.cmd >nul 2>&1
if errorlevel 1 goto :npm_missing

if not exist "node_modules\playwright\package.json" (
  echo [1/3] Installing dependencies for the first run...
  call npm.cmd install
  if errorlevel 1 goto :dependency_failed
) else (
  echo [1/3] Dependencies are ready.
)

echo [2/3] Validating the current seven-field batch...
call npm.cmd run validate:local
if errorlevel 1 goto :batch_failed

if /I "%~1"=="--check" goto :check_ok

echo [3/3] Opening the Chrome login page...
echo Wait for the QR code, then scan it. Login remains open for 15 minutes.
set "DOUYIN_LOGIN_WAIT_MS=900000"
set "DOUYIN_MAX_LOGIN_WAIT_MS=1800000"
set "DOUYIN_LOGIN_UI_WAIT_MS=120000"
set "DOUYIN_LOGIN_QR_SETTLE_MS=10000"
call npm.cmd run login:account1
if errorlevel 1 goto :login_failed

call npm.cmd run health >nul 2>&1
if not errorlevel 1 goto :already_running

echo Login succeeded. Starting the local service...
echo Service URL: http://127.0.0.1:3300
echo Close this window to stop the service.
call npm.cmd start
exit /b %errorlevel%

:check_ok
echo.
echo One-click startup check passed.
echo Check mode did not open Chrome or start the service.
exit /b 0

:already_running
echo.
echo Login succeeded. The local service is already running.
pause
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
goto :failed

:batch_failed
echo.
echo [FAILED] The current publishing batch did not pass validation.
goto :failed

:login_failed
echo.
echo [FAILED] Login was not completed within 15 minutes, or Chrome failed.
echo Run this script again to retry. No content was published.

:failed
pause
exit /b 1
