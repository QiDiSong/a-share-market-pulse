@echo off
setlocal
cd /d "%~dp0"
title Market Pulse - Phone Access

echo.
echo   Starting the dashboard in LAN mode...
echo   Your phone must be on the same Wi-Fi / LAN as this computer.
echo   The window will print a "phone access" address - open it on your phone.
echo   If the phone cannot connect, allow python.exe through Windows Firewall (TCP 8765).
echo.

where python >nul 2>nul
if not errorlevel 1 (
    python server.py --lan --open
    if errorlevel 1 pause
    exit /b
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 server.py --lan --open
    if errorlevel 1 pause
    exit /b
)

echo.
echo   Python was not found.
echo   Please install Python 3.9 or newer, then run this file again.
echo   Download: https://www.python.org/downloads/
echo.
pause
