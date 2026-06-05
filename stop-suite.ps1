$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`""
    )
    exit
}

function Import-EnvFile {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [switch]$Override
    )
    if (-not (Test-Path $Path)) { return }
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

function Stop-ByCommandNeedle {
    param([string]$Needle, [string]$Label)
    $escaped = $Needle.Replace("\", "\\")
    $matches = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Needle*" }
    if (-not $matches) {
        Write-Host "$Label is not running." -ForegroundColor DarkYellow
        return
    }
    foreach ($proc in $matches) {
        try {
            Stop-Process -Id $proc.ProcessId -Force
            Write-Host "Stopped $Label process $($proc.ProcessId)." -ForegroundColor Green
        } catch {
            Write-Host "Could not stop $Label process $($proc.ProcessId): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

function Stop-ByPort {
    param([int]$Port, [string]$Label)
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        try {
            Stop-Process -Id $listener.OwningProcess -Force
            Write-Host "Stopped $Label listener on port $Port (process $($listener.OwningProcess))." -ForegroundColor Green
        } catch {
            Write-Host "Could not stop $Label listener on port $Port (process $($listener.OwningProcess)): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Import-EnvFile (Join-Path $scriptDir ".env")
Import-EnvFile (Join-Path $scriptDir ".env.local") -Override

$suitePort = [int](Get-EnvValue "PORT" "8810")
$receiverPort = [int](Get-EnvValue "DUNE_RECEIVER_PORT" "5055")

Write-Host "Stopping AlphaNine Dune Suite..." -ForegroundColor Cyan
Stop-ByCommandNeedle (Join-Path $scriptDir "server.js") "Dune Suite"
Stop-ByCommandNeedle (Join-Path $scriptDir "receivers\dune-live-give-receiver.js") "give-item receiver"
Stop-ByPort $suitePort "Dune Suite"
Stop-ByPort $receiverPort "give-item receiver"
Write-Host "Stop command finished." -ForegroundColor Cyan
