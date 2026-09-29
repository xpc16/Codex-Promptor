#requires -Version 5.1
<#
.SYNOPSIS
  Install or operate a local Cloudflared health watchdog (Windows PowerShell 5.1).
.DESCRIPTION
  Independent of Promptor. Check only polls loopback, never a public application URL.
  Install/Update/Restore require an elevated PowerShell. Status is read-only.
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Check', 'Status', 'Update', 'Restore')]
    [string]$Mode = 'Status',
    [string]$InstallDirectory = "$env:ProgramData\cloudflared\maintenance",
    [string]$Executable = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
)

$ErrorActionPreference = 'Stop'
$taskName = 'Cloudflared Health Watchdog'
$serviceName = 'Cloudflared'
$readyUrl = 'http://127.0.0.1:20241/ready'

function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this operation from an administrator PowerShell.'
    }
}

function Invoke-NativeChecked {
    param([string]$File, [string[]]$Arguments)
    $output = & $File @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$File failed ($LASTEXITCODE): $output" }
}

function Read-JsonFile {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
}

function Write-JsonFile {
    param([string]$Path, $Value)
    $temporary = "$Path.tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
}

function Write-MaintenanceLog {
    param([string]$Message)
    $path = Join-Path $InstallDirectory 'watchdog.log'
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -ge 256KB) {
        [IO.File]::Copy($path, "$path.1", $true)
        [IO.File]::WriteAllText($path, '')
    }
    [IO.File]::AppendAllText($path, ("{0:o} {1}`r`n" -f [datetime]::UtcNow, $Message))
}

function Get-ServiceCommand {
    param([string]$Command)
    if ($Command -notmatch '^\s*(?:"(?<exe>[^"]+\.exe)"|(?<exe>\S+\.exe))\s+(?<args>.+)$') {
        throw 'Cannot parse the Cloudflared service executable path.'
    }
    [pscustomobject]@{ Executable = $Matches.exe; Arguments = $Matches.args }
}

function Get-MonitoredCommand {
    param([string]$Command, [string]$Binary, [string]$Logs)
    $parts = Get-ServiceCommand $Command
    # Preserve token-file, config, protocol and all other existing arguments.
    $arguments = $parts.Arguments -replace '(?i)\s+--(?:metrics|log-directory|logfile|loglevel)(?:=|\s+)(?:"[^"]*"|\S+)', ''
    if ($arguments -notmatch '^tunnel\s') { throw 'Expected a cloudflared tunnel service.' }
    $arguments = 'tunnel --metrics 127.0.0.1:20241 --loglevel info --log-directory "' + $Logs + '"' + $arguments.Substring(6)
    '"' + $Binary + '" ' + $arguments
}

function Get-TunnelReadiness {
    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create($readyUrl)
        $request.Proxy = $null
        $request.Timeout = 5000
        $request.ReadWriteTimeout = 5000
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        $count = [int]$body.readyConnections
        [pscustomobject]@{ Ready = ([int]$response.StatusCode -eq 200 -and $count -gt 0); Connections = $count; Error = $null }
    } catch {
        if ($_.Exception.Response) { $_.Exception.Response.Close() }
        [pscustomobject]@{ Ready = $false; Connections = 0; Error = $_.Exception.Message }
    } finally {
        if ($response) { $response.Close() }
    }
}

function Get-NextHealthState {
    param($Previous, [datetime]$Now, [bool]$Ready, [int]$Connections, [string]$ServiceStatus, [int]$ServiceProcessId)
    # Missing/corrupt state gives a full cooldown, rather than risking a restart loop.
    if (-not $Previous) {
        $Previous = [pscustomobject]@{
            Failures = 0; LastCheckUtc = $Now.ToString('o'); LastRestartUtc = $Now.ToString('o')
            ProcessId = $ServiceProcessId; GraceUntilUtc = $Now.AddSeconds(120).ToString('o')
        }
    }
    $lastCheck = [datetime]::Parse($Previous.LastCheckUtc).ToUniversalTime()
    $lastRestart = [datetime]::Parse($Previous.LastRestartUtc).ToUniversalTime()
    $grace = [datetime]::Parse($Previous.GraceUntilUtc).ToUniversalTime()
    $failures = [int]$Previous.Failures
    if (($Now - $lastCheck).TotalSeconds -gt 150 -or $Now -lt $lastCheck) { $failures = 0 }
    if ($ServiceProcessId -gt 0 -and $ServiceProcessId -ne $Previous.ProcessId) {
        $grace = $Now.AddSeconds(120)
        $failures = 0
    }
    $status = 'unavailable'
    $restart = $false
    if ($Ready -and $ServiceStatus -eq 'Running') {
        $failures = 0
        $status = if ($Connections -lt 4) { 'degraded' } else { 'ready' }
    } elseif ($ServiceStatus -in @('Start Pending', 'Stop Pending', 'StartPending', 'StopPending') -or $Now -lt $grace) {
        $failures = 0
        $status = 'starting'
    } else {
        $failures = [Math]::Min(3, $failures + 1)
        if ($failures -ge 3 -and ($Now - $lastRestart).TotalSeconds -ge 300) {
            $restart = $true
            $lastRestart = $Now
            $grace = $Now.AddSeconds(120)
            $failures = 0
            $status = 'recovering'
        }
    }
    [pscustomobject]@{
        Restart = $restart
        State = [pscustomobject]@{
            Status = $status; Connections = $Connections; Failures = $failures
            LastCheckUtc = $Now.ToString('o'); LastRestartUtc = $lastRestart.ToString('o')
            GraceUntilUtc = $grace.ToString('o'); ProcessId = $ServiceProcessId
        }
    }
}

function Restart-TunnelService {
    $controller = Get-Service -Name $serviceName
    if ($controller.Status -ne 'Stopped') {
        $controller.Stop()
        $controller.WaitForStatus('Stopped', [timespan]::FromSeconds(40))
    }
    $controller.Start()
    $controller.WaitForStatus('Running', [timespan]::FromSeconds(15))
}

function Invoke-HealthCheck {
    $statePath = Join-Path $InstallDirectory 'state.json'
    $previous = $null
    try {
        $previous = Read-JsonFile $statePath
        if ($previous) {
            foreach ($field in @('LastCheckUtc', 'LastRestartUtc', 'GraceUntilUtc')) {
                [void][datetime]::Parse($previous.$field)
            }
        }
    } catch {
        $previous = $null
        Write-MaintenanceLog 'State was unreadable; starting with a recovery cooldown.'
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if (-not $service -or $service.StartMode -eq 'Disabled') { return }
    $probe = if ($service.State -eq 'Running') { Get-TunnelReadiness } else {
        [pscustomobject]@{ Ready = $false; Connections = 0; Error = "Service state: $($service.State)" }
    }
    $next = Get-NextHealthState $previous ([datetime]::UtcNow) $probe.Ready $probe.Connections $service.State $service.ProcessId
    # Save the restart timestamp BEFORE attempting recovery, including when recovery fails.
    Write-JsonFile $statePath $next.State
    if (-not $previous -or $previous.Status -ne $next.State.Status -or $previous.Connections -ne $next.State.Connections) {
        Write-MaintenanceLog "Status=$($next.State.Status) connections=$($probe.Connections) service=$($service.State) $($probe.Error)"
    }
    if ($next.Restart) {
        Write-MaintenanceLog 'Three failed checks; restarting Cloudflared only (cooldown 300 seconds).'
        Restart-TunnelService
        Write-MaintenanceLog 'Service started; waiting for Cloudflare readiness.'
    }
    $next.State
}

function Get-PowerBackup {
    $schemeText = (& powercfg.exe /getactivescheme) -join ' '
    if ($schemeText -notmatch '[a-fA-F0-9-]{36}') { throw 'Cannot determine the active power scheme.' }
    $scheme = $Matches[0]
    $settings = foreach ($setting in @('STANDBYIDLE', 'HIBERNATEIDLE')) {
        $query = (& powercfg.exe /query $scheme SUB_SLEEP $setting) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "Cannot read power setting $setting" }
        $values = [regex]::Matches($query, '0x([a-fA-F0-9]+)')
        if ($values.Count -lt 2) { throw "Cannot parse power setting $setting" }
        [pscustomobject]@{ Name = $setting; AC = [Convert]::ToInt32($values[$values.Count-2].Groups[1].Value,16); DC = [Convert]::ToInt32($values[$values.Count-1].Groups[1].Value,16) }
    }
    [pscustomobject]@{ Scheme = $scheme; Settings = @($settings) }
}

function Set-AlwaysOnPower {
    param($Power, [switch]$Restore)
    foreach ($setting in $Power.Settings) {
        $ac = if ($Restore) { $setting.AC } else { 0 }
        $dc = if ($Restore) { $setting.DC } else { 0 }
        Invoke-NativeChecked powercfg.exe @('/setacvalueindex', $Power.Scheme, 'SUB_SLEEP', $setting.Name, "$ac")
        Invoke-NativeChecked powercfg.exe @('/setdcvalueindex', $Power.Scheme, 'SUB_SLEEP', $setting.Name, "$dc")
    }
    Invoke-NativeChecked powercfg.exe @('/setactive', $Power.Scheme)
}

function Protect-InstallDirectory {
    if (Test-Path -LiteralPath $InstallDirectory) {
        if ((Get-Item -LiteralPath $InstallDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Install directory must not be a reparse point.' }
    } else { New-Item -ItemType Directory -Path $InstallDirectory | Out-Null }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($admins)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rights = if ($sid -eq 'S-1-5-32-545') { 'ReadAndExecute' } else { 'FullControl' }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,$rights,'ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $InstallDirectory -AclObject $acl
}

function Install-Maintenance {
    Assert-Administrator
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if (-not $service) { throw 'Install the Cloudflared service first.' }
    $parts = Get-ServiceCommand $service.PathName
    if ($parts.Arguments -match '(?i)--token(?:=|\s)') { throw 'Use --token-file before installing maintenance; do not store tokens in service arguments.' }
    $Executable = (Get-Item -LiteralPath $Executable).FullName
    if ((Get-FileHash -LiteralPath $parts.Executable).Hash -ne (Get-FileHash -LiteralPath $Executable).Hash) {
        throw 'The selected executable differs from the running service binary. Align the versions before changing paths.'
    }
    $listener = Get-NetTCPConnection -LocalPort 20241 -State Listen -ErrorAction SilentlyContinue
    if ($listener -and @($listener | Where-Object OwningProcess -ne $service.ProcessId).Count -gt 0) { throw 'Port 20241 belongs to another process.' }
    Protect-InstallDirectory
    $backupPath = Join-Path $InstallDirectory 'backup.json'
    $backup = Read-JsonFile $backupPath
    if (-not $backup) {
        $backup = [pscustomobject]@{ CreatedUtc = [datetime]::UtcNow.ToString('o'); ImagePath = $service.PathName; Power = Get-PowerBackup }
        Write-JsonFile $backupPath $backup
    }
    $installedScript = Join-Path $InstallDirectory 'cloudflared-maintenance.ps1'
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne $installedScript) { Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force }
    $logs = Join-Path $InstallDirectory 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($oldTask) { Disable-ScheduledTask -TaskName $taskName | Out-Null; Stop-ScheduledTask -TaskName $taskName }
    $command = Get-MonitoredCommand $service.PathName $Executable $logs
    try {
        Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName" -Name ImagePath -Value $command
        Set-AlwaysOnPower (Get-PowerBackup)
        Restart-TunnelService
        $shell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $action = New-ScheduledTaskAction -Execute $shell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installedScript + '" -Mode Check -InstallDirectory "' + $InstallDirectory + '"') -WorkingDirectory $InstallDirectory
        $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 90) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Local Cloudflared readiness check every minute; 3 failures, 5 minute recovery cooldown.' -Force | Out-Null
        Write-MaintenanceLog "Installed. Service executable: $Executable. Protocol arguments preserved."
        Invoke-HealthCheck
        Write-Host "Installed: $installedScript"
    } catch {
        Write-MaintenanceLog "Installation failed: $($_.Exception.Message). Restoring original settings."
        Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName" -Name ImagePath -Value $backup.ImagePath
        Set-AlwaysOnPower $backup.Power -Restore
        Restart-TunnelService
        throw
    }
}

function Update-TunnelBinary {
    Assert-Administrator
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    $binary = (Get-ServiceCommand $service.PathName).Executable
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $reenable = $task -and $task.State -ne 'Disabled'
    if ($task) { Disable-ScheduledTask -TaskName $taskName | Out-Null; Stop-ScheduledTask -TaskName $taskName }
    try {
        Write-MaintenanceLog "Manual update of the SERVICE binary: $binary"
        & $binary update
        $code = $LASTEXITCODE
        if ($code -eq 11) {
            Restart-TunnelService
            Write-MaintenanceLog 'Cloudflared updated and service restarted.'
        } elseif ($code -ne 0) { throw "Cloudflared update failed with exit code $code" }
        & $binary --version
    } finally {
        if ($reenable) { Enable-ScheduledTask -TaskName $taskName | Out-Null }
    }
}

function Restore-Maintenance {
    Assert-Administrator
    $backup = Read-JsonFile (Join-Path $InstallDirectory 'backup.json')
    if (-not $backup) { throw 'No original-settings backup found.' }
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Stop-ScheduledTask -TaskName $taskName
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName" -Name ImagePath -Value $backup.ImagePath
    Set-AlwaysOnPower $backup.Power -Restore
    Restart-TunnelService
    Write-MaintenanceLog 'Restored original service path and power settings. Logs and backups retained.'
}

# Dot-sourcing exposes the pure decision functions to the dependency-free tests.
if ($MyInvocation.InvocationName -eq '.') { return }
try {
    switch ($Mode) {
        'Install' { Install-Maintenance }
        'Check' {
            Assert-Administrator
            # The scheduler skips overlapping runs; this also covers manual concurrent checks.
            $lock = $null
            try { $lock = [IO.File]::Open((Join-Path $InstallDirectory 'check.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
            catch [IO.IOException] { return }
            try { Invoke-HealthCheck } finally { $lock.Dispose() }
        }
        'Update' { Update-TunnelBinary }
        'Restore' { Restore-Maintenance }
        'Status' {
            Get-Service -Name $serviceName | Select-Object Name, Status, StartType
            Get-TunnelReadiness
            Read-JsonFile (Join-Path $InstallDirectory 'state.json')
            Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object LastRunTime, LastTaskResult, NextRunTime
            $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
            $binary = (Get-ServiceCommand $service.PathName).Executable
            Write-Host "Service executable: $binary"
            & $binary --version
        }
    }
} catch {
    if (Test-Path -LiteralPath $InstallDirectory) {
        try { Write-MaintenanceLog "ERROR: $($_.Exception.Message)" } catch { }
    }
    Write-Error $_ -ErrorAction Continue
    exit 1
}
