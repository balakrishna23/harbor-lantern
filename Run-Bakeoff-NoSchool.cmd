@echo off
rem Bake-off variant: 50 new tier-1 nurses, WITHOUT sending the training institution (max 50 credits)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Bakeoff-Live.ps1" --confirmed=0 --tier1=50 --no-school --max-credits=50
