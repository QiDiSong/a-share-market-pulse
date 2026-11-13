@echo off
setlocal
cd /d "%~dp0"
title Market Pulse - A-Share Dashboard

where python >nul 2>nul
if not errorlevel 1 (
    python server.py --open
    if errorlevel 1 pause
    exit /b
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 server.py --open
    if errorlevel 1 pause
    exit /b
)

echo.
echo   Python was not found.
echo   Please install Python 3.9 or newer, then run this file again.
echo   Download: https://www.python.org/downloads/
echo.
pause
