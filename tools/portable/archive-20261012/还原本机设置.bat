@echo off
chcp 65001 >nul
title LLM Wiki Portable - Restore Settings
echo Restoring this PC's original app-state.json (quit LLM Wiki first)...
"%~dp0runtime\python.exe" "%~dp0bin\run-full-import.py" restore
echo.
pause
