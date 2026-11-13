@echo off
setlocal
title Stop - Market Pulse Dashboard

echo.
echo   Looking for the dashboard service on port 8765 ...
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:8765 .*LISTENING"') do (
    echo   Stopping PID %%p
    taskkill /PID %%p /F >nul 2>nul
    set FOUND=1
)

if "%FOUND%"=="0" (
    echo   No process is listening on port 8765. It may already be stopped.
) else (
    echo.
    echo   Dashboard stopped.
)
echo.
timeout /t 3 >nul
