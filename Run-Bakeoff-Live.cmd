@echo off
rem Double-click to run the People Data Labs bake-off (dry run, then live, up to 100 credits)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Bakeoff-Live.ps1"
