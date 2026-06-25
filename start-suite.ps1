$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverFile = Join-Path $scriptDir "server.js"
$receiverFile = Join-Path $scriptDir "receivers\dune-live-give-receiver.js"
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

function Import-EnvFile {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [switch]$Override
    )
    if (-not (Test-Path $Path)) { return }
    Write-Host "Loading $(Split-Path -Leaf $Path)..." -ForegroundColor DarkCyan
    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
        $name = $matches[1]
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($Override -or -not [Environment]::GetEnvironmentVariable($name, "Process")) {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

function Get-EnvValue {
    param([string]$Name, [string]$Default = "")
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

function Test-HttpOk {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Get-ListenerProcess {
    param([int]$Port)
    return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

Import-EnvFile (Join-Path $scriptDir ".env")
Import-EnvFile (Join-Path $scriptDir ".env.local") -Override

$receiverHost = Get-EnvValue "DUNE_RECEIVER_HOST" "127.0.0.1"
$receiverPort = [int](Get-EnvValue "DUNE_RECEIVER_PORT" "5055")
$receiverHealthUrl = "http://$receiverHost`:$receiverPort/health"
$receiverGiveUrl = "http://$receiverHost`:$receiverPort/api/give-item"

if (-not (Get-EnvValue "DUNE_RECEIVER_SSH_HOST")) {
    Write-Host "Missing DUNE_RECEIVER_SSH_HOST in .env or .env.local. Receiver startup stopped." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

if (-not (Test-Path $receiverFile)) {
    Write-Host "Give-item receiver was not found: $receiverFile" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

[Environment]::SetEnvironmentVariable("DUNE_ADMIN_GIVE_ITEM_TRANSPORT", (Get-EnvValue "DUNE_ADMIN_GIVE_ITEM_TRANSPORT" "http-json"), "Process")
[Environment]::SetEnvironmentVariable("DUNE_ADMIN_GIVE_ITEM_URL", (Get-EnvValue "DUNE_ADMIN_GIVE_ITEM_URL" $receiverGiveUrl), "Process")
[Environment]::SetEnvironmentVariable("DUNE_ADMIN_GIVE_ITEM_HEALTH_URL", (Get-EnvValue "DUNE_ADMIN_GIVE_ITEM_HEALTH_URL" $receiverHealthUrl), "Process")
if (-not (Get-EnvValue "DUNE_ADMIN_GIVE_ITEM_TOKEN") -and (Get-EnvValue "DUNE_RECEIVER_TOKEN")) {
    [Environment]::SetEnvironmentVariable("DUNE_ADMIN_GIVE_ITEM_TOKEN", (Get-EnvValue "DUNE_RECEIVER_TOKEN"), "Process")
}

Write-Host "Checking give-item receiver at $receiverHealthUrl..." -ForegroundColor Cyan
if (Test-HttpOk $receiverHealthUrl) {
    Write-Host "Give-item receiver is already running. No duplicate started." -ForegroundColor Green
} else {
    $listener = Get-ListenerProcess $receiverPort
    if ($listener) {
        Write-Host "Port $receiverPort is already in use, but the receiver health check failed." -ForegroundColor Red
        Write-Host "Stop the process on port $receiverPort or run Stop AlphaNine Dune Suite.bat, then try again." -ForegroundColor Yellow
        Read-Host "Press Enter to close"
        exit 1
    }

    Write-Host "Starting give-item receiver in a separate window..." -ForegroundColor Cyan
    Start-Process powershell.exe -WorkingDirectory $scriptDir -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-NoExit",
        "-Command", "`"$node`" `"$receiverFile`""
    )

    $ready = $false
    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-HttpOk $receiverHealthUrl) {
            $ready = $true
            break
        }
        Write-Host "Waiting for receiver health... $i/30" -ForegroundColor DarkYellow
    }
    if (-not $ready) {
        Write-Host "Give-item receiver did not become healthy at $receiverHealthUrl." -ForegroundColor Red
        Read-Host "Press Enter to close"
        exit 1
    }
    Write-Host "Give-item receiver is healthy." -ForegroundColor Green
}

Write-Host "Starting AlphaNine Dune Suite..." -ForegroundColor Cyan
Write-Host "Open: http://127.0.0.1:8810" -ForegroundColor Green
Write-Host "Live give-item: $([Environment]::GetEnvironmentVariable("DUNE_ADMIN_GIVE_ITEM_TRANSPORT", "Process")) -> $([Environment]::GetEnvironmentVariable("DUNE_ADMIN_GIVE_ITEM_URL", "Process"))" -ForegroundColor Green
Write-Host "Keep this window open while using the suite." -ForegroundColor Yellow

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-Command",
    "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8810'"
)

& $node $serverFile
