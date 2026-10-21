@echo off
chcp 65001 >nul
title LLM Wiki Portable - Full Import
echo ============================================================
echo  LLM Wiki - one-click full import (1746 docs, qa-split)
echo  This will: deploy settings - inject tasks - start app
echo  Make sure the OLD LLM Wiki on this PC is CLOSED first.
echo ============================================================
echo.
"%~dp0runtime\python.exe" "%~dp0bin\run-full-import.py" --apply
echo.
pause
