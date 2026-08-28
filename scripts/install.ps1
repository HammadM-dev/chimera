# CHIMERA installer for Windows.
#
#   irm https://raw.githubusercontent.com/HammadM-dev/chimera-releases/main/install.ps1 | iex
#
# Downloads the latest release into the user's own profile and puts `chimera`
# on PATH. No admin rights, nothing in Program Files, nothing in the registry
# beyond the user's own PATH variable.
#
# Why this rather than "download the .exe": SmartScreen warns about executables
# carrying Mark-of-the-Web, which is attached by browsers on download and is
# not attached by Invoke-WebRequest. A signing certificate removes the warning
# properly and can be added later without changing anything a user does here.

$ErrorActionPreference = 'Stop'

$Repo = 'HammadM-dev/chimera-releases'
$Root = Join-Path $env:LOCALAPPDATA 'Programs\CHIMERA'

function Fail($message) {
    Write-Host "install: $message" -ForegroundColor Red
    exit 1
}

Write-Host 'Looking for the latest release...'

try {
    # GitHub's API refuses requests without a User-Agent.
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
        -Headers @{ 'User-Agent' = 'chimera-installer' }
} catch {
    Fail "could not read $Repo's releases. If that repository is private, its assets cannot be downloaded without a token."
}

$version = $release.tag_name
if (-not $version) { Fail 'no released version found yet.' }

# The Windows target is a portable executable — one file, no installer to run
# and nothing to uninstall but this folder.
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'ia32' }

$asset = $release.assets |
    Where-Object { $_.name -like '*.exe' } |
    Where-Object { $_.name -like "*$arch*" } |
    Select-Object -First 1

if (-not $asset) {
    # Same reasoning as the shell installer: fall back to an asset that is not
    # named for a different architecture, rather than to whatever is first. A
    # wrong-architecture binary installs cleanly and then refuses to start.
    $other = if ($arch -eq 'x64') { 'ia32', 'arm64' } else { 'x64', 'arm64' }
    $asset = $release.assets |
        Where-Object { $_.name -like '*.exe' } |
        Where-Object { $name = $_.name; -not ($other | Where-Object { $name -like "*$_*" }) } |
        Select-Object -First 1
}

if (-not $asset) { Fail "release $version has no Windows asset for $arch." }

Write-Host "Installing CHIMERA $version for windows/$arch..."

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$target = Join-Path $Root 'chimera.exe'

# Downloaded beside the target and moved into place, so an interrupted download
# cannot leave a truncated executable that looks installed.
$temp = "$target.partial"
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $temp `
        -Headers @{ 'User-Agent' = 'chimera-installer' }
    Move-Item -Force $temp $target
} catch {
    if (Test-Path $temp) { Remove-Item -Force $temp }
    Fail 'download failed.'
}

# Unblock regardless: harmless when the attribute is absent, and it is present
# if this script was itself saved by a browser before being run.
Unblock-File -Path $target -ErrorAction SilentlyContinue

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$Root*") {
    $updated = if ([string]::IsNullOrEmpty($userPath)) { $Root } else { "$userPath;$Root" }
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    $pathAdded = $true
}

Write-Host ''
Write-Host "CHIMERA $version is installed."
Write-Host "  app:     $target"

if ($pathAdded) {
    # The PATH change reaches new shells only; saying "type chimera" here would
    # be wrong in the very window the person is looking at.
    Write-Host ''
    Write-Host 'Open a new terminal, then type `chimera` to start.'
} else {
    Write-Host ''
    Write-Host 'Type `chimera` to start.'
}
