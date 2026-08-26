param(
  # Rebuild even when the existing output already looks current.
  [switch]$Force,
  # Launch whatever is in dist\ without checking whether sources moved on.
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $toolRoot

$serverEntry = Join-Path $toolRoot "dist\server\main.js"

# Newest write time under a set of paths, or $null when nothing exists there.
function Get-NewestWriteTime([string[]]$paths) {
  $newest = $null
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $item = Get-Item -LiteralPath $path
    $times = if ($item.PSIsContainer) {
      Get-ChildItem -LiteralPath $path -Recurse -File | Select-Object -ExpandProperty LastWriteTimeUtc
    } else {
      @($item.LastWriteTimeUtc)
    }
    foreach ($time in $times) {
      if ($null -eq $newest -or $time -gt $newest) { $newest = $time }
    }
  }
  return $newest
}

# Editing a source file and forgetting to rebuild silently serves the previous
# bundle, which reads as "my change did nothing". Compare timestamps instead of
# rebuilding every launch so an unchanged tree still starts immediately.
function Test-BuildIsStale {
  if (-not (Test-Path -LiteralPath $serverEntry)) { return $true }
  $sourceTime = Get-NewestWriteTime @(
    (Join-Path $toolRoot "src"),
    (Join-Path $toolRoot "config"),
    (Join-Path $toolRoot "package.json"),
    (Join-Path $toolRoot "package-lock.json")
  )
  $builtTime = Get-NewestWriteTime @((Join-Path $toolRoot "dist"))
  if ($null -eq $sourceTime -or $null -eq $builtTime) { return $true }
  return $sourceTime -gt $builtTime
}

if ($NoBuild) {
  if (-not (Test-Path -LiteralPath $serverEntry)) {
    throw "No build output at dist\server\main.js. Run .\start.ps1 without -NoBuild first."
  }
} elseif ($Force) {
  Write-Host "Rebuilding (forced)..." -ForegroundColor Cyan
  npm run build
} elseif (Test-BuildIsStale) {
  Write-Host "Sources changed since the last build; rebuilding..." -ForegroundColor Cyan
  npm run build
} else {
  Write-Host "Build output is current; skipping rebuild." -ForegroundColor DarkGray
}

$env:CODEX_PROMPTOR_ROOT = $toolRoot
$env:CODEX_PROMPTOR_OPEN = "1"
node $serverEntry
