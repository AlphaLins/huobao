@echo off
setlocal

cd /d "%~dp0"

REM Copy this file to start-public-custom.bat and change the values below.
set PUBLIC_ACCESS_PASSWORD=change-this-access-code
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD=change-this-admin-password

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\build-public.ps1"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

start "Huobao Public Server" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "Set-Location '%~dp0'; .\scripts\start-public.ps1 -PublicAccessPassword '%PUBLIC_ACCESS_PASSWORD%' -AdminUsername '%ADMIN_USERNAME%' -AdminPassword '%ADMIN_PASSWORD%'"
timeout /t 5 /nobreak >nul
start "Huobao ngrok Tunnel" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "Set-Location '%~dp0'; .\scripts\start-ngrok.ps1"

echo Public server and ngrok started.
echo Copy the Forwarding HTTPS URL from the ngrok window.
pause
