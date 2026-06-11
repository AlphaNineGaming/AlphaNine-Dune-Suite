$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$stopScript = Join-Path $scriptDir "stop-suite.ps1"

if (-not (Test-Path $stopScript)) {
    Write-Host "Could not find stop-suite.ps1 next to this script." -ForegroundColor Red
    exit 1
}

& $stopScript
