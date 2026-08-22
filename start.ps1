$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $toolRoot

if (-not (Test-Path -LiteralPath (Join-Path $toolRoot "dist\server\main.js"))) {
  Write-Host "Build output was not found; running npm run build first." -ForegroundColor Yellow
  npm run build
}

$env:CODEX_PROMPTOR_ROOT = $toolRoot
$env:CODEX_PROMPTOR_OPEN = "1"
node (Join-Path $toolRoot "dist\server\main.js")
