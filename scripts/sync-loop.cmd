@echo off
:loop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ullap\Documents\Arbeit\Schach\Website\scripts\sync-once.ps1"
timeout /t 10 /nobreak >nul
goto loop
