@echo off
chcp 65001 >nul
title Huobao - Kill Dev Ports

echo ========================================
echo   Huobao dev port cleanup
echo   Ports: 5679, 3013, 3000
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-dev-ports.ps1"

echo.
echo Press any key to close this window.
pause >nul
