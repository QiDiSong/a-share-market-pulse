@echo off
setlocal
title Market Pulse - Stop Public Access

echo.
echo   Stopping Cloudflare tunnel ...
taskkill /IM cloudflared.exe /F >nul 2>nul
echo   Tunnel stopped. Local dashboard is unaffected: http://127.0.0.1:8765
echo.
timeout /t 3 >nul
