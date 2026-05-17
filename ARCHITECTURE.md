# MyOwnLLM Architecture

## What MyOwnLLM is

**MyOwnLLM is a local API surface for local AI.** A single binary exposes an OpenAI-compatible HTTP API on `127.0.0.1` that resolves "what model should I run on this machine?" against a JSON file you (or someone else) host. The GUI and CLI are two clients of that same surface; nothing in the design assumes a human is watching.

The "centralized" piece is decentralized by construction: the source of truth for which models a team uses is a static JSON file at a URL the team controls. Any host (GitHub Pages, S3, an internal HTTP server) is sufficient. Manifests can `import` other manifests to compose merged family lists across publishers.

## One picture

```
   HTTP clients ───────►  ┌──────────────────────────────────────────────────┐
   (Cursor, Continue,     │   myownllm (single binary)                          │
    Aider, agents,        │                                                  │
    your scripts)         │   axum API   (default :1473) ◄── primary surface │
                          │      │                                            │
                          │      ▼                                            │
                          │   resolver    (virtual ID → tag)                  │
                          │     │   ▲                                         │
                          │     │   │ per-file TTL, recursive imports         │
                          │     │   │ (manifests with families)               │
                          │     ▼   │                                         │
                          │   fetch & cache (~/.myownllm/cache)                  │
                          │      │                                            │
                          │      ▼                                            │
                          │   preload     (pull, warm, ensure_tracked_models)│
                          │   watcher     (5-min ticks; hot-swap on update;  │
                          │                self-update check)                 │
                          │      │                                            │
                          │      ▼                                            │
                          │   ollama.rs   (manage `ollama serve` child)       │
                          │                                                  │
                          │   CLI         ◄── thin client of the same core   │
                          │   GUI (Tauri) ◄── thin client of the same core   │
                          └──────┬───────────────────────────────────────────┘
                                 │ subprocess + HTTP 127.0.0.1:11434
                                 ▼
                          ┌─────────────┐
                          │   Ollama    │
                          └─────────────┘
```

The same Rust binary handles three personas, picked at process-start by argv:

| Invocation       | Persona                                                          |
|------------------|------------------------------------------------------------------|
| `myownllm serve`    | Headless OpenAI-compat server (the primary use case)             |
| `myownllm <cmd>`    | CLI (status, models, providers, families, preload, import/export) |
| `myownllm`          | GUI (Tauri); also runs the API server alongside                  |

## The provider/family ecosystem

One kind of JSON file:

- **Manifest** — `{ name, version, ttl_minutes?, default_family, families: { ... }, imports?, headroom_gb?, shared_modes? }`. Each family declares its own `default_mode` and per-mode tier table; the resolver walks `families[active_family].modes[active_mode].tiers` against the local hardware. The user picks active provider + active family; the rest is automatic.

`imports` is an array of URLs to other manifests. The fetcher walks them recursively, dedupes by URL, detects cycles, and merges family maps in document order (the importing file's own families win on key collision). **Each imported file is fetched and cached against its own `ttl_minutes`** — the recursion does not flatten TTL, so a slow-changing top-level manifest can import a fast-moving one without the publisher having to coordinate.

That per-file TTL is also how publishers express rate-limit expectations: a manifest hosted on a free static host might say `ttl_minutes: 1440` to keep load down; a high-availability commercial endpoint might say `5`.

### Tier resolution and unified memory

A tier carries three RAM/VRAM thresholds because Apple Silicon and discrete GPUs behave differently:

- `min_vram_gb` — primary discrete-GPU path. Matches when `vram_gb >= min_vram_gb`. The number already includes KV-cache / activation overhead and any VRAM the paired transcribe runtime would also claim, so the resolver and the displayed "Needs ~X GB VRAM" hint use exactly the same number.
- `min_ram_gb` — last-resort CPU-fallback path on discrete GPU. Only consulted when the primary VRAM walk produced no hit at all (e.g. a 2 GB GPU staring at a ladder whose bottom rung needs 4 GB). Matches when `ram_gb - headroom_gb[gpu_type]` clears the bar; the model lives in system RAM and inference runs on CPU. Rare in practice — every shipped family ladder ends in a `min_vram_gb=0` rung, so the VRAM walk almost always matches first.
- `min_unified_ram_gb` — unified-memory path (Apple, integrated GPUs, CPU-only SBCs). Matches against raw RAM. The publisher has already factored in OS headroom and the paired transcribe model, so a single number captures "this machine can host text + audio together". Omitted on legacy tiers, in which case the resolver synthesises `min_ram_gb + headroom_gb[gpu_type]` so older manifests keep working.

**Two-pass walk (schema v19).** The resolver walks the ladder twice on discrete GPU: first for VRAM-fitting tiers (primary), then — only if nothing matched — for CPU-fittable tiers. The previous OR-fallback would silently promote a 24 GB 3090 to a 28 GB tier via system RAM, then display "Needs ~28 GB VRAM" the GPU couldn't deliver. The two-pass walk keeps the displayed hint honest: the recommended tier is always one the GPU can actually host, with CPU fallback called out explicitly in the Family detail header when it triggers.

`headroom_gb` is a manifest-level map (`apple`/`none`/`nvidia`/`amd` → GB) that reserves system overhead for the OS, WebView, ollama daemon, and the paired ASR model (Moonshine ~150 MB resident on Pi-class, Parakeet ~700 MB on capable hardware). Compiled-in defaults: `apple: 5, none: 2, nvidia: 1, amd: 1`. Apple is highest because macOS + browser tabs share the LLM pool; discrete-GPU hosts are lowest because the LLM lives on the card and system RAM only hosts the client. When diarization is enabled, the resolver subtracts an additional ~0.5 GB for the pyannote pipeline.

`shared_modes` lets a manifest publish canonical mode blocks once and have every family inherit them without redeclaring tiers. Today's default manifest ships two shared modes: **`transcribe`** (per-tier ASR runtime: Moonshine on the Pi rung, Parakeet on the capable rung) and **`diarize`** (pyannote pipeline, opt-in via the transcribe pane's "Identify speakers" toggle). A family's own `modes[k]` always wins on collision, so a family can override either ladder without forking the schema.

**Per-tier `runtime` (schema v13).** `ManifestTier` carries an optional `runtime` field that overrides the mode-level default. This is how a single transcribe ladder promotes capable hardware to Parakeet while the bottom rung stays on Moonshine. Resolution order: `tier.runtime` → `mode.runtime` → `default_runtime_for(mode)` (`transcribe → moonshine`, `diarize → pyannote-diarize`, everything else → `ollama`).

## Modules (Rust)

| File | Role |
|------|------|
| `main.rs` | argv branching; setup hook spawns watcher, self-update checker, and API server. |
| `cli.rs`  | Every CLI subcommand. |
| `api.rs`  | axum router, virtual-ID resolution, pull-on-demand, model rewrite. |
| `api_models.rs` | OpenAI-compatible request/response types. |
| `resolver.rs` | Manifest fetch + per-file TTL cache, recursive imports with cycle detection, family + hardware-tier walk, virtual-ID map. Mirrors `src/manifest.ts`. |
| `preload.rs` | `preload(modes, …)` + `ensure_tracked_models()` reconcile loop. |
| `watcher.rs` | Background ticker (every 5 min) that re-runs `ensure_tracked_models`, recomputes model-status, and triggers `self_update::tick`. Process lock at `~/.myownllm/watcher.lock`. |
| `self_update.rs` | Periodic GitHub-releases check, channel-aware (stable/beta), patch auto-apply, atomic rename-on-restart, package-manager-install detection (no-op when installed via brew/apt/rpm/MSI). |
| `hardware.rs` | nvidia-smi / rocm-smi / sysctl / /proc detection. |
| `ollama.rs` | spawn/stop `ollama serve`, pull, list, delete, warm, has_model. |
| `purge.rs` | Danger-zone resets: `purge_models` / `purge_conversations` / `purge_all`. Shared between the Storage tab's "Danger zone" Tauri commands and `myownllm purge` in the CLI. |
| `mesh/` | Cloud Mesh substrate. `identity.rs` owns the long-lived ed25519 keypair persisted to `~/.myownllm/.secrets/identity.json` (0600 on Unix), generated lazily on first mesh-tab visit. `commands.rs` exposes `mesh_identity_get` / `mesh_identity_set_label` / `mesh_network_id_generate` / `mesh_network_id_normalize` to the GUI. Wire transport (signaling, WebRTC, gossip, roster CRDT, Move) lives in upcoming submodules; identity + Network ID handling is the shipped surface. |

## Modules (TypeScript)

The TS layer is the GUI's source of truth. The Rust layer reads the same on-disk caches/config so headless commands work without booting Node.

| File | Role |
|------|------|
| `config.ts` | Read/write `~/.myownllm/config.json` with default-merge for upgrades. |
| `manifest.ts` | `getManifest(url)` (per-file TTL cached, recursive imports), `resolveModel`, `pickFamily`, `familyModes`, `allRecommendedModels`. |
| `providers.ts` | CRUD over saved providers, plus `getActiveFamily` / `setActiveFamily`. |
| `model-lifecycle.ts` | `recomputeRecommendedSet`, `runCleanup`, `pruneNow`, `markEvictedNow`. |
| `import-export.ts` | Bundle config to/from `myownllm:import:…` URLs. |
| `preload.ts`, `watcher.ts` | Thin Tauri-invoke wrappers for the Rust counterparts. |
| `mesh.ts`, `mesh-state.svelte.ts` | Cloud Mesh bindings + reactive UI state. `mesh.ts` wraps the four Rust commands; `mesh-state.svelte.ts` caches the identity readout for the session and exposes an `ensureLoaded()` for the Cloud Mesh settings tab. |
| `settings-attention.svelte.ts` | Generic per-tab attention indicator registry. `SettingsPanel` renders dots from this store; the legacy `updateUi.available` signal is mirrored into it so the existing Updates dot keeps working through the unified path. New tabs that need a dot just call `settingsAttention.set(tabId, …)`. |
| `ui/*.svelte` | Svelte 5 UI. |

## Live update lifecycle

```
  Manifest URL changes (provider edit) or contents change (TTL refresh) or
  imported manifest changes (its own TTL refresh)
       │
       ▼
  watcher tick (5 min)  ── or ──  CLI provider/family mutation
       │
       ▼
  preload::ensure_tracked_models()
       │
       ├─ for each tracked mode: resolver::resolve(mode) → new tag
       │       │   (resolve fetches the manifest, recurses imports,
       │       │    each at its own TTL, merged in document order)
       │       │
       │       ├─ if tag not pulled  → ollama::pull_with(...)
       │       └─ if tag changed     → emit myownllm://mode-swap
       │
       ▼
  watcher::recompute_status_from_disk()
       │
       └─ writes ~/.myownllm/cache/model-status.json
              old tag's recommended_by becomes empty
              last_recommended timestamp = now (clock starts)
              model-lifecycle.runCleanup() will evict after model_cleanup_days
```

Hot-swap semantics: the OpenAI server reads `resolver::resolve(mode)` per request, so the next call after a swap hits the new tag transparently. In-flight streams keep using the old tag (Ollama keeps it loaded for `keep_alive`).

## Self-update lifecycle

```
  watcher tick (every 5 min)
       │
       ▼
  self_update::tick()
       │
       ├─ install kind?
       │     └─ homebrew / dpkg / rpm / MSI / chocolatey  → return (defer to PM)
       │     └─ raw binary on PATH                        → continue
       │
       ├─ HEAD https://api.github.com/repos/…/releases/{channel}
       │     (etag-cached; cheap when unchanged)
       │
       ├─ new tag, same major.minor → patch:  auto-apply
       │   new tag, different minor or major:  download, stage, notify
       │
       ├─ download asset for current platform
       ├─ verify SHA256 from release manifest
       ├─ stage at  ~/.myownllm/updates/<version>/myownllm(.exe)
       │
       └─ on next launch (or on SIGTERM if running as daemon):
             atomically rename staged binary over the running one
             (Windows: scheduled rename via MoveFileEx + restart)
```

Config (in `~/.myownllm/config.json`):

```jsonc
{
  "auto_update": {
    "enabled": true,
    "channel": "stable",          // "stable" | "beta"
    "auto_apply": "patch",        // "patch" | "minor" | "all" | "none"
    "check_interval_hours": 6,
    "stable_url": null,           // optional override; falls back to build-time default
    "beta_url": null              // optional override; falls back to build-time default
  }
}
```

Disabling: `myownllm update disable`, the "Automatic updates" toggle in the GUI's Settings → Updates tab, `auto_update.enabled = false` in config, or `MYOWNLLM_AUTOUPDATE=0` for a one-shot opt-out. When MyOwnLLM detects a package-manager install, the updater logs a one-line note and stays out of the way regardless of config.

Redirecting the release feed: set `auto_update.stable_url` / `auto_update.beta_url` in config, or bake new defaults into a build with the `MYOWNLLM_RELEASE_URL_STABLE` / `MYOWNLLM_RELEASE_URL_BETA` env vars at compile time (resolved via `option_env!` in `self_update.rs`, the same pattern `providers/preset.json` uses for shipping build-time provider defaults).

## Why no extra HTTP framework?

- **axum** for the server: tower-compatible, ergonomic streaming via `Body::from_stream`, ~3 MB stripped impact. Already paired with `reqwest` for upstream calls (rustls-tls so we don't pull OpenSSL on Linux).
- **No router for the GUI** — Tauri IPC handles that.
- **No global state crate** — `OnceLock<Mutex<…>>` covers the per-process locks we need (Ollama child handle, watcher start gate, preload mutex).

## Persistence

```
~/.myownllm/
├── config.json                       (user settings + tracked_modes + api + auto_update)
├── watcher.lock                      (PID; cooperative process lock)
├── updates/                          (staged self-update binaries)
└── cache/
    ├── manifests/<hash>.json         (manifest + fetched_at, per-URL — imports cached separately)
    └── model-status.json             (recommended_by + last_recommended per tag)
```
