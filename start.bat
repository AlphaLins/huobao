@echo off
cd /d G:\anime\huobao\backend
echo [1/2] Starting backend on port 5679...
start "HuobaoBackend" cmd /k "npm run dev"

timeout /t 2 /nobreak

cd /d G:\anime\huobao\frontend
echo [2/2] Starting frontend on port 3013...
start "HuobaoFrontend" cmd /k "npm run dev"

cd /d G:\anime\huobao

echo.
echo ========================================
echo   Huobao Drama Started!
echo   Backend: http://localhost:5679
echo   Frontend: http://localhost:3013
echo ========================================
echo.
pause
