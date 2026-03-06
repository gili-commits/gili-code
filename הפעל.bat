@echo off
chcp 65001 > nul
echo.
echo  ============================================
echo   ACT - מלווה נפשי אישי
echo  ============================================
echo.
echo  מתקין תלויות (npm install)...
call npm install
echo.
echo  מפעיל שרת...
echo  פתח בדפדפן: http://localhost:3000
echo.
node server.js
pause
