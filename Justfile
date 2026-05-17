# MyOwnLLM - one-command operations.
# Install `just` (https://just.systems) then run `just setup` to get going.

# `set shell` is used on Linux/macOS. On Windows the global
# `windows-shell` override routes recipes through PowerShell so they
# can find `pnpm.cmd` / `node.exe` via Windows PATH — without it, a
# user whose `bash` is WSL bash (very common when WSL is installed)
# ends up with pnpm's bash wrapper trying to `exec node` and failing
# because WSL doesn't expose Windows binaries by their unqualified
# name. The trade-off is that any recipe using bash-specific syntax
# (`if [ -x … ]`, `|| true`, `\` line continuations) needs a
# `[windows]` variant; recipes that just call cross-platform tools
# (pnpm, cargo, git) work in both shells unmodified.
set shell := ["bash", "-cu"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

default: help

help:
    @just --list

# Install all dev prerequisites (Rust, Node, pnpm, Tauri CLI, GTK / Windows SDK deps).
# Platform-split — `[unix]` covers Linux + macOS, `[windows]` covers
# Windows. With `windows-shell := powershell` set above, the `[windows]`
# recipe already runs through PowerShell — no `[script(...)]` needed.
[unix]
[doc("Install all dev prerequisites (Rust, Node, pnpm, Tauri CLI, GTK deps).")]
setup:
    @./scripts/bootstrap.sh

[windows]
[doc("Install all dev prerequisites (Rust, Node, pnpm, Tauri CLI, Windows SDK).")]
setup:
    @& .\scripts\bootstrap.ps1

# Run the GUI in dev mode with hot reload.
dev:
    @pnpm install --frozen-lockfile
    @pnpm tauri dev

# Build a production Tauri bundle.
build:
    @pnpm install --frozen-lockfile
    @pnpm tauri build

# Run the binary (build first if needed).
[unix]
[doc("Run the binary (build first if needed).")]
run *ARGS:
    @if [ -x src-tauri/target/release/myownllm ]; then \
        src-tauri/target/release/myownllm {{ARGS}}; \
    else \
        cargo run --release --manifest-path src-tauri/Cargo.toml -- {{ARGS}}; \
    fi

[windows]
[doc("Run the binary (build first if needed).")]
run *ARGS:
    @if (Test-Path src-tauri/target/release/myownllm.exe) { & src-tauri/target/release/myownllm.exe {{ARGS}} } else { cargo run --release --manifest-path src-tauri/Cargo.toml -- {{ARGS}} }

# Start the OpenAI-compatible HTTP server (default port 1473).
serve port="1473":
    @just run serve --port {{port}}

# Preload models for the listed modes (e.g. `just preload text vision code`).
preload +modes:
    @just run preload {{modes}} --track

# Format Rust + frontend.
[unix]
[doc("Format Rust + frontend.")]
fmt:
    @cd src-tauri && cargo fmt
    @pnpm exec prettier --write "src/**/*.{ts,svelte,json,md}" || true

[windows]
[doc("Format Rust + frontend.")]
fmt:
    @cd src-tauri; cargo fmt
    @pnpm exec prettier --write "src/**/*.{ts,svelte,json,md}"; if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0 }

# Lint Rust + run svelte-check.
[unix]
[doc("Lint Rust + run svelte-check.")]
lint:
    @cd src-tauri && cargo clippy --all-targets -- -W warnings
    @pnpm check

[windows]
[doc("Lint Rust + run svelte-check.")]
lint:
    @cd src-tauri; cargo clippy --all-targets -- -W warnings
    @pnpm check

# Cheap subset of CI to run locally before pushing.
[unix]
[doc("Cheap subset of CI to run locally before pushing.")]
check: lint
    @cd src-tauri && cargo fmt --check
    @cd src-tauri && cargo test --no-fail-fast

[windows]
[doc("Cheap subset of CI to run locally before pushing.")]
check: lint
    @cd src-tauri; cargo fmt --check
    @cd src-tauri; cargo test --no-fail-fast

# Cut a release: bump version everywhere, commit, push, trigger the workflow.
# Usage: just release 0.1.8
# Unix-only: bump-version.sh is a bash script and the release flow has
# always been driven from the maintainer's Linux/macOS box.
[unix]
[doc("Cut a release: bump version everywhere, commit, push, trigger the workflow.")]
release version:
    @./scripts/bump-version.sh {{version}}
    @if ! git diff --quiet src-tauri/Cargo.toml src-tauri/Cargo.lock package.json; then \
        git add src-tauri/Cargo.toml src-tauri/Cargo.lock package.json; \
        git commit -m "chore(release): {{version}}"; \
    fi
    @git push
    @gh workflow run release.yml -f tag={{version}}
