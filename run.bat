@echo off
title ChatGPT MCP Manager
cd /d "%~dp0"
echo Starting ChatGPT MCP Manager...
python main.py
if errorlevel 1 (
    echo.
    echo Press any key to exit...
    pause > nul
)
