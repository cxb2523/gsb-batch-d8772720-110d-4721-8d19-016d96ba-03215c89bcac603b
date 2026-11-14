@echo off
cd /d %~dp0
if not exist logs mkdir logs

:loop
echo [%date% %time%] scheduler start >> logs\scheduler.log
npm.cmd run scheduler >> logs\scheduler.log 2>&1
echo [%date% %time%] scheduler stopped, restart in 10s >> logs\scheduler.log
timeout /t 10 /nobreak
goto loop
