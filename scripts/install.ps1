# MyOwnLLM end-user installer (Windows).
#
# Tries (in order):
#   1. Download a pre-built release binary from GitHub for the current platform.
#   2. Fall back to building from source via scripts/bootstrap.ps1.
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1 | iex
#   iex "& { $(irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1) } -Run"
#   .\scripts\install.ps1 -DryRun

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Run,
    [switch]$FromSource,
    [string]$Prefix = "$env:LOCALAPPDATA\Programs\MyOwnLLM",
    [string]$Repo = $(if ($env:MYOWNLLM_REPO) { $env:MYOWNLLM_REPO } else { "mrjeeves/MyOwnLLM" })
)

$ErrorActionPreference = "Stop"

function Log($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "xxx $msg" -ForegroundColor Red }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x86_64" }
    "ARM64" { "aarch64" }
    default { $env:PROCESSOR_ARCHITECTURE.ToLower() }
}
$asset = "myownllm-windows-$arch.zip"

function Install-FromZip([string]$zipPath) {
    if (-not (Test-Path $Prefix)) {
        New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
    }
    Expand-Archive -Path $zipPath -DestinationPath $Prefix -Force
    $exe = Join-Path $Prefix "myownllm.exe"
    if (-not (Test-Path $exe)) {
        throw "myownllm.exe not found in $zipPath after extraction"
    }
    Log "Installed: $exe"

    # Add prefix to user PATH if it isn't already there.
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not ($userPath -split ";" | Where-Object { $_ -ieq $Prefix })) {
        Log "Adding $Prefix to user PATH"
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$Prefix", "User")
        $env:Path = "$env:Path;$Prefix"
    }
}

function Try-Release {
    $api = "https://api.github.com/repos/$Repo/releases/latest"
    Log "Looking up latest release: $api"
    try {
        $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "myownllm-installer" }
    } catch {
        Warn "GitHub releases unreachable (or no release yet): $($_.Exception.Message)"
        return $false
    }
    $match = $release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
    if (-not $match) {
        Warn "No release asset matched $asset."
        return $false
    }
    $url = $match.browser_download_url
    Log "Downloading $url"
    if ($DryRun) { Log "(dry-run) would download $url"; return $true }

    $tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "myownllm-install-$([guid]::NewGuid())")
    try {
        $zip = Join-Path $tmp $asset
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        $shaUrl = "$url.sha256"
        try {
            $shaFile = "$zip.sha256"
            Invoke-WebRequest -Uri $shaUrl -OutFile $shaFile -UseBasicParsing
            $expected = (Get-Content $shaFile -Raw).Split()[0].Trim().ToLower()
            $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
            if ($expected -ne $actual) {
                throw "SHA256 mismatch: expected $expected, got $actual"
            }
            Log "SHA256 OK"
        } catch {
            Warn "No SHA256 sidecar or check failed; skipping integrity check."
        }
        Install-FromZip $zip
        return $true
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

# MyOwnLLM transcription needs onnxruntime ≥1.24. It's not bundled in
# the release zip — keeps the artifact lean and lets us ship one
# binary per platform — so we fetch Microsoft's prebuilt and drop the
# DLL next to myownllm.exe at install time. The app has an in-process
# first-run fallback (~/.myownllm/runtime/) so "warn and continue" is
# safe on download failure.
function Install-OnnxRuntime {
    if ($DryRun) { Log "(dry-run) would fetch onnxruntime"; return }

    # Read the pinned version from the source we're installing from.
    $ortVersion = ""
    try {
        $ortVersion = (Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$Repo/main/.ort-version" -Headers @{ "User-Agent" = "myownllm-installer" }).Trim()
    } catch {
        if (Test-Path ".ort-version") { $ortVersion = (Get-Content ".ort-version" -Raw).Trim() }
    }
    if (-not $ortVersion) {
        $ortVersion = "1.24.2"
        Warn "couldn't read .ort-version; falling back to $ortVersion"
    }

    if ($arch -ne "x86_64") {
        Warn "onnxruntime: no Microsoft prebuilt for arch '$arch' — install manually."
        return
    }
    $pkg = "onnxruntime-win-x64-$ortVersion"
    $url = "https://github.com/microsoft/onnxruntime/releases/download/v$ortVersion/$pkg.zip"

    Log "Downloading onnxruntime v$ortVersion (windows-x64)…"
    $tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "myownllm-ort-$([guid]::NewGuid())")
    try {
        $zip = Join-Path $tmp "ort.zip"
        try {
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        } catch {
            Warn "onnxruntime download failed: $($_.Exception.Message)"
            Warn "Transcription will fail until you fix this. Recovery options:"
            Warn "  1. Re-run this installer when networking is back."
            Warn "  2. Run 'myownllm fetch-onnxruntime' to retry from the app."
            Warn "  3. Place onnxruntime.dll in $env:USERPROFILE\.myownllm\runtime\."
            return
        }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $dll = Get-ChildItem -Path (Join-Path $tmp $pkg) -Recurse -Filter "onnxruntime.dll" | Select-Object -First 1
        if (-not $dll) {
            Warn "onnxruntime.dll not found inside archive — upstream layout may have changed."
            return
        }
        if (-not (Test-Path $Prefix)) {
            New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
        }
        Copy-Item -Force $dll.FullName (Join-Path $Prefix "onnxruntime.dll")
        Log "onnxruntime v$ortVersion installed to $Prefix\onnxruntime.dll"
    } catch {
        # Windows Defender will occasionally quarantine a freshly-
        # extracted DLL during the Copy-Item. Surface the actual error
        # so the user can act on it (whitelist + re-run) rather than
        # guessing.
        Warn "onnxruntime install failed: $($_.Exception.Message)"
        Warn "If Defender flagged it, restore from quarantine and re-run."
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

function Build-FromSource {
    Log "Building from source…"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Err "git is required to build from source."
        exit 1
    }
    if ((Test-Path "Justfile") -and (Test-Path "src-tauri")) {
        $repoDir = (Get-Location).Path
        Log "Using current directory as source: $repoDir"
    } else {
        $repoDir = Join-Path $env:TEMP "MyOwnLLM-$([guid]::NewGuid())"
        Log "Cloning into $repoDir"
        if (-not $DryRun) { git clone --depth 1 "https://github.com/$Repo.git" $repoDir }
    }
    if ($DryRun) { Log "(dry-run) would bootstrap and build in $repoDir"; return }

    Push-Location $repoDir
    try {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $repoDir "scripts\bootstrap.ps1")
        pnpm install --frozen-lockfile
        pnpm tauri build
        $built = Join-Path $repoDir "src-tauri\target\release\myownllm.exe"
        if (-not (Test-Path $built)) {
            Err "Build did not produce $built"
            exit 1
        }
        if (-not (Test-Path $Prefix)) {
            New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
        }
        Copy-Item -Force $built (Join-Path $Prefix "myownllm.exe")
        Log "Installed: $(Join-Path $Prefix 'myownllm.exe')"
    } finally {
        Pop-Location
    }
}

if ($FromSource -or -not (Try-Release)) {
    Build-FromSource
}

# Best-effort onnxruntime fetch. Failures fall through to the in-app
# first-run fetcher (which writes to ~/.myownllm/runtime/ instead of
# the install prefix), so we don't abort the install.
try {
    Install-OnnxRuntime
} catch {
    Warn "onnxruntime install skipped: $($_.Exception.Message). Will fetch on first launch."
}

if ($Run -and -not $DryRun) {
    Log "Launching myownllm run…"
    & (Join-Path $Prefix "myownllm.exe") run
    exit $LASTEXITCODE
}

Log "Done. Try: myownllm run | myownllm serve | myownllm preload text vision"
Log "Open a new terminal so the updated PATH takes effect."
