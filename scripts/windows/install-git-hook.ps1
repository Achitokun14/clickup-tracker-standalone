# install-git-hook.ps1 — Windows wrapper for scripts/install-git-hook.sh.
#
# Requires: Git for Windows (provides bash.exe).
#
# Usage:
#   .\install-git-hook.ps1 -Repo C:\path\to\repo -ProjectId <uuid> -HookSecret <hex>
#   .\install-git-hook.ps1 -Repo . -ProjectId <uuid> -HookSecret <hex> -Base http://localhost:4020

param(
    [Parameter(Mandatory=$true)][string]$Repo,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$HookSecret,
    [string]$Base = "http://localhost:4020",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$bashCandidates = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
)
$bash = $bashCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) {
    Write-Host "✗ bash.exe not found. Install Git for Windows." -ForegroundColor Red
    exit 1
}

function ConvertTo-MsysPath([string]$p) {
    $resolved = (Resolve-Path -LiteralPath $p).Path
    $drive = $resolved.Substring(0, 1).ToLower()
    $rest = $resolved.Substring(2) -replace "\\", "/"
    "/$drive$rest"
}

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$installShRel = Join-Path $root "scripts\install-git-hook.sh"
$installSh = ConvertTo-MsysPath $installShRel
$repoMsys = ConvertTo-MsysPath $Repo

$bashArgs = @(
    $installSh,
    "--repo", $repoMsys,
    "--project-id", $ProjectId,
    "--hook-secret", $HookSecret,
    "--base", $Base
)
if ($Force) { $bashArgs += "--force" }

& $bash @bashArgs
exit $LASTEXITCODE
