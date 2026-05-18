# MyOwnLLM Reference

Full reference manual for MyOwnLLM. For a one-page overview and quick start, see [README.md](README.md). For internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [API server](#api-server)
- [Connecting client apps](#connecting-client-apps)
- [CLI reference](#cli-reference)
  - [Run / Chat](#run--chat)
  - [Status](#status)
  - [Models](#models)
  - [Providers](#providers)
  - [Families](#families)
  - [Preload](#preload)
  - [Import & Export](#import--export)
  - [Update](#update)
- [GUI](#gui)
- [Cloud Mesh](#cloud-mesh)
- [Provider system](#provider-system)
- [Manifest format](#manifest-format)
- [Imports & merged catalogs](#imports--merged-catalogs)
- [Auto-update](#auto-update)
- [Model lifecycle & cleanup](#model-lifecycle--cleanup)
- [Scriptability](#scriptability)
- [Config files](#config-files)
- [Building from source](#building-from-source)
- [Repackaging for your org](#repackaging-for-your-org)

---

## How it works

```
myownllm serve
  1. Detect GPU (nvidia-smi / rocm-smi / system_profiler) and RAM
  2. Fetch active provider's manifest (cached against the manifest's own TTL)
  3. Walk tiers top-to-bottom → pick best model this hardware can run
  4. Auto-install Ollama if missing
  5. Pull the resolved tag if not already on disk (with progress)
  6. Start ollama serve (managed child process)
  7. Listen on 127.0.0.1:1473, expose virtual model IDs
```

On every request: re-resolve, hot-swap if upstream changed, return. A 5-minute background watcher keeps tracked modes warm and checks for self-updates so the binary itself stays current with no user intervention. You never interact with Ollama directly; MyOwnLLM manages it as a child process.

---

## Installation

### Requirements

- macOS 12+, Linux (x86_64 or aarch64), or Windows 10+
- Internet on first run (to pull the model — typically 3–15 GB)
- Ollama is auto-installed if missing

### Small systems (Raspberry Pi 4 / Pi 5)

MyOwnLLM ships native `linux-aarch64` builds, so a 64-bit Raspberry Pi OS install is a one-liner. The hardware detector reads `/proc/device-tree/model` and `/proc/cpuinfo`, surfaces the board name (e.g. "Raspberry Pi 5 Model B") in the GUI and `myownllm status`, and walks a CPU-friendly tier ladder so a 2 GB Pi 4 lands on `llama3.2:1b` while a 16 GB Pi 5 reaches `gemma4:e4b`.

Gemma 4's edge variants (`e2b` / `e4b`) are the recommended default on Pi 5 — they're built for offline edge inference, are multimodal (text + image + audio-visual), and run completely offline at ~7.6 tok/s on a Pi 5 thanks to per-layer activations that keep the runtime footprint near 2B / 4B parameters regardless of the full weight count.

| Board                 | Default text model |
|-----------------------|--------------------|
| Pi 4 / Pi 5 — 2 GB    | `llama3.2:1b`      |
| Pi 4 / Pi 5 — 4 GB    | `llama3.2:3b`      |
| Pi 4 / Pi 5 — 8 GB    | `gemma4:e2b`       |
| Pi 5 — 16 GB          | `gemma4:e4b`       |

Notes:
- Use **64-bit Raspberry Pi OS** (Bookworm or newer). 32-bit (`armv7l`) is not a release target.
- Ollama installs through its official script on Pi 4/5 (aarch64). If that fails on a constrained image, run `myownllm serve --no-ollama` and point Ollama at `127.0.0.1:11434` yourself.
- Override the picked model anytime: `myownllm preload text --model llama3.2:1b --track`.

### One-line (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh
```

The installer downloads a pre-built binary from the latest GitHub release. If no release matches your platform it falls back to building from source via `scripts/bootstrap.sh`. Pass `--run` to launch immediately:

```bash
curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh -s -- --run
```

### One-line (Windows, PowerShell)

```powershell
irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1 | iex
```

To launch immediately after install:

```powershell
iex "& { $(irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1) } -Run"
```

### From source

See [Building from source](#building-from-source).

---

## API server

`myownllm serve` is the primary surface. It speaks OpenAI's wire format on `127.0.0.1:1473` so anything that already speaks that wire format — Cursor, Continue, Aider, custom agents, your own scripts — works against it as a drop-in provider.

```bash
myownllm serve                                       # 127.0.0.1:1473
myownllm serve --port 8080
myownllm serve --host 0.0.0.0 --bearer-token sk-…    # expose to LAN with auth
myownllm serve --no-ollama                           # don't auto-start ollama
```

### Endpoints

| Path | Behaviour |
|------|-----------|
| `POST /v1/chat/completions` | OpenAI chat. Streams when `stream: true`. |
| `POST /v1/completions`      | Legacy completions. |
| `POST /v1/embeddings`       | Proxied to Ollama embeddings. |
| `GET  /v1/models`           | Virtual model IDs + raw pulled tags. |
| `GET  /healthz`             | 200 if Ollama reachable, else 503. |
| `POST /v1/myownllm/preload`    | Body `{"modes":[…], "track":bool}`; SSE progress. |
| `GET  /v1/myownllm/status`     | Current resolved tag per tracked mode. |

### Virtual model IDs

These resolve at request-time to whatever tag your manifest currently selects for your hardware. Client-side configuration stays stable forever — the underlying tag swaps automatically when upstream JSON changes.

| Model ID              | Resolves to (example) |
|-----------------------|-----------------------|
| `myownllm`            | `gemma4:e4b`          |
| `myownllm-transcribe` | `parakeet:parakeet-tdt-0.6b-v3-int8` |

Every response includes `X-MyOwnLLM-Resolved-Model` so a client (or a log) can see what tag actually served the request.

If a virtual model's tag isn't pulled yet, the server returns `503` with `Retry-After: 10` and a JSON body describing pull progress. Pass `?wait=true` (or header `X-MyOwnLLM-Wait: true`) to hold the connection and stream pull progress as SSE keep-alives instead.

The GUI also runs the API server on the same port by default — disable via `config.json` (`api.enabled: false`).

---

## Connecting client apps

Most consumer-facing AI apps advertise a "local model" toggle and then leave you to figure out the actual fields. MyOwnLLM speaks OpenAI's HTTP wire format on `127.0.0.1:1473`, so anything that supports a custom OpenAI base URL is a drop-in.

The universal answer to *"how do I point [client] at my local LLM?"* is always these four values:

| Field    | Value                                              |
|----------|----------------------------------------------------|
| Base URL | `http://127.0.0.1:1473/v1`                         |
| API key  | any non-empty string (e.g. `myownllm`)                |
| Model    | `myownllm` (chat) · `myownllm-transcribe` (ASR)    |
| Auth     | `Authorization: Bearer <key>` (clients add this for you) |

Below are exact, copy-pasteable configs for the apps that most commonly ship with the toggle but bury the fields. Start `myownllm serve` first; everything else just points at the same URL.

### opencode

`opencode.json` (project root, or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myownllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MyOwnLLM (local)",
      "options": { "baseURL": "http://127.0.0.1:1473/v1" },
      "models": {
        "myownllm":            { "name": "MyOwnLLM (chat)" },
        "myownllm-transcribe": { "name": "MyOwnLLM (transcribe)" }
      }
    }
  }
}
```

Restart opencode, then `/models` → pick `MyOwnLLM`.

### OpenClaw

In OpenClaw's Settings → Providers → Add → **OpenAI-compatible**:

```
Name:     MyOwnLLM
Base URL: http://127.0.0.1:1473/v1
API key:  myownllm
Model:    myownllm
```

Equivalent CLI:

```bash
openclaw provider add myownllm \
  --kind openai-compatible \
  --base-url http://127.0.0.1:1473/v1 \
  --api-key myownllm \
  --model myownllm
openclaw provider use myownllm
```

### OpenClaude (Gitlawb / mjohnnywest / hatixntsoa forks)

OpenClaude reads its OpenAI-mode settings from environment variables:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://127.0.0.1:1473/v1
export OPENAI_API_KEY=myownllm
export OPENAI_MODEL=myownllm          # or myownllm-transcribe
openclaude
```

Drop those four lines in your shell rc and every OpenClaude session routes through MyOwnLLM.

### Cursor

Settings → Models → enable **Override OpenAI Base URL**:

```
http://127.0.0.1:1473/v1
```

API key field: `myownllm`. Add `myownllm` to the **Model Names** list and click **Verify**. Cursor caches model lists — toggle the override off and on once after adding new model IDs.

### Continue.dev

`~/.continue/config.yaml`:

```yaml
models:
  - name: MyOwnLLM
    provider: openai
    model: myownllm
    apiBase: http://127.0.0.1:1473/v1
    apiKey: myownllm
```

Legacy `config.json` form, if you haven't migrated yet:

```json
{ "title": "MyOwnLLM", "provider": "openai",
  "model": "myownllm",
  "apiBase": "http://127.0.0.1:1473/v1",
  "apiKey": "myownllm" }
```

### Cline / Roo Code

⚙️ → API Provider → **OpenAI Compatible**:

```
Base URL:  http://127.0.0.1:1473/v1
API Key:   myownllm
Model ID:  myownllm
```

If the Base URL field is missing, update the extension — it was hidden briefly in some 3.x builds and has since been restored. CLI users: `cline provider configure openai-compatible`.

### Aider

Flags:

```bash
aider \
  --openai-api-base http://127.0.0.1:1473/v1 \
  --openai-api-key  myownllm \
  --model           openai/myownllm
```

Or `.env` in your project:

```
OPENAI_API_BASE=http://127.0.0.1:1473/v1
OPENAI_API_KEY=myownllm
AIDER_MODEL=openai/myownllm
```

The `openai/` prefix tells aider's LiteLLM layer to treat it as a generic OpenAI-compatible model and skip token-cost lookups.

### Zed

`~/.config/zed/settings.json`:

```json
{
  "language_models": {
    "openai_compatible": {
      "MyOwnLLM": {
        "api_url": "http://127.0.0.1:1473/v1",
        "available_models": [
          { "name": "myownllm",            "display_name": "MyOwnLLM (chat)",       "max_tokens": 32768 },
          { "name": "myownllm-transcribe", "display_name": "MyOwnLLM (transcribe)", "max_tokens": 32768 }
        ]
      }
    }
  }
}
```

Zed prompts for the API key on first use — type `myownllm` (it's stored in the system keychain, not the JSON file).

### Open WebUI

Open WebUI's **Ollama** panel won't see MyOwnLLM — MyOwnLLM exposes OpenAI's wire format, not Ollama's native API. Use the **OpenAI** panel instead:

Settings → Connections → OpenAI API:

```
API Base URL: http://127.0.0.1:1473/v1
API Key:      myownllm
```

### LibreChat

`librechat.yaml`:

```yaml
endpoints:
  custom:
    - name: MyOwnLLM
      apiKey: myownllm
      baseURL: http://127.0.0.1:1473/v1
      models:
        default: ["myownllm", "myownllm-transcribe"]
        fetch: false
      titleConvo: true
      modelDisplayLabel: MyOwnLLM
```

### Raw SDK use

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:1473/v1", api_key="myownllm")
client.chat.completions.create(
    model="myownllm",
    messages=[{"role": "user", "content": "hi"}],
)
```

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://127.0.0.1:1473/v1",
  apiKey:  "myownllm",
});
```

### Clients that only speak Ollama (port 11434)

A handful of tools (Msty, some Obsidian plugins, older Open WebUI builds) only know how to talk to `http://localhost:11434`. MyOwnLLM already runs Ollama as a managed child process, so those tools can hit `http://127.0.0.1:11434` directly and see exactly the models MyOwnLLM pulled. Confirm with `myownllm status`.

The trade-off: going through Ollama directly bypasses MyOwnLLM's virtual model IDs (`myownllm`, `myownllm-transcribe`), so you'll be naming raw tags like `qwen3.5:9b`. Use MyOwnLLM's URL whenever the client lets you.

### Clients that only speak Anthropic's wire format

If a tool only accepts `ANTHROPIC_BASE_URL` and the Anthropic Messages API (vanilla Claude Code, some Anthropic-only desktop apps), put an Anthropic→OpenAI shim in front of MyOwnLLM — `claude-code-router`, `anthropic-proxy`, or LiteLLM in `--anthropic` mode all work. Point the shim's upstream at `http://127.0.0.1:1473/v1` and the client at the shim. MyOwnLLM itself does not translate the Anthropic wire format.

### Troubleshooting

- **`Connection refused`** — `myownllm serve` isn't running, or the client is on a different host. MyOwnLLM binds `127.0.0.1` by default; for LAN access run `myownllm serve --host 0.0.0.0 --bearer-token sk-…` and point the client at that host with the matching key.
- **`model not found: myownllm`** — the client is hitting MyOwnLLM but the manifest doesn't expose that mode (or the active family is missing a `text` tier). `curl http://127.0.0.1:1473/v1/models` lists what's actually available; `myownllm status` shows which mode resolved.
- **`503 Retry-After`** — the model isn't pulled yet. Wait, or run `myownllm preload text` ahead of time. Clients that respect `Retry-After` will recover on their own.
- **Client streams nothing then errors** — some clients send `stream: true` but don't handle SSE keep-alive frames. Disable streaming in the client, or pass `?wait=true` so MyOwnLLM streams progress as keep-alives.

---

## CLI reference

| Command            | Purpose                                                |
|--------------------|--------------------------------------------------------|
| `myownllm serve`      | Start the OpenAI-compatible HTTP server (primary)      |
| `myownllm run`        | Chat in the terminal (auto-installs Ollama if missing) |
| `myownllm preload`    | Pull and warm models for one or more modes             |
| `myownllm status`     | Show provider, mode, hardware, ollama state            |
| `myownllm stop`       | Stop the managed Ollama process                        |
| `myownllm models`     | List / pin / override / prune pulled models            |
| `myownllm providers`  | Manage provider URLs                                   |
| `myownllm families`   | Pick the model family inside the active provider      |
| `myownllm import`     | Import a config bundle                                 |
| `myownllm export`     | Export the current config                              |
| `myownllm purge`      | Danger zone: delete models, conversations, or all data |
| `myownllm update`     | Self-update: `status`, `check`, `apply`                |

### Run / Chat

```bash
myownllm                          # open GUI (no args = launch window)
myownllm run                      # chat in the terminal
myownllm run --mode transcribe    # mic → text via Moonshine / Parakeet (auto-picked by tier)
myownllm run --model qwen2.5:7b   # force a specific model
myownllm run --profile https://example.com/manifest.json   # one-off manifest URL
```

`--profile` does not save — it's a single-run override for the active provider's manifest. To save a provider permanently, use `myownllm providers add`.

| Mode | What it loads | Notes |
|------|---------------|-------|
| `text` | General-purpose LLM | Default; served as virtual ID `myownllm` |
| `transcribe` | Moonshine / Parakeet (per tier) | Activates mic; outputs transcribed text. Pi 5 → Moonshine (English only); capable hardware → Parakeet TDT 0.6B v3 (25 languages). Served as virtual ID `myownllm-transcribe`. |
| `diarize`    | pyannote pipeline | Internal sub-feature of transcribe (opt-in via the transcribe pane's "Identify speakers" toggle). Tags each segment with a speaker ID; click the pill to rename. Not exposed as a virtual ID. |

Exit chat: `Ctrl+C` or type `exit`.

### Status

```bash
myownllm status
myownllm status --json
```

```
Provider : MyOwnLLM Default
Family   : gemma4
Mode     : text
Ollama   : running
VRAM     : 12.0 GB (nvidia)
RAM      : 32.0 GB
Disk free: 118.3 GB

Families in MyOwnLLM Default:
 * gemma4         Gemma 4
   qwen3          Qwen 3

Recommended models for this hardware:
  text       → gemma4:e4b
```

```jsonc
// --json output
{
  "active_provider": "MyOwnLLM Default",
  "active_family": "gemma4",
  "active_mode": "text",
  "ollama_running": true,
  "hardware": { "vram_gb": 12.0, "ram_gb": 32.0, "disk_free_gb": 118.3, "gpu_type": "nvidia" },
  "families":  [ { "name": "gemma4", "label": "Gemma 4" }, { "name": "qwen3", "label": "Qwen 3" } ],
  "recommendations": { "text": "gemma4:e4b" }
}
```

### Models

```bash
myownllm models                          # list pulled models with status
myownllm models --json                   # machine-readable list

myownllm models keep <model>             # pin — never auto-evict this model
myownllm models unkeep <model>

myownllm models override <mode> <model>  # force model for a mode
myownllm models override <mode> --clear  # revert to provider recommendation

myownllm models prune                    # evict all unrecommended, non-kept, non-override now
myownllm models rm <model>               # force-remove (also clears keep/override)
```

Column meanings:

```
NAME                                SIZE   FLAGS
qwen2.5:14b                         8.2G   (recommended)
qwen2.5-coder:7b                    4.3G   kept override:code
deepseek-r1:14b                     8.9G   unrecommended 2d
```

- `recommended` — still selected by at least one active provider for this hardware
- `unrecommended Xd` — no active provider recommends it; will be evicted after the cleanup threshold
- `kept` — pinned by user, never auto-evicted
- `override:<mode>` — user-selected override for that mode; implicitly kept

### Providers

A **provider** is a named, saved URL pointing to a manifest. The active provider determines which model MyOwnLLM recommends for your hardware.

```bash
myownllm providers                          # list (* = active)
myownllm providers add <url> --name <name>
myownllm providers use <name>               # set as active (hot-swap)
myownllm providers rm <name>                # cannot remove active
myownllm providers show [name]              # fetch and display manifest
myownllm providers reset                    # re-merge bundled preset list
```

```bash
myownllm providers add https://deepseek.com/myownllm/r1.json --name "DeepSeek R1"
myownllm providers use "DeepSeek R1"
myownllm run
```

`MYOWNLLM_PROFILE=<url>` overrides the active provider at runtime without touching saved config — useful in CI, Docker, or automation:

```bash
MYOWNLLM_PROFILE=https://example.com/minimal.json myownllm run
```

### Families

A **family** is a named bundle of model versions inside a provider's manifest — e.g. `gemma4`, `qwen3`. Each family owns its own per-mode tier table; MyOwnLLM resolves the active family's tiers against your hardware to pick a model. The default provider ships two families (`gemma4`, `qwen3`); `gemma4` is the default.

```bash
myownllm families                           # list families in the active provider (* = active)
myownllm families use <name>                # set as active (hot-swap)
myownllm families show [name]               # print tiers for a family across all modes
myownllm families --json                    # machine-readable list
```

```bash
myownllm families
# Families in MyOwnLLM Default:
#  * gemma4         Gemma 4
#    qwen3          Qwen 3

myownllm families use qwen3
myownllm families show qwen3
# qwen3  (Qwen 3)
#   Alibaba Qwen 3 — strong multilingual and reasoning performance at every size.
#   default mode: text
#
#   mode text:
#     ≥ 24 GB VRAM · ≥ 48 GB RAM   qwen3.6:35b
#     ≥ 16 GB VRAM · ≥ 32 GB RAM   qwen3.6:27b
#     ≥  8 GB VRAM · ≥ 16 GB RAM   qwen3.5:9b
#     ≥  4 GB VRAM · ≥  8 GB RAM   qwen3.5:1b
#     ≥  0 GB VRAM · ≥  0 GB RAM   qwen3.5:1b
```

`myownllm providers use <name>` automatically resets the active family to the new manifest's `default_family` — no stale-name fallthrough.

### Preload

Pull and warm models for one or more modes ahead of time. Useful before going offline, before a demo, or during setup so the OpenAI server has everything warm.

```bash
myownllm preload text                       # pull the text-mode model
myownllm preload text transcribe            # pull both end-user modes
myownllm preload text transcribe --track    # also persist as tracked modes
myownllm preload text --no-warm             # skip post-pull warm-up call
myownllm preload text --json                # NDJSON event output
```

Tracked modes are kept current automatically: when a manifest update changes the recommended tag, MyOwnLLM pulls the new one in the background and starts the eviction clock on the old one.

### Import & Export

The full config — providers — is plain JSON. Share it however you want.

```bash
myownllm export                       # JSON to stdout
myownllm export --url                 # base64-encoded myownllm:import:... URL

myownllm import ./config.json
myownllm import https://gist.../config.json
myownllm import myownllm:import:eyJwcm92aWRlcnMiOltdfQ
```

Import is **always additive**. Existing entries (matched by name) are never overwritten. The GUI's provider panel also has an import field — paste any of the above formats directly.

### Update

```bash
myownllm update              # alias for status
myownllm update status       # current version, install kind, pending updates
myownllm update check        # force a release check now
myownllm update apply        # apply any staged update (or no-op)
```

See [Auto-update](#auto-update) for behaviour.

### Purge

Three destructive resets for testing, support sessions, or starting over. Each
mirrors a row in the GUI's **Settings → Storage → Danger zone** card.

```bash
myownllm purge models               # every pulled tag + ASR/diarize artifacts
myownllm purge conversations        # every saved chat + sidecars
myownllm purge data                 # the whole ~/.myownllm/ tree, plus models
```

| Tier            | What it deletes                                                                       |
|-----------------|---------------------------------------------------------------------------------------|
| `models`        | Every pulled Ollama tag, every ASR / diarize artifact under `~/.myownllm/models/`, and resets `kept_models` / `mode_overrides` / `family_overrides`. Provider list and active family are kept. |
| `conversations` | Everything under `conversation_dir` — JSON files, talking-points sidecars, folders, user-dropped files. The folder itself is recreated empty. |
| `data`          | Stops the managed Ollama, drops every model, then removes the entire `~/.myownllm/` tree (config, cache, transcribe buffer, updates, legacy dirs). A redirected `conversation_dir` outside `~/.myownllm/` is wiped too. Next launch starts fresh against compiled-in defaults — same as a first install. |

Without `-f` each tier prints a one-line summary of what it's about to delete and waits for you to type the matching phrase verbatim. The phrases are deliberately specific so muscle-memorying through a prompt won't fire one off:

```
$ myownllm purge models
About to delete all models.
Removes every pulled Ollama tag, on-disk ASR / diarize artifacts, and resets
your kept-list and mode overrides. Provider list and active family are kept.
Models will be re-downloaded on next use.

This is irreversible. There is no trash.
Type the phrase to confirm (or anything else to abort):
  delete all models
>
```

Pass `-f` (or `--force`) to skip the prompt — for scripts, CI, or anywhere a TTY isn't available:

```bash
myownllm purge models -f
myownllm purge conversations -f
myownllm purge data -f
myownllm purge data -f --json    # machine-readable PurgeReport
```

```jsonc
// --json output (PurgeReport)
{
  "bytes_freed": 18403258461,
  "items_removed": 142,
  "errors": []
}
```

There is no undo. There is no trash. Once a tier completes, the data is gone. `purge data` in particular requires a restart afterward: the running process has just had its config dir deleted from under it, and will repopulate defaults on next launch the same way a first install does.

---

## GUI

Launch the GUI by running `myownllm` with no arguments, or open the application bundle.

**First run** (auto-transitions, no user choices required):

```
"Detecting hardware…"
"Best model for your system: Qwen2.5 14B — Downloading 8.9 GB…"
  [progress bar]
→ chat opens automatically
```

**Main window:**

```
┌─────────────────────────────────────────────────────┐
│ ● qwen2.5:14b                            ⊞ Models   │  ← status bar
├─────────────────────────────────────────────────────┤
│                                                     │
│              (messages appear here)                 │
│                                                     │
├─────────────────────────────────────────────────────┤
│ [Text]  [Vision]  [Code]  [Transcribe]              │  ← mode bar
├─────────────────────────────────────────────────────┤
│  Message…                              [Send]       │
└─────────────────────────────────────────────────────┘
```

- **Status bar** — click the model name to open the provider panel; click "⊞ Models" for the model status panel.
- **Mode bar** — switch modes; the model hot-swaps without restarting the server.
- No settings screen, no preferences, no model picker. Everything just works.

**Settings panel** (click the model pill or the gear):
- **Family tab** — pick which family inside the active provider MyOwnLLM uses for recommendations. Each family card shows its full tier list with the tier picked for your hardware highlighted, so you can see exactly what's running and why.
- **Providers tab** — list of saved providers. Click any provider to switch (model and family hot-swap immediately to the new manifest's default family).
- **Models tab** — every pulled model with its size, recommendation status, and pin/override controls.
- **Storage tab** — per-area auto-cleanup toggles and a "Clean now" button per area (models, transcribe buffer, legacy runtimes, update leftovers, orphaned conversation files). The conversations folder lives here too. At the bottom: a **Danger zone** card with one-click resets — Delete all models, Delete all conversations, Delete all app data and downloads. Each is gated behind a typed challenge phrase and mirrors the matching `myownllm purge` subcommand. All three force-reload the app window after the delete completes — any open chat or in-flight recording goes with it.

**Model status panel** (click "⊞ Models"):
- Every pulled model: size, which providers recommend it, age if unrecommended.
- Pin icon to keep a model (exempt from cleanup).
- Per-mode override: pick a specific model from any provider's full tier list.
- "Clean up" — evicts all unrecommended, non-pinned, non-override models.

---

## Cloud Mesh

**Two MyOwnLLM instances with the same Network ID find each other, mutually authenticate, and share work peer-to-peer over WebRTC.** No MyOwnLLM-operated signaling server, no API key, no cloud round-trip. Every device becomes a window into the same mesh: phone audio in, desktop transcription out, a laptop's idle GPU answering prompts from the tablet on the kitchen counter.

Cloud Mesh ships off by default. To turn it on, open **Settings → Networks → Status** and follow the wizard — pick or generate a Network ID, lock it, and the mesh client comes up.

### Concepts

| Term | What it is |
|------|------------|
| **Network ID** | Short human name like `office-mesh` (3–64 chars of `[a-z0-9_-]`). Hashed under domain tag `myownllm-network-v1:` to a 52-char base32 handle — the handle is what hits the wire, the name is what you share. Same name on two devices = same mesh. |
| **Device ID** | Permanent per-install identifier: `<base32-pubkey>-<SUFFIX>`. The pubkey is a long-lived ed25519 key under `~/.myownllm/.secrets/identity.json` (0600 on Unix). The 5-char uppercase-hex `SUFFIX` is a stable display tag (`sha256(pubkey).first_5_hex_chars`) — that's the part you read aloud to confirm a peer is who they say they are. |
| **Auth handshake** | On every peer encounter, both sides exchange a `hello` (pubkey + 32-byte nonce + 6-char verification code), then `auth_response` (each signs the other's nonce under domain tag `myownllm-mesh-auth-v1:`). Mutual ed25519 verification = identity. Followed by user `approve` / `deny`. |
| **Verification code** | Per-request 6-char `[a-z0-9]` code each side generates. The code is the eyeball-check ("the code I see in the app matches the code you read me over the phone") — not load-bearing for security (the signatures are), but the UX confirmation that the request is the one you expect. |
| **Roster** | Per–Network ID list of approved Device IDs at `~/.myownllm/mesh/roster.json`. Reconnects from rostered peers auto-allow without re-prompting. Switching Network ID atomically swaps to a fresh empty roster — old approvals don't carry across networks. |

### Quick start

1. **Device A:** open **Settings → Networks → Status**. The wizard says "Pick a Network ID" — type a name (e.g. `home-mesh`) or click **Generate** for a random one. Click the lock to commit.
2. **Device B:** same tab. Type the **same** name. Click the lock.
3. Within seconds the wizard on each device flips to "approval(s) waiting" with a card showing the request. The host side (lex-lesser pubkey) prompts first ("X wants to connect"). Compare the verification code shown to what the other person reads aloud; if they match, click **Approve**.
4. The guest side gets a follow-up prompt ("X authorized you — confirm?"). Approve there too. Both sides flip to **Connected** and the peer joins the Ring on the **Connections** tab.
5. After approval, reconnects auto-allow silently — you only see a prompt for genuinely new peers.

### What the mesh does for you

| Feature | Where it shows up |
|---------|-------------------|
| **Cross-device conversation list** | The main **sidebar** has an always-visible **Network** section at the bottom with one row per saved network and a **+ Add** button. Click a saved network to switch to it; the active network is highlighted and expanded with its connected peers as nested groups. Peer conversations appear under each peer-group row, **organized into the same folder tree the peer uses on-host** — so `Work/Projects/Q4 planning` on the source shows up as nested expandable folders on every device, not as a flat list. Right-click a network → switch / settings / forget. Right-click a peer → settings. |
| **Saved networks** | The mesh is a single-active-network model: only one Trystero room joined at a time, but the user can save several (`home-mesh`, `office-mesh`, `camping-mesh`) and switch between them with one click. Each saved network keeps its own roster file (`~/.myownllm/mesh/rosters/{network_id}.json`) so switching back skips re-authentication for previously-approved peers. Per-network settings: accepting policy, signaling relays, STUN, TURN. **The Network ID is the display name** — there's no separate label field. The ID isn't secret either: anyone using the same handle lands in the same room and can knock (you'll see their request), but joining still requires approval. Pick something unique if you don't want to field knocks from strangers; click **Generate** for a 52-char hash that won't collide with anyone. |
| **Push a local conversation** | Right-click any local conversation in the sidebar → **Push to device → \<peer\>**. The sender's copy is deleted after the receiver acks; the receiver lands the conversation in the same folder it lived in on the source (creating intermediate folders if needed). Single-RTT today; tracked with a `moving…` pill on the catalog row across all peers while in flight. |
| **Pull a remote conversation** | Right-click a remote conversation under any Network group → **← Pull from \<peer\>**. The remote peer drives the Move handshake with you as the destination; the conversation appears in your local sidebar in the same folder it lived in on the source. Source must be in your roster — strangers in the same Trystero room can't be pulled from. |
| **Remote inference** | In the chat compose row, the **via:** picker lets you route a prompt to any peer that has an LLM advertised. The peer's local Ollama runs the request and streams tokens back over the data channel. Stop, cancel, and reasoning-mode all work the same as local. |
| **Resource map** | Under **Networks → Connections → Resources in use**, every in-flight inference (outbound + inbound) and Move shows as a live row: `→` = you using a peer's resources, `←` = a peer using yours. |
| **Capability badges** | Each peer's row shows what they can do — `LLM`, `ASR`, `mic`, `diarize`, plus a one-liner hardware summary (`Pi 5 · 4 GB RAM`). Sourced from each device's broadcast `capabilities_update`. |
| **Accepting policy** | Per-network toggle on the Status tab, inline with the status pill. `available` = take any work, `limited` = only if no better peer exists, `busy` = refuse incoming inference. Each saved network has its own setting — you can be `available` at home and `busy` on an office mesh simultaneously. |
| **Ring + indirect peers** | The **Connections** tab splits peers into two groups. The **Ring** is the set the local selector is actively routing through — it auto-heals on every join / leave by re-running the deterministic ring selector. **Indirect** is peers we know about but aren't routing through right now — shelved (data channel open as heartbeat, parked because the mesh grew past the ring capacity) or offline rostered (approved before, not in the room right now). Keeps Pi-class devices from melting under N² connection counts on a 10-device mesh. |

### Transport: Trystero over Nostr (default)

Discovery and WebRTC connection setup go through [Trystero](https://trystero.dev), which proxies signed signaling messages through decentralized infrastructure (Nostr relays by default, with BitTorrent / MQTT / IPFS available as compile-time alternatives). **MyOwnLLM operates none of these.** The default is the community-run public Nostr relay pool.

The relay sees only the small WebRTC offer/answer envelopes during connection setup — never the mesh's actual traffic. Once peers connect, the data channel is direct and end-to-end.

### Self-hosting a relay (LAN / office / air-gapped)

For an office or home network where you don't want connection setup to traverse public relays, point Trystero at your own. **Settings → Networks → Settings → Signaling relays** takes a list of WebSocket URLs; the disclosure under "Self-host a Nostr relay" gives you one-line Docker commands for `strfry` (lightweight C++, ~10 MB RAM) and `nostr-rs-relay` (Rust, persistent SQLite).

```sh
# Lightweight option
docker run -d -p 7777:7777 dockurr/strfry

# Then in MyOwnLLM: add ws://your-host:7777 to the relay list.
```

Two devices both pointed at the same private relay find each other through it without ever hitting the public Nostr network.

### NAT traversal: STUN + optional TURN

WebRTC needs STUN to discover NAT mappings; the defaults are Google's public STUN pool, which works on ~95% of networks. The other 5% (symmetric NAT, both peers behind it) need a TURN relay — that's user-supplied because TURN consumes real bandwidth. Add TURN entries in **Settings → Networks → Settings → TURN servers** with their URL + credentials.

### Activity log

Connect → handshake → approve → re-handshake → catalog announce — every event lands in the **Networks → Activity** sub-tab as a ring-buffered log (newest at top, 80-entry cap). Useful when debugging a "peer didn't show up" situation. The `quiet logs` checkbox suppresses `info` events while keeping `warn` and `error` — useful once steady-state and you don't want the chatter. Quiet is global (a UI preference, not per-network).

### Resilience (post-sleep, network blips)

The mesh client watches for OS sleep / network drop via four signals (`visibilitychange`, `focus`, `online`, `pageshow`) plus a heartbeat-tick clock-gap detector. On wake it pings every peer with a tight 1.5 s probe; if any peer doesn't pong it enters a backoff schedule of re-handshakes (2 s, 5 s, 10 s, 20 s, 30 s, then capped) before escalating to a forced Trystero room rejoin. Rejoins are throttled (1m → 2m → 5m → 10m → 30m) so a peer that's genuinely offline doesn't drag the rest of the mesh through a churn loop.

You can force-reconnect a peer manually from its row in the Connections list.

### Wire protocol (for the curious)

Every message is a JSON envelope with a discriminated `kind` field, framed over Trystero's typed `makeAction("mesh")` data channel. The kinds (all in `src/mesh-protocol.ts`):

```
# Handshake
hello                    pubkey + nonce + verification code + capabilities
auth_response            signature over the other side's nonce
approve / deny           after user approval / denial

# Liveness
ping / pong              heartbeat with timestamp echo

# Capabilities + ring topology
capabilities_update      re-broadcast on local hardware/model change
shelve / unshelve        ring selector toggles a peer between active and standby

# Catalog gossip
catalog_announce         full list of conversations hosted on the sender

# Move (single-RTT, Phase 1)
move_offer / move_accept / move_decline / move_payload / move_complete

# Move (2-phase visibility, Phase 2 — broadcast to everyone)
move_prepare / move_commit / move_abort

# Pull (Phase 2 — requester asks source to push to them)
move_request / move_request_decline

# Remote inference
infer_request            messages + family/mode + think hint
infer_chunk              one delta or thinking-delta per frame
infer_done / infer_error
infer_cancel             abort an in-flight inference
```

The protocol version is `1` and stays there across additive Phase 2 changes — v0.2.14 Phase 1 peers and Phase 2 peers can share a mesh, with the v1 side simply not seeing the ring shelving / remote inference / catalog niceties.

### Persistence

```
~/.myownllm/
├── .secrets/
│   └── identity.json    (ed25519 keypair; 0600 on Unix)
└── mesh/
    └── rosters/
        ├── home-mesh.json      (per-network approved peers; 0600 on Unix)
        ├── acme-office.json
        └── ...
```

Identity is one keypair across every network you join. Rosters are
per-network — each saved network gets its own file under
`~/.myownllm/mesh/rosters/{network_id}.json`, so switching between
saved networks preserves their rosters independently. A legacy
pre-multi-network `~/.myownllm/mesh/roster.json` is migrated into its
per-network home automatically on first roster load.

---

## Provider system

### What is a Provider?

A **URL** that returns a JSON [manifest](#manifest-format). The manifest publishes one or more **families** (e.g. `gemma4`, `qwen3`); each family carries its own per-mode tier table. MyOwnLLM fetches the manifest, caches it against the publisher-defined TTL, and resolves `families[active_family].modes[active_mode]` against your hardware.

Providers are saved by name in your local config. One provider is active at a time; switching is hot — the model swaps without restarting anything.

### What is a Family?

A **family** is a model family inside a provider's manifest — Gemma 4, Qwen 3, etc. Picking the family is how the user picks "which model line do I want", letting MyOwnLLM keep tiering by hardware. The user's choice of family is saved alongside the active provider; the resolver always walks `families[active_family].modes[active_mode].tiers`.

```
Provider "MyOwnLLM Default"
  └─ default_family = "gemma4"
       families:
         ├─ gemma4   tiers: [31b → 26b → e4b → e2b]
         └─ qwen3    tiers: [35b → 27b → 9b  → 1b ]
```

Default ships with `gemma4` as the active family. Switching families is one CLI call (`myownllm families use qwen3`) or one click in the GUI's Family tab.

### Publishing your own

Host any static JSON file in the [manifest format](#manifest-format). One file, any static host (GitHub Pages, S3, a Cloudflare Worker, your company intranet).

```bash
myownllm providers add https://ai.yourcompany.com/myownllm-manifest.json --name "Company LLM"
myownllm providers use "Company LLM"
```

A single manifest can expose multiple families — that's how you ship "use our 8B for fast, 70B for slow" choices behind one URL. The user picks which family to use; MyOwnLLM tiers within it. No account, no API key, no SDK. One static JSON file is the entire participation contract.

---

## Manifest format

```jsonc
{
  "name": "My Provider",         // display name
  "version": "12",
  "ttl_minutes": 360,            // how long MyOwnLLM caches THIS file before re-fetching (default: 360).
                                 // Publisher's rate-limit signal — pick what fits your host.
  "default_family": "gemma4",    // family used until the user picks one

  "imports": [                   // optional: URLs to other manifests whose families are merged in.
    "https://example.com/base-families.json"
  ],
                                 // Each imported manifest is fetched + cached against ITS OWN ttl_minutes.
                                 // Importing file wins on family-key collision.

  "headroom_gb": {               // optional: RAM (GB) reserved for OS / WebView / ollama overhead
    "apple": 5,                  //   alongside the paired ASR model (Moonshine ~150 MB on Pi-class,
    "none":  2,                  //   Parakeet ~700 MB on capable). Apple holds back the most because
    "nvidia": 1,                 //   macOS + browser tabs share the LLM pool; discrete-GPU hosts only
    "amd": 1                     //   need a sliver of system RAM because the LLM lives on the GPU.
  },                             //   Missing keys inherit the compiled-in defaults shown.

  "shared_modes": {
    "transcribe": {              // Every family inherits this unless it overrides `modes.transcribe`.
      "tiers": [                 // v13: per-tier `runtime` lets one ladder promote capable hardware
                                 // to Parakeet (25 langs) while the bottom rung stays on Moonshine
                                 // (English, edge-class). Fall-through order:
                                 //   tier.runtime → mode.runtime → default_runtime_for(mode).
        { "min_vram_gb": 4, "min_ram_gb": 8, "min_unified_ram_gb": 16,
          "runtime": "parakeet",  "model": "parakeet-tdt-0.6b-v3-int8",
          "fallback": "moonshine-small-q8" },
        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0,
          "runtime": "moonshine", "model": "moonshine-small-q8",
          "fallback": "moonshine-small-q8" }
      ]
    },
    "diarize": {                 // Opt-in speaker diarization via the transcribe pane toggle.
      "tiers": [                 // Same pipeline (pyannote-seg + embedder + online clusterer),
                                 // smaller embedder on Pi-class to keep latency in budget.
        { "min_vram_gb": 0, "min_ram_gb": 6, "min_unified_ram_gb": 12,
          "runtime": "pyannote-diarize",
          "model": "pyannote-seg-3.0+wespeaker-r34",
          "fallback": "pyannote-seg-3.0+campp-small" },
        { "min_vram_gb": 0, "min_ram_gb": 0, "min_unified_ram_gb": 0,
          "runtime": "pyannote-diarize",
          "model": "pyannote-seg-3.0+campp-small",
          "fallback": "pyannote-seg-3.0+campp-small" }
      ]
    }
  },

  "families": {
    "gemma4": {
      "label": "Gemma 4",
      "description": "Google Gemma 4 — agentic open models that run end-to-end on the edge (Pi 5, Jetson Orin Nano).",
      "default_mode": "text",
      "modes": {
        "text": {
          "label": "Text",
          "tiers": [
            // Tiers are walked top-to-bottom. First match wins.
            // Unified-memory hosts (apple, none) match on `min_unified_ram_gb` — raw RAM that
            // must include OS headroom AND the paired transcribe model (large-v3-turbo, ~2 GB).
            // Discrete GPUs (nvidia, amd) walk twice: first for vram_gb >= min_vram_gb (primary),
            // then — only if nothing matched on VRAM — for (ram_gb - headroom_gb[gpu]) >= min_ram_gb
            // (last-resort CPU fallback). The displayed "Needs ~X GB VRAM" hint always matches
            // the primary pass.
            { "min_vram_gb": 24, "min_ram_gb": 24, "min_unified_ram_gb": 32, "model": "gemma4:31b",  "fallback": "gemma4:26b" },
            { "min_vram_gb": 12, "min_ram_gb": 12, "min_unified_ram_gb": 18, "model": "gemma4:12b",  "fallback": "gemma4:e4b" },
            { "min_vram_gb": 5,  "min_ram_gb": 6,  "min_unified_ram_gb": 10, "model": "gemma4:e4b",  "fallback": "gemma4:e2b" },
            { "min_vram_gb": 4,  "min_ram_gb": 4,  "min_unified_ram_gb": 8,  "model": "gemma4:e2b",  "fallback": "gemma4:1b"  },
            { "min_vram_gb": 0,  "min_ram_gb": 0,  "min_unified_ram_gb": 0,  "model": "gemma4:270m", "fallback": "gemma4:270m"}
            // Always include a zero-threshold catch-all as the last tier.
          ]
        }
      }
    }
  }
}
```

**Default tier ladder, sized to actual gemma4 resident memory + per-tier ASR model:**

| Hardware (unified)        | Pick                                  | Runtime peak |
|---------------------------|---------------------------------------|--------------|
| Pi 5 4 GB                 | `gemma4:270m` + Moonshine Small       | ~1.8 GB      |
| Pi 5 8 GB / Orin Nano 8   | `gemma4:e2b`  + Moonshine Small       | ~2.2 GB      |
| 8 GB Mac                  | `gemma4:e2b`  + Moonshine Small       | ~6 GB        |
| 16 GB Mac (M1/M2/M3)      | `gemma4:e4b`  + Parakeet TDT 0.6B v3  | ~9 GB        |
| 24 GB Mac (M-Pro)         | `gemma4:12b`  + Parakeet TDT 0.6B v3  | ~15 GB       |
| 36 GB Mac (M-Pro/Max)     | `gemma4:26b`  + Parakeet TDT 0.6B v3  | ~26 GB       |
| 48+ GB Mac (M-Max/Ultra)  | `gemma4:31b`  + Parakeet TDT 0.6B v3  | ~28 GB       |

**Pi 5 caveat:** Moonshine Small is English-only. If non-English transcription on Pi-class hardware is a hard requirement, override via `mode_overrides.transcribe` or wait for a future multilingual streaming model on the Pi tier.

Discrete GPUs use `min_vram_gb` for the GPU-resident path (model lives on the card, system RAM only hosts the ASR worker + the ollama client). A last-resort CPU-fallback path through `min_ram_gb` exists for the rare case where every rung wants more VRAM than the GPU has.

**Rules:**
- A family **must** define `default_mode` and at least one entry under `modes`.
- **Unified-memory hosts** (`gpu_type` `apple` or `none`) match on `min_unified_ram_gb`. The threshold is raw total RAM — the publisher already factored in OS headroom and the paired transcribe model so a single machine can run text + audio together. When the field is omitted the resolver synthesises it as `min_ram_gb + headroom_gb[gpu_type]`, so legacy tiers keep working.
- **Discrete-GPU hosts** (`nvidia`, `amd`) walk the ladder twice. **Primary pass:** match if `vram_gb >= min_vram_gb` (model lives on GPU). **Last-resort pass (only if nothing matched on VRAM):** match if `(ram_gb - headroom_gb[gpu_type]) >= min_ram_gb` (model lives in system RAM, inference runs on CPU). The displayed "Needs ~X GB VRAM" hint always matches the primary pass — never the fallback.
- Tiers walked top-to-bottom; first match wins.
- Last tier should always be a zero-threshold catch-all.
- `fallback` is tried if the primary model fails to pull.
- If the user's saved `active_family` doesn't exist in the manifest, the resolver falls back to `default_family`, then to the first family in document order.
- Unknown fields are ignored — manifests are forward-compatible within the schema version.
- `ttl_minutes` controls how long MyOwnLLM caches **this file** before re-fetching (default 360). It is the publisher's rate-limit signal; MyOwnLLM honours it.
- `headroom_gb` is optional. Missing keys inherit the compiled-in defaults (`apple: 5`, `none: 2`, `nvidia: 1`, `amd: 1`). Sized to cover the OS, WebView, and ollama daemon alongside the paired ASR worker (Moonshine ~150 MB resident, Parakeet ~700 MB) so the text pick has room to share memory with transcribe. When diarization is enabled, the resolver subtracts an additional ~500 MB for the pyannote pipeline.
- The default `shared_modes.transcribe` ladder has two rungs, **picked by per-tier `runtime`**:
   - `parakeet` on Apple Silicon ≥ 16 GB / x86 ≥ 8 GB RAM / any GPU ≥ 4 GB VRAM — Parakeet TDT 0.6B v3, 25 languages, ~80–200 ms inference latency.
   - `moonshine` on everything below that — Moonshine Small, English-only, ~500 ms latency, runs at real-time on a Pi 5.
   Both backends are streaming-native and emit one segment per chunk (no 5 s minimum). Override per-family via the family's own `modes.transcribe` block.
- `shared_modes.diarize` is opt-in via the transcribe pane's "Identify speakers" toggle. The composite model name (`pyannote-seg-3.0+wespeaker-r34` or `pyannote-seg-3.0+campp-small`) is split into a segmenter and a speaker embedder; the Rust side runs online agglomerative clustering on the embeddings to assign stable cluster IDs across a conversation. Models are pulled lazily on first toggle-on.
- `imports` lets a manifest pull families from other manifests; each imported file obeys its own TTL and is cached separately. Family-key collisions favour the importing file.

Model tags are standard Ollama tags (e.g. `gemma4:e4b`, `qwen3.5:9b`). Anything in the [Ollama library](https://ollama.com/library) works.

---

## Imports & merged manifests

A manifest can `imports` other manifests by URL. Their families are merged into the importing file:

```jsonc
// A manifest at https://yourco.com/myownllm/manifest.json
{
  "name": "Your Org",
  "version": "4",
  "ttl_minutes": 1440,
  "default_family": "gemma4",
  "imports": [
    "https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/manifests/default.json",     // pulls the MyOwnLLM default families in
    "https://partner.com/myownllm/manifest.json"       // and a partner's family
  ],
  "families": {
    "company-llm": { "label": "Company LLM", "default_mode": "text", "modes": { /* … */ } }
  }
}
```

**Resolution rules:**

- Imports are walked recursively, depth-first, before the importing file's own families are added.
- **Cycles are detected** by URL and broken silently — each URL appears once and only once in the merge.
- **Each imported file has its own `ttl_minutes` and its own cache entry.** A daily top-level manifest importing an hourly manifest will see the hourly one refresh hourly without bumping the top-level fetch.
- **Document order matters.** Imports are merged first, then the importing file's families. On family-key collision, the importing file wins — the closer-to-you publisher gets the last word.

The "centralized" aspect of an org's setup is that one root JSON file. The decentralized aspect is that nothing forces it to be hosted in one place — federate by importing.

---

## Auto-update

MyOwnLLM is built to be installed once and never thought about again. A background updater runs alongside the watcher, checks the GitHub releases endpoint at most every `check_interval_hours` (default 6), and applies new releases according to `auto_apply`:

| Policy   | Behaviour                                                                       |
|----------|---------------------------------------------------------------------------------|
| `patch`  | (default) Auto-apply patch releases (`0.4.x → 0.4.y`); notify on minor / major. |
| `minor`  | Auto-apply patch and minor; notify on major.                                    |
| `all`    | Auto-apply everything.                                                          |
| `none`   | Just notify; never auto-apply.                                                  |

The updater stages the new binary at `~/.myownllm/updates/<version>/`, verifies its SHA256 against the release's `SHA256SUMS` asset, and atomically swaps it over the running binary on the next process restart (Windows uses the standard rename-on-boot dance). For long-running `myownllm serve` daemons under systemd / launchd / a Windows service, the swap takes effect after the next service restart.

**Package-manager installs are detected and skipped.** If MyOwnLLM is installed via Homebrew, dpkg/apt, rpm, MSI, or Chocolatey, the updater logs a one-line note and lets the package manager handle versioning.

**Disable:**

Three ways, from most to least durable:

```bash
myownllm update disable   # persistent: flips auto_update.enabled = false in config
myownllm update enable    # turn it back on
```

The GUI's **Settings → Updates** tab has an "Automatic updates" toggle that does
the same thing. The "Check for updates" button there keeps working when
auto-update is disabled — a disabled toggle only stops the *background* checks,
not your ability to manually pull an update.

```jsonc
// ~/.myownllm/config.json (defaults shown)
"auto_update": {
  "enabled": true,
  "channel": "stable",          // "stable" | "beta"
  "auto_apply": "patch",        // "patch" | "minor" | "all" | "none"
  "check_interval_hours": 6,
  "stable_url": null,           // optional override; falls back to build-time default
  "beta_url": null              // optional override; falls back to build-time default
}
```

```bash
MYOWNLLM_AUTOUPDATE=0 myownllm serve   # one-shot opt-out
```

`myownllm update status` shows the current version, install kind, the active
release-feed URL (with a `(custom)` marker if redirected), and any pending update.

### Pointing at your own release host

If you're shipping a private fork or vendoring MyOwnLLM behind a corporate
mirror, redirect the update feed without forking the source. You have two
layers:

1. **Per-machine (config):** set `auto_update.stable_url` and / or
   `auto_update.beta_url` in `~/.myownllm/config.json` to your own URLs.
   The endpoints must speak the GitHub releases JSON shape — for `stable_url`,
   return a single release object; for `beta_url`, return an array (newest
   first). Each release needs a `tag_name` and an `assets` array of
   `{name, browser_download_url}` pointing at the binary tarballs plus a
   `SHA256SUMS` sidecar.

2. **Build-time defaults:** when you rebuild the binary, set these env
   vars and they're baked in as the fallback if no config override exists:

   ```bash
   MYOWNLLM_RELEASE_URL_STABLE=https://releases.example.com/myownllm/latest \
   MYOWNLLM_RELEASE_URL_BETA=https://releases.example.com/myownllm/beta \
     cargo build --release
   ```

   This mirrors how `providers/preset.json` lets you ship build-time provider
   defaults — same idea, different config key.

---

## Model lifecycle & cleanup

MyOwnLLM manages disk automatically. Models accumulate as you switch providers; this system keeps the pile bounded.

### Three TTL layers

There are three distinct concepts. They are independent and do not interact.

| Layer | What has a TTL | Who sets it | What happens when it expires |
|-------|----------------|-------------|------------------------------|
| **Manifest** | Cached manifest from a provider URL | Provider publisher (`ttl_minutes`) | MyOwnLLM silently re-fetches |
| **Imported manifest** | Cached imports of the active manifest | Each import's publisher (`ttl_minutes`) | MyOwnLLM silently re-fetches that one file |
| **Model cleanup** | Pulled Ollama models no longer recommended | User (`model_cleanup_days`, default 1) | Model is deleted from disk |

The first two are about freshness of remote data; the third is about disk cleanup.

**TTLs are per-file.** When a file `imports` other files, each imported file is cached independently against its own `ttl_minutes`. Don't host on a free static CDN with a 5-minute TTL.

### Model eviction

A pulled model is **in use** if any saved provider's manifest mentions its tag in any family/mode/tier. MyOwnLLM computes this set on every startup and after every provider/family change.

When a model drops out of every provider's recommendation set, a clock starts. Once it's been unrecommended for longer than `model_cleanup_days` (default 1), it's deleted.

```
Startup:
  For each pulled model:
    recommended_by = [providers whose manifests recommend this model for my hardware]
    if recommended_by is empty:
      time_since_recommended = now - last_recommended_at
      if time_since_recommended > model_cleanup_days:
        delete model
```

Cleanup triggers on:

1. **App startup** — always.
2. **Provider or family change** — recomputes the recommendation set immediately.
3. **Pre-pull disk check** — if disk is tight, evicts unrecommended models before pulling.

No model is ever deleted silently the moment you remove a provider. The clock starts when it becomes unrecommended; you have a full day (or whatever you set) before it's gone.

### Keeping and overriding

**Keep (pin)** — never auto-evict.

```bash
myownllm models keep qwen2.5:32b
myownllm models unkeep qwen2.5:32b
```

**Mode override** — force a specific model for a mode regardless of provider recommendations. Override models are implicitly kept.

```bash
myownllm models override text qwen3.6:14b
myownllm models override text --clear
```

In the GUI: open the Models panel → click "change" next to any mode → pick from any model any of your providers mentions.

**Cleanup order:**
1. Evict: unrecommended + not kept + not an override + older than threshold.
2. Never touch: kept, override, or still-recommended models.

```bash
myownllm models prune    # immediately evict everything that qualifies (ignores age)
```

### Wiping the slate

`myownllm models prune` only touches unrecommended, non-pinned, non-override tags — it's the routine cleanup pass run by hand. For a full reset (testing, support, switching providers wholesale, or just starting over), use [`myownllm purge`](#purge) or the GUI's **Settings → Storage → Danger zone**:

```bash
myownllm purge models           # every pulled tag + ASR/diarize artifacts
myownllm purge conversations    # every saved chat
myownllm purge data             # the whole ~/.myownllm/ tree, plus models
```

Each tier prompts for a typed confirmation; `-f` skips it for scripts. There is no trash.

---

## Scriptability

Every command supports `--json` for machine-readable output and `--quiet` to suppress non-JSON prose.

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | User error (bad arguments, missing required config) |
| `2` | Network or I/O error |
| `3` | Not found (provider, family, or model doesn't exist) |
| `4` | Resource conflict (e.g. removing the active provider) |

Because the CLI is fully scriptable and `--json` outputs are stable, MyOwnLLM can be set up or reconfigured by a running model:

```bash
myownllm providers add https://example.com/manifest.json --name "Example"
myownllm providers use "Example"
myownllm families --json | jq '.[].name'
myownllm families use qwen3
myownllm status --json | jq '{provider: .active_provider, family: .active_family, recommendations}'
myownllm run --quiet
```

Operations are idempotent. `myownllm providers add` with an existing name updates the URL. `myownllm providers use` is always safe to re-run. Scripts don't need to check first.

---

## Config files

MyOwnLLM manages all its config files. You shouldn't need to open them — use the CLI or GUI. They are documented here for transparency.

**Location:** `~/.myownllm/`

```
~/.myownllm/
├── config.json          # active provider, active family, mode, cleanup, providers, api, auto_update
├── watcher.lock         # PID; cooperative process lock
├── updates/             # staged self-update binaries (<version>/myownllm)
└── cache/
    ├── manifests/       # cached provider manifests (<hash>.json + fetched_at, per-URL)
    └── model-status.json   # computed recommended-by set for all pulled models
```

The `manifests/` cache stores one entry per URL. When a manifest reached via an `import`, it gets its own cache entry and obeys its own TTL.

### `~/.myownllm/config.json`

```jsonc
{
  "active_provider": "MyOwnLLM Default",
  "active_family": "gemma4",
  "active_mode": "text",
  "model_cleanup_days": 1,
  "kept_models": ["qwen3.6:35b"],
  "mode_overrides": {
    "text": "qwen3.6:14b",
    "transcribe": null
  },
  "api": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 1473,
    "cors_allow_all": false,
    "bearer_token": null
  },
  "auto_update": {
    "enabled": true,
    "channel": "stable",
    "auto_apply": "patch",
    "check_interval_hours": 6,
    "stable_url": null,
    "beta_url": null
  },
  "cloud_mesh": {
    "enabled": false,
    "active_network_id": "net-abc123",  // id of the currently-active saved network, or null
    "diag_quiet": false,                // suppress info events in Activity log — Phase 2
    "networks": [                       // saved networks; one is active at a time
      {
        "id": "net-abc123",             // stable internal id, generated on save
        "network_id": "home-mesh",      // canonical Network ID — display name + roster filename
        "locked": true,                 // true = mesh client joins when this is active
        "signaling_servers": [],        // per-network; empty = Trystero defaults
        "stun_servers": [
          "stun:stun.l.google.com:19302",
          "stun:stun1.l.google.com:19302"
        ],
        "turn_servers": [],
        "accepting": "available"        // per-network: "available" | "limited" | "busy"
      },
      {
        "id": "net-def456",
        "network_id": "acme-office",
        "locked": true,
        "signaling_servers": ["wss://relay.internal.acme:7777"],
        "stun_servers": ["stun:stun.l.google.com:19302"],
        "turn_servers": [],
        "accepting": "limited"
      }
    ]
  },
  "providers": [
    { "name": "MyOwnLLM Default", "url": "https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/manifests/default.json" },
    { "name": "Local Dev",     "url": "https://ai.internal/manifest.json" }
  ]
}
```

---

## Building from source

### Prerequisites

**All platforms:**
- [Rust](https://rustup.rs) 1.88+
- [Node.js](https://nodejs.org) 18+
- [pnpm](https://pnpm.io) 8+
- [Tauri CLI v2](https://tauri.app): `cargo install tauri-cli`
- A copy of `onnxruntime` ≥1.20 for ASR + diarization. The end-user install scripts (`install.sh` / `install.ps1`) fetch it automatically into the install prefix; if you install via the Tauri `.msi`/`.dmg`/`.deb` bundle directly, MyOwnLLM downloads it on first launch into `~/.myownllm/runtime/` and you'll see a one-time progress toast. For local `cargo run`, run `scripts/bootstrap.sh` (Linux/macOS) or `scripts/bootstrap.ps1` (Windows) — both honour `.ort-version` at the repo root.

### Troubleshooting onnxruntime

Transcription error "**onnxruntime isn't loaded**" means none of the search paths contained a usable `libonnxruntime`. The app searches, in order:

1. `ORT_DYLIB_PATH` (env var — absolute path override)
2. The directory containing the `myownllm` binary
3. `~/.myownllm/runtime/` (where the first-run fetcher writes; also a safe place to drop a manual override)
4. System install locations (`/usr/lib`, `/opt/homebrew/lib`, `C:\Program Files\onnxruntime\…`)

Recovery, in order of effort:

- **Run `myownllm fetch-onnxruntime`** from a terminal. Downloads the pinned version (see `.ort-version`) into `~/.myownllm/runtime/` and prints the destination path.
- **Drop the file manually.** Download `onnxruntime-{win-x64,osx-arm64,osx-x86_64,linux-x64,linux-aarch64}-${VERSION}.{zip,tgz}` from <https://github.com/microsoft/onnxruntime/releases>, extract the `lib/onnxruntime.dll` / `libonnxruntime.{dylib,so.1}` file into `~/.myownllm/runtime/`, and restart.
- **Set `ORT_DYLIB_PATH`** to the absolute path of the dylib if you want to point at a specific copy (debugging, side-by-side versions).
- **Windows Defender** occasionally quarantines `onnxruntime.dll` after the install script extracts it. It's a Microsoft-signed binary; restore from quarantine and add an exclusion for the install dir.

**Linux:** `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev libasound2-dev`
(`libasound2-dev` is the ALSA dev headers cpal links against for mic capture.)

**macOS:** Xcode Command Line Tools (`xcode-select --install`)

**Windows:** WebView2 (auto-installed by `bootstrap.ps1`)

### Build

```bash
git clone https://github.com/mrjeeves/MyOwnLLM
cd MyOwnLLM
pnpm install
pnpm tauri build       # production bundle
pnpm tauri dev         # dev mode (hot-reload GUI)
```

`just setup` does the prereq install in one step (idempotent).

### Type-check only

```bash
pnpm check                                      # TypeScript + Svelte
cargo check --manifest-path src-tauri/Cargo.toml   # Rust
```

### Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for module-by-module roles. High level:

```
src/             # TypeScript: config, manifest fetching with imports, lifecycle
src-tauri/src/   # Rust: API server, CLI, hardware/Ollama, resolver mirror, self-update
manifests/       # bundled fallback manifest (with families)
providers/       # bundled preset providers (replace to repackage)
```

---

## Repackaging for your org

You don't need to fork the code — swap one JSON file and rebuild.

**`providers/preset.json`** — providers pre-loaded on first run:

```json
[
  { "name": "Company LLM",  "url": "https://ai.yourco.com/manifest.json"      },
  { "name": "Company Code", "url": "https://ai.yourco.com/code-manifest.json" }
]
```

On first launch, MyOwnLLM merges these into `~/.myownllm/config.json`. Existing entries (by name) are never overwritten, so users who've customised their config are safe; defaults just appear in their list.

Users can still add their own providers on top. Company-provided entries have no special privilege — they're just pre-loaded defaults.
