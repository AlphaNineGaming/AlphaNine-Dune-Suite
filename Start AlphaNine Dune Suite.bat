@echo off
title AlphaNine Dune Suite
set "SUITE_DIR=%~dp0"
echo Starting AlphaNine Dune Suite from:
echo %SUITE_DIR%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SUITE_DIR%start-suite.ps1"
