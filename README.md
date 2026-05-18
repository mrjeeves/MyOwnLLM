<div align="center">

# MyOwnLLM

### Multi-speaker diarized transcription. A local LLM endpoint. A peer mesh that turns every device you own into more capacity.<br>The AI everyone thought was in the box.

[**myownllm.net**](https://myownllm.net) — installers, screenshots, the pitch

[Docs](DOCS.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS_·_Linux_·_Windows_·_Pi_5-2ea44f.svg)](DOCS.md#installation)
[![OpenAI-compatible](https://img.shields.io/badge/OpenAI-compatible-10a37f.svg)](DOCS.md#api-server)
[![Ollama-compatible](https://img.shields.io/badge/Ollama-compatible-ff7a59.svg)](DOCS.md#api-server)
[![Anthropic-compatible](https://img.shields.io/badge/Anthropic-compatible-d97757.svg)](DOCS.md#api-server)

</div>

---

## Why this exists

The local-LLM piece *is* a solved problem now. Ollama installs in one command. LMStudio gives you a model picker with backend choice. We use both of those ourselves, because they work. So this isn't another local-LLM installer dressed up in different copy.

What *isn't* free and easy is everything else that was supposed to come with the AI revolution. Multi-speaker diarized transcription that doesn't ship your meetings to a vendor. A speaker timeline that stays stable for two hours instead of resetting every window. A talking-points summary that grows with the conversation in real time. *Mesh* — every device you own contributing to a shared pool of compute and capability, so plugging in a second laptop *adds* capacity instead of consuming a separate subscription.

That's what we thought AI was going to be before it turned into a host of separate metered APIs. MyOwnLLM is the pieces that didn't get built — packaged as a desktop app, scriptable from the CLI, with a local OpenAI-compatible endpoint thrown in because if we're already on your machine, we may as well serve a model too.

**What ships today:**

|   |   |
|---|---|
| **Multi-speaker diarized transcription** | Mic-to-text in ~1 s on a Pi 5 (English) or 80–200 ms on capable hardware (25 languages), with `pyannote-segmentation-3.0` + an embedder driving speaker IDs that stay stable across the whole session — not just a single window. Click a speaker pill to rename them; labels persist with the session. A live Talking-Points summary grows alongside the transcript. In-process — no Python venv, no whisper-server sidecar, no cloud round-trip. |
| **A local LLM endpoint that just works** | OpenAI-compatible HTTP on `127.0.0.1:1473` (also Ollama, also Anthropic), serving whichever model fits the machine — picked by a JSON manifest you, your team, or someone you trust controls. Cursor, Continue, Aider, Cline, Zed, Open WebUI, opencode, **OpenClaw**, OpenClaude, and your own scripts target it on day one. No metered tokens, no vendor lock-in. |

**What ships now alongside — Cloud Mesh:**

Every MyOwnLLM instance becomes a window into the same mesh. Devices share a Network ID (a short human name like `office-mesh`, hashed for namespace cleanliness), find each other through [Trystero](https://trystero.dev) over public Nostr relays — no MyOwnLLM-operated signaling server, no API key to register, no single point of failure — and connect peer-to-peer over WebRTC. Mutual ed25519 auth handshake with a per-request verification code locks down who's actually on your mesh. A second laptop joins and its LLM becomes a *route* in the chat compose ("via:" picker); conversations move between devices from the right-click menu or the **Connections** tab's cross-device grid. The mesh self-balances: it stays full-mesh at small sizes and switches to a deterministic ring topology past three peers so Pi-class devices don't melt under N² connection counts. Self-host a Nostr relay for an air-gapped office/LAN mesh; one-line Docker command in the Settings sub-tab. Mic / transcription / file routing are scaffolded (capability advertisement, peer pickers) and land in a follow-up PR. See **Settings → Cloud Mesh** in the GUI, or [DOCS.md › Cloud Mesh](DOCS.md#cloud-mesh) for the full reference.

## Install

The fast path is [**myownllm.net**](https://myownllm.net) — signed installers for every platform.

Or one line in a shell:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh
```

```sh
# Windows
irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1 | iex
```

Then:

```sh
myownllm          # opens the GUI
myownllm serve    # headless API on :1473
myownllm run      # terminal chat
```

## Live transcription, on your machine

A first-class capture pipeline, not a sidebar feature. Mic in, segmented transcript out, with speakers attributed and a live summary growing alongside it — all in-process, all on-device.

- **Streaming ASR.** Moonshine Small on a Pi 5 (English, ~500 ms), Parakeet TDT 0.6B v3 on capable hardware (25 languages, 80–200 ms). Streaming-native: one segment per audio chunk, no 5-second minimum.
- **Speaker diarization.** Opt-in toggle. `pyannote-segmentation-3.0` plus a speaker embedder (`wespeaker-r34` on capable hardware, `campp-small` on the lower rung), with online agglomerative clustering on the Rust side — speaker IDs stay stable across the entire conversation, not just a single window. Click a speaker pill to rename them; the labels persist with the session.
- **Talking Points.** A continuous LLM loop summarises the live transcript into a growing bullet list while you talk. The list updates as the conversation evolves, is persisted with the session, and can be paused, resumed, or stopped from the mode bar. It claims the chat-model slot while running so it can use whichever local model your hardware tier picked for text.
- **Crash-resilient by design.** Audio chunks land on disk before the ASR backend sees them, so a force-quit can be drained on next launch. Transcripts, speaker labels, diarize state, and the talking-points list are all part of the conversation record.
- **In-process.** No Python venv, no whisper-server sidecar, no cloud round-trip. ASR, diarization, and the chat model used to summarise all run inside `myownllm` itself, coordinated through two singleton slots on the GUI's mode bar.

Both paths — chat and transcription — are designed to be available on the GUI, the headless `serve` API, and the HTTP remote view. The desktop GUI is the most complete today; full audio capture over `serve` / remote is on the near-term roadmap.

## Highlights

|   |   |
|---|---|
| **Multi-speaker diarized transcription** | Speaker IDs that stay stable across the whole session, not just a single window. `pyannote-segmentation-3.0` + a speaker embedder, online clustering on the Rust side. The part the rest of the ecosystem hand-waves. |
| **Cloud Mesh** | Devices on the same Network ID find each other via Trystero (Nostr relays, no central broker) and connect peer-to-peer over WebRTC. Mutual ed25519 auth handshake with per-request verification code; identity is a long-lived keypair under `~/.myownllm/.secrets/`. **Remote inference** routes a chat to any peer's LLM ("via:" picker on the compose row). **Catalog gossip** + a **Network** sub-tab show every conversation on every device in one grid; click an empty cell to Move it. Ring topology with bounded connections so 10-device meshes work. Self-host a Nostr relay for an air-gapped mesh. |
| **Three wire formats, one server** | OpenAI on `:1473`, plus Ollama and Anthropic. Point Cursor, Continue, Aider, Cline, Zed, Open WebUI, opencode, OpenClaw, OpenClaude or your own scripts at it and it just works. |
| **Virtual model IDs** | `myownllm` and `myownllm-transcribe`. Stable names; the right tag for your hardware auto-resolves. |
| **Manifests, not config** | A JSON file at a URL is the source of truth. `imports` compose merged catalogs across publishers — no coordination required. |
| **Runs on a Pi 5** | Default manifest ships Gemma 4 edge variants (`e2b` / `e4b`), Apache-2.0, ~7.6 tok/s on a Pi 5. Same manifest gives a 4090 the 4090 tag. |
| **Desktop GUI** | Tauri + Svelte 5. Two singleton slots (chat-model, transcription) with conversation folders, in-place rename, crash-recoverable state. |
| **HTTP remote** | Open the GUI from your phone (or any HTTP client) on the same network. Single-user lock with kick-and-hide. (Lives under **Networks → HTTP**.) |
| **Self-updating** | Stages quietly on launch, applies on next start. Last good manifest stays cached for offline runs. |
| **Scriptable end-to-end** | Every CLI subcommand returns parseable text or `--json`. |

## CLI

```sh
myownllm                 # GUI
myownllm serve           # API server
myownllm run             # terminal chat
myownllm status          # provider, hardware, daemon, update
myownllm models          # what's pulled, what could be
myownllm families        # list / switch family
myownllm providers       # list / switch provider
myownllm update          # check / apply / configure self-update
```

Full reference: [DOCS.md › CLI](DOCS.md#cli).

## Build from source

```sh
git clone https://github.com/mrjeeves/MyOwnLLM && cd MyOwnLLM
just setup && just build
```

Repo layout, dev loop, and commit style live in [CONTRIBUTING.md](CONTRIBUTING.md).

## More

- [**myownllm.net**](https://myownllm.net) — installers, screenshots, the pitch
- [DOCS.md](DOCS.md) — manifest format, client configs, provider/family system, auto-update, lifecycle, scripting, repackaging
- [ARCHITECTURE.md](ARCHITECTURE.md) — internals, modules, data flow
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, repo layout, commit style
- [LICENSE](LICENSE) — MIT
