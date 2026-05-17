# MyOwnLLM dev bootstrap (Windows). Idempotent: re-running is a no-op.
# Run from an elevated PowerShell prompt: `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1`

$ErrorActionPreference = "Stop"

function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }
function Log($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }

if (-not (Have "winget")) {
    Warn "winget not found. Install App Installer from the Microsoft Store and re-run."
    exit 1
}

if (-not (Have "rustup")) {
    Log "Installing rustup…"
    winget install --id Rustlang.Rustup --silent --accept-source-agreements --accept-package-agreements
    $env:Path = "$env:Path;$env:USERPROFILE\.cargo\bin"
}

# Rust on Windows targets `x86_64-pc-windows-msvc` by default, which links
# via Microsoft's `link.exe` from Visual Studio Build Tools. rustup-init
# normally prompts to install Build Tools when it's missing, but running
# via winget with --silent suppresses that prompt — so a fresh box gets
# rustup happily installed and then every `cargo install` blows up with:
#   error: linker `link.exe` not found
# Probe for the linker; install BuildTools + the C++ workload only if it
# isn't there. The install is large (~5 GB) so we don't want to re-run
# it on every bootstrap.
#
# `--override` passes the args verbatim to the Visual Studio Installer:
#   Microsoft.VisualStudio.Workload.VCTools  — the actual C++ toolchain
#   Microsoft.VisualStudio.Component.Windows11SDK.22621 — Windows headers
#   --includeRecommended                     — pulls in matching MSBuild +
#                                              ATL/MFC bits Tauri needs at
#                                              bundle time
function Have-MsvcLinker {
    if (Have "link.exe") { return $true }
    # `link.exe` only appears on PATH inside a Developer Command Prompt;
    # check the canonical install paths too.
    foreach ($base in @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\VC\Tools\MSVC",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC"
    )) {
        if (Test-Path $base) {
            $found = Get-ChildItem -Path $base -Recurse -Filter "link.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found) { return $true }
        }
    }
    return $false
}

if (-not (Have-MsvcLinker)) {
    Log "Installing Visual Studio Build Tools (C++ workload, ~5 GB — first run only)…"
    winget install --id Microsoft.VisualStudio.2022.BuildTools --silent `
        --accept-source-agreements --accept-package-agreements `
        --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended"
    if ($LASTEXITCODE -ne 0) {
        Warn "Build Tools install returned exit $LASTEXITCODE. If `cargo install` later fails with 'link.exe not found', install manually:"
        Warn "  https://visualstudio.microsoft.com/downloads/  →  'Build Tools for Visual Studio 2022'  →  check 'Desktop development with C++'"
        Warn "…then re-run scripts/bootstrap.ps1."
    }
}

Log "Installing Rust 1.88.0 toolchain (no-op if present)…"
rustup toolchain install 1.88.0 -c clippy,rustfmt --profile minimal | Out-Null

if (-not (Have "node")) {
    Log "Installing Node.js LTS…"
    winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
}

if (-not (Have "pnpm")) {
    # winget updates the persistent PATH but not the running session's, so a
    # freshly installed Node (and the corepack shim that ships with it) won't
    # be on PATH yet. Refresh from the machine + user envs before probing.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

    if (Have "corepack") {
        Log "Enabling pnpm via corepack…"
        corepack enable
        corepack prepare pnpm@latest --activate
    } elseif (Have "npm") {
        # Node 25+ unbundled corepack; older Node may also not ship it. npm
        # is always there, so install pnpm directly.
        Log "Installing pnpm via npm…"
        npm install -g pnpm
    } else {
        Warn "Neither corepack nor npm is on PATH. Open a new terminal (so the post-install PATH refreshes) and re-run scripts/bootstrap.ps1."
        exit 1
    }
}

# WebView2 is required by Tauri on Windows.
$webView2 = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if (-not $webView2) {
    Log "Installing Microsoft Edge WebView2 Runtime…"
    winget install --id Microsoft.EdgeWebView2Runtime --silent --accept-source-agreements --accept-package-agreements
}

# cmake is kept around for any C/C++ build.rs in the dep tree. The
# previous whisper-rs ASR backend has been replaced by `ort`
# (load-dynamic onnxruntime) so cmake is no longer strictly required —
# but installing it is cheap and several smaller crates still reach for
# it, so we leave it in.
if (-not (Have "cmake")) {
    Log "Installing CMake…"
    winget install --id Kitware.CMake --silent --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# `$ErrorActionPreference = "Stop"` at the top only catches PowerShell-
# native errors — external commands like `cargo` signal failure through
# `$LASTEXITCODE`, which Stop never sees. Without the explicit check
# below, a `cargo install` that died on a missing linker prints
# "==> Done. Try: just dev …" and leaves the user staring at a "command
# not found" the next time they try to build. Check after every external
# invocation that's expected to succeed.
Log "Installing tauri-cli@^2…"
cargo install tauri-cli --version "^2" --locked
if ($LASTEXITCODE -ne 0) {
    Warn "tauri-cli install failed (cargo exit $LASTEXITCODE)."
    Warn "If the error mentions 'link.exe not found', open a NEW PowerShell window so the Build Tools PATH refreshes, then re-run scripts/bootstrap.ps1."
    exit $LASTEXITCODE
}

if (-not (Have "just")) {
    Log "Installing just…"
    winget install --id Casey.Just --silent --accept-source-agreements --accept-package-agreements
}

Log "Done. Try: just dev | just build | just run | just serve | just preload text vision"
