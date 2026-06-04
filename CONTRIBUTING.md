# Contributing to MyOwnLLM

## Setup

```bash
git clone https://github.com/mrjeeves/MyOwnLLM
cd MyOwnLLM
just setup        # installs Rust 1.88, Node, pnpm, Tauri CLI, GTK deps on Linux
just dev          # hot-reload GUI
# or
just run -- run   # CLI chat
just serve        # OpenAI-compat server on :1473
just preload text vision
```

`just setup` is idempotent — re-run any time. See [`scripts/bootstrap.sh`](scripts/bootstrap.sh) for what it does.

### Text-to-speech in dev

The **Speak** button phonemizes with espeak-ng. A release bundles its own
pinned, static copy (built from source by `build.rs`); for local dev the
resolver in `src-tauri/src/tts/phonemes.rs` falls back to a **system**
`espeak-ng` (installed by `just setup`) in debug builds, so `just dev` /
`cargo run` speak without the slow from-source build. No system espeak-ng and no
bundle → the Speak button degrades to your OS WebSpeech voices. To exercise the
exact bundled build locally, install the autotools it needs (`brew install
autoconf automake libtool`, or `apt-get install autoconf automake libtool
pkg-config`) and run `just build`.

## Repo layout

- `src-tauri/src/` — Rust: CLI, OpenAI-compat server, hardware detection, Ollama wrapper, watcher.
- `src/` — TypeScript + Svelte: GUI, manifest/source/provider logic, model lifecycle.
- `manifests/`, `providers/` — bundled defaults shipped with the binary.
- `scripts/` — one-line installer + bootstrap.
- `Justfile` — task runner.

## Before opening a PR

```bash
just check    # cargo fmt + clippy + svelte-check + tests
just fmt      # auto-format
```

CI runs the same on Linux/macOS/Windows. PRs that don't pass `just check` won't be reviewed.

## Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(api): add /v1/embeddings`
- `fix(cli): preload --json should not interleave with stderr`
- `docs(readme): document virtual model IDs`

## Architecture notes

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the high-level design and the request-flow diagrams.

## Filing bugs

Include the output of `myownllm status --json` and `myownllm --version` in every bug report. If the API server is involved, include a `curl -i` of the failing request.
