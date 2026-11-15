@echo off
rem 编码说明（改这个文件前必读）：
rem   1) 本文件用【GBK】保存。Windows 中文系统 cmd 代码页是 936，
rem      用 UTF-8 存的话，下面的中文 echo 会显示成乱码。
rem   2) node 的输出是 UTF-8，所以在跑 node 【之前】要 chcp 65001，
rem      否则黑窗口里 server.js 的日志会显示成「闂查奔涓婃灦鍔」这种乱码。
rem   3) chcp 65001 之后，cmd 自己的 echo 又会按 UTF-8 解释本文件（GBK）里的中文，
rem      所以 node 之后的提示一律用英文。
cd /d "%~dp0\..\.."
title 闲鱼上架助手

echo.
echo   正在启动，3 秒后浏览器会自动打开...
echo   用完关掉这个黑窗口就行。
echo.

start "" /min cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8099"

rem 切到 UTF-8，让 node 的中文日志正常显示
chcp 65001 >nul
node tools\staff-ui\server.js

echo.
chcp 936 >nul
echo.
echo   服务已停止，按任意键关闭。
pause >nul
