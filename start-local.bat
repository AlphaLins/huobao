@echo off
setlocal

cd /d "%~dp0"

echo ========================================
echo Huobao Drama local development startup
echo ========================================
echo.
echo This starts the local-only version:
echo   Frontend: http://localhost:3013
echo   Backend:  http://localhost:5679
echo.
echo It does not start ngrok and is not public.
echo Close the opened windows with Ctrl+C when finished.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports=@(3013,5679); foreach($p in $ports){ Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop; Write-Host \"Stopped process on port $p\" } catch {} } }"

start "Huobao Backend 5679" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command ". '%~dp0scripts\use-system-proxy.ps1'; Set-Location '%~dp0backend'; npm run dev"
timeout /t 3 /nobreak >nul
start "Huobao Frontend 3013" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "Set-Location '%~dp0frontend'; npm run dev"

echo.
echo Started local development servers.
echo Open:
echo   http://localhost:3013
echo.
echo Press any key to close this launcher window. The server windows will keep running.
pause >nul
