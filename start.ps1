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

# The session tables under docs/ are generated, not tracked, so a fresh clone
# has none of them -- and nobody discovers a script they were never told about.
# Built once, when neither file is there yet; after that they are the reader's
# to refresh (or delete, which asks for them again).
$exportScript = Join-Path $toolRoot "scripts\export-agent-sessions.ps1"
$exportTargets = @(
  (Join-Path $toolRoot "docs\codex_sessions_exports.md"),
  (Join-Path $toolRoot "docs\claude_code_sessions_exports.md")
)
$haveExports = @($exportTargets | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
if ((Test-Path -LiteralPath $exportScript) -and -not $haveExports) {
  Write-Host "First run: listing your Codex and Claude Code conversations in the background..." -ForegroundColor Cyan
  # Detached rather than awaited: reading every rollout takes about ten seconds
  # on a machine with real history, and the app should not wait on a
  # convenience. Never fatal either -- a missing CLI history, a locked file or
  # an unreadable rollout is a reason to start without the tables, not a reason
  # not to start.
  try {
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$exportScript`""
    ) | Out-Null
  } catch { Write-Warning "Session export skipped: $($_.Exception.Message)" }
}

$env:CODEX_PROMPTOR_ROOT = $toolRoot
$env:CODEX_PROMPTOR_OPEN = "1"
node $serverEntry
