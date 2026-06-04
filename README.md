<div align="center">

# ⚡ MyOwnLLM

**An AI that runs on every device you own — and manages itself.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/macOS_·_Linux_·_Windows_·_Pi-2ea44f.svg)](#-platforms)
[![API: OpenAI · Ollama · Anthropic](https://img.shields.io/badge/API-OpenAI_·_Ollama_·_Anthropic-10a37f.svg)](#-api)
[![Built with Rust + Tauri](https://img.shields.io/badge/built_with-Rust_+_Tauri-dea584.svg)](ARCHITECTURE.md)

[**Download**](https://myownllm.net) · [Docs](DOCS.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

</div>

---

MyOwnLLM is a **local-first AI you install once and run everywhere** — a desktop app, an OpenAI-compatible server, and a terminal chat in a single ~50 MB binary. It picks the right model for your hardware, keeps itself updated, and turns every box you own into one shared, private mesh. No account, no API key, no cloud round-trip.

## Contents

- [Features](#-features)
- [Install](#-install)
- [Quick start](#-quick-start)
- [The agent](#-the-agent)
- [Cloud Mesh](#-cloud-mesh)
- [Live transcription](#-live-transcription)
- [API](#-api)
- [Platforms](#-platforms)
- [Learn more](#-learn-more)
- [License](#-license)

## ✨ Features

| | |
| --- | --- |
| 🤖 **Self-managing agent** | A tool-calling chat with five tools — including keyless `web_search` — that runs shell commands, reads and writes files, and configures the mesh for you. |
| 🕸️ **Cloud Mesh** | Your devices find each other and share inference peer-to-peer over WebRTC. No broker, no account, no API key. |
| 🎙️ **Live diarized transcription** | Real-time streaming captions in 25 languages, with speaker IDs that stay stable across the whole session — and carry into future ones. |
| 🗣️ **Text-to-speech** | On-device TTS (Kokoro / Piper) with a self-installing espeak-ng phonemizer and a `POST /v1/audio/speech` endpoint. Pick a default voice across engines (incl. your OS's system voices) in **Settings → Voices**, or override it per **persona**. |
| 🔌 **Three wire formats, one server** | OpenAI, Ollama, and Anthropic on `:1473`. Cursor, Continue, Aider, Cline, Zed, and Open WebUI all just work. |
| 🧠 **Hardware-aware models** | Manifest-driven tier selection from a Raspberry Pi 4 (2 GB) to a 5090. Gemma 4 and Qwen 3.6 edge builds included. |
| 🔄 **Self-updating** | Stages on launch, applies on next start. Last-good manifest cached for offline runs. |
| 🔒 **Local-first & private** | Everything runs on your own hardware. Self-host a relay for an air-gapped LAN. |

## 📦 Install

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1 | iex
```

Prefer a signed installer? Grab one for every platform at [**myownllm.net**](https://myownllm.net).

## 🚀 Quick start

One binary, three personas:

```sh
myownllm          # desktop GUI (Tauri + Svelte 5)
myownllm serve    # OpenAI / Ollama / Anthropic HTTP on :1473
myownllm run      # terminal chat
```

Drop it in anywhere you already point at OpenAI:

```sh
myownllm serve &
curl http://127.0.0.1:1473/v1/chat/completions \
  -H 'Authorization: Bearer myownllm' \
  -d '{"model":"myownllm","messages":[{"role":"user","content":"hi"}]}'
```

## 🤖 The agent

The built-in chat is a tool-calling agent. It reaches for a tool whenever a request calls for one, then tells you what it did:

| Tool | What it does | Gated |
| --- | --- | --- |
| `networks` | Inspect and manage the Cloud Mesh — status, peers, approvals, switching, reconnect, rediscovery. | — |
| `web_search` | Keyless web search. DuckDuckGo by default; point it at a self-hosted SearXNG instead. | — |
| `read_file` | Read a text file from disk. | — |
| `write_file` | Create or append to a file. | ✅ per-network |
| `shell` | Run a shell command and capture stdout / stderr / exit code. | ✅ per-network |

- **Tools run on the caller's box even when inference is on a remote peer** — your Pi can borrow the workstation's 5090 and still configure the Pi.
- **`shell` and `write_file` route through a per-network permission gate** — Deny / Allow once / Always for this command-or-path / Always for the tool. Decisions persist per network and gossip to peers when `auto_gossip` is on. `web_search` and `read_file` are read-only and ungated.
- **The loop runs a round's tool calls in parallel** and is bounded (16 rounds); when the budget is hit it forces a final, tool-free answer instead of stalling.
- Per-prompt tool selection lives in **Settings → Prompts** — deselect a tool to hide it from the model entirely for that prompt.

### Web search backend

`web_search` is keyless out of the box (DuckDuckGo's HTML endpoint — no signup, works anywhere). To route it through a self-hosted [SearXNG](https://docs.searxng.org/) instead, set this in `~/.myownllm/config.json`:

```json
"web_search": { "backend": "searxng", "searxng_url": "http://127.0.0.1:8080" }
```

## 🕸️ Cloud Mesh

Two (or ten) MyOwnLLM instances that share a **Network ID** find each other, mutually authenticate, and share work peer-to-peer over WebRTC — phone audio in, desktop transcription out, a laptop's idle GPU answering prompts from the tablet on the counter.

Discovery, auth, WebRTC + ICE, NAT traversal, and reconnect logic live in the standalone [`myownmesh`](https://github.com/mrjeeves/MyOwnMesh) daemon, bundled as a Tauri sidecar: signed signaling over public Nostr relays, end-to-end encrypted data channels between peers. **No MyOwnLLM-operated broker, no account, no API key.** Joining still takes explicit per-device approval behind a 6-char verification code. Self-host a relay for an air-gapped LAN.

## 🎙️ Live transcription

Real-time streaming captions — interim text that firms up as you speak (Silero VAD endpointing, LocalAgreement-2, beam search on the words you keep) — via Moonshine or Parakeet TDT across 25 languages, with `pyannote-segmentation-3.0` and online clustering for diarization.

Speaker IDs stay stable across the **whole** session, not per window, and **Speaker Profiles** carry a confirmed voice's name into *future* sessions: one-tap confirm a chip and its clip anchors the profile. **Talking Points** runs a live LLM loop that summarises the growing transcript into a bullet list while you talk. All in-process — no Python venv, no whisper sidecar.

## 🔌 API

`myownllm serve` exposes **three wire formats on one port** (`:1473`):

- **OpenAI** — `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/audio/speech`, and a live streaming-transcription WebSocket.
- **Ollama** — for clients that only speak Ollama (`:11434`).
- **Anthropic** — for clients that only speak Anthropic's Messages format.

Cursor, Continue, Aider, Cline, Zed, Open WebUI, and opencode all work as drop-in providers. See [DOCS.md → API server](DOCS.md#api-server) for endpoints, virtual model IDs, and per-client setup.

## 🖥️ Platforms

macOS 12+ (Apple Silicon) · Linux x86_64 / aarch64 · Windows 10+ · Raspberry Pi 4 & 5. Signed, auto-updating, ~50 MB app plus the first-run model.

## 📚 Learn more

| | |
| --- | --- |
| [DOCS.md](DOCS.md) | Manifests, CLI, API, agent & tools, lifecycle, scripting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Internals, modules, data flow |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, repo layout, commit style |

## 📄 License

[MIT](LICENSE).
