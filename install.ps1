#Requires -Version 5.1
<#
    Hermes Startup Animation - installer
    ============================================================================
    Installs the whole thing and wires up every OS-level piece so that nothing
    has to be done by hand afterwards:

      * discovers the Hermes install directory, HERMES_HOME and a usable Node
      * copies the runtime into the install directory
      * generates the windowless launcher + settings CLI for THIS machine
      * sets the user-level WebView2 debug-port variable
      * adds the launcher to the Startup folder
      * registers the watchdog scheduled task (at logon + every 2 minutes)
      * starts the supervisor and runs a self-check

    Every step is idempotent: running it again just repairs what is missing.
    No administrator rights are needed (everything is per-user).

    Usage:
      powershell -ExecutionPolicy Bypass -File install.ps1
      powershell -ExecutionPolicy Bypass -File install.ps1 -HermesDir "D:\Hermes Agent CN Desktop"
      powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "$env:LOCALAPPDATA\HermesSplash"

    Keep this file pure ASCII: Windows PowerShell 5.1 reads .ps1 without a BOM
    as ANSI, so non-ASCII here would be mangled.
#>

[CmdletBinding()]
param(
  [string] $HermesDir,                       # folder containing hermes-agent-cn-desktop.exe
  [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'HermesSplash'),
  [string] $HermesHome,                      # defaults to <HermesDir>\data\hermes-home
  [string] $NodePath,                        # defaults to PATH/Hermes-bundled node
  [string] $DshConfig,                       # optional: path to dsh-startup.json
  [int]    $CdpPort = 0,                     # 0 = let Chromium pick a free port (recommended)
  [int]    $ApiPort = 9334,
  [switch] $NoSkill,                         # do not install the Hermes skill
  [switch] $NoStartupEntry,
  [switch] $NoTask,
  [switch] $SkipStart,
  [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$TaskName = 'HermesSplashWatchdog'
$EnvName  = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'
$EnvValue = "--remote-debugging-port=$CdpPort"

function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }
function Step([string]$msg) { Write-Host ''; Write-Host "=== $msg ===" }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Write text with an exact encoding. Windows PowerShell 5.1's -Encoding UTF8 adds
# a BOM, which breaks JSON.parse in Node, so write UTF-8 without BOM by hand.
function Write-Text([string]$Path, [string]$Text, [string]$Kind) {
  switch ($Kind) {
    'Utf8NoBom' { [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
    'Unicode'   { [System.IO.File]::WriteAllText($Path, $Text, [System.Text.Encoding]::Unicode) }   # UTF-16LE + BOM, for .vbs
    'Ansi'      { [System.IO.File]::WriteAllText($Path, $Text, [System.Text.Encoding]::Default) }   # OEM/ANSI, for .cmd
    default     { throw "unknown encoding kind: $Kind" }
  }
}

function Get-NodeVersion([string]$exe) {
  try {
    $v = (& $exe -v 2>$null)
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

# ---------------------------------------------------------------- discovery --
Step '1. locating Hermes'

if (-not $HermesDir) {
  # a) registry uninstall entry (the CN desktop writes one)
  foreach ($root in @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (-not (Test-Path $root)) { continue }
    foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.DisplayName -match 'Hermes' -and $p.InstallLocation) {
        $cand = $p.InstallLocation.Trim('"')
        if (Test-Path (Join-Path $cand 'hermes-agent-cn-desktop.exe')) { $HermesDir = $cand; break }
      }
    }
    if ($HermesDir) { break }
  }
}
if (-not $HermesDir) {
  # b) common locations
  foreach ($cand in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Hermes Agent CN Desktop'),
      (Join-Path $env:ProgramFiles 'Hermes Agent CN Desktop'),
      "${env:ProgramFiles(x86)}\Hermes Agent CN Desktop")) {
    if ($cand -and (Test-Path (Join-Path $cand 'hermes-agent-cn-desktop.exe'))) { $HermesDir = $cand; break }
  }
}
if (-not $HermesDir) {
  # c) the running app
  $proc = Get-Process -Name 'hermes-agent-cn-desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc -and $proc.Path) { $HermesDir = Split-Path $proc.Path -Parent }
}
if (-not $HermesDir -or -not (Test-Path (Join-Path $HermesDir 'hermes-agent-cn-desktop.exe'))) {
  Fail "could not find the Hermes desktop app. Pass it explicitly:  install.ps1 -HermesDir '<folder with hermes-agent-cn-desktop.exe>'"
}
Say "  Hermes      : $HermesDir"

if (-not $HermesHome) {
  $cand = Join-Path $HermesDir 'data\hermes-home'
  if (Test-Path $cand) { $HermesHome = $cand }
}
if ($HermesHome) { Say "  HERMES_HOME : $HermesHome" } else { Say '  HERMES_HOME : (not found - skill will not be installed)' }

# Optional: a local DeepSeek Harness install, used only by "hermes-splash dsh"
# (import that animation's settings). Harmless when absent.
if (-not $DshConfig -and $env:DSH_HOME) {
  $cand = Join-Path $env:DSH_HOME 'dsh-startup.json'
  if (Test-Path $cand) { $DshConfig = $cand }
}
if ($DshConfig) { Say "  dsh config  : $DshConfig" }

Step '2. locating Node'
if ($NodePath -and (Test-Path $NodePath)) { $nodeMajor = Get-NodeVersion $NodePath }
if (-not $NodePath) {
  $cands = @()
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath) { $cands += $onPath.Source }
  $cands += @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
  # Hermes ships its own Node under data\versions\<ver>\node\node.exe - use the newest.
  $versions = Join-Path $HermesDir 'data\versions'
  if (Test-Path $versions) {
    Get-ChildItem $versions -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object {
      $cands += (Join-Path $_.FullName 'node\node.exe')
    }
  }
  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) {
      $maj = Get-NodeVersion $c
      if ($maj -ge 22) { $NodePath = $c; $nodeMajor = $maj; break }
    }
  }
}
if (-not $NodePath) {
  Fail "no Node.js >= 22 found (WebSocket is required). Install Node 22+, or pass -NodePath '<node.exe>'. Hermes usually ships one under data\versions\<ver>\node\node.exe."
}
Say "  Node        : $NodePath (v$nodeMajor)"

# ------------------------------------------------------------------- install --
Step '3. installing runtime files'
if (-not (Test-Path (Join-Path $RepoRoot 'runtime\supervisor.mjs'))) {
  Fail "runtime\ folder not found next to install.ps1 - run the script from the repository root."
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'src') | Out-Null

# Stop whatever is running from this install dir before replacing files.
foreach ($f in @('supervisor.pid', 'watcher.pid')) {
  $pf = Join-Path $InstallDir $f
  if (Test-Path $pf) {
    $txt = (Get-Content $pf -Raw).Trim()
    if ($txt -match '^\d+$') {
      $p = Get-Process -Id ([int]$txt) -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -like 'node*') {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Say "  stopped running $($p.ProcessName) (pid $($p.Id))"
      }
    }
    Remove-Item $pf -Force -ErrorAction SilentlyContinue
  }
}

Copy-Item (Join-Path $RepoRoot 'runtime\*') $InstallDir -Recurse -Force
Say "  copied runtime -> $InstallDir"
# user data is never overwritten; the supervisor creates config.json if missing
Say "  config.json kept as-is: $(Test-Path (Join-Path $InstallDir 'config.json'))"

# splash-bundle.js is a build artifact (not in the repository), so produce it now
# instead of waiting for the supervisor to notice it is missing.
& $NodePath (Join-Path $InstallDir 'build-bundle.mjs') | Out-Null
if (-not (Test-Path (Join-Path $InstallDir 'splash-bundle.js'))) {
  Fail "could not build splash-bundle.js - run: node `"$InstallDir\build-bundle.mjs`""
}
Say '  built splash-bundle.js'

Step '4. writing machine-specific files'
$pathsObj = [ordered]@{
  version    = 1
  installDir = $InstallDir
  hermesDir  = $HermesDir
  hermesHome = $HermesHome
  nodePath   = $NodePath
  dshConfig  = $DshConfig
  cdpPort    = $CdpPort
  apiPort    = $ApiPort
  installedAt = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
}
Write-Text (Join-Path $InstallDir 'paths.json') ($pathsObj | ConvertTo-Json -Depth 4) 'Utf8NoBom'
Say '  paths.json'

# --- windowless launcher ---------------------------------------------------
# Generated for this machine. Written as UTF-16 (BOM) because Windows Script
# Host reads .vbs as ANSI otherwise, which would mangle non-ASCII paths.
$vbsLauncher = @"
' Hermes startup-animation supervisor launcher (generated by install.ps1)
' Starts supervisor.mjs with no window. Safe to run at any time: a second
' supervisor exits immediately.
Option Explicit

Dim fso, sh, dir, node, candidates, i, hermesDir, versions, verDir, cand, best, bestTime, t

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

dir       = "@@INSTALL_DIR@@"
hermesDir = "@@HERMES_DIR@@"

If Not fso.FileExists(dir & "\supervisor.mjs") Then WScript.Quit 1

candidates = Array( _
@@NODE_CANDIDATES@@ _
)

node = ""
For i = 0 To UBound(candidates)
  If candidates(i) <> "" Then
    If fso.FileExists(candidates(i)) Then
      node = candidates(i)
      Exit For
    End If
  End If
Next

' Fallback: whatever Node the Hermes runtime bundles (newest version folder).
If node = "" Then
  If hermesDir <> "" Then
    versions = hermesDir & "\data\versions"
    If fso.FolderExists(versions) Then
      best = ""
      bestTime = 0
      For Each verDir In fso.GetFolder(versions).SubFolders
        cand = verDir.Path & "\node\node.exe"
        If fso.FileExists(cand) Then
          t = verDir.DateLastModified
          If best = "" Then
            best = cand
            bestTime = t
          ElseIf t > bestTime Then
            best = cand
            bestTime = t
          End If
        End If
      Next
      node = best
    End If
  End If
End If

If node = "" Then node = "node.exe"

sh.CurrentDirectory = dir
On Error Resume Next
sh.Run """" & node & """ """ & dir & "\supervisor.mjs""", 0, False
If Err.Number <> 0 Then
  On Error GoTo 0
  WScript.Quit 1
End If
On Error GoTo 0
"@

$nodeCands = @($NodePath)
foreach ($c in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
  if ($c -and $c -ne $NodePath) { $nodeCands += $c }
}
$nodeLines = ($nodeCands | ForEach-Object { '  "' + $_ + '"' }) -join ", _`r`n"
$vbsLauncher = $vbsLauncher.Replace('@@INSTALL_DIR@@', $InstallDir).Replace('@@HERMES_DIR@@', $HermesDir).Replace('@@NODE_CANDIDATES@@', $nodeLines)
$vbsPath = Join-Path $InstallDir 'hermes-splash-supervisor.vbs'
Write-Text $vbsPath $vbsLauncher 'Unicode'
Say '  hermes-splash-supervisor.vbs'

# --- settings CLI ----------------------------------------------------------
# ANSI so cmd.exe decodes any non-ASCII path correctly.
$cmd = @"
@echo off
REM Hermes startup-animation settings (generated by install.ps1)
chcp 65001 >nul
setlocal
set "NODE=@@NODE@@"
if not exist "%NODE%" set "NODE="
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0config-cli.mjs" %*
exit /b %ERRORLEVEL%
"@.Replace('@@NODE@@', $NodePath)
Write-Text (Join-Path $InstallDir 'hermes-splash.cmd') $cmd 'Ansi'
Say '  hermes-splash.cmd'

Step '5. installing the Hermes skill'
if ($NoSkill -or -not $HermesHome) {
  Say '  skipped'
} else {
  $skillSrc = Join-Path $RepoRoot 'skill\hermes-startup-animation\SKILL.md'
  if (Test-Path $skillSrc) {
    $skillDst = Join-Path $HermesHome 'skills\hermes-startup-animation'
    New-Item -ItemType Directory -Force -Path $skillDst | Out-Null
    Copy-Item $skillSrc (Join-Path $skillDst 'SKILL.md') -Force
    Say "  -> $skillDst\SKILL.md (visible in a NEW Hermes session)"
  } else {
    Say '  skill/SKILL.md not found - skipped'
  }
}

Step '6. debug-port environment variable'
# This variable is per-user and applies to EVERY WebView2 app on the machine, so a
# fixed port is a race: whichever app starts first takes it (observed in the wild -
# Microsoft PC Manager grabbed 9333 and Hermes then had no debug port at all).
# Port 0 lets Chromium pick a free port per app and record it in that app's
# DevToolsActivePort; we only ever read Hermes's own file. -CdpPort <n> forces a
# fixed port for people who really want one.
$current = [Environment]::GetEnvironmentVariable($EnvName, 'User')
if ($current -eq $EnvValue) {
  Say "  already set: $EnvValue"
} elseif ($current -and $current -notmatch '^--remote-debugging-port=\d+$') {
  Say "  WARNING: already set to a different value with extra flags, leaving it alone: $current"
} else {
  [Environment]::SetEnvironmentVariable($EnvName, $EnvValue, 'User')
  if ($current) { Say "  updated: $current -> $EnvValue (applies to the next Hermes launch)" }
  else { Say "  set: $EnvValue (applies to the next Hermes launch)" }
}

Step '7. autostart'
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
if ($NoStartupEntry) {
  Say '  startup entry skipped'
} else {
  Copy-Item $vbsPath (Join-Path $StartupDir 'hermes-splash-supervisor.vbs') -Force
  Say "  Startup folder: hermes-splash-supervisor.vbs"
  # retire the older watcher-only launcher so nothing starts an unsupervised injector
  foreach ($stale in @((Join-Path $StartupDir 'hermes-splash-watcher.vbs'))) {
    if (Test-Path $stale) { Remove-Item $stale -Force; Say "  removed stale $stale" }
  }
}

if ($NoTask) {
  Say '  scheduled task skipped'
} else {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbsPath + '"')
  $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # [TimeSpan]::MaxValue serialises out of range for the task XML; 10 years is plenty.
  $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) `
    -Settings $settings -Force `
    -Description 'Keeps the Hermes startup-animation supervisor running (logon + every 2 minutes; no-op when it is already up).' | Out-Null
  Say "  scheduled task: $TaskName (at logon + every 2 minutes)"
}

Step '8. starting it'
if ($SkipStart) {
  Say '  skipped (-SkipStart)'
} else {
  & wscript.exe $vbsPath
  Start-Sleep -Seconds 5
}

Step '9. self-check'
& (Join-Path $InstallDir 'hermes-splash.cmd') doctor
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  Write-Host 'Done. Hermes will play the startup animation on every launch.' -ForegroundColor Green
  Write-Host "Settings: in-app via Config -> Skills (/skills) or Ctrl+Alt+S, or:"
  Write-Host "  & `"$InstallDir\hermes-splash.cmd`" status"
} else {
  Write-Host 'Installed, but the self-check reported problems (see above).' -ForegroundColor Yellow
  Write-Host "Logs: $InstallDir\supervisor.log and watcher.log"
}
exit $code
