# self-setup.ps1 — convenience wrapper for Windows users.
# Delegates to ../../install.ps1 so there is exactly one installer entrypoint.

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$installer = Join-Path $root "install.ps1"
& $installer @args
exit $LASTEXITCODE
