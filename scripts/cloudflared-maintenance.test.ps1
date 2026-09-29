#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\cloudflared-maintenance.ps1"
$passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:passed++
}
$now = [datetime]::Parse('2026-09-29T08:00:00Z').ToUniversalTime()
function New-TestState {
    [pscustomobject]@{ Failures=0; LastCheckUtc=$now.AddSeconds(-60).ToString('o'); LastRestartUtc=$now.AddHours(-1).ToString('o'); GraceUntilUtc=$now.AddHours(-1).ToString('o'); ProcessId=123; Status='ready'; Connections=4 }
}
$state = New-TestState
foreach ($minute in 0..2) {
    $decision = Get-NextHealthState $state $now.AddMinutes($minute) $false 0 'Running' 123
    Assert-True ($decision.Restart -eq ($minute -eq 2)) "Recover only on failure 3 (sample $minute)"
    $state = $decision.State
}
Assert-True ($state.LastRestartUtc -eq $now.AddMinutes(2).ToString('o')) 'Persist recovery time before restart'
foreach ($minute in 3..6) {
    $decision = Get-NextHealthState $state $now.AddMinutes($minute) $false 0 'Running' 123
    Assert-True (-not $decision.Restart) 'Never restart within cooldown'
    $state = $decision.State
}
$decision = Get-NextHealthState $state $now.AddMinutes(7) $false 0 'Running' 123
Assert-True $decision.Restart 'Allow another attempt after 5 minutes'
$state = New-TestState
$state.Failures = 2
$decision = Get-NextHealthState $state $now $true 1 'Running' 123
Assert-True (-not $decision.Restart -and $decision.State.Failures -eq 0) 'One healthy connection clears failures without restarting'
$decision = Get-NextHealthState $decision.State $now.AddMinutes(1) $false 0 'Running' 123
Assert-True (-not $decision.Restart -and $decision.State.Failures -eq 1) 'Recovery breaks the failure sequence'
$state.LastCheckUtc = $now.AddMinutes(-10).ToString('o')
$decision = Get-NextHealthState $state $now $false 0 'Running' 123
Assert-True (-not $decision.Restart -and $decision.State.Failures -eq 1) 'Sleep or missed checks reset consecutive failures'
$state = New-TestState
$state.Failures = 2
$decision = Get-NextHealthState $state $now $false 0 'Running' 456
Assert-True (-not $decision.Restart -and $decision.State.Status -eq 'starting') 'New process receives startup grace'
$decision = Get-NextHealthState $state $now $false 0 'Start Pending' 123
Assert-True (-not $decision.Restart) 'Do not interrupt a service transition'
$decision = Get-NextHealthState $null $now $false 0 'Running' 123
Assert-True (-not $decision.Restart) 'Missing state must not cause immediate restart'
$decision = Get-NextHealthState $state $now $false 0 'Stopped' 0
Assert-True $decision.Restart 'Stopped service can be recovered after the failure threshold'
$state.LastCheckUtc = $now.AddMinutes(5).ToString('o')
$decision = Get-NextHealthState $state $now $false 0 'Running' 123
Assert-True (-not $decision.Restart) 'Clock moving backwards does not trigger recovery'
$command = Get-MonitoredCommand 'D:\cloudflared.exe tunnel --protocol quic run --token-file C:\ProgramData\cloudflared\token' 'C:\Program Files (x86)\cloudflared\cloudflared.exe' 'C:\ProgramData\cloudflared\maintenance\logs'
Assert-True ($command.Contains('--protocol quic')) 'Preserve protocol'
Assert-True ($command.Contains('--token-file C:\ProgramData\cloudflared\token')) 'Preserve token-file reference'
Assert-True ((Get-ServiceCommand $command).Executable -eq 'C:\Program Files (x86)\cloudflared\cloudflared.exe') 'Correctly quote executable with spaces'
$second = Get-MonitoredCommand $command 'C:\Program Files (x86)\cloudflared\cloudflared.exe' 'C:\ProgramData\cloudflared\maintenance\logs'
Assert-True ($second -eq $command) 'Reinstall does not duplicate flags'
$command = Get-MonitoredCommand 'D:\cloudflared.exe tunnel --metrics=127.0.0.1:9999 --logfile "C:\old logs\cf.log" run --token-file C:\token' 'D:\cloudflared.exe' 'C:\logs'
Assert-True (-not $command.Contains('--logfile') -and -not $command.Contains(':9999')) 'Replace conflicting logging and metrics flags'
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('cloudflared-maintenance-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$testFile = Join-Path $testDirectory 'state.json'
try {
    Write-JsonFile $testFile @{ Failures = 1 }
    Write-JsonFile $testFile @{ Failures = 2 }
    Assert-True ((Read-JsonFile $testFile).Failures -eq 2) 'Atomically replace the state file on Windows PowerShell 5.1'

    # Exercise the actual persistence/recovery ordering without touching a real service.
    $InstallDirectory = $testDirectory
    $script:recoveries = 0
    function Get-CimInstance { [pscustomobject]@{ State='Running'; ProcessId=123; StartMode='Auto' } }
    function Get-TunnelReadiness { [pscustomobject]@{ Ready=$false; Connections=0; Error='Simulated disconnection' } }
    function Restart-TunnelService {
        $script:recoveries++
        $saved = Read-JsonFile $testFile
        Assert-True (([datetime]::UtcNow - [datetime]::Parse($saved.LastRestartUtc).ToUniversalTime()).TotalSeconds -lt 10) 'Recovery cooldown is saved before touching the service'
        throw 'Simulated service start failure'
    }
    $now = [datetime]::UtcNow
    $seed = New-TestState
    $seed.Failures = 2
    Write-JsonFile $testFile $seed
    try { Invoke-HealthCheck | Out-Null; throw 'Expected a simulated start failure' }
    catch { Assert-True ($_.Exception.Message -eq 'Simulated service start failure') 'Recovery failure reaches the caller' }
    Invoke-HealthCheck | Out-Null
    Assert-True ($script:recoveries -eq 1) 'Failed recovery does not immediately trigger another restart'
    Write-JsonFile $testFile @{ LastCheckUtc = 'invalid' }
    Invoke-HealthCheck | Out-Null
    Assert-True ($script:recoveries -eq 1 -and (Read-JsonFile $testFile).Status -eq 'starting') 'Invalid persisted dates reset safely with a cooldown'
} finally {
    # Remove only the two exact files created by this test, then the empty temp directory.
    foreach ($path in @($testFile, "$testFile.tmp", (Join-Path $testDirectory 'watchdog.log'))) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }
    Remove-Item -LiteralPath $testDirectory
}
Write-Host "$passed checks passed. No service, task, power setting or network was changed."
