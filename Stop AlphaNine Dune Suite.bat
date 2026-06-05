@echo off
title Stop AlphaNine Dune Suite
set "SUITE_DIR=%~dp0"
echo Stopping AlphaNine Dune Suite from:
echo %SUITE_DIR%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SUITE_DIR%stop-suite.ps1"
echo.
pause
