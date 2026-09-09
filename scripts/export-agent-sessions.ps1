<#
.SYNOPSIS
  Lists every Codex and Claude Code conversation on this machine as two
  Markdown tables: where it ran, its session id, and the first few things the
  person actually typed.

.DESCRIPTION
  Both CLIs keep their history as JSONL, one record per line, and both mix the
  person's own prompts in with a great deal of machinery -- environment blocks,
  tool results, slash-command echoes, interruption notices. Reading a session
  id out of a directory listing tells you nothing about which conversation it
  was; the opening prompts do.

  Windows PowerShell 5.1 and nothing else: no modules, no npm, no Python.

  What counts as a prompt is not guessed. The wrapper markers filtered below
  were counted across this machine's own corpus (86 Codex rollouts, 28 Claude
  session files); each one is listed with what it turned out to be.

.PARAMETER PromptCount
  How many opening prompts to show per conversation. Default 3.

.PARAMETER MaxLength
  Characters kept per prompt before it is cut, because an agent instruction
  file pasted as a prompt runs to several kilobytes and turns the table into
  an unreadable wall. 0 keeps the whole thing.

.EXAMPLE
  .\scripts\export-agent-sessions.ps1

.EXAMPLE
  .\scripts\export-agent-sessions.ps1 -PromptCount 5 -MaxLength 0 -OutputDirectory D:\tmp
#>
[CmdletBinding()]
param(
  [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
  [string]$ClaudeHome = (Join-Path $env:USERPROFILE ".claude"),
  [string]$OutputDirectory = "",
  [int]$PromptCount = 3,
  [int]$MaxLength = 200
)

$ErrorActionPreference = "Stop"

# Resolved here rather than in the param block: `$PSScriptRoot` is not reliably
# populated while parameter defaults are being bound, and an empty default is a
# clearer failure than a path built from nothing.
if (-not $OutputDirectory) {
  $scriptDir = $PSScriptRoot
  if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $OutputDirectory = Join-Path (Split-Path -Parent $scriptDir) "docs"
}

# Codex writes some of its own turns with role "user": the sandbox
# description, the environment block, an aborted-turn notice, the plugin and
# skill catalogues. Counted across this machine's rollouts, these accounted for
# 371 of 1,920 user-role records -- enough to fill the first three columns of a
# table with text nobody typed.
$codexNoise = @(
  "<environment_context>",
  "<turn_aborted>",
  "<recommended_plugins>",
  "<skill>",
  "<user_shell_command>",
  "<permissions instructions>",
  "# AGENTS.md instructions for"
)

# Claude Code stores slash commands, their local output, the caveat that
# precedes them, and background task notifications as user records. 326 of
# 1,088 on this machine.
$claudeNoise = @(
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<task-notification>",
  "<system-reminder>",
  "[Request interrupted"
)

function Test-IsNoise([string]$text, [string[]]$markers) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $true }
  $head = $text.TrimStart()
  foreach ($marker in $markers) {
    if ($head.StartsWith($marker, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# One table cell: no newlines, no pipes, nothing that Markdown reads as markup.
function ConvertTo-Cell([string]$text, [int]$maxLength) {
  if ([string]::IsNullOrWhiteSpace($text)) { return "-" }
  $value = $text -replace "[\x00-\x1f]", " "
  $value = ($value -replace "\s{2,}", " ").Trim()
  if ($maxLength -gt 0 -and $value.Length -gt $maxLength) {
    $value = $value.Substring(0, $maxLength) + "…"
  }
  $value = $value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
  $value = $value.Replace("|", "&#124;").Replace("``", "&#96;")
  if ([string]::IsNullOrWhiteSpace($value)) { return "-" }
  return $value
}

# Streamed rather than read whole: a Claude session file runs to tens of
# thousands of records and only the opening handful are wanted.
#
# FileShare::ReadWrite because a conversation that is open right now has its
# rollout held by the CLI writing to it, and those are exactly the ones worth
# listing. The default share mode refuses them.
function Open-JsonLines([string]$path) {
  $stream = New-Object System.IO.FileStream(
    $path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite)
  return New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
}

function ConvertFrom-Line([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return $null }
  try { return $line | ConvertFrom-Json } catch { return $null }
}

# Codex content is an array of parts; only typed text is a prompt.
function Get-CodexText($content) {
  if ($null -eq $content) { return "" }
  $parts = @()
  foreach ($item in @($content)) {
    if ($null -ne $item.text -and $item.type -eq "input_text") { $parts += [string]$item.text }
  }
  return ($parts -join " ")
}

function Get-CodexSession([string]$path, [int]$want) {
  $sessionId = ""
  $cwd = ""
  $started = ""
  $events = New-Object System.Collections.ArrayList
  $items = New-Object System.Collections.ArrayList

  $reader = Open-JsonLines $path
  try {
  while ($null -ne ($line = $reader.ReadLine())) {
    # Cheap string tests before the expensive parse. Every rollout is mostly
    # reasoning and command output, none of which can be a prompt.
    $maybeMeta = $line.Contains('"session_meta"')
    $maybeEvent = $line.Contains('"user_message"')
    $maybeItem = $line.Contains('"role":"user"') -or $line.Contains('"role": "user"')
    if (-not ($maybeMeta -or $maybeEvent -or $maybeItem)) { continue }

    $record = ConvertFrom-Line $line
    if ($null -eq $record) { continue }
    $payload = $record.payload

    # The FIRST session_meta only. A rollout produced by `/resume` carries a
    # second one describing the conversation it continued, and taking the last
    # match made two different rollouts report the same id -- which is exactly
    # the confusion this table exists to remove.
    if ($record.type -eq "session_meta" -and $null -ne $payload) {
      if (-not $sessionId) {
        if ($payload.id) { $sessionId = [string]$payload.id }
        if ($payload.cwd) { $cwd = [string]$payload.cwd }
        if ($payload.timestamp) { $started = [string]$payload.timestamp }
      }
      continue
    }
    if ($null -eq $payload) { continue }

    # Newer Codex writes the person's own message as its own event, already
    # separated from everything it synthesises. Half the rollouts here predate
    # that, hence the fallback below.
    if ($record.type -eq "event_msg" -and $payload.type -eq "user_message") {
      $text = [string]$payload.message
      if (-not (Test-IsNoise $text $codexNoise)) { [void]$events.Add($text) }
      if ($events.Count -ge $want) { break }
      continue
    }
    if ($record.type -eq "response_item" -and $payload.type -eq "message" -and $payload.role -eq "user") {
      $text = Get-CodexText $payload.content
      if (-not (Test-IsNoise $text $codexNoise)) { [void]$items.Add($text) }
    }
  }
  } finally { $reader.Dispose() }

  $prompts = if ($events.Count -gt 0) { $events } else { $items }
  if ([string]::IsNullOrWhiteSpace($sessionId)) {
    # rollout-<timestamp>-<uuid>.jsonl
    $name = [System.IO.Path]::GetFileNameWithoutExtension($path)
    if ($name -match "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$") { $sessionId = $Matches[1] }
  }
  return [pscustomobject]@{
    Cwd = $cwd
    SessionId = $sessionId
    Started = $started
    Prompts = @($prompts | Select-Object -First $want)
    Updated = (Get-Item -LiteralPath $path).LastWriteTime
  }
}

# Claude content is either a plain string or an array in which only `text`
# parts are the person; `tool_result` parts are what the tools said back.
function Get-ClaudeText($content) {
  if ($content -is [string]) { return $content }
  if ($null -eq $content) { return "" }
  $parts = @()
  foreach ($item in @($content)) {
    if ($item -is [string]) { $parts += $item; continue }
    if ($null -ne $item.text -and $item.type -eq "text") { $parts += [string]$item.text }
  }
  return ($parts -join " ")
}

function Get-ClaudeSession([string]$path, [int]$want) {
  $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($path)
  $cwd = ""
  $started = ""
  $prompts = New-Object System.Collections.ArrayList

  $reader = Open-JsonLines $path
  try {
  while ($null -ne ($line = $reader.ReadLine())) {
    if (-not ($line.Contains('"type":"user"') -or $line.Contains('"type": "user"'))) { continue }
    $record = ConvertFrom-Line $line
    if ($null -eq $record -or $record.type -ne "user") { continue }
    if ($record.cwd -and -not $cwd) { $cwd = [string]$record.cwd }
    if ($record.sessionId) { $sessionId = [string]$record.sessionId }
    if ($record.timestamp -and -not $started) { $started = [string]$record.timestamp }
    # A meta record is context Claude Code inserted; a sidechain is a subagent
    # talking to itself, not this conversation.
    if ($record.isMeta -eq $true -or $record.isSidechain -eq $true) { continue }
    $text = Get-ClaudeText $record.message.content
    if (Test-IsNoise $text $claudeNoise) { continue }
    [void]$prompts.Add($text)
    if ($prompts.Count -ge $want) { break }
  }
  } finally { $reader.Dispose() }

  if (-not $cwd) {
    # The project folder is the working directory with separators flattened.
    # Recoverable only as a hint, so it is marked rather than guessed at.
    $cwd = (Split-Path -Leaf (Split-Path -Parent $path)) + "（由目录名推断）"
  }
  return [pscustomobject]@{
    Cwd = $cwd
    SessionId = $sessionId
    Started = $started
    Prompts = @($prompts)
    Updated = (Get-Item -LiteralPath $path).LastWriteTime
  }
}

function Write-Report {
  param(
    [string]$Path,
    [string]$Title,
    [string]$Source,
    [string[]]$Notes,
    [object[]]$Sessions,
    [int]$Want,
    [int]$Limit,
    [int]$Skipped
  )
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add("# $Title")
  [void]$lines.Add("")
  [void]$lines.Add("- 来源：``$Source``")
  [void]$lines.Add("- 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')（由 ``scripts/export-agent-sessions.ps1`` 生成，可随时重跑覆盖）")
  [void]$lines.Add("- 会话数：$($Sessions.Count)；跳过 $Skipped 个没有任何用户 prompt 的空会话")
  foreach ($note in $Notes) { [void]$lines.Add("- $note") }
  [void]$lines.Add("")

  $header = "| 序号 | 最近活动 | 对话所在路径 | Session ID"
  $divider = "|---:|---|---|---"
  for ($i = 1; $i -le $Want; $i++) {
    $header += " | Prompt $i"
    $divider += "|---"
  }
  [void]$lines.Add("$header |")
  [void]$lines.Add("$divider|")

  $index = 0
  foreach ($session in $Sessions) {
    $index++
    $row = "| $index | $($session.Updated.ToString('yyyy-MM-dd')) | $(ConvertTo-Cell $session.Cwd 0) | ``$($session.SessionId)``"
    for ($i = 0; $i -lt $Want; $i++) {
      $prompt = ""
      if ($i -lt $session.Prompts.Count) { $prompt = [string]$session.Prompts[$i] }
      $row += " | " + (ConvertTo-Cell $prompt $Limit)
    }
    [void]$lines.Add("$row |")
  }

  $text = ($lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  -> $Path  ($($Sessions.Count) 个会话)" -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $OutputDirectory)) {
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
}

# --- Codex ---------------------------------------------------------------
$codexSessionRoot = Join-Path $CodexHome "sessions"
if (Test-Path -LiteralPath $codexSessionRoot) {
  Write-Host "读取 Codex 会话：$codexSessionRoot" -ForegroundColor Cyan
  $codexFiles = @(Get-ChildItem -LiteralPath $codexSessionRoot -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue)
  $codexSessions = New-Object System.Collections.ArrayList
  $codexSkipped = 0
  foreach ($file in $codexFiles) {
    try { $session = Get-CodexSession $file.FullName $PromptCount }
    catch { Write-Warning "跳过 $($file.Name)：$($_.Exception.Message)"; continue }
    # A Codex thread that was opened and never prompted writes a rollout with
    # nothing in it. Listing those would be listing conversations that never
    # happened.
    if ($session.Prompts.Count -eq 0) { $codexSkipped++; continue }
    [void]$codexSessions.Add($session)
  }
  $ordered = @($codexSessions | Sort-Object Cwd, Updated)
  Write-Report -Path (Join-Path $OutputDirectory "codex_sessions_exports.md") `
    -Title "Codex 会话导出" -Source $CodexHome -Sessions $ordered `
    -Want $PromptCount -Limit $MaxLength -Skipped $codexSkipped `
    -Notes @(
      "规则：优先读取 ``event_msg/user_message``（Codex 自己标记出的用户输入）；旧版本 rollout 没有这类事件，回退到 ``response_item`` 中 ``role: user`` 的输入文本。",
      "Session ID 取该 rollout 自己的那一个：``/resume`` 产生的 rollout 里还会带一份被续接会话的 meta，这里忽略它。",
      "过滤：$($codexNoise -join '、') 等 Codex 自己合成的 user 消息。",
      "单元格内换行压缩为空格，``|`` ``<`` ``>`` 已转义；超过 $MaxLength 字的 prompt 会截断（``-MaxLength 0`` 可关闭）。"
    )
} else {
  Write-Warning "找不到 $codexSessionRoot，跳过 Codex。"
}

# --- Claude Code ---------------------------------------------------------
$claudeProjectRoot = Join-Path $ClaudeHome "projects"
if (Test-Path -LiteralPath $claudeProjectRoot) {
  Write-Host "读取 Claude Code 会话：$claudeProjectRoot" -ForegroundColor Cyan
  # `<project>/<session>/subagents/**` holds what subagents said to themselves.
  # They are not conversations anybody had, and there are more of them than
  # there are conversations -- 97 against 24 on this machine.
  $allClaudeFiles = @(Get-ChildItem -LiteralPath $claudeProjectRoot -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue)
  $claudeFiles = @($allClaudeFiles | Where-Object { $_.FullName -notlike "*\subagents\*" })
  $subagentCount = $allClaudeFiles.Count - $claudeFiles.Count
  $claudeSessions = New-Object System.Collections.ArrayList
  $claudeSkipped = 0
  foreach ($file in $claudeFiles) {
    try { $session = Get-ClaudeSession $file.FullName $PromptCount }
    catch { Write-Warning "跳过 $($file.Name)：$($_.Exception.Message)"; continue }
    if ($session.Prompts.Count -eq 0) { $claudeSkipped++; continue }
    [void]$claudeSessions.Add($session)
  }
  $ordered = @($claudeSessions | Sort-Object Cwd, Updated)
  Write-Report -Path (Join-Path $OutputDirectory "claude_code_sessions_exports.md") `
    -Title "Claude Code 会话导出" -Source $claudeProjectRoot -Sessions $ordered `
    -Want $PromptCount -Limit $MaxLength -Skipped $claudeSkipped `
    -Notes @(
      "规则：只取 ``type: user`` 记录中真正的文本内容；``tool_result`` 是工具回话，不是 prompt。",
      "已排除 $subagentCount 个 ``subagents/`` 下的子代理 transcript——那不是任何人开过的对话。",
      "过滤：``isMeta``、``isSidechain``（子代理自言自语），以及 $($claudeNoise -join '、') 开头的记录。",
      "单元格内换行压缩为空格，``|`` ``<`` ``>`` 已转义；超过 $MaxLength 字的 prompt 会截断（``-MaxLength 0`` 可关闭）。"
    )
} else {
  Write-Warning "找不到 $claudeProjectRoot，跳过 Claude Code。"
}

Write-Host "完成。" -ForegroundColor Green
