@echo off
setlocal
cd /d "%~dp0"
title Market Pulse - Enable auto start (window mode)

echo.
echo   This will start 启动看板.bat at every logon.
echo   A console window will appear (minimized in the taskbar).
echo   For a fully hidden start, use 安装开机自启.bat instead.
echo.
pause

wscript //nologo "%~dp0_autostart.vbs" install bat
if errorlevel 1 goto failed

echo.
echo   [OK] Auto start enabled (bat, minimized window).
echo        Open the dashboard at: http://127.0.0.1:8765
echo.
pause
exit /b 0

:failed
echo.
echo   [ERROR] Could not enable auto start.
echo           Make sure 启动看板.bat exists in this folder.
echo.
pause
exit /b 1
