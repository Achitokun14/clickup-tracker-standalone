# install.ps1 — Windows PowerShell wrapper that delegates to install.sh.
#
# Requires: Git for Windows (provides bash.exe), Docker Desktop, Node.js LTS.
# Run from PowerShell as a regular user (no admin needed unless Docker requires it).
#
# Usage:
#   .\install.ps1
#   .\install.ps1 -Agent claude-code
#   .\install.ps1 -Agent all -SkipDocker

param(
    [string]$Agent = "",
    [switch]$SkipDocker,
    [switch]$SkipMcp,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

# Locate bash.exe (Git for Windows)
$bashCandidates = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
)
$bash = $bashCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) {
    $bash = (Get-Command bash -ErrorAction SilentlyContinue)?.Path
}
if (-not $bash) {
    Write-Host "✗ bash.exe not found. Install Git for Windows from https://git-scm.com/download/win" -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installSh = Join-Path $scriptDir "install.sh"

# Translate Windows path to MSYS path: C:\foo\bar -> /c/foo/bar
function ConvertTo-MsysPath([string]$p) {
    $drive = $p.Substring(0, 1).ToLower()
    $rest = $p.Substring(2) -replace "\\", "/"
    "/$drive$rest"
}
$msysScript = ConvertTo-MsysPath $installSh

# Build args
$bashArgs = @($msysScript)
if ($Agent)          { $bashArgs += "--agent"; $bashArgs += $Agent }
if ($SkipDocker)     { $bashArgs += "--skip-docker" }
if ($SkipMcp)        { $bashArgs += "--skip-mcp" }
if ($NonInteractive) { $bashArgs += "--noninteractive" }

Write-Host "→ delegating to $bash $msysScript $($bashArgs -join ' ')" -ForegroundColor Cyan
& $bash @bashArgs
exit $LASTEXITCODE
