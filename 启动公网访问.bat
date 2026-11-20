@echo off
setlocal
cd /d "%~dp0"
title Market Pulse - Public Access

echo.
echo   Starting Cloudflare tunnel for the dashboard ...
echo   This may take ~15 seconds. The public URL will be written to 公网地址.txt
echo.

start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1"

timeout /t 18 >nul
if exist "%~dp0公网地址.txt" (
    echo   Current public address:
    echo.
    type "%~dp0公网地址.txt"
) else (
    echo   URL file not ready yet, open 公网地址.txt in a few seconds.
)
echo.
pause
