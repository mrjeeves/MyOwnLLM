# Cloud Mesh Connection Engine

> **The connection engine lives in [MyOwnMesh](https://github.com/mrjeeves/MyOwnMesh), not in this repo.**
>
> Layers 1–3 (signaling, WebRTC + ICE, the cryptographic handshake)
> and the resilience ladder (reconnect tiers, wake detection, force
> rediscovery, ring topology) all moved out of the LLM into the
> standalone `myownmesh` daemon during PRs #201 / #203 / #204 / #205.
> MyOwnLLM bundles `myownmesh serve` as a Tauri sidecar and talks to
> it over a line-delimited JSON IPC socket; the engine itself is no
> longer something this repo defines or tests.
>
> If you're chasing a connection-layer bug — peer can't be found,
> handshake stalls, ICE fails, signaling drops — read MyOwnMesh's
> own docs and source. The four-layer model, the seven-tier
> reconnection ladder, the per-relay denylist, the `pc.restartIce()`
> watchdog, the wake probe, and the rebuild throttle all live there.

## What MyOwnLLM still owns

A layer-4 surface on top of the daemon's RPC + typed channels:

| File                          | Role                                                          |
|-------------------------------|---------------------------------------------------------------|
| `src/mesh-daemon.svelte.ts`   | Subscribes to `mesh://event`; reactive store the GUI binds to. Installs LLM feature handlers + gossip subscribers. |
| `src/mesh-protocol.ts`        | LLM-specific types: `Capabilities` (LLMs/ASR/hardware/etc), `CatalogEntry`, `FEATURES`. |
| `src/mesh-capabilities.ts`    | Snapshot local capabilities into the wire shape; predicate helpers (`canServeInference`, `canServeTranscribe`). |
| `src/mesh-gossip.ts`          | Catalog / permissions / prompts gossip over typed channels. |
| `src/mesh-inference.ts`       | Remote inference (`infer` streaming RPC, both sides). |
| `src/mesh-file.ts`            | File transfer (`file_offer` RPC + `file_chunks/<id>` channel). |
| `src/mesh-move.ts`            | Conversation move + remote-session view (`session_fetch`, `session_save`, `move_take`, `move_drop`). |
| `src/mesh-transcribe.ts`      | Remote ASR (`transcribe` RPC + `transcribe_audio/<request_id>` channel). |
| `src/mesh-governance.ts`      | LLM-side helpers for the daemon's signed-proposal governance flow. |
| `src-tauri/src/mesh/daemon.rs`         | Daemon spawn / attach, IPC `ControlClient`, event forwarding to `mesh://event`. |
| `src-tauri/src/mesh/daemon_commands.rs`| 30 Tauri commands wrapping the daemon's IPC surface. |

## How the LLM talks to the daemon

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Frontend (Svelte / TS)                                              │
 │   mesh-daemon.svelte.ts ◄── reactive store                          │
 │     │                                                               │
 │     │  invoke("mesh_daemon_*")        listen("mesh://event")        │
 │     ▼                                       ▲                       │
 ├─────┴───────────────────────────────────────┴───────────────────────┤
 │ Tauri backend (Rust)                                                │
 │   mesh/daemon.rs                                                    │
 │     ControlClient ─── line-delimited JSON IPC ─── event pump        │
 │                                                                     │
 │            ~/.myownmesh/daemon.sock  (shared with MyOwnMesh GUI)    │
 │              · or ·                                                 │
 │            ~/.myownllm/daemon.sock   (LLM-spawned sidecar)          │
 └────────────────────────────────────┬────────────────────────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │   myownmesh serve      │
                          │   (the whole connection│
                          │    engine)             │
                          └────────────────────────┘
```

**Detect-and-share resolution** (`mesh/daemon.rs::find_daemon_binary`):

1. `~/.myownmesh/daemon.sock` — if the MyOwnMesh GUI's daemon is already running, attach. Shared identity, shared roster, one engine on the box.
2. `~/.myownllm/daemon.sock` — if a previous LLM-spawned daemon survived, attach.
3. Spawn `myownmesh serve` ourselves with `MYOWNMESH_HOME=~/.myownllm` so existing users keep their pubkey + roster files.

Binary discovery: `MYOWNLLM_MESH_BIN` env → `MYOWNMESH_BIN` env → bundled sidecar (`<exe_dir>/myownmesh{.exe}`) → `$PATH` → workspace dev fallbacks. The sidecar is pinned to a release tag in `.myownmesh-rev` at the repo root; `src-tauri/build.rs` downloads + bundles the matching prebuilt for the target triple.

## LLM-specific protocol (layer 4)

The daemon provides two primitives the LLM uses:

- **RPC methods** (`registerRpcHandler` + `callRpc` / `callRpcStream`) — request/response with optional streaming chunks.
- **Typed channels** (`subscribeChannel` + `channelSendAll` / `channelSendTo`) — pub/sub by channel name across active peers.

LLM-side methods + channels in current use:

| Surface          | Kind     | Wire shape (caller initial payload → handler response)                                              |
|------------------|----------|-----------------------------------------------------------------------------------------------------|
| `infer`          | streaming RPC | `{messages, family, mode, think?, tools?}` → chunks `{delta}` / `{thinking_delta}` / `{tool_call}` |
| `transcribe`     | streaming RPC | `{runtime, model, diarize_model, sample_rate}` → segments `{text, speaker?, overlap?, start_ms?, end_ms?}` |
| `transcribe_audio/<request_id>` | typed channel | Audio frames `{index, bytes_b64, is_final}` — sender → handler (i16 LE PCM, 16 kHz mono) |
| `file_offer`     | single-shot RPC | `{id, filename, size_bytes, mime_type?, sha256_b32, chunk_size}` → `{accepted, reason?}` |
| `file_send`      | streaming RPC (degenerate) | `{id}` → end-of-stream signal; chunks travel on the channel below |
| `file_chunks/<id>` | typed channel | `{index, bytes_b64, is_final}` — sender → receiver, 48 KB chunks, base64-encoded |
| `session_fetch`  | single-shot RPC | `{guid}` → `{conversation}` or `{error}` |
| `session_save`   | single-shot RPC | `{conversation}` → `{ok}` or `{error}` |
| `move_take`      | single-shot RPC | `{guid, conversation, source_folder}` → `{ok, guid}` or `{error}` |
| `move_drop`      | single-shot RPC | `{guid}` → `{ok}` or `{error}` |
| `catalog/announce` | typed channel | `{entries: CatalogEntry[], ts}` — broadcast on local mutation (debounced 500 ms) + every 60 s |
| `permissions/snapshot` | typed channel | `{tools: {shell, write_file}, ts}` — gossip-gated; per-tool LWW by `updated_at` |
| `prompts/snapshot` | typed channel | `{prompts: Prompt[], ts}` — gossip-gated; per-id LWW by `updated_at` |

Capabilities ride the daemon's own `capabilities_update` broadcast (not a typed channel). The LLM's `Capabilities` blob is packed into `CapabilityAdvert.extra` for the round-trip — the daemon stays domain-agnostic and the LLM's structured fields (`llms`, `asr`, `hardware`, `inputs`, `outputs`, `accepting`, `features`) survive serde without daemon-side schema changes.

## Reading further

- [MyOwnMesh README](https://github.com/mrjeeves/MyOwnMesh) — the engine itself.
- [`src-tauri/src/mesh/daemon.rs`](src-tauri/src/mesh/daemon.rs) — daemon spawn, IPC client, event pump.
- [`src-tauri/src/mesh/daemon_commands.rs`](src-tauri/src/mesh/daemon_commands.rs) — the 30 Tauri commands the frontend invokes.
- [`src/mesh-daemon.svelte.ts`](src/mesh-daemon.svelte.ts) — frontend reactive store + handler-install plumbing.
- [DOCS.md](DOCS.md) Cloud Mesh section — user-facing behaviour.
