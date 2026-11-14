@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not defined CW_PORT set "CW_PORT=17323"

if /i "%~1"=="status" goto status
if /i "%~1"=="check" goto status
if /i "%~1"=="url" goto address
if /i "%~1"=="address" goto address

set "CW_NO_BROWSER=1"
set "CW_QUIET_START=1"
node src/app.mjs console
set "code=%ERRORLEVEL%"
popd
exit /b %code%

:address
echo http://127.0.0.1:%CW_PORT%/
:hold
pause >nul
goto hold

:status
node tools/mitm-ca.mjs status
set "code=%ERRORLEVEL%"
popd
exit /b %code%
