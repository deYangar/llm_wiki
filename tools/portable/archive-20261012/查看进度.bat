@echo off
chcp 65001 >nul
title LLM Wiki Portable - Status
"%~dp0runtime\python.exe" "%~dp0bin\run-full-import.py" status
echo.
pause
