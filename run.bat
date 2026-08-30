@echo off
title Gemini Spark MCP Manager
cd /d "%~dp0"
echo Starting Gemini Spark MCP Manager...
python main.py
if errorlevel 1 (
    echo.
    echo Press any key to exit...
    pause > nul
)
