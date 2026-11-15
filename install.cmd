@echo off
rem ===== One-click installer wrapper (ASCII only on purpose) =====
rem Why a .cmd wrapper: the AI-illiterate user just double-clicks this file.
rem Double-clicking a .ps1 does NOT run it (Windows opens it in Notepad), and even
rem when it does run, the default ExecutionPolicy may block it. This wrapper calls
rem powershell with -ExecutionPolicy Bypass so neither of those can bite.
rem Any arguments you pass here are forwarded to install.ps1.

rem ===== chcp 65001 (2026-11-12) =====
rem install.ps1 writes Chinese messages. PowerShell emits them as UTF-8;
rem a Chinese Windows console defaults to codepage 936, so without this line
rem the ENTIRE installer screen shows as garbage (e.g. install-guide text).
rem Measured: without chcp -> mojibake; with chcp 65001 -> correct.
rem Keep this file ASCII-only: a .cmd with UTF-8 Chinese would mojibake itself.
chcp 65001 >nul

setlocal
set "PS=powershell.exe"
where pwsh >nul 2>nul && set "PS=pwsh.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
echo [install.cmd] exit code = %CODE%
pause
exit /b %CODE%
