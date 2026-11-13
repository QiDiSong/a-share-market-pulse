@echo off
setlocal
cd /d "%~dp0"
title Market Pulse - Disable auto start

wscript //nologo "%~dp0_autostart.vbs" remove
if errorlevel 1 goto failed

echo.
echo   [OK] Auto start disabled. The dashboard will no longer start with Windows.
echo.
pause
exit /b 0

:failed
echo.
echo   [ERROR] Could not remove the startup shortcut. Delete it manually from:
echo           %%APPDATA%%\Microsoft\Windows\Start Menu\Programs\Startup
echo.
pause
exit /b 1
