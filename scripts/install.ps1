<#
.SYNOPSIS
    One-line installer for Oh My Agy (oma) on Windows.

.EXAMPLE
    irm https://raw.githubusercontent.com/liansishen/oh-my-agy/main/scripts/install.ps1 | iex

.NOTES
    Optional environment variables:
      OMA_REPO           GitHub repository (default: liansishen/oh-my-agy)
      OMA_VERSION        Release tag to install (default: latest)
      OMA_INSTALL_DIR    Install directory (default: $env:LOCALAPPDATA\Programs\oma)
      OMA_NO_MODIFY_PATH Set to 1 to skip updating user PATH
      OMA_SKIP_PLUGIN    Set to 1 to skip installing the Tern oma-reopen plugin
#>
[CmdletBinding()]
param(
    [string]$Repo = $(if ($env:OMA_REPO) { $env:OMA_REPO } else { 'liansishen/oh-my-agy' }),
    [string]$Version = $(if ($env:OMA_VERSION) { $env:OMA_VERSION } else { 'latest' }),
    [string]$InstallDir = $(if ($env:OMA_INSTALL_DIR) { $env:OMA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\oma' }),
    [switch]$NoModifyPath,
    [switch]$SkipPlugin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OMA_NO_MODIFY_PATH -eq '1') { $NoModifyPath = $true }
if ($env:OMA_SKIP_PLUGIN -eq '1') { $SkipPlugin = $true }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

function Get-RequestHeaders {
    $headers = @{ 'User-Agent' = 'oma-installer' }
    $token = if ($env:OMA_GITHUB_TOKEN) { $env:OMA_GITHUB_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
    if ($token) {
        $headers['Authorization'] = "Bearer $token"
    }
    return $headers
}

function Resolve-ReleaseTag {
    param([string]$TargetRepo, [string]$Requested)
    if ($Requested -ne 'latest' -and -not [string]::IsNullOrWhiteSpace($Requested)) {
        if ($Requested -match '^[vV]') { return "v$($Requested.Substring(1))" }
        return "v$Requested"
    }

    $headers = Get-RequestHeaders
    try {
        $resp = Invoke-RestMethod -Uri "https://api.github.com/repos/$TargetRepo/releases/latest" -Headers $headers -UseBasicParsing
        if ($resp.tag_name) { return [string]$resp.tag_name }
    } catch {
        # Fallback to GitHub latest redirect if REST API is rate-limited
        try {
            $req = [System.Net.HttpWebRequest]::Create("https://github.com/$TargetRepo/releases/latest")
            $req.AllowAutoRedirect = $true
            $req.UserAgent = 'oma-installer'
            $res = $req.GetResponse()
            $finalUri = $res.ResponseUri.AbsoluteUri
            $res.Close()
            if ($finalUri -match '/releases/tag/([^/?#]+)') {
                return [Uri]::UnescapeDataString($Matches[1])
            }
        } catch {}
        throw "Failed to resolve latest release tag for https://github.com/$TargetRepo : $($_.Exception.Message)"
    }
    throw "No published GitHub Releases found in https://github.com/$TargetRepo"
}

$arch = if ([Environment]::Is64BitOperatingSystem) {
    $procArch = $env:PROCESSOR_ARCHITECTURE
    if ($procArch -eq 'ARM64') { 'arm64' } else { 'x64' }
} else {
    throw 'Only 64-bit Windows is supported.'
}

$assetName = "oma-windows-$arch.exe"
$tag = Resolve-ReleaseTag -TargetRepo $Repo -Requested $Version
$baseUrl = "https://github.com/$Repo/releases/download/$tag"

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("oma-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

try {
    $binTmp = Join-Path $tmpDir $assetName
    Write-Host "Installing oma $tag ($assetName) from https://github.com/$Repo ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$baseUrl/$assetName" -OutFile $binTmp -Headers (Get-RequestHeaders) -UseBasicParsing

    $sumsTmp = Join-Path $tmpDir 'SHA256SUMS.txt'
    try {
        Invoke-WebRequest -Uri "$baseUrl/SHA256SUMS.txt" -OutFile $sumsTmp -Headers (Get-RequestHeaders) -UseBasicParsing
        $expected = $null
        foreach ($line in (Get-Content -Path $sumsTmp)) {
            if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\./)?(.+?)\s*$') {
                if ($Matches[3] -eq $assetName) {
                    $expected = $Matches[1].ToLowerInvariant()
                    break
                }
            }
        }
        if ($expected) {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            $fs = [System.IO.File]::OpenRead($binTmp)
            try {
                $hashBytes = $sha.ComputeHash($fs)
            } finally {
                $fs.Dispose()
                $sha.Dispose()
            }
            $actual = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
            if ($actual -ne $expected) {
                throw "SHA256 checksum mismatch for $assetName (expected $expected, got $actual)."
            }
            Write-Host "Verified SHA256 ($($actual.Substring(0, 12))...)" -ForegroundColor DarkGray
        }
    } catch {
        if ($_.Exception.Message -like 'SHA256 checksum mismatch*') { throw }
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $destExe = Join-Path $InstallDir 'oma.exe'
    $backupExe = "$destExe.old"
    $stagingExe = Join-Path $InstallDir (".oma-install-$PID.new.exe")
    Copy-Item -Force $binTmp $stagingExe

    if (Test-Path $backupExe) {
        try { Remove-Item -Force $backupExe -ErrorAction Stop } catch {}
    }

    $movedOld = $false
    try {
        if (Test-Path $destExe) {
            Move-Item -Force $destExe $backupExe
            $movedOld = $true
        }
        Move-Item -Force $stagingExe $destExe
    } catch {
        if ($movedOld -and (-not (Test-Path $destExe)) -and (Test-Path $backupExe)) {
            try { Move-Item -Force $backupExe $destExe } catch {}
        }
        if (Test-Path $stagingExe) { Remove-Item -Force $stagingExe -ErrorAction SilentlyContinue }
        throw
    }

    if (Test-Path $backupExe) {
        try { Remove-Item -Force $backupExe -ErrorAction SilentlyContinue } catch {}
    }

    Write-Host "Installed: $destExe" -ForegroundColor Green

    if (-not $NoModifyPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = @()
        if (-not [string]::IsNullOrWhiteSpace($userPath)) {
            $entries = $userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        }
        $normInstall = $InstallDir.TrimEnd('\')
        $exists = $entries | Where-Object { $_.TrimEnd('\') -ieq $normInstall }
        if (-not $exists) {
            $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $InstallDir } else { "$($userPath.TrimEnd(';'));$InstallDir" }
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            Write-Host "Added $InstallDir to user PATH. Open a new terminal for all shells to pick it up." -ForegroundColor Yellow
        }
        if ($env:Path -notlike "*$normInstall*") {
            $env:Path = "$($env:Path.TrimEnd(';'));$InstallDir"
        }
    }

    if (-not $SkipPlugin -and (Get-Command tern -ErrorAction SilentlyContinue)) {
        try {
            $pluginDir = Join-Path $tmpDir 'oma-reopen'
            New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
            $rawBase = "https://raw.githubusercontent.com/$Repo/$tag/plugins/oma-reopen"
            Invoke-WebRequest -Uri "$rawBase/plugin.toml" -OutFile (Join-Path $pluginDir 'plugin.toml') -Headers (Get-RequestHeaders) -UseBasicParsing
            Invoke-WebRequest -Uri "$rawBase/host.luau" -OutFile (Join-Path $pluginDir 'host.luau') -Headers (Get-RequestHeaders) -UseBasicParsing
            & tern plugin install $pluginDir | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Host 'Installed Tern plugin: oma-reopen' -ForegroundColor Green
            }
        } catch {
            Write-Host "Note: skipped optional Tern plugin installation ($($_.Exception.Message))." -ForegroundColor DarkGray
        }
    }

    Write-Host ''
    & $destExe --version
} finally {
    if (Test-Path $tmpDir) {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    }
}
