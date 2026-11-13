@echo off
setlocal
cd /d "%~dp0"
title Market Pulse - Enable auto start

wscript //nologo "%~dp0_autostart.vbs" install
if errorlevel 1 goto failed

echo.
echo   [OK] Auto start enabled.
echo        Startup shortcut: %%APPDATA%%\Microsoft\Windows\Start Menu\Programs\Startup
echo        Open the dashboard at: http://127.0.0.1:8765
echo.
pause
exit /b 0

:failed
echo.
echo   [ERROR] Could not enable auto start.
echo           Make sure 启动看板-静默.vbs exists in this folder.
echo.
pause
exit /b 1
