#Requires -Version 5.1
<#
    Hermes Startup Animation - uninstaller
    ============================================================================
    Stops the supervisor + injector, removes autostart (Startup entry and the
    watchdog scheduled task), removes the skill, and - with -Purge - deletes the
    install directory.

    The WebView2 debug-port variable is only removed when it still holds exactly
    the value this project wrote; if you set it yourself it is left alone.

    Usage:
      powershell -ExecutionPolicy Bypass -File uninstall.ps1
      powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
      powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge -KeepSkill

    Keep this file pure ASCII.
#>

[CmdletBinding()]
param(
  [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'HermesSplash'),
  [switch] $Purge,
  [switch] $KeepSkill,
  [switch] $KeepEnvVar
)

$ErrorActionPreference = 'Continue'
$TaskName = 'HermesSplashWatchdog'
$EnvName  = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$EnvValue = '--remote-debugging-port=9333'
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'

function Head([string]$m) { Write-Host ''; Write-Host "=== $m ===" }

Head '1. stopping the supervisor and injector'
$stopped = 0
foreach ($f in @('supervisor.pid', 'watcher.pid')) {
  $pf = Join-Path $InstallDir $f
  if (-not (Test-Path $pf)) { continue }
  $txt = (Get-Content $pf -Raw).Trim()
  if ($txt -match '^\d+$') {
    $p = Get-Process -Id ([int]$txt) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -like 'node*') {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      $stopped++
      Write-Host "  stopped $($p.ProcessName) pid $($p.Id)"
    }
  }
  Remove-Item $pf -Force -ErrorAction SilentlyContinue
}
# Fallback when a pid file went missing.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*HermesSplash*' -and $_.CommandLine -notlike '*dsh-subprocess*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $stopped++
    Write-Host "  stopped stray node pid $($_.ProcessId)"
  }
Write-Host "  $stopped process(es) stopped"

Head '2. removing autostart'
foreach ($name in @('hermes-splash-supervisor.vbs', 'hermes-splash-watcher.vbs')) {
  $p = Join-Path $StartupDir $name
  if (Test-Path $p) { Remove-Item $p -Force; Write-Host "  removed $p" }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "  removed scheduled task $TaskName"
} else {
  Write-Host '  (no scheduled task)'
}

Head '3. removing the skill'
if ($KeepSkill) {
  Write-Host '  kept (-KeepSkill)'
} else {
  $pathsFile = Join-Path $InstallDir 'paths.json'
  $homeDir = $null
  if (Test-Path $pathsFile) {
    # paths.json is UTF-8 (no BOM); Windows PowerShell 5.1 defaults to ANSI.
    try { $homeDir = (Get-Content $pathsFile -Raw -Encoding UTF8 | ConvertFrom-Json).hermesHome } catch { }
  }
  if ($homeDir) {
    $skillDir = Join-Path $homeDir 'skills\hermes-startup-animation'
    if (Test-Path $skillDir) { Remove-Item $skillDir -Recurse -Force; Write-Host "  removed $skillDir" }
    else { Write-Host '  (skill not installed)' }
  } else {
    Write-Host '  (could not tell where HERMES_HOME is - delete skills\hermes-startup-animation by hand if needed)'
  }
}

Head '4. debug-port environment variable'
$current = [Environment]::GetEnvironmentVariable($EnvName, 'User')
if ($KeepEnvVar) {
  Write-Host '  kept (-KeepEnvVar)'
} elseif ($current -match '^--remote-debugging-port=\d+$') {
  [Environment]::SetEnvironmentVariable($EnvName, $null, 'User')
  Write-Host "  removed $EnvName (was $current)"
} elseif ($current) {
  Write-Host "  kept (current value was not written by this project): $current"
} else {
  Write-Host '  (not set)'
}

Head '5. files'
if ($Purge) {
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  deleted $InstallDir"
} else {
  Write-Host "  kept $InstallDir (add -Purge to delete it)"
}

Write-Host ''
Write-Host 'Done. The desktop app itself was never modified, so there is nothing to roll back.'
