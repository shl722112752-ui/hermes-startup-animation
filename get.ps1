#Requires -Version 5.1
<#
    Hermes Startup Animation - download + install in one step
    ============================================================================
    Downloads the release zip from GitHub, verifies its SHA-256 against the
    SHA256SUMS.txt published with the same release, then runs install.ps1.

    One line (recommended):

      irm https://raw.githubusercontent.com/shl722112752-ui/hermes-startup-animation/main/get.ps1 | iex

    Or download it first and read it before running anything:

      irm https://raw.githubusercontent.com/shl722112752-ui/hermes-startup-animation/main/get.ps1 -OutFile get.ps1
      notepad get.ps1
      powershell -ExecutionPolicy Bypass -File get.ps1

    Optional parameters (only meaningful when you run this as a file):

      -Version v1.0.4   install a specific release instead of the latest one
      -Repo owner/name  use a fork instead of the upstream repository
      -SkipVerify       skip the SHA-256 check (not recommended)
      -Dest <dir>       extract here and keep the files
      -Keep             keep the temporary extraction directory
      -NoInstall        download + verify + unpack, then stop (no install)
      -InstallArgs ".." extra arguments for install.ps1, e.g. "-NoStartupEntry -SkipStart"

    Notes:
      * No administrator rights are needed; everything is per-user.
      * install.ps1 always runs in a child PowerShell process, so its own
        "exit 1" can never close the console you started this from.
      * Keep this file pure ASCII: Windows PowerShell 5.1 reads a .ps1 without a
        BOM as ANSI, so non-ASCII text here would be mangled.
#>

[CmdletBinding()]
param(
  [string] $Version = 'latest',
  [string] $Repo = 'shl722112752-ui/hermes-startup-animation',
  [string] $Dest,
  [string] $InstallArgs = '',
  [switch] $SkipVerify,
  [switch] $Keep,
  [switch] $NoInstall
)

$ErrorActionPreference = 'Stop'

function Info([string] $m) { Write-Host $m }
function Warn([string] $m) { Write-Host "WARNING: $m" -ForegroundColor Yellow }
function Die([string] $m) {
  # Run as a file: exit with a clean one-line error (a thrown exception would dump
  # a stack trace, which looks like a crash). Run through "irm | iex": throwing is
  # the only safe option, because "exit" would close the user's console.
  if ($PSCommandPath) {
    Write-Host ''
    Write-Host "ERROR: $m" -ForegroundColor Red
    exit 1
  }
  throw $m
}

# Windows PowerShell 5.1 still defaults to TLS 1.0 on some builds, which GitHub
# refuses. TLS 1.2 is a no-op on builds that already negotiate it.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$apiBase = "https://api.github.com/repos/$Repo"
$headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'hermes-startup-animation-get' }

# Download one release asset. The browser_download_url lives on github.com, which
# some networks (hosts-file hacks, corporate filters, regional blocks) cannot
# reach; the API host is usually still fine, so try the API asset endpoint first
# and fall back to the plain URL. Two tries each, then give up with instructions.
function Save-Asset($asset, [string] $dest) {
  $attempts = @(
    @{ uri = "$apiBase/releases/assets/$($asset.id)"; headers = @{ 'Accept' = 'application/octet-stream'; 'User-Agent' = 'hermes-startup-animation-get' } },
    @{ uri = $asset.browser_download_url; headers = @{ 'User-Agent' = 'hermes-startup-animation-get' } }
  )
  $last = 'unknown error'
  foreach ($a in $attempts) {
    foreach ($try in 1, 2) {
      try {
        Invoke-WebRequest -Uri $a.uri -Headers $a.headers -OutFile $dest -TimeoutSec 300 -MaximumRedirection 10
        if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { return }
        $last = "server returned an empty file ($($a.uri))"
      } catch {
        $last = $_.Exception.Message
      }
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 2
    }
  }
  Die @"
Download failed: $last

Nothing was installed. Do it by hand instead:
  1. open https://github.com/$Repo/releases
  2. download hermes-startup-animation-<version>.zip and SHA256SUMS.txt
  3. check the zip against the checksum, then unpack and run install.ps1
"@
}

Info "Repository : $Repo"
Info "Release    : $Version"

# ---------------------------------------------------------------- 1. resolve the release
$release = $null
try {
  $url = if ($Version -eq 'latest' -or $Version -eq '') { "$apiBase/releases/latest" } else { "$apiBase/releases/tags/$Version" }
  $release = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 60
} catch {
  Die @"
Could not read the release list from GitHub: $($_.Exception.Message)

Do it by hand instead:
  1. open https://github.com/$Repo/releases
  2. download hermes-startup-animation-<version>.zip and SHA256SUMS.txt
  3. check the zip against the checksum, then unpack and run install.ps1
"@
}
if (-not $release) { Die "No release found for '$Version' in $Repo." }
$tag = [string] $release.tag_name
Info "Tag        : $tag"

$zipAsset = @($release.assets | Where-Object { $_.name -like 'hermes-startup-animation-*.zip' }) | Select-Object -First 1
$sumAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
if (-not $zipAsset) { Die "Release $tag has no hermes-startup-animation-*.zip asset; use the repository source instead." }
Info ("Package    : {0} ({1} bytes)" -f $zipAsset.name, $zipAsset.size)
if (-not $sumAsset) { Warn "this release has no SHA256SUMS.txt, so the download cannot be verified" }

# ---------------------------------------------------------------- 2. download
$work = if ($Dest) { $Dest } else { Join-Path $env:TEMP ("hsa-get-{0}" -f $PID) }
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zipPath = Join-Path $work $zipAsset.name

try {
  Save-Asset $zipAsset $zipPath
} catch {
  Die "Download failed: $($_.Exception.Message)"
}
if (-not (Test-Path $zipPath)) { Die "Download produced no file at $zipPath" }

# ---------------------------------------------------------------- 3. verify SHA-256
if ($SkipVerify) {
  Warn "checksum verification skipped on request"
} elseif (-not $sumAsset) {
  Die @"
Release $tag has no SHA256SUMS.txt, so the download cannot be verified.
Nothing was installed. Either take an older release that ships a checksum, pass
-SkipVerify if you accept the risk, or download by hand and check the archive:
  https://github.com/$Repo/releases
"@
} else {
  $sumPath = Join-Path $work 'SHA256SUMS.txt'
  try {
    Save-Asset $sumAsset $sumPath
  } catch {
    Die "Could not download SHA256SUMS.txt: $($_.Exception.Message)"
  }
  $expected = $null
  foreach ($line in (Get-Content $sumPath)) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
      if ($Matches[2] -eq $zipAsset.name) { $expected = $Matches[1].ToLower(); break }
    }
  }
  if (-not $expected) { Die "SHA256SUMS.txt has no entry for $($zipAsset.name)." }
  $actual = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Die @"
CHECKSUM MISMATCH - the download was not installed.
  expected $expected
  actual   $actual
Delete the file and try again; if it keeps failing, download the zip by hand
from https://github.com/$Repo/releases and check it yourself.
"@
  }
  Info "Checksum   : OK ($actual)"
}

# ---------------------------------------------------------------- 4. unpack
$unpacked = Join-Path $work 'unpacked'
try {
  Expand-Archive -Path $zipPath -DestinationPath $unpacked -Force
} catch {
  Die "Could not unpack $($zipAsset.name): $($_.Exception.Message)"
}

# Files that came from the internet carry a mark of the web; PowerShell refuses
# to run scripts marked that way under some policies. Clear it on the unpacked tree.
try {
  Get-ChildItem $unpacked -Recurse -File | ForEach-Object { Unblock-File -Path $_.FullName -ErrorAction SilentlyContinue }
} catch { Warn "could not clear the mark-of-the-web on the unpacked files" }

$installer = Get-ChildItem $unpacked -Recurse -Filter 'install.ps1' -File | Select-Object -First 1
if (-not $installer) { Die "install.ps1 is not inside $($zipAsset.name)." }
Info ("Unpacked   : {0}" -f $installer.FullName)

# ---------------------------------------------------------------- 5. install (child process)
if ($NoInstall) {
  Info ''
  Info "-NoInstall given: downloaded, verified and unpacked only. Nothing was installed."
  Info ("Files are in: {0}" -f $unpacked)
  return
}

$exe = (Get-Process -Id $PID).Path
if (-not $exe) { $exe = 'powershell.exe' }
$childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer.FullName)
if ($InstallArgs.Trim()) { $childArgs += ($InstallArgs -split '\s+' | Where-Object { $_ }) }

Info ''
Info ("Running    : {0} {1}" -f $exe, ($childArgs -join ' '))
Info ''
$proc = Start-Process -FilePath $exe -ArgumentList $childArgs -Wait -PassThru -NoNewWindow
$code = $proc.ExitCode
Info ''
if ($code -ne 0) { Die "install.ps1 exited with code $code - see the messages above." }

# ---------------------------------------------------------------- 6. cleanup + summary
if (-not $Keep -and -not $Dest) {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Info "Temporary files removed ($work)."
} else {
  Info "Files kept in $work"
}

Info ''
Info 'Done. Next steps:'
Info '  1. start Hermes once - the animation plays during startup'
Info '  2. change it any time in Hermes: Settings -> Skills -> Startup animation,'
Info '     or from a terminal: hermes-splash panel   (in %LOCALAPPDATA%\HermesSplash)'
Info '  3. to remove everything: uninstall.ps1 (add -Purge to delete the install dir too)'
