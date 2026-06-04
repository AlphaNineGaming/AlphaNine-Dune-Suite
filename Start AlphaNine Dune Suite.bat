@echo off
set "SUITE_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SUITE_DIR%start-suite.ps1"
