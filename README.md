<div align="center">

# MyOwnLLM

### An AI that runs on every device you own — and manages itself.

[**Download**](https://myownllm.net) · [Docs](DOCS.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/macOS_·_Linux_·_Windows_·_Pi-2ea44f.svg)](DOCS.md#installation)
[![OpenAI · Ollama · Anthropic compatible](https://img.shields.io/badge/API-compatible-10a37f.svg)](DOCS.md#api-server)

</div>

## Install

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.sh | sh
```

```sh
# Windows
irm https://raw.githubusercontent.com/mrjeeves/MyOwnLLM/main/scripts/install.ps1 | iex
```

Signed installers for every platform: [**myownllm.net**](https://myownllm.net).

## One binary, three personas

```sh
myownllm          # desktop GUI (Tauri + Svelte 5)
myownllm serve    # OpenAI / Ollama / Anthropic HTTP on :1473
myownllm run      # terminal chat
```

## What it does

- **One AI across your devices.** Boxes on the same Network ID find each other via the bundled [`myownmesh`](https://github.com/mrjeeves/MyOwnMesh) daemon — signed signaling over public Nostr relays, end-to-end WebRTC data channels between peers. No MyOwnLLM-operated broker, no account, no API key. Share inference, pass conversations, pin a peer per surface. Self-host a relay for an air-gapped LAN.
- **Every device makes it stronger.** A Pi can borrow the workstation's model over the mesh; the workstation can serve the laptop's chat. Manifest-driven hardware tier selection covers Pi 4 2 GB through a 4090; edge variants for Gemma 4 (`e2b`/`e4b`) and Qwen 3.6 down to 0.8b.
- **It's its own IT.** The chat is a tool-calling agent with four tools today — `networks` (mesh: status / add / approve / switch / forget / reconnect / rediscover / accepting / recent activity), `shell`, `read_file`, `write_file`. `shell` and `write_file` route through a per-network permission gate (Deny / Allow once / Always for this command-or-path / Always for the tool); decisions persist per network in `Config.cloud_mesh.networks[*].agent_permissions` and gossip to peers on the same network when `auto_gossip` is on. **Tools execute on the caller's box even when inference is on a remote peer** — your Pi can borrow the 4090 and still configure the Pi.
- **Diarized live transcription.** Moonshine or Parakeet TDT (25 languages), `pyannote-segmentation-3.0` + online clustering. Speaker IDs stay stable across the whole session — not per window. In-process; no Python venv, no whisper sidecar.
- **Talking Points.** A live LLM loop summarises the growing transcript into a bullet list while you talk. Pausable, persisted with the session, on-device.
- **Three wire formats, one server.** OpenAI on `:1473`, plus Ollama and Anthropic. Cursor, Continue, Aider, Cline, Zed, Open WebUI, opencode all just work.
- **Self-updating.** Stages on launch, applies next start. Last-good manifest cached for offline runs.

## Drop-in OpenAI

```sh
myownllm serve &
curl http://127.0.0.1:1473/v1/chat/completions \
  -H 'Authorization: Bearer myownllm' \
  -d '{"model":"myownllm","messages":[{"role":"user","content":"hi"}]}'
```

## Platforms

macOS 12+ (Apple Silicon) · Linux x86_64 / aarch64 · Windows 10+ · Raspberry Pi 4 & 5. Signed, auto-updating, ~50 MB app plus first-run model.

## More

[DOCS.md](DOCS.md) — manifests, CLI, API, lifecycle, scripting · [ARCHITECTURE.md](ARCHITECTURE.md) — internals, modules, data flow · [CONTRIBUTING.md](CONTRIBUTING.md) — setup, repo layout, commit style · [LICENSE](LICENSE) — MIT
