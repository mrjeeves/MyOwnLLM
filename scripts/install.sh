#!/bin/sh
# MyOwnLLM end-user installer.
#
# Tries (in order):
#   1. Download a pre-built release binary from GitHub for the current platform.
#   2. Fall back to building from source via scripts/bootstrap.sh.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh -s -- --run
#   ./scripts/install.sh --dry-run
#
# This script is intentionally POSIX sh-compatible so that `curl … | sh` works
# under dash, ash/busybox sh, and bash alike. Avoid bash-only constructs
# ([[ ]], RETURN traps, ${var^^}, arrays, etc.).

set -eu
# pipefail is supported by bash, ksh, zsh, and dash >= 0.5.10. Enable it when
# the running shell understands it; otherwise carry on without it.
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

REPO="${MYOWNLLM_REPO:-mrjeeves/MyOwnLLM}"
DRY_RUN=false
RUN_AFTER=false
PREFIX_DIR="${MYOWNLLM_PREFIX:-}"
FORCE_SOURCE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=true ;;
    --run)         RUN_AFTER=true ;;
    --from-source) FORCE_SOURCE=true ;;
    --prefix=*)    PREFIX_DIR="${arg#*=}" ;;
    *) ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mxxx\033[0m %s\n' "$*" >&2; }

OS_RAW="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS_RAW" in
  darwin) OS="macos" ;;
  linux)  OS="linux" ;;
  *)      OS="$OS_RAW" ;;
esac
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)  ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *)             ARCH="$ARCH_RAW" ;;
esac
ASSET="myownllm-${OS}-${ARCH}.tar.gz"

# Pick install prefix. Prefer /usr/local/bin if writable; else ~/.local/bin.
if [ -z "$PREFIX_DIR" ]; then
  if [ -w /usr/local/bin ] || sudo -n true 2>/dev/null; then
    PREFIX_DIR="/usr/local/bin"
  else
    PREFIX_DIR="$HOME/.local/bin"
  fi
fi

install_binary() {
  src="$1"
  mkdir -p "$PREFIX_DIR"
  if [ -w "$PREFIX_DIR" ]; then
    install -m 0755 "$src" "$PREFIX_DIR/myownllm"
  else
    sudo install -m 0755 "$src" "$PREFIX_DIR/myownllm"
  fi
  log "Installed: $PREFIX_DIR/myownllm"
}

# MyOwnLLM is a Tauri app: every binary, including CLI subcommands, is dynamically
# linked against libwebkit2gtk-4.1.so.0 (Tauri's webview). On a fresh Linux box
# without those system libs, the dynamic loader bails before main() runs and
# the user sees:
#   myownllm: error while loading shared libraries: libwebkit2gtk-4.1.so.0: …
# Even `myownllm setup` can't recover from that — the binary never executes.
# Install the runtime libs at install time so the first launch just works.
#
# Privilege-escalation rules:
#   - Already root → run the package manager directly.
#   - Non-root → just call `sudo …`. sudo prompts via /dev/tty (not stdin), so
#     this works even under `curl … | sh` where the script's stdin is the pipe.
#     If sudo can't get credentials (no tty, no askpass, no cached creds), the
#     command exits non-zero and we surface a clear "run this yourself" error.
#   - DEBIAN_FRONTEND=noninteractive + dpkg confdef/confold flags keep apt from
#     stalling on a debconf prompt that nobody is around to answer.
#
# Previously the script tried to detect "sudo can't prompt" up-front (via
# `sudo -n true || [ -t 0 ]`) and *skipped* the install with a warning when
# it thought sudo wouldn't work — which silently left fresh boxes with a
# binary that can't launch. Now: try once, fail loudly, return non-zero so
# the caller aborts instead of pretending the install succeeded.
install_linux_runtime_deps() {
  [ "$OS" = "linux" ] || return 0
  [ "$DRY_RUN" = "true" ] && { log "(dry-run) would install Linux runtime deps"; return 0; }

  if command -v apt-get >/dev/null 2>&1; then
    log "Installing Linux runtime libraries via apt (libwebkit2gtk-4.1, libayatana-appindicator3, librsvg2)…"
    pkgs="libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2"
    apt_opts="-y --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
    if [ "$(id -u)" = "0" ]; then
      env DEBIAN_FRONTEND=noninteractive apt-get update -qq \
        && env DEBIAN_FRONTEND=noninteractive apt-get install $apt_opts $pkgs \
        || { _runtime_dep_failure "apt-get" "$pkgs" "sudo apt-get install -y $pkgs"; return 1; }
    else
      sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq \
        && sudo env DEBIAN_FRONTEND=noninteractive apt-get install $apt_opts $pkgs \
        || { _runtime_dep_failure "sudo apt-get" "$pkgs" "sudo apt-get install -y $pkgs"; return 1; }
    fi
  elif command -v dnf >/dev/null 2>&1; then
    log "Installing Linux runtime libraries via dnf…"
    pkgs="webkit2gtk4.1 libappindicator-gtk3 librsvg2"
    if [ "$(id -u)" = "0" ]; then
      dnf install -y $pkgs || { _runtime_dep_failure "dnf" "$pkgs" "sudo dnf install -y $pkgs"; return 1; }
    else
      sudo dnf install -y $pkgs || { _runtime_dep_failure "sudo dnf" "$pkgs" "sudo dnf install -y $pkgs"; return 1; }
    fi
  elif command -v pacman >/dev/null 2>&1; then
    log "Installing Linux runtime libraries via pacman…"
    pkgs="webkit2gtk-4.1 libappindicator-gtk3 librsvg"
    if [ "$(id -u)" = "0" ]; then
      pacman -S --noconfirm --needed $pkgs || { _runtime_dep_failure "pacman" "$pkgs" "sudo pacman -S $pkgs"; return 1; }
    else
      sudo pacman -S --noconfirm --needed $pkgs || { _runtime_dep_failure "sudo pacman" "$pkgs" "sudo pacman -S $pkgs"; return 1; }
    fi
  else
    err "Unrecognized Linux distro — cannot auto-install Tauri runtime libs."
    err "Install your distro's equivalents of webkit2gtk-4.1, libayatana-appindicator3,"
    err "and librsvg2, then re-run this installer."
    return 1
  fi

  log "Runtime libraries installed."
  return 0
}

_runtime_dep_failure() {
  err "$1 failed to install the MyOwnLLM runtime libraries: $2"
  err "MyOwnLLM cannot launch without these (the binary is dynamically linked"
  err "against libwebkit2gtk-4.1.so.0). Install them yourself and re-run:"
  err "  $3"
}

# MyOwnLLM transcription requires onnxruntime ≥1.24 (ort 2.0.0-rc.12 +
# api-22). It's not bundled in the release tarball — keeps the artifact
# lean and lets us ship a single binary per platform — so we fetch
# Microsoft's prebuilt and drop the dylib next to the binary at install
# time. The app has an in-process fallback that fetches the same dylib
# into ~/.myownllm/runtime/ on first launch if we miss it here, so
# "warn and continue" is safe.
install_onnxruntime() {
  [ "$DRY_RUN" = "true" ] && { log "(dry-run) would fetch onnxruntime"; return 0; }

  # Read the pinned version from the source we built/installed from.
  # In the canonical curl|sh path the .ort-version file lives in the
  # tagged repo, so fetch it over raw.githubusercontent. Fall back to
  # a sensible default rather than failing if the network blip caught
  # this specific request.
  ort_version=""
  if command -v curl >/dev/null 2>&1; then
    ort_version="$(curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/.ort-version" 2>/dev/null | tr -d '[:space:]')"
  fi
  if [ -z "$ort_version" ] && [ -f .ort-version ]; then
    ort_version="$(tr -d '[:space:]' < .ort-version)"
  fi
  if [ -z "$ort_version" ]; then
    ort_version="1.24.2"
    warn "couldn't read .ort-version; falling back to ${ort_version}"
  fi

  case "$OS-$ARCH" in
    macos-aarch64) pkg="onnxruntime-osx-arm64-${ort_version}";   ext="tgz" ;;
    macos-x86_64)  pkg="onnxruntime-osx-x86_64-${ort_version}";  ext="tgz" ;;
    linux-x86_64)  pkg="onnxruntime-linux-x64-${ort_version}";   ext="tgz" ;;
    linux-aarch64) pkg="onnxruntime-linux-aarch64-${ort_version}"; ext="tgz" ;;
    *)
      warn "onnxruntime: no prebuilt for ${OS}-${ARCH} — install manually from https://github.com/microsoft/onnxruntime/releases"
      return 0
      ;;
  esac
  url="https://github.com/microsoft/onnxruntime/releases/download/v${ort_version}/${pkg}.${ext}"

  log "Downloading onnxruntime v${ort_version} (${OS}-${ARCH})…"
  tmp="$(mktemp -d)"
  if ! curl -fsSL "$url" -o "$tmp/ort.tgz"; then
    warn "onnxruntime download failed from $url"
    warn "Transcription will fail until you fix this. Recovery options:"
    warn "  1. Re-run this installer when networking is back."
    warn "  2. Run \`myownllm fetch-onnxruntime\` to retry from the app."
    warn "  3. Place libonnxruntime manually under \$HOME/.myownllm/runtime/."
    rm -rf "$tmp"
    return 0
  fi
  if ! tar -xzf "$tmp/ort.tgz" -C "$tmp"; then
    warn "onnxruntime archive extraction failed — try \`myownllm fetch-onnxruntime\`."
    rm -rf "$tmp"
    return 0
  fi

  # Where to place the dylib. PREFIX_DIR is the bin dir we just put
  # myownllm in; the binary's `current_exe()/..` is the second entry
  # in the search list (see src-tauri/src/ort_setup.rs), so putting
  # the dylib alongside the binary just works. On Linux we keep both
  # the versioned `.so.${V}` and an unversioned `.so` symlink so the
  # ort_setup search finds the file under either name.
  if [ "$OS" = "linux" ]; then
    src="$tmp/${pkg}/lib/libonnxruntime.so.${ort_version}"
    [ -f "$src" ] || src="$(find "$tmp/${pkg}/lib" -maxdepth 1 -name 'libonnxruntime.so*' -type f | head -n1)"
    if [ -z "$src" ] || [ ! -f "$src" ]; then
      warn "couldn't locate libonnxruntime.so in $tmp/${pkg}/lib"
      rm -rf "$tmp"; return 0
    fi
    _install_with_sudo "$src" "$PREFIX_DIR/libonnxruntime.so.${ort_version}" 0644
    _symlink_with_sudo "libonnxruntime.so.${ort_version}" "$PREFIX_DIR/libonnxruntime.so"
    _symlink_with_sudo "libonnxruntime.so.${ort_version}" "$PREFIX_DIR/libonnxruntime.so.1"
  elif [ "$OS" = "macos" ]; then
    src="$tmp/${pkg}/lib/libonnxruntime.${ort_version}.dylib"
    [ -f "$src" ] || src="$(find "$tmp/${pkg}/lib" -maxdepth 1 -name 'libonnxruntime*.dylib' -type f | head -n1)"
    if [ -z "$src" ] || [ ! -f "$src" ]; then
      warn "couldn't locate libonnxruntime.dylib in $tmp/${pkg}/lib"
      rm -rf "$tmp"; return 0
    fi
    _install_with_sudo "$src" "$PREFIX_DIR/libonnxruntime.dylib" 0644
  fi
  rm -rf "$tmp"
  log "onnxruntime v${ort_version} installed to $PREFIX_DIR/"
}

# Common install primitive: same sudo-fallback logic as install_binary,
# parameterised so the ort install can reuse it without duplicating the
# permission probe.
_install_with_sudo() {
  src="$1"; dst="$2"; mode="$3"
  dst_dir="$(dirname "$dst")"
  mkdir -p "$dst_dir" 2>/dev/null || sudo mkdir -p "$dst_dir"
  if [ -w "$dst_dir" ]; then
    install -m "$mode" "$src" "$dst"
  else
    sudo install -m "$mode" "$src" "$dst"
  fi
}

_symlink_with_sudo() {
  target="$1"; link="$2"
  link_dir="$(dirname "$link")"
  if [ -w "$link_dir" ]; then
    ln -sf "$target" "$link"
  else
    sudo ln -sf "$target" "$link"
  fi
}

ensure_on_path() {
  case ":$PATH:" in
    *":$PREFIX_DIR:"*) return 0 ;;
  esac

  shell_name="$(basename "${SHELL:-bash}")"
  marker="# added by myownllm installer"
  case "$shell_name" in
    zsh)
      rc="$HOME/.zshrc"
      line="export PATH=\"$PREFIX_DIR:\$PATH\"  $marker"
      ;;
    fish)
      rc="$HOME/.config/fish/config.fish"
      line="fish_add_path -g $PREFIX_DIR  $marker"
      ;;
    *)
      rc="$HOME/.bashrc"
      line="export PATH=\"$PREFIX_DIR:\$PATH\"  $marker"
      ;;
  esac

  if grep -qsF "$marker" "$rc" 2>/dev/null; then
    warn "$PREFIX_DIR not on current PATH; PATH already added to $rc — open a new terminal."
    return 0
  fi

  mkdir -p "$(dirname "$rc")"
  if printf '\n%s\n' "$line" >> "$rc" 2>/dev/null; then
    log "Added $PREFIX_DIR to PATH in $rc"
    log "Open a new terminal (or run: source $rc) for it to take effect."
  else
    warn "$PREFIX_DIR is not on PATH. Add this to your shell rc:"
    warn "  $line"
  fi
}

# Tracked for cleanup since POSIX sh has no function-scoped RETURN trap.
_TRY_RELEASE_TMP=""
_cleanup_try_release() {
  if [ -n "$_TRY_RELEASE_TMP" ] && [ -d "$_TRY_RELEASE_TMP" ]; then
    rm -rf "$_TRY_RELEASE_TMP"
  fi
  _TRY_RELEASE_TMP=""
}

try_release() {
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl missing; skipping release download."
    return 1
  fi
  api="https://api.github.com/repos/${REPO}/releases/latest"
  log "Looking up latest release: $api"
  if ! json="$(curl -fsSL "$api" 2>/dev/null)"; then
    warn "GitHub releases unreachable (or no release yet)."
    return 1
  fi
  url="$(printf '%s' "$json" | grep -Eo "https://[^\"]+/${ASSET}" | head -n1 || true)"
  if [ -z "$url" ]; then
    warn "No release asset matched ${ASSET}."
    return 1
  fi
  sha_url="${url}.sha256"
  log "Downloading $url"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would download $url"
    return 0
  fi
  _TRY_RELEASE_TMP="$(mktemp -d)"
  trap _cleanup_try_release EXIT INT TERM
  curl -fsSL "$url" -o "$_TRY_RELEASE_TMP/$ASSET"
  if curl -fsSL "$sha_url" -o "$_TRY_RELEASE_TMP/$ASSET.sha256" 2>/dev/null; then
    (cd "$_TRY_RELEASE_TMP" && sha256sum -c "$ASSET.sha256" 2>/dev/null || shasum -a 256 -c "$ASSET.sha256")
  else
    warn "No SHA256 sidecar; skipping integrity check."
  fi
  tar -xzf "$_TRY_RELEASE_TMP/$ASSET" -C "$_TRY_RELEASE_TMP"
  install_binary "$_TRY_RELEASE_TMP/myownllm"
  _cleanup_try_release
  trap - EXIT INT TERM
  return 0
}

build_from_source() {
  log "Building from source…"
  if ! command -v git >/dev/null 2>&1; then
    err "git is required to build from source."
    exit 1
  fi
  if [ -f Justfile ] && [ -d src-tauri ]; then
    repo_dir="$(pwd)"
    log "Using current directory as source: $repo_dir"
  else
    repo_dir="$(mktemp -d)/MyOwnLLM"
    log "Cloning into $repo_dir"
    if [ "$DRY_RUN" != "true" ]; then
      git clone --depth 1 "https://github.com/${REPO}.git" "$repo_dir"
    fi
  fi
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would bootstrap and build in $repo_dir"
    return 0
  fi
  ( cd "$repo_dir" && bash scripts/bootstrap.sh )
  ( cd "$repo_dir" && pnpm install --frozen-lockfile && pnpm tauri build )
  built="$repo_dir/src-tauri/target/release/myownllm"
  if [ ! -x "$built" ]; then
    err "Build did not produce $built"
    exit 1
  fi
  install_binary "$built"
}

if [ "$FORCE_SOURCE" = "true" ] || ! try_release; then
  build_from_source
fi

# Install runtime libs after the binary is in place. Doing it here (rather than
# inside try_release / build_from_source) means we run it once even if we fall
# back from a release download to a source build.
#
# If this fails we exit non-zero: the binary is on disk, but it won't launch
# until the libs are installed. Continuing silently was the old behaviour and
# left users with a "myownllm: command does nothing" mystery on first run.
if ! install_linux_runtime_deps; then
  err "Aborting: $PREFIX_DIR/myownllm is on disk but cannot launch without the libs above."
  exit 1
fi

# Best-effort onnxruntime fetch. Failures fall through to the in-app
# first-run fetcher (which writes to ~/.myownllm/runtime/ instead of
# the install prefix), so we don't abort the install — the user can
# still launch the GUI, chat, and use the API server without ORT, and
# transcription will recover itself on first launch.
install_onnxruntime || warn "onnxruntime install skipped — will fetch on first launch."

if [ "$DRY_RUN" != "true" ]; then
  ensure_on_path
fi

if [ "$RUN_AFTER" = "true" ] && [ "$DRY_RUN" != "true" ]; then
  log "Launching myownllm run…"
  exec "$PREFIX_DIR/myownllm" run
fi

log "Done."
log ""
log "Quick start:"
log "  myownllm serve    # OpenAI/Ollama/Anthropic-compatible API on :1473 (works headless)"
log "  myownllm run      # terminal chat (works headless)"
log "  myownllm status   # provider, hardware, daemon, update"
log "  myownllm          # desktop GUI (needs a display — X11 or Wayland)"
