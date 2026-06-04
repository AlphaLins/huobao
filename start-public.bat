@echo off
setlocal

cd /d "%~dp0"

echo ========================================
echo Huobao Drama public sharing startup
echo ========================================
echo.
echo This will:
echo   1. Build the public frontend bundle
echo   2. Start the local production server on 5679
echo   3. Start ngrok for public access
echo.
echo Default login:
echo   Access password: huobao
echo   Admin username: admin
echo   Admin password: admin123
echo.
echo Close the opened server/ngrok windows with Ctrl+C when finished.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\build-public.ps1"
if errorlevel 1 (
  echo.
  echo Build failed. Press any key to exit.
  pause >nul
  exit /b 1
)

start "Huobao Public Server" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "Set-Location '%~dp0'; .\scripts\start-public.ps1"
timeout /t 5 /nobreak >nul
start "Huobao ngrok Tunnel" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "Set-Location '%~dp0'; .\scripts\start-ngrok.ps1"

echo.
echo Started.
echo.
echo In the ngrok window, copy the Forwarding HTTPS URL and send it to testers.
echo Example:
echo   https://xxxx.ngrok-free.dev
echo.
echo Press any key to close this launcher window. The server and ngrok windows will keep running.
pause >nul
