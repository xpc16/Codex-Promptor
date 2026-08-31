$ErrorActionPreference = "Stop"

try {
  $encoded = $env:CODEX_PROMPTOR_AGENT_SPEC_BASE64
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    throw "CODEX_PROMPTOR_AGENT_SPEC_MISSING"
  }

  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $spec = $json | ConvertFrom-Json
  $env:NO_COLOR = "1"
  Set-Location -LiteralPath ([string]$spec.cwd)
  if ([string]$spec.theme -eq "dark") {
    $Host.UI.RawUI.ForegroundColor = "Gray"
    $Host.UI.RawUI.BackgroundColor = "Black"
    $ansi = "37;40"
  } else {
    $Host.UI.RawUI.ForegroundColor = "Black"
    $Host.UI.RawUI.BackgroundColor = "White"
    $ansi = "30;47"
  }
  $escape = [char]27
  Write-Host -NoNewline "$escape[$ansi`m"
  Clear-Host

  # PowerShell 5.1 cannot preserve quotes embedded in native argv (the Codex
  # hook TOML contains many). Node performs the exact argv launch while
  # inheriting this PowerShell's ConPTY input/output handles.
  $nodeLauncher = Join-Path $PSScriptRoot "launch-agent.mjs"
  & ([string]$spec.nodePath) $nodeLauncher
  $agentOk = $?
  $agentExit = $LASTEXITCODE
  if ($null -eq $agentExit) {
    if ($agentOk) { $agentExit = 0 } else { $agentExit = 1 }
  }
} catch {
  Write-Error $_
  $agentExit = 1
} finally {
  $exitMarker = if ($null -ne $spec) { [string]$spec.exitMarker } else { "__CODEX_PROMPTOR_AGENT_EXIT__:" }
  Write-Output "$exitMarker$agentExit"
  Remove-Item Env:CODEX_PROMPTOR_AGENT_SPEC_BASE64 -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_PROMPTOR_HOOK_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_PROMPTOR_CODEX_HOOK_URL -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_PROMPTOR_CLAUDE_HOOK_URL -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_PROMPTOR_CURSOR_HOOK_URL -ErrorAction SilentlyContinue
}
