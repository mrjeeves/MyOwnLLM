#!/usr/bin/env bash
# MyOwnLLM dev bootstrap: install Rust, Node, pnpm, Tauri CLI, and platform dev libs.
# Idempotent — safe to re-run. Skips anything already present.

set -euo pipefail

CI_MODE=false
for arg in "$@"; do
  [[ "$arg" == "--ci" ]] && CI_MODE=true
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mxxx\033[0m %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  warn "WSL2 detected — Tauri GUI windows need an X server (WSLg or VcXsrv) to render."
fi

# ---------------------------------------------------------------------------
# Platform packages
# ---------------------------------------------------------------------------

install_linux_deps() {
  if [[ "$CI_MODE" == "true" ]]; then
    log "CI mode: skipping apt step (provide deps via workflow)"
    return
  fi
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
  fi

  case "${ID:-}" in
    ubuntu|debian|pop|linuxmint|raspbian)
      log "Installing Tauri build deps (apt)…"
      sudo apt-get update -qq
      # xdg-utils is required by Tauri's AppImage bundler (xdg-open ships
      # inside the AppImage); preinstalled on ubuntu-latest x86_64 runners
      # but missing on ubuntu-24.04-arm and Raspberry Pi OS. cmake +
      # libasound2-dev are needed by the local-transcription stack —
      # whisper-rs builds whisper.cpp from source via cmake, and cpal
      # links against ALSA on Linux. espeak-ng is the TTS (Speak)
      # phonemizer the debug-only dev resolver falls back to when the
      # bundled static build wasn't staged (src/tts/phonemes.rs).
      sudo apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
        librsvg2-dev libssl-dev xdg-utils curl wget file build-essential \
        pkg-config cmake libasound2-dev espeak-ng
      ;;
    fedora|rhel|centos)
      log "Installing Tauri build deps (dnf)…"
      sudo dnf install -y \
        webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel \
        librsvg2-devel openssl-devel curl wget file gcc gcc-c++ make \
        pkgconf-pkg-config cmake alsa-lib-devel espeak-ng
      ;;
    arch|manjaro)
      log "Installing Tauri build deps (pacman)…"
      sudo pacman -S --needed --noconfirm \
        webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl curl \
        wget file base-devel cmake alsa-lib espeak-ng
      ;;
    *)
      warn "Unrecognised Linux distro (${ID:-?}). Install Tauri deps manually:"
      warn "  https://tauri.app/start/prerequisites/#linux"
      ;;
  esac

  # The ASR / diarize backends use `ort` with `features =
  # ["load-dynamic"]`, which means libonnxruntime.so must exist at
  # runtime — it isn't statically linked at build time. apt doesn't
  # ship onnxruntime, so pull the official prebuilt that matches ort
  # 2.0.0-rc.12's api-22 expectation (ORT ≥1.20). Without this the
  # first record click hangs inside the FFI trampoline trying to
  # resolve a missing dylib.
  install_onnxruntime_linux
}

install_onnxruntime_linux() {
  # Already present anywhere src-tauri/src/ort_setup.rs searches? Skip.
  for cand in \
    /usr/local/lib/libonnxruntime.so \
    /usr/local/lib/libonnxruntime.so.1 \
    /usr/lib/libonnxruntime.so \
    /usr/lib/x86_64-linux-gnu/libonnxruntime.so \
    /usr/lib/aarch64-linux-gnu/libonnxruntime.so; do
    if [[ -f "$cand" ]]; then
      log "onnxruntime already present at $cand — skipping download."
      return
    fi
  done

  # Single source of truth — see /.ort-version in the repo root.
  # `scripts/bootstrap.sh` lives one level down, so resolve relative
  # to this script's location rather than $PWD (which varies between
  # `./scripts/bootstrap.sh` and `bash scripts/bootstrap.sh` runs).
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local ort_version_file="${script_dir}/../.ort-version"
  local ort_version="1.20.1"
  if [[ -f "$ort_version_file" ]]; then
    ort_version="$(tr -d '[:space:]' < "$ort_version_file")"
  fi
  local ort_arch
  case "$ARCH" in
    x86_64|amd64)  ort_arch="x64" ;;
    aarch64|arm64) ort_arch="aarch64" ;;
    *)
      warn "onnxruntime: no prebuilt for arch '$ARCH' — install manually from https://github.com/microsoft/onnxruntime/releases"
      return
      ;;
  esac
  local pkg="onnxruntime-linux-${ort_arch}-${ort_version}"
  local url="https://github.com/microsoft/onnxruntime/releases/download/v${ort_version}/${pkg}.tgz"

  log "Downloading onnxruntime v${ort_version} (${ort_arch}) …"
  local tmpdir
  tmpdir="$(mktemp -d)"
  # Double-quote so $tmpdir expands now (the local goes out of scope when
  # we return, and a deferred expansion under `set -u` would explode with
  # "tmpdir: unbound variable"). Disarm the trap inside its own body so it
  # doesn't re-fire when the *outer* caller (install_linux_deps) returns.
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'; trap - RETURN" RETURN
  if ! curl -fsSL "$url" -o "$tmpdir/ort.tgz"; then
    warn "onnxruntime download failed from $url — install manually."
    return
  fi
  tar -xzf "$tmpdir/ort.tgz" -C "$tmpdir"
  # The tarball contains lib/libonnxruntime.so.${ort_version} + a
  # libonnxruntime.so symlink. Drop both into /usr/local/lib and run
  # ldconfig so the dynamic loader picks them up.
  sudo install -m 0644 "$tmpdir/${pkg}/lib/libonnxruntime.so.${ort_version}" /usr/local/lib/
  sudo ln -sf "libonnxruntime.so.${ort_version}" /usr/local/lib/libonnxruntime.so
  sudo ln -sf "libonnxruntime.so.${ort_version}" /usr/local/lib/libonnxruntime.so.1
  if have ldconfig; then
    sudo ldconfig
  fi
  log "onnxruntime installed to /usr/local/lib/libonnxruntime.so.${ort_version}"
}

install_macos_deps() {
  if ! xcode-select -p >/dev/null 2>&1; then
    log "Installing Xcode Command Line Tools (you may be prompted)…"
    xcode-select --install || true
  fi
  if ! have brew; then
    warn "Homebrew not found. Install from https://brew.sh and re-run."
    return
  fi
  # cmake is required by whisper-rs's build.rs (it builds whisper.cpp from
  # source). Skipped if already present so re-runs stay fast.
  if ! have cmake; then
    log "Installing cmake (needed by whisper-rs)…"
    brew install cmake
  fi
  # onnxruntime — see Linux install for why. Homebrew ships ≥1.20 which
  # matches ort 2.0.0-rc.12's api-22 expectation. Already-installed
  # versions are upgraded so a stale 1.16 install (which loads via
  # dlopen but has a mismatched C ABI → hang at first Session call)
  # gets replaced.
  if brew list --versions onnxruntime >/dev/null 2>&1; then
    local current
    current="$(brew list --versions onnxruntime | awk '{print $2}')"
    log "onnxruntime already installed via brew (${current}). Run \`brew upgrade onnxruntime\` if Moonshine still hangs."
  else
    log "Installing onnxruntime via brew…"
    brew install onnxruntime
  fi
  # espeak-ng is the TTS (Speak) phonemizer. A release bundles its own pinned,
  # static copy (build.rs::bundle_espeak, which needs autotools); for dev the
  # debug-only resolver in src/tts/phonemes.rs falls back to this system one, so
  # `just dev` can speak without the slow from-source build.
  if ! have espeak-ng; then
    log "Installing espeak-ng (TTS phonemizer for dev)…"
    brew install espeak-ng
  fi
}

case "$OS" in
  Linux)  install_linux_deps ;;
  Darwin) install_macos_deps ;;
  *)      warn "Unsupported OS: $OS — proceeding anyway." ;;
esac

# ---------------------------------------------------------------------------
# Rust
# ---------------------------------------------------------------------------

if ! have rustup && ! have cargo; then
  log "Installing rustup…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.88.0
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
elif have rustup; then
  log "Ensuring Rust 1.88.0 is installed…"
  rustup toolchain install 1.88.0 -c clippy,rustfmt --profile minimal
fi

# ---------------------------------------------------------------------------
# Node + pnpm — `just dev` / `just build` shell out to `pnpm tauri …`, and
# Vite 6 needs Node 20+. Install a current Node when it's missing or too
# old (distro packages on Debian / Raspberry Pi OS lag well behind), then
# get pnpm through corepack. This step used to just warn and bail, which
# left `just dev` to die with "pnpm: command not found".
# ---------------------------------------------------------------------------

NODE_MAJOR=22  # LTS line to install when Node is absent or too old.

node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }

install_node_linux() {
  [[ -f /etc/os-release ]] && . /etc/os-release
  # Match on ID + ID_LIKE (space-padded) so derivatives resolve too:
  # Raspberry Pi OS is ID=raspbian ID_LIKE=debian; Pop/Mint carry
  # ID_LIKE="ubuntu debian"; etc.
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*|*" raspbian "*)
      # The distro nodejs is usually too old for Vite 6, so pull a current
      # line from NodeSource — its package bundles npm and corepack.
      log "Installing Node ${NODE_MAJOR}.x via NodeSource…"
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    *" fedora "*|*" rhel "*|*" centos "*)
      log "Installing Node via dnf…"
      sudo dnf install -y nodejs npm
      ;;
    *" arch "*)
      log "Installing Node via pacman…"
      sudo pacman -S --needed --noconfirm nodejs npm
      ;;
    *)
      warn "Don't know how to install Node on this distro (${ID:-?})."
      warn "Install Node ${NODE_MAJOR}+ from https://nodejs.org (or fnm/nvm),"
      warn "then re-run \`just setup\`."
      exit 1
      ;;
  esac
}

ensure_node() {
  if have node; then
    local maj
    maj="$(node_major)"
    if [[ -n "$maj" && "$maj" -ge 20 ]]; then
      return
    fi
    warn "Node $(node -v 2>/dev/null) is older than v20 (Vite 6 needs 20+) — installing v${NODE_MAJOR}."
  fi
  if [[ "$OS" == "Darwin" ]]; then
    if have brew; then
      log "Installing Node via brew…"
      brew install node
    else
      warn "Homebrew not found. Install Node ${NODE_MAJOR}+ from https://nodejs.org, then re-run."
      exit 1
    fi
  else
    install_node_linux
  fi
  hash -r 2>/dev/null || true  # forget the shell's cached "node not found"
}

ensure_pnpm() {
  if have pnpm; then
    return
  fi
  if have corepack; then
    log "Enabling pnpm via corepack…"
    # corepack writes its shims into Node's bin dir: a system Node
    # (NodeSource / dnf / pacman) needs sudo there, a user-managed one
    # (fnm / nvm / brew) doesn't — try without sudo first.
    corepack enable 2>/dev/null || sudo corepack enable 2>/dev/null || true
    corepack prepare pnpm@latest --activate || true
    hash -r 2>/dev/null || true
  fi
  if ! have pnpm && have npm; then
    # Node 25+ unbundled corepack; some distro Nodes ship npm only.
    log "Installing pnpm via npm…"
    sudo npm install -g pnpm 2>/dev/null || npm install -g pnpm || true
    hash -r 2>/dev/null || true
  fi
  if ! have pnpm; then
    warn "Could not put pnpm on PATH automatically. Install it manually:"
    warn "  https://pnpm.io/installation"
    exit 1
  fi
}

ensure_node
ensure_pnpm

# ---------------------------------------------------------------------------
# Tauri CLI v2 (cargo install ensures `cargo tauri` works headless too)
# ---------------------------------------------------------------------------

if ! cargo tauri --version >/dev/null 2>&1; then
  log "Installing tauri-cli@^2…"
  cargo install tauri-cli --version "^2" --locked
fi

# ---------------------------------------------------------------------------
# just (used as our task runner)
# ---------------------------------------------------------------------------

if ! have just; then
  log "Installing just…"
  if [[ "$OS" == "Darwin" ]] && have brew; then
    brew install just
  elif have cargo; then
    cargo install just --locked
  else
    warn "just not installed; skipping. Install from https://just.systems."
  fi
fi

log "Done. Try: just dev | just build | just run | just serve | just preload text vision"
