# MyOwnMesh → Myo v2 reference (multi-device, deferred)

This documents **MyOwnMesh** for Myo v2 (multi-device). It is deferred — Myo v1 is single-device — so this is real-but-not-exhaustive. **Important: the new agent will likely NOT have the MyOwnMesh repo**, so this file is written to stand alone. Everything below was read line-by-line from `/home/user/MyOwnMesh` (branch `claude/practical-shannon-RPFiK`). Workspace version `0.1.3`, edition 2021, rust-version 1.88.0, MIT, repo `github.com/mrjeeves/MyOwnMesh`.

---

## 1. What it is

A **pure-Rust, tailscale-less peer-to-peer mesh** built on `webrtc-rs`. The substrate was extracted from MyOwnLLM's `src/mesh-*.ts` + `src-tauri/src/mesh/` and generalised so any app can embed it. (README; `ARCHITECTURE.md` "Lineage from MyOwnLLM".) Core pieces:

- **WebRTC data channels** for transport — one `PeerSession` per peer (`webrtc = "0.13"`, `Cargo.toml:35`). Typed pub/sub channels + generic RPC ride over the data channel. No TURN required for the common case (STUN-only); TURN configurable.
- **Nostr signaling**, **Trystero-wire-compatible** — same room-handle derivation as JS Trystero v0.24: `SHA-256(app_id || ":" || network_id)`, same deterministic relay shuffle (README "What it gives you"; `crates/myownmesh-signaling/`). App-id `myownmesh-cloud-mesh-v1` (`lib.rs:135`, overridable via `MYOWNMESH_TRYSTERO_APP_ID`). Five published upstream Trystero fixes are baked in natively (`crates/myownmesh-signaling/src/upstream.rs`). An in-process `LocalBroker` (`signaling/local.rs`) lets two peers handshake with no relays at all (used by tests/examples).
- **ed25519 identity + mutual auth.** Per-device long-lived ed25519 keypair at `~/.myownmesh/.secrets/identity.json` (mode 0600). Every peer encounter exchanges `hello` + `auth_response`, each side signing the other's nonce under the domain tag `myownmesh-mesh-auth-v1:` over `SIGN_DOMAIN_TAG || nonce || my_device_id || their_device_id` (`lib.rs:64-76`, `:124-128`). The pubkey (base32-lowercase) is the Device ID peers know you by.
- **6-char human pairing code.** A `[a-z0-9]` 6-char verification code rides along the handshake for out-of-band eyeball confirmation ("the code I see matches what you read me"). Not cryptographically load-bearing — the ed25519 signature authenticates — but it catches a simultaneous-attacker MITM at first-meeting. After approval the peer lands in a per-network roster and auto-approves on reconnect (`crates/myownmesh-core/src/verification.rs`; see §3).
- **7-tier reconnection ladder** (Steady → Wake probe → ICE watchdog → ICE restart → Re-handshake → Room rejoin → Stop-and-start) and **selectable topologies** (Ring default / Star / FullMesh). Spec in `CONNECTION-ENGINE.md`; impl in `crates/myownmesh-core/src/engine/` + `src/topology/`.
- **One identity, many networks.** Per-network rosters at `~/.myownmesh/mesh/rosters/{network_id}.json`. Switching active network swaps rosters, keeps identity. Home dir overridable via `MYOWNMESH_HOME`.

Networks can be **open or closed** with signed governance transitions (roles, quorum, split/recovery) — `docs/NETWORK-TYPES.md`, `network_state.rs`. Not needed for Myo's basic device-fleet case.

---

## 2. Crates / workspace

`Cargo.toml` workspace members (`Cargo.toml:3-8`):

```toml
members = [
    "crates/myownmesh-core",
    "crates/myownmesh-signaling",
    "crates/myownmesh-updater",
    "crates/myownmesh",
]
```

| Crate | Kind | Purpose |
|---|---|---|
| **`myownmesh-core`** | lib (`myownmesh_core`) | "The only crate embedders need." Runtime, connection engine, WebRTC transport, wire protocol, topology selectors, generic RPC, typed channels, identity, rosters, governance. Public facade `Mesh`/`MeshHandle`/`JoinedNetwork`. (`crates/myownmesh-core/Cargo.toml:2-3`.) |
| **`myownmesh-signaling`** | lib (`myownmesh_signaling`) | Nostr signaling driver (Trystero-wire-compatible) + in-process `LocalBroker`. Optional — only needed if you want the Nostr driver. Attached via `engine::attach_nostr(&net.state())`. (`crates/myownmesh-signaling/Cargo.toml`.) |
| **`myownmesh-updater`** | lib (`myownmesh_updater`) | Self-update: configurable release feed, SHA-256 verification, stage-then-apply. `tick_forever()` background task. Embedders generally DON'T pull this in. |
| **`myownmesh`** | bin (`myownmesh`) | The **daemon + CLI**. Owns the mesh and exposes a **line-delimited-JSON control socket** (Unix domain socket / Windows named pipe) that GUIs and CLI clients talk to. `myownmesh serve` runs the daemon. (`crates/myownmesh/Cargo.toml:17-19`.) |

Also referenced but not in this workspace: a `gui/` Tauri 2 + Svelte 5 desktop app that is a **client** of the daemon (talks over the control socket, never embeds `myownmesh-core`), and a future `myownmesh-gui` crate.

Key workspace deps (`Cargo.toml:19-79`): `webrtc 0.13`, `tokio-tungstenite 0.24` (Nostr WS, rustls), `interprocess 2` (control socket), `ed25519-dalek 2`, `secp256k1 0.30` (BIP-340 Schnorr for Nostr event signing), `dashmap`, `parking_lot`, `serde`/`serde_json`, `clap 4`, `dirs 5`. Release profile is size-optimized + `panic = "abort"` + LTO (`:81-87`).

**Two ways to embed (README "Embed in your Rust app"):** as git deps pinned to a tag, or as a sibling-path dep:
```toml
myownmesh-core      = { git = "https://github.com/mrjeeves/MyOwnMesh", tag = "v0.1.0" }
myownmesh-signaling = { git = "https://github.com/mrjeeves/MyOwnMesh", tag = "v0.1.0" }
# or: myownmesh-core = { path = "../MyOwnMesh/crates/myownmesh-core" }
```

---

## 3. Public API surface

There are **two** API surfaces depending on how you embed:

### (A) Embedded library API (`myownmesh-core`)

The high-level facade (`crates/myownmesh-core/src/handle.rs`, re-exported from `lib.rs:113`):

```rust
// Open the local identity + WebRTC stack.
impl Mesh {
    pub async fn open(config: MeshConfig) -> Result<MeshHandle>;   // handle.rs:56
}

impl MeshHandle {
    pub fn identity(&self) -> &Arc<Identity>;                              // :92
    pub fn device_id(&self) -> String;                                    // :97
    pub fn events(&self) -> broadcast::Receiver<MeshEvent>;               // :104
    pub async fn join(&self, config: NetworkConfig) -> Result<JoinedNetwork>; // :112
    pub fn joined_network_ids(&self) -> Vec<String>;                      // :160
}

impl JoinedNetwork {
    pub fn network_id(&self) -> &str;                                     // :181
    pub fn current_phase(&self) -> MeshPhase;                             // :198
    pub fn current_topology(&self) -> TopologyMode;                      // :202
    pub async fn set_topology(&self, mode: TopologyMode) -> Result<()>;  // :209
    pub fn channel<T>(&self, name: &str) -> Channel<T>;                  // :219  typed pub/sub
    pub fn rpc(&self) -> Arc<Rpc>;                                        // :228
    pub fn peers(&self) -> Vec<PeerInfo>;                                 // :233
    pub fn peer(&self, device_id: &str) -> Option<PeerInfo>;             // :238
    pub async fn roster_list(&self) -> Result<Vec<AuthorizedPeer>>;      // :243
    pub async fn roster_approve(&self, device_id: &str, label: &str) -> Result<()>; // :249
    pub async fn roster_remove(&self, device_id: &str) -> Result<()>;    // :268
    pub fn advertise(&self, caps: CapabilityAdvert);                     // :288
    pub fn state(&self) -> Arc<NetworkState>;                            // :426
    pub async fn leave(self) -> Result<()>;                             // :401
    // + governance: propose_transition / sign_proposal / deny_proposal / withdraw_proposal / spawn_split
}
```

Signaling is attached separately so a network can run on the LocalBroker or Nostr:
```rust
let _nostr = myownmesh_core::engine::attach_nostr(&net.state());   // lib.rs:33, README
```

**Generic RPC** (`crates/myownmesh-core/src/rpc.rs`, re-exported `lib.rs:121`). Handlers register under string method names; payloads are opaque `serde_json::Value`:

```rust
impl Rpc {
    pub fn attach(network: &Arc<NetworkState>) -> Self;                  // rpc.rs:144
    pub fn serve<F, Fut>(&self, method: &str, handler: F)               // :155  single-shot
        where F: Fn(RpcCall) -> Fut + Send + Sync + 'static,
              Fut: Future<Output = Result<RpcResponse, String>> + Send + 'static;
    pub fn serve_stream<F, Fut>(&self, method: &str, handler: F)        // :173  streaming (returns mpsc::Receiver<Value>)
        where Fut: Future<Output = Result<mpsc::Receiver<serde_json::Value>, String>> + Send + 'static;
    pub fn forget(&self, method: &str);                                 // :189
    pub async fn call(&self, peer: &str, method: &str, payload: Value)  // :194
        -> Result<RpcResponse, RpcError>;
    pub async fn call_stream(&self, peer: &str, method: &str, payload: Value) // :230
        -> Result<mpsc::UnboundedReceiver<Result<Value, String>>, RpcError>;
    pub fn advertise(&self, caps: CapabilityAdvert);                    // :263
    pub fn capabilities(&self) -> CapabilityAdvert;                     // :274
}
```

**Typed channels** (`crates/myownmesh-core/src/channels.rs`): `Channel<T>` with `send_to(peer, &T)` (`:88`), `broadcast(&T) -> usize` (`:107`), `subscribe() -> ChannelSubscription<T>` (`:119`), and `ChannelSubscription::recv()` (`:142`). `T: Serialize + DeserializeOwned`.

**Capability advertisement** (`crates/myownmesh-core/src/protocol/rpc.rs:15-37`) — the mechanism Myo v2 uses to advertise a `:1473` endpoint (see §5):

```rust
pub struct CapabilityAdvert {
    pub tags: Vec<String>,            // free-form: "transcribe", "infer", "host-files", ...
    pub app_version: Option<String>,
    pub max_connections: Option<u32>,
    pub extra: serde_json::Value,     // embedder-defined structured blob (JSON) — put endpoint info here
}
```

**Event stream** — `MeshHandle::events()` yields `MeshEvent` (`crates/myownmesh-core/src/events.rs`, re-exported `lib.rs:112`):

```rust
#[serde(tag = "event_kind", rename_all = "snake_case")]
pub enum MeshEvent { Peer(PeerEvent), Phase(PhaseEvent), Diag(DiagEntry) }   // events.rs:183
```

`PeerEvent` (`events.rs:97-158`) carries the **6-char pairing code** on the `Authenticated` variant — this is the pairing flow's data:

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerEvent {
    Sighted     { network_id, device_id },                    // saw a peer, no hello yet
    Authenticated {                                            // hello+auth_response verified, NOT yet user-approved
        network_id: String, device_id: DeviceId, label: String,
        verification_code: String,    // <-- the 6-char code to show the user for out-of-band confirm
        capabilities: CapabilityAdvert,
        rostered: bool,               // true => will auto-approve without prompting
    },
    Approved    { network_id, device_id, label },             // both sides approved; app traffic flows
    Shelved / Unshelved { ... by_us },                        // topology demotion
    CapabilitiesChanged { network_id, device_id, capabilities },
    Dropped     { network_id, device_id, reason, grace_window_ms },
}
```

**The 6-char pairing flow** (`crates/myownmesh-core/src/verification.rs`):

```rust
pub const VERIFICATION_CODE_LEN: usize = 6;
const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";   // 36^6 ≈ 2.2B keyspace
pub fn generate_code() -> String;            // verification.rs:26 — fresh from OsRng
pub fn is_well_formed(code: &str) -> bool;   // :40 — len==6 && all [a-z0-9]
```

End-to-end pairing: peer is `Sighted` → handshake completes → both sides emit `Authenticated { verification_code }` → UI shows the code on both devices → user confirms they match and calls `roster_approve(device_id, label)` → `Approved` fires and the data channel is open for app RPC/channels. On reconnect the rostered peer auto-approves (`rostered: true`).

### (B) Control-socket IPC API (the daemon — how Myo will actually use it)

When you embed via the **daemon** (the externalBin pattern, §4), you don't link `myownmesh-core` — you speak **line-delimited JSON** over the control socket (`~/.myownmesh/daemon.sock` on Unix, named pipe on Windows). This is the surface MyOwnLLM uses today and the one the task names (`RpcRegister`, `EventsSubscribe`). Defined in `crates/myownmesh/src/control.rs`.

Requests are a tagged enum, `#[serde(tag = "op", rename_all = "snake_case")]` (`control.rs:39-278`). One JSON object per line; responses are `{ ok: bool, error?: string, data?: value }` (`control.rs:280-305`).

**`EventsSubscribe`** (`control.rs:103-108`) is special: it converts that one connection into a **one-way server-push stream**. After sending it, the daemon writes one `ServerOut` frame per line until the client disconnects, and the ack carries a **`client_id`** the client must pass back on all subsequent `client_id`-bearing ops (`control.rs:429-434`). You open one connection for events and issue RPC/channel management on others, tying them together via `client_id`.

**`RpcRegister`** (`control.rs:178-183`) — claim a method name; peer calls to it are forwarded to your event socket as `RpcInbound`:

```rust
RpcRegister { client_id: ClientId, network: String, method: String, streaming: bool }
```

Last-claim-wins (a later register evicts the prior owner with a `HandlerDisplaced` event). The full IPC verb set (`control.rs`):

- Lifecycle/query: `Status`, `NetworksList`, `PeersList`, `RosterList`, `RosterApprove`, `RosterRemove`, `TopologySet`, `IdentityShow`, `IdentitySetLabel`, `NetworkIdGenerate`, `NetworkIdNormalize`, `ConfigShow`, `NetworkAdd`, `NetworkRemove` (`:42-102`).
- Governance: `GovernanceState` / `…ProposeKindChange` / `…ProposeRoleGrant` / `…ProposeRoleRevoke` / `…Sign` / `…Deny` / `…Withdraw` / `…SpawnSplit` (`:110-158`).
- **RPC + typed-channel IPC** (all require a prior `EventsSubscribe` on the same client): `RpcRegister`, `RpcUnregister`, `RpcRespond`, `RpcStreamChunk`, `RpcStreamEnd`, `RpcCall`, `RpcCallStream`, `ChannelSubscribe`, `ChannelUnsubscribe`, `ChannelSendTo`, `ChannelSendAll`, `CapabilitiesSet` (`:160-277`).

Server-push frames the daemon writes after `EventsSubscribe` (`crates/myownmesh/src/ipc/wire.rs:28-83`), tagged `#[serde(tag = "kind", rename_all = "snake_case")]`:

```rust
pub enum ServerOut {
    Event { event: MeshEvent },                                       // live peer/phase/diag
    Lagged { skipped: u64 },                                          // subscriber too slow
    RpcInbound { network, from, request_id, method, payload, streaming }, // a peer called your method
    RpcCallStreamChunk { request_id, payload },                       // chunk of YOUR outbound RpcCallStream
    RpcCallStreamEnd { request_id, error: Option<String> },
    ChannelInbound { network, from, channel, payload },               // inbound typed-channel frame
    HandlerDisplaced { network, method, by },                         // someone else claimed your method
}
```

So the round trip for "serve an RPC method": `EventsSubscribe` (get `client_id`) → `RpcRegister{client_id, network, method, streaming}` → receive `RpcInbound{request_id, ...}` on the event socket → answer with `RpcRespond{request_id, ok|error}` (single-shot) or `RpcStreamChunk{request_id,...}` × N + `RpcStreamEnd{request_id}` (streaming). To call out: `RpcCall` (blocks for the reply) or `RpcCallStream{client_id,...}` (returns a `request_id`; chunks arrive as `RpcCallStreamChunk`/`…End`).

**Daemon CLI** (`crates/myownmesh/src/main.rs` + `cli/`): `myownmesh serve` (alias bare `myownmesh`) runs the daemon; `myownmesh ctl status` / `ctl networks list`; `myownmesh identity show`; `myownmesh update check`; `myownmesh config edit`. On start, `serve::run` (`cli/serve.rs:21-`) loads `~/.myownmesh/config.json`, `Mesh::open`, joins every configured network + `attach_nostr` per network, then `control::serve` listens on the socket.

---

## 4. How MyOwnLLM embeds it today

**Pattern: externalBin daemon over the control socket — NOT a linked crate.** MyOwnLLM bundles the `myownmesh` binary as a Tauri sidecar and talks to it over the line-delimited-JSON IPC. It does NOT depend on `myownmesh-core` as a Cargo dep.

- **Bundling:** `src-tauri/tauri.conf.json` declares `bundle.externalBin: ["binaries/myownmesh"]`. `build.rs` fetches/copies the daemon into `binaries/myownmesh-<triple>`; Tauri places it next to the main exe. (See `myownllm-integration.md` §5/§6.)
- **Supervision:** `src-tauri/src/mesh/daemon.rs` spawns `myownmesh serve` with `MYOWNMESH_HOME=~/.myownllm/.myownmesh/` (isolated from a standalone MyOwnMesh install), probes-then-spawns, attaches if one is already running, and kills the child on `Drop` (Job Object on Windows). It holds its OWN mirror of the `Request`/`Response` enum as a control-socket **client** (`daemon.rs:99` `EventsSubscribe`, `:137` `RpcRegister`, etc. — a client-side copy of the daemon's `control.rs` protocol). Returns `(ControlClient, Option<DaemonChild>)`.
- **Event-socket bootstrap + client_id:** `src-tauri/src/mesh/daemon_commands.rs` opens the `EventsSubscribe` connection and surfaces the daemon-assigned id to the frontend as `ipc_client_id` (`daemon_commands.rs:39-46`), so the frontend can pass it back on `RpcRegister` / `ChannelSubscribe` / `RpcCallStream`.
- **Tauri command bridge:** `daemon_commands.rs` exposes `mesh_daemon_rpc_register` (`:314`), `mesh_daemon_rpc_unregister`, `mesh_daemon_rpc_call` / `…_call_stream`, `mesh_daemon_channel_{subscribe,unsubscribe,send_to,send_all}`, `mesh_daemon_capabilities_set`, etc. (registered in `main.rs:1160-1164`). Each fills in `client_id: daemon.client_id.clone()` and forwards a `Request::…` over the socket.
- **Frontend client:** `src/mesh-daemon.svelte.ts` (~1470 lines) is the TS wrapper. `registerRpcHandler(method, streaming, handler)` → `invoke("mesh_daemon_rpc_register", {network, method, streaming})` (`mesh-daemon.svelte.ts:1307-`); `callRpcStream`, `channelSendTo`, `subscribeChannel`, etc. wrap the matching commands. Feature modules build on this: `src/mesh-transcribe.ts` (remote ASR, see `myownllm-integration.md` §9), `src/mesh-inference.ts` (remote LLM `infer` RPC), `src/mesh-file.ts`, `src/mesh-gossip.ts`, `src/mesh-governance.ts`, `src/mesh-capabilities.ts`. Entry types in `src/mesh.ts` (identity get/set-label, network-id generate/normalize).

Net: the GUI is a thin client; crashing the UI never disturbs the running mesh (the daemon outlives it). **Myo should adopt this exact pattern** — bundle `myownmesh` as a sidecar, supervise it like MyOwnLLM does, and speak the control protocol — rather than linking `myownmesh-core` (which would pull the WebRTC stack into Myo's process and couple lifecycles).

---

## 5. v2 relevance for Myo

Myo v1 is single-device. Myo v2 uses MyOwnMesh to go multi-device. Concretely:

- **Replace Tailscale-based LLM discovery with mesh-advertised `:1473` endpoints.** Today Odysseus discovers peer LLMs over Tailscale (that logic lives in odysseus `src/model_discovery.py` — mentioned only; that repo isn't here, so it's not quoted). In v2, each device's Myo advertises its local `myownllm serve` (the OpenAI-compatible `:1473` sidecar — see `myownllm-integration.md` §4) as a mesh capability instead. Use `CapabilityAdvert` (§3): put `tags: ["infer", "transcribe"]` and the endpoint/model info in `extra` (JSON), then push it via `CapabilitiesSet` (IPC) / `JoinedNetwork::advertise` (lib). Peers receive it on the `Authenticated` / `CapabilitiesChanged` `PeerEvent` and filter on tags — no Tailscale, no IP coordination, NAT-traversed via WebRTC. Discovery becomes "enumerate peers whose `CapabilityAdvert.tags` contains `infer`," and the actual chat call goes peer-to-peer over an `infer` streaming RPC (the shape MyOwnLLM's `mesh-inference.ts` already implements) rather than to a Tailscale IP:1473.
- **Remote ASR.** Reuse MyOwnLLM's `transcribe` streaming-RPC + `transcribe_audio/<id>` channel design (`myownllm-integration.md` §9): a capture-only device streams 16 kHz i16 PCM to a GPU peer over `RpcCallStream` + `ChannelSendTo`, and gets segment frames back. The Rust ASR pipeline (`start_remote_session`/`feed_remote_audio`) is identical to local — only the audio source differs.
- **`RpcRegister` / `EventsSubscribe` usage** (the v2 wiring): on each Myo instance, open `EventsSubscribe` (capture `client_id`), `RpcRegister` the methods this device serves (`infer`, `transcribe`), set `CapabilitiesSet` advertising what it offers, and render the `Authenticated`-event 6-char codes in Myo's pairing UI for device approval. To call a remote model: `RpcCallStream{client_id, network, peer, method:"infer", payload}` and consume `RpcCallStreamChunk`/`…End`.
- **Pairing UX:** the 6-char code (§1/§3) is Myo's device-pairing primitive — show it during `Authenticated`, confirm out-of-band, then `RosterApprove`. No accounts, no central server.

Defer the topology/governance surface (Ring vs Star, open/closed networks) until v2 actually needs >2 devices; a 2-device fleet works on the defaults (`TopologyMode::default()` = Ring, open network, `auto_approve: false`).

---

## Gotchas

- **Two API surfaces — pick the daemon one.** `myownmesh-core` (linked lib: `Mesh`/`Rpc`/`Channel`) vs the **control-socket IPC** (line-delimited JSON: `RpcRegister`/`EventsSubscribe`/`RpcCall`). MyOwnLLM uses the **daemon over IPC**; Myo should too (sidecar, not linked crate) — linking `myownmesh-core` drags the whole WebRTC/Nostr stack into Myo's process and ties the mesh's lifecycle to the UI's.
- **`EventsSubscribe` must come first.** Every RPC/channel verb requires a prior `EventsSubscribe` on the same client; the daemon hands back a `client_id` you must thread into `RpcRegister`/`RpcCallStream`/`ChannelSubscribe`/`RpcCallStream`. Calling them un-subscribed returns a `not subscribed` error. Keep the event connection open for the app's lifetime.
- **`RpcRegister` is last-claim-wins.** A second register for the same `(network, method)` evicts the first with a `HandlerDisplaced` frame. Don't double-register the same method from two Myo components.
- **The 6-char code is NOT the security boundary.** ed25519 mutual signing authenticates; the code is only the human eyeball-check against a simultaneous MITM at first meeting. Don't gate trust on the code alone — gate on `roster_approve` after the user confirms it.
- **Isolate `MYOWNMESH_HOME`.** If Myo ships the same `myownmesh` binary a user might also run standalone, set `MYOWNMESH_HOME=~/.myo/mesh` (as MyOwnLLM sets `~/.myownllm/.myownmesh/`) so identity + rosters + config don't collide. Identity lives at `$MYOWNMESH_HOME/.secrets/identity.json` (0600); rosters at `$MYOWNMESH_HOME/mesh/rosters/{network_id}.json`.
- **App-id / domain-tag isolate fleets on purpose.** Trystero app-id `myownmesh-cloud-mesh-v1` and signing tag `myownmesh-mesh-auth-v1:` mean bare-MyOwnMesh peers and MyOwnLLM peers do NOT meet or accept each other's signatures. If Myo wants its own isolated fleet (not interop with either), override `MYOWNMESH_TRYSTERO_APP_ID` (env, build-time) and fork the domain tag — but then Myo only meets other Myo.
- **Capabilities are opaque to the mesh.** `CapabilityAdvert.tags`/`extra` are forwarded as-is and never validated by the substrate — Myo defines and interprets them. Put the `:1473` endpoint/model metadata in `extra` and filter peers in Myo, not in the mesh.
- **The repo may be absent for the new agent.** This file is the source of truth; the daemon binary still ships via MyOwnLLM's bundle (`binaries/myownmesh-<triple>`) and `MyOwnMesh` releases the same binary for all five targets (linux-x86_64, linux-aarch64, macos-x86_64, macos-aarch64, windows-x86_64). Linux is pinned to glibc 2.35 (Ubuntu 22.04).
- **Linux WebView WebRTC flag still applies** if any mesh JS runs in a WebView (it doesn't for the daemon-IPC path, but `mesh-*.ts` running in Myo's WebView would need it): `set_enable_webrtc(true)` before page load — see `myownllm-integration.md` §6.
