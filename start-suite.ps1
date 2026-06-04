$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverFile = Join-Path $scriptDir "server.js"
$bundledNode = "C:\Users\Khader\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$node = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`""
    )
    exit
}

if (-not $node) {
    Write-Host "Node.js was not found. Install Node.js 18 or newer, then try again." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Starting AlphaNine Dune Suite..." -ForegroundColor Cyan
Write-Host "Open: http://127.0.0.1:8810" -ForegroundColor Green
Write-Host "Keep this window open while using the suite." -ForegroundColor Yellow

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-Command",
    "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8810'"
)

& $node $serverFile
