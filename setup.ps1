$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $toolRoot

function Assert-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Command '$name' was not found. Install it and add it to PATH."
  }
}

Assert-Command node
Assert-Command npm
Assert-Command codex

$nodeMajor = [int]((node --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22 -or $nodeMajor -ge 25) {
  throw "Node.js 22-24 is required. Current version: $(node --version)."
}

$codexVersion = (codex --version).Trim()
if ($codexVersion -ne "codex-cli 0.147.0") {
  throw "codex-cli 0.147.0 is required. Current version: '$codexVersion'."
}

Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
npm ci

Write-Host "Creating data directories..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $toolRoot "data\tabs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $toolRoot "data\backups") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $toolRoot "data\trash") | Out-Null

Write-Host "Running typecheck and production build..." -ForegroundColor Cyan
npm run typecheck
npm run build

Write-Host "Setup complete. Run .\start.ps1 to launch the tool." -ForegroundColor Green
