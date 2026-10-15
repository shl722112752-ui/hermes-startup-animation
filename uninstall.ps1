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
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'

# paths.json is UTF-8 without BOM and Windows PowerShell 5.1 defaults to ANSI, so
# -Encoding UTF8 must be explicit. It tells us where HERMES_HOME is and which
# debug-port value this project wrote (cdpPort), so nothing here has to guess.
$pathsFile = Join-Path $InstallDir 'paths.json'
$pathsObj = $null
if (Test-Path $pathsFile) {
  try { $pathsObj = (Get-Content $pathsFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { $pathsObj = $null }
}

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
# Fallback for node processes started from this install directory, for when a pid
# file went missing. Matching the install path (rather than the literal name
# "HermesSplash") also covers custom -InstallDir values - and it matters, because
# a supervisor that survives this step re-adds the env var deleted in step 4.
$esc = [Regex]::Escape($InstallDir)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $esc -and $_.CommandLine -notlike '*dsh-subprocess*' } |
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
  $homeDir = if ($pathsObj) { $pathsObj.hermesHome } else { $null }
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
# Only delete the value this project wrote. The installer records the port it
# chose in paths.json (0 = "let Chromium pick a free port"), so a value set for
# another WebView2 app or tool is never touched.
$want = $null
if ($pathsObj -and $null -ne $pathsObj.cdpPort) { $want = "--remote-debugging-port=$([int]$pathsObj.cdpPort)" }
$removed = $false
if ($KeepEnvVar) {
  Write-Host '  kept (-KeepEnvVar)'
} elseif ($want -and $current -eq $want) {
  [Environment]::SetEnvironmentVariable($EnvName, $null, 'User')
  $removed = $true
  Write-Host "  removed $EnvName (was $current)"
} elseif ($current) {
  if ($want) { Write-Host "  kept (current value was not written by this project): $current" }
  else { Write-Host "  kept (paths.json is missing, so this project's value cannot be told apart): $current" }
} else {
  Write-Host '  (not set)'
}
if ($removed) {
  # Re-check: a supervisor that survived step 1 would put the variable straight back.
  Start-Sleep -Milliseconds 300
  $again = [Environment]::GetEnvironmentVariable($EnvName, 'User')
  if ($again) { Write-Host "  WARNING: $EnvName came back as `"$again`" - a supervisor is probably still running" }
  else { Write-Host '  confirmed removed' }
}

Head '5. files'
if ($Purge) {
  # -InstallDir accepts any string, so "-Purge" alone must not be treated as licence
  # to recursively delete it. Only remove a directory that is really our install.
  if (-not (Test-Path (Join-Path $InstallDir 'supervisor.mjs'))) {
    Write-Host "  WARNING: $InstallDir does not look like the install dir (no supervisor.mjs) - refusing to delete it" -ForegroundColor Yellow
    Write-Host "           re-run with -InstallDir pointing at the real directory"
  } else {
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  deleted $InstallDir"
  }
} else {
  Write-Host "  kept $InstallDir (add -Purge to delete it)"
}

Write-Host ''
Write-Host 'Done. The desktop app itself was never modified, so there is nothing to roll back.'
