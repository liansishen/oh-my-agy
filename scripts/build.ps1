<#
.SYNOPSIS
    Typechecks, tests, builds, and optionally installs Oh My Agy (`oma`).

.DESCRIPTION
    Runs `bun run typecheck`, `bun test`, and compiles `src/bin/oma.ts` into a
    single standalone executable (`dist/oma.exe` on Windows, and optionally
    `dist/oma` for Linux x64) via `bun build --compile`.

.PARAMETER Target
    Build target: `win` (default), `linux`, or `all`.

.PARAMETER OutDir
    Output directory relative to the repo root (or absolute path). Default: `dist`.

.PARAMETER SkipTypecheck
    Skip `bun run typecheck`.

.PARAMETER SkipTest
    Skip `bun test`.

.PARAMETER Install
    Install the compiled `oma.exe` into `-InstallDir` (Windows target only).

.PARAMETER InstallDir
    Destination directory when `-Install` is set. Defaults to
    `$env:LOCALAPPDATA\Programs\oma`.

.PARAMETER AddToPath
    When combined with `-Install`, ensures `-InstallDir` is present in the
    current user's `Path` environment variable.

.EXAMPLE
    .\scripts\build.ps1

.EXAMPLE
    .\scripts\build.ps1 -Install -AddToPath

.EXAMPLE
    .\scripts\build.ps1 -Target all -SkipTest
#>
[CmdletBinding()]
param(
    [ValidateSet('win', 'linux', 'all')]
    [string]$Target = 'win',

    [string]$OutDir = 'dist',

    [switch]$SkipTypecheck,

    [switch]$SkipTest,

    [switch]$Install,

    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\oma'),

    [switch]$AddToPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Step {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string[]]$Command
    )
    Write-Host "==> $Name" -ForegroundColor Cyan
    $exe = $Command[0]
    $argsList = if ($Command.Length -gt 1) { $Command[1..($Command.Length - 1)] } else { @() }
    & $exe @argsList
    if ($LASTEXITCODE -ne 0) {
        throw "Step '$Name' failed with exit code $LASTEXITCODE."
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedOutDir = if ([System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir
} else {
    Join-Path $repoRoot $OutDir
}

Push-Location $repoRoot
try {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        throw "Bun is not installed or not on PATH. Install Bun 1.4+ first: https://bun.sh"
    }

    $entryPoint = Join-Path $repoRoot 'src\bin\oma.ts'
    if (-not (Test-Path $entryPoint)) {
        throw "Entry point not found: $entryPoint"
    }

    if (-not $SkipTypecheck) {
        Invoke-Step -Name 'Typecheck (tsc --noEmit)' -Command @('bun', 'run', 'typecheck')
    }

    if (-not $SkipTest) {
        Invoke-Step -Name 'Unit & integration tests (bun test)' -Command @('bun', 'test')
    }

    New-Item -ItemType Directory -Force -Path $resolvedOutDir | Out-Null

    $builtArtifacts = @()

    if ($Target -eq 'win' -or $Target -eq 'all') {
        $winOut = Join-Path $resolvedOutDir 'oma.exe'
        Invoke-Step -Name "Compile Windows executable ($winOut)" -Command @(
            'bun', 'build', '--compile', 'src/bin/oma.ts', '--outfile', $winOut
        )
        $builtArtifacts += $winOut
    }

    if ($Target -eq 'linux' -or $Target -eq 'all') {
        $linuxOut = Join-Path $resolvedOutDir 'oma'
        Invoke-Step -Name "Cross-compile Linux x64 executable ($linuxOut)" -Command @(
            'bun', 'build', '--compile', '--target=bun-linux-x64', 'src/bin/oma.ts', '--outfile', $linuxOut
        )
        $builtArtifacts += $linuxOut
    }

    Write-Host ""
    Write-Host "Build succeeded:" -ForegroundColor Green
    foreach ($artifact in $builtArtifacts) {
        if (Test-Path $artifact) {
            $sizeMb = [Math]::Round((Get-Item $artifact).Length / 1MB, 2)
            Write-Host "  - $artifact ($sizeMb MB)"
        }
    }

    if ($Install) {
        $winExe = Join-Path $resolvedOutDir 'oma.exe'
        if (-not (Test-Path $winExe)) {
            throw "-Install requires the Windows build artifact ($winExe). Use -Target win or -Target all."
        }

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        $destExe = Join-Path $InstallDir 'oma.exe'
        Copy-Item -Force $winExe $destExe
        Write-Host ""
        Write-Host "Installed: $destExe" -ForegroundColor Green

        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $pathEntries = @()
        if (-not [string]::IsNullOrWhiteSpace($userPath)) {
            $pathEntries = $userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        }
        $normalizedInstall = $InstallDir.TrimEnd('\')
        $alreadyInPath = $pathEntries | Where-Object { $_.TrimEnd('\') -ieq $normalizedInstall }

        if ($alreadyInPath) {
            Write-Host "User PATH already contains $InstallDir" -ForegroundColor DarkGray
        } elseif ($AddToPath) {
            $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
                $InstallDir
            } else {
                "$($userPath.TrimEnd(';'));$InstallDir"
            }
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            if ($env:Path -notlike "*$normalizedInstall*") {
                $env:Path = "$($env:Path.TrimEnd(';'));$InstallDir"
            }
            Write-Host "Added $InstallDir to user PATH. Open a new terminal for all shells to pick it up." -ForegroundColor Yellow
        } else {
            Write-Host "Note: $InstallDir is not on your user PATH. Re-run with -AddToPath or add it manually." -ForegroundColor Yellow
        }
    }
} finally {
    Pop-Location
}
